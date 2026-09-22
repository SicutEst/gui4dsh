// gateway-native HTTPS: Let's Encrypt via ACME DNS-01, with the DNS provider
// doing the validation (DNSPod for the mainland route, Aliyun DNS for users
// whose domains live there). Certificates land in <dataDir>/certs/<fqdn>/ and
// are renewed automatically when under 30 days remain.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import acme, { forge } from 'acme-client';
import { store } from './store.js';
import { dataDir } from './config.js';

const CERTS_DIR = path.join(dataDir, 'certs');
const DIRECTORY_PROD = acme.directory.letsencrypt.production;
const DIRECTORY_STAGING = acme.directory.letsencrypt.staging;

type Provider = 'dnspod' | 'aliyun';

function cfg(): { provider: Provider; fqdn: string; email: string } | null {
  const s = store.data.settings as unknown as Record<string, unknown>;
  const fqdn = String(s.ddnsSub && s.ddnsDomain ? `${s.ddnsSub}.${s.ddnsDomain}` : '').trim().toLowerCase();
  const token = String(s.ddnsToken || '');
  const ak = String(s.acmeAliAccessKeyId || '');
  const sk = String(s.acmeAliAccessKeySecret || '');
  const provider: Provider | null = s.acmeProvider === 'aliyun' ? 'aliyun' : s.acmeProvider === 'dnspod' ? 'dnspod' : null;
  if (!fqdn || !provider) return null;
  if (provider === 'dnspod' && !token) return null;
  if (provider === 'aliyun' && (!ak || !sk)) return null;
  return { provider, fqdn, email: String(s.acmeEmail || 'admin@' + fqdn.split('.').slice(-2).join('.')) };
}

export function certPaths(fqdn: string): { cert: string; key: string } {
  return { cert: path.join(CERTS_DIR, fqdn, 'fullchain.pem'), key: path.join(CERTS_DIR, fqdn, 'privkey.pem') };
}

export async function tlsStatus(): Promise<{ enabled: boolean; fqdn: string; daysLeft: number | null }> {
  const c = cfg();
  if (!c) return { enabled: false, fqdn: '', daysLeft: null };
  try {
    const info = await forge.readCertificateInfo(fs.readFileSync(certPaths(c.fqdn).cert, 'utf8'));
    const days = Math.round((new Date(info.notAfter).getTime() - Date.now()) / 86400000);
    return { enabled: fs.existsSync(certPaths(c.fqdn).key), fqdn: c.fqdn, daysLeft: days };
  } catch {
    return { enabled: false, fqdn: c.fqdn, daysLeft: null };
  }
}

// ---- DNS providers: create / clear the _acme-challenge TXT record ----

function splitFqdn(fqdn: string): { rr: string; zone: string } {
  // dsh.example.com → rr=_acme-challenge.dsh, zone=example.com
  const parts = fqdn.split('.');
  return { rr: '_acme-challenge.' + parts[0], zone: parts.slice(1).join('.') };
}

async function dnspodApi(action: string, params: Record<string, string>): Promise<any> {
  const s = store.data.settings as unknown as Record<string, unknown>;
  const body = new URLSearchParams({ login_token: String(s.ddnsToken || ''), format: 'json', ...params });
  const res = await fetch(`https://api.dnspod.cn/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json()) as { status?: { code?: string; message?: string }; records?: any[] };
  if (String(j.status?.code) !== '1') throw new Error(`dnspod ${action}: ${j.status?.message || j.status?.code}`);
  return j;
}

function pctEncode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function aliyunApi(action: string, biz: Record<string, string>): Promise<any> {
  const s = store.data.settings as unknown as Record<string, unknown>;
  const ak = String(s.acmeAliAccessKeyId || '');
  const sk = String(s.acmeAliAccessKeySecret || '');
  const pub: Record<string, string> = {
    Action: action,
    AccessKeyId: ak,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2015-01-09',
    ...biz,
  };
  const sorted = Object.keys(pub).sort().map((k) => `${pctEncode(k)}=${pctEncode(pub[k])}`).join('&');
  const toSign = `POST&${pctEncode('/')}&${pctEncode(sorted)}`;
  const sig = crypto.createHmac('sha1', sk + '&').update(toSign).digest('base64');
  const res = await fetch('https://alidns.aliyuncs.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...pub, Signature: sig }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (j.Code) throw new Error(`alidns ${action}: ${j.Code} ${j.Message}`);
  return j;
}

async function setTxt(fqdn: string, value: string): Promise<() => Promise<void>> {
  const { rr, zone } = splitFqdn(fqdn);
  const c = cfg();
  if (c?.provider === 'aliyun') {
    await aliyunApi('AddDomainRecord', { DomainName: zone, RR: rr, Type: 'TXT', Value: value });
    return async () => {
      const list = (await aliyunApi('DescribeSubDomainRecords', { SubDomain: `${rr}.${zone}`, Type: 'TXT' })) as { DomainRecords?: { Record?: any[] } };
      for (const r of list.DomainRecords?.Record || []) {
        if (r.Value === value) await aliyunApi('DeleteDomainRecord', { RecordId: String(r.RecordId) });
      }
    };
  }
  const created = await dnspodApi('Record.Create', { domain: zone, sub_domain: rr, record_type: 'TXT', record_line: '默认', value });
  const id = String(created.record?.id || '');
  return async () => {
    if (id) await dnspodApi('Record.Remove', { domain: zone, record_id: id }).catch(() => undefined);
  };
}

// ---- issuance ----

function accountKeyPath(): string {
  return path.join(CERTS_DIR, 'account.key');
}

function loadOrCreateAccountKey(): crypto.KeyObject {
  try {
    return crypto.createPrivateKey(fs.readFileSync(accountKeyPath(), 'utf8'));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    fs.writeFileSync(accountKeyPath(), privateKey.export({ type: 'sec1', format: 'pem' }));
    return privateKey;
  }
}

export async function issue(staging = false): Promise<{ ok: boolean; error?: string; daysLeft?: number | null }> {
  const c = cfg();
  if (!c) return { ok: false, error: '请先在 DDNS 面板配置 Token 与域名（或选择阿里云 DNS 并填 AK）' };
  let cleanup: (() => Promise<void>) | null = null;
  try {
    loadOrCreateAccountKey(); // generate on first use
    const client = new acme.Client({ directoryUrl: staging ? DIRECTORY_STAGING : DIRECTORY_PROD, accountKey: fs.readFileSync(accountKeyPath(), 'utf8') });
    await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${c.email}`] });

    const order = await client.createOrder({ identifiers: [{ type: 'dns', value: c.fqdn }] });
    const authz = await client.getAuthorizations(order);

    // find the dns-01 authz: pending needs the TXT dance, valid skips straight to finalize
    let dnsAuthz = authz.find((a: any) => a.status === 'pending' && (a.challenges || []).some((ch: any) => ch.type === 'dns-01'));
    if (dnsAuthz) {
      const ch = (dnsAuthz as any).challenges.find((x: any) => x.type === 'dns-01');
      const keyAuth = await client.getChallengeKeyAuthorization(ch);

      cleanup = await setTxt(c.fqdn, keyAuth);
      await new Promise((r) => setTimeout(r, 30000)); // DNS propagation
      // skip local verifyChallenge (VPN DNS may lag); let LE's servers do the real check
      await client.completeChallenge(ch);
      await client.waitForValidStatus(dnsAuthz);
    }
    // authz already valid (cached) → fall through to finalize

    const [privateKey, csr] = await forge.createCsr({ commonName: c.fqdn, altNames: [c.fqdn] });
    await client.finalizeOrder(order, csr);
    const certPem = await client.getCertificate(order); // full chain PEM string
    const p = certPaths(c.fqdn);
    fs.mkdirSync(path.dirname(p.cert), { recursive: true });
    fs.writeFileSync(p.cert, certPem);
    fs.writeFileSync(p.key, privateKey.toString());
    return { ok: true, daysLeft: (await tlsStatus()).daysLeft };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (cleanup) await cleanup().catch(() => undefined);
  }
}

/** Daily check: renew under 30 days. */
export function init(): void {
  const tick = async () => {
    const s = await tlsStatus();
    if (s.enabled && s.daysLeft !== null && s.daysLeft < 30) {
      const r = await issue(false);
      if (!r.ok) console.log('[acme] renewal failed:', r.error);
      else console.log('[acme] certificate renewed');
    }
  };
  setInterval(() => void tick(), 24 * 60 * 60 * 1000);
  setTimeout(() => void tick(), 60_000);
}
