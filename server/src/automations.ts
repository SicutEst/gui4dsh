import { Cron } from 'croner';
import { store } from './store.js';
import { bus } from './bus.js';
import { runHeadless, newId } from './dsh/manager.js';
import type { Automation, AutomationRun } from './types.js';

const jobs = new Map<string, Cron>();
const running = new Set<string>();

function validateCron(expr: string): string | null {
  try {
    const c = new Cron(expr);
    const next = c.nextRun();
    c.stop();
    return next ? null : 'schedule never fires';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function cronPreview(expr: string): { valid: boolean; error?: string } {
  const err = validateCron(expr);
  return err ? { valid: false, error: err } : { valid: true };
}

/** Rebuild all schedulers from persisted state. Call after any CRUD change. */
export function rebuild(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  for (const a of store.data.automations) {
    if (!a.enabled) {
      a.nextRunAt = null;
      continue;
    }
    try {
      const job = new Cron(a.cron, () => {
        void runAutomation(a.id, 'cron');
      });
      jobs.set(a.id, job);
      a.nextRunAt = job.nextRun()?.getTime() ?? null;
      a.lastError = null;
    } catch (err) {
      a.lastError = err instanceof Error ? err.message : String(err);
      a.nextRunAt = null;
    }
  }
  store.save();
}

export async function runAutomation(id: string, trigger: 'cron' | 'manual'): Promise<AutomationRun | null> {
  const a = store.data.automations.find((x) => x.id === id);
  if (!a) return null;
  if (running.has(id)) return null;
  running.add(id);

  const run: AutomationRun = {
    id: newId(),
    automationId: a.id,
    automationName: a.name,
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    ok: false,
    timedOut: false,
    output: '',
  };
  store.pushAutomationRun(run);
  a.lastRunAt = run.startedAt;
  a.runCount++;
  store.save();
  bus.emit({ type: 'automation:started', automation: { ...a }, runId: run.id });

  console.log(`[automation] "${a.name}" started (${trigger})`);
  const result = await runHeadless(a.prompt, a.timeoutMin || 30);
  run.finishedAt = Date.now();
  run.exitCode = result.code;
  run.timedOut = result.timedOut;
  run.ok = !result.timedOut && result.code === 0;
  run.output = (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '')).slice(0, 64 * 1024);
  store.save();
  running.delete(id);

  const auto2 = store.data.automations.find((x) => x.id === id);
  bus.emit({ type: 'automation:completed', automation: auto2 ? { ...auto2 } : null, run: { ...run } });
  console.log(`[automation] "${a.name}" finished ok=${run.ok} code=${result.code}`);
  return run;
}

export function createAutomation(input: Partial<Automation>): Automation | { error: string } {
  const cron = (input.cron || '').trim();
  const prompt = (input.prompt || '').trim();
  const name = (input.name || '').trim() || 'Automation';
  if (!cron) return { error: 'cron expression required' };
  if (!prompt) return { error: 'prompt required' };
  const check = cronPreview(cron);
  if (!check.valid) return { error: `invalid cron: ${check.error}` };

  const a: Automation = {
    id: newId(),
    name,
    cron,
    prompt,
    enabled: input.enabled ?? true,
    timeoutMin: input.timeoutMin && input.timeoutMin > 0 ? input.timeoutMin : 30,
    createdAt: Date.now(),
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    lastError: null,
  };
  store.data.automations.push(a);
  rebuild();
  return a;
}

export function updateAutomation(id: string, patch: Partial<Automation>): Automation | { error: string } {
  const a = store.data.automations.find((x) => x.id === id);
  if (!a) return { error: 'not found' };
  if (patch.cron !== undefined && patch.cron !== a.cron) {
    const check = cronPreview(patch.cron.trim());
    if (!check.valid) return { error: `invalid cron: ${check.error}` };
  }
  if (patch.name !== undefined) a.name = patch.name.trim() || a.name;
  if (patch.cron !== undefined) a.cron = patch.cron.trim();
  if (patch.prompt !== undefined) a.prompt = patch.prompt;
  if (patch.enabled !== undefined) a.enabled = patch.enabled;
  if (patch.timeoutMin !== undefined) a.timeoutMin = patch.timeoutMin > 0 ? patch.timeoutMin : 30;
  rebuild();
  return a;
}

export function deleteAutomation(id: string): boolean {
  const idx = store.data.automations.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  store.data.automations.splice(idx, 1);
  store.data.automationRuns = store.data.automationRuns.filter((r) => r.automationId !== id);
  rebuild();
  return true;
}
