// cloudflared (Cloudflare Tunnel) supervisor: download the exe, capture the
// login URL so the wizard can surface it in the user's browser session, run
// quick tunnels and scrape their trycloudflare URL, and manage named tunnels.
// All child state lives under <dataDir>/cfd so the SYSTEM service context and
// manual runs never fight over profile paths.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './config.js';
import { store } from './store.js';

const execFileP = promisify(execFile);

const cfdHome = path.join(dataDir, 'cfd');
const exe = path.join(cfdHome, 'cloudflared.exe');
const loginUrlLog = path.join(cfdHome, 'login-url.txt');
const quickUrlLog = path.join(cfdHome, 'quick-url.txt');

let quickChild: ChildProcess | null = null;
let namedChild: ChildProcess | null = null;
let loginChild: ChildProcess | null = null;
let loginUrlCaptured = '';

function env(): NodeJS.ProcessEnv {
  // cloudflared resolves its config dir from USERPROFILE on Windows
  return { ...process.env, USERPROFILE: cfdHome, TUNNEL_ORIGIN_CERT: path.join(cfdHome, '.cloudflared', 'cert.pem') };
}

function log(line: string): void {
  const p = path.join(cfdHome, 'cfd.log');
  try {
    fs.mkdirSync(cfdHome, { recursive: true });
    fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
  } catch { /* ignore */ }
}

export function installed(): boolean {
  return fs.existsSync(exe);
}

export function loggedIn(): boolean {
  return fs.existsSync(path.join(cfdHome, '.cloudflared', 'cert.pem'));
}

export function quickUrl(): string {
  try {
    return fs.readFileSync(quickUrlLog, 'utf8').trim();
  } catch {
    return '';
  }
}

export function status(): {
  installed: boolean;
  loggedIn: boolean;
  quickRunning: boolean;
  quickUrl: string;
  namedRunning: boolean;
  loginUrl: string;
} {
  return {
    installed: installed(),
    loggedIn: loggedIn(),
    quickRunning: quickChild !== null && quickChild.exitCode === null,
    quickUrl: quickUrl(),
    namedRunning: namedChild !== null && namedChild.exitCode === null,
    loginUrl: loginUrlCaptured,
  };
}

/** Download the official exe into our managed dir (no winget needed). */
export async function install(): Promise<{ ok: boolean; error?: string }> {
  if (installed()) return { ok: true };
  try {
    fs.mkdirSync(cfdHome, { recursive: true });
    const res = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', {
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(exe + '.part', buf);
    fs.renameSync(exe + '.part', exe);
    log(`installed cloudflared (${(buf.length / 1048576).toFixed(1)} MB)`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Start `tunnel login`; the child prints an authorization URL we capture for
 * the wizard (the browser must open in the USER session — the wizard shows
 * the link). Resolves once the URL has been captured; completion is detected
 * later via loggedIn().
 */
export function login(): { ok: boolean; error?: string } {
  if (!installed()) return { ok: false, error: '请先安装 cloudflared' };
  if (loginChild) return { ok: true };
  loginUrlCaptured = '';
  try {
    loginChild = spawn(exe, ['tunnel', 'login'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    loginChild = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const grab = (d: unknown) => {
    const text = String(d);
    const m = text.match(/https:\/\/dash\.cloudflare\.com\/argotunnel[^\s"']*/);
    if (m) {
      loginUrlCaptured = m[0];
      try {
        fs.writeFileSync(loginUrlLog, loginUrlCaptured);
      } catch { /* ignore */ }
    }
    log('[login] ' + text.trim().slice(0, 200));
  };
  loginChild.stdout?.on('data', grab);
  loginChild.stderr?.on('data', grab);
  loginChild.on('exit', (code) => {
    loginChild = null;
    log(`[login] exited (${code})`);
  });
  return { ok: true };
}

/** Run an ephemeral quick tunnel; the trycloudflare URL is scraped to disk. */
export function quickStart(): { ok: boolean; error?: string; url?: string } {
  if (!installed()) return { ok: false, error: '请先安装 cloudflared' };
  if (quickChild && quickChild.exitCode === null) return { ok: true, url: quickUrl() };
  try { fs.rmSync(quickUrlLog); } catch { /* stale url from a previous run must not leak */ }
  try {
    fs.mkdirSync(cfdHome, { recursive: true });
    quickChild = spawn(exe, ['tunnel', '--url', 'http://127.0.0.1:7420', '--no-autoupdate'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    quickChild = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  log('[quick] started');
  const grab = (d: unknown) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) {
      try {
        fs.writeFileSync(quickUrlLog, m[0]);
      } catch { /* ignore */ }
      log('[quick] url ' + m[0]);
    }
  };
  quickChild.stdout?.on('data', grab);
  quickChild.stderr?.on('data', grab);
  quickChild.on('exit', (code) => {
    quickChild = null;
    log(`[quick] exited (${code})`);
  });
  return { ok: true };
}

export function quickStop(): { ok: boolean } {
  try {
    quickChild?.kill();
  } catch { /* ignore */ }
  return { ok: true };
}

/** Create a named tunnel and bind the hostname (requires login first). */
export async function namedCreate(hostname: string): Promise<{ ok: boolean; error?: string }> {
  if (!installed()) return { ok: false, error: '请先安装 cloudflared' };
  if (!loggedIn()) return { ok: false, error: '请先完成登录授权' };
  if (!/^[a-z0-9.-]{4,200}$/i.test(hostname)) return { ok: false, error: '域名格式不对' };
  try {
    await execFileP(exe, ['tunnel', 'create', 'gui4dsh'], { env: env() });
  } catch (e) {
    // "already exists" is fine
    if (!/already exists|Resource already/i.test(String(e))) {
      return { ok: false, error: `创建通道失败: ${String(e).slice(0, 160)}` };
    }
  }
  try {
    await execFileP(exe, ['tunnel', 'route', 'dns', 'gui4dsh', hostname], { env: env() });
  } catch (e) {
    if (!/already exists|record already/i.test(String(e))) {
      return { ok: false, error: `绑定域名失败: ${String(e).slice(0, 160)}` };
    }
  }
  log(`[named] created & bound ${hostname}`);
  return { ok: true };
}

/** Run the named tunnel as a supervised child. */
export function namedRun(): { ok: boolean; error?: string } {
  if (!installed()) return { ok: false, error: '请先安装 cloudflared' };
  if (!loggedIn()) return { ok: false, error: '请先完成登录授权' };
  if (namedChild && namedChild.exitCode === null) return { ok: true };
  try {
    namedChild = spawn(exe, ['tunnel', 'run', '--url', 'http://127.0.0.1:7420', 'gui4dsh', '--no-autoupdate'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    namedChild = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const grab = (d: unknown) => log('[named] ' + String(d).trim().slice(0, 200));
  namedChild.stdout?.on('data', grab);
  namedChild.stderr?.on('data', grab);
  namedChild.on('exit', (code) => {
    namedChild = null;
    log(`[named] exited (${code})`);
  });
  log('[named] started');
  return { ok: true };
}

export function namedStop(): { ok: boolean } {
  try {
    namedChild?.kill();
  } catch { /* ignore */ }
  return { ok: true };
}

/** Boot hook: resume the named tunnel if the user enabled auto-start. */
export function init(): void {
  const s = store.data.settings as unknown as Record<string, unknown>;
  if (s.cfdAutoStart === true) namedRun();
}
