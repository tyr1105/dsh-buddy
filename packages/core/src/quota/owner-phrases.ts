/**
 * 总管私聊里的两种整句口令（P76d，方案 7.1，设计稿场景 E）：「我接下来 N 小时要用」（你自己要用）和「用我的额度」。
 *
 * 为什么由中心认领、不叫醒总管：这两句话的意思固定，处理的是中心自己的额度安排（员工多久不开新回合、
 * 哪件事用你留出的额度），不需要总管出一个回合去理解；认领之后话照常落在对话里，中心以总管的名义回一句，不入队叫醒总管
 * （照「撤销」口令的写法：落楼后不入队）。
 *
 * 只在主人发给总管私聊的消息上认：主题、员工私聊、DSH 会话里的直聊都不认。
 * 规范化沿用 normalizeConfirmText（全角转半角、转小写、去掉空白与标点），所以「 我接下来两小时要用，」「我接下来2小时要用DSH。」都认。
 * 整句才认：多一个字（「我接下来可能要用」「我接下来 6 小时要用」）都按普通消息处理，由总管自己判断。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { ThreadMessage } from '../model/outreach.js';
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import { jobTitleOf } from '../job/chain.js';
import { normalizeConfirmText } from '../project/agreement-confirm.js';
import { postThread } from '../outreach/thread.js';
import { quotaClockText } from './clock-text.js';
import { getQuotaPlan, redKindOf, savePlan } from './plan.js';
import { getQuotaState } from './window.js';

/** 「用我的额度」要在这样的消息之后说才生效：中心在总管私聊里落的「会误交付时间」提示，消息的 refId 以它开头。 */
export const DUE_RISK_REF_PREFIX = 'duerisk:';
/** refId 里 jobId 列表的分隔符：`duerisk:<jobId>,<jobId>`。P76h 落提示时照这个写。 */
export const DUE_RISK_REF_SEPARATOR = ',';

const HOLD_PATTERN = /^我接下来(\d|一|两|二|三|四|五)个?小时要用(dsh)?$/;
const HOURS_BY_CHAR: Readonly<Record<string, number>> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
const CANCEL_TEXT = '不用留了';
const BORROW_TEXT = '用我的额度';

/** 总管私聊：目标线程是一位总管员工自己的线程。 */
function isChiefThread(ctx: HubContext, threadId: string): boolean {
  return ctx.store.table('bots').get(threadId)?.role === 'chief';
}

/** 以总管的名义落一句话（不叫醒任何人）。 */
function chiefSays(ctx: HubContext, chiefId: string, text: string): void {
  postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', text });
}

/** 额度状态变化让界面刷新：总览，以及读着额度说明的进度行（项目页与主题）。 */
function refreshViews(ctx: HubContext): void {
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 最近一条「会误交付时间」的提示里的事（jobId 列表）；不在 BORROW_REPLY_WINDOW_MS 内或没有这样的提示返回空数组。 */
function dueRiskJobIds(ctx: HubContext, chiefId: string, now: number): string[] {
  const hint = ctx.store.log('thread').recent(Number.MAX_SAFE_INTEGER,
    row => row.thread === chiefId && row.from !== 'owner' && row.refId !== null && row.refId.startsWith(DUE_RISK_REF_PREFIX))[0];
  if (!hint || now - hint.createdAt > BUDGET_DEFAULTS.BORROW_REPLY_WINDOW_MS) return [];
  return hint.refId!.slice(DUE_RISK_REF_PREFIX.length).split(DUE_RISK_REF_SEPARATOR).filter(id => id !== '');
}

/**
 * 认领成功返回 true（话已处理，调用方不再叫醒总管）；不认领返回 false（照原流程当普通消息，叫醒总管）。
 * 自己兜底所有异常：出错时不认领，让这句话照常叫醒总管，不丢主人的话。
 */
export function claimQuotaPhrase(ctx: HubContext, threadId: string, message: ThreadMessage): boolean {
  try {
    if (!isChiefThread(ctx, threadId)) return false;
    const normalized = normalizeConfirmText(message.text);
    const now = ctx.clock.now();

    // 「我接下来 N 小时要用」：N 为 1 到 5（超过 5 不认领，由总管自己判断要不要答应这么久）。
    const hold = HOLD_PATTERN.exec(normalized);
    if (hold) {
      const hours = /^\d$/.test(hold[1]!) ? Number(hold[1]) : HOURS_BY_CHAR[hold[1]!]!;
      if (hours < 1 || hours > BUDGET_DEFAULTS.OWNER_HOLD_MAX_HOURS) return false;
      const until = now + hours * 3_600_000;
      savePlan(ctx, { ...getQuotaPlan(ctx, now), ownerHoldUntil: until, updatedAt: now });
      chiefSays(ctx, threadId, `好的，员工在 ${quotaClockText(until, now, ctx.settings.timezone)} 前不开新回合，正在做的回合做完为止。`);
      refreshViews(ctx);
      return true;
    }

    // 「不用留了」：只在你自己要用的时段内取消；时段外（没设过、已到点）是普通消息。
    if (normalized === CANCEL_TEXT) {
      const plan = getQuotaPlan(ctx, now);
      if (plan.ownerHoldUntil === null || plan.ownerHoldUntil <= now) return false;
      savePlan(ctx, { ...plan, ownerHoldUntil: null, updatedAt: now });
      chiefSays(ctx, threadId, '已取消，员工照常开工。');
      refreshViews(ctx);
      return true;
    }

    // 「用我的额度」：只在「会误交付时间」的提示之后 24 小时内、且当前红灯是员工份额用完时生效。
    if (normalized === BORROW_TEXT) {
      const quota = getQuotaState(ctx, now);
      const plan = getQuotaPlan(ctx, now);
      if (redKindOf(plan, quota, ctx.settings) !== 'staff_full') return false;
      const jobs = dueRiskJobIds(ctx, threadId, now).map(id => ctx.store.table('jobs').get(id)).filter(job => job !== null);
      if (jobs.length === 0) return false;
      savePlan(ctx, { ...plan, borrowJobIds: [...new Set([...plan.borrowJobIds, ...jobs.map(job => job.id)])], updatedAt: now });
      chiefSays(ctx, threadId, `好的，${jobs.map(job => jobTitleOf(ctx, job)).join('、')}现在用你留出的额度接着做，本窗口结束前有效。`);
      refreshViews(ctx);
      return true;
    }
    return false;
  } catch (error) {
    try { ctx.logger.error('额度口令处理失败，按普通消息处理', error); } catch { /* 日志出错也不能抛出去。 */ }
    return false;
  }
}
