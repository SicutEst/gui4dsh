// built-in frpc tunnel management: generate a minimal config from settings,
// supervise the frpc process, and report status. The gateway port is always
// the local target — one tunnel, one exposed surface.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';
import { DEFAULT_GATEWAY_PORT, dataDir } from './config.js';

let child: ChildProcess | null = null;
let startedAt = 0;
const logLines: string[] = [];

function cfg(): { server: string; serverPort: string; token: string; remotePort: number; frpcPath: string; localPort: number } {
  const s = store.data.settings as unknown as Record<string, unknown>;
  return {
    server: (s.frpServer as string) || '',
    serverPort: (s.frpServerPort as string) || '7000',
    token: (s.frpToken as string) || '',
    remotePort: Number(s.frpRemotePort) || 0,
    frpcPath: (s.frpcPath as string) || 'frpc',
    localPort: Number(process.env.G4D_PORT) || DEFAULT_GATEWAY_PORT,
  };
}

function log(line: string): void {
  logLines.push(line);
  if (logLines.length > 60) logLines.splice(0, logLines.length - 60);
}

function configPath(): string {
  return path.join(dataDir, 'frpc-gui4dsh.toml');
}

function writeConfig(): void {
  const c = cfg();
  const toml = [
    `serverAddr = ${JSON.stringify(c.server)}`,
    `serverPort = ${Number(c.serverPort) || 7000}`,
    c.token ? `auth.token = ${JSON.stringify(c.token)}` : '',
    'transport.tls.enable = true',
    '',
    '[[proxies]]',
    'name = "gui4dsh"',
    'type = "tcp"',
    `localPort = ${c.localPort}`,
    `remotePort = ${c.remotePort}`,
    'transport.useEncryption = true',
    '',
  ].filter((x) => x !== '').join('\n');
  fs.writeFileSync(configPath(), toml);
}

export function frpRunning(): boolean {
  return child !== null && child.exitCode === null;
}

export function status(): { running: boolean; startedAt: number; config: ReturnType<typeof cfg> | null; log: string[] } {
  const c = cfg();
  const ready = c.server && c.remotePort;
  return { running: frpRunning(), startedAt, config: ready ? c : null, log: logLines.slice() };
}

export function start(): { ok: boolean; error?: string } {
  if (frpRunning()) return { ok: true };
  const c = cfg();
  if (!c.server || !c.remotePort) return { ok: false, error: '请先填写 frp 服务器地址和远程端口' };
  try {
    writeConfig();
  } catch (e) {
    return { ok: false, error: `配置写入失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    child = spawn(c.frpcPath, ['-c', configPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    child = null;
    return { ok: false, error: `frpc 启动失败（检查路径）: ${e instanceof Error ? e.message : String(e)}` };
  }
  startedAt = Date.now();
  log(`[frp] started frpc (pid ${child.pid}) → ${c.server}:${c.remotePort} → local ${c.localPort}`);
  child.stdout?.on('data', (d) => log(String(d).trim()));
  child.stderr?.on('data', (d) => log(String(d).trim()));
  child.on('exit', (code) => {
    log(`[frp] frpc exited (code ${code})`);
    child = null;
  });
  return { ok: true };
}

export function stop(): { ok: boolean } {
  if (!frpRunning()) return { ok: true };
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/** gateway boot hook: honor the enabled flag */
export function init(): void {
  const s = store.data.settings as unknown as Record<string, unknown>;
  if (s.frpEnabled === true) start();
}
