// idle-time task queue: deferrable prompts the gateway dispatches once no
// session has been running for a sustained idle window (ZCode OffPeak-style)

import { store } from './store.js';
import { dsh } from './dsh/client.js';

export interface IdleTask {
  id: string;
  prompt: string;
  cwd?: string;
  createdAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  sessionId?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface IdleState {
  enabled: boolean;
  idleMinutes: number;
  tasks: IdleTask[];
}

function st(): IdleState {
  const s = store.data as unknown as { idle?: IdleState };
  if (!s.idle) s.idle = { enabled: false, idleMinutes: 10, tasks: [] };
  return s.idle;
}

let timer: NodeJS.Timeout | null = null;
let lastBusyAt = Date.now();
let checking = false;

async function anySessionRunning(): Promise<boolean> {
  const r = await dsh.call<{ items: Array<{ sessionId: string; running?: boolean }> }>('session.list', {});
  if (!r.ok) return true; // can't tell — treat as busy, never fire blindly
  return (r.value.items || []).some((x) => !!x.running);
}

async function tick(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const s = st();
    if (!s.enabled) return;
    // completion check for the running task — but never before the turn has
    // had a fair chance to start (a tick inside the accept→turn-start window
    // would otherwise see running:false and mark it done prematurely)
    const running = s.tasks.find((t) => t.status === 'running');
    if (running) {
      if (running.sessionId && running.startedAt && Date.now() - running.startedAt > 90_000) {
        const r = await dsh.call<{ items: Array<{ sessionId: string; running?: boolean }> }>('session.list', {});
        const item = r.ok ? (r.value.items || []).find((x) => x.sessionId === running.sessionId) : undefined;
        if (item && !item.running) {
          running.status = 'done';
          running.finishedAt = Date.now();
          store.save();
        }
      }
      return; // one idle task at a time
    }
    if (await anySessionRunning()) {
      lastBusyAt = Date.now();
      return;
    }
    if (Date.now() - lastBusyAt < s.idleMinutes * 60_000) return;
    const next = s.tasks.find((t) => t.status === 'pending');
    if (!next) return;
    // dispatch: create a session in the task's cwd and send the prompt
    const create = await dsh.call<{ sessionId: string }>('session.create', { ...(next.cwd ? { cwd: next.cwd } : {}) });
    if (!create.ok) {
      next.status = 'failed';
      next.error = create.error?.message || 'create failed';
      next.finishedAt = Date.now();
      store.save();
      return;
    }
    const prompt = await dsh.call('session.prompt', {
      sessionId: create.value.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: next.prompt }],
    });
    next.status = prompt.ok ? 'running' : 'failed';
    next.sessionId = create.value.sessionId;
    next.startedAt = Date.now();
    next.error = prompt.ok ? undefined : prompt.error?.message || 'prompt failed';
    if (!prompt.ok) next.finishedAt = Date.now();
    store.save();
  } finally {
    checking = false;
  }
}

export function initIdleQueue(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), 60_000);
  void tick();
}

export function idleState(): IdleState {
  return st();
}

export function setIdleConfig(enabled: boolean, idleMinutes?: number): void {
  const s = st();
  s.enabled = enabled;
  const m = Number(idleMinutes);
  if (Number.isSafeInteger(m) && m >= 1 && m <= 240) s.idleMinutes = m;
  if (enabled) lastBusyAt = Date.now();
  store.save();
}

export function addIdleTask(prompt: string, cwd?: string): IdleTask {
  const t: IdleTask = {
    id: `idle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    prompt: prompt.trim(),
    ...(cwd && cwd.trim() ? { cwd: cwd.trim() } : {}),
    createdAt: Date.now(),
    status: 'pending',
  };
  st().tasks.push(t);
  store.save();
  return t;
}

export function removeIdleTask(id: string): void {
  const s = st();
  const t = s.tasks.find((x) => x.id === id);
  if (t && t.status === 'running') return; // cannot remove a dispatched task
  s.tasks = s.tasks.filter((x) => x.id !== id);
  store.save();
}
