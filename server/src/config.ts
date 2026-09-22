import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** server package root (src/.. or dist/..) */
export const pkgRoot = path.resolve(here, '..');
/** monorepo root */
export const monoRoot = path.resolve(pkgRoot, '..');

export const dataDir = process.env.G4D_DATA_DIR || path.join(os.homedir(), '.gui4dsh');
export const storeFile = path.join(dataDir, 'store.json');

export const DEFAULT_GATEWAY_PORT = Number(process.env.G4D_PORT || 7420);
export const DSH_PORT = Number(process.env.DSH_PORT || 34180);
/** The user's own npx dsh instance (official UI). Preferred backend when running. */
export const DSH_USER_URL = process.env.DSH_USER_URL || 'http://127.0.0.1:3080';
/** Set DSH_URL to attach to an already-running `dsh web` instead of spawning one. */
export const DSH_URL = process.env.DSH_URL || `http://127.0.0.1:${DSH_PORT}`;
export const DSH_EXTERNAL = Boolean(process.env.DSH_URL);

export const webDist = path.join(monoRoot, 'web', 'dist');

export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

export function localDay(ts: number | string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
