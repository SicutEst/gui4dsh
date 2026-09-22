// browser automation: registers the bundled CDP-driven MCP server into dsh's
// cordis.yml (mcp-client stdio entry) so the model gets mcp__browser__* tools

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from './config.js';
import { killDshNow } from './dsh/manager.js';

const ENTRY_ID = 'mcp-gui4dsh-browser';

function cordisPath(): string {
  return path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
}

function mcpScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'browser-mcp.js');
}

function entryBlock(): string {
  const script = mcpScriptPath().replace(/\\/g, '/');
  return [
    `# [gui4dsh] browser automation MCP server (dsh model tools)`,
    `- insert:`,
    `  - id: ${ENTRY_ID}`,
    `    name: '@deepseek-ai/dsh-mcp-client'`,
    `    config:`,
    `      serverName: browser`,
    `      transport: stdio`,
    `      command: node`,
    `      args:`,
    `        - "${script}"`,
  ].join('\n');
}

/** cordis.yml is a top-level list; keep foreign entries intact, toggle ours. */
function currentText(): string {
  try {
    return fs.readFileSync(cordisPath(), 'utf8');
  } catch {
    return '';
  }
}

export function browserEnabled(): boolean {
  return currentText().includes(`id: ${ENTRY_ID}`);
}

export function setBrowserEnabled(enabled: boolean): { ok: boolean; error?: string; restarted?: boolean } {
  if (enabled && !fs.existsSync(mcpScriptPath())) {
    return { ok: false, error: 'browser-mcp.js not built' };
  }
  let text = currentText();
  // remove our block: from the marker comment (or our `- insert:` holding ENTRY_ID)
  // through to the next top-level element or EOF
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isMarker = line.includes('[gui4dsh] browser automation');
    const isOurInsert = /^- insert:/.test(line) && lines.slice(i + 1, i + 4).some((l) => l.includes(`id: ${ENTRY_ID}`));
    const isOldBare = line.trim() === `- id: ${ENTRY_ID}`;
    if (isMarker || isOurInsert || isOldBare) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // our block's continuation lines are indented or blank
      if (line.trim() === '' || /^[ \t]+/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (enabled) text = (text ? text + '\n' : '') + entryBlock() + '\n';
  try {
    fs.mkdirSync(path.dirname(cordisPath()), { recursive: true });
    fs.writeFileSync(cordisPath(), text, 'utf8');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // the patch layer loads at dsh boot — recycle the managed dsh to apply
  killDshNow();
  return { ok: true, restarted: true };
}

export function browserStatus(): { enabled: boolean; script: string } {
  return { enabled: browserEnabled(), script: mcpScriptPath() };
}
