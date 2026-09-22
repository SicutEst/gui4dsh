export interface TaskMeta {
  pinned?: boolean;
  groupId?: string;
  notes?: string;
  updatedAt: number;
}

export interface TaskGroup {
  id: string;
  title: string;
  color: string;
  createdAt: number;
}

export interface Automation {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  timeoutMin: number;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  lastError?: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  trigger: 'cron' | 'manual';
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  ok: boolean;
  timedOut: boolean;
  output: string;
}

export type HookEventName =
  | 'session.started'
  | 'session.running'
  | 'session.idle'
  | 'turn.completed'
  | 'turn.error'
  | 'agent.error'
  | 'automation.started'
  | 'automation.completed';

export const HOOK_EVENT_NAMES: HookEventName[] = [
  'session.started',
  'session.running',
  'session.idle',
  'turn.completed',
  'turn.error',
  'agent.error',
  'automation.started',
  'automation.completed',
];

export interface Hook {
  id: string;
  name: string;
  event: HookEventName;
  sessionId?: string | null;
  actionType: 'shell' | 'notify';
  command?: string;
  enabled: boolean;
  createdAt: number;
}

export interface HookRun {
  id: string;
  hookId: string;
  hookName: string;
  event: string;
  at: number;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface DayUsage {
  prompts: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: string[];
}

export interface ModelUsage {
  provider: string;
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

export interface GatewaySettings {
  locale: 'zh' | 'en';
  theme: 'dark' | 'light';
  externalBaseUrl: string;
  openBrowserOnStart: boolean;
  /** Master switch: when false, only loopback (local machine) access is allowed. */
  remoteEnabled: boolean;
  /** Follow the latest @deepseek-ai/dsh on npm (daily check). */
  autoUpdateDsh: boolean;
}

export interface SkillGroup {
  id: string;
  title: string;
  color: string;
}

export interface StoreShape {
  version: 1;
  token: string;
  settings: GatewaySettings;
  taskMeta: Record<string, TaskMeta>;
  taskGroups: TaskGroup[];
  automations: Automation[];
  automationRuns: AutomationRun[];
  hooks: Hook[];
  hookRuns: HookRun[];
  usage: Record<string, DayUsage>;
  models: ModelUsage[];
  skillGroups: SkillGroup[];
  skillAssign: Record<string, string>;
  statsBackfilled: boolean;
}
