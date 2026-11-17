/**
 * 预计消耗：问一次（P76f，方案 7.5）。「将超出预计」与原来的「回合用到上限」合成同一个条目、同一个函数。
 *
 * 为什么合并：主人面前同一件事只有一个入口。原来只在回合用完时才问，用完那一刻这件事已经停下；
 * 现在每个执行链回合结束时按记录算「已用加余下」，大于预算线就先问一次（这件事不停，预计之内的部分照常在做），
 * 真用到预算线时才停下——之前问过的不再建条目，只停下并告诉主人。
 *
 * 唯一建这类条目的函数是 askBudget；两种原因：
 * - projected：已用加余下大于预算线。条件：有预计、这件事没有别的开着的条目、这个预算线没问过、你没选过「暂停」、
 *   没有在等「缩小范围」的新版本。动作分两段：先建条目（会出错的一步），成功后记「问过」和条目编号，最后总管私聊落一句；
 *   这件事的状态和队列都不动。
 * - reached：回合用到预算线（job/cap.ts 的 blockForTurnCap 判断完前置条件后调用）。问过的不再建条目；
 *   你选过「暂停」的转「你已暂停」；没问过的建条目再停下。
 *
 * 触发的地方：回合收尾（job/continue.ts）、每个 tick 的巡检（job/sweep.ts）、闸门丢弃一次 job_cap 之后、交回或核对没能叫醒下一个人时，
 * 都经这里，靠 jobNotices.budgetAskedCaps 和事项键 job:<id>:cap:<预算线> 去重。
 * 没有预计的旧事不走这里（blockForTurnCap 沿用原来的文字和选项）；发布环节有自己的回合上限，不问。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { Job } from '../model/job.js';
import { createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { removeEntry } from '../scheduler/queue.js';
import { jobTitleOf } from './chain.js';
import { budgetOptions, capSubjectKey } from './block-options.js';
import { openBlockItems, withdrawBlockItems } from './block-items.js';
import { overrunReasons, projectJob, usedTurnsOf, type BudgetProjection } from './budget.js';
import { budgetBody, budgetTitle, projectedChatText, reachedChatText, topUpTokens, type BudgetAskReason } from './budget-text.js';
import { latestEstimate } from './estimate.js';
import { patchNotice, noticeOf } from './notices.js';
import { hasAnyOpenJobItem } from './owner-ask.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, isJobClosed, putJob } from './store.js';
import { holdForOwner } from './unblock.js';
import { usageRowOf } from './usage.js';
import { waitingReasonOf } from './wait-text.js';

/** askBudget 的可选参数。 */
export interface AskBudgetOptions {
  /** 交回、提交核对结论因预算线没有叫醒下一个人时：现在卡在什么（等谁做什么），写进条目正文的「目前停在」。 */
  stuckText?: string;
  /** 小修：停在预算线上却没有条目、没有等确认的新版本时，重新建一条（上一次的选择没有做成）；不看「问过」「暂停」「缩小范围」记号。 */
  reissue?: boolean;
}

/**
 * 已用加余下的算法视图：projected 原因直接取 projectJob；reached 原因在这件事处于不算余下的状态（受阻等）时，
 * 余下按 0 算，并保证预计总数至少比预算线多 1（用到预算线了，说明预计不够）。
 */
function viewFor(ctx: HubContext, job: Job, reason: BudgetAskReason): { view: BudgetProjection; align: number; total: number } | null {
  const estimate = latestEstimate(ctx, job.agreementId);
  if (estimate === null) return null;
  const usage = ctx.store.table('jobUsage').get(job.id) ?? usageRowOf(ctx, job, ctx.clock.now());
  const projected = projectJob(job, usage, estimate);
  const align = usage.steps.align.turns;
  if (reason === 'projected') return projected === null ? null : { view: projected, align, total: estimate.total };
  const used = usedTurnsOf(usage);
  const base: BudgetProjection = projected ?? { used, remaining: 0, projected: used, cap: job.turnCap, reasons: overrunReasons(usage, estimate, job) };
  return { view: { ...base, projected: Math.max(base.projected, 1 + job.turnCap) }, align, total: estimate.total };
}

/** 停下这件事并清队列：写状态、记 turn_cap 事件、清掉队列里这件事的全部候选（含别的员工的）、总管私聊落一句。 */
export function stopAtCap(ctx: HubContext, job: Job, next: Job, itemId: string | null, chatText: string | null): void {
  const now = ctx.clock.now();
  // 建条目时「打扰你」已在记录上加一（createInboxItem）：取最新的计数，不能被建条目之前读到的旧记录盖掉。
  putJob(ctx, { ...next, disturbCount: ctx.store.table('jobs').get(job.id)?.disturbCount ?? next.disturbCount ?? 0, updatedAt: now });
  appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'turn_cap', to: [job.chiefId], refId: itemId,
    data: { used: job.turnsUsed, cap: job.turnCap } });
  for (const entry of ctx.store.table('queue').list(row => row.jobId === job.id)) removeEntry(ctx, entry.id);
  if (chatText !== null) {
    try {
      postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: chatText });
    } catch (error) {
      ctx.logger.warn('预算线的私聊提示没有落下', { jobId: job.id, error: String(error) });
    }
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.inbox, job.chiefId);
}

/**
 * 问一次。返回是否真的做了（建了条目、或停下了）。
 * 没有预计的旧事、不在会算余下的状态、条件不满足，一律返回 false，什么都不改。
 */
export function askBudget(ctx: HubContext, jobId: string, reason: BudgetAskReason, options: AskBudgetOptions = {}): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null || isJobClosed(job)) return false;
  const viewed = viewFor(ctx, job, reason);
  if (viewed === null) return false;
  return reason === 'projected' ? askProjected(ctx, job, viewed) : askReached(ctx, job, viewed, options);
}

/** 条目正文要用的数与文字。 */
function bodyOf(ctx: HubContext, job: Job, viewed: NonNullable<ReturnType<typeof viewFor>>, reason: BudgetAskReason, stuckLine: string): { title: string; body: string; n: number } {
  const { view, align, total } = viewed;
  const n = Math.max(D.TOP_UP_MIN, view.projected - view.cap);
  const tokens = topUpTokens(ctx, job.agreementId, n);
  const title = jobTitleOf(ctx, job);
  const body = budgetBody({ reason, usedAll: align + view.used, total, needAll: align + view.projected, reasons: view.reasons,
    n, tokenLow: tokens.low, tokenHigh: tokens.high, stuckLine });
  return { title: budgetTitle(title, reason), body, n };
}

/**
 * 记下这一个预算线问过了。
 * 与方案不同的一点（见 docs/questions.md P76f）：这件事没有停，所以不把条目编号（Job.inboxId）记在这件事上——
 * 编号不为空表示「这件事在等主人，中心不再叫总管」（job/chain.ts 的 expectedActorOf、job/stall.ts），
 * 这件事继续做的过程中若做不下去或核对三轮不过，总管必须仍然能被叫醒。到预算线停下时再记编号（stopAtCap 的调用方）。
 */
function recordAsked(ctx: HubContext, job: Job): void {
  const notice = noticeOf(ctx, job.id);
  patchNotice(ctx, job.id, { budgetAskedCaps: [...new Set([...notice.budgetAskedCaps, job.turnCap])] });
}

/** 这个预算线的条目：开着的优先，其次已答复的；只剩被撤回的（别的条目建立时撤掉了）算没有。 */
function capItemOf(ctx: HubContext, job: Job): { id: string; status: string } | null {
  const rows = ctx.store.table('inbox').list(row => row.subjectKey === capSubjectKey(job.id, job.turnCap) && row.status !== 'withdrawn');
  return rows.find(row => row.status === 'open') ?? rows[0] ?? null;
}

/** projected：已用加余下大于预算线，问一次，这件事不停。 */
function askProjected(ctx: HubContext, job: Job, viewed: NonNullable<ReturnType<typeof viewFor>>): boolean {
  const { view, align, total } = viewed;
  if (view.projected <= view.cap) return false;
  const notice = noticeOf(ctx, job.id);
  // 问过这个预算线、你选了暂停（用到预算线时转「你已暂停」）、在等「缩小范围」的新版本（总管那一回合是专门给的）：都不再问。
  if (notice.budgetAskedCaps.includes(view.cap) || notice.holdAtCap || notice.narrowRequestedAt !== null) return false;
  if (hasAnyOpenJobItem(ctx, job.id)) return false;
  const { title, body, n } = bodyOf(ctx, job, viewed, 'projected', '');
  // 先做会出错的一步（建主人要处理的条目），成功之后才记「问过」：出错时什么都没记，下一次再试。
  createInboxItem(ctx, {
    botId: job.chiefId, type: 'question', title, body, options: [...budgetOptions(n)], defaultOption: null, expiresAt: null,
    priority: 'P1', refId: job.id, subjectKey: capSubjectKey(job.id, view.cap),
  });
  recordAsked(ctx, job);
  try {
    postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id,
      text: projectedChatText(jobTitleOf(ctx, job), align + view.projected, total) });
  } catch (error) {
    ctx.logger.warn('预计将超出的私聊提示没有落下', { jobId: job.id, error: String(error) });
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.inbox, job.chiefId);
  return true;
}

/** reached：回合用到预算线（前置条件已由 blockForTurnCap 判断过）。 */
function askReached(ctx: HubContext, job: Job, viewed: NonNullable<ReturnType<typeof viewFor>>, options: AskBudgetOptions): boolean {
  const { total } = viewed;
  const now = ctx.clock.now();
  const title = jobTitleOf(ctx, job);
  const notice = noticeOf(ctx, job.id);
  // 小修：已经停在预算线、没有条目也没有等确认的新版本：重新建一条（事项键同一格式，用现在的预算线），不看各种记号。
  if (options.reissue === true) {
    const { title: itemTitle, body, n } = bodyOf(ctx, job, viewed, 'reached', '');
    const item = createInboxItem(ctx, {
      botId: job.chiefId, type: 'question', title: itemTitle, body, options: [...budgetOptions(n)], defaultOption: null, expiresAt: null,
      priority: 'P1', refId: job.id, subjectKey: capSubjectKey(job.id, job.turnCap),
    });
    patchNotice(ctx, job.id, { budgetAskedCaps: [...new Set([...notice.budgetAskedCaps, job.turnCap])] });
    // P76r3（R10 第 5 点）：「仍停在」只在之前确实告诉过主人「已停下」时才用。缩小范围这条路径停下时不落私聊，
    // 这时用到达预算线时的那一句，不说「仍」。之前问过这个预算线（还有条目可答复）才说明「已停下」说过。
    const chat = notice.budgetAskedCaps.includes(job.turnCap)
      ? `${title}仍停在预计的 ${total} 回合上，在等你决定。`
      : reachedChatText(title, total, 'unasked');
    stopAtCap(ctx, job, { ...job, inboxId: item.id }, item.id, chat);
    return true;
  }
  // 已经因为别的原因受阻（执行者做不下去、核对三轮不过、有人停用）的事：状态和受阻原因保持不变，只补条目和私聊。
  const waiting = job.state === 'blocked' && job.blocked !== null && job.blocked.kind !== 'turn_cap' && job.blocked.kind !== 'owner_hold';
  // 你选过「暂停」：到预算线转「你已暂停」，不建条目。
  // P76r3（R12）：同时撤回这件事其余开着的通知类条目（做法与其余受阻路径一致），否则它们失去编号指向、一直开着。
  if (notice.holdAtCap) {
    patchNotice(ctx, job.id, { holdAtCap: false });
    const others = openBlockItems(ctx, job.id);
    stopAtCap(ctx, job, holdForOwner(job, now), null, reachedChatText(title, total, 'held'));
    withdrawBlockItems(ctx, others, now, '这件事已按你的选择暂停');
    return true;
  }
  // 有预计的事统一写「已用到预计消耗」（P76r3，R10 第 2 点：旧叫法「回合用到上限」只留给没有预计的旧事）。
  const next = waiting ? job : applyJobAction(job, { type: 'block', kind: 'turn_cap', no: null, text: '已用到预计消耗' }, now);
  // 你选了「缩小范围」、总管的新版本还在等你确认：这件事停下等新版本，不再另建条目（主人面前已有那张确认卡）。
  if (notice.narrowRequestedAt !== null && !notice.budgetAskedCaps.includes(job.turnCap)) {
    stopAtCap(ctx, job, next, null, null);
    return true;
  }
  // 问过这个预算线的（条目开着或已答复）：不建条目，只停下并告诉你；条目还开着的，把编号记在这件事上（受阻的事的条目编号指向它）。
  // 问过但条目已被别的条目顶替撤回的（只剩撤回的），当作没问过，下面重新建一条：否则停下之后主人没有地方答复。
  const existing = notice.budgetAskedCaps.includes(job.turnCap) ? capItemOf(ctx, job) : null;
  if (existing !== null) {
    stopAtCap(ctx, job, { ...next, inboxId: existing.status === 'open' ? existing.id : next.inboxId }, existing.status === 'open' ? existing.id : null,
      reachedChatText(title, total, 'asked'));
    return true;
  }
  // 没问过：建条目再停下。「目前停在」按事实写：交回、核对没能叫醒下一个人时由那个动作写明，优先于受阻原因。
  const real = waitingReasonOf(ctx, job, { ignoreBlockText: !waiting });
  const stuckSource = options.stuckText ?? (real === null ? '' : real.startsWith('约定第') ? `${real}。` : real);
  const { title: itemTitle, body, n } = bodyOf(ctx, job, viewed, 'reached', stuckSource.trim() !== '' ? `目前停在：${stuckSource}` : '');
  const item = createInboxItem(ctx, {
    botId: job.chiefId, type: 'question', title: itemTitle, body, options: [...budgetOptions(n)], defaultOption: null, expiresAt: null,
    priority: 'P1', refId: job.id, subjectKey: capSubjectKey(job.id, job.turnCap),
  });
  patchNotice(ctx, job.id, { budgetAskedCaps: [...new Set([...notice.budgetAskedCaps, job.turnCap])] });
  stopAtCap(ctx, job, { ...next, inboxId: item.id }, item.id, reachedChatText(title, total, 'unasked'));
  return true;
}

/**
 * 小修（不变量）：一件事因预算线受阻时，必有一条开着的条目、或一版约定在等你确认、或你已选暂停。巡检里调用。
 * 不满足（总管撤销了缩小范围的新版本、你退回了它、总管拟改动的回合结束却没有提交新版本）时，清掉 narrowRequestedAt 并重新建条目。
 * 总管拟改动的回合还在排队或在跑时不动。返回是否重建了条目。
 */
export function repairCapStop(ctx: HubContext, jobId: string): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null || job.state !== 'blocked' || job.blocked?.kind !== 'turn_cap') return false;
  if (hasAnyOpenJobItem(ctx, job.id)) return false;
  if (ctx.store.table('agreements').get(job.agreementId)?.state === 'pending') return false;
  const notice = noticeOf(ctx, job.id);
  if (notice.narrowRequestedAt !== null) {
    const chiefBusy = ctx.store.table('queue').count(row => row.jobId === job.id && row.botId === job.chiefId) > 0
      || ctx.store.table('wakes').count(wake => wake.jobId === job.id && wake.botId === job.chiefId && wake.endedAt === null
        && ['delivering', 'running', 'committed'].includes(wake.status)) > 0;
    if (chiefBusy) return false;
    patchNotice(ctx, job.id, { narrowRequestedAt: null });
  }
  return askBudget(ctx, job.id, 'reached', { reissue: true });
}

/**
 * 回合结束或巡检时看一眼：已用加余下大于预算线就问一次（这件事不停）。只做 askBudget 'projected' 的条件判断；出错只记日志。
 */
export function checkBudget(ctx: HubContext, jobId: string): void {
  try {
    askBudget(ctx, jobId, 'projected');
  } catch (error) {
    try { ctx.logger.warn('预计消耗的检查失败', { jobId, error: String(error) }); } catch { /* 日志出错也不能挡住回合收尾。 */ }
  }
}
