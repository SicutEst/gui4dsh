import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { monoRoot, dshHome, DSH_PORT } from '../config.js';
import { bus } from '../bus.js';

export type DshStatus = 'external' | 'starting' | 'up' | 'down';

export interface HeadlessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

let child: ChildProcess | null = null;
let status: DshStatus = 'down';
let shuttingDown = false;
let restartAttempts = 0;
const logLines: string[] = [];
let dshWebToken = '';

/** The per-boot access token the new dsh prints in its web URL (auth for API/WS). */
export function getDshWebToken(): string {
  return dshWebToken;
}

function log(line: string): void {
  const stamped = line.replace(/\r/g, '');
  for (const l of stamped.split('\n')) {
    if (!l.trim()) continue;
    logLines.push(l);
    if (logLines.length > 300) logLines.shift();
    console.error(`[dsh] ${l}`);
    const m = l.match(/[?&]token=([A-Za-z0-9_-]+)/);
    if (m && m[1] !== dshWebToken) {
      dshWebToken = m[1];
      bus.emit({ type: 'dsh:token', token: dshWebToken });
    }
  }
}

export function getStatus(): DshStatus {
  return status;
}

export function recentLogs(count = 60): string[] {
  return logLines.slice(-count);
}

/**
 * Locate the dsh launcher script so we can spawn it with an args array
 * (no shell quoting problems). Falls back to null => shell/npx mode.
 */
export function resolveDshScript(): string | null {
  const envBin = process.env.DSH_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  const candidates: string[] = [
    path.join(monoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];

  // npm global root
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch {
    /* npm not reachable */
  }

  // npx cache scan (Windows: %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\...)
  const cacheRoot =
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
      : path.join(process.env.HOME || '', '.npm', '_npx');
  try {
    if (fs.existsSync(cacheRoot)) {
      for (const entry of fs.readdirSync(cacheRoot)) {
        candidates.push(path.join(cacheRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      }
    }
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function spawnDsh(): void {
  const script = resolveDshScript();
  if (script) {
    log(`spawning: node "${script}" web --port ${DSH_PORT} --host 127.0.0.1`);
    child = spawn(process.execPath, [script, 'web', '--port', String(DSH_PORT), '--host', '127.0.0.1', '--no-open'], {
      cwd: dshHome(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    log('spawning via npx: @deepseek-ai/dsh web');
    child = spawn('npx', ['-y', '@deepseek-ai/dsh', 'web', '--port', String(DSH_PORT), '--host', '127.0.0.1', '--no-open'], {
      cwd: dshHome(),
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  child.stdout?.on('data', (d) => log(String(d)));
  child.stderr?.on('data', (d) => log(String(d)));
  child.on('error', (err) => log(`process error: ${err.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown || restartsPaused) return;
    log(`dsh exited (code=${code} signal=${signal})`);
    status = 'down';
    bus.emit({ type: 'dsh:status', status: 'down', detail: `exited code=${code}` });
    const delay = Math.min(60000, 5000 * Math.pow(2, Math.min(restartAttempts, 4)));
    restartAttempts++;
    log(`restarting dsh in ${delay / 1000}s (attempt ${restartAttempts})`);
    setTimeout(() => {
      if (!shuttingDown && !restartsPaused && !child) {
        status = 'starting';
        bus.emit({ type: 'dsh:status', status: 'starting' });
        spawnDsh();
      }
    }, delay);
  });
}

let restartsPaused = false;

/** updater: suppress crash-restart while swapping the dsh package on disk */
export function pauseRestarts(): void {
  restartsPaused = true;
}

export function resumeRestarts(): void {
  restartsPaused = false;
}

export function killDshNow(): void {
  if (child?.pid) killTree(child.pid);
}

export function isDshRunning(): boolean {
  return child !== null;
}

export function start(): void {
  if (status === 'external') return;
  shuttingDown = false;
  restartAttempts = 0;
  status = 'starting';
  bus.emit({ type: 'dsh:status', status: 'starting' });
  spawnDsh();
}

export function markExternal(): void {
  status = 'external';
}

export function markUp(): void {
  if (status === 'up') return;
  status = 'up';
  restartAttempts = 0;
  bus.emit({ type: 'dsh:status', status: 'up' });
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function shutdown(): void {
  shuttingDown = true;
  if (child?.pid) killTree(child.pid);
  child = null;
}

/** One-shot `dsh --profile headless "<prompt>"` execution for automations. */
export function runHeadless(prompt: string, timeoutMin: number): Promise<HeadlessResult> {
  return new Promise((resolve) => {
    const script = resolveDshScript();
    let proc: ChildProcess;
    if (script) {
      proc = spawn(process.execPath, [script, '--profile', 'headless', prompt], {
        cwd: dshHome(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Shell fallback: sanitize characters that break cmd quoting.
      const safe = prompt.replace(/["\r\n]/g, ' ').slice(0, 8000);
      proc = spawn('npx', ['-y', '@deepseek-ai/dsh', '--profile', 'headless', safe], {
        cwd: dshHome(),
        env: process.env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 128 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) killTree(proc.pid);
    }, Math.max(1, timeoutMin) * 60_000);

    proc.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += String(d);
    });
    proc.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += String(d);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + err.message, timedOut });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function newId(): string {
  return crypto.randomUUID();
}
