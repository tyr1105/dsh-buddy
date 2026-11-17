/**
 * 主人答复预计消耗条目（事项键 job:<id>:cap:<预算线>）之后，这件事怎样继续（P76f，方案 7.5「答复」）。
 *
 * 三个办法（新条目）：
 * - 「追加 n 个回合」：预算线加 n，预计追加一项（总数加 n、返工预留加 n、token 区间加上）；这件事因预算线受阻的，解除受阻并叫此刻该动的人
 *   （等核对叫核对人，等返工叫执行者……）；没受阻的不叫人；你之前选的「暂停」记号清掉；
 * - 「缩小范围」：预算线加 1（给总管这一个回合）；受阻的不解除受阻；叫醒总管，请他拟一版缩小范围的约定改动交你确认
 *   （总管怎么写、你确认之后怎样继续，见 job/narrow.ts）；
 * - 「暂停」：这件事还没到预算线时只记「用到预算线时暂停」；已经到预算线（受阻）时转「你已暂停」。
 * 旧存档里开着的条目选项是「再给 8 个回合」「暂停」：「再给 8 个回合」按「追加 8 个回合」处理，其余同上。
 *
 * 三段式沿用 blocked-commit.ts 的 commitAnswer：校验（失败什么都没写）→ 写状态（有备份，叫不醒就整体恢复）→ 主人看得见的话（出错只记日志）。
 * 预算线只经 budget-line.ts 改。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { budgetChoiceOf } from './block-options.js';
import { commitAnswer, type BlockedAnswerVia } from './blocked-commit.js';
import { raiseJobBudget } from './budget-line.js';
import { nextEstimate, topUpTokens } from './budget-text.js';
import { jobTitleOf } from './chain.js';
import { appendEstimateVersion, latestEstimate } from './estimate.js';
import { markReleased } from './escalation-expiry.js';
import { NARROW_EVENT_SUMMARY, NARROW_OWNER_SUMMARY } from './narrow.js';
import { noticeOf, patchNotice, restoreNotice } from './notices.js';
import { queueWake, softly, type UndoSteps } from './work-common.js';
import { applyJobAction } from './state.js';
import { holdForOwner } from './unblock.js';

/** 答案不在条目选项里时的拒绝文字：两项写「甲」或「乙」，三项写「甲」「乙」或「丙」。 */
function onlyOptionsText(options: readonly string[]): string {
  const quoted = options.map(text => `「${text}」`);
  return `answer：只能是${quoted.length === 2 ? quoted.join('或') : `${quoted.slice(0, -1).join('')}或${quoted.at(-1)}`}`;
}

/**
 * 答复预计消耗条目。校验失败抛出中文错误且什么都没写；返回更新后的事。
 * item 是这件事现在开着的预计消耗条目（调用方已确认它存在、编号对得上）。
 */
export function answerBudgetItem(ctx: HubContext, job: Job, item: InboxItem, rawAnswer: string, via: BlockedAnswerVia): Job {
  const answer = rawAnswer.trim();
  const choice = budgetChoiceOf(answer);
  // 答案必须是这一条条目自己的某个选项（追加的回合数随条目而定，不能自己换数）。
  if (choice === null || !item.options.includes(answer)) throw new Error(onlyOptionsText(item.options));
  const now = ctx.clock.now();
  const title = jobTitleOf(ctx, job);
  const estimate = latestEstimate(ctx, job.agreementId);
  const blocked = job.state === 'blocked';
  const blockedByCap = blocked && job.blocked?.kind === 'turn_cap';
  const notice = noticeOf(ctx, job.id);
  const wakeSummary = choice.kind === 'top_up' ? `主人给「${title}」追加了 ${choice.n} 个回合，请接着处理` : '';
  let next: Job = { ...job, inboxId: null, updatedAt: now };
  let chat: string;
  let writes: ((undo: UndoSteps) => void) | undefined;
  let wakeWith: ((undo: UndoSteps) => string | null) | undefined;
  let wake: { summary: string } | null = null;

  if (choice.kind === 'top_up') {
    const n = choice.n;
    next = raiseJobBudget(ctx, next, n, 'top_up');
    // 因预算线受阻的：解除受阻，回到受阻前的环节；已经因为别的原因受阻的事保持受阻，只叫该写说明的人（wakeExpected 会挑对人）。
    if (blockedByCap) next = markReleased(applyJobAction(next, { type: 'unblock' }, now));
    if (blocked) wake = { summary: wakeSummary };
    const tokens = topUpTokens(ctx, job.agreementId, n);
    writes = undo => {
      if (estimate !== null) undo.push(appendEstimateVersion(ctx, job.agreementId, nextEstimate(estimate, 'top_up', now, { n, low: tokens.low, high: tokens.high })));
      // 你之前选的「暂停」记号作废：追加之后预算线变了，到时候要不要停由新的问答决定。
      if (notice.holdAtCap) { const before = patchNotice(ctx, job.id, { holdAtCap: false }); undo.push(() => { restoreNotice(ctx, job.id, before); }); }
    };
    chat = estimate === null ? `已追加 ${n} 个回合，继续做。` : `已追加 ${n} 个回合，预计改为 ${estimate.total + n} 回合，接着做。`;
  } else if (choice.kind === 'narrow') {
    // 预算线加 1：给总管拟新版本这一个回合；受阻的不解除受阻（新版本你确认之后才接着做）。
    next = raiseJobBudget(ctx, next, 1, 'narrow');
    writes = undo => {
      const before = patchNotice(ctx, job.id, { narrowRequestedAt: now });
      undo.push(() => { restoreNotice(ctx, job.id, before); });
      // P76r3（R3）：预算线加 1 的同时追加一项预计（加到总管预留上），保持「预计总数 − 对齐 == 预算线」。
      if (estimate !== null) {
        const tokens = topUpTokens(ctx, job.agreementId, 1, 'chief');
        undo.push(appendEstimateVersion(ctx, job.agreementId,
          nextEstimate(estimate, 'narrow', now, { n: 1, low: tokens.low, high: tokens.high }, 'chief')));
      }
    };
    wakeWith = undo => {
      queueWake(ctx, { job: next, botId: job.chiefId, why: 'escalate', eventId: newId('jev', ctx.rng), summary: NARROW_EVENT_SUMMARY,
        ownerSummary: NARROW_OWNER_SUMMARY }, undo, '总管');
      return job.chiefId;
    };
    chat = '好的，我拟一版缩小范围的改动给你确认。';
  } else if (blocked) {
    // 已到预算线（或这件事已经受阻）：转「你已暂停」。
    next = holdForOwner(job, now);
    chat = `已暂停「${title}」。要接着做时告诉我。`;
  } else {
    // 还没到预算线：只记「用到预算线时暂停」，在这之前照常在做。
    const total = estimate?.total ?? job.turnCap;
    writes = undo => { const before = patchNotice(ctx, job.id, { holdAtCap: true }); undo.push(() => { restoreNotice(ctx, job.id, before); }); };
    chat = `好的，用到 ${total} 回合时暂停，在这之前预计之内的部分照常在做。`;
  }

  const done = commitAnswer(ctx, job, item, next, answer, 'cap', via, wake, { cap: next.turnCap }, {
    ...(writes === undefined ? {} : { writes }), ...(wakeWith === undefined ? {} : { wakeWith }) });
  softly(ctx, '总管私聊里的话', () => {
    postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: chat });
  });
  ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
  return done.job;
}
