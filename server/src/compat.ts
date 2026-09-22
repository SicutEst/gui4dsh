// post-update compatibility probe: after the updater installs a new dsh, this
// checks that the endpoints our Typert adapter depends on still respond with
// the expected shapes. Any failure triggers an automatic rollback to the
// previous working version, so a breaking dsh release never strands the user.

import * as manager from './dsh/manager.js';
import { dsh } from './dsh/client.js';

interface Probe {
  method: string;
  payload: unknown;
  check: (v: any) => boolean;
  label: string;
}

const PROBES: Probe[] = [
  { method: 'session.list', payload: {}, check: (v) => Array.isArray(v?.items), label: 'session.list → items[]' },
  { method: 'workspace.list', payload: {}, check: (v) => Array.isArray(v?.items), label: 'workspace.list → items[]' },
  { method: 'agentPreset.list', payload: {}, check: (v) => Array.isArray(v?.presets), label: 'agentPreset.list → presets[]' },
  { method: 'session.models', payload: {}, check: (v) => !!v?.current?.provider, label: 'session.models → current.provider' },
];

export interface CompatResult {
  ok: boolean;
  passed: number;
  failed: string[];
}

/** Wait for dsh to come up and probe critical endpoints. */
export async function probeCompat(maxWaitMs = 30_000): Promise<CompatResult> {
  const deadline = Date.now() + maxWaitMs;
  // wait for dsh to answer at all
  while (Date.now() < deadline) {
    const r = await dsh.call('session.list', {});
    if (r.ok) break;
    await new Promise((r2) => setTimeout(r2, 2000));
  }

  const failed: string[] = [];
  let passed = 0;
  for (const p of PROBES) {
    try {
      const r = await dsh.call(p.method, p.payload);
      if (r.ok && p.check(r.value)) {
        passed++;
      } else {
        failed.push(`${p.label}: ${r.ok ? 'shape mismatch' : r.error?.message || 'failed'}`);
      }
    } catch (e) {
      failed.push(`${p.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: failed.length === 0, passed, failed };
}
