import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { WritableDraft } from 'immer';
import { dshCall, dshOk, fe, connectWs, type WsStatus } from './api';
import type {
  Automation,
  AutomationRun,
  ApprovalPending,
  ContentBlock,
  Hook,
  HookRun,
  QuestionPending,
  SessionModels,
  SessionSummary,
  SessionEvent,
  SkillEntry,
  TaskGroup,
  TaskMeta,
  Toast,
  WorkspaceView,
} from './types';

export type ViewName = 'chat' | 'search' | 'automations' | 'skills' | 'projects' | 'stats' | 'hooks' | 'settings';

export interface StreamPart {
  kind: 'text' | 'reasoning' | 'tool-call';
  text?: string;
  name?: string;
  args?: string;
}

export interface AttachmentDraft {
  name: string;
  size: number;
  kind: 'image' | 'file';
  mediaType?: string;
  dataBase64?: string;
  bytes?: ArrayBuffer;
}

export interface ChatItem {
  kind: 'user' | 'context' | 'assistant' | 'tool' | 'notice';
  seq: number;
  optimistic?: boolean;
  message?: { content?: ContentBlock[]; source?: any };
  turn?: number;
  step?: number;
  usage?: any;
  streaming?: boolean;
  parts?: StreamPart[];
  callId?: string;
  name?: string;
  arguments?: string;
  pending?: boolean;
  result?: { content?: ContentBlock[]; error?: { name: string; code: string }; meta?: any };
  level?: 'error' | 'warn' | 'info';
  text?: string;
}

/** Light event projection kept per chat for the trajectory view (times + previews). */
export interface TrajEv {
  seq: number;
  time: number;
  type: string;
  data?: any;
}

interface ChatState {
  items: ChatItem[];
  lastSeq: number;
  minSeq: number;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  streaming: boolean;
  todos: Array<{ content: string; status: string }>;
  queue: Array<{ id: string; placement: string; message: { content: ContentBlock[] } }>;
  projValues: Record<string, { value: any; seq: number }>;
  model?: { provider?: string; model?: string };
  streamIdx: Record<string, number>;
  traj: TrajEv[];
  feedback: Record<string, { rating: 'positive' | 'negative'; version: string }>;
}

function newChat(): ChatState {
  return {
    items: [],
    lastSeq: 0,
    minSeq: Number.MAX_SAFE_INTEGER,
    hasMore: false,
    loaded: false,
    loading: false,
    streaming: false,
    todos: [],
    queue: [],
    projValues: {},
    streamIdx: {},
    traj: [],
    feedback: {},
  };
}

function itemText(item: ChatItem): string {
  return (item.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
}

function ensureChat(s: WritableDraft<AppState>, sid: string): WritableDraft<ChatState> {
  if (!s.chats[sid]) s.chats[sid] = newChat();
  return s.chats[sid];
}

/** Event types the trajectory ledger shows as rows (others are skipped as noise). */
const TRAJ_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start',
  'user/message', 'assistant/message', 'system/message',
  'tool/call', 'tool/result',
  'permission/preset', 'sandbox/mode', 'approval/policy',
]);

function pushTraj(chat: WritableDraft<ChatState>, ev: SessionEvent): void {
  if (!TRAJ_TYPES.has(ev.type) && !ev.type.startsWith('compaction')) return;
  let data: any;
  switch (ev.type) {
    case 'user/message': {
      const m = ev.data;
      const blocks = m?.content || [];
      data = {
        user: m?.source?.kind === 'user',
        text: blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n').slice(0, 300),
        images: blocks.filter((b: any) => b.type === 'image').length,
        files: blocks.filter((b: any) => b.type === 'file' || b.type === 'file-reference').length,
      };
      break;
    }
    case 'assistant/message': {
      const { message, usage } = ev.data || {};
      const blocks = message?.content || [];
      data = {
        provider: message?.source?.provider, model: message?.source?.model,
        text: blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n').slice(0, 300),
        reasoning: blocks.some((b: any) => b.type === 'reasoning'),
        toolCalls: blocks.filter((b: any) => b.type === 'tool-call').length,
        usage: usage || null,
      };
      break;
    }
    case 'tool/call':
      data = { callId: ev.data?.callId, name: ev.data?.name, args: String(ev.data?.arguments || '').slice(0, 1200) };
      break;
    case 'tool/result': {
      const content = ev.data?.message?.content || [];
      const preview = content
        .filter((b: any) => b.type === 'text' || b.type === 'tool-result')
        .map((b: any) => b.text || JSON.stringify(b).slice(0, 200))
        .join('\n')
        .slice(0, 800);
      data = { callId: ev.data?.message?.source?.callId ?? content?.[0]?.toolCallId, error: !!ev.data?.error, preview };
      break;
    }
    case 'system/message': {
      const blocks = ev.data?.content || ev.data?.message?.content || [];
      data = { text: (Array.isArray(blocks) ? blocks : []).filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n').slice(0, 200) };
      break;
    }
    case 'turn/end':
      data = { kind: ev.data?.reason?.kind, message: ev.data?.reason?.error?.message };
      break;
    default:
      data = ev.data && typeof ev.data === 'object' ? { value: String((ev.data as any).preset || (ev.data as any).mode || (ev.data as any).policy || '').slice(0, 80) } : undefined;
  }
  chat.traj.push({ seq: ev.seq, time: ev.time || 0, type: ev.type, data });
}

/** Fold one durable session event into a chat draft. */
function foldEvent(chat: WritableDraft<ChatState>, ev: SessionEvent): void {
  if (ev.seq <= chat.lastSeq) return;
  chat.lastSeq = ev.seq;
  if (ev.seq < chat.minSeq) chat.minSeq = ev.seq;
  pushTraj(chat, ev);

  switch (ev.type) {
    case 'turn/start':
      chat.streaming = true;
      break;
    case 'user/message': {
      const m = ev.data;
      if (m?.source?.kind === 'user') {
        const text = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n');
        const opt = chat.items.find((i) => i.optimistic && i.kind === 'user' && itemText(i) === text);
        if (opt) {
          opt.optimistic = false;
          opt.seq = ev.seq;
          opt.message = m;
        } else {
          chat.items.push({ kind: 'user', seq: ev.seq, message: m });
        }
      } else {
        chat.items.push({ kind: 'context', seq: ev.seq, message: m });
      }
      break;
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = ev.data;
      const key = `${turn}:${step}`;
      let idx = chat.streamIdx[key];
      if (idx === undefined) {
        chat.items.push({ kind: 'assistant', seq: ev.seq, turn, step, streaming: true, parts: [] });
        idx = chat.items.length - 1;
        chat.streamIdx[key] = idx;
      }
      const item = chat.items[idx];
      const parts = item.parts!;
      const ensure = (i: number) => {
        while (parts.length <= i) parts.push({ kind: 'text', text: '' });
      };
      switch (chunk.type) {
        case 'block-start': {
          ensure(chunk.index);
          const kind = chunk.blockType === 'reasoning' ? 'reasoning' : chunk.blockType === 'tool-call' ? 'tool-call' : 'text';
          parts[chunk.index] = { kind, text: '', args: '' };
          break;
        }
        case 'text-delta':
        case 'reasoning-delta': {
          ensure(chunk.index);
          const p = parts[chunk.index];
          p.text = (p.text || '') + chunk.text;
          break;
        }
        case 'tool-call-delta': {
          ensure(chunk.index);
          const p = parts[chunk.index];
          p.kind = 'tool-call';
          if (chunk.name) p.name = chunk.name;
          p.args = (p.args || '') + chunk.argumentsDelta;
          break;
        }
      }
      break;
    }
    case 'assistant/message': {
      const { turn, step, message, usage } = ev.data;
      const key = `${turn}:${step}`;
      const idx = chat.streamIdx[key];
      if (idx !== undefined) {
        chat.items.splice(idx, 1);
        delete chat.streamIdx[key];
      }
      chat.items.push({ kind: 'assistant', seq: ev.seq, turn, step, message, usage });
      break;
    }
    case 'tool/call':
      chat.items.push({
        kind: 'tool',
        seq: ev.seq,
        callId: ev.data.callId,
        name: ev.data.name,
        arguments: ev.data.arguments,
        pending: true,
      });
      break;
    case 'tool/result': {
      const callId = ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
      let target: WritableDraft<ChatItem> | undefined;
      for (let i = chat.items.length - 1; i >= 0; i--) {
        const it = chat.items[i];
        if (it.kind === 'tool' && it.callId === callId && !it.result) {
          target = it;
          break;
        }
      }
      const result = { content: ev.data?.message?.content, error: ev.data?.error, meta: ev.data?.meta };
      if (target) {
        target.result = result;
        target.pending = false;
      } else {
        chat.items.push({ kind: 'tool', seq: ev.seq, callId, name: '?', arguments: '', pending: false, result });
      }
      break;
    }
    case 'todo/write':
      chat.todos = ev.data?.todos || [];
      break;
    case 'feedback/message-put': {
      const it = ev.data?.item;
      if (it?.messageId && (it.rating === 'positive' || it.rating === 'negative')) {
        chat.feedback[it.messageId] = { rating: it.rating, version: it.version };
      }
      break;
    }
    case 'feedback/message-delete':
      if (ev.data?.messageId) delete chat.feedback[ev.data.messageId];
      break;
    case 'request/header': {
      const cfg = ev.data?.header?.config || {};
      chat.model = { provider: cfg.provider, model: cfg.model };
      break;
    }
    case 'turn/end': {
      chat.streaming = false;
      chat.streamIdx = {};
      const kind = ev.data?.reason?.kind;
      if (kind === 'error') {
        chat.items.push({ kind: 'notice', seq: ev.seq, level: 'error', text: ev.data?.reason?.error?.message || 'error' });
      } else if (kind === 'interrupted') {
        chat.items.push({ kind: 'notice', seq: ev.seq, level: 'warn', text: 'interrupted' });
      } else if (kind === 'max-tokens') {
        chat.items.push({ kind: 'notice', seq: ev.seq, level: 'warn', text: 'max-tokens' });
      }
      break;
    }
  }
}

export interface DeliverableFile { path: string; op: string }

/** Files created/modified per turn, derived from the light event projection. */
export function deriveDeliverables(traj: TrajEv[]): Map<number, DeliverableFile[]> {
  const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
  const out = new Map<number, DeliverableFile[]>();
  let turn = 0;
  const callPaths = new Map<string, { path: string; op: string }>();
  const push = (t: number, f: DeliverableFile) => {
    const list = out.get(t) || [];
    if (!list.some((x) => x.path === f.path)) list.push(f);
    out.set(t, list);
  };
  for (const ev of traj) {
    const d = ev.data || {};
    if (ev.type === 'turn/start') turn += 1;
    else if (ev.type === 'tool/call' && WRITE_TOOLS.has(d.name)) {
      let args: any = null;
      try {
        args = typeof d.args === 'string' ? JSON.parse(d.args) : d.args;
      } catch {
        continue;
      }
      const path = args?.file_path || args?.path || args?.command?.path;
      const cmd = args?.command?.command || args?.command;
      const op = d.name === 'str_replace_editor' && cmd === 'view' ? '' : String(cmd || d.name);
      if (path && op) callPaths.set(d.callId, { path: String(path), op });
    } else if (ev.type === 'tool/result' && !d.error && d.callId) {
      const hit = callPaths.get(d.callId);
      if (hit) {
        push(turn, hit);
        callPaths.delete(d.callId);
      }
    }
  }
  return out;
}

interface AppState {
  booted: boolean;
  wsStatus: WsStatus;
  dshStatus: string;
  sessions: SessionSummary[];
  workspaces: WorkspaceView[];
  archived: string[];
  jobs: Record<string, Array<{ id: string; kind: string; label: string; status: string; startedAt: number; finishedAt?: number; detail?: string }>>;
  taskMeta: Record<string, TaskMeta>;
  taskGroups: TaskGroup[];
  skills: SkillEntry[];
  skillsSession: string | null;
  modelsCache: Record<string, SessionModels>;
  automations: Automation[];
  automationRuns: AutomationRun[];
  hooks: Hook[];
  hookRuns: HookRun[];
  chats: Record<string, ChatState>;
  approvals: Record<string, ApprovalPending>;
  questions: Record<string, QuestionPending>;
  activeId: string | null;
  view: ViewName;
  sidebarOpen: boolean;
  composerPreset: string;
  toasts: Toast[];
  newTaskModal: boolean;
  qrModal: string | null;
  remoteOpen: boolean;
  filePanel: boolean;
  fileListings: Record<string, Array<{ name: string; type: string; size?: number }>>;
  filePreview: { path: string; loading: boolean; text?: string; bytes?: number; err?: string } | null;
  filePreviewSid: string | null;

  boot: () => Promise<void>;
  resyncAll: () => Promise<void>;
  setView: (v: ViewName) => void;
  setSidebar: (open: boolean) => void;
  openSession: (sid: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshTaskMeta: () => Promise<void>;
  refreshAutomations: () => Promise<void>;
  refreshHooks: () => Promise<void>;
  refreshSkills: (force?: boolean) => Promise<void>;
  loadModels: (sid: string) => Promise<void>;
  loadOlder: (sid: string) => Promise<void>;
  sendMessage: (sid: string, text: string, mode?: 'queue' | 'steer', attachments?: AttachmentDraft[]) => Promise<void>;
  cancel: (sid: string) => Promise<void>;
  rename: (sid: string, title: string) => Promise<void>;
  fork: (sid: string, atSeq?: number) => Promise<void>;
  archive: (sid: string) => Promise<void>;
  setPinned: (sid: string, pinned: boolean) => Promise<void>;
  setGroup: (sid: string, groupId: string | null) => Promise<void>;
  selectModel: (sid: string, provider: string, model: string, reasoningEffort?: string) => Promise<void>;
  queueAction: (sid: string, itemId: string, action: any) => Promise<void>;
  rate: (sid: string, messageId: string, rating: 'positive' | 'negative') => Promise<void>;
  toggleFilePanel: () => void;
  listFiles: (sid: string, dir: string) => Promise<void>;
  openFilePreview: (sid: string, path: string, bytes?: number) => Promise<void>;
  respondApproval: (sid: string, outcome: 'allowed-once' | 'rejected') => Promise<void>;
  respondQuestion: (sid: string, answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> }) => Promise<void>;
  newTask: (opts: { workspaceId?: string; cwd?: string; agentPreset?: string; prompt?: string }) => Promise<string | null>;
  applyWs: (msg: any) => void;
  toast: (level: Toast['level'], title: string, body?: string) => void;
  dismissToast: (id: string) => void;
  setNewTaskModal: (open: boolean) => void;
  setQrModal: (url: string | null) => void;
  setRemoteOpen: (open: boolean) => void;
  setComposerPreset: (text: string) => void;
}

let refreshTimer: number | undefined;

export const useStore = create<AppState>()(
  immer((setState, getState) => {
    const mutate = (fn: (draft: WritableDraft<AppState>) => void) => setState(fn);
    const get = getState;

    const scheduleSessionsRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void get().refreshSessions(), 350);
    };

    const applyMuxFrame = (frame: any, rpcId?: string): void => {
      if (!frame || !frame.type) return;
      switch (frame.type) {
        case 'session/event':
          mutate((s) => {
            const chat = ensureChat(s, frame.sessionId);
            foldEvent(chat, frame.event);
          });
          if (frame.event?.type === 'turn/end' || frame.event?.type === 'user/message') scheduleSessionsRefresh();
          break;
        case 'session/queue':
          mutate((s) => {
            ensureChat(s, frame.sessionId).queue = frame.items || [];
          });
          break;
        case 'session/jobs':
          mutate((s) => {
            if ((frame.jobs || []).length === 0) delete s.jobs[frame.sessionId];
            else s.jobs[frame.sessionId] = frame.jobs;
          });
          break;
        case 'session/projection':
          mutate((s) => {
            const chat = ensureChat(s, frame.sessionId);
            const cur = chat.projValues[frame.key];
            if (!cur || (frame.seq ?? 0) >= cur.seq) {
              chat.projValues[frame.key] = { value: frame.value, seq: frame.seq ?? 0 };
            }
          });
          break;
        case 'approval/requested':
          mutate((s) => {
            s.approvals[frame.sessionId] = {
              rpcId: rpcId || '',
              sessionId: frame.sessionId,
              approvalId: frame.approvalId,
              toolName: frame.toolName,
              callId: frame.callId,
              reason: frame.reason,
            };
          });
          break;
        case 'approval/resolved':
          mutate((s) => {
            delete s.approvals[frame.sessionId];
          });
          break;
        case 'question/requested':
          mutate((s) => {
            s.questions[frame.sessionId] = { rpcId: rpcId || '', sessionId: frame.sessionId, questions: frame.questions || [] };
          });
          break;
        case 'question/resolved':
          mutate((s) => {
            delete s.questions[frame.sessionId];
          });
          break;
      }
    };

    const applyHostFrame = (frame: any): void => {
      if (!frame || !frame.type) return;
      switch (frame.type) {
        case 'host/session-added':
        case 'host/session-removed':
        case 'host/workspace-changed':
        case 'host/workspace-removed':
        case 'host/workspace-order-changed':
        case 'host/archived-sessions-changed':
          scheduleSessionsRefresh();
          void get().refreshWorkspaces();
          break;
        case 'host/session-status':
          mutate((s) => {
            const sess = s.sessions.find((x) => x.sessionId === frame.sessionId);
            if (sess) sess.running = !!frame.running;
            const chat = s.chats[frame.sessionId];
            if (chat) chat.streaming = !!frame.running;
          });
          scheduleSessionsRefresh();
          break;
        case 'host/agent-error':
          mutate((s) => {
            const chat = s.chats[frame.sessionId];
            if (chat) chat.items.push({ kind: 'notice', seq: chat.lastSeq + 0.5, level: 'error', text: frame.message });
          });
          get().toast('error', String(frame.message || 'agent error').slice(0, 140), frame.sessionId);
          break;
      }
    };

    return {
      booted: false,
      wsStatus: 'connecting',
      dshStatus: 'starting',
      sessions: [],
      workspaces: [],
      archived: [],
      jobs: {},
      filePanel: false,
      fileListings: {},
      filePreview: null,
      filePreviewSid: null,
      taskMeta: {},
      taskGroups: [],
      skills: [],
      skillsSession: null,
      modelsCache: {},
      automations: [],
      automationRuns: [],
      hooks: [],
      hookRuns: [],
      chats: {},
      approvals: {},
      questions: {},
      activeId: null,
      view: 'chat',
      sidebarOpen: false,
      composerPreset: '',
      toasts: [],
      newTaskModal: false,
      qrModal: null,
      remoteOpen: false,

      resyncAll: async () => {
        await Promise.all([
          get().refreshSessions(),
          get().refreshWorkspaces(),
          get().refreshTaskMeta(),
          get().refreshAutomations(),
          get().refreshHooks(),
        ]);
        // re-pull the open conversation so messages sent elsewhere appear
        const sid = get().activeId;
        if (sid) {
          mutate((s) => {
            if (s.chats[sid]) s.chats[sid].loaded = false;
          });
          await get().openSession(sid);
        }
      },

      boot: async () => {
        await Promise.all([
          get().refreshSessions(),
          get().refreshWorkspaces(),
          get().refreshTaskMeta(),
          get().refreshAutomations(),
          get().refreshHooks(),
        ]);
        mutate((s) => {
          s.booted = true;
        });
        connectWs(
          (msg) => get().applyWs(msg),
          (st2) => {
            const wasLost = get().wsStatus === 'lost';
            mutate((s) => void (s.wsStatus = st2));
            // reconnect after a drop: full resync (events were missed while offline)
            if (st2 === 'connected' && wasLost) void get().resyncAll();
          },
        );
      },

      setView: (v) =>
        mutate((s) => {
          s.view = v;
          s.sidebarOpen = false;
        }),
      setSidebar: (open) => mutate((s) => void (s.sidebarOpen = open)),
      setNewTaskModal: (open) => mutate((s) => void (s.newTaskModal = open)),
      setQrModal: (url) => mutate((s) => void (s.qrModal = url)),
      setRemoteOpen: (open) => mutate((s) => void (s.remoteOpen = open)),
      setComposerPreset: (text) => mutate((s) => void (s.composerPreset = text)),

      openSession: async (sid) => {
        mutate((s) => {
          s.activeId = sid;
          s.view = 'chat';
          s.sidebarOpen = false;
        });
        const existing = get().chats[sid];
        if (!existing || !existing.loaded) {
          const res = await dshCall<{
            events: Array<{ event: SessionEvent }>;
            hasMore: boolean;
            projections?: { asOfSeq: number; values?: Record<string, unknown> };
          }>('session.history', { sessionId: sid, maxMessages: 40 });
          if (res.ok) {
            const v = res.value!;
            mutate((s) => {
              const c = ensureChat(s, sid);
              c.loading = false;
              c.items = [];
              c.lastSeq = 0;
              c.minSeq = Number.MAX_SAFE_INTEGER;
              c.streamIdx = {};
              c.traj = [];
              for (const entry of v.events || []) foldEvent(c, entry.event);
              c.hasMore = v.hasMore;
              c.loaded = true;
              if (v.projections?.values) {
                for (const [key, value] of Object.entries(v.projections.values)) {
                  c.projValues[key] = { value, seq: v.projections.asOfSeq };
                }
              }
              if (c.minSeq === Number.MAX_SAFE_INTEGER) c.minSeq = 0;
            });
            // seed message feedback (assistant message ratings) for this session
            void dshCall<any>('messageFeedback.list', { sessionId: sid }).then((r) => {
              if (!r.ok) return;
              const inner = r.value as any;
              if (inner?.ok === false) return;
              const items: Array<{ messageId: string; rating: 'positive' | 'negative'; version: string }> = inner?.items || inner?.value?.items || [];
              mutate((s) => {
                const c = ensureChat(s, sid);
                c.feedback = {};
                for (const it of items) c.feedback[it.messageId] = { rating: it.rating, version: it.version };
              });
            });
          } else {
            mutate((s) => {
              const c = ensureChat(s, sid);
              c.loading = false;
              c.loaded = true;
            });
            get().toast('error', res.error?.message || 'failed to load history');
          }
        }
        void get().loadModels(sid);
        void get().refreshSkills();
      },

      refreshSessions: async () => {
        const res = await dshCall<{ items: SessionSummary[] }>('session.list', {});
        if (res.ok) {
          const items = (res.value?.items || []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
          mutate((s) => {
            s.sessions = items;
          });
        }
      },

      refreshWorkspaces: async () => {
        const res = await dshCall<{ items: WorkspaceView[]; archivedSessionIds: string[] }>('workspace.list', {});
        if (res.ok) {
          mutate((s) => {
            s.workspaces = res.value?.items || [];
            s.archived = res.value?.archivedSessionIds || [];
          });
        }
      },

      refreshTaskMeta: async () => {
        const r = await fe.taskmeta();
        mutate((s) => {
          s.taskMeta = r.meta;
          s.taskGroups = r.groups;
        });
      },

      refreshAutomations: async () => {
        const r = await fe.automations();
        mutate((s) => {
          s.automations = r.automations || [];
          s.automationRuns = r.runs || [];
        });
      },

      refreshHooks: async () => {
        const r = await fe.hooks();
        mutate((s) => {
          s.hooks = r.hooks || [];
          s.hookRuns = r.runs || [];
        });
      },

      refreshSkills: async (force) => {
        // skills are discovered from <cwd>/.agents/skills — scope the catalog
        // to the user's home session so global skills always show up
        const home = ((await fe.health().catch(() => ({}))) as { home?: string }).home?.replace(/\\/g, '/').toLowerCase() || '';
        let sid = force ? '' : get().skillsSession;
        if (home) {
          const homeSession = get().sessions.find((x) => (x.cwd || '').replace(/\\/g, '/').toLowerCase() === home);
          if (homeSession) sid = homeSession.sessionId;
        }
        if (!sid) {
          if (!home) {
            const any = get().activeId || get().sessions.find((x) => x.origin !== 'subagent')?.sessionId;
            if (!any) return;
            sid = any;
          } else {
            const res = await dshCall<{ sessionId: string }>('session.create', { cwd: home });
            if (!res.ok) return;
            sid = res.value!.sessionId;
            await get().refreshSessions();
          }
          mutate((st) => void (st.skillsSession = sid));
        }
        const res = await dshCall<{ skills: SkillEntry[] }>('skill.list', { sessionId: sid });
        if (res.ok) {
          mutate((st) => {
            st.skills = (res.value?.skills || []) as SkillEntry[];
          });
        }
      },

      loadModels: async (sid) => {
        if (get().modelsCache[sid]) return;
        const res = await dshCall<SessionModels>('session.models', { sessionId: sid });
        if (res.ok) {
          mutate((s) => {
            s.modelsCache[sid] = res.value!;
          });
        }
      },

      loadOlder: async (sid) => {
        const chat = get().chats[sid];
        if (!chat || !chat.loaded || chat.loading || !chat.hasMore) return;
        mutate((s) => {
          s.chats[sid].loading = true;
        });
        const before = chat.minSeq > 0 ? chat.minSeq : undefined;
        const res = await dshCall<{ events: Array<{ event: SessionEvent }>; hasMore: boolean }>('session.history', {
          sessionId: sid,
          beforeSeq: before,
          maxMessages: 40,
        });
        if (!res.ok) {
          mutate((s) => {
            s.chats[sid].loading = false;
          });
          return;
        }
        mutate((s) => {
          const c = s.chats[sid];
          c.loading = false;
          let minSeq = c.minSeq;
          const older: ChatItem[] = [];
          const olderTraj: TrajEv[] = [];
          const tmp = { traj: olderTraj } as WritableDraft<ChatState>;
          for (const entry of res.value!.events || []) {
            const ev = entry.event;
            if (ev.seq < minSeq) minSeq = ev.seq;
            foldOlderInto(older, ev);
            pushTraj(tmp, ev);
          }
          c.items.unshift(...older);
          c.traj.unshift(...olderTraj);
          c.hasMore = res.value!.hasMore;
          c.minSeq = minSeq;
        });
      },

      sendMessage: async (sid, text, mode = 'queue', attachments) => {
        const trimmed = text.trim();
        const atts = attachments || [];
        if (!trimmed && atts.length === 0) return;
        // images ride inline as base64 parts; files upload first and reference their receipt
        const parts: Array<Record<string, unknown>> = [];
        if (trimmed) parts.push({ type: 'text', text: trimmed });
        for (const a of atts) {
          if (a.kind === 'image' && a.dataBase64) parts.push({ type: 'image', mediaType: a.mediaType, data: a.dataBase64, name: a.name });
        }
        const fileAtts = atts.filter((a) => a.kind === 'file' && a.bytes);
        for (const a of fileAtts) {
          try {
            const r = await fe.uploadFile(sid, a.name, a.bytes!);
            if (r?.receiptId) parts.push({ type: 'file', receiptId: r.receiptId });
          } catch (e: any) {
            get().toast('error', `${a.name}: ${e?.message || 'upload failed'}`);
          }
        }
        if (parts.length === 0) return;
        mutate((s) => {
          const chat = ensureChat(s, sid);
          if (!trimmed.startsWith('/')) {
            chat.items.push({
              kind: 'user',
              seq: -Date.now(),
              optimistic: true,
              message: {
                content: [
                  ...(trimmed ? [{ type: 'text', text: trimmed }] : []),
                  ...atts.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', mediaType: a.mediaType, data: a.dataBase64, name: a.name })),
                ],
                source: { kind: 'user' },
              },
            });
          }
        });
        const res = await dshCall<{ accepted: boolean; command?: { text?: string } }>('session.prompt', {
          sessionId: sid,
          mode,
          content: parts,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (res.ok) {
          if (res.value?.command?.text) {
            mutate((s) => {
              ensureChat(s, sid).items.push({ kind: 'notice', seq: -Date.now() - 1, level: 'info', text: res.value!.command!.text });
            });
          }
        } else {
          mutate((s) => {
            const chat = ensureChat(s, sid);
            const idx = chat.items.findIndex((i) => i.optimistic);
            if (idx >= 0) chat.items.splice(idx, 1);
          });
          get().toast('error', res.error?.message || 'prompt failed', res.error?.code);
        }
      },

      cancel: async (sid) => {
        await dshCall('session.cancel', { sessionId: sid });
      },

      rename: async (sid, title) => {
        const res = await dshCall('session.rename', { sessionId: sid, title });
        if (res.ok) {
          mutate((s) => {
            const chat = ensureChat(s, sid);
            chat.projValues.title = { value: title, seq: (chat.projValues.title?.seq || 0) + 1 };
          });
        } else {
          get().toast('error', res.error?.message || 'rename failed');
        }
      },

      fork: async (sid, atSeq) => {
        const res = await dshCall<{ sessionId: string }>('session.fork', { sessionId: sid, atSeq });
        if (res.ok) {
          await get().refreshSessions();
          void get().openSession(res.value!.sessionId);
        } else {
          get().toast('error', res.error?.message || 'fork failed');
        }
      },

      archive: async (sid) => {
        const res = await dshCall('workspace.archiveSession', { sessionId: sid });
        if (res.ok) {
          mutate((s) => {
            if (s.activeId === sid) s.activeId = null;
          });
          await Promise.all([get().refreshSessions(), get().refreshWorkspaces()]);
        } else {
          get().toast('error', res.error?.message || 'archive failed');
        }
      },

      setPinned: async (sid, pinned) => {
        mutate((s) => {
          s.taskMeta[sid] = { ...(s.taskMeta[sid] || { updatedAt: Date.now() }), pinned, updatedAt: Date.now() };
        });
        await fe.setTaskMeta(sid, { pinned });
      },

      setGroup: async (sid, groupId) => {
        mutate((s) => {
          s.taskMeta[sid] = { ...(s.taskMeta[sid] || { updatedAt: Date.now() }), groupId: groupId || undefined, updatedAt: Date.now() };
        });
        await fe.setTaskMeta(sid, { groupId });
      },

      selectModel: async (sid, provider, model, reasoningEffort) => {
        const res = await dshCall('session.selectModel', { sessionId: sid, provider, model, reasoningEffort });
        if (res.ok) {
          const sel = (res.value as any)?.selected || { provider, model, reasoningEffort };
          mutate((s) => {
            if (s.modelsCache[sid]) s.modelsCache[sid].current = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort } as any;
          });
          get().toast('success', reasoningEffort ? `${provider}/${model} · ${reasoningEffort}` : `${provider}/${model}`);
        } else {
          get().toast('error', res.error?.message || 'select failed');
        }
      },

      queueAction: async (sid, itemId, action) => {
        await dshCall('session.updateQueue', { sessionId: sid, itemId, action });
      },

      rate: async (sid, messageId, rating) => {
        const cur = get().chats[sid]?.feedback[messageId];
        const retract = !!cur && cur.rating === rating;
        const body: Record<string, unknown> = { sessionId: sid, messageId, ifVersion: cur?.version ?? null };
        if (!retract) body.rating = rating;
        const r = await dshCall<any>(retract ? 'messageFeedback.delete' : 'messageFeedback.put', body);
        const biz = r.ok ? ((r.value as any)?.ok === false ? (r.value as any).error : null) : r.error;
        if (biz) get().toast('error', biz.message || 'feedback failed');
      },

      toggleFilePanel: () => {
        mutate((s) => {
          s.filePanel = !s.filePanel;
          if (!s.filePanel) s.filePreview = null;
        });
      },

      listFiles: async (sid, dir) => {
        mutate((s) => void (s.fileListings[dir] = [])); // mark loading with empty
        const r = await dshCall<{ entries?: Array<{ name: string; type: string; size?: number }> }>('workspaceFiles.list', {
          workspaceFileScopeId: sid,
          path: dir || '.',
        });
        if (!r.ok) {
          get().toast('error', r.error?.message || 'list failed');
          return;
        }
        const entries = (r.value?.entries || []).slice().sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
        );
        mutate((s) => void (s.fileListings[dir] = entries));
      },

      openFilePreview: async (sid, path, bytes) => {
        mutate((s) => void (s.filePreview = { path, loading: true }));
        mutate((s) => void (s.filePreviewSid = sid));
        const MAX = 200_000;
        const want = typeof bytes === 'number' && bytes > 0 ? Math.min(bytes, MAX) : MAX;
        const r = await dshCall<{ text?: string; bytes?: number; offset?: number }>('workspaceFiles.read', {
          workspaceFileScopeId: sid,
          path,
          range: { offset: 1, length: want },
        });
        mutate((s) => {
          if (s.filePreview?.path !== path) return;
          if (!r.ok) s.filePreview = { path, loading: false, err: r.error?.message || 'read failed' };
          else s.filePreview = { path, loading: false, text: r.value?.text, bytes: r.value?.bytes };
        });
      },

      respondApproval: async (sid, outcome) => {
        const ap = get().approvals[sid];
        if (!ap) return;
        mutate((s) => {
          delete s.approvals[sid];
        });
        await fe.respond(ap.rpcId, {
          ok: true,
          value: { sessionId: sid, approvalId: ap.approvalId, outcome },
        });
      },

      respondQuestion: async (sid, answer) => {
        const q = get().questions[sid];
        if (!q) return;
        mutate((s) => {
          delete s.questions[sid];
        });
        await fe.respond(q.rpcId, { ok: true, value: { sessionId: sid, answer } });
      },

      newTask: async (opts) => {
        let sid: string | undefined;
        if (opts.workspaceId) {
          const ws = get().workspaces.find((w) => w.workspaceId === opts.workspaceId);
          const blank = get().sessions.find(
            (s) => s.blank && s.origin !== 'subagent' && ws?.sessionIds.includes(s.sessionId),
          );
          if (blank) sid = blank.sessionId;
        }
        if (!sid) {
          const payload: any = {};
          if (opts.workspaceId) payload.workspaceId = opts.workspaceId;
          if (opts.cwd) payload.cwd = opts.cwd;
          if (opts.agentPreset) payload.agentPreset = opts.agentPreset;
          const res = await dshCall<{ sessionId: string }>('session.create', payload);
          if (!res.ok) {
            get().toast('error', res.error?.message || 'create failed', res.error?.code);
            return null;
          }
          sid = res.value!.sessionId;
        }
        await get().refreshSessions();
        await get().openSession(sid);
        if (opts.prompt?.trim()) await get().sendMessage(sid, opts.prompt);
        return sid;
      },

      applyWs: (msg) => {
        if (!msg || !msg.t) return;
        switch (msg.t) {
          case 'hello':
            mutate((s) => void (s.dshStatus = msg.dsh || 'starting'));
            break;
          case 'dsh:mux':
            applyMuxFrame(msg.frame, msg.rpcId);
            break;
          case 'dsh:host':
            applyHostFrame(msg.frame);
            break;
          case 'dsh:status':
            mutate((s) => void (s.dshStatus = msg.status));
            if (msg.status === 'up') {
              void get().refreshSessions();
              void get().refreshWorkspaces();
            }
            break;
          case 'automation:started':
          case 'automation:completed':
          case 'automation:changed':
            void get().refreshAutomations();
            if (msg.t === 'automation:completed') {
              const run = msg.run as AutomationRun;
              get().toast(run?.ok ? 'success' : 'error', `${run?.automationName ?? ''} · ${run?.ok ? 'OK' : 'FAIL'}`);
            }
            break;
          case 'hook:ran':
          case 'hook:changed':
            void get().refreshHooks();
            break;
          case 'gateway:notification':
            get().toast(msg.level === 'error' ? 'error' : 'info', String(msg.title || ''), String(msg.body || ''));
            break;
        }
      },

      toast: (level, title, body) => {
        const id = Math.random().toString(36).slice(2);
        mutate((s) => {
          s.toasts.push({ id, level, title, body });
        });
        setTimeout(() => get().dismissToast(id), level === 'error' ? 8000 : 4000);
      },

      dismissToast: (id) => {
        mutate((s) => {
          s.toasts = s.toasts.filter((t2) => t2.id !== id);
        });
      },
    };
  }),
);

/** Fold older-page events into a detached item list (no live state involved). */
function foldOlderInto(items: WritableDraft<ChatItem>[], ev: SessionEvent): void {
  switch (ev.type) {
    case 'user/message':
      items.push({ kind: ev.data?.source?.kind === 'user' ? 'user' : 'context', seq: ev.seq, message: ev.data });
      break;
    case 'assistant/message':
      items.push({ kind: 'assistant', seq: ev.seq, turn: ev.data.turn, step: ev.data.step, message: ev.data.message, usage: ev.data.usage });
      break;
    case 'tool/call':
      items.push({ kind: 'tool', seq: ev.seq, callId: ev.data.callId, name: ev.data.name, arguments: ev.data.arguments, pending: false });
      break;
    case 'tool/result': {
      const callId = ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
      const result = { content: ev.data?.message?.content, error: ev.data?.error, meta: ev.data?.meta };
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'tool' && it.callId === callId && !it.result) {
          it.result = result;
          it.pending = false;
          return;
        }
      }
      items.push({ kind: 'tool', seq: ev.seq, callId, name: '?', arguments: '', pending: false, result });
      break;
    }
    case 'turn/end': {
      const kind = ev.data?.reason?.kind;
      if (kind === 'error') {
        items.push({ kind: 'notice', seq: ev.seq, level: 'error', text: ev.data?.reason?.error?.message || 'error' });
      }
      break;
    }
  }
}

export async function ensureAnySession(): Promise<string | null> {
  const st = useStore.getState();
  const sid = st.activeId || st.sessions.find((s) => s.origin !== 'subagent')?.sessionId;
  if (sid) return sid;
  return await st.newTask({});
}

export { dshOk };
