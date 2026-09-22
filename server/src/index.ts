import { spawn } from 'node:child_process';
import fs from 'node:fs';
import QRCode from 'qrcode';
import os from 'node:os';
import { DEFAULT_GATEWAY_PORT, DSH_USER_URL, DSH_URL, DSH_EXTERNAL, ensureDataDir } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { dsh, setDshBaseUrl, getDshBaseUrl } from './dsh/client.js';
import * as manager from './dsh/manager.js';
import { rebuild as rebuildAutomations } from './automations.js';
import { initHooks } from './hooks.js';
import { backfillFromProjcache, trackSessionEvent } from './stats.js';
import { startUpdater } from './updater.js';
import { pushTurnDone, pushApproval } from './push.js';
import * as frp from './frp.js';
import * as cfd from './cfd.js';
import * as ddns from './ddns.js';
import * as acmeTls from './acme.js';
import { buildServer, getPairCode as apiGetPairCode } from './api.js';

function parseArgs(): { port: number; open: boolean } {
  const args = process.argv.slice(2);
  let port = DEFAULT_GATEWAY_PORT;
  let open = store.data.settings.openBrowserOnStart;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[i + 1]);
    if (args[i] === '--no-open') open = false;
    if (args[i] === '--open') open = true;
  }
  return { port, open };
}

function lanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
}

async function waitForDsh(): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const res = await dsh.call('session.list', {});
    if (res.ok) {
      console.log('[gateway] dsh is up (session/list answered)');
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.error('[gateway] dsh did not become ready in 4 minutes; will keep retrying in background');
}

async function main(): Promise<void> {
  ensureDataDir();
  store.load();
  const { port, open } = parseArgs();

  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  gui4dsh — web frontend for dsh (mobile)    │');
  console.log('└─────────────────────────────────────────────┘');

  if (DSH_EXTERNAL) {
    manager.markExternal();
    console.log(`[gateway] attaching to external dsh at ${process.env.DSH_URL}`);
  } else {
    // manage our own instance on DSH_PORT — its built-in official UI (same port)
    // is what the user should bookmark on the desktop, so all surfaces share
    // one dsh instance and stay perfectly in sync
    manager.start();
  }

  // bridge dsh streams onto the gateway bus (drives ws clients, stats, hooks)
  dsh.watchMux((msg) => {
    bus.emit({ type: 'dsh:mux', rpcId: msg.rpcId, method: msg.method, frame: msg.frame });
    const frame = msg.frame as { type?: string; sessionId?: string; event?: { type: string; time: number; data?: unknown } };
    if (frame?.type === 'session/event' && frame.sessionId && frame.event) {
      trackSessionEvent(frame.sessionId, frame.event);
      if (frame.event.type === 'turn/end') {
        // history replay (follow snapshot) re-emits old events: only push live ones
        const evTime = frame.event.time;
        if (typeof evTime === 'number' && Math.abs(Date.now() - evTime) > 2 * 60_000) return;
        const reason = (frame.event.data as { reason?: { kind?: string } } | undefined)?.reason;
        void pushTurnDone(frame.sessionId, reason?.kind);
      }
    }
    if (msg.method === 'approval/requested' && (frame as any)?.sessionId) {
      const f = frame as any;
      const summary = [f.toolName, typeof f.reason === 'string' ? f.reason : ''].filter(Boolean).join('：');
      void pushApproval(f.sessionId as string, summary);
    }
  });
  const wasRunning = new Map<string, boolean>();
  dsh.watchHost((msg) => {
    bus.emit({ type: 'dsh:host', frame: msg.frame });
    const frame = msg.frame as { type?: string; sessionId?: string; running?: boolean };
    if (frame?.type === 'host/session-status' && frame.sessionId) {
      const prev = wasRunning.get(frame.sessionId);
      wasRunning.set(frame.sessionId, !!frame.running);
      if (prev === true && frame.running === false) void pushTurnDone(frame.sessionId);
    }
  });

  initHooks();
  rebuildAutomations();
  backfillFromProjcache();
  frp.init();
  cfd.init();
  ddns.init();
  acmeTls.init();

  const app = await buildServer(port);
  await app.listen({ port, host: '::' }); // dual-stack: public IPv6 can reach us directly

  // native HTTPS on a second port when a certificate has been issued —
  // the IPv6-direct route then gets encryption without any relay
  const tls = await acmeTls.tlsStatus();
  if (tls.enabled) {
    const { certPaths } = await import('./acme.js');
    const p2 = acmeTls.certPaths(tls.fqdn);
    const tlsPort = Number(process.env.G4D_TLS_PORT || 7443);
    try {
      const app2 = await buildServer(tlsPort, { key: fs.readFileSync(p2.key), cert: fs.readFileSync(p2.cert) });
      await app2.listen({ port: tlsPort, host: '::' });
      console.log('[gateway] native https on :' + tlsPort + ' for ' + tls.fqdn);
    } catch (e) {
      console.log('[gateway] https listener failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const localUrl = `http://127.0.0.1:${port}`;
  const pairingUrl = `${localUrl}/#token=${store.data.token}`;
  console.log(`\n[gateway] listening on ${localUrl} (LAN: 0.0.0.0:${port})`);
  console.log(`[gateway] pairing token: ${store.data.token}`);
  console.log(`[gateway] 6-digit pairing code: ${apiGetPairCode().code ?? '(generate in Settings → Remote access)'}\n`);

  for (const ip of lanIps()) {
    const url = `http://${ip}:${port}/#token=${store.data.token}`;
    try {
      const qr = await QRCode.toString(url, { type: 'terminal', small: true });
      console.log(`手机扫码连接 (${ip}):\n${qr}${url}\n`);
    } catch {
      console.log(`手机访问: ${url}`);
    }
  }
  if (store.data.settings.externalBaseUrl) {
    console.log(`外部地址(frp): ${store.data.settings.externalBaseUrl}/#token=${store.data.token}\n`);
  }

  void waitForDsh();
  startUpdater();

  if (open) openBrowser(pairingUrl);

  const shutdown = () => {
    console.log('\n[gateway] shutting down...');
    manager.shutdown();
    store.flushSync();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[gateway] fatal:', err);
  process.exit(1);
});
