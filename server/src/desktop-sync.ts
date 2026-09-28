// desktop sync guard: dsh Desktop (and any other dsh process) shares this
// ~/.dsh home, but each running dsh caches its session/workspace registry in
// memory and never sees another process's writes. The desktop updates
// storages/workspace.json on every create/fork/move — watching that file lets
// the gateway recycle its own dsh when the desktop changed something, so the
// gui always converges to the desktop's state. Never fires while a session is
// running (an active turn must not be interrupted).

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { killDshNow, isDshRunning } from './dsh/manager.js';
import { dsh } from './dsh/client.js';

const WORKSPACE_FILE = () => path.join(dshHome(), 'storages', 'workspace.json');
const POLL_MS = 10_000;
const SETTLE_MS = 4000;

let timer: NodeJS.Timeout | null = null;
let lastSeen = { mtime: 0, size: 0 };
let pendingRestart = false;
let checking = false;
let bootedAt = 0;

function enabled(): boolean {
  return store.data.settings.desktopSync !== false;
}

function currentStamp(): { mtime: number; size: number } {
  try {
    const st = fs.statSync(WORKSPACE_FILE());
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return { mtime: 0, size: 0 };
  }
}

async function anySessionRunning(): Promise<boolean> {
  const r = await dsh.call<{ items: Array<{ running?: boolean }> }>('session.list', {});
  return r.ok ? (r.value?.items || []).some((s) => s.running) : true; // can't tell → treat busy
}

async function check(): Promise<void> {
  if (checking || !enabled() || !isDshRunning()) return;
  checking = true;
  try {
    const stamp = currentStamp();
    const changed = stamp.mtime !== lastSeen.mtime || stamp.size !== lastSeen.size;
    if (!changed) {
      if (pendingRestart && !(await anySessionRunning())) {
        pendingRestart = false;
        console.log('[desktop-sync] applying pending workspace changes — recycling dsh');
        bus.emit({ type: 'desktop:synced' } as never);
        killDshNow();
      }
      return;
    }
    lastSeen = stamp;
    // ignore the very first observation after gateway boot
    if (Date.now() - bootedAt < 30_000) return;
    if (await anySessionRunning()) {
      pendingRestart = true;
      console.log('[desktop-sync] workspace.json changed but sessions are running — deferring');
      return;
    }
    console.log('[desktop-sync] workspace.json changed by another dsh process — recycling dsh');
    bus.emit({ type: 'desktop:synced' } as never);
    killDshNow();
  } finally {
    checking = false;
  }
}

export function initDesktopSync(): void {
  if (timer) return;
  bootedAt = Date.now();
  lastSeen = currentStamp();
  timer = setInterval(() => void check(), POLL_MS);
  timer.unref?.();
}
