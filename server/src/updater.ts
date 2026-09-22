import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { monoRoot } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import * as manager from './dsh/manager.js';
import { probeCompat } from './compat.js';

const CHECK_INTERVAL_MS = 24 * 3600_000;

export function currentDshVersion(): string {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(monoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ).version;
  } catch {
    return 'unknown';
  }
}

async function latestDshVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

function npmInstall(version: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(
      cmd,
      ['install', `@deepseek-ai/dsh@${version}`, '--workspace', 'server', '--no-audit', '--no-fund'],
      { cwd: monoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let output = '';
    proc.stdout?.on('data', (d) => (output += String(d)));
    proc.stderr?.on('data', (d) => (output += String(d)));
    proc.on('error', (err) => resolve({ code: -1, output: output + err.message }));
    proc.on('exit', (code) => resolve({ code: code ?? -1, output }));
  });
}

let updating = false;

async function waitDshGone(maxMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && manager.isDshRunning()) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface UpdateOutcome {
  ok: boolean;
  from: string;
  to: string | null;
  detail: string;
}

/** Check npm for a newer dsh; if found, swap the bundled copy and restart dsh. */
export async function checkForUpdate(force = false): Promise<UpdateOutcome> {
  const from = currentDshVersion();
  if (updating) return { ok: false, from, to: null, detail: 'update already in progress' };
  const to = await latestDshVersion();
  if (!to) return { ok: false, from, to: null, detail: 'registry unreachable' };
  if (to === from) return { ok: true, from, to, detail: 'already latest' };
  if (!force && store.data.settings.autoUpdateDsh === false) {
    return { ok: false, from, to, detail: 'auto-update disabled in settings' };
  }

  console.log(`[updater] dsh ${from} -> ${to}`);
  updating = true;
  try {
    // pause auto-restart, stop the running dsh (its files are locked on Windows)
    manager.pauseRestarts();
    manager.killDshNow();
    await waitDshGone();
    const r = await npmInstall(to);
    if (r.code !== 0) {
      console.error(`[updater] npm install failed: ${r.output.slice(-400)}`);
      return { ok: false, from, to, detail: `npm install failed (${r.code})` };
    }
    const now = currentDshVersion();
    manager.resumeRestarts();
    manager.start();
    console.log(`[updater] dsh updated to ${now}, probing compatibility…`);

    // compat probe: if the new version broke our adapter, roll back
    const compat = await probeCompat(30_000);
    if (!compat.ok) {
      console.error(`[updater] compat probe FAILED (${compat.failed.join('; ')}), rolling back to ${from}`);
      manager.pauseRestarts();
      manager.killDshNow();
      await waitDshGone();
      const rb = await npmInstall(from);
      manager.resumeRestarts();
      manager.start();
      bus.emit({ type: 'dsh:updated', from, to: from, detail: 'rolled back' });
      if (rb.code !== 0) {
        return { ok: false, from, to: from, detail: `update broke compat AND rollback npm failed (${rb.code})` };
      }
      return { ok: false, from, to: from, detail: `updated to ${now} but broke compat, rolled back to ${from}: ${compat.failed.join('; ')}` };
    }

    console.log(`[updater] compat probe passed (${compat.passed}/${compat.passed + compat.failed.length} ok)`);
    bus.emit({ type: 'dsh:updated', from, to: now });
    return { ok: now === to, from, to: now, detail: now === to ? 'updated' : `installed ${now}` };
  } finally {
    updating = false;
    manager.resumeRestarts();
  }
}

export function startUpdater(): void {
  // first check 90s after boot (let everything settle), then daily
  setTimeout(() => void checkForUpdate().catch(() => {}), 90_000);
  setInterval(() => void checkForUpdate().catch(() => {}), CHECK_INTERVAL_MS);
}
