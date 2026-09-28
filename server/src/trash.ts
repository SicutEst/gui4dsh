// recycle-bin session deletion: dsh has no delete (append-only logs, a
// search index that hates inconsistency) — so deletion here moves the
// session's log directory into ~/.dsh/trash/ (reversible), records the id
// in the gateway store, restarts dsh, and the gateway filters the id out
// of session.list / search / workspace results so it never resurfaces.

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './config.js';
import { store } from './store.js';
import { killDshNow } from './dsh/manager.js';

export interface TrashEntry {
  id: string;
  title: string;
  deletedAt: number;
  /** absolute original log dirs (main + subagent children), restore target */
  orig: string[];
  /** file names inside trash/ matching orig by index */
  files: string[];
}

function trashDir(): string {
  return path.join(dshHome(), 'trash');
}

function entries(): TrashEntry[] {
  const d = store.data as unknown as { trash?: TrashEntry[] };
  if (!Array.isArray(d.trash)) d.trash = [];
  return d.trash;
}

export function trashList(): TrashEntry[] {
  return entries().slice().sort((a, b) => b.deletedAt - a.deletedAt);
}

export function isDeleted(id: string): boolean {
  return entries().some((e) => e.id === id);
}

/** Find the log dir holding one session: sessions/<ws>/<session-<uuid>|<uuid>. */
function findLogDir(id: string): string | null {
  const uuid = id.replace(/^session-/, '');
  const base = path.join(dshHome(), 'sessions');
  if (!fs.existsSync(base)) return null;
  for (const ws of fs.readdirSync(base)) {
    for (const cand of [path.join(base, ws, `session-${uuid}`), path.join(base, ws, uuid)]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    }
  }
  return null;
}

function childSessionIds(id: string, all: Array<{ sessionId: string; parentSessionId?: string }>): string[] {
  return all.filter((s) => s.parentSessionId === id).map((s) => s.sessionId);
}

function uniqueTrashName(base: string): string {
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(trashDir(), name))) name = `${base}-${i++}`;
  return name;
}

/** Delete one session (plus its subagent children) into the recycle bin. */
export function deleteSession(id: string, title: string, all: Array<{ sessionId: string; parentSessionId?: string }>): { ok: boolean; error?: string } {
  if (isDeleted(id)) return { ok: false, error: 'already deleted' };
  const targets = [id, ...childSessionIds(id, all)];
  const orig: string[] = [];
  const files: string[] = [];
  fs.mkdirSync(trashDir(), { recursive: true });
  for (const target of targets) {
    const dir = findLogDir(target);
    if (!dir) continue; // log already gone — still register the id so filters hold
    const name = uniqueTrashName(path.basename(dir));
    fs.renameSync(dir, path.join(trashDir(), name));
    orig.push(dir);
    files.push(name);
  }
  if (orig.length === 0) {
    return { ok: false, error: 'session log not found on disk' };
  }
  entries().push({ id, title, deletedAt: Date.now(), orig, files });
  store.save();
  // dsh caches the session table in memory — recycle it so the deletion applies
  killDshNow();
  return { ok: true };
}

/** Restore one deleted session: put logs back where they came from. */
export function restoreSession(id: string): { ok: boolean; error?: string } {
  const list = entries();
  const entry = list.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'not in trash' };
  entry.orig.forEach((orig, i) => {
    const src = path.join(trashDir(), entry.files[i]);
    if (!fs.existsSync(src) || fs.existsSync(orig)) return;
    fs.mkdirSync(path.dirname(orig), { recursive: true });
    fs.renameSync(src, orig);
  });
  (store.data as unknown as { trash?: TrashEntry[] }).trash = list.filter((e) => e.id !== id);
  store.save();
  killDshNow();
  return { ok: true };
}

/** Purge one trash entry permanently (logs are gone for good). */
export function purgeSession(id: string): { ok: boolean; error?: string } {
  const list = entries();
  const entry = list.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'not in trash' };
  for (const f of entry.files) {
    try {
      fs.rmSync(path.join(trashDir(), f), { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  (store.data as unknown as { trash?: TrashEntry[] }).trash = list.filter((e) => e.id !== id);
  store.save();
  return { ok: true };
}
