// domestic DDNS for the mainland-friendly "¥10 domain + home IPv6 direct"
// route: manages a DNSPod record that tracks the home network's public IPv6
// (or IPv4 when the line actually has one). DNSPod legacy API keeps signing
// trivial (login_token), and api.dnspod.cn is directly reachable in China.

import { store } from './store.js';

interface DdnsCfg {
  token: string; // "id,secret" from the DNSPod console
  domain: string; // example.com
  sub: string; // dsh
  enabled: boolean;
}

export function ddnsCfg(): DdnsCfg | null {
  const s = store.data.settings as unknown as Record<string, unknown>;
  const token = String(s.ddnsToken || '');
  const domain = String(s.ddnsDomain || '').trim().toLowerCase();
  if (!token || !domain) return null;
  return { token, domain, sub: String(s.ddnsSub || 'dsh').trim().toLowerCase() || 'dsh', enabled: s.ddnsEnabled === true };
}

export function fqdn(): string {
  const c = ddnsCfg();
  return c ? `${c.sub}.${c.domain}` : '';
}

let lastApplied = '';
let lastError = '';
let timer: NodeJS.Timeout | null = null;

async function api(action: string, params: Record<string, string>): Promise<any> {
  const c = ddnsCfg();
  if (!c) throw new Error('未配置');
  const body = new URLSearchParams({
    login_token: c.token,
    format: 'json',
    lang: 'cn',
    error_on_empty: 'no',
    ...params,
  });
  const res = await fetch(`https://api.dnspod.cn/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json()) as { status?: { code?: string; message?: string }; records?: any[] };
  const code = String(j.status?.code ?? '');
  if (code !== '1') throw new Error(`${action}: ${j.status?.message || code}`);
  return j;
}

async function currentAddr(): Promise<{ v6: string; v4: string }> {
  let v6 = '';
  let v4 = '';
  try {
    const r = await fetch('https://ipv6.icanhazip.com', { signal: AbortSignal.timeout(6000) });
    const t = (await r.text()).trim();
    if (t.includes(':')) v6 = t;
  } catch { /* no v6 */ }
  try {
    const r = await fetch('https://ipv4.icanhazip.com', { signal: AbortSignal.timeout(6000) });
    const t = (await r.text()).trim();
    if (/\d+\.\d+/.test(t)) v4 = t;
  } catch { /* nat v4 */ }
  return { v6, v4 };
}

/** Detect the home IP and create/update the DNS records. */
export async function apply(): Promise<{ ok: boolean; error?: string; fqdn?: string; v6?: string; v4?: string }> {
  const c = ddnsCfg();
  const host = fqdn();
  if (!c) return { ok: false, error: '请先填写 DNSPod token 和域名' };
  try {
    const addr = await currentAddr();
    if (!addr.v6 && !addr.v4) return { ok: false, error: '没有检测到公网 IP（IPv6/IPv4 都没有），此路线当前不可用' };
    let sawChange = false;
    for (const [type, value] of [['AAAA', addr.v6], ['A', addr.v4]] as const) {
      if (!value) continue;
      const list = await api('Record.List', { domain: c.domain, sub_domain: c.sub, record_type: type });
      const existing = (list.records || []).find((r: any) => r.type === type && r.name === c.sub);
      if (existing && existing.value === value) continue;
      if (existing) {
        await api('Record.Modify', {
          domain: c.domain, record_id: String(existing.id), sub_domain: c.sub,
          record_type: type, record_line: '默认', value,
        });
      } else {
        await api('Record.Create', {
          domain: c.domain, sub_domain: c.sub, record_type: type,
          record_line: '默认', value,
        });
      }
      sawChange = true;
    }
    lastApplied = JSON.stringify(addr);
    lastError = '';
    return { ok: true, fqdn: host, v6: addr.v6, v4: addr.v4, error: sawChange ? undefined : '无变化（已是最新的 IP）' };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return { ok: false, error: lastError };
  }
}

export function status(): { configured: boolean; enabled: boolean; fqdn: string; lastApplied: string; lastError: string } {
  const c = ddnsCfg();
  return {
    configured: !!c,
    enabled: c?.enabled === true,
    fqdn: fqdn(),
    lastApplied,
    lastError,
  };
}

/** Keep the record fresh (home IPv6 changes on redial). */
export function init(): void {
  if (timer) clearInterval(timer);
  const tick = () => {
    const c = ddnsCfg();
    if (c?.enabled) void apply();
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  setTimeout(tick, 30_000);
}
