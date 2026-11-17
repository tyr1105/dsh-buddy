/**
 * 「执行者做不下去」的统一处理（P74c）：续排判断出执行者空手而归、兜底巡检叫了两次都没有进展，都走这里。
 * （P74d 的工具 block 会复用同一个函数，所以文字和步骤只写这一份。）
 *
 * 步骤（和派活一样，先改状态、再叫人，最后才写主人看得见的话）：
 *   1. 这件事转「受阻」（原因：执行者），保存；
 *   2. 给总管排一次 escalate 唤醒（总管要么回答让它恢复，要么向主人说明）；
 *   3. 追加 executor_blocked 事件（data.tried 是试过的办法，这里没有就是空数组）；
 *   4. 工作往来落一句「{执行者}做不下去：{原因}。已告诉总管。」（出错只记日志）。
 * 总管此刻不在岗时唤醒排不上：状态已经改好，兜底巡检会在他恢复在岗后重新叫他，所以不会丢。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { enqueueJobWake, jobTitleOf } from './chain.js';
import { ownerSafe } from './owner-text.js';
import { closeSentence } from '../util/sentence.js';

/** 受阻说明含内部名称时，给主人看的工作往来里换成的固定句。 */
const SHOWN_FALLBACK = '具体原因见这件事的主题';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';

/** 按完整字符截取并去掉首尾空白；空文字换成兜底说明（受阻说明不能为空）。 */
export function clipReason(text: string | null | undefined, fallback: string): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean === '' ? fallback : [...clean].slice(0, D.NOTE_MAX_CHARS).join('');
}

/**
 * 兜底转受阻时，按实际没有动的人写两句话（P74r1，R6）：summary 给总管（模型）看，work 是主人看得见的工作往来。
 * 执行者没有动写执行者（沿用「做不下去」的说法）、核对人没有动写核对人、总管没有动写总管，不能一律写成执行者做不下去。
 * stalledId 为空，或就是执行者：沿用原来的写法。
 */
function stalledWords(ctx: HubContext, job: Job, text: string, stalledId: string | undefined): { summary: string; work: string } {
  const title = jobTitleOf(ctx, job);
  const nameOf = (id: string, fallback: string): string => ctx.store.table('bots').get(id)?.name ?? fallback;
  if (stalledId === undefined || stalledId === job.executorId) {
    const name = nameOf(job.executorId, '执行者');
    // P74f-2（补充要求 3.3）：给主人看的工作往来里，模型写的原因要过内部名称检查，含内部名称的换成固定句。
    // P74r15：说明本身以句号结尾时不再接句号（closeSentence）。
    return { summary: `${name}在做「${title}」时做不下去：${text}`, work: `${name}无法继续：${closeSentence(ownerSafe(text, SHOWN_FALLBACK))}已告诉总管。` };
  }
  if (stalledId === job.chiefId) {
    // 总管欠的是回答（有未回答的提问）、核对结论，还是别的处理，按事实写；总管自己核对而没有提问的情形不会走到这里（见 sweep.ts）。
    const what = job.openAsk !== null ? '回答' : job.state === 'checking' ? '提交核对结论' : '处理';
    return { summary: `「${title}」一直在等你${what}，叫了你两次都没有进展：${text}`, work: `总管一直没有${what}：${closeSentence(ownerSafe(text, SHOWN_FALLBACK))}已再叫总管。` };
  }
  const name = nameOf(stalledId, '核对人');
  return { summary: `${name}在核对「${title}」时一直没有提交结论：${text}`, work: `${name}一直没有提交核对结论：${closeSentence(ownerSafe(text, SHOWN_FALLBACK))}已告诉总管。` };
}

/**
 * 把这件事标成「受阻」并叫醒总管。actor 是事件的发出者（执行者的员工 id，或 'hub'）。返回改完的事。
 * stalledId（P74r1）：兜底巡检转受阻时，实际没有动的人；省略表示执行者做不下去（续排和工具 block 的情形）。
 */
export function blockExecutor(ctx: HubContext, job: Job, text: string, now: number, actor: string, extra: Record<string, unknown> = {}, stalledId?: string,
  /** P74r15：说明本身已是完整的事实句（回合被中心结束）时，调用方自己写给总管和给主人看的两句，不套「做不下去」「叫了两次」的写法。 */
  wordsOverride?: { summary: string; work: string }): Job {
  const next = applyJobAction(job, { type: 'block', kind: 'executor', no: null, text }, now);
  putJob(ctx, next);
  const eventId = newId('jev', ctx.rng);
  const words = wordsOverride ?? stalledWords(ctx, job, text, stalledId);
  const entry = enqueueJobWake(ctx, {
    job: next, botId: job.chiefId, why: 'escalate', eventId,
    summary: words.summary,
  });
  if (entry === null) ctx.logger.warn('执行者做不下去，但没有排上总管的唤醒（总管此刻可能不在岗），等兜底巡检再叫', { jobId: job.id });
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor, kind: 'executor_blocked', to: [job.chiefId], refId: null,
    data: { text, tried: [], ...extra } });
  try {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: words.work });
  } catch (error) {
    ctx.logger.warn('执行者做不下去的工作往来没有落下', { jobId: job.id, error: String(error) });
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return next;
}
