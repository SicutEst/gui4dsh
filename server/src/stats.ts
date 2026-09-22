import fs from 'node:fs';
import path from 'node:path';
import { dshHome, localDay } from './config.js';
import { store } from './store.js';

interface TokenTotals {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ProjcacheSession {
  identity?: { createdAt?: number; cwd?: string };
  rows?: {
    sessionStats?: { val?: { turns?: number } };
    tokenUsage?: { val?: { totals?: TokenTotals } };
  };
}

/** Fold a live mux session/event frame into daily + per-model usage stats. */
export function trackSessionEvent(sessionId: string, event: { type: string; time: number; data?: any }): void {
  const day = store.day(localDay(event.time));
  if (!day.sessions.includes(sessionId)) day.sessions.push(sessionId);

  switch (event.type) {
    case 'user/message': {
      const src = event.data?.message?.source ?? event.data?.source;
      if (src?.kind === 'user') day.prompts++;
      break;
    }
    case 'assistant/message': {
      const usage = event.data?.usage;
      if (usage) {
        day.tokensIn += usage.inputTokens || 0;
        day.tokensOut += usage.outputTokens || 0;
        day.cacheRead += usage.cacheReadTokens || 0;
        day.cacheWrite += usage.cacheWriteTokens || 0;
      }
      const src = event.data?.message?.source ?? event.data?.source;
      if (src?.provider) {
        store.bumpModel(src.provider, src.model || '?', 0, usage?.inputTokens || 0, usage?.outputTokens || 0);
      }
      break;
    }
    case 'turn/end': {
      day.turns++;
      const src = event.data?.reason;
      void src;
      break;
    }
  }
  store.save();
}

/** One-time backfill from dsh's own projection cache so the heatmap has history. */
export function backfillFromProjcache(): void {
  if (store.data.statsBackfilled) return;
  const file = path.join(dshHome(), 'storages', 'session_projcache.json');
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions = raw?.tables?.sessions as Record<string, ProjcacheSession> | undefined;
    if (!sessions) return;
    let count = 0;
    for (const [sid, s] of Object.entries(sessions)) {
      if (!s?.identity?.createdAt) continue;
      const day = store.day(localDay(s.identity.createdAt));
      if (!day.sessions.includes(sid)) day.sessions.push(sid);
      day.turns += s.rows?.sessionStats?.val?.turns || 0;
      const totals = s.rows?.tokenUsage?.val?.totals || {};
      day.tokensIn += totals.uncachedInputTokens || 0;
      day.tokensOut += totals.outputTokens || 0;
      day.cacheRead += totals.cacheReadTokens || 0;
      day.cacheWrite += totals.cacheWriteTokens || 0;
      count++;
    }
    store.data.statsBackfilled = true;
    store.save();
    console.log(`[stats] backfilled ${count} sessions from dsh projcache`);
  } catch (err) {
    console.error('[stats] backfill failed:', err);
  }
}
