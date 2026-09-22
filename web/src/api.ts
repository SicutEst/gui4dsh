import type { RpcResult } from './types';

const TOKEN_KEY = 'g4d_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken()}`,
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('g4d:unauthorized'));
    throw new ApiError(401, 'unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return body as T;
}

/** Call a dsh RPC method through the gateway passthrough. Returns the RpcResult envelope. */
export async function dshCall<T = unknown>(method: string, payload: unknown = {}): Promise<RpcResult<T>> {
  return req<RpcResult<T>>(`/api/dsh/${method}`, { method: 'POST', body: JSON.stringify(payload ?? {}) });
}

export async function dshOk<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
  const r = await dshCall<T>(method, payload);
  if (!r.ok) throw new ApiError(400, r.error?.message || 'dsh error', r.error?.code);
  return r.value as T;
}

export const fe = {
  verify: () => req<{ ok: boolean; locale: string; version: string }>('/api/fe/verify'),
  health: () => req<{ dsh: string; logs: string[]; uptime: number }>('/api/fe/health'),
  pairing: () => req<import('./types').PairingInfo>('/api/fe/pairing'),
  resetToken: () => req<{ token: string }>('/api/fe/token/reset', { method: 'POST', body: '{}' }),
  restoreArchived: (sessionId: string) =>
    req<{ ok: boolean; already?: boolean }>('/api/fe/archive/restore', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  /** Upload one file's raw bytes; resolves the prompt receipt id. */
  uploadFile: async (sessionId: string, name: string, bytes: ArrayBuffer) => {
    const res = await fetch(`/api/fe/upload?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${getToken()}` },
      body: bytes,
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (!res.ok || !j.ok) throw new ApiError(res.status, j.error?.message || `upload failed (${res.status})`);
    return j.value as { receiptId?: string };
  },
  paircode: () => req<{ code: string | null; expiresAt: number }>('/api/fe/paircode'),
  newPaircode: () => req<{ code: string; expiresAt: number }>('/api/fe/paircode', { method: 'POST', body: '{}' }),
  exchangePaircode: (code: string) =>
    req<{ ok: boolean; token?: string; error?: string }>('/api/fe/pair/exchange', { method: 'POST', body: JSON.stringify({ code }) }),
  autoPair: () => req<{ ok: boolean; token?: string }>('/api/fe/auto-pair', { method: 'POST', body: JSON.stringify({}) }),
  settings: () => req<import('./types').GatewaySettings>('/api/fe/settings'),
  pushTest: () => req<{ ok: boolean; error?: string }>('/api/fe/push/test', { method: 'POST', body: '{}' }),
  memoryList: () => req<{ enabled: boolean; dir: string; files: Array<{ name: string; content: string }> }>('/api/fe/memory'),
  memoryWrite: (name: string, content: string) =>
    req<{ ok: boolean; error?: string }>('/api/fe/memory/file', { method: 'PUT', body: JSON.stringify({ name, content }) }),
  memoryDelete: (name: string) =>
    req<{ ok: boolean; error?: string }>(`/api/fe/memory/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  memoryToggle: (enabled: boolean) =>
    req<{ ok: boolean; error?: string }>('/api/fe/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  idleState: () =>
    req<{ enabled: boolean; idleMinutes: number; tasks: Array<{ id: string; prompt: string; cwd?: string; createdAt: number; status: string; sessionId?: string; startedAt?: number; error?: string }> }>('/api/fe/idle'),
  idleConfig: (enabled: boolean, idleMinutes?: number) =>
    req<{ enabled: boolean; idleMinutes: number; tasks: unknown[] }>('/api/fe/idle/config', { method: 'POST', body: JSON.stringify({ enabled, idleMinutes }) }),
  idleAddTask: (prompt: string, cwd?: string) =>
    req<{ ok: boolean; task?: { id: string } }>('/api/fe/idle/task', { method: 'POST', body: JSON.stringify({ prompt, cwd }) }),
  idleRemoveTask: (id: string) =>
    req<{ ok: boolean }>(`/api/fe/idle/task?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  browserStatus: () => req<{ enabled: boolean; script: string }>('/api/fe/browser'),
  browserToggle: (enabled: boolean) =>
    req<{ ok: boolean; error?: string; restarted?: boolean }>('/api/fe/browser/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  duckdnsBind: (token: string, domain: string, ip?: string, ipv6?: string) =>
    req<{ ok: boolean; response?: string; error?: string }>('/api/fe/duckdns/bind', { method: 'POST', body: JSON.stringify({ token, domain, ip, ipv6 }) }),
  duckdnsCheck: (host: string) =>
    req<{ ok: boolean; a?: string[]; aaaa?: string[] }>('/api/fe/duckdns/check', { method: 'POST', body: JSON.stringify({ host }) }),
  frpStatus: () => req<{ running: boolean; startedAt: number; config: unknown; log: string[] }>('/api/fe/frp/status'),
  frpStart: () => req<{ ok: boolean; error?: string }>('/api/fe/frp/start', { method: 'POST', body: '{}' }),
  frpStop: () => req<{ ok: boolean }>('/api/fe/frp/stop', { method: 'POST', body: '{}' }),
  saveSettings: (s: Partial<import('./types').GatewaySettings>) =>
    req<import('./types').GatewaySettings>('/api/fe/settings', { method: 'PUT', body: JSON.stringify(s) }),
  taskmeta: () => req<{ meta: Record<string, import('./types').TaskMeta>; groups: import('./types').TaskGroup[] }>('/api/fe/taskmeta'),
  setTaskMeta: (sid: string, patch: { pinned?: boolean; groupId?: string | null; notes?: string }) =>
    req<import('./types').TaskMeta>(`/api/fe/taskmeta/${sid}`, { method: 'PUT', body: JSON.stringify(patch) }),
  groups: {
    create: (title: string, color?: string) =>
      req<import('./types').TaskGroup>('/api/fe/groups', { method: 'POST', body: JSON.stringify({ title, color }) }),
    update: (id: string, patch: { title?: string; color?: string }) =>
      req<import('./types').TaskGroup>(`/api/fe/groups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: boolean }>(`/api/fe/groups/${id}`, { method: 'DELETE' }),
  },
  automations: () =>
    req<{ automations: import('./types').Automation[]; runs?: import('./types').AutomationRun[] }>('/api/fe/automations?runs=100'),
  createAutomation: (a: Partial<import('./types').Automation>) =>
    req<import('./types').Automation | { error: string }>('/api/fe/automations', { method: 'POST', body: JSON.stringify(a) }),
  updateAutomation: (id: string, patch: Partial<import('./types').Automation>) =>
    req<import('./types').Automation | { error: string }>(`/api/fe/automations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAutomation: (id: string) => req<{ ok: boolean }>(`/api/fe/automations/${id}`, { method: 'DELETE' }),
  runAutomation: (id: string) =>
    req<import('./types').AutomationRun | { error: string }>(`/api/fe/automations/${id}/run`, { method: 'POST' }),
  hooks: () =>
    req<{ hooks: import('./types').Hook[]; runs: import('./types').HookRun[] }>('/api/fe/hooks'),
  createHook: (h: Partial<import('./types').Hook>) =>
    req<import('./types').Hook>('/api/fe/hooks', { method: 'POST', body: JSON.stringify(h) }),
  updateHook: (id: string, patch: Partial<import('./types').Hook>) =>
    req<import('./types').Hook | { error: string }>(`/api/fe/hooks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteHook: (id: string) => req<{ ok: boolean }>(`/api/fe/hooks/${id}`, { method: 'DELETE' }),
  testHook: (id: string) => req<{ ok: boolean } | { error: string }>(`/api/fe/hooks/${id}/test`, { method: 'POST' }),
  stats: (days = 366) => req<import('./types').StatsPayload>(`/api/fe/stats?days=${days}`),
  skillsMeta: () =>
    req<{ groups: import('./types').SkillGroup[]; assign: Record<string, string> }>('/api/fe/skills/meta'),
  saveSkillsMeta: (data: { groups: import('./types').SkillGroup[]; assign: Record<string, string> }) =>
    req<{ groups: import('./types').SkillGroup[]; assign: Record<string, string> }>('/api/fe/skills/meta', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  respond: (rpcId: string, result: unknown) =>
    req<{ accepted: boolean }>('/api/fe/respond', { method: 'POST', body: JSON.stringify({ rpcId, result }) }),
};

export type WsStatus = 'connecting' | 'connected' | 'lost';

export function connectWs(onMsg: (msg: any) => void, onStatus: (s: WsStatus) => void): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;

  const connect = () => {
    if (closed) return;
    onStatus(attempt === 0 ? 'connecting' : 'lost');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    ws.onopen = () => {
      attempt = 0;
      onStatus('connected');
    };
    ws.onmessage = (ev) => {
      try {
        onMsg(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      attempt++;
      setTimeout(connect, Math.min(15000, 600 * attempt));
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  };

  connect();
  return () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}
