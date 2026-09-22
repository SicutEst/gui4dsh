import { spawn } from 'node:child_process';
import { store } from './store.js';
import { bus } from './bus.js';
import { newId } from './dsh/manager.js';
import type { Hook, HookEventName, HookRun } from './types.js';
import type { GatewayEvent } from './bus.js';

const running = new Set<string>();

/** Map gateway bus events onto the user-facing hook event vocabulary. */
function extractHookEvents(ev: GatewayEvent): Array<{ name: HookEventName; sessionId?: string; detail?: unknown }> {
  const out: Array<{ name: HookEventName; sessionId?: string; detail?: unknown }> = [];
  if (ev.type === 'dsh:host') {
    const frame = ev.frame as Record<string, any>;
    if (frame?.type === 'host/session-added') out.push({ name: 'session.started', sessionId: frame.sessionId });
    if (frame?.type === 'host/session-status') {
      out.push({
        name: frame.running ? 'session.running' : 'session.idle',
        sessionId: frame.sessionId,
        detail: { running: frame.running },
      });
    }
    if (frame?.type === 'host/agent-error') {
      out.push({ name: 'agent.error', sessionId: frame.sessionId, detail: { message: frame.message } });
    }
  }
  if (ev.type === 'dsh:mux') {
    const frame = ev.frame as Record<string, any>;
    if (frame?.type === 'session/event') {
      const event = frame.event as { type: string; data?: any };
      if (event?.type === 'turn/end') {
        const kind = event.data?.reason?.kind;
        if (kind === 'completed') out.push({ name: 'turn.completed', sessionId: frame.sessionId, detail: event.data });
        else if (kind === 'error') out.push({ name: 'turn.error', sessionId: frame.sessionId, detail: event.data });
      }
    }
  }
  if (ev.type === 'automation:started') out.push({ name: 'automation.started', detail: { automation: ev.automation } });
  if (ev.type === 'automation:completed') out.push({ name: 'automation.completed', detail: { automation: ev.automation, run: ev.run } });
  return out;
}

function runHookAction(hook: Hook, event: HookEventName, sessionId: string | undefined, detail: unknown): void {
  const key = `${hook.id}:${event}:${sessionId ?? '-'}`;
  if (running.has(key)) return;
  running.add(key);

  const finish = (run: Partial<HookRun> & { ok: boolean }) => {
    const rec: HookRun = {
      id: newId(),
      hookId: hook.id,
      hookName: hook.name,
      event,
      at: Date.now(),
      ok: run.ok,
      exitCode: run.exitCode ?? null,
      output: (run.output || '').slice(0, 16 * 1024),
    };
    store.pushHookRun(rec);
    store.save();
    bus.emit({ type: 'hook:ran', run: rec });
    running.delete(key);
  };

  if (hook.actionType === 'notify') {
    bus.emit({
      type: 'gateway:notification',
      level: event.includes('error') ? 'error' : 'info',
      title: hook.name,
      body: `${event}${sessionId ? ` · ${sessionId.slice(0, 8)}` : ''}`,
    });
    finish({ ok: true, output: 'notified' });
    return;
  }

  const command = hook.command || '';
  if (!command.trim()) {
    finish({ ok: false, output: 'empty command' });
    return;
  }

  const detailStr = (() => {
    try {
      return JSON.stringify(detail ?? {}).slice(0, 8192);
    } catch {
      return '{}';
    }
  })();

  const env = {
    ...process.env,
    G4D_EVENT: event,
    G4D_SESSION_ID: sessionId || '',
    G4D_DETAIL: detailStr,
  };

  const proc =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, 120_000);

  proc.stdout?.on('data', (d) => (output += String(d)));
  proc.stderr?.on('data', (d) => (output += String(d)));
  proc.on('error', (err) => {
    clearTimeout(timer);
    finish({ ok: false, output: output + err.message });
  });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    finish({ ok: code === 0, exitCode: code, output });
  });
}

export function initHooks(): void {
  bus.on((ev) => {
    const matches = extractHookEvents(ev);
    if (matches.length === 0) return;
    for (const m of matches) {
      for (const hook of store.data.hooks) {
        if (!hook.enabled) continue;
        if (hook.event !== m.name) continue;
        if (hook.sessionId && m.sessionId && hook.sessionId !== m.sessionId) continue;
        runHookAction(hook, m.name, m.sessionId, m.detail);
      }
    }
  });
}

export function testHook(id: string): boolean {
  const hook = store.data.hooks.find((h) => h.id === id);
  if (!hook) return false;
  runHookAction(hook, hook.event, hook.sessionId || undefined, { test: true });
  return true;
}
