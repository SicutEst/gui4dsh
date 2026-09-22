import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { webDist, dshHome } from './config.js';
import * as memory from './memory.js';
import * as idle from './idle.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { dsh } from './dsh/client.js';
import * as manager from './dsh/manager.js';
import * as automations from './automations.js';
import { testHook } from './hooks.js';
import { backfillFromProjcache } from './stats.js';
import * as updaterInfo from './updater.js';
import { pushTest } from './push.js';
import * as frp from './frp.js';
import * as cfd from './cfd.js';
import * as ddns from './ddns.js';
import * as acmeTls from './acme.js';

const DSH_METHOD_RE = /^(session|subagent|host|workspace|agentPreset|settings|credentials|llm|goal|skill|command|messageFeedback|workspaceFiles)\.[a-zA-Z]+$/;

// --- short pairing code (WhatsApp-style): 6 digits, single-use, long-lived until used
const pairAttempts = new Map<string, number>(); // ip -> count (1-min window)

// long-lived single-use pairing code: no expiry, regenerated on demand
let pairCode: string | null = null;

function newPairCode(): string {
  pairCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return pairCode;
}

// auth-failure lockout: exposing the gateway directly (IPv6/DDNS) invites
// credential stuffing; 8 bad tokens in a window silences an IP for 30 min
const authFails = new Map<string, { n: number; until: number }>();
function authLocked(ip: string): boolean {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (rec.until > Date.now()) return true;
  if (rec.until > 0) authFails.delete(ip);
  return false;
}
function authFailed(ip: string): void {
  const now = Date.now();
  const rec = authFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 8) {
    rec.until = now + 30 * 60_000;
    rec.n = 0;
  }
  authFails.set(ip, rec);
  if (authFails.size > 5000) {
    for (const [k, v] of authFails) if (v.until < now && v.n < 8) authFails.delete(k);
  }
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  for (const [k, v] of pairAttempts) {
    if (now - v > windowMs) pairAttempts.delete(k);
  }
  const n = (pairAttempts.get(ip) || 0) + 1;
  pairAttempts.set(ip, n);
  return n > 5;
}

export function getPairCode(): { code: string | null; expiresAt: number } {
  return { code: pairCode, expiresAt: 0 };
}

function tokenFromReq(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = (req.query as Record<string, string> | undefined)?.token;
  return (q || '').trim();
}

function tokenOk(candidate: string): boolean {
  if (!candidate) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(store.data.token).digest();
  return crypto.timingSafeEqual(a, b);
}

function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  return urls;
}

const sockets = new Set<WebSocket>();

function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const ws of sockets) {
    try {
      ws.send(data);
    } catch {
      sockets.delete(ws);
    }
  }
}

export async function buildServer(port: number, httpsOpts?: { key: Buffer; cert: Buffer }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, ...(httpsOpts ? { https: httpsOpts } : {}) });

  await app.register(fastifyWebsocket);

  // raw file uploads proxy through as bytes (dsh's uploadFileBinary route)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // --- remote-access master switch: when off, only loopback Host headers pass.
  // frp forwards arrive with source 127.0.0.1, so the Host header (not req.ip)
  // is the reliable local-vs-remote signal.
  function isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h.startsWith('127.0.0.1:') || h.startsWith('localhost:');
  }

  // --- auth fence: everything under /api and /ws requires the pairing token
  // (exceptions: pairing-code exchange + loopback auto-pair — the unpaired device has no token yet)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if ((url.startsWith('/api') || url === '/ws') && url !== '/api/fe/pair/exchange' && url !== '/api/fe/auto-pair') {
      const ip = req.ip || 'unknown';
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!loopback && authLocked(ip)) {
        await reply.code(429).send({ error: 'too many failed attempts' });
      } else if (!tokenOk(tokenFromReq(req))) {
        if (!loopback) authFailed(ip);
        await reply.code(401).send({ error: 'unauthorized' });
      }
    }
    // remote switch: non-loopback requests are refused entirely when disabled
    if (!store.data.settings.remoteEnabled && !isLoopbackHost(req.headers.host || '')) {
      await reply.code(403).send({ error: 'remote access disabled' });
    }
  });

  // --- static web dist
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // index.html must never be cached: hashed assets change every build and a
    // stale shell referencing old chunks breaks the SPA (blank page / errors)
    app.addHook('onSend', (req, reply, payload, done) => {
      const url = req.url.split('?')[0];
      if (url === '/' || url === '/index.html') {
        reply.header('cache-control', 'no-cache, no-store, must-revalidate');
      }
      done(null, payload);
    });
  }

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket as unknown as WebSocket);
    socket.send(JSON.stringify({ t: 'hello', dsh: manager.getStatus(), version: '0.1.0' }));
    // replay the live control baseline (queues/jobs/projections) missed before this client attached
    for (const frame of dsh.controlSnapshot()) socket.send(JSON.stringify({ t: 'dsh:mux', frame }));
    socket.on('close', () => sockets.delete(socket as unknown as WebSocket));
    // downlink-only: ignore any client message
  });

  bus.on((ev) => broadcast({ t: ev.type, ...ev }));

  // ---------- gateway (fe) API ----------
  app.get('/api/fe/verify', async () => ({ ok: true, locale: store.data.settings.locale, version: '0.1.0' }));

  app.get('/api/fe/health', async () => ({
    dsh: manager.getStatus(),
    dshPkg: updaterInfo.currentDshVersion(),
    logs: manager.recentLogs(40),
    uptime: Math.round(process.uptime()),
    automations: store.data.automations.length,
    home: path.dirname(dshHome()),
  }));

  app.get('/api/fe/pairing', async () => ({
    token: store.data.token,
    lanUrls: lanUrls(port),
    externalUrl: store.data.settings.externalBaseUrl || null,
    port,
  }));

  // --- short pairing code endpoints
  // (re)generate a 6-digit pairing code (authed: only the already-paired desktop)
  app.post('/api/fe/paircode', async () => {
    const code = newPairCode();
    return { code, expiresAt: 0 };
  });
  // read the current pairing code (authed)
  app.get('/api/fe/paircode', async () => getPairCode());
  // exchange a pairing code for the long-lived token (UNAUTHENTICATED by design)
  app.post('/api/fe/pair/exchange', async (req, reply) => {
    const ip = req.ip || 'unknown';
    if (rateLimited(ip)) return reply.code(429).send({ error: 'too many attempts' });
    const body = req.body as { code?: string };
    const code = (body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'invalid-code' };
    if (!pairCode) return { ok: false, error: 'no-code' };
    if (code !== pairCode) return { ok: false, error: 'wrong-code' };
    // single-use: consume immediately
    pairCode = null;
    return { ok: true, token: store.data.token };
  });
  // loopback auto-pair: the PC's own browser (127.0.0.1/localhost + loopback Host header)
  // enters without any code. Same trust model as dsh itself; the Host check defeats
  // DNS rebinding, and no CORS means remote pages cannot read the token.
  app.post('/api/fe/auto-pair', async (req, reply) => {
    const ip = req.ip || '';
    const host = (req.headers.host || '').toLowerCase();
    const loopbackIp = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const loopbackHost = host === '127.0.0.1' || host === 'localhost' || host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
    if (!loopbackIp || !loopbackHost) return reply.code(403).send({ error: 'loopback-only' });
    return { ok: true, token: store.data.token };
  });

  app.post('/api/fe/token/reset', async () => ({ token: store.rotateToken() }));

  // dsh updater: check (and apply) a newer @deepseek-ai/dsh
  app.post('/api/fe/dsh/update', async (req) => {
    const force = ((req.body as { force?: boolean }) || {}).force !== false;
    return updaterInfo.checkForUpdate(force);
  });

  // file upload → dsh raw-byte route; body is the file itself (octet-stream)
  app.post('/api/fe/upload', async (req, reply) => {
    const q = req.query as { sessionId?: string; name?: string };
    if (!q.sessionId || !/^session-[a-zA-Z0-9-]+$/.test(q.sessionId)) {
      return reply.code(400).send({ error: 'bad sessionId' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty body — send the file as application/octet-stream' });
    }
    return dsh.uploadFile(q.sessionId, q.name, body);
  });

  // un-archive one session: dsh rc.2 has no unarchive API, so rewrite the
  // registry file and restart the (supervised) dsh child so it reloads state.
  // Refused while any session is running — the restart would cut their streams.
  app.post('/api/fe/archive/restore', async (req, reply) => {    const { sessionId } = (req.body || {}) as { sessionId?: string };
    if (!sessionId || !/^session-[a-zA-Z0-9-]+$/.test(sessionId)) {
      return reply.code(400).send({ error: 'bad sessionId' });
    }
    const list = await dsh.call<{ items: Array<{ sessionId: string; running?: boolean }> }>('session.list', {});
    if (list.ok && list.value?.items?.some((x) => x.running)) {
      return reply.code(409).send({ error: 'busy', message: 'a session is running; restore would interrupt it' });
    }
    const file = `${dshHome()}/storages/workspace.json`;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return reply.code(500).send({ error: 'workspace storage unreadable' });
    }
    const doc = JSON.parse(raw) as { global?: { archivedSessionIds?: string[] } };
    const before = doc.global?.archivedSessionIds ?? [];
    if (!before.includes(sessionId)) return { ok: true, already: true };
    doc.global = { ...doc.global, archivedSessionIds: before.filter((id) => id !== sessionId) };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    manager.killDshNow(); // supervisor respawns it; fresh process re-reads the file
    return { ok: true };
  });

  app.get('/api/fe/settings', async () => store.data.settings);

  // cross-session persistent memory (markdown files + AGENTS.md block)
  app.get('/api/fe/memory', async () => ({
    enabled: memory.memoryEnabled(),
    dir: memory.memoryDirPath(),
    ...memory.listMemory(),
  }));
  app.put('/api/fe/memory/file', async (req) => {
    const { name, content } = (req.body || {}) as { name?: string; content?: string };
    return memory.writeMemoryFile(String(name || ''), String(content ?? ''));
  });
  app.delete('/api/fe/memory/file', async (req) => {
    const name = (req.query as { name?: string }).name || '';
    return memory.deleteMemoryFile(String(name));
  });
  app.post('/api/fe/memory/toggle', async (req) => {
    const { enabled } = (req.body || {}) as { enabled?: boolean };
    return memory.setMemoryEnabled(!!enabled);
  });

  // idle-time task queue
  app.get('/api/fe/idle', async () => idle.idleState());
  app.post('/api/fe/idle/config', async (req) => {
    const { enabled, idleMinutes } = (req.body || {}) as { enabled?: boolean; idleMinutes?: number };
    idle.setIdleConfig(!!enabled, idleMinutes);
    return idle.idleState();
  });
  app.post('/api/fe/idle/task', async (req) => {
    const { prompt, cwd } = (req.body || {}) as { prompt?: string; cwd?: string };
    if (!prompt || !String(prompt).trim()) return { ok: false, error: 'empty prompt' };
    return { ok: true, task: idle.addIdleTask(String(prompt), cwd ? String(cwd) : undefined) };
  });
  app.delete('/api/fe/idle/task', async (req) => {
    const id = (req.query as { id?: string }).id || '';
    idle.removeIdleTask(String(id));
    return { ok: true };
  });
  app.put('/api/fe/settings', async (req) => {
    const body = req.body as Record<string, unknown>;
    const s = store.data.settings as unknown as Record<string, unknown>;
    if (body.locale === 'zh' || body.locale === 'en') s.locale = body.locale;
    if (body.theme === 'dark' || body.theme === 'light' || body.theme === 'system') s.theme = body.theme;
    if (typeof body.externalBaseUrl === 'string') s.externalBaseUrl = body.externalBaseUrl.trim().replace(/\/+$/, '');
    if (typeof body.openBrowserOnStart === 'boolean') s.openBrowserOnStart = body.openBrowserOnStart;
    if (typeof body.remoteEnabled === 'boolean') s.remoteEnabled = body.remoteEnabled;
    if (typeof body.autoUpdateDsh === 'boolean') s.autoUpdateDsh = body.autoUpdateDsh;
    // push notifications (bark / ntfy)
    if (body.pushChannel === 'off' || body.pushChannel === 'bark' || body.pushChannel === 'ntfy') s.pushChannel = body.pushChannel;
    for (const k of ['barkServer', 'barkKey', 'ntfyServer', 'ntfyTopic'] as const) {
      if (typeof body[k] === 'string') s[k] = (body[k] as string).trim();
    }
    for (const k of ['pushOnTurnEnd', 'pushOnApproval'] as const) {
      if (typeof body[k] === 'boolean') s[k] = body[k];
    }
    // frp tunnel
    if (typeof body.frpcPath === 'string') s.frpcPath = body.frpcPath.trim();
    if (typeof body.frpServer === 'string') s.frpServer = body.frpServer.trim();
    if (typeof body.frpToken === 'string') s.frpToken = body.frpToken.trim();
    if (Number.isFinite(Number(body.frpRemotePort))) s.frpRemotePort = Number(body.frpRemotePort);
    if (typeof body.frpServerPort === 'string') s.frpServerPort = body.frpServerPort.trim() || '7000';
    if (typeof body.frpEnabled === 'boolean') s.frpEnabled = body.frpEnabled;
    if (typeof body.cfdAutoStart === 'boolean') s.cfdAutoStart = body.cfdAutoStart;
    // DNSPod DDNS
    for (const k of ['ddnsToken', 'ddnsDomain', 'ddnsSub'] as const) {
      if (typeof body[k] === 'string') s[k] = (body[k] as string).trim();
    }
    if (typeof body.ddnsEnabled === 'boolean') s.ddnsEnabled = body.ddnsEnabled;
    if (body.acmeProvider === 'dnspod' || body.acmeProvider === 'aliyun') s.acmeProvider = body.acmeProvider;
    for (const k of ['acmeEmail', 'acmeAliAccessKeyId', 'acmeAliAccessKeySecret'] as const) {
      if (typeof body[k] === 'string') s[k] = (body[k] as string).trim();
    }
    store.save();
    return s;
  });

  app.post('/api/fe/push/test', async () => pushTest());

  // what the outside world could reach us at: public IPv6 (if any) plus
  // the machine's own global v6 addresses, for the zero-cost direct route
  app.get('/api/fe/netinfo', async () => {
    let publicV6 = '';
    let publicV4 = '';
    try {
      const r = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
      const j = (await r.json()) as { ip?: string };
      if (j.ip?.includes(':')) publicV6 = j.ip;
      else if (j.ip) publicV4 = j.ip;
    } catch { /* offline / blocked */ }
    if (!publicV6) {
      try {
        const r = await fetch('https://ipv6.icanhazip.com', { signal: AbortSignal.timeout(6000) });
        const t = (await r.text()).trim();
        if (t.includes(':')) publicV6 = t;
      } catch { /* no v6 route */ }
    }
    const localV6: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv6' && !ni.internal && !ni.address.startsWith('fe80::')) localV6.push(ni.address);
      }
    }
    // reachability of the foreign services the zero-cost routes depend on
    // (mainland users often cannot reach them directly)
    const reach = async (u: string) => {
      try {
        const r = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
        return r.status < 500;
      } catch {
        return false;
      }
    };
    const [duckdns, cloudflare, github] = await Promise.all([
      reach('https://www.duckdns.org/'),
      reach('https://trycloudflare.com/'),
      reach('https://github.com/'),
    ]);
    return { publicV6, publicV4, localV6, gatewayPort: Number(process.env.G4D_PORT) || 7420, reach: { duckdns, cloudflare, github } };
  });

  // DuckDNS helper for the wizard: the user only logs in once and pastes
  // their token — domain creation, IP binding and DNS verification happen here
  app.post('/api/fe/duckdns/bind', async (req) => {
    const { token, domain, ip, ipv6 } = (req.body || {}) as { token?: string; domain?: string; ip?: string; ipv6?: string };
    if (!token || !/^[a-f0-9-]{10,}$/.test(token)) return { ok: false, error: 'token 格式不对（DuckDNS 页面顶部那串）' };
    if (!domain || !/^[a-z0-9-]{3,64}$/.test(domain)) return { ok: false, error: '名字只能用小写字母、数字和横线' };
    const q = new URLSearchParams({ domains: domain, token });
    if (ip) q.set('ip', ip);
    if (ipv6) q.set('ipv6', ipv6);
    try {
      const res = await fetch('https://www.duckdns.org/update?' + q.toString(), { signal: AbortSignal.timeout(10000) });
      const text = (await res.text()).trim();
      return { ok: text === 'OK', response: text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/fe/duckdns/check', async (req) => {
    const { host } = (req.body || {}) as { host?: string };
    if (!host || !/^[a-z0-9.-]{4,200}$/i.test(host)) return { ok: false, error: 'bad host' };
    const dns = await import('node:dns/promises');
    let a: string[] = [];
    let aaaa: string[] = [];
    // raw resolve4/6 can be blocked (VPN DNS interception); lookup() goes
    // through the OS resolver and works everywhere
    try {
      const rs = await dns.lookup(host, { all: true });
      a = rs.filter((x) => x.family === 4).map((x) => x.address);
      aaaa = rs.filter((x) => x.family === 6).map((x) => x.address);
    } catch { /* unresolvable */ }
    return { ok: a.length > 0 || aaaa.length > 0, a, aaaa };
  });

  // connectivity probe for the setup wizard: is the public URL reachable,
  // and (for https) how many days does the certificate have left
  app.post('/api/fe/probe', async (req) => {
    const { url } = (req.body || {}) as { url?: string };
    if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: 'bad url' };
    const started = Date.now();
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const ms = Date.now() - started;
      let certDays: number | null = null;
      if (url.startsWith('https:')) {
        certDays = await new Promise<number | null>(async (resolve) => {
          try {
            const u = new URL(url);
            const tls = await import('node:tls');
            const sock = tls.connect(
              { host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false },
              () => {
                const cert = sock.getPeerCertificate();
                sock.destroy();
                resolve(cert?.valid_to ? Math.max(0, Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)) : null);
              },
            );
            sock.on('error', () => resolve(null));
          } catch {
            resolve(null);
          }
        });
      }
      return { ok: true, status: res.status, ms, https: url.startsWith('https:'), certDays };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
    }
  });

  // gateway-native HTTPS (ACME DNS-01, Let's Encrypt)
  app.get('/api/fe/tls/status', async () => acmeTls.tlsStatus());
  app.post('/api/fe/tls/issue', async (req) => acmeTls.issue(((req.body || {}) as { staging?: boolean }).staging === true));
  // DNSPod DDNS: the mainland-friendly fixed-domain route (¥10 domain + home IPv6)
  app.get('/api/fe/ddns/status', async () => ddns.status());
  app.post('/api/fe/ddns/apply', async () => ddns.apply());

  // self-restart: kill supervised children, exit; WinSW (onfailure restart)
  // relaunches the gateway with fresh dist 5s later — no UAC needed ever again.
  // Token-fenced like every other admin endpoint.
  app.post('/api/fe/gateway/restart', async () => {
    setTimeout(() => {
      try { manager.killDshNow(); } catch { /* already gone */ }
      try { frp.stop(); } catch { /* ignore */ }
      try { cfd.quickStop(); cfd.namedStop(); } catch { /* ignore */ }
      setTimeout(() => process.exit(1), 800);
    }, 300);
    return { ok: true, relaunch: '5s' };
  });
  // cloudflared (Cloudflare Tunnel) control for the wizard
  app.get('/api/fe/cfd/status', async () => cfd.status());
  app.post('/api/fe/cfd/install', async () => cfd.install());
  app.post('/api/fe/cfd/login', async () => cfd.login());
  app.post('/api/fe/cfd/quick/start', async () => cfd.quickStart());
  app.post('/api/fe/cfd/quick/stop', async () => cfd.quickStop());
  app.post('/api/fe/cfd/named/create', async (req) => cfd.namedCreate(String(((req.body || {}) as { hostname?: string }).hostname || '')));
  app.post('/api/fe/cfd/named/run', async () => cfd.namedRun());
  app.post('/api/fe/cfd/named/stop', async () => cfd.namedStop());

  // frp tunnel control
  app.get('/api/fe/frp/status', async () => frp.status());
  app.post('/api/fe/frp/start', async () => frp.start());
  app.post('/api/fe/frp/stop', async () => frp.stop());

  // task meta + groups
  app.get('/api/fe/taskmeta', async () => ({ meta: store.data.taskMeta, groups: store.data.taskGroups }));
  app.put('/api/fe/taskmeta/:sid', async (req) => {
    const { sid } = req.params as { sid: string };
    const body = req.body as { pinned?: boolean; groupId?: string | null; notes?: string };
    const cur = store.data.taskMeta[sid] || { updatedAt: Date.now() };
    if (body.pinned !== undefined) cur.pinned = body.pinned;
    if (body.groupId !== undefined) cur.groupId = body.groupId || undefined;
    if (body.notes !== undefined) cur.notes = body.notes;
    cur.updatedAt = Date.now();
    store.data.taskMeta[sid] = cur;
    store.save();
    return cur;
  });
  app.post('/api/fe/groups', async (req) => {
    const body = req.body as { title?: string; color?: string };
    const g = {
      id: manager.newId(),
      title: (body.title || '').trim() || 'Group',
      color: body.color || '#5b7cfa',
      createdAt: Date.now(),
    };
    store.data.taskGroups.push(g);
    store.save();
    return g;
  });
  app.patch('/api/fe/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const g = store.data.taskGroups.find((x) => x.id === id);
    if (!g) return { error: 'not found' };
    const body = req.body as { title?: string; color?: string };
    if (body.title !== undefined) g.title = body.title.trim() || g.title;
    if (body.color !== undefined) g.color = body.color;
    store.save();
    return g;
  });
  app.delete('/api/fe/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    store.data.taskGroups = store.data.taskGroups.filter((g) => g.id !== id);
    for (const m of Object.values(store.data.taskMeta)) if (m.groupId === id) m.groupId = undefined;
    store.save();
    return { ok: true };
  });

  // automations
  app.get('/api/fe/automations', async (req) => {
    const { runs } = (req.query as Record<string, string>) || {};
    const result: unknown[] = store.data.automations;
    if (runs !== undefined) {
      return { automations: result, runs: store.data.automationRuns.slice(0, Number(runs) || 50) };
    }
    return { automations: result };
  });
  app.post('/api/fe/automations', async (req) => {
    const created = automations.createAutomation((req.body || {}) as never);
    if ('error' in created) return { error: created.error };
    broadcast({ t: 'automation:changed' });
    return created;
  });
  app.patch('/api/fe/automations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const updated = automations.updateAutomation(id, (req.body || {}) as never);
    if ('error' in updated) return { error: updated.error };
    broadcast({ t: 'automation:changed' });
    return updated;
  });
  app.delete('/api/fe/automations/:id', async (req) => {
    automations.deleteAutomation((req.params as { id: string }).id);
    broadcast({ t: 'automation:changed' });
    return { ok: true };
  });
  app.post('/api/fe/automations/:id/run', async (req) => {
    const run = await automations.runAutomation((req.params as { id: string }).id, 'manual');
    return run ?? { error: 'not found or already running' };
  });

  // hooks
  app.get('/api/fe/hooks', async () => ({ hooks: store.data.hooks, runs: store.data.hookRuns.slice(0, 100) }));
  app.post('/api/fe/hooks', async (req) => {
    const body = (req.body || {}) as { name?: string; event?: string; sessionId?: string; actionType?: string; command?: string };
    const h = {
      id: manager.newId(),
      name: (body.name || '').trim() || 'Hook',
      event: (body.event || 'turn.completed') as import('./types.js').HookEventName,
      sessionId: body.sessionId || null,
      actionType: body.actionType === 'notify' ? 'notify' : 'shell',
      command: body.command || '',
      enabled: true,
      createdAt: Date.now(),
    } as import('./types.js').Hook;
    store.data.hooks.push(h);
    store.save();
    broadcast({ t: 'hook:changed' });
    return h;
  });
  app.patch('/api/fe/hooks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const h = store.data.hooks.find((x) => x.id === id);
    if (!h) return { error: 'not found' };
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.name === 'string') h.name = body.name.trim() || h.name;
    if (typeof body.event === 'string') h.event = body.event as never;
    if ('sessionId' in body) h.sessionId = (body.sessionId as string) || null;
    if (body.actionType === 'shell' || body.actionType === 'notify') h.actionType = body.actionType;
    if (typeof body.command === 'string') h.command = body.command;
    if (typeof body.enabled === 'boolean') h.enabled = body.enabled;
    store.save();
    broadcast({ t: 'hook:changed' });
    return h;
  });
  app.delete('/api/fe/hooks/:id', async (req) => {
    const { id } = req.params as { id: string };
    store.data.hooks = store.data.hooks.filter((h) => h.id !== id);
    store.save();
    broadcast({ t: 'hook:changed' });
    return { ok: true };
  });
  app.post('/api/fe/hooks/:id/test', async (req) => {
    const ok = testHook((req.params as { id: string }).id);
    return ok ? { ok: true } : { error: 'not found' };
  });

  // stats
  app.get('/api/fe/stats', async (req) => {
    backfillFromProjcache();
    const days = Math.min(730, Math.max(30, Number((req.query as Record<string, string>).days) || 366));
    const cutoff = Date.now() - days * 86400_000;
    const daily = Object.entries(store.data.usage)
      .filter(([date]) => new Date(`${date}T23:59:59`).getTime() >= cutoff)
      .map(([date, d]) => ({
        date,
        prompts: d.prompts,
        turns: d.turns,
        tokensIn: d.tokensIn,
        tokensOut: d.tokensOut,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        sessions: d.sessions.length,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const totals = daily.reduce(
      (acc, d) => ({
        turns: acc.turns + d.turns,
        prompts: acc.prompts + d.prompts,
        tokensIn: acc.tokensIn + d.tokensIn,
        tokensOut: acc.tokensOut + d.tokensOut,
      }),
      { turns: 0, prompts: 0, tokensIn: 0, tokensOut: 0 },
    );
    const models = [...store.data.models].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
    return { daily, totals, models };
  });

  // skills custom grouping
  app.get('/api/fe/skills/meta', async () => ({ groups: store.data.skillGroups, assign: store.data.skillAssign }));
  app.put('/api/fe/skills/meta', async (req) => {
    const body = (req.body || {}) as { groups?: typeof store.data.skillGroups; assign?: Record<string, string> };
    if (Array.isArray(body.groups)) store.data.skillGroups = body.groups;
    if (body.assign && typeof body.assign === 'object') store.data.skillAssign = body.assign;
    store.save();
    return { groups: store.data.skillGroups, assign: store.data.skillAssign };
  });

  // respond to dsh server-initiated requests (approvals / questions)
  app.post('/api/fe/respond', async (req) => {
    const body = req.body as { rpcId?: string; result?: unknown };
    if (!body?.rpcId || !body.result) return { error: 'rpcId and result required' };
    const accepted = await dsh.respond(body.rpcId, body.result as never);
    return { accepted };
  });

  // transparent passthrough to dsh RPC
  app.post('/api/dsh/:method', async (req, reply) => {
    const { method } = req.params as { method: string };
    if (!DSH_METHOD_RE.test(method)) {
      return reply.code(400).send({ error: `method not allowed: ${method}` });
    }
    const result = await dsh.call(method, req.body ?? {});
    return reply.send(result);
  });

  // SPA fallback
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api') || url === '/ws') {
      return reply.code(404).send({ error: 'not found' });
    }
    if (fs.existsSync(webDist)) {
      return reply.sendFile('index.html');
    }
    return reply.code(503).send({ error: 'web UI not built yet — run `npm run build` first' });
  });

  return app;
}
