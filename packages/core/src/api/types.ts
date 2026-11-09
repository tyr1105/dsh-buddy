/** 界面契约逐项保留规格 15.1 字段，时间额外提供原始毫秒，界面无需读取内部表或自行拼装文案。 */
import type { Activity, AgendaItem, AppraisalLog, Autonomy, Bot, Goal, InboxItem, Lifecycle, ModelChoice, Outcome, PaceProfile, Role, Settings, ThreadMessage, Variant, WakeKind, WakeTicket, Watch } from '../model/index.js';

export type Light = 'green' | 'yellow' | 'orange' | 'red';
export type CommandResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string;
  lifecycle: Lifecycle; lifecycleLabel: string; activity: Activity; activityLabel: string; activityText: string;
  nextThinkAt: number | null; nextThinkText: string; lightCheckAt: number | null;
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveAt: number | null; lastActiveText: string | null;
  unread: number; todayThinks: number; todayBudget: number; todayTokens: number; waitingOwner: boolean;
}
export interface OverviewView {
  bots: BotCard[];
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number };
  team: { unread: number; lastMessageText: string | null };
  quota: { light: Light; lightLabel: string; usedText: string; resetAt: number | null; resetText: string | null };
  health: { ok: boolean; heartbeatAt: number | null; heartbeatText: string; downtimeAt: number | null; downtimeText: string | null; openAlerts: number };
  nowAt: number; nowText: string; quietNow: boolean; pushesLeftToday: number;
}
export interface ThreadMessageView {
  id: string; thread: string; from: string; fromName: string; fromColor: string | null;
  kind: ThreadMessage['kind']; text: string; createdAt: number; timeText: string; createdText: string;
  card: null | { inboxId: string; approvalId: string | null; type: InboxItem['type']; status: InboxItem['status']; title: string; body: string;
    options: string[]; defaultOption: string | null; answer: string | null; expiresAt: number | null; expiresText: string | null };
}
export interface ThreadView { threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null }
export interface WakeRow {
  id: string; variant: Variant; variantLabel: string; reasonKind: WakeKind; reasonText: string; score: number; threshold: number;
  status: WakeTicket['status']; outcome: Outcome | null; outcomeLabel: string | null; summary: string | null;
  steps: number; tokens: number; durationMs: number | null; durationText: string | null; startedAt: number; timeText: string; startedText: string;
}
export interface AppraisalRow {
  id: string; at: number; timeText: string; decision: AppraisalLog['decision']; decisionLabel: string;
  suppressedBy: AppraisalLog['suppressedBy']; text: string; score: number; threshold: number;
}
export interface BotView {
  card: BotCard;
  profile: { persona: string; autonomy: Autonomy; autonomyLabel: string; pace: PaceProfile; paceLabel: string; model: ModelChoice;
    modelText: string; homeDir: string; sessionId: string | null; createdAt: number; createdText: string;
    probationAt: number | null; probationText: string | null; workDataAllowed: boolean };
  aspirations: Array<{ id: string; text: string; status: string }>;
  goals: Array<{ id: string; title: string; doneWhen: string; period: string; periodAt: number | null; periodText: string;
    status: Goal['status']; statusLabel: string; lastProgressAt: number; lastProgressText: string; createdBy: 'owner' | 'bot' }>;
  agenda: Array<{ id: string; kind: AgendaItem['kind']; kindLabel: string; title: string; dueAt: number | null; dueText: string | null;
    priority: number; toOwner: boolean; source: AgendaItem['source']; status: AgendaItem['status'] }>;
  watches: Array<{ id: string; kind: Watch['kind']; kindLabel: string; target: string; filter: string | null; intervalMs: number | null;
    intervalText: string | null; expectationText: string | null; status: Watch['status']; createdBy: Watch['createdBy']; why: string;
    lastCheckedAt: number | null; lastCheckedText: string | null }>;
  routines: Array<{ id: string; name: string; whenToUse: string; steps: string[]; runs: number; updatedAt: number; updatedText: string }>;
  rules: Array<{ id: string; text: string; redLine: boolean; scope: 'global' | 'bot' }>;
  memoryExcerpt: string; wakes: WakeRow[]; appraisals: AppraisalRow[];
  stats: { thinks7d: number; intervalCv: number | null; selfPacedRatio: number | null; selfInitiated7d: number; proposalAcceptRate: number | null; tokens7d: number };
}
export interface InboxItemView {
  id: string; botId: string | null; botName: string | null; botColor: string | null; type: InboxItem['type']; typeLabel: string;
  /** 仅审批卡为实际批准票 id；调用 decideApproval 使用它，不能误传收件箱 id。 */
  approvalId: string | null;
  priority: InboxItem['priority']; title: string; body: string; options: string[]; defaultOption: string | null;
  createdAt: number; createdText: string; expiresAt: number | null; expiresText: string | null;
}
export interface InboxView { items: InboxItemView[] }
export interface ActivityRow {
  id: string; at: number; timeText: string; botId: string | null; botName: string | null; botColor: string | null;
  kind: 'wake' | 'commit' | 'approval' | 'alert' | 'handoff' | 'peer' | 'lifecycle' | 'system'; text: string;
}
export interface ActivityView { rows: ActivityRow[]; hasMore: boolean }
export interface SettingsView { settings: Settings; pushChannelOptions: string[]; modelOptions: Array<{ value: ModelChoice; label: string }> }
export interface RecentSessionView { sessionId: string; title: string; updatedAt: number; updatedText: string }
/** 分页使用记录 id 作为稳定游标，也兼容旧界面的毫秒游标；同一毫秒不会因 id 游标丢消息。 */
export interface PageInput { before?: string | number; limit?: number }
/** 命令接收 unknown 是刻意的：宿主的 JSON 必须在边界校验，不能靠 TypeScript 类型假定安全。 */
export interface UiApi {
  overview(): OverviewView;
  bot(botId: string): Promise<BotView>;
  thread(threadId: string, page?: PageInput): ThreadView;
  inbox(): InboxView;
  activity(page?: PageInput): ActivityView;
  settings(): Promise<SettingsView>;
  recentSessions(): Promise<RecentSessionView[]>;
  createBot(input: unknown): Promise<CommandResult<Bot>>;
  updateBot(botId: string, patch: unknown): Promise<CommandResult<Bot>>;
  /** 按用户动作切换生命周期；入口校验 botId 和 action。 */
  lifecycleAction(input: unknown): Promise<CommandResult<Bot>>;
  /** 主人打断只取消在途工作，不计未交账或机器人错误。 */
  interruptBot(input: unknown): Promise<CommandResult<WakeTicket>>;
  setLifecycle(botId: string, lifecycle: Lifecycle): Promise<CommandResult<Bot>>;
  sendMessage(threadId: string, text: string): Promise<CommandResult>;
  answerInbox(id: string, answer: string): Promise<CommandResult>;
  decideApproval(id: string, approve: boolean, note?: string): Promise<CommandResult>;
  upsertAspiration(input: unknown): Promise<CommandResult>;
  upsertGoal(input: unknown): Promise<CommandResult>;
  closeGoal(id: string, outcome: 'done' | 'active' | 'abandoned' | boolean): Promise<CommandResult>;
  upsertWatch(input: unknown): Promise<CommandResult>;
  decideWatchProposal(id: string, approve: boolean): Promise<CommandResult>;
  upsertRule(input: unknown): Promise<CommandResult>;
  editRoutine(id: string, patch: unknown): Promise<CommandResult>;
  teach(botId: string, sessionId: string, note: string): Promise<CommandResult>;
  pokeBot(botId: string, text?: string): Promise<CommandResult>;
  updateSettings(patch: unknown): Promise<CommandResult>;
  markThreadRead(threadId: string): Promise<CommandResult>;
}
