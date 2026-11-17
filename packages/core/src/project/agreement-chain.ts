/**
 * 执行链回合里，总管为一个未回答的提问出约定新版本的那个窄例外（P74r2b）。
 *
 * 为什么有这个例外：第一块的规则是「约定只能根据主人的话提交或修改」，所以提交必须发生在主人发消息叫醒的回合里。
 * 但执行者、核对人的提问是在执行链回合里送到总管的（不是主人发起的回合）。约定推不出答案的提问，主人确认过的设计是
 * 「总管出新版本请主人确认」，规则却把这条路挡住了：总管什么都做不了，约 3 小时后主人才收到一条不含问题的「停住了」。
 * 新版本本身不会自己生效，要主人确认才固定，所以给这一种情形开一个范围很窄的例外，不违背规则的原则。
 *
 * 例外四个条件缺一不可（见 chainReviseAsk）。其余情形在执行链回合里照旧拒绝。
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { WakeTicket } from '../model/wake.js';
import { isJobClosed, openAskText } from '../job/store.js';
import type { AgreementSubmitInput } from './agreement-content.js';

/** 不是主人的话叫醒的回合里提交约定被拒的文字（原文，第一块定的）。 */
export const NOT_OWNER_TURN_TEXT = '约定只能根据主人的话提交或修改：这一回合不是主人发消息叫醒的';
/** 执行链回合里对这件事自己的约定 revise，但这件事没有未回答的提问时的拒绝文字（原文）。 */
export const NO_OPEN_ASK_TEXT = `${NOT_OWNER_TURN_TEXT}。只有执行者或核对人的提问在约定里推不出答案时，才能在这里用 mode revise 出新版本请主人确认。`;

/** 执行链回合里写了 answersAsk: false 时的拒绝文字（原文）：这一回合出新版本只能是为了回答提问。 */
export const CHAIN_ANSWERS_FALSE_TEXT = '这一回合只有为了回答这个提问才能出新版本，answersAsk 不能写 false。';

/**
 * P74r3（H1）：主人发起的回合里，这份约定有进行中的事、这件事有未回答且还没关联到某个版本的提问，
 * 而总管没写 answersAsk 时的拒绝文字（原文）。提问原文超过 80 字截断加「…」。
 * 为什么要总管写明：主人这一回合说的可能是另一件不相干的改动，中心不能替总管判断这一版是不是在回答那个提问。
 */
export function undeclaredAskText(ctx: HubContext, job: Job): string {
  const ask = job.openAsk!;
  const asker = ctx.store.table('bots').get(ask.fromId)?.name ?? '员工';
  const chars = [...(openAskText(ctx, job) ?? '（问题原文没有留在记录里）').replace(/\s+/g, ' ').trim()];
  const shown = chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('');
  return `这件事有一个没回答的提问：${asker}问「${shown}」。这一版是不是在回答它？是就写 answersAsk: true；不是就写 answersAsk: false，之后仍要用 hub_job_manage 的 answer 回答它。`;
}

/** 这件事有没有「未回答、且还没关联到某个约定版本」的提问（此时主人发起的回合里出新版本要写明 answersAsk）。 */
export function hasUnlinkedAsk(job: Pick<Job, 'openAsk'>): boolean {
  return job.openAsk !== null && job.openAsk.agreementNo == null;
}

/**
 * 放行的那一次 revise 的起因：这件事和它没回答的提问。
 * P76f：ask 为空表示起因不是提问，而是主人在预计消耗条目里选了「缩小范围」，总管为此出新版本（见 job/narrow.ts）。
 */
export interface ChainAsk { job: Job; ask: NonNullable<Job['openAsk']> | null }

/**
 * 执行链回合里总管能不能为这件事的一个提问出新版本。下面四个条件同时满足才放行，返回这件事和那条提问：
 * 1. 这一回合是这件事的执行链回合（唤醒单带这件事的编号），调用者是这件事的总管；
 * 2. input.agreementId 是这件事的约定，约定当前已固定；
 * 3. mode 是 revise；
 * 4. 这件事有未回答的提问；或（P76f）主人选了「缩小范围」、新版本还没出（jobNotices.narrowRequestedAt 不为空）。
 * 前三条不满足返回 null（调用方按原来的文字拒绝）；前三条满足而没有未回答的提问，用专门的文字拒绝（告诉总管什么时候才能这样做）。
 */
export function chainReviseAsk(ctx: HubContext, botId: string, wake: WakeTicket, input: AgreementSubmitInput): ChainAsk | null {
  if (!wake.jobId || input.mode !== 'revise' || input.agreementId === undefined) return null;
  const job = ctx.store.table('jobs').get(wake.jobId);
  if (!job || job.chiefId !== botId || job.agreementId !== input.agreementId || isJobClosed(job)) return null;
  const agreement = ctx.store.table('agreements').get(input.agreementId);
  if (!agreement || agreement.botId !== botId || agreement.state !== 'locked') return null;
  // P76f：主人选了「缩小范围」、新版本还没出：这一回合就是为它叫醒总管的，放行（新版本不会自己生效，主人确认才固定）。
  if (ctx.store.table('jobNotices').get(job.id)?.narrowRequestedAt != null) return { job, ask: null };
  if (job.openAsk === null) throw new Error(NO_OPEN_ASK_TEXT);
  return { job, ask: job.openAsk };
}
