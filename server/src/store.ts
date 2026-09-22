import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeFile, ensureDataDir } from './config.js';
import type { StoreShape, DayUsage, AutomationRun, HookRun } from './types.js';

function defaultStore(): StoreShape {
  return {
    version: 1,
    token: crypto.randomBytes(24).toString('base64url'),
    settings: { locale: 'zh', theme: 'dark', externalBaseUrl: '', openBrowserOnStart: true, remoteEnabled: true, autoUpdateDsh: true },
    taskMeta: {},
    taskGroups: [],
    automations: [],
    automationRuns: [],
    hooks: [],
    hookRuns: [],
    usage: {},
    models: [],
    skillGroups: [],
    skillAssign: {},
    statsBackfilled: false,
  };
}

class Store {
  data: StoreShape = defaultStore();
  private saveTimer: NodeJS.Timeout | null = null;

  load(): void {
    ensureDataDir();
    try {
      if (fs.existsSync(storeFile)) {
        const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        this.data = { ...defaultStore(), ...raw };
        if (!this.data.token || typeof this.data.token !== 'string') {
          this.data.token = crypto.randomBytes(24).toString('base64url');
        }
        this.data.settings = { ...defaultStore().settings, ...(raw.settings || {}) };
      }
    } catch (err) {
      console.error('[store] failed to load, starting fresh:', err);
      this.data = defaultStore();
    }
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const tmp = storeFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, storeFile);
      } catch (err) {
        console.error('[store] save failed:', err);
      }
    }, 400);
  }

  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      if (fs.existsSync(path.dirname(storeFile))) {
        fs.writeFileSync(storeFile, JSON.stringify(this.data, null, 2));
      }
    } catch {
      /* best effort */
    }
  }

  rotateToken(): string {
    this.data.token = crypto.randomBytes(24).toString('base64url');
    this.save();
    return this.data.token;
  }

  day(day: string): DayUsage {
    let d = this.data.usage[day];
    if (!d) {
      d = { prompts: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, sessions: [] };
      this.data.usage[day] = d;
    }
    return d;
  }

  bumpModel(provider: string, model: string, turns: number, tokensIn: number, tokensOut: number): void {
    let m = this.data.models.find((x) => x.provider === provider && x.model === model);
    if (!m) {
      m = { provider, model, turns: 0, tokensIn: 0, tokensOut: 0 };
      this.data.models.push(m);
    }
    m.turns += turns;
    m.tokensIn += tokensIn;
    m.tokensOut += tokensOut;
  }

  pushAutomationRun(run: AutomationRun): void {
    this.data.automationRuns.unshift(run);
    if (this.data.automationRuns.length > 500) this.data.automationRuns.length = 500;
  }

  pushHookRun(run: HookRun): void {
    this.data.hookRuns.unshift(run);
    if (this.data.hookRuns.length > 300) this.data.hookRuns.length = 300;
  }
}

export const store = new Store();
