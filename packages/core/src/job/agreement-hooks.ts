/**
 * 约定变化之后，这件事的后续（P74e，方案 5.2.3、5.4，B2）。
 *
 * 一份约定挂着一件正在做的事时，约定的三种变化各有后续，这里是它们的集中处理：
 * - 待确认（B2，出新版本请主人确认）：onReopenPending —— 工作往来一句、给执行者排一次唤醒，说明哪些暂停、哪些照常在做；
 * - 主人确认固定、或主人亲口的小改动直接生效（amend）：onAgreementLocked —— 重写主题文件、清掉暂停、主题里以总管名义落一句、
 *   叫醒执行者；新版本改了「怎样算做完」而这件事已交回或已交付的，按新版本只退回被改到的条目返工；
 * - 主人不确认，总管撤销这次重新确认：onReopenWithdrawn —— 清掉暂停，仍按原版本做。
 * P74r2c：新版本改了「怎样算做完」的条目顺序位置时，按条目原文把交付时核对的条目、待改条目、受阻关联条目换成新序号；
 * 核对中只删去条目的，由中心按新序号重排最近一次交回并重新叫核对人（对应关系的纯函数在 item-remap.ts）。
 * 三者都不叫醒总管（这是 B2 省一个总管回合的设计）：叫不叫总管由第一块的确认途径决定，见 agreement-confirm.ts。
 *
 * 为什么放在 job/：这些是「一件事」的状态变化；约定模块（project/）只在写完自己的状态之后调用这里，出错只记日志，
 * 不影响约定已经写成功的状态（第二段，方案 6.4）。
 *
 * 为什么有 scheduleHook：确认约定的几条途径都是同步函数，而重写主题文件要碰盘（异步）。这里把异步的收尾登记下来，
 * 界面命令和回合事件的出口会等它做完（flushJobHooks）；单元测试也用它等。
 */
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { launchOf, type Agreement } from '../model/agreement.js';
import { JobSchema, type Job, type JobReview, type JobSubmission, type JobUnmet } from '../model/job.js';
import { afterAgreementLockedMemory } from '../memory/precedents.js';
import { deliverJob } from './deliver.js';
import { estimateFor } from './estimate.js';
import { afterNarrowLocked } from './narrow.js';
import { patchNotice } from './notices.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { enqueueJobWake, jobTitleOf } from './chain.js';
import {
  buildRemappedSubmission, clip20, flippedDeliveryItems, mapDeliveryItems, remapBlockedNo, remapItems, remapUnmet, submissionTexts,
} from './item-remap.js';
import { writeJobFiles } from './files.js';
import { invalidateOpenEscalation, wakeChiefAfterExpiry } from './escalation-expiry.js';
import { stopJobForAgreement, versionStopsJob } from './stops-job.js';
import { clipTo, pausedCount } from './pause.js';
import { dropJobEntries } from './start-wake.js';
import { endLaunchForRemovedClause, noteLaunchNotStopped } from './launch-removed.js';
import { effectiveStateOf, reworkForVersion } from './version-stage.js';
import { appendJobEvent, isJobClosed, jobOfAgreement, latestSubmission, putJob, reviewsOf } from './store.js';

// ---------------------------------------------------------------------------
// 异步收尾的登记
// ---------------------------------------------------------------------------

const inflight = new WeakMap<HubContext, Set<Promise<void>>>();
/** 正在跑的「固定后的收尾」：键是「事编号:版本号」（P74r2b，防止巡检补做和正常收尾重复）。 */
const followUpsRunning = new WeakMap<HubContext, Set<string>>();

/** 登记并启动一段异步收尾；出错只记日志。 */
export function scheduleHook(ctx: HubContext, what: string, work: () => Promise<void>): void {
  let set = inflight.get(ctx);
  if (!set) { set = new Set(); inflight.set(ctx, set); }
  const promise: Promise<void> = work().catch(error => {
    try { ctx.logger.warn(`${what}失败`, { error: String(error) }); } catch { /* 日志出错也不能抛出去。 */ }
  }).finally(() => { set!.delete(promise); });
  set.add(promise);
}

/** 等所有已登记的异步收尾做完（界面命令、回合事件的出口、测试用）。 */
export async function flushJobHooks(ctx: HubContext): Promise<void> {
  const set = inflight.get(ctx);
  while (set !== undefined && set.size > 0) await Promise.all([...set]);
}

// ---------------------------------------------------------------------------
// 查询与小工具
// ---------------------------------------------------------------------------

/** 这份约定有没有一件正在做的事（不是已完成、已停止）；有就返回它。 */
export function activeJobOfAgreement(ctx: HubContext, agreementId: string): Job | null {
  const job = jobOfAgreement(ctx, agreementId);
  return job !== null && !isJobClosed(job) ? job : null;
}

/**
 * 主人确认之后，这份约定的事不需要叫醒总管：这份约定有进行中的事（执行者接着做），或者这次确认的是写明「不再做」的版本、
 * 中心刚把这件事停下（P74f-2，补充要求第 1 节：由中心直接停，不叫醒总管）。确认的几条途径在固定之后用它决定叫不叫总管；
 * 固定之后这件事可能已经停止，所以不能只看 activeJobOfAgreement。
 */
export function confirmNeedsNoChief(ctx: HubContext, agreementId: string): boolean {
  if (activeJobOfAgreement(ctx, agreementId) !== null) return true;
  const job = jobOfAgreement(ctx, agreementId);
  const locked = ctx.store.table('agreements').get(agreementId)?.versions.filter(row => row.lockedAt !== null).sort((a, b) => b.no - a.no)[0];
  return job !== null && job.state === 'stopped' && job.stoppedAt !== null && locked !== undefined && locked.stopsJob === true
    && locked.lockedAt !== null && job.stoppedAt >= locked.lockedAt;
}

/** 执行者正在干活的状态：这时才需要叫醒他（核对中、等你验收、受阻时叫了也没有事可做）。 */
const WORKING: readonly Job['state'][] = ['ready', 'doing', 'rework'];

/** 名字。 */
function nameOf(ctx: HubContext, botId: string, fallback: string): string {
  return ctx.store.table('bots').get(botId)?.name ?? fallback;
}

/** 去掉句末标点，让「{说明}。」不会变成「{说明}。。」。 */
function bare(text: string): string {
  return text.replace(/[。.！!；;，,\s]+$/u, '');
}

/** 顿号连接；没有内容写「无」。 */
function listText(items: readonly string[]): string {
  return items.length === 0 ? '无' : items.join('、');
}

/** 给执行者排一次接着做的唤醒；状态不是在干活，或入队没成功，返回 false。 */
function wakeWorkingExecutor(ctx: HubContext, job: Job, why: 'resumed' | 'returned', summary: string, eventId: string): boolean {
  if (!WORKING.includes(job.state)) return false;
  const entry = enqueueJobWake(ctx, { job, botId: job.executorId, why, eventId, summary });
  if (entry === null) ctx.logger.warn('约定变化后没有排上执行者的唤醒（他此刻可能不在岗）', { jobId: job.id });
  return entry !== null;
}

/** 这件事开着的「待你处理」条目撤回（验收条目等）。返回撤回了几条。 */
function withdrawJobInbox(ctx: HubContext, job: Job, answer: string): number {
  const open = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
  for (const item of open) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer, answeredAt: ctx.clock.now() });
    emitInboxChange(ctx, item);
  }
  return open.length;
}

// ---------------------------------------------------------------------------
// 一、出新版本、等主人确认（B2）
// ---------------------------------------------------------------------------

/**
 * 约定重新请主人确认时（Job.pause 已经和约定新版本一起写好）：工作往来落一句，给执行者排一次唤醒。
 * 返回执行者是否被叫醒，供工具如实回话。出错只记日志（调用方捕获）。
 */
export function onReopenPending(ctx: HubContext, job: Job): boolean {
  const pause = job.pause;
  if (pause === null) return false;
  // P74r4a 第 2 条：约定出了新版本在等主人确认：这件事还没选的那次说明立即失效（条目撤回、卡片显示失效），
  // 受阻原因不变；确认或撤销之后再叫总管（见 wakeChiefAfterExpiry）。
  invalidateOpenEscalation(ctx, job.id, 'reconfirming');
  // P74f（补充要求第 2 节）：待你验收时出了新版本：撤回验收条目（交付卡随之显示「在等你确认」，验收的按钮和打字都被拒），
  // 主人面前同一件事同一时刻只有一个入口——现在是约定确认。确认或撤销之后再放出验收条目。
  if (job.state === 'awaiting_owner' && withdrawJobInbox(ctx, job, `约定第 ${pause.versionNo} 版在等你确认`) > 0) {
    ctx.store.table('jobs').patch(job.id, { inboxId: null });
  }
  const eventId = newId('jev', ctx.rng);
  // P74f-2：这一版写明「不再做」：确认前执行者照常做，不用叫醒；确认后由中心停下（stops-job.ts）。
  if (pause.stopsJob === true) {
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: job.chiefId, kind: 'paused', to: [job.executorId], refId: null,
      data: { versionNo: pause.versionNo, paused: [], continuing: [], stopsJob: true } });
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId,
      text: `约定第 ${pause.versionNo} 版在等你确认；确认后这件事停止，确认前照常在做。` });
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    return false;
  }
  const woken = wakeWorkingExecutor(ctx, job, 'resumed', `约定第 ${pause.versionNo} 版在等主人确认，暂停：${listText(pause.paused)}；其余照常在做`, eventId);
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: job.chiefId, kind: 'paused', to: [job.executorId], refId: null,
    data: { versionNo: pause.versionNo, paused: pause.paused, continuing: pause.continuing } });
  postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId,
    text: `约定第 ${pause.versionNo} 版在等你确认；暂停：${listText(pause.paused)}；其余照常在做。` });
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return woken;
}

// ---------------------------------------------------------------------------
// 二、固定之后
// ---------------------------------------------------------------------------

/** P74r2b：这一版固定后，由它回答的那条提问（提问是为这一版或更早的待确认版本出的）；没有返回 null。 */
function askAnsweredBy(job: Job, versionNo: number): NonNullable<Job['openAsk']> | null {
  return job.openAsk !== null && job.openAsk.agreementNo != null && versionNo >= job.openAsk.agreementNo ? job.openAsk : null;
}

/** 这个版本之前最近一次固定过的版本（它就是正在执行的版本）。 */
function previousLocked(agreement: Agreement, versionNo: number) {
  return agreement.versions.filter(row => row.no < versionNo && row.lockedAt !== null).sort((a, b) => b.no - a.no)[0] ?? null;
}

/**
 * 主人确认固定了一版（how 为 confirm），或主人亲口的小改动直接生效（how 为 amend）之后调用；
 * 只登记异步收尾，立即返回。出错只记日志，不影响约定已经写成功的状态。
 */
export function onAgreementLocked(ctx: HubContext, agreementId: string, versionNo: number, how: 'confirm' | 'amend' | 'option'): void {
  // P75d：每次固定都先做记忆部分（写先例；P75r1 起不再按约定卡上的修改更正被引用的记忆）。放在所有提前返回之前：
  // 还没有事挂在这份约定上（刚固定、还没派活）、这一版写明不再做的情况也要写先例。
  // 异步登记，出错由 afterAgreementLockedMemory 自己记日志，不影响下面的收尾；同一版重复调用不会重复写（writePrecedents 逐条重新查表）。
  scheduleHook(ctx, '约定固定后的记忆', () => afterAgreementLockedMemory(ctx, agreementId, versionNo));
  const job = jobOfAgreement(ctx, agreementId);
  // P76e：这份约定还没有这件事（或这件事已停止、可能重新派活）时，固定时按规则算一项预计消耗（lock，替换同一版的 draft）。
  // 已经有这件事的约定再次固定不重算（预计只在追加、缩小范围时才改，P76f）。放在所有提前返回之前；同步、不调用模型，出错只记日志。
  if (job === null || job.state === 'stopped') {
    try { estimateFor(ctx, agreementId, versionNo, 'lock'); } catch (error) { ctx.logger.warn('预计消耗没有算成（约定固定）', { agreementId, error: String(error) }); }
  }
  if (job === null || job.state === 'stopped') return;
  // P74f-2：这一版写明了「不再做」：由中心直接停下这件事（同步，不叫醒总管），不再做别的收尾（主题文件不用重写）。
  // 出错只记日志：这一版的「已处理到」没有更新，巡检会再来补停。
  if (how === 'confirm' && versionStopsJob(ctx, agreementId, versionNo)) {
    try { stopJobForAgreement(ctx, agreementId, versionNo); }
    catch (error) { ctx.logger.warn('主人确认不再做之后停下这件事失败', { agreementId, error: String(error) }); }
    return;
  }
  // P74r4a 第 2 条：固定了新版本（含主人亲口的小改动直接生效）：这件事还没选的说明立即失效，同步做，不等异步收尾。
  // 主人选办法生成的版本（option）不在此列：那次说明已经被用掉了。
  const escalation = job.escalation;
  if (how !== 'option' && escalation != null && versionNo > escalation.versionNo) invalidateOpenEscalation(ctx, job.id, 'updated');
  // P74r2b：同一件事同一版的收尾同时只跑一份：收尾还在跑（比如在重写主题文件）时，巡检的补做不能再开一份，否则话和叫醒会重复。
  const key = `${job.id}:${versionNo}`;
  let running = followUpsRunning.get(ctx);
  if (!running) { running = new Set(); followUpsRunning.set(ctx, running); }
  if (running.has(key)) return;
  running.add(key);
  scheduleHook(ctx, '约定固定后的后续', () => lockedFollowUp(ctx, agreementId, versionNo, how).finally(() => { running!.delete(key); }));
}

async function lockedFollowUp(ctx: HubContext, agreementId: string, versionNo: number, how: 'confirm' | 'amend' | 'option'): Promise<void> {
  const agreement = ctx.store.table('agreements').get(agreementId);
  const first = jobOfAgreement(ctx, agreementId);
  if (!agreement || first === null || first.state === 'stopped') return;
  // 1. 重写主题文件（已完成的事也要：约定文件里的版本号要对得上）；失败只记日志，后面的状态步骤照常做。
  try { await writeJobFiles(ctx, first); } catch (error) { ctx.logger.warn('约定固定后重写主题文件失败', { jobId: first.id, error: String(error) }); }
  // P74f-2：主人选了带改动的办法、由中心生成的新版本：这件事的状态、条目对应、叫人都已由 choose-option.ts 处理（同一次写入里
  // 已记下「已处理到第几版」），这里只重写主题文件，不再按「怎样算做完」的差异退回返工。
  if (how === 'option') { ctx.emit(HUB_EVENT_SCOPES.project, null); return; }
  // 2. 已完成的事到此为止（只记下已处理到这一版，巡检不再补做）。
  const job = ctx.store.table('jobs').get(first.id);
  if (!job) return;
  // P74r3（疑点 1）：「已处理到第几版」只增不减，取已有值和这一版中较大的一个（连续确认两版时，较旧一版的收尾后写入也不会把它写小）。
  const handled = Math.max(job.handledVersionNo ?? 0, versionNo);
  // P74r9：新版本里「对外发布」一项决定这件事有没有发布这一步。还没有验收的，按新版本更新 launchStep；
  // 已经验收的（发布这一步已经开始或结束，或已经确定没有）不动，只记日志，免得验收之后发布这一步凭空出现或消失。
  const version = agreement.versions.find(row => row.no === versionNo);
  const newLaunchStep = version === undefined ? job.launchStep : launchOf(version.content) !== null;
  // P74r13：已经验收、新版本去掉了对外发布、而发布这一步还没有做完：中心结束这一步（主人确认了不发布）；
  // 发布已经做完的不动（总管提交修订时已在返回文字里写明事实）；反方向（加上）不追加发布这一步。
  let current: Job = job;
  if (job.acceptedAt !== null && newLaunchStep !== job.launchStep) {
    if (!newLaunchStep && endLaunchForRemovedClause(ctx, job, versionNo)) current = ctx.store.table('jobs').get(job.id) ?? job;
    else if (!newLaunchStep && noteLaunchNotStopped(ctx, job, versionNo)) ctx.logger.info('约定去掉了对外发布，但发布已在执行或已完成，主题里已说明', { jobId: job.id, versionNo });
    else ctx.logger.info('约定对外发布一项变了，但这件事已经验收，发布这一步不变', { jobId: job.id, versionNo, launchStep: job.launchStep });
  }
  if (isJobClosed(current)) {
    ctx.store.table('jobs').put(JobSchema.parse({ ...current, handledVersionNo: handled }));
    return;
  }
  if (!version) return;
  const executorName = nameOf(ctx, job.executorId, '执行者');
  const eventId = newId('jev', ctx.rng);
  const hadPause = job.pause !== null && job.pause.versionNo === versionNo;

  // 3. 新版本改了「怎样算做完」：已交回、已交付的内容是按旧版本做的，只把被改到的条目退回返工。
  // P74r2b（疑点 1）：只在最近一次交回是按更早的版本做的时候才退回；最近一次交回已经是按这一版（或更新的版本）做的，不退回
  // （确认与交回交错：执行者在收尾写文件的间隙里已经按新版本交回了，状态已是核对中）。
  const prev = previousLocked(agreement, versionNo);
  const sub = latestSubmission(ctx, job.id);
  const doneOnNew = (sub?.versionNo ?? 0) >= versionNo;
  const reviewerId = job.reviewerId ?? job.chiefId;
  // P74r2c（G4）：按条目原文对应上一个固定版本和这一版。序号变了，按序号存的几样东西要跟着换：
  // 交付时核对的条目（deliveryItems）、返工待改的条目（unmet）、受阻关联的条目（blocked.no）。
  const remap = prev === null ? null : remapItems(prev.content.doneWhen, version.content.doneWhen);
  const itemsChanged = remap !== null && remap.changed;
  // 交付时核对的条目：随这一版等确认时算好的结果（总管写了 deliveryItems，或中心按原文对应）；
  // 没有这个结果（旧数据、直接生效）时按原文对应现算。
  const deliveryItems = how === 'confirm' && hadPause && job.pause!.deliveryItems !== undefined ? job.pause!.deliveryItems
    : itemsChanged ? mapDeliveryItems(job.deliveryItems, remap) : job.deliveryItems;
  // 需要重新交回的条目：新增或改写的，以及「是否交付时核对」状态变了的。
  const flipped = remap === null ? [] : flippedDeliveryItems(job.deliveryItems, deliveryItems, remap);
  let nos = how === 'confirm' && remap !== null && !doneOnNew ? [...new Set([...remap.added, ...flipped])].sort((a, b) => a - b) : [];
  // 核对中、没有新增或改写、只有删去：最近一次交回不退回，由中心按新序号重排一条（只追加，原记录不动）。
  // P74r3（H2）：按实际所处的环节判断：受阻时取解除后要回到的状态，回到核对中的也现在就重排，不等解除。
  // P74f（补充要求第 2 节）：待你验收时只删去条目的，同样重排最近一次交回，并把通过的那次核对也按新编号重排一份，然后重新交付。
  let resort: { submission: JobSubmission; removedNos: number[]; review: JobReview | null } | null = null;
  const stage0 = effectiveStateOf(job);
  if ((stage0 === 'checking' || stage0 === 'awaiting_owner') && how === 'confirm' && itemsChanged && nos.length === 0 && !doneOnNew && sub !== null) {
    // 以最近一次交回里的条目原文为准（它可能比上一个固定版本更早）。
    const bySub = remapItems(submissionTexts(sub), version.content.doneWhen);
    if (bySub.added.length > 0) nos = bySub.added;
    else if (bySub.changed) {
      const remapped = buildRemappedSubmission(sub, bySub, versionNo, newId('jsb', ctx.rng), ctx.clock.now());
      resort = { submission: remapped, removedNos: bySub.removed, review: stage0 === 'awaiting_owner' ? remapPassedReview(ctx, job, sub, bySub, remapped) : null };
    }
  }
  const unmetNew: JobUnmet[] = nos.map(no => ({ no, problem: `约定第 ${versionNo} 版改了这一条`, fixTo: clipTo(version.content.doneWhen[no - 1]!, 200) }));
  // P74r2b：这一版是为一个提问出的，现在固定了：提问由这一版回答（清掉 openAsk）。
  const ask = how === 'confirm' ? askAnsweredBy(job, versionNo) : null;
  // 「已处理到第几版」在状态步骤里一起写：状态步骤没做完（进程退出）就不更新，巡检会补做。
  // 待改条目、受阻关联条目按原文换成新序号（原文被改写或删去的待改条目去掉，受阻关联置空）。
  let next: Job = { ...job, pause: null, openAsk: ask === null ? job.openAsk : null, handledVersionNo: handled, updatedAt: ctx.clock.now(), deliveryItems,
    // P74r9：还没有验收：发布这一步按新版本约定的对外发布一项更新。
    launchStep: job.acceptedAt === null ? newLaunchStep : job.launchStep,
    ...(itemsChanged ? { unmet: remapUnmet(job.unmet, remap), blocked: job.blocked === null ? null : { ...job.blocked, no: remapBlockedNo(job.blocked.no, remap) } } : {}) };
  // P74r3（H2）：按实际所处的环节处理被改到的条目（version-stage.ts）：核对中、待你验收退回返工；受阻且解除后回到核对中的，
  // 把解除后要回到的状态改成返工中（仍然受阻）；返工中的并入待改清单；待开工、执行中不用处理（第一轮本来就要全部交回）。
  const rework = reworkForVersion(next, unmetNew, ctx.clock.now());
  next = rework.job;
  const reworked = rework.how === 'now';
  const deferred = rework.how === 'after_unblock';
  const before = job;
  const droppedUndo: Array<() => void> = [];
  try {
    if (reworked) {
      // 撤回这件事开着的条目（验收条目）；丢弃核对人排着的候选。
      withdrawJobInbox(ctx, job, '约定改了，需要重新交回');
      droppedUndo.push(dropJobEntries(ctx, reviewerId, job.id));
    } else if (deferred) {
      // 受阻期间改成解除后返工：核对人排着的旧候选没有用了（不撤回「停住了」条目，这件事仍然受阻）。
      droppedUndo.push(dropJobEntries(ctx, reviewerId, job.id));
    }
    if (resort !== null) {
      // 追加中心重排的交回记录；丢弃核对人排着的旧候选（下面第 4 步重新给他排「待核对」）。
      ctx.store.table('jobSubmissions').put(resort.submission);
      droppedUndo.push(() => { ctx.store.table('jobSubmissions').remove(resort!.submission.id); });
      droppedUndo.push(dropJobEntries(ctx, reviewerId, job.id));
      if (resort.review !== null) {
        // P74f：待你验收：通过的那次核对也按新编号追加一份；旧的验收条目撤回，交付记录清空，下面重新交付（新的交付卡和验收条目）。
        ctx.store.table('jobReviews').put(resort.review);
        droppedUndo.push(() => { ctx.store.table('jobReviews').remove(resort!.review!.id); });
        withdrawJobInbox(ctx, job, '约定删去了条目，重新交付');
        // 交付记录清空卡片编号（下面重新交付会落新的一张卡），修订号加 1：旧卡显示失效，只有新卡可以验收（P74f-2）。
        next = { ...next, inboxId: null, delivery: job.delivery == null ? null : { ...job.delivery, cardMessageId: null, checks: [], rev: (job.delivery.rev ?? 0) + 1 } };
      }
    }
    putJob(ctx, JobSchema.parse(next));
  } catch (error) {
    for (const undo of droppedUndo.reverse()) { try { undo(); } catch { /* 恢复出错只记日志。 */ } }
    try { putJob(ctx, before); } catch { /* 同上。 */ }
    throw error;
  }
  // 4. 事件、主题里的话、叫醒执行者（状态都写好之后才做）。
  const note = bare(version.changeNote);
  // P74r2b：提问由这一版回答：提问人是执行者且在干活的状态时，他这一次叫醒就是回答（唤醒的感知用回答事件的编号，
  // 他的唤醒包里看到「总管刚回答你：按约定第 n 版处理：……」）；提问人是核对人时，另外叫核对人。都不叫总管。
  const answeredId = ask === null ? null : newId('jev', ctx.rng);
  const askerName = ask === null ? '' : nameOf(ctx, ask.fromId, '员工');
  const executorAsked = ask !== null && ask.fromId === job.executorId;
  const base = reworked ? `约定第 ${versionNo} 版改了第 ${nos.join('、')} 条，请按新版本返工这几条`
    : deferred ? `约定第 ${versionNo} 版改了第 ${nos.join('、')} 条，这件事恢复后请按新版本返工这几条` : `约定第 ${versionNo} 版已生效，请接着做`;
  const summary = executorAsked ? `${askerName}的问题按约定第 ${versionNo} 版处理：${note}；${base}` : base;
  const woken = wakeWorkingExecutor(ctx, next, reworked ? 'returned' : 'resumed', summary, executorAsked ? answeredId! : eventId);
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: how === 'confirm' ? 'owner' : job.chiefId, kind: 'resumed', to: [job.executorId], refId: null,
    data: { versionNo, how, ...(nos.length > 0 ? { reworkNos: nos } : {}), ...(deferred ? { deferred: true } : {}), ...(resort !== null ? { remappedFrom: resort.submission.remappedFrom, removedNos: resort.removedNos } : {}),
      ...(woken ? {} : { woken: false }) } });
  // P74r2c：中心重排了交回记录：给核对人重新排「待核对」（不叫执行者，不占他的回合，轮次不变）。
  // P74r3（H2）：这件事此刻受阻时不叫（核对人可能就是停用的那位），解除受阻的几条路径会叫醒核对人，他按新编号核对。
  if (resort !== null && next.state === 'checking') {
    const queued = enqueueJobWake(ctx, { job: next, botId: reviewerId, why: 'to_review', eventId,
      summary: `「${jobTitleOf(ctx, job)}」约定第 ${versionNo} 版删去了条目，交回已按新编号重排，请对照约定逐条核对` });
    if (queued === null) ctx.logger.warn('约定删去条目后没有给核对人排上待核对（他此刻可能不在岗）', { jobId: job.id });
  }
  if (ask !== null) {
    let askerWoken = executorAsked && woken;
    if (!executorAsked && next.state === 'checking') {
      askerWoken = enqueueJobWake(ctx, { job: next, botId: ask.fromId, why: 'answered', eventId: answeredId,
        summary: `你的问题按约定第 ${versionNo} 版处理：${note}` }) !== null;
    }
    appendJobEvent(ctx, { id: answeredId!, jobId: job.id, actor: 'hub', kind: 'answered', to: [ask.fromId], refId: ask.eventId,
      data: { text: `按约定第 ${versionNo} 版处理：${note}。`, byAgreementNo: versionNo, ...(askerWoken ? {} : { woken: false }) } });
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: answeredId,
      text: `${askerName}的问题按约定第 ${versionNo} 版处理：${note}。` });
  }
  if (how === 'amend') {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: `约定第 ${versionNo} 版：${note}。` });
  } else {
    // P74r12：不再把暂停的清单拼进这句话（清单每行都是片段，拼起来读不通）；只写暂停的总处数，清单在约定卡上。
    postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'reply', refId: job.id,
      text: hadPause
        ? `约定第 ${versionNo} 版已按你的确认固定：${note}。${executorName}已继续做暂停的 ${pausedCount(job.pause!)} 处（见约定卡），交付时间不变。`
        : `约定第 ${versionNo} 版已按你的确认固定：${note}。` });
    if (reworked || deferred) {
      postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId,
        text: reworked ? `约定第 ${versionNo} 版改了第 ${nos.join('、')} 条，${executorName}按新版本返工这几条。`
          : `约定第 ${versionNo} 版改了第 ${nos.join('、')} 条，这件事恢复后${executorName}按新版本返工这几条。` });
    }
    if (resort !== null) {
      // 固定句（中心名义）：说明条目重新编号了，核对按新编号进行。
      postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId,
        text: `约定第 ${versionNo} 版删去了第 ${resort.removedNos.join('、')} 条，其余条目重新编号，${resort.review !== null ? '交付卡按新编号重新给你' : '核对按新编号进行'}。` });
    }
  }
  // P74f：待你验收的事，约定新版本固定后没有退回返工（没有变，或只删去了条目、已重排）：重新交付——
  // 新的交付卡和验收条目；「没有变」时旧交付卡恢复可验收，只补放验收条目。出错只记日志，巡检会补齐。
  if (!reworked && !deferred && next.state === 'awaiting_owner') {
    try { deliverJob(ctx, ctx.store.table('jobs').get(job.id) ?? next); } catch (error) { ctx.logger.warn('约定固定后重新交付失败', { jobId: job.id, error: String(error) }); }
  }
  // P74r4a 第 2 条：说明已失效、这件事仍受阻在等总管：立即给总管排一次唤醒，让他按新约定重新判断。
  wakeChiefAfterExpiry(ctx, job.id);
  // P76f：这一版是主人选了「缩小范围」之后总管出的新版本：清记号、预计追加一项、预算线造成的受阻在这里解除并叫人、重算预计消耗。
  if (how === 'confirm') {
    try { afterNarrowLocked(ctx, job.id, versionNo); } catch (error) { ctx.logger.warn('缩小范围的新版本确认后的后续没有做成', { jobId: job.id, error: String(error) }); }
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.executorId);
}

/**
 * 待你验收时只删去了条目：通过的那次核对按新编号重排出一份（只追加，原记录不动），对应中心重排的那份交回。
 * 被删去的条目不带，其余结论、说明原样。找不到通过的核对（旧数据）返回 null，交付卡就用现有的核对记录。
 */
export function remapPassedReview(ctx: HubContext, job: Job, source: JobSubmission, remap: ReturnType<typeof remapItems>, remapped: JobSubmission): JobReview | null {
  const last = reviewsOf(ctx, job.id).filter(row => row.submissionId === source.id).at(-1) ?? null;
  if (last === null) return null;
  const items = last.items.flatMap(item => {
    const target = remap.toNew.get(item.no);
    return target === undefined ? [] : [{ ...item, no: target }];
  }).sort((a, b) => a.no - b.no);
  if (items.length === 0) return null;
  const spotChecked = last.spotChecked.flatMap(no => remap.toNew.get(no) ?? []);
  // byCenter：标明这份核对是中心重排的、不是核对人做的一轮（回执和试用反馈数核对轮数时只排除它，P74r4a 第 5 条）。
  return { ...last, id: newId('jrv', ctx.rng), submissionId: remapped.id, items, spotChecked, createdAt: ctx.clock.now(), byCenter: true };
}

// ---------------------------------------------------------------------------
// 三、总管撤销这次重新确认
// ---------------------------------------------------------------------------

/**
 * 约定待确认的新版本被撤下时，这件事上与它有关的几处回到一致的状态（总管撤销重新确认、停止这件事共用）：
 * 暂停信息清空；提问是为这一版出的，主人不确认：提问仍未回答（清掉「已转成约定第 n 版」的记号），这件事在等谁回到总管（P74r2b）。
 * 「已处理到第几版」不动：待确认的版本从没固定过，没有收尾可补。纯函数，不改入参。
 */
export function clearReopenLinks(job: Job): Job {
  const openAsk = job.openAsk !== null && job.openAsk.agreementNo != null ? { ...job.openAsk, agreementNo: null } : job.openAsk;
  return { ...job, pause: null, openAsk };
}

/**
 * 主人不确认（例如回「不限」），总管用 withdraw 撤销了这次重新确认之后调用：
 * 清掉暂停；工作往来一句；给执行者排一次唤醒，暂停的部分照原版本接着做。同步执行，调用方捕获错误。
 */
export function onReopenWithdrawn(ctx: HubContext, agreementId: string): void {
  const agreement = ctx.store.table('agreements').get(agreementId);
  const job = activeJobOfAgreement(ctx, agreementId);
  if (!agreement || job === null || job.pause === null) return;
  const keptNo = agreement.versions.find(row => row.state === 'locked')?.no ?? 0;
  const droppedNo = job.pause.versionNo;
  const next = JobSchema.parse({ ...clearReopenLinks(job), updatedAt: ctx.clock.now() });
  putJob(ctx, next);
  // P76f：主人不采用缩小范围的新版本：不再等它，总管唤醒包里的「缩小范围」一段随之消失。
  if (ctx.store.table('jobNotices').get(job.id)?.narrowRequestedAt != null) patchNotice(ctx, job.id, { narrowRequestedAt: null });
  // P74r4a-m1：待确认的版本被撤销：确认期间已标 reconfirming 的说明改标 withdrawn（约定没有变，只是这次说明在确认期间失效了）。
  // 在上面写好最新记录之后再标，才不会被旧记录盖掉。
  invalidateOpenEscalation(ctx, job.id, 'withdrawn');
  const eventId = newId('jev', ctx.rng);
  wakeWorkingExecutor(ctx, next, 'resumed', `约定第 ${droppedNo} 版没有采用，仍按第 ${keptNo} 版做，请接着做`, eventId);
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: job.chiefId, kind: 'resumed', to: [job.executorId], refId: null,
    data: { versionNo: droppedNo, withdrawn: true, keptNo } });
  postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId,
    text: `约定第 ${droppedNo} 版没有采用，仍按第 ${keptNo} 版做。暂停的部分照第 ${keptNo} 版继续做。` });
  // P74f：待你验收时撤销：同「没有变」，重新放出验收条目，交付卡恢复可验收（补充要求第 2 节第 3 点）。
  if (next.state === 'awaiting_owner') deliverJob(ctx, next);
  // P74r4a 第 2 条：待确认的版本被撤销：这件事的说明（确认期间已失效）仍受阻在等总管时，立即叫总管重新判断。
  wakeChiefAfterExpiry(ctx, job.id);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.executorId);
}
