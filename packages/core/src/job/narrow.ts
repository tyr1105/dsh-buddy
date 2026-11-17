/**
 * 「缩小范围」之后的两头（P76f，方案 7.5）：叫醒总管时写给他看的话，以及主人确认新版本之后这件事怎样接着做。
 *
 * 流程：主人在预计消耗条目里选「缩小范围」（budget-answer.ts）→ 预算线加 1、记 narrowRequestedAt、叫醒总管（why 为 escalate）
 * → 总管的唤醒包里多一段（narrowParagraph）：约定里还没通过的条目，和怎样提交新版本
 * → 总管用 hub_agreement_submit 的 mode revise 出新版本请主人确认（执行链回合里的窄例外，见 project/agreement-chain.ts）
 * → 主人确认新版本（job/agreement-hooks.ts 的收尾）→ afterNarrowLocked：清记号、预计追加一项（reason 为 narrow，总数不变）、
 *   这件事因预算线受阻的解除受阻并叫此刻该动的人，剩余回合为 0 的再追加 TOP_UP_MIN 个回合、总管私聊说明，最后重算一次预计消耗。
 *
 * 为什么新版本固定之后要由这里解除受阻：约定固定后的收尾（lockedFollowUp）只叫「正在干活」的执行者；
 * 这件事停在预算线（受阻）时，没有人会再叫它，必须由这里接着往下走。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { releaseBlockItems } from './block-items.js';
import { raiseBudgetBy } from './budget-line.js';
import { checkBudget } from './budget-ask.js';
import { jobTitleOf } from './chain.js';
import { appendEstimateVersion, latestEstimate } from './estimate.js';
import { nextEstimate, topUpTokens } from './budget-text.js';
import { lockedVersionOf } from './files.js';
import { patchNotice } from './notices.js';
import { applyJobAction } from './state.js';
import { latestSubmission, putJob, reviewsOf } from './store.js';
import { tryWakeExpected } from './unblock.js';

/** 叫醒总管时的摘要（给模型看，逐字）。 */
export const NARROW_EVENT_SUMMARY = '主人选了缩小范围：请拟一版改动交主人确认。只删去或放宽『怎样算做完』里还没通过的条目，不新增条目；改好后照常提交新版本，等主人确认。';

/** 给主人看的那一行（队列里这次叫醒的说明）。 */
export const NARROW_OWNER_SUMMARY = '等待拟缩小范围的改动';

/** 约定里还没通过的条目（序号与原文）：最近一次核对里结论是符合或沿用的算通过，其余（含没核对过的）都算没通过。 */
export function notPassedItems(ctx: HubContext, job: Job, doneWhen: readonly string[]): Array<{ no: number; text: string }> {
  const reviews = reviewsOf(ctx, job.id).filter(review => review.stage === job.stage);
  const last = reviews.at(-1);
  const submission = last === undefined ? null : ctx.store.table('jobSubmissions').get(last.submissionId) ?? latestSubmission(ctx, job.id);
  // 通过的条目按原文认（序号可能因约定改版变过）。
  const passed = new Set<string>();
  if (last !== undefined && submission !== null) {
    for (const row of last.items) {
      if (row.verdict !== 'met' && row.verdict !== 'carried') continue;
      const text = submission.items.find(own => own.no === row.no)?.text;
      if (text !== undefined) passed.add(text);
    }
  }
  return doneWhen.map((text, index) => ({ no: index + 1, text })).filter(item => !passed.has(item.text));
}

/**
 * 总管唤醒包里「缩小范围」那一段（逐行）；这件事没有在等缩小范围、或新版本已经出了（约定在等你确认）时返回 null。
 * 段落写明：主人选了什么、哪些条目还没通过、用哪个工具和参数提交新版本（只用唤醒包里的话就能完成）。
 */
export function narrowParagraph(ctx: HubContext, job: Job): string[] | null {
  const notice = ctx.store.table('jobNotices').get(job.id);
  if (notice === null || notice.narrowRequestedAt === null) return null;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null || agreement.state !== 'locked') return null;
  const items = notPassedItems(ctx, job, lockedVersionOf(agreement).content.doneWhen);
  const list = items.length === 0 ? ['（每一条都已通过，可以放宽其中的要求）'] : items.map(item => `doneWhen ${item.no}. ${item.text}`);
  return [
    '主人选了缩小范围。约定里还没通过的条目：',
    ...list,
    `请用 hub_agreement_submit 提交一版改动：mode 写 revise，agreementId 写 ${agreement.id}，changeNote 写为什么这样缩小；`
      + 'doneWhen 写改后的全部条目（沿用的条目顺序不要调整，删去的条目在 removals 里逐条写原文），continuing 写不受影响、照常在做的部分，paused 写被改动涉及的部分。'
      + '只删去或放宽这些条目，不新增；在本次改动说明里写一句为什么这样缩小。',
  ];
}

/**
 * 主人确认了一版约定之后调用（约定固定后的收尾末尾，同步）：这件事在等缩小范围的新版本、而这一版就是它（版本是选了缩小范围之后出的）时，
 * 清掉记号、预计追加一项（narrow，总数不变）、解除预算线造成的受阻并叫人、剩余回合为 0 的追加 TOP_UP_MIN 个回合，最后重算预计消耗。
 * 返回是否处理过。出错由调用方记日志。
 */
export function afterNarrowLocked(ctx: HubContext, jobId: string, versionNo: number): boolean {
  const notice = ctx.store.table('jobNotices').get(jobId);
  const job = ctx.store.table('jobs').get(jobId);
  if (notice === null || notice.narrowRequestedAt === null || job === null) return false;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const version = agreement?.versions.find(row => row.no === versionNo);
  // 确认的是选缩小范围之前就有的版本：不是这次缩小范围的新版本，不处理。
  if (version === undefined || version.createdAt < notice.narrowRequestedAt) return false;
  const now = ctx.clock.now();
  patchNotice(ctx, jobId, { narrowRequestedAt: null });
  // P76r3（R3）：新版本固定时追加一项预计（reason 为 narrow）；剩余回合为 0 要追加 TOP_UP_MIN 个的，
  // 这一项的总数也加同样的数，保持「预计总数 − 对齐 == 预算线」。
  const toppedUp = job.state === 'blocked' && job.blocked?.kind === 'turn_cap' && job.turnsUsed >= job.turnCap;
  const last = latestEstimate(ctx, job.agreementId);
  if (last !== null) {
    const add = toppedUp
      ? (() => { const tokens = topUpTokens(ctx, job.agreementId, D.TOP_UP_MIN); return { n: D.TOP_UP_MIN, low: tokens.low, high: tokens.high }; })()
      : null;
    appendEstimateVersion(ctx, job.agreementId, { ...nextEstimate(last, 'narrow', now, add), versionNo });
  }
  const title = jobTitleOf(ctx, job);
  if (job.state === 'blocked' && job.blocked?.kind === 'turn_cap') {
    // 因预算线受阻：剩余回合为 0 的追加 TOP_UP_MIN 个，解除受阻回到受阻前的环节，叫此刻该动的人。
    if (toppedUp) { raiseBudgetBy(ctx, jobId, D.TOP_UP_MIN, 'narrow'); }
    const fresh = ctx.store.table('jobs').get(jobId) ?? job;
    const released = releaseBlockItems(ctx, applyJobAction(fresh, { type: 'unblock' }, now)).job;
    putJob(ctx, { ...released, updatedAt: now });
    tryWakeExpected(ctx, released, `主人确认了缩小范围的新版本：「${title}」请按约定第 ${versionNo} 版接着做`);
    if (toppedUp) {
      try {
        postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: `新版本已确认，追加 ${D.TOP_UP_MIN} 个回合照新版本做完。` });
      } catch (error) { ctx.logger.warn('缩小范围确认后的私聊没有落下', { jobId, error: String(error) }); }
    }
  }
  checkBudget(ctx, jobId);
  return true;
}
