export interface RpcResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: string;
  cwd?: string;
  agentPreset?: string;
  projections?: { asOfSeq: number; values?: Record<string, unknown> };
}

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable: boolean;
}

export interface AgentPresetEntry {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SessionModels {
  current: ModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string; description?: string; reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string } }>;
  }>;
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: string;
  toolCallId?: string;
  content?: ContentBlock[];
  isError?: boolean;
  attachment?: { id?: string; mediaType?: string };
}

export interface QueuedInboxItem {
  id: string;
  placement: 'queued' | 'steering' | 'context';
  message: { role: string; content: ContentBlock[]; source?: { kind?: string } };
}

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
  view?: unknown;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskOption[];
  multiSelect?: boolean;
  intent?: { kind: 'plan-review'; approve: string };
}

export interface ApprovalPending {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface QuestionPending {
  rpcId: string;
  sessionId: string;
  questions: AskQuestion[];
}

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

export interface Hook {
  id: string;
  name: string;
  event: string;
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

export interface DayStat {
  date: string;
  prompts: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

export interface StatsPayload {
  daily: DayStat[];
  totals: { turns: number; prompts: number; tokensIn: number; tokensOut: number };
  models: ModelUsage[];
}

export interface SkillGroup {
  id: string;
  title: string;
  color: string;
}

export interface GatewaySettings {
  locale: 'zh' | 'en';
  theme: 'dark' | 'light' | 'system';
  externalBaseUrl: string;
  openBrowserOnStart: boolean;
  remoteEnabled: boolean;
  autoUpdateDsh?: boolean;
  pushChannel?: 'off' | 'bark' | 'ntfy';
  barkServer?: string;
  barkKey?: string;
  ntfyServer?: string;
  ntfyTopic?: string;
  pushOnTurnEnd?: boolean;
  pushOnApproval?: boolean;
  frpcPath?: string;
  frpServer?: string;
  frpServerPort?: string;
  frpToken?: string;
  frpRemotePort?: number;
  frpEnabled?: boolean;
}

export interface PairingInfo {
  token: string;
  lanUrls: string[];
  externalUrl: string | null;
  port: number;
}

export type Toast = {
  id: string;
  level: 'info' | 'error' | 'success';
  title: string;
  body?: string;
};
