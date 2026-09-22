// push notifications: Bark (iOS) + ntfy (cross-platform), fired on session
// turn completion and approval asks so the phone hears about finished or
// blocked work even with the app closed

import { store } from './store.js';
import { dsh } from './dsh/client.js';

interface PushCfg {
  channel: 'off' | 'bark' | 'ntfy';
  barkServer: string;
  barkKey: string;
  ntfyServer: string;
  ntfyTopic: string;
  onTurnEnd: boolean;
  onApproval: boolean;
}

export function pushCfg(): PushCfg {
  const s = store.data.settings as unknown as Record<string, unknown>;
  return {
    channel: (s.pushChannel as PushCfg['channel']) || 'off',
    barkServer: (s.barkServer as string) || 'https://api.day.app',
    barkKey: (s.barkKey as string) || '',
    ntfyServer: (s.ntfyServer as string) || 'https://ntfy.sh',
    ntfyTopic: (s.ntfyTopic as string) || '',
    onTurnEnd: s.pushOnTurnEnd !== false,
    onApproval: s.pushOnApproval !== false,
  };
}

function cfgReady(c: PushCfg): boolean {
  if (c.channel === 'bark') return !!c.barkKey.trim();
  if (c.channel === 'ntfy') return !!c.ntfyTopic.trim();
  return false;
}

async function deliver(title: string, body: string, url?: string): Promise<{ ok: boolean; error?: string }> {
  const c = pushCfg();
  if (!cfgReady(c)) return { ok: false, error: 'push not configured' };
  try {
    if (c.channel === 'bark') {
      const base = c.barkServer.replace(/\/+$/, '');
      const u = `${base}/${encodeURIComponent(c.barkKey.trim())}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=gui4dsh${url ? `&url=${encodeURIComponent(url)}` : ''}`;
      const res = await fetch(u, { method: 'GET' });
      return res.ok ? { ok: true } : { ok: false, error: `bark HTTP ${res.status}` };
    }
    const base = c.ntfyServer.replace(/\/+$/, '');
    // headers must stay ASCII: fold the (possibly Chinese) title into the body
    const res = await fetch(`${base}/${encodeURIComponent(c.ntfyTopic.trim())}`, {
      method: 'POST',
      headers: { priority: 'default', tags: 'whale' },
      body: `${title}\n${body}`,
    });
    return res.ok ? { ok: true } : { ok: false, error: `ntfy HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sessionTitleOf(sessionId: string): Promise<string> {
  const r = await dsh.call<{ items: Array<{ sessionId: string; projections?: { values?: Record<string, unknown> }; cwd?: string }> }>('session.list', {});
  if (!r.ok) return sessionId.slice(8, 18);
  const s = r.value.items.find((x) => x.sessionId === sessionId);
  const t = s?.projections?.values?.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return s?.cwd?.split(/[\\/]/).pop() || sessionId.slice(8, 18);
}

function pushUrl(sessionId: string): string {
  const base = store.data.settings.externalBaseUrl || '';
  return base ? `${base}/#s=${sessionId}` : '';
}

const recentPushed = new Map<string, number>();

/** One turn finished (turn/end on a followed session). */
export async function pushTurnDone(sessionId: string, reasonKind?: string): Promise<void> {
  const c = pushCfg();
  if (c.channel === 'off') return;
  if (!c.onTurnEnd) return;
  if (!cfgReady(c)) {
    console.log(`[push] turn done ${sessionId.slice(8, 18)} dropped: channel '${c.channel}' not configured (missing key/topic)`);
    return;
  }
  const last = recentPushed.get(sessionId) || 0;
  if (Date.now() - last < 90_000) {
    console.log(`[push] turn done ${sessionId.slice(8, 18)} skipped (dedup window)`);
    return;
  }
  recentPushed.set(sessionId, Date.now());

  const title = await sessionTitleOf(sessionId);
  const interrupted = reasonKind === 'interrupted';
  const r = await deliver(
    interrupted ? `任务已停止：${title}` : `任务完成：${title}`,
    interrupted ? '会话被中断' : 'dsh 已完成本轮任务，点开查看结果',
    pushUrl(sessionId),
  );
  console.log(`[push] turn done ${sessionId.slice(8, 18)} (${reasonKind || 'end'}) -> ${r.ok ? 'sent' : `FAILED: ${r.error}`}`);
}

/** dsh is asking the user to approve a tool call. */
export async function pushApproval(sessionId: string, summary: string): Promise<void> {
  const c = pushCfg();
  if (c.channel === 'off' || !c.onApproval) return;
  if (!cfgReady(c)) {
    console.log(`[push] approval ${sessionId.slice(8, 18)} dropped: channel '${c.channel}' not configured`);
    return;
  }
  const title = await sessionTitleOf(sessionId);
  const r = await deliver(`需要审批：${title}`, summary || 'dsh 请求执行一个工具调用，请打开处理', pushUrl(sessionId));
  console.log(`[push] approval ${sessionId.slice(8, 18)} -> ${r.ok ? 'sent' : `FAILED: ${r.error}`}`);
}

export async function pushTest(): Promise<{ ok: boolean; error?: string }> {
  return deliver('gui4dsh 测试推送', '推送通道已配置成功 ✓');
}
