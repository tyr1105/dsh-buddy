/**
 * 交付（P74f，方案 5.4）：核对通过之后，由中心把结果交给主人。不调用模型，也不叫醒总管。
 *
 * 一次交付做三件主人看得见的事：主题里以总管名义说一句话并落交付卡；总管私聊说一句；「待你处理」里放一条验收条目
 * （只有一个按钮「验收通过」，没有默认选项、不会到期）。随后在这件事记录上写交付记录（交付时核对的结果、交付卡消息编号）
 * 并追加 delivered 事件。核对通过时状态已经是「待你验收」，所以这里全部是第二段动作：出错只记日志。
 *
 * 为什么 deliverJob 可以重复调用：它只补缺的部分（没有交付卡才落话和卡，没有开着的验收条目才建条目），
 * 每个 tick 的巡检也调用它兜底（ensureDeliveries）：核对通过时进程退出、条目建失败，下一次巡检补齐，不会重复。
 * 约定新版本在等主人确认期间不交付、不补（此时主人面前不能有验收入口，见补充要求第 2 节）。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { deliveryCardTitle } from '../api/job-delivery-views.js';
import type { HubContext } from '../engine/context.js';
import { createInboxItem, emitInboxChange, JOB_ACCEPT_OPTION } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { jobTitleOf } from './chain.js';
import { lockedVersionOf } from './files.js';
import { appendJobEvent, isJobClosed } from './store.js';
import { softly } from './work-common.js';
import type { Job } from '../model/job.js';

/** 验收条目的事项键：job:<jobId>:accept:<阶段>。 */
export function acceptSubjectKey(jobId: string, stage: number): string {
  return `job:${jobId}:accept:${stage}`;
}

/**
 * 交付卡消息的 refId：delivery:<jobId>#<阶段>；同一阶段重新交付的卡带修订号：delivery:<jobId>#<阶段>~<修订号>
 * （P74f-2：只有最新一张可以验收，旧卡显示失效，所以两张卡的 refId 必须不同）。第一张卡（修订号 0）的写法不变。
 */
export function deliveryRefId(jobId: string, stage: number, rev = 0): string {
  return rev > 0 ? `delivery:${jobId}#${stage}~${rev}` : `delivery:${jobId}#${stage}`;
}

/** 这件事本阶段最新一张交付卡的修订号。 */
export function currentDeliveryRev(job: Pick<Job, 'stage' | 'delivery'>): number {
  return job.delivery != null && job.delivery.stage === job.stage ? job.delivery.rev ?? 0 : 0;
}

/** 这个阶段最新一张交付卡的消息（已落楼的）；没有为 null。 */
export function deliveryCardMessage(ctx: HubContext, job: Pick<Job, 'id' | 'topicId' | 'stage' | 'delivery'>) {
  const ref = deliveryRefId(job.id, job.stage, currentDeliveryRev(job));
  return ctx.store.log('thread').recent(1, row => row.thread === job.topicId && row.kind === 'job_card' && row.refId === ref)[0] ?? null;
}

/** 这个阶段开着的验收条目；没有为 null。 */
export function openAcceptItem(ctx: HubContext, job: Pick<Job, 'id' | 'stage'>) {
  const key = acceptSubjectKey(job.id, job.stage);
  return ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === key)[0] ?? null;
}

/** 约定新版本在等主人确认吗。 */
export function agreementPendingNo(ctx: HubContext, job: Pick<Job, 'agreementId'>): number | null {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  return agreement !== null && agreement.state === 'pending' ? agreement.versions[agreement.versions.length - 1]!.no : null;
}

/** 交付时核对的条目按时交付算符合：没有交付时间的算符合。 */
function deliveryChecks(job: Job): Array<{ no: number; ok: boolean }> {
  return job.deliveryItems.map(no => ({ no, ok: job.dueAt === null || job.deliveredAt === null || job.deliveredAt <= job.dueAt }));
}

/** 主题里那句话（总管名义）：全部符合，或有已过交付时间的条目。 */
export function deliverySentence(title: string, total: number, lateNos: number[], reviewerName: string | null): string {
  const who = reviewerName === null ? '我已逐条核对' : `${reviewerName}已逐条核对`;
  if (lateNos.length === 0) return `${title}已做完，${total} 条「怎样算做完」全部符合，${who}。请你验收。`;
  return `${title}已做完，${total - lateNos.length} 条全部符合，第 ${lateNos.join('、')} 条已过交付时间。请你验收。`;
}

/**
 * 交付：补齐缺的部分。核对通过后（onReviewPassed）调用，也被巡检兜底调用。返回是否做了什么。
 * 状态不是「待你验收」、约定新版本在等确认时什么都不做。
 */
export function deliverJob(ctx: HubContext, job: Job): boolean {
  if (job.state !== 'awaiting_owner' || agreementPendingNo(ctx, job) !== null) return false;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null) return false;
  let did = false;
  const title = jobTitleOf(ctx, job);
  const total = lockedVersionOf(agreement).content.doneWhen.length;
  const checks = deliveryChecks(job);
  const lateNos = checks.filter(check => !check.ok).map(check => check.no);

  // 一、验收条目（先建：它是会出错的一步；失败就整个交付稍后由巡检重来，主人什么都还没看到）。
  let inboxId = job.inboxId;
  if (openAcceptItem(ctx, job) === null) {
    const item = createInboxItem(ctx, {
      botId: job.chiefId, type: 'question', title: `${title}：待你验收`,
      // P74r4a 第 9 条：有已过交付时间的条目时不能写「全部符合」，与主题里那句一致。
      body: lateNos.length === 0 ? `${total} 条「怎样算做完」全部符合，已逐条核对。哪条不符合，在对话里写序号和问题。`
        : `${total - lateNos.length} 条符合，第 ${lateNos.join('、')} 条已过交付时间。哪条不符合，在对话里写序号和问题。`,
      options: [JOB_ACCEPT_OPTION], defaultOption: null, expiresAt: null, priority: 'P1',
      refId: job.id, subjectKey: acceptSubjectKey(job.id, job.stage), topicId: job.topicId,
    });
    inboxId = item.id;
    did = true;
  } else inboxId = openAcceptItem(ctx, job)!.id;

  // 二、主题里的话、交付卡、总管私聊（没有交付卡才落；落一次）。
  // 交付卡是否已落：看这件事上的交付记录（约定删去条目后重新交付时记录被清空，才会落新的一张）。
  let cardId: string | null = job.delivery != null && job.delivery.stage === job.stage ? job.delivery.cardMessageId : null;
  // P74r4a：交付卡落楼的时间一并记在交付记录上（打字验收判断「这句话是否晚于交付卡」用它，不读只保留 14 天的线程日志）。
  let cardAt: number | null = cardId !== null && job.delivery != null ? job.delivery.cardAt ?? null : null;
  const rev = currentDeliveryRev(job);
  if (cardId === null) {
    const reviewerName = job.reviewerId === null ? null : ctx.store.table('bots').get(job.reviewerId)?.name ?? '核对人';
    const now = ctx.clock.now();
    softly(ctx, '交付的话和卡片', () => {
      postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'reply', refId: job.id, text: deliverySentence(title, total, lateNos, reviewerName) });
      const card = postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'job_card', refId: deliveryRefId(job.id, job.stage, rev),
        text: deliveryCardTitle(title, lockedVersionOf(agreement).no) });
      cardId = card.id;
      cardAt = card.createdAt;
      postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: `${title}待你验收，内容在这件事的主题里。` });
    });
    if (cardId !== null) {
      did = true;
      appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'delivered', to: ['owner'], refId: deliveryRefId(job.id, job.stage, rev), at: now,
        data: { stage: job.stage, cardMessageId: cardId, deliveryChecks: checks.map(check => ({ no: check.no, ok: check.ok, ...(check.ok ? {} : { note: '已过交付时间' }) })) } });
    }
  }

  // 三、记在这件事上（条目编号、交付记录）。
  const fresh = ctx.store.table('jobs').get(job.id) ?? job;
  if (fresh.inboxId !== inboxId || fresh.delivery?.stage !== job.stage || (cardId !== null && fresh.delivery?.cardMessageId !== cardId)
    || (cardId !== null && cardAt !== null && fresh.delivery?.cardAt !== cardAt)) {
    ctx.store.table('jobs').put({ ...fresh, inboxId,
      delivery: { stage: job.stage, cardMessageId: cardId, ...(cardAt === null ? {} : { cardAt }), checks, ...(rev > 0 ? { rev } : {}) } });
  }
  if (did) {
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    ctx.emit(HUB_EVENT_SCOPES.inbox, job.chiefId);
    ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
    emitInboxChange(ctx, { botId: job.chiefId });
  }
  return did;
}

/** 每个 tick 的兜底：待你验收的事，缺交付卡或缺验收条目的补齐；出错只记日志，一件事出错不影响别的事。 */
export function ensureDeliveries(ctx: HubContext): void {
  for (const job of ctx.store.table('jobs').list(row => row.state === 'awaiting_owner' && !isJobClosed(row))) {
    softly(ctx, '补齐交付', () => { deliverJob(ctx, job); });
  }
}
