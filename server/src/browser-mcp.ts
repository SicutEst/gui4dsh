// standalone MCP stdio server exposing browser automation over CDP.
// spawned by dsh through cordis.yml (mcp-client, serverName: browser);
// talks newline-delimited JSON-RPC 2.0 on stdio and drives a headless
// Edge/Chrome through the DevTools protocol. No SDK dependency.

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import WebSocket from 'ws';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// ---------- CDP browser ----------

let browserProc: ChildProcess | null = null;
let ws: WebSocket | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let loadFired: (() => void) | null = null;

function cdpPort(): number {
  return Number(process.env.GUI4DSH_CDP_PORT || 9333);
}

async function ensureBrowser(): Promise<string> {
  if (ws && ws.readyState === WebSocket.OPEN) return 'ok';
  const port = cdpPort();
  // already-running debugger? probe it first so multiple MCP calls reuse one browser
  try {
    const v = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl?: string };
    if (v?.webSocketDebuggerUrl) return await attach(port);
  } catch { /* not running — spawn */ }
  const exe =
    process.env.GUI4DSH_BROWSER_EXE ||
    [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ].find((p) => fs.existsSync(p));
  if (!exe) throw new Error('no Chromium browser found (set GUI4DSH_BROWSER_EXE)');
  const profile = path.join(HOME, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  browserProc = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  // wait for the debug endpoint
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const v = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl?: string };
      if (v?.webSocketDebuggerUrl) return await attach(port);
    } catch { /* retry */ }
  }
  throw new Error('browser debug endpoint did not come up');
}

async function attach(port: number): Promise<string> {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  return await new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'cdp error'));
        else p.resolve(m.result);
      } else if (m.method === 'Page.loadEventFired') {
        loadFired?.();
        loadFired = null;
      }
    });
    ws.on('open', () => void send('Page.enable').then(() => send('Runtime.enable')).then(() => resolve('ok')).catch(reject));
    ws.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    ws.on('close', () => { ws = null; });
  });
}

function send(method: string, params: any = {}): Promise<any> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser not attached'));
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }
    }, 30_000);
  });
}

async function evalJs(expression: string): Promise<any> {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error'));
  return r.result?.value;
}

async function navigate(url: string): Promise<string> {
  const loadP = new Promise<void>((r) => { loadFired = r; setTimeout(r, 20_000); });
  await send('Page.navigate', { url });
  await loadP;
  const info = await evalJs('({url: location.href, title: document.title})');
  return `${info.title || '(untitled)'} — ${info.url}`;
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'navigate',
    description: 'Open a URL in the controlled browser and wait for it to load. Returns the page title and final URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'absolute http(s) URL' } }, required: ['url'] },
    run: async (a: any) => await navigate(String(a.url)),
  },
  {
    name: 'snapshot',
    description: 'Read the current page: title, URL, and the visible text (truncated). Use this to understand the page before interacting.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const t = await evalJs('document.body ? document.body.innerText : "(empty)"');
      return String(t).slice(0, 8000);
    },
  },
  {
    name: 'click',
    description: 'Click an element by CSS selector.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    run: async (a: any) => {
      const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error('selector matched nothing');
      return 'clicked';
    },
  },
  {
    name: 'type',
    description: 'Type text into an input matched by CSS selector. Optionally press Enter afterwards (useful for search boxes).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
      required: ['selector', 'text'],
    },
    run: async (a: any) => {
      await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(String(a.selector))}); if (!el) throw new Error('selector matched nothing'); el.focus(); el.value = ${JSON.stringify(String(a.text))}; el.dispatchEvent(new Event('input', {bubbles:true})); ${a.pressEnter ? 'el.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", code:"Enter", keyCode:13, bubbles:true})); if (el.form) el.form.submit();' : ''} })()`);
      await new Promise((r) => setTimeout(r, 800));
      return 'typed';
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page vertically by dy pixels (negative scrolls up).',
    inputSchema: { type: 'object', properties: { dy: { type: 'number' } } },
    run: async (a: any) => { await evalJs(`window.scrollBy(0, ${Number(a.dy) || 500})`); return 'scrolled'; },
  },
  {
    name: 'screenshot',
    description: 'Capture the current viewport as a PNG image.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_a: any, replyImage: (b64: string) => void) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      replyImage(String(r.data));
      return 'screenshot attached';
    },
  },
  {
    name: 'eval',
    description: 'Evaluate JavaScript in the page and return the JSON-encoded result. For extraction and interaction beyond the dedicated tools.',
    inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] },
    run: async (a: any) => JSON.stringify(await evalJs(String(a.js))).slice(0, 8000),
  },
];

// ---------- stdio JSON-RPC ----------

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    out({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'gui4dsh-browser', version: '0.1.0' },
      },
    });
  } else if (msg.method === 'notifications/initialized') {
    /* nothing */
  } else if (msg.method === 'ping') {
    out({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    out({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
    });
  } else if (msg.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) {
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `unknown tool: ${msg.params?.name}` }], isError: true } });
      return;
    }
    (async () => {
      try {
        await ensureBrowser();
        let imageB64: string | null = null;
        const text = await tool.run(msg.params?.arguments || {}, (b64) => (imageB64 = b64));
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: String(text) }];
        if (imageB64) content.push({ type: 'image', data: imageB64, mimeType: 'image/png' });
        out({ jsonrpc: '2.0', id: msg.id, result: { content } });
      } catch (e) {
        out({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true },
        });
      }
    })();
  }
});

rl.on('close', () => {
  try { ws?.close(); } catch { /* ignore */ }
  try { browserProc?.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
});
