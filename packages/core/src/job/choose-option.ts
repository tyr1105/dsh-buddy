/**
 * 主人选办法（P74f-2，任务卡第 7 节后半，补充要求 3.5、3.8、P74r2b 第 3 点、P74r2c 第 4 点、P74r3 第 2 点）。
 *
 * 总管用 escalate 把「卡在哪」和两三个办法交给主人后，主人在三轮不过卡上点一个办法，或在「待你处理」里点那条的按钮。
 * 两个入口都落到这里。校验失败什么都不写；写状态有备份、叫不醒就整体恢复；主人看得见的话在状态全部写成功之后。
 *
 * 选了带改动（change）的办法：中心生成约定的新固定版本（option-version.ts），然后这件事按「怎样算做完」的条目对应处理——
 * 交付时核对的条目、待改清单、受阻关联的条目、最近一次交回和核对记录，都按条目原文换成新序号（item-remap.ts 的同一套函数）：
 * - 核对三轮不过：其余条目本阶段都已通过、被删的正是卡住的条目，直接交付（option_deliver）；
 *   否则回到核对中（option_recheck），核对人只需给记下的那几条结论（recheckNos，review.ts 里其余条目按沿用处理）；
 * - 执行者做不下去：解除受阻，按这件事所处的环节叫对的人，新增、改写的条目并入待改清单。
 * 选了不带改动的办法：不改状态，叫醒总管（以主人的话叫醒），由总管换人、回答或转交材料。followUp 为真的办法也叫醒总管。
 * 这件事开着的其余受阻条目一并撤回，条目编号清空；主题文件在收尾里重写（onAgreementLocked 的 option 分支）。
 */
import { z } from 'zod';
import { LEGACY_TOP_UP_TURNS } from './block-options.js';
import { raiseJobBudget } from './budget-line.js';
import { nextEstimate, topUpTokens } from './budget-text.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { JobSchema, type Job, type JobEscalation, type JobReview, type JobSubmission } from '../model/job.js';
import { ThreadMessageSchema, type InboxItem, type ThreadMessage } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { postThread, wakeForOwnerMessage } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { onAgreementLocked, remapPassedReview } from './agreement-hooks.js';
import { openBlockItems } from './block-items.js';
import { appendEstimateVersion, latestEstimate } from './estimate.js';
import { isOnDutyNow, jobTitleOf } from './chain.js';
import { deliverJob, agreementPendingNo } from './deliver.js';
import { EXPIRY_REFUSAL_TEXT, jobEscalationExpiry } from './escalation-expiry.js';
import { OPTION_LETTERS, escalateSubjectKey, optionLabel } from './escalate.js';
import { buildOptionSubmission, clip20, mapDeliveryItems, remapBlockedNo, remapItems, remapUnmet, submissionTexts } from './item-remap.js';
import { applyOwnerOptionVersion } from './option-version.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, latestSubmission, putJob, reviewsOf } from './store.js';
import { wakeExpected } from './unblock.js';
import { reworkForVersion } from './version-stage.js';
import { runUndoSync, softly, type UndoSteps } from './work-common.js';
import { clearChiefBlockedAfterEscalation } from './chief-blocked.js';

/** 选办法的入口：「待你处理」按钮，或界面命令（三轮不过卡上的按钮）。 */
export type ChooseVia = 'inbox' | 'command';

/** 不是最新一张卡时的拒绝文字。 */
export const STALE_ESCALATION_TEXT = '这张卡已不是最新的，请在最新的一张上选办法';

/** 把卡住的这件事按新版本的条目对应换好（交付时核对条目、待改清单、受阻关联条目、已处理到第几版），再按办法转入下一环节。 */
function moveJob(ctx: HubContext, job: Job, escalation: JobEscalation, change: NonNullable<JobEscalation['options'][number]['change']>,
  prevDone: string[], newDone: string[], versionNo: number, now: number, keepBlocked = false): { job: Job; submission: JobSubmission | null; review: JobReview | null; delivered: boolean } {
  const remap = remapItems(prevDone, newDone);
  let next: Job = { ...job, updatedAt: now, handledVersionNo: Math.max(job.handledVersionNo ?? 0, versionNo),
    deliveryItems: mapDeliveryItems(job.deliveryItems, remap), unmet: remapUnmet(job.unmet, remap),
    blocked: job.blocked === null ? null : { ...job.blocked, no: remapBlockedNo(job.blocked.no, remap) } };
  if (escalation.kind === 'executor') {
    // 执行者做不下去：解除受阻回到受阻前的环节；新增、改写的条目并入待改清单（返工中才有意义，其余环节不用处理）。
    // P74r16c 第 2 节：因参与者被停用而受阻、停用的那位此刻仍不在岗时（keepBlocked）不解除受阻：叫不醒他，硬解除只会让选办法整体失败；
    // 条目照样按新版本换好，这件事保持受阻，等他恢复在岗之后接着做（resumeJobsOfReinstated 叫醒时带上选定的办法）。
    if (!keepBlocked) next = applyJobAction(next, { type: 'unblock' }, now);
    const unmetNew = remap.added.map(no => ({ no, problem: `按你选的办法改了这一条`, fixTo: newDone[no - 1]! }));
    return { job: { ...reworkForVersion(next, unmetNew, now).job, inboxId: null }, submission: null, review: null, delivered: false };
  }
  // 核对三轮不过：看最近一次交回、对应的最近一次核对里还有哪些条目不符。
  // P74r4a 第 2 条第 4 点：三套序号（交回和核对记录里的序号按那次交回的版本、办法里的序号按说明时的版本 = 现在固定的版本、
  // 新版本）一律按条目原文换算，不按序号直接套。prevDone 就是现在固定的版本（选办法时已校验说明的版本等于它）。
  const sub = latestSubmission(ctx, job.id);
  const last = sub === null ? null : reviewsOf(ctx, job.id).filter(row => row.submissionId === sub.id).at(-1) ?? null;
  const subToPrev = sub === null ? null : remapItems(submissionTexts(sub), prevDone);
  const unmetOld = last === null || subToPrev === null ? [escalation.no ?? change.no]
    : last.items.filter(row => row.verdict === 'unmet').flatMap(row => subToPrev.toNew.get(row.no) ?? []);
  const deleted = change.text === null;
  // 新版本里交回里没有的条目（说明之后在别处插入的新条目；改写的那一条不算）：没做过，必须进核对。
  const bySubNew = sub === null ? null : remapItems(submissionTexts(sub), newDone);
  const fresh = bySubNew === null ? [] : bySubNew.added.filter(no => deleted || no !== change.no);
  // 需要核对人给结论的条目（新序号）：删去的情形是剩下仍不符的；改写的情形是原来不符的加上被改写的这一条；再加上新插入的条目。
  const recheckNew = [...new Set([...(deleted
    ? unmetOld.filter(no => no !== change.no).flatMap(no => remap.toNew.get(no) ?? [])
    : [...unmetOld, change.no]), ...fresh])].sort((a, b) => a - b);
  // 按新版本重排最近一次交回（和一次通过的核对）：新阶段、第 1 轮，标明是中心重排的。
  const stageAfter = job.stage + 1;
  let submission: JobSubmission | null = null;
  if (sub !== null) {
    // 被改写的那一条沿用它原来在交回里的那一条（按原文找：prevDone 的第 change.no 条在交回里的序号）。
    const sourceNo = deleted ? undefined : remapItems(prevDone, submissionTexts(sub)).toNew.get(change.no);
    const base = buildOptionSubmission(sub, newDone, sourceNo === undefined ? null : { newNo: change.no, sourceNo }, versionNo, newId('jsb', ctx.rng), now);
    submission = { ...base, stage: stageAfter, round: 1 };
  }
  if (recheckNew.length === 0) {
    // 其余条目都已通过、被删的正是卡住的条目：直接交付；交付卡读的是新阶段的核对记录，所以通过的那次核对也按新编号重排一份。
    const review = sub !== null && submission !== null && last !== null
      ? remapPassedReview(ctx, job, sub, remapItems(submissionTexts(sub), newDone), submission) : null;
    return { job: { ...applyJobAction(next, { type: 'option_deliver' }, now), inboxId: null, delivery: null },
      submission, review: review === null ? null : { ...review, stage: stageAfter, round: 1 }, delivered: true };
  }
  return { job: { ...applyJobAction(next, { type: 'option_recheck' }, now), inboxId: null, recheckNos: recheckNew }, submission, review: null, delivered: false };
}

/** 选办法。校验失败抛出中文错误且什么都没写；返回改完的这件事。 */
export function chooseJobOption(ctx: HubContext, input: { jobId: string; stage: number; option: number; via: ChooseVia; revision?: number }): Job {
  // ---- 第一段：校验 ----
  const job = ctx.store.table('jobs').get(input.jobId);
  if (job === null) throw new Error('jobId：没有这件事');
  const escalation = job.escalation ?? null;
  if (escalation === null) throw new Error('这件事现在不在等你选办法');
  if (escalation.stage !== input.stage) throw new Error(STALE_ESCALATION_TEXT);
  // 同一阶段再次说明的卡带修订号：对着旧卡选办法被拒。
  if (input.revision !== undefined && input.revision !== (escalation.rev ?? 0)) throw new Error(STALE_ESCALATION_TEXT);
  if (escalation.chosen !== null) throw new Error('这一张已经选过办法了');
  if (!Number.isInteger(input.option) || input.option < 0 || input.option >= escalation.options.length) {
    throw new Error(`option：只能选 ${OPTION_LETTERS.slice(0, escalation.options.length).join('、')}`);
  }
  const pending = agreementPendingNo(ctx, job);
  if (pending !== null) throw new Error(`约定第 ${pending} 版在等你确认，确认后再选办法。`);
  // P74r4a 第 2 条：一次说明只对它写的时候的约定版本、那一次受阻有效。记下的版本号不等于现在固定的版本、或已被标为失效：拒绝；
  // 不是现在这一次受阻写的（受阻解除又受阻过）：这张卡已不是最新的。
  // P74r4a-m1：拒绝文字按失效原因区分（约定已更新、撤销、这件事已接着做、已停止），每一句说的都是事实。
  const expiry = jobEscalationExpiry(ctx, job, escalation);
  if (expiry !== null) throw new Error(EXPIRY_REFUSAL_TEXT[expiry]);
  if (job.state !== 'blocked') throw new Error('这件事现在不在等你选办法');
  if (job.stage !== input.stage) throw new Error(STALE_ESCALATION_TEXT);
  const chosen = escalation.options[input.option]!;
  const letter = OPTION_LETTERS[input.option]!;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null) throw new Error('这件事的约定找不到了，不能选办法');
  const item = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === escalateSubjectKey(job.id, input.stage, escalation.rev ?? 0))[0] ?? null;
  if (item === null) throw new Error('这条提醒已经处理过');

  // ---- 第二段：写状态（有备份，全部成功才算数）----
  const now = ctx.clock.now();
  const messageId = newId('m', ctx.rng); // 主人那句「选 A：……」的编号：先生成，新约定版本里要记它
  const answer = optionLabel(input.option, chosen.title);
  const others = openBlockItems(ctx, job.id).filter(row => row.id !== item.id);
  const undo: UndoSteps = [];
  let next: Job = { ...job, escalation: { ...escalation, chosen: input.option, chosenAt: now }, inboxId: null, updatedAt: now };
  // P74r6：这件事的回合已经用到上限：选办法的同时追加回合（与「再给回合」同一个数），否则选完叫不醒人。
  const toppedUp = job.turnsUsed >= job.turnCap;
  if (toppedUp) next = raiseJobBudget(ctx, next, LEGACY_TOP_UP_TURNS, 'top_up');
  let versionNo: number | null = null;
  let deliver = false;
  try {
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer, answeredAt: now });
    undo.push(() => { ctx.store.table('inbox').put(item); });
    if (chosen.change !== null) {
      const made = applyOwnerOptionVersion(ctx, agreement, { change: chosen.change, title: chosen.title, messageId, thread: job.chiefId, now });
      undo.push(() => { ctx.store.table('agreements').put(agreement); });
      versionNo = made.version.no;
      // P74r16c 第 2 节：参与者被停用而受阻、停用的那位仍不在岗：保持受阻（见 moveJob）。
      const stillOff = job.blocked?.kind === 'participant_off'
        && [job.executorId, job.reviewerId].some(id => id !== null && !isOnDutyNow(ctx, id));
      const moved = moveJob(ctx, next, escalation, chosen.change, made.prevDone, made.newDone, made.version.no, now, stillOff);
      next = moved.job;
      deliver = moved.delivered;
      if (moved.submission !== null) {
        ctx.store.table('jobSubmissions').put(moved.submission);
        undo.push(() => { ctx.store.table('jobSubmissions').remove(moved.submission!.id); });
      }
      if (moved.review !== null) {
        ctx.store.table('jobReviews').put(moved.review);
        undo.push(() => { ctx.store.table('jobReviews').remove(moved.review!.id); });
      }
    }
    putJob(ctx, JobSchema.parse(next));
    undo.push(() => { putJob(ctx, job); });
    // P76r3（R3）：选办法时因回合用满自动追加的 8 个，同时追加一项预计（与预算线在同一次带备份的写入里改），
    // 保持「预计总数 − 对齐 == 预算线」。
    if (toppedUp) {
      const last = latestEstimate(ctx, job.agreementId);
      if (last !== null) {
        const tokens = topUpTokens(ctx, job.agreementId, LEGACY_TOP_UP_TURNS);
        undo.push(appendEstimateVersion(ctx, job.agreementId,
          nextEstimate(last, 'top_up', now, { n: LEGACY_TOP_UP_TURNS, low: tokens.low, high: tokens.high })));
      }
    }
    // 状态写好之后叫人（闸门读存储里的状态）：带改动的办法叫此刻该动的人；叫不醒就整体恢复。
    if (chosen.change !== null && !deliver && next.state !== 'blocked') {
      wakeExpected(ctx, next, `主人为「${jobTitleOf(ctx, job)}」选了办法：${chosen.title}`, undo);
    }
    appendJobEvent(ctx, { jobId: job.id, actor: 'owner', kind: 'option_chosen', to: [job.chiefId], refId: item.id,
      data: { stage: input.stage, option: input.option, title: chosen.title, via: input.via,
        ...(chosen.change === null ? {} : { change: chosen.change }), ...(versionNo === null ? {} : { versionNo }) } });
  } catch (error) {
    runUndoSync(ctx, undo, '选办法', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`选办法没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_option_chosen', { jobId: job.id, option: input.option, via: input.via }, 'owner', now);
  ctx.runtime.ownerActiveAt = now;
  // P74r14：这次说明有了结果（主人选了办法）：清掉总管因为这次说明写下的受阻状态（其余事仍在等主人选办法时不清）。
  clearChiefBlockedAfterEscalation(ctx, job.id);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  emitInboxChange(ctx, item);

  // ---- 第三段：主人看得见的话 ----
  softly(ctx, '撤回其余受阻条目', () => {
    for (const other of others) { ctx.store.table('inbox').patch(other.id, { status: 'withdrawn', answer: '主人已选办法', answeredAt: now }); emitInboxChange(ctx, other); }
  });
  let message: ThreadMessage | null = null;
  softly(ctx, '主人选办法的话', () => {
    // 以主人名义在总管私聊落「选 {字母}：{title}」；编号用先生成的那个（新约定版本引用它）。
    message = ThreadMessageSchema.parse({ id: messageId, thread: job.chiefId, from: 'owner', kind: 'chat', text: `选 ${letter}：${chosen.title}`,
      refId: job.id, createdAt: now, readAt: now });
    ctx.store.log('thread').append(message!);
    ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
  });
  if (toppedUp) {
    softly(ctx, '追加回合的话', () => {
      postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: `这件事的回合已经用完，按你选的办法继续需要回合，已追加 ${LEGACY_TOP_UP_TURNS} 个。` });
    });
  }
  if (versionNo !== null) {
    softly(ctx, '约定新版本的提示', () => {
      postThread(ctx, { thread: job.chiefId, from: 'hub', kind: 'system', refId: agreement.id, text: `已按你选的办法记为约定第 ${versionNo} 版。` });
    });
    softly(ctx, '重写主题文件', () => { onAgreementLocked(ctx, agreement.id, versionNo!, 'option'); });
  }
  if (deliver) softly(ctx, '交付', () => { deliverJob(ctx, ctx.store.table('jobs').get(job.id) ?? next); });
  // 不带改动、或后续要总管安排（followUp）的办法：以主人那句话叫醒总管。
  if ((chosen.change === null || chosen.followUp) && message !== null) {
    softly(ctx, '叫醒总管', () => {
      const chief = ctx.store.table('bots').get(job.chiefId);
      if (chief) wakeForOwnerMessage(ctx, chief, message!);
    });
  }
  return ctx.store.table('jobs').get(job.id) ?? next;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 「待你处理」条目的回答（「A　标题」）对应第几个办法；对不上返回 null。 */
export function optionIndexOfAnswer(escalation: JobEscalation, answer: string): number | null {
  const text = answer.trim();
  const index = escalation.options.findIndex((option, i) => optionLabel(i, option.title) === text);
  return index < 0 ? null : index;
}

/** 在「待你处理」里点办法的按钮。 */
export function chooseFromInbox(ctx: HubContext, item: InboxItem, answer: string): void {
  const match = /^job:(job_[a-z0-9]{10}):escalate:(\d+)(?:~(\d+))?$/.exec(item.subjectKey);
  const job = match === null ? null : ctx.store.table('jobs').get(match[1]!);
  if (match === null || job === null || job.escalation == null) throw new Error('这条事项已失效');
  const index = optionIndexOfAnswer(job.escalation, answer);
  if (index === null) throw new Error('answer：请在给出的办法里选一个');
  chooseJobOption(ctx, { jobId: job.id, stage: Number(match[2]), option: index, via: 'inbox', revision: match[3] === undefined ? 0 : Number(match[3]) });
}

const ChooseCommandSchema = z.strictObject({
  jobId: recordId('job'),
  stage: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '阶段从 1 起'),
  option: z.number({ error: '必须是整数' }).int('必须是整数').min(0, '办法序号从 0 起'),
  revision: z.number({ error: '必须是整数' }).int('必须是整数').min(0, '修订号从 0 起').optional(),
});

/** 界面命令 chooseJobOption：入参校验后落到 chooseJobOption。 */
export function chooseJobOptionCommand(ctx: HubContext, raw: unknown): { jobId: string; stage: number; option: number } {
  const input = parseInput(ChooseCommandSchema, raw, '选办法');
  chooseJobOption(ctx, { jobId: input.jobId, stage: input.stage, option: input.option, via: 'command', ...(input.revision === undefined ? {} : { revision: input.revision }) });
  return { jobId: input.jobId, stage: input.stage, option: input.option };
}
