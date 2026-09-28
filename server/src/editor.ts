// in-place message editing: dsh's log is append-only and dsh has no edit —
// but the log format is transparent (zstd frames of JSON lines, seq-ordered,
// no checksums), so the gateway can perform a ZCode-style edit at the storage
// layer: truncate the log just before a past user message, then the gui
// re-sends the corrected text as a fresh turn. Safety: the original log is
// copied into trash before rewriting, and restored automatically if the
// edited log fails verification after the dsh restart.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dshHome } from './config.js';
import { killDshNow } from './dsh/manager.js';

const MAGIC = 0xfd2fb528;

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

function pickLogFile(dir: string): string | null {
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function decodeLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let start = 0;
  const chunks: Buffer[] = [];
  for (let i = 4; i <= buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === MAGIC) {
      chunks.push(buf.subarray(start, i));
      start = i;
      i += 3;
    }
  }
  chunks.push(buf.subarray(start));
  for (const c of chunks) {
    const out = zlib.zstdDecompressSync(c);
    for (const l of out.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
  }
  return lines;
}

function encodeLines(lines: string[]): Buffer {
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

function backupCopy(file: string, id: string): string {
  const dir = path.join(dshHome(), 'trash');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `edit-backup-${Date.now().toString(36)}-${id}.zstd`);
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Truncate the session log just before the user message with `atSeq`, so the
 * gui can re-send a corrected version as a fresh turn. The original log is
 * backed up; call restoreBackup() if verification after the dsh restart fails.
 */
export function truncateAtUserMessage(id: string, atSeq: number): { ok: boolean; error?: string; backup?: string } {
  const dir = findLogDir(id);
  if (!dir) return { ok: false, error: 'session log not found on disk' };
  const file = pickLogFile(dir);
  if (!file) return { ok: false, error: 'log file not found' };
  const backup = backupCopy(file, id);
  let lines: string[];
  try {
    lines = decodeLines(fs.readFileSync(file));
  } catch (e) {
    return { ok: false, error: `decode failed: ${e instanceof Error ? e.message : String(e)}`, backup };
  }
  const idx = lines.findIndex((l) => {
    try {
      const j = JSON.parse(l);
      return j.type === 'user/message' && j.seq === atSeq;
    } catch {
      return false;
    }
  });
  if (idx < 0) return { ok: false, error: `user message seq ${atSeq} not found in log`, backup };
  // walk back to the turn/start owning this message — truncating mid-turn
  // leaves a dangling turn state that dsh's loader rejects
  let cut = idx;
  while (cut > 1) {
    try {
      if (JSON.parse(lines[cut]).type === 'turn/start') break;
    } catch { /* not json — keep walking */ }
    cut--;
  }
  const kept = lines.slice(0, cut);
  if (kept.length < 1) return { ok: false, error: 'nothing to keep (header missing)', backup };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, encodeLines(kept));
  fs.renameSync(tmp, file);
  killDshNow();
  return { ok: true, backup };
}

/** Restore the backup over the (possibly broken) edited log and recycle dsh. */
export function restoreBackup(id: string, backup: string): { ok: boolean } {
  const dir = findLogDir(id);
  if (!dir) return { ok: false };
  const file = pickLogFile(dir);
  if (!file) return { ok: false };
  fs.copyFileSync(backup, file);
  killDshNow();
  return { ok: true };
}
