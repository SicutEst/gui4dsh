// cross-session persistent memory: markdown files under $DSH_HOME/memory,
// surfaced to dsh agents through a clearly-marked block in the user-global
// AGENTS.md instruction file ($DSH_HOME/AGENTS.md)

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './config.js';

const MARK_START = '<!-- gui4dsh:memory:start -->';
const MARK_END = '<!-- gui4dsh:memory:end -->';

function memoryDir(): string {
  return path.join(dshHome(), 'memory');
}

function agentsFile(): string {
  return path.join(dshHome(), 'AGENTS.md');
}

function safeName(name: string): string | null {
  const n = String(name || '').trim().replace(/\\/g, '/');
  if (!n || n.includes('/') || n.includes('..')) return null;
  if (!/^[a-zA-Z0-9._\- ]+$/.test(n)) return null;
  return n.endsWith('.md') ? n : `${n}.md`;
}

function instructionBlock(): string {
  const dir = memoryDir().replace(/\\/g, '/');
  return [
    MARK_START,
    '## Persistent memory',
    '',
    `You keep persistent memory across sessions. It lives in \`${dir}\`:`,
    '- `MEMORY.md` is the index — one bullet per memory: `- [title](file.md) — one-line hook`.',
    '- Each other `*.md` file holds exactly one durable fact, with `name`, `description` and `type: user | feedback | project | reference` frontmatter.',
    '',
    'Working rules:',
    '- At the start of a task, check the index for relevant memories and read those files before relying on them.',
    '- When the user states a durable preference, correction, or project constraint, save it: one file per fact, then update the index.',
    '- When a memory turns out wrong, update or delete it instead of following it.',
    '- Do not save what a single conversation already records or details that only matter right now.',
    MARK_END,
  ].join('\n');
}

export interface MemoryFile { name: string; content: string }

export function listMemory(): { files: MemoryFile[] } {
  const dir = memoryDir();
  if (!fs.existsSync(dir)) return { files: [] };
  const files: MemoryFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      files.push({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') });
    } catch { /* unreadable — skip */ }
  }
  files.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
  return { files };
}

export function writeMemoryFile(name: string, content: string): { ok: boolean; error?: string } {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'invalid file name' };
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.writeFileSync(path.join(memoryDir(), n), String(content ?? ''), 'utf8');
  return { ok: true };
}

export function deleteMemoryFile(name: string): { ok: boolean; error?: string } {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'invalid file name' };
  try {
    fs.unlinkSync(path.join(memoryDir(), n));
  } catch {
    /* already gone */
  }
  return { ok: true };
}

export function memoryEnabled(): boolean {
  try {
    return fs.readFileSync(agentsFile(), 'utf8').includes(MARK_START);
  } catch {
    return false;
  }
}

export function setMemoryEnabled(enabled: boolean): { ok: boolean; error?: string } {
  const file = agentsFile();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const s = text.indexOf(MARK_START);
  const e = text.indexOf(MARK_END);
  if (s >= 0 && e > s) text = (text.slice(0, s) + text.slice(e + MARK_END.length)).trim();
  if (enabled) {
    text = (text ? text.trimEnd() + '\n\n' : '') + instructionBlock() + '\n';
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    if (enabled) fs.mkdirSync(memoryDir(), { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function memoryDirPath(): string {
  return memoryDir();
}
