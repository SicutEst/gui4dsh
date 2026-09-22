import WebSocket from 'ws';
import { DSH_URL } from '../config.js';
import { getDshWebToken, markUp } from './manager.js';

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface StreamMessage {
  rpcId: string;
  method: string;
  frame: Record<string, unknown> & { type: string };
}

type FrameHandler = (msg: StreamMessage) => void;

function mintRpcId(): string {
  return crypto.randomUUID();
}

let dshBaseUrl = DSH_URL;

export function setDshBaseUrl(url: string): void {
  dshBaseUrl = url;
}

export function getDshBaseUrl(): string {
  return dshBaseUrl;
}

// ---------------------------------------------------------------------------
// dsh 0.1.5 auth: GET /?token=<launch token> sets a signed dsh-auth-* cookie
// ---------------------------------------------------------------------------
let authCookie = '';
let authCookieForToken = '';

async function ensureAuthCookie(): Promise<string> {
  const token = getDshWebToken();
  if (!token) return '';
  if (authCookie && authCookieForToken === token) return authCookie;
  try {
    const res = await fetch(`${dshBaseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const dshCookie = cookies.find((c) => c.startsWith('dsh-auth-'));
    if (dshCookie) {
      authCookie = dshCookie.split(';')[0];
      authCookieForToken = token;
    }
  } catch {
    /* retried on next call */
  }
  return authCookie;
}

function cookieHeader(): Record<string, string> {
  return authCookie ? { cookie: authCookie } : {};
}

// ---------------------------------------------------------------------------
// dsh 0.1.5 Typert gateway adaptation
//   unary:   POST /api/<namespace>/<method>  body {type:'client-request', rpcId,
//            method:<endpoint>, payload:{args:{request|_request:<old payload>}}}
//   streams: WS /api/remote.mux  {type:'open',streamId,endpoint,payload} /
//            {type:'item'|'end'|'error', streamId, ...}
// ---------------------------------------------------------------------------

/** old dot method -> new slash endpoint (with renames) */
const METHOD_MAP: Record<string, string> = {
  'skill.list': 'skills/list',
  'session.models': 'session/modelCatalog',
  'agentPreset.list': 'agentPresets/list',
  'agentPreset.select': 'agentPresets/select',
  'agentPreset.read': 'agentPresets/read',
  'agentPreset.copy': 'agentPresets/copy',
  'agentPreset.openDocument': 'agentPresets/openDocument',
  'agentPreset.remove': 'agentPresets/deletePreset',
};

function toEndpoint(method: string): string {
  if (METHOD_MAP[method]) return METHOD_MAP[method];
  const i = method.indexOf('.');
  return i < 0 ? method : `${method.slice(0, i)}/${method.slice(i + 1)}`;
}

/** old history payload -> new page payload (older-pages path only) */
function historyToPage(payload: any): any {
  const sid = payload?.sessionId;
  return {
    address: { kind: 'session', sessionId: sid },
    throughSeq: typeof payload?.beforeSeq === 'number' ? payload.beforeSeq - 1 : 0,
    beforeSeq: payload?.beforeSeq,
    ...(payload?.maxMessages !== undefined ? { maxMessages: payload.maxMessages } : {}),
  };
}

function pageToHistory(value: any): any {
  const records = Array.isArray(value?.records) ? value.records : [];
  return {
    events: records.filter((r: any) => r?.type === 'event' && r.event).map((r: any) => ({ event: r.event })),
    hasMore: !!value?.hasMore,
  };
}

interface PendingAsk {
  clientId: string;
  eventId: string;
}

class DshClient {
  private muxHandler: FrameHandler | null = null;
  private hostHandler: FrameHandler | null = null;

  private ws: WebSocket | null = null;
  private wsClosed = true;
  private wsAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private streamSeq = 0;
  private follows = new Map<string, string>(); // sessionId -> streamId
  private controlStreamId = ''; // host-wide queue/jobs/projection stream
  private pendingAsks = new Map<string, PendingAsk>(); // eventId -> ask
  private eventClientId = '';

  async call<T = unknown>(method: string, payload: unknown, timeoutMs = 120_000): Promise<RpcResult<T>> {
    void timeoutMs;
    if (method === 'workspace.list') {
      // no unary list endpoint exists: the follow stream's first frame is the baseline
      const first = await this.streamFirst<any>('workspace/follow', {});
      if (!first.ok) return first as RpcResult<T>;
      const frame = first.value;
      const baseline = frame?.type === 'baseline' ? frame.value : frame;
      return { ok: true, value: { items: baseline?.items ?? [], archivedSessionIds: baseline?.archivedSessionIds ?? [] } } as RpcResult<T>;
    }
    if (method === 'session.history') {
      const p = (payload ?? {}) as any;
      if (p.beforeSeq !== undefined) {
        // older pages go through the real pagination endpoint
        const inner = await this.unary<any>('session/page', historyToPage(payload));
        return inner.ok ? ({ ok: true, value: pageToHistory(inner.value) } as RpcResult<T>) : (inner as RpcResult<T>);
      }
      // tail page: the follow stream's opening snapshot carries it (records + cursor)
      const snap = await this.waitSnapshot(p.sessionId, p.maxMessages ?? 40);
      if (!snap) return { ok: false, error: { code: 'internal', message: 'session snapshot timeout' } };
      const records = snap.records || [];
      return {
        ok: true,
        value: {
          events: records.filter((r: any) => r?.type === 'event' && r.event).map((r: any) => ({ event: r.event })),
          hasMore: snap.cursor !== undefined && records.length >= (p.maxMessages ?? 40),
        },
      } as RpcResult<T>;
    }
    let body: any = payload ?? {};
    if (method === 'session.prompt' && body && !body.requestId) body = { ...body, requestId: mintRpcId() };
    const endpoint = toEndpoint(method);
    const res = await this.unary<T>(endpoint, body);
    // modelCatalog response -> old SessionModels shape for the web frontend
    if (res.ok && method === 'session.models') {
      const v = res.value as any;
      res.value = {
        current: v.default ?? v.current,
        routable: Array.isArray(v.routableProviders) ? v.routableProviders.length > 0 : !!v.routable,
        groups: v.groups ?? [],
        failures: v.failures ?? [],
      } as any;
    }
    if (res.ok) {
      const sid = (body as any)?.sessionId ?? (res.value as any)?.sessionId;
      if (typeof sid === 'string' && sid.startsWith('session-')) this.followSession(sid);
    }
    return res;
  }

  /** Stream one file to dsh's raw-byte upload route; returns the prompt receipt. */
  async uploadFile(sessionId: string, name: string | undefined, bytes: Buffer): Promise<RpcResult<unknown>> {
    const token = getDshWebToken();
    if (token && !authCookie) await ensureAuthCookie();
    const qs = new URLSearchParams({ sessionId });
    if (name) qs.set('name', name);
    try {
      const res = await fetch(`${dshBaseUrl}/api/session/uploadFileBinary?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...cookieHeader() },
        body: new Uint8Array(bytes),
      });
      if (res.status === 401) return { ok: false, error: { code: 'internal', message: 'dsh auth expired' } };
      const msg = (await res.json().catch(() => null)) as any;
      if (msg?.result === undefined && msg?.ok === undefined) {
        return { ok: false, error: { code: 'internal', message: `upload failed (${res.status})` } };
      }
      return (msg?.result ?? msg) as RpcResult<unknown>;
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async unary<T>(endpoint: string, payload: any, argsTry = 0): Promise<RpcResult<T>> {
    const rpcId = mintRpcId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      await ensureAuthCookie();
      // attempt 0: {_request}, 1: {request}, 2: flat named fields, 3: {} (no-parameter endpoints)
      let args: unknown;
      if (argsTry === 0) args = { _request: payload ?? {} };
      else if (argsTry === 1) args = { request: payload ?? {} };
      else if (argsTry === 2) args = payload ?? {};
      else args = {};
      const res = await fetch(`${dshBaseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader() },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        authCookie = '';
        return { ok: false, error: { code: 'internal', message: 'dsh auth expired' } };
      }
      const msg = (await res.json().catch(() => null)) as any;
      const result = msg?.result;
      if (result === undefined) return { ok: false, error: { code: 'internal', message: `malformed response (${res.status})` } };
      if (!result.ok && result.error?.code === 'gateway/arguments-invalid' && argsTry < 3) {
        const m = String(result.error.message || '');
        const missing = /missing "([a-zA-Z_]+)"/.exec(m);
        const wantsOtherName = (missing && missing[1] !== '_request') || m.includes('unexpected "_request"');
        // both named forms rejected and the complaint is about an unexpected field -> try flat, then empty args
        const wantsEmpty = argsTry === 2 && (m.includes('unexpected') && !missing);
        if (wantsOtherName || wantsEmpty) return this.unary<T>(endpoint, payload, argsTry + 1);
      }
      markUp();
      return result as RpcResult<T>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'internal', message: `transport: ${message}` } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Answer a server-initiated ask (approval / question). rpcId = eventId. */
  async respond(rpcId: string, result: RpcResult<unknown>): Promise<boolean> {
    const ask = this.pendingAsks.get(rpcId);
    if (!ask) return false;
    this.pendingAsks.delete(rpcId);
    await ensureAuthCookie();
    try {
      const res = await fetch(`${dshBaseUrl}/api/$events/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader() },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: mintRpcId(),
          method: '$events/result',
          payload: {
            args: {
              clientId: ask.clientId,
              eventId: ask.eventId,
              outcome: result.ok
                ? { kind: 'result', value: result.value }
                : { kind: 'rejected', error: { code: 'cancelled', message: 'client rejected' } },
            },
          },
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ WS mux

  watchMux(handler: FrameHandler): () => void {
    this.muxHandler = handler;
    this.ensureWs();
    return () => {
      this.muxHandler = null;
    };
  }

  watchHost(handler: FrameHandler): () => void {
    this.hostHandler = handler;
    this.ensureWs();
    return () => {
      this.hostHandler = null;
    };
  }

  restartStreams(): void {
    this.dropWs();
    this.ensureWs();
  }

  private ensureWs(): void {
    if (!this.wsClosed || this.ws) return;
    void this.openWs();
  }

  private dropWs(): void {
    this.wsClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.follows.clear();
    this.pendingAsks.clear();
  }

  private async openWs(): Promise<void> {
    await ensureAuthCookie();
    if (!authCookie) {
      this.scheduleReconnect();
      return;
    }
    const url = `${dshBaseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: cookieHeader() });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.wsClosed = false;
    ws.onopen = () => {
      this.wsAttempt = 0;
      markUp();
      this.streamSeq = 0;
      this.sendWs({ type: 'open', streamId: this.nextStreamId('ev'), endpoint: '$events', payload: { args: {} } });
      // host-wide live control state (queues, background jobs, projections incl. goal)
      const ctl = this.nextStreamId('ctl');
      this.controlStreamId = ctl;
      this.sendWs({ type: 'open', streamId: ctl, endpoint: 'session/control', payload: { args: {} } });
    };
    ws.onmessage = (ev: { data: unknown }) => {
      try {
        const m = JSON.parse(String((ev as { data: unknown }).data));
        this.onMuxMessage(m);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.wsClosed = true;
      this.follows.clear();
      this.followMax.clear();
      this.controlStreamId = '';
      this.pendingAsks.clear();
      // fail any pending snapshot waiters so history requests don't hang
      for (const [, w] of this.snapshotWaiters) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      this.snapshotWaiters.clear();
      for (const [, w] of this.streamFirstWaiters) {
        clearTimeout(w.timer);
        w.resolve({ ok: false, error: { code: 'internal', message: 'dsh ws closed' } });
      }
      this.streamFirstWaiters.clear();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || (this.muxHandler === null && this.hostHandler === null)) return;
    this.wsAttempt++;
    const delay = Math.min(15000, 800 * this.wsAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureWs();
    }, delay);
  }

  private nextStreamId(prefix: string): string {
    this.streamSeq += 1;
    return `${prefix}${this.streamSeq}`;
  }

  private streamFirstWaiters = new Map<string, { resolve: (v: RpcResult<any>) => void; timer: NodeJS.Timeout }>();

  /** Open one stream, resolve with its FIRST item, then cancel the stream. */
  private streamFirst<T>(endpoint: string, payload: unknown, timeoutMs = 20_000): Promise<RpcResult<T>> {
    return new Promise((resolve) => {
      this.ensureWs();
      const streamId = this.nextStreamId('sf');
      const timer = setTimeout(() => {
        this.streamFirstWaiters.delete(streamId);
        this.sendWs({ type: 'cancel', streamId });
        resolve({ ok: false, error: { code: 'internal', message: 'stream first item timeout' } });
      }, timeoutMs);
      this.streamFirstWaiters.set(streamId, { resolve, timer });
      this.sendWs({ type: 'open', streamId, endpoint, payload: { args: payload ?? {} } });
    });
  }

  private sendWs(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  /** Subscribe to one session's durable event stream (idempotent). */
  followSession(sessionId: string, maxMessages?: number, forceReopen = false): void {
    if (!sessionId) return;
    const existing = this.follows.get(sessionId);
    if (existing) {
      // snapshots are emitted only at stream open; a history request on an
      // already-followed session must cancel + reopen or it will never arrive
      const waiter = this.snapshotWaiters.get(sessionId);
      const needReopen = forceReopen || (waiter && maxMessages && (this.followMax.get(sessionId) ?? 0) < maxMessages);
      if (!needReopen) return;
      this.sendWs({ type: 'cancel', streamId: existing });
      this.follows.delete(sessionId);
    }
    const streamId = this.nextStreamId('fs');
    this.follows.set(sessionId, streamId);
    this.followMax.set(sessionId, maxMessages ?? 0);
    this.sendWs({
      type: 'open',
      streamId,
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId },
            assistantStream: true,
            ...(maxMessages !== undefined ? { maxMessages } : {}),
          },
        },
      },
    });
  }

  private snapshotWaiters = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
  private followMax = new Map<string, number>();

  /** Resolve with the follow stream's opening snapshot (records+cursor) for one session. */
  private waitSnapshot(sessionId: string, maxMessages: number): Promise<any> {
    return new Promise((resolve) => {
      const prev = this.snapshotWaiters.get(sessionId);
      if (prev) clearTimeout(prev.timer);
      this.followSession(sessionId, maxMessages, true);
      const timer = setTimeout(() => {
        this.snapshotWaiters.delete(sessionId);
        resolve(null);
      }, 25_000);
      this.snapshotWaiters.set(sessionId, { resolve, timer });
    });
  }

  private onMuxMessage(m: any): void {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'item') {
      const waiter = this.streamFirstWaiters.get(m.streamId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.streamFirstWaiters.delete(m.streamId);
        this.sendWs({ type: 'cancel', streamId: m.streamId });
        waiter.resolve({ ok: true, value: m.value });
        return;
      }
      this.onStreamItem(m.streamId, m.value);
    } else if (m.type === 'error') {
      const waiter = this.streamFirstWaiters.get(m.streamId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.streamFirstWaiters.delete(m.streamId);
        const err = (m as any).error;
        waiter.resolve({ ok: false, error: { code: err?.code ?? 'internal', message: err?.message ?? String(err ?? 'stream error') } });
        return;
      }
      for (const [sid, fid] of this.follows) {
        if (fid === m.streamId) this.follows.delete(sid);
      }
    }
  }

  private onStreamItem(streamId: string, value: any): void {
    if (!value || typeof value !== 'object') return;
    if (streamId === this.controlStreamId) {
      this.onControlItem(value);
      return;
    }
    const sid = this.sessionOf(streamId);
    if (!sid) {
      // $events stream (or unknown) — host-level events / asks
      this.onEventItem(value);
      return;
    }
    // session/follow stream -> old session/event frames
    if (value.type === 'snapshot') {
      const records = value.records || [];
      // satisfy a pending history request with the same snapshot
      const waiter = this.snapshotWaiters.get(sid);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.snapshotWaiters.delete(sid);
        waiter.resolve(value);
      }
      for (const rec of records) {
        if (rec?.type === 'event' && rec.event) {
          this.emitMux('session/event', sid, { type: 'session/event', sessionId: sid, event: rec.event });
        }
      }
      return;
    }
    if (value.type === 'event' && value.event) {
      this.emitMux('session/event', sid, { type: 'session/event', sessionId: sid, event: value.event });
      return;
    }
    // assistant-stream frames: the frontend folds raw SessionEvents; token-level
    // deltas arrive fast enough through follow events, so ignore these.
  }

  private sessionOf(streamId: string): string {
    for (const [sid, fid] of this.follows) if (fid === streamId) return sid;
    return '';
  }

  /** session/control frames: baseline {queues, jobs, projections} then live replacements. */
  private controlCache = new Map<string, { queue?: unknown; jobs?: unknown; projections?: Map<string, { value: unknown; seq: number }> }>();

  /** Reconnect baseline for freshly attached web clients (dsh:mux frames). */
  controlSnapshot(): Array<Record<string, unknown> & { type: string }> {
    const out: Array<Record<string, unknown> & { type: string }> = [];
    for (const [sessionId, c] of this.controlCache) {
      if (c.queue) out.push({ type: 'session/queue', sessionId, items: c.queue });
      if (c.jobs) out.push({ type: 'session/jobs', sessionId, jobs: c.jobs });
      for (const [key, p] of c.projections || []) {
        out.push({ type: 'session/projection', sessionId, key, value: p.value, seq: p.seq });
      }
    }
    return out;
  }

  private cacheControl(sessionId: string, patch: (c: { queue?: unknown; jobs?: unknown; projections?: Map<string, { value: unknown; seq: number }> }) => void): void {
    let c = this.controlCache.get(sessionId);
    if (!c) {
      c = { projections: new Map() };
      this.controlCache.set(sessionId, c);
    }
    patch(c);
  }

  private onControlItem(value: any): void {
    if (value.type === 'baseline') {
      const b = value.value || {};
      this.controlCache.clear();
      for (const [sessionId, items] of Object.entries(b.queues || {})) {
        this.emitMux('session/queue', sessionId, { type: 'session/queue', sessionId, items });
        this.cacheControl(sessionId, (c) => (c.queue = items));
      }
      for (const [sessionId, jobs] of Object.entries(b.jobs || {})) {
        if ((jobs as unknown[]).length > 0) {
          this.emitMux('session/jobs', sessionId, { type: 'session/jobs', sessionId, jobs });
          this.cacheControl(sessionId, (c) => (c.jobs = jobs));
        }
      }
      for (const [sessionId, block] of Object.entries(b.projections || {})) {
        const values = (block as any)?.values || {};
        const asOfSeq = (block as any)?.asOfSeq || 0;
        for (const [key, val] of Object.entries(values)) {
          this.emitMux('session/projection', sessionId, { type: 'session/projection', sessionId, key, value: val, seq: asOfSeq });
          this.cacheControl(sessionId, (c) => (c.projections!.set(key, { value: val, seq: asOfSeq })));
        }
      }
      return;
    }
    if (value.type === 'queue' && value.sessionId) {
      this.emitMux('session/queue', value.sessionId, { type: 'session/queue', sessionId: value.sessionId, items: value.items });
      this.cacheControl(value.sessionId, (c) => (c.queue = value.items));
      return;
    }
    if (value.type === 'jobs' && value.sessionId) {
      this.emitMux('session/jobs', value.sessionId, { type: 'session/jobs', sessionId: value.sessionId, jobs: value.jobs });
      this.cacheControl(value.sessionId, (c) => (c.jobs = value.jobs));
      return;
    }
    if (value.type === 'projection' && value.sessionId) {
      this.emitMux('session/projection', value.sessionId, { type: 'session/projection', sessionId: value.sessionId, key: value.key, value: value.value, seq: value.seq });
      this.cacheControl(value.sessionId, (c) => (c.projections!.set(value.key, { value: value.value, seq: value.seq })));
    }
  }

  private emitMux(method: string, rpcId: string, frame: Record<string, unknown> & { type: string }): void {
    this.muxHandler?.({ rpcId, method, frame });
  }

  private emitHost(method: string, frame: Record<string, unknown> & { type: string }): void {
    this.hostHandler?.({ rpcId: '', method, frame });
  }

  private onEventItem(value: any): void {
    if (value.type === 'ready') {
      this.eventClientId = value.clientId || '';
      return;
    }
    if (value.type === 'emit') {
      const name = value.event as string;
      const arg0 = Array.isArray(value.args) ? value.args[0] : value.args;
      switch (name) {
        case 'api-session/added':
          this.emitHost('host/session-added', { type: 'host/session-added', ...(arg0 && typeof arg0 === 'object' ? arg0 : { sessionId: arg0 }) });
          if (arg0?.sessionId) this.followSession(arg0.sessionId);
          break;
        case 'api-session/removed':
          this.emitHost('host/session-removed', { type: 'host/session-removed', sessionId: arg0?.sessionId ?? arg0 });
          break;
        case 'api-session/status':
          this.emitHost('host/session-status', { type: 'host/session-status', sessionId: arg0?.sessionId, running: !!arg0?.running });
          break;
        case 'api-session/error':
          this.emitHost('host/agent-error', { type: 'host/agent-error', sessionId: arg0?.sessionId, message: arg0?.message || String(arg0) });
          break;
        default:
          this.emitHost('host/remote-event', { type: 'host/remote-event', event: name, args: value.args });
          break;
      }
      return;
    }
    if (value.type === 'waterfall') {
      const name = value.event as string;
      const eventId = value.eventId as string;
      const request = (value.request ?? {}) as any;
      if (name === 'approval/asked') {
        this.pendingAsks.set(eventId, { clientId: this.eventClientId, eventId });
        this.muxHandler?.({
          rpcId: eventId,
          method: 'approval/requested',
          frame: {
            type: 'approval/requested',
            sessionId: request.sessionId ?? request.session ?? '',
            approvalId: request.approvalId ?? request.id ?? eventId,
            toolName: request.toolName ?? '',
            callId: request.callId,
            reason: request.reason,
          },
        });
        return;
      }
      if (name === 'user-questions/request') {
        this.pendingAsks.set(eventId, { clientId: this.eventClientId, eventId });
        this.muxHandler?.({
          rpcId: eventId,
          method: 'question/requested',
          frame: {
            type: 'question/requested',
            sessionId: request.sessionId ?? request.session ?? '',
            questions: request.questions ?? [],
          },
        });
        return;
      }
      // unknown ask: acknowledge with next so the host is never blocked
      void this.respondUnknown(eventId);
    }
  }

  private async respondUnknown(eventId: string): Promise<void> {
    const clientId = this.eventClientId;
    await ensureAuthCookie();
    try {
      await fetch(`${dshBaseUrl}/api/$events/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader() },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: mintRpcId(),
          method: '$events/result',
          payload: { args: { clientId, eventId, outcome: { kind: 'next' } } },
        }),
      });
    } catch {
      /* ignore */
    }
  }
}

export const dsh = new DshClient();
