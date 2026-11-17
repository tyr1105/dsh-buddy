/** 线程、收件箱和活动流统一投影为中文视图；稳定 id 分页保留同毫秒发生的多条事件。 */
import { z } from 'zod';
import { ownerReasonSummary } from '../util/owner-text.js';
import { approvalActionText, approvalDisplayText, ownerParameterPreview } from '../util/action-text.js';
import type { HubContext } from '../engine/context.js';
import type { InboxItem, ModelChoice, ThreadMessage } from '../model/index.js';
import { INBOX_TYPE_LABELS, LIFECYCLE_LABELS, OUTCOME_LABELS, PUSH_CHANNELS } from '../model/enums.js';
import { nonempty } from '../model/primitives.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { presetSkillOptions } from '../config/preset-skills.js';
import { readDshSkillOptions } from './skills.js';
import { readModelCatalog } from './models.js';
import { threadMessages } from '../outreach/thread.js';
import { ALERT_REINSTATE_ANSWER, quarantinedBotOfAlertItem } from '../outreach/inbox.js';
import { readAuditDetail } from '../outreach/audit.js';
import { inboxDefaultOption, inboxOptions } from '../outreach/inbox-options.js';
import { agreementCardForMessage, agreementPanelForTopic, jobSplitOf, stopLineOf } from './agreement-views.js';
import { isAgreementInboxItem, parseAgreementSubjectKey } from '../project/agreement-confirm.js';
import { AGREEMENT_TOPIC_NOTE, topicNoteTextFor } from '../project/agreement-home.js';
import { agreementForTopic } from '../project/agreements.js';
import { jobProgressForTopic, topicFloorsForTopic } from './job-topic-views.js';
import { jobCardView } from './job-card-views.js';
import { memoryNotesIndex, type MemoryNoteView } from './memory-views.js';
import { escalationCardView, escalationRefOfItem } from './job-escalation-views.js';
import { approvalArgsFull, approvalNotesView, isLaunchApproval, onBehalfOfText } from './approval-card-view.js';
import type { Approval } from '../model/outreach.js';
import { noteJobOf } from '../job/launch-approval.js';
import { jobEntryOf, type JobEntryKind } from '../job/inbox-answer.js';
import { waitedText } from '../job/stall-text.js';
import { isTeamInboxItem, parseTeamSubjectKey } from '../team/cards.js';
import { teamCardViewFor, teamQuestionViewFor } from './team-views.js';
import { skillActivityRows } from './skill-activity.js';
import { input, paginate, requireBot, shortTime } from './common.js';
import type { ActivityRow, ActivityView, ApprovalCardParts, EscalationCardView, InboxView, PageInput, RecentSessionView, SettingsView, ThreadMessageView, ThreadView } from './types.js';

/** 不改写历史日志或票据；旧审批展示时重新解释原参数，避免升级后仍保留只写了诱饵路径的卡片。 */
function approvalCardView(ctx: HubContext, row: InboxItem): InboxItem {
  const approval = row.type === 'approval' && row.refId ? ctx.store.table('approvals').get(row.refId) : null;
  if (!approval || approval.botId !== row.botId || approval.actionTextVersion === 2 || approval.actionTextVersion === 3) return row;
  return { ...row, ...approvalDisplayText(approval, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars) };
}
/** P69：审批卡分段内容；旧记录缺 ownerReason、riskNote 时按「没有」，原始参数截到配置的字数。 */
function approvalParts(ctx: HubContext, row: InboxItem): ApprovalCardParts | undefined {
  const approval = row.type === 'approval' && row.refId ? ctx.store.table('approvals').get(row.refId) : null;
  if (!approval || approval.botId !== row.botId) return undefined;
  // P74g：费用、能否撤回、批准之后三行（缺的写「未说明」），以及属于一件事的审批写「由某某执行」。
  const job = noteJobOf(ctx, approval.id);
  const executor = job === null ? null : ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
  const launch = isLaunchApproval(job, approval);
  return { actionText: approvalActionText(approval, ctx.settings.c03.actionCommandMaxChars), ownerReason: approval.ownerReason ?? null,
    riskNote: approval.riskNote ?? null, argsPreview: ownerParameterPreview(approval.argsPreview, ctx.settings.c03.approvalOwnerParamsMaxChars),
    // P74r9 第 3 节：发布审批给三行（缺的写「未说明」）；别的审批只在员工写了至少一行时给，一行都没写为 null。
    notes: approvalNotesView(approval.actionClass, ctx.store.table('approvalNotes').get(approval.id), launch),
    onBehalfOf: executor === null ? null : onBehalfOfText(executor),
    // P74r4b：这张审批是不是某件事发布这一步的审批（总管私聊里的审批卡与「待你处理」里这一条用同一份视图，两处都带）。
    launch,
    // P74r4b-m1：中心作废的审批为真（界面写「已作废」）；主人拒绝、到期没人处理、已使用的为假。
    voided: approval.voided === true,
    // P74r20 补做：命令全文（只给主人看的审批卡；唤醒包、活动流、日志不带）。拿不到全文时不带这一项。
    ...argsFullField(ctx, approval) };
}
/** 审批卡的命令全文字段：出站记录里的负载（没被截断）优先，其次是没被截断的审批记录；都没有就不带。 */
function argsFullField(ctx: HubContext, approval: Approval): { argsFull?: string } {
  const outbox = ctx.store.table('outbox').list(row => row.approvalId === approval.id)[0] ?? null;
  const full = approvalArgsFull(approval, outbox);
  return full === undefined ? {} : { argsFull: full };
}
/** P74g：属于一件事的审批，显示名和颜色用总管的（审批卡落在总管私聊，「待你处理」里归在总管名下）；其余返回 null。 */
function approvalSender(ctx: HubContext, row: InboxItem): { id: string; name: string; color: string } | null {
  if (row.type !== 'approval' || !row.refId) return null;
  const chief = noteJobOf(ctx, row.refId)?.chiefId;
  const bot = chief === undefined ? null : ctx.store.table('bots').get(chief);
  return bot === null || bot === undefined ? null : { id: bot.id, name: bot.name, color: bot.color };
}
/** 只给确有目标关联的验收题加身份，不靠标题或正文猜业务类型。 */
function goalCheckId(ctx: HubContext, item: InboxItem): string | null {
  const goal = item.type === 'question' && item.refId && item.subjectKey === `goal_check:${item.refId}`
    ? ctx.store.table('goals').get(item.refId) : null;
  return goal?.botId === item.botId ? goal.id : null;
}

/** 线程消息关联实际收件箱状态，历史卡片在主人处理后立即显示真实答案。 */
function messageView(ctx: HubContext, row: ThreadMessage, notes: Map<string, MemoryNoteView[]>): ThreadMessageView {
  const sender = ctx.store.table('bots').get(row.from);
  // 只有卡片消息的精确收件箱 id 才能绑定，交账/审批关联 id 不能反查并复制卡片。
  const referenced = row.refId && ['question', 'approval', 'proposal', 'alert'].includes(row.kind) && row.from !== 'owner'
    ? ctx.store.table('inbox').get(row.refId) : null;
  const visible = referenced?.status === 'closed' && referenced.answer === 'idea_pool' ? null : referenced;
  const inbox = visible ? approvalCardView(ctx, visible) : null;
  // P72h H5：主题开头那条中心旁白写着「约定确认前不会开工」，约定固定或撤下后这句话就不对了，
  // 视图里按约定当前状态换成对应文字（存储里的原文不改）。
  const noteState = row.from === 'hub' && row.kind === 'system' && row.text === AGREEMENT_TOPIC_NOTE
    ? agreementForTopic(ctx, row.thread)?.state ?? null : undefined;
  const noteText = noteState === undefined ? null : topicNoteTextFor(noteState === 'pending' || noteState === 'locked' ? noteState : null);
  // P48：队友被删除后历史消息仍可读；查不到发送者时只显示「已删除的员工」，不暴露内部 id。
  // P74g：属于一件事的审批卡，发送者显示为总管（卡片落在总管私聊）。
  const onChief = row.from === 'hub' && row.kind === 'approval' && inbox !== null ? approvalSender(ctx, inbox) : null;
  return { id: row.id, thread: row.thread, from: row.from, fromName: row.from === 'owner' ? '主人' : row.from === 'hub' ? onChief?.name ?? 'Agent 中心' : sender?.name ?? '已删除的员工',
    fromColor: onChief?.color ?? sender?.color ?? null, kind: row.kind, text: row.kind === 'approval' && inbox?.type === 'approval' ? inbox.body : noteText ?? row.text, createdAt: row.createdAt,
    timeText: shortTime(ctx, row.createdAt)!, createdText: shortTime(ctx, row.createdAt)!,
    card: inbox ? { inboxId: inbox.id, approvalId: inbox.type === 'approval' ? inbox.refId : null, goalId: goalCheckId(ctx, inbox),
      type: inbox.type, status: inbox.status, title: inbox.title, body: inbox.body,
      options: inboxOptions(inbox), defaultOption: inboxDefaultOption(inbox), answer: inbox.answer, expiresAt: inbox.expiresAt, expiresText: shortTime(ctx, inbox.expiresAt),
      ...(approvalParts(ctx, inbox) ? { approval: approvalParts(ctx, inbox)! } : {}),
      // P75i：教它技能的选会话提问卡带学习记录编号（事项键 learn:<记录编号>）。
      ...(inbox.type === 'question' && inbox.subjectKey.startsWith('learn:') ? { learnRunId: inbox.subjectKey.split(':')[1]! } : {}) } : null,
    // P72c：约定卡带专用视图；找不到对应约定或版本时为 null，界面退回显示 text。其他类别不带这个字段。
    ...(row.kind === 'agreement' ? { agreement: agreementCardForMessage(ctx, row.refId, row.id) } : {}),
    // P73c：三问和组队卡带专用视图；找不到对应记录时为 null，界面退回显示 text。
    ...(row.kind === 'team_question' ? { teamQuestion: teamQuestionViewFor(ctx, row.refId, row.id) } : {}),
    ...(row.kind === 'team' ? { teamCard: row.refId === null ? null : teamCardViewFor(ctx, row.refId) } : {}),
    // P74d：交回卡、核对卡带专用视图；找不到对应记录时为 null，界面退回显示 text。
    ...(row.kind === 'job_card' ? { jobCard: jobCardView(ctx, row.refId) } : {}),
    // P75c：挂在这条消息下面的「已记住」；没有时不出现这个字段。
    ...(notes.has(row.id) ? { memoryNotes: notes.get(row.id)! } : {}) };
}
/** 「已等 {时长}」从开着满多久才显示。 */
const WAITED_TEXT_FROM_MS = 60 * 60 * 1000;
/** 查询最新一页后按阅读顺序从旧到新返回，oldestId 可直接用于向上翻页。 */
export function threadView(ctx: HubContext, threadId: string, page?: PageInput): ThreadView {
  threadId = input(nonempty, threadId, 'threadId');
  // P48：队友被删除后线程标题不再抛错，改用「已删除的员工」，历史仍可翻看。
  // P63：主题线程的标题就是主题名。
  const title = threadId === 'team' ? '团队'
    : ctx.store.table('projectTopics').get(threadId)?.title ?? ctx.store.table('bots').get(threadId)?.name ?? '已删除的员工';
  const all = threadMessages(ctx, threadId).reverse();
  const result = paginate(all, page, row => row.createdAt);
  const rows = result.rows.reverse();
  // P72c：主题线程且该主题有约定时，带上约定面板（界面画在主题第一层）。
  const isTopic = ctx.store.table('projectTopics').get(threadId) !== null;
  const agreement = isTopic ? agreementPanelForTopic(ctx, threadId) : null;
  const notes = memoryNotesIndex(ctx);
  return { threadId, title, messages: rows.map(row => messageView(ctx, row, notes)), hasMore: result.hasMore, oldestId: rows[0]?.id ?? null,
    ...(agreement ? { agreement } : {}),
    // P74a：主题线程带进度行和楼层（工作往来折叠）；floors 按这个主题的全部消息算，不受分页影响。
    ...(isTopic ? { progress: jobProgressForTopic(ctx, threadId), floors: topicFloorsForTopic(ctx, threadId, threadMessages(ctx, threadId), notes) } : {}) };
}
/** 收件箱只返回未处理项，紧急度优先，同级按最早创建先处理。 */
export function inboxView(ctx: HubContext): InboxView {
  return { items: ctx.store.table('inbox').list(row => row.status === 'open')
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.createdAt - b.createdAt).map(stored => {
      const row = approvalCardView(ctx, stored);
      // P74g：属于一件事的审批，归在总管名下（显示名、颜色、botId 都用总管的）；存储里的 botId 仍是申请的员工。
      const onChief = approvalSender(ctx, row);
      const bot = onChief !== null ? ctx.store.table('bots').get(onChief.id) : row.botId ? ctx.store.table('bots').get(row.botId) : null;
      // P65：来自项目主题的事项带上主题，界面写「来自主题：……」，「查看对话」直接进主题；主题已删除时不带。
      const topic = row.topicId ? ctx.store.table('projectTopics').get(row.topicId) : null;
      return { id: row.id, botId: onChief?.id ?? row.botId, botName: bot?.name ?? null, botColor: bot?.color ?? null,
        topicId: topic?.id ?? null, topicTitle: topic?.title ?? null,
        approvalId: row.type === 'approval' ? row.refId : null,
        goalId: goalCheckId(ctx, row),
        ...(approvalParts(ctx, row) ? { approval: approvalParts(ctx, row)! } : {}),
        type: row.type, typeLabel: INBOX_TYPE_LABELS[row.type], priority: row.priority, title: row.title, body: row.body,
        options: inboxOptions(row), defaultOption: inboxDefaultOption(row), createdAt: row.createdAt, createdText: shortTime(ctx, row.createdAt)!,
        expiresAt: row.expiresAt, expiresText: shortTime(ctx, row.expiresAt),
        ...agreementInboxFields(ctx, row), ...teamInboxFields(row), ...learnInboxFields(row), ...escalationInboxFields(ctx, row),
        // P76g：开着满 1 小时的条目带「已等 {时长}」；不满 1 小时不带这个字段。
        ...waitedFields(ctx, row),
        // P74r4b：一件事的四类条目（验收、三轮不过、回合上限、停住了）带 jobEntry；其余条目不带这个字段。
        ...jobEntryFields(row),
        // P74r16b：员工被中心停用的告警条目带恢复入口（员工此刻仍被中心停用时才有）。
        ...reinstateFields(ctx, row) };
    }) };
}
/** P76g：条目开着满 1 小时才有的「已等 {时长}」（「待你处理」里这一条等了多久）。 */
function waitedFields(ctx: HubContext, row: InboxItem): { waitedText?: string } {
  const waited = ctx.clock.now() - row.createdAt;
  return waited >= WAITED_TEXT_FROM_MS ? { waitedText: `已等 ${waitedText(waited)}` } : {};
}
/** P74r16b：「员工被中心停用」告警条目的恢复入口；其余条目、员工已在岗时返回空对象。 */
function reinstateFields(ctx: HubContext, row: InboxItem): { reinstate?: { botId: string; botName: string; answer: 'reinstate' } } {
  const bot = quarantinedBotOfAlertItem(ctx, row);
  return bot === null ? {} : { reinstate: { botId: bot.id, botName: bot.name, answer: ALERT_REINSTATE_ANSWER } };
}
/** P74r4b：按事项键判断（与 answerJobInbox 分流同一套判断）；不是一件事的条目返回空对象。 */
function jobEntryFields(row: InboxItem): { jobEntry?: { kind: JobEntryKind; jobId: string } } {
  const entry = jobEntryOf(row);
  return entry === null ? {} : { jobEntry: entry };
}
/** P74r4a：说明条目带这张卡的完整视图（与总管私聊里那张卡同一份数据）；普通事项不带。 */
function escalationInboxFields(ctx: HubContext, row: InboxItem): { escalationCard?: EscalationCardView | null } {
  const ref = escalationRefOfItem(row);
  return ref === null ? {} : { escalationCard: escalationCardView(ctx, ref) };
}
/** P73c：组队卡确认条目带组队卡 id（界面据此渲染「不会自动入职」并隐藏自由文本）；普通事项不带。 */
function teamInboxFields(row: InboxItem): { teamProposalId?: string } {
  const id = isTeamInboxItem(row) ? parseTeamSubjectKey(row.subjectKey) : null;
  return id === null ? {} : { teamProposalId: id };
}
/**
 * P75r7（A2）：教它技能的选会话提问条目（事项键 learn:<记录编号>）带学习记录编号，
 * 取法与线程卡片相同（取事项键的第二段）；不是学习条目时不带这个键，界面据此把条目画成学习卡。
 */
function learnInboxFields(row: InboxItem): { learnRunId?: string } {
  return row.subjectKey.startsWith('learn:') ? { learnRunId: row.subjectKey.split(':')[1]! } : {};
}
/** P72c：约定确认条目带上约定 id 和版本号（界面据此显示约定标识）；普通事项不带。 */
function agreementInboxFields(ctx: HubContext, row: InboxItem): { agreementId?: string; agreementVersion?: number; agreementTitle?: string | null; agreementJobSplit?: boolean; agreementStop?: boolean } {
  const parsed = isAgreementInboxItem(row) ? parseAgreementSubjectKey(row.subjectKey) : null;
  if (!parsed) return {};
  // P74r8：「有事在做」「确认后停止」两个事实由核心给出，界面不再从打开过的对话里推断；
  // 与约定卡视图的 jobSplit、stopLine 同一个来源（jobSplitOf、stopLineOf）。找不到约定或版本时两项都为假。
  const agreement = ctx.store.table('agreements').get(parsed.agreementId);
  const version = agreement?.versions.find(row => row.no === parsed.version);
  return { agreementId: parsed.agreementId, agreementVersion: parsed.version, agreementTitle: agreement?.title ?? null,
    agreementJobSplit: agreement && version ? jobSplitOf(ctx, agreement, version) !== null : false,
    agreementStop: version ? stopLineOf(version) !== null : false };
}
/** 活动流以实际业务对象为来源，不把 protected_files 等内部审计展示为用户活动。 */
export function activityView(ctx: HubContext, page?: PageInput): ActivityView {
  const rows: ActivityRow[] = [];
  /** 每个来源统一补齐机器人姓名、颜色和时间，使页面无需再查名册。 */
  const add = (id: string, at: number, botId: string | null, kind: ActivityRow['kind'], text: string, lines?: string[]) => {
    const bot = botId ? ctx.store.table('bots').get(botId) : null;
    rows.push({ id, at, timeText: shortTime(ctx, at)!, botId, botName: bot?.name ?? null, botColor: bot?.color ?? null, kind, text,
      // P75i：同一组的细项（只有每周整理的记录有）；其余行不带这个字段。
      ...(lines === undefined ? {} : { lines }) });
  };
  // P75i：「技能库」一类记录从 skillRuns、skillUpdates 表和回退、放回的审计生成（api/skill-activity.ts）。
  for (const row of skillActivityRows(ctx)) add(row.id, row.at, row.botId, 'skill', row.text, row.lines);
  for (const row of ctx.store.table('wakes').list()) add(row.id, row.startedAt, row.botId, 'wake', `唤醒：${ownerReasonSummary(row.reason, ctx)}`);
  for (const row of ctx.store.table('commits').list()) add(row.id, row.createdAt, row.botId, 'commit', `${OUTCOME_LABELS[row.outcome]}：${row.summary}`);
  for (const row of ctx.store.table('approvals').list()) add(row.id, row.decidedAt ?? row.createdAt, row.botId, 'approval',
    `${row.status === 'pending' ? '等待审批' : ['approved', 'used'].includes(row.status) ? '已批准' : '未批准'}：${row.why}`);
  for (const row of ctx.store.table('alerts').list()) add(row.id, row.lastAt, row.botId, 'alert', row.text);
  for (const row of ctx.store.table('handoffs').list()) add(row.id, row.updatedAt, row.from, 'handoff', `交接：${row.task}`);
  for (const row of ctx.store.table('mail').list()) add(row.id, row.createdAt, row.from, 'peer', row.text);
  for (const row of ctx.store.log('audit').all().filter(row => row.action === 'lifecycle' || row.action === 'hub_started' || row.action === 'hub_stopped')) {
    const detail = readAuditDetail<{ botId?: string; text?: string; to?: string }>(row.detail);
    add(row.id, row.at, detail?.botId ?? null, row.action === 'lifecycle' ? 'lifecycle' : 'system',
      detail?.text ?? (row.action === 'hub_started' ? '中心已启动' : row.action === 'hub_stopped' ? '中心已停止' : `状态变更：${LIFECYCLE_LABELS[detail?.to as keyof typeof LIFECYCLE_LABELS] ?? '已更新'}`));
  }
  rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  return paginate(rows, page, row => row.at);
}
/** 有目录时只展示宿主可用模型；未提供目录时保留默认模型与名册选择的兼容视图。 */
export async function settingsView(ctx: HubContext): Promise<SettingsView> {
  const catalog = await readModelCatalog(ctx);
  const dshSkillOptions = await readDshSkillOptions(ctx);
  if (catalog !== null) return { settings: structuredClone(ctx.settings), pushChannelOptions: [...PUSH_CHANNELS],
    modelOptions: [{ value: null, label: '跟随宿主默认模型' }, ...catalog.map(({ provider, model, label }) => ({ value: { provider, model }, label }))],
    presetSkillOptions: presetSkillOptions(), dshSkillOptions };
  const choices: ModelChoice[] = [null, ctx.settings.defaultModel, ...ctx.store.table('bots').list().map(row => row.model)];
  const unique = [...new Map(choices.map(value => [JSON.stringify(value), value])).values()];
  return { settings: structuredClone(ctx.settings), pushChannelOptions: [...PUSH_CHANNELS],
    modelOptions: unique.map(value => ({ value, label: value ? `${value.provider} / ${value.model}` : '跟随宿主默认模型' })),
    presetSkillOptions: presetSkillOptions(), dshSkillOptions };
}
/** 教学会话由宿主提供，校验返回值后只展示最小信息，不自行读取会话正文。 */
export async function recentSessions(ctx: HubContext): Promise<RecentSessionView[]> {
  const schema = z.array(z.strictObject({ sessionId: nonempty, title: z.string(), updatedAt: z.number().int() }));
  const rows = input(schema, await ctx.host.listRecentSessions(C04_DEFAULTS.RECENT_SESSION_LIMIT), '最近会话');
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(row => ({ ...row, updatedText: shortTime(ctx, row.updatedAt)! }));
}
