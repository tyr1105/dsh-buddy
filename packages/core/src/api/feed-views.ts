/** 线程、收件箱和活动流统一投影为中文视图；稳定 id 分页保留同毫秒发生的多条事件。 */
import { z } from 'zod';
import { ownerReasonSummary } from '../util/owner-text.js';
import { approvalDisplayText } from '../util/action-text.js';
import type { HubContext } from '../engine/context.js';
import type { InboxItem, ModelChoice, ThreadMessage } from '../model/index.js';
import { INBOX_TYPE_LABELS, LIFECYCLE_LABELS, OUTCOME_LABELS, PUSH_CHANNELS } from '../model/enums.js';
import { nonempty } from '../model/primitives.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { presetSkillOptions } from '../config/preset-skills.js';
import { readDshSkillOptions } from './skills.js';
import { readModelCatalog } from './models.js';
import { threadMessages } from '../outreach/thread.js';
import { readAuditDetail } from '../outreach/audit.js';
import { inboxDefaultOption, inboxOptions } from '../outreach/inbox-options.js';
import { input, paginate, requireBot, shortTime } from './common.js';
import type { ActivityRow, ActivityView, InboxView, PageInput, RecentSessionView, SettingsView, ThreadMessageView, ThreadView } from './types.js';

/** 不改写历史日志或票据；旧审批展示时重新解释原参数，避免升级后仍保留只写了诱饵路径的卡片。 */
function approvalCardView(ctx: HubContext, row: InboxItem): InboxItem {
  const approval = row.type === 'approval' && row.refId ? ctx.store.table('approvals').get(row.refId) : null;
  if (!approval || approval.botId !== row.botId || approval.actionTextVersion === 2) return row;
  return { ...row, ...approvalDisplayText(approval, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars) };
}
/** 只给确有目标关联的验收题加身份，不靠标题或正文猜业务类型。 */
function goalCheckId(ctx: HubContext, item: InboxItem): string | null {
  const goal = item.type === 'question' && item.refId && item.subjectKey === `goal_check:${item.refId}`
    ? ctx.store.table('goals').get(item.refId) : null;
  return goal?.botId === item.botId ? goal.id : null;
}

/** 线程消息关联实际收件箱状态，历史卡片在主人处理后立即显示真实答案。 */
function messageView(ctx: HubContext, row: ThreadMessage): ThreadMessageView {
  const sender = ctx.store.table('bots').get(row.from);
  // 只有卡片消息的精确收件箱 id 才能绑定，交账/审批关联 id 不能反查并复制卡片。
  const referenced = row.refId && ['question', 'approval', 'proposal', 'alert'].includes(row.kind) && row.from !== 'owner'
    ? ctx.store.table('inbox').get(row.refId) : null;
  const visible = referenced?.status === 'closed' && referenced.answer === 'idea_pool' ? null : referenced;
  const inbox = visible ? approvalCardView(ctx, visible) : null;
  // P48：队友被删除后历史消息仍可读；查不到发送者时只显示「已删除的队友」，不暴露内部 id。
  return { id: row.id, thread: row.thread, from: row.from, fromName: row.from === 'owner' ? '主人' : row.from === 'hub' ? 'Agent 中心' : sender?.name ?? '已删除的队友',
    fromColor: sender?.color ?? null, kind: row.kind, text: row.kind === 'approval' && inbox?.type === 'approval' ? inbox.body : row.text, createdAt: row.createdAt,
    timeText: shortTime(ctx, row.createdAt)!, createdText: shortTime(ctx, row.createdAt)!,
    card: inbox ? { inboxId: inbox.id, approvalId: inbox.type === 'approval' ? inbox.refId : null, goalId: goalCheckId(ctx, inbox),
      type: inbox.type, status: inbox.status, title: inbox.title, body: inbox.body,
      options: inboxOptions(inbox), defaultOption: inboxDefaultOption(inbox), answer: inbox.answer, expiresAt: inbox.expiresAt, expiresText: shortTime(ctx, inbox.expiresAt) } : null };
}
/** 查询最新一页后按阅读顺序从旧到新返回，oldestId 可直接用于向上翻页。 */
export function threadView(ctx: HubContext, threadId: string, page?: PageInput): ThreadView {
  threadId = input(nonempty, threadId, 'threadId');
  // P48：队友被删除后线程标题不再抛错，改用「已删除的队友」，历史仍可翻看。
  // P63：主题线程的标题就是主题名。
  const title = threadId === 'team' ? '团队'
    : ctx.store.table('projectTopics').get(threadId)?.title ?? ctx.store.table('bots').get(threadId)?.name ?? '已删除的队友';
  const all = threadMessages(ctx, threadId).reverse();
  const result = paginate(all, page, row => row.createdAt);
  const rows = result.rows.reverse();
  return { threadId, title, messages: rows.map(row => messageView(ctx, row)), hasMore: result.hasMore, oldestId: rows[0]?.id ?? null };
}
/** 收件箱只返回未处理项，紧急度优先，同级按最早创建先处理。 */
export function inboxView(ctx: HubContext): InboxView {
  return { items: ctx.store.table('inbox').list(row => row.status === 'open')
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.createdAt - b.createdAt).map(stored => {
      const row = approvalCardView(ctx, stored);
      const bot = row.botId ? ctx.store.table('bots').get(row.botId) : null;
      // P65：来自项目主题的事项带上主题，界面写「来自主题：……」，「查看对话」直接进主题；主题已删除时不带。
      const topic = row.topicId ? ctx.store.table('projectTopics').get(row.topicId) : null;
      return { id: row.id, botId: row.botId, botName: bot?.name ?? null, botColor: bot?.color ?? null,
        topicId: topic?.id ?? null, topicTitle: topic?.title ?? null,
        approvalId: row.type === 'approval' ? row.refId : null,
        goalId: goalCheckId(ctx, row),
        type: row.type, typeLabel: INBOX_TYPE_LABELS[row.type], priority: row.priority, title: row.title, body: row.body,
        options: inboxOptions(row), defaultOption: inboxDefaultOption(row), createdAt: row.createdAt, createdText: shortTime(ctx, row.createdAt)!,
        expiresAt: row.expiresAt, expiresText: shortTime(ctx, row.expiresAt) };
    }) };
}
/** 活动流以实际业务对象为来源，不把 protected_files 等内部审计展示为用户活动。 */
export function activityView(ctx: HubContext, page?: PageInput): ActivityView {
  const rows: ActivityRow[] = [];
  /** 每个来源统一补齐机器人姓名、颜色和时间，使页面无需再查名册。 */
  const add = (id: string, at: number, botId: string | null, kind: ActivityRow['kind'], text: string) => {
    const bot = botId ? ctx.store.table('bots').get(botId) : null;
    rows.push({ id, at, timeText: shortTime(ctx, at)!, botId, botName: bot?.name ?? null, botColor: bot?.color ?? null, kind, text });
  };
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
