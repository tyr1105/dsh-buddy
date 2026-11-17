/**
 * 主人答复「预计消耗」「停住了」两类条目之后，这件事怎样继续（P74f-2，任务卡第 8 节，补充要求 3.4 与 3.5；P76f 改写第一类）。
 *
 * 预计消耗条目（事项键 job:<id>:cap:<预算线>，原来叫回合上限条目）：
 * - 新条目的三个办法「追加 n 个回合」「缩小范围」「暂停」，旧条目的「再给 8 个回合」「暂停」：处理在 budget-answer.ts；
 *   本文件只负责找到条目、校验是不是最新的一条，再交给它。
 * 「停住了」条目（事项键 job:<id>:stall:<序号>）：
 * - 「再提醒一次」：叫醒此刻该动的人（总管自己核对没有动静时叫总管），兜底的连续计数从头算（追加一条不是兜底的事件），条目编号清空；
 * - 「暂停」：这件事转为「你已暂停」（之后总管 resume 才能恢复）。
 * 入口有两个：「待你处理」里的按钮（inbox-answer.ts 分流到这里）和界面命令（answerJobCap、answerJobStall）。
 *
 * 分三段（方案 6.4）：校验（失败什么都没写）；写状态（有备份，叫不醒就整体恢复，见 blocked-commit.ts）；主人看得见的话（出错只记日志）。
 */
import { z } from 'zod';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Job } from '../model/job.js';
import { ThreadMessageSchema, type InboxItem } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { postThread, wakeForOwnerMessage } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { STALL_OPTIONS, takeOverNameOf } from './block-options.js';
import { commitAnswer, type BlockedAnswerVia } from './blocked-commit.js';
import { answerBudgetItem } from './budget-answer.js';
import { expectedActorOf, jobTitleOf } from './chain.js';
import { latestEstimate } from './estimate.js';
import { patchNotice, restoreNotice } from './notices.js';
import { canTakeOver } from './stall-takeover.js';
import { dropJobEntries } from './start-wake.js';
import { holdForOwner } from './unblock.js';
import { softly, type UndoSteps } from './work-common.js';

/** 对着旧条目答复时的拒绝文字（P74r4a 第 8 条）。 */
export const STALE_ITEM_TEXT = '这条提醒已经不是最新的，请在最新的一条上答复。';

export type { BlockedAnswerVia };

// 「没有进展」条目的选项文字只在 block-options.ts 定义一次，这里转出（原来的引用方不用改）。
export { STALL_OPTIONS };

/** 这件事开着的某一类条目；没有为 null。 */
function openItemOf(ctx: HubContext, jobId: string, kind: 'cap' | 'stall'): InboxItem | null {
  return ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:${kind}:`))[0] ?? null;
}

/** 答复预计消耗条目。校验失败抛出中文错误且什么都没写；返回更新后的事。 */
export function answerJobCap(ctx: HubContext, input: { jobId: string; answer: string; via: BlockedAnswerVia; itemId?: string }): Job {
  const job = ctx.store.table('jobs').get(input.jobId);
  if (job === null) throw new Error('jobId：没有这件事');
  const item = openItemOf(ctx, job.id, 'cap');
  // P76r3（R10 第 2 点）：有预计的事统一写「预计消耗」；没有预计的旧事保留「回合上限」。
  const capWord = latestEstimate(ctx, job.agreementId) === null ? '回合上限' : '预计消耗';
  if (item === null) throw new Error(`这条提醒已经处理过，或这件事现在不在等你答复${capWord}`);
  if (input.itemId !== undefined && input.itemId !== item.id) throw new Error(STALE_ITEM_TEXT);
  return answerBudgetItem(ctx, job, item, input.answer, input.via);
}

/** 答复「停住了」条目。校验失败抛出中文错误且什么都没写；返回更新后的事。 */
export function answerJobStall(ctx: HubContext, input: { jobId: string; answer: string; via: BlockedAnswerVia; itemId?: string }): Job {
  const job = ctx.store.table('jobs').get(input.jobId);
  if (job === null) throw new Error('jobId：没有这件事');
  const item = openItemOf(ctx, job.id, 'stall');
  if (item === null) throw new Error('这条提醒已经处理过，或这件事现在不在等你答复');
  if (input.itemId !== undefined && input.itemId !== item.id) throw new Error(STALE_ITEM_TEXT);
  const [retry, hold] = STALL_OPTIONS;
  const answer = input.answer.trim();
  // P76g：条目有「换{名字}接手」时，那一项也是合法答案（只认这条条目自己写出来的那一项）。
  const takeOverName = item.options.includes(answer) ? takeOverNameOf(answer) : null;
  if (answer !== retry && answer !== hold && takeOverName === null) {
    const offered = item.options.find(text => takeOverNameOf(text) !== null);
    throw new Error(offered === undefined ? `answer：只能是「${retry}」或「${hold}」` : `answer：只能是「${offered}」「${retry}」「${hold}」`);
  }
  const now = ctx.clock.now();
  const title = jobTitleOf(ctx, job);
  // 换人接手：答复时再核对一次这位现在还能不能接手（停用、归档、已经在这件事里都不行）；核对不过什么都不写。
  if (takeOverName !== null) {
    const stalledId = expectedActorOf(job);
    const bot = stalledId === null ? null : ctx.store.table('bots').list(row => row.name === takeOverName).find(row => canTakeOver(ctx, job, stalledId, row)) ?? null;
    if (bot === null) throw new Error(`${takeOverName}现在不能接手，请选别的办法。`);
  }
  const next: Job = answer === hold ? holdForOwner(job, now) : { ...job, inboxId: null, updatedAt: now };
  // 「暂停」：这件事的候选一并清掉（再叫的人不会自己醒来）；失败时放回去。
  const dropped: Array<() => void> = answer === hold
    ? [...new Set(ctx.store.table('queue').list(row => row.jobId === job.id).map(row => row.botId))].map(botId => dropJobEntries(ctx, botId, job.id)) : [];
  // 「再提醒一次」：重新唤醒的计时重新开始（清空 rewakeAt）。要撤销时原样写回。
  const clearRewake = (undo: UndoSteps): void => {
    const before = patchNotice(ctx, job.id, { rewakeAt: null });
    undo.push(() => { restoreNotice(ctx, job.id, before); });
  };
  let done: { job: Job; wokenId: string | null };
  try {
    done = commitAnswer(ctx, job, item, next, answer, 'stall', input.via,
      answer === retry ? { summary: `主人选了再提醒一次：「${title}」已有一阵子没有进展，请接着处理或说明卡在哪` } : null,
      answer === retry ? { retry: true } : takeOverName !== null ? { takeOver: takeOverName } : {},
      answer === retry ? { writes: clearRewake } : {});
  } catch (error) {
    for (const undo of dropped.reverse()) { try { undo(); } catch { /* 恢复出错只记日志。 */ } }
    throw error;
  }
  // 换人接手：不改这件事的状态，以你的话叫醒总管，由总管用改派换人（做法与选办法一致）。
  if (takeOverName !== null) {
    const sentence = `换${takeOverName}接手「${title}」。`;
    const message = ThreadMessageSchema.parse({ id: newId('m', ctx.rng), thread: job.chiefId, from: 'owner', kind: 'chat', text: sentence,
      refId: job.id, createdAt: now, readAt: now });
    softly(ctx, '你说的话', () => { ctx.store.log('thread').append(message); ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId); });
    softly(ctx, '叫醒总管', () => {
      const chief = ctx.store.table('bots').get(job.chiefId);
      if (chief) wakeForOwnerMessage(ctx, chief, message);
    });
    ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
    return done.job;
  }
  softly(ctx, '总管私聊里的话', () => {
    const who = done.wokenId === null ? null : done.wokenId === job.chiefId ? '总管' : ctx.store.table('bots').get(done.wokenId)?.name ?? '对方';
    postThread(ctx, { thread: job.chiefId, from: answer === retry ? 'hub' : job.chiefId, kind: answer === retry ? 'system' : 'reply', refId: job.id,
      text: answer === retry ? (who === null ? `已再提醒「${title}」。` : `已再提醒${who}一次。`) : `已暂停「${title}」。要继续做时告诉我。` });
  });
  ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
  return done.job;
}

// ---------------------------------------------------------------------------
// 界面命令
// ---------------------------------------------------------------------------

/**
 * itemId（P74r4a 第 8 条）：可选，按钮所在那条提醒的编号。传了而它不是这件事现在开着的那一条（旧卡上的按钮），拒绝；
 * 不传时行为不变（答复这件事现在开着的那一条）。
 */
const BlockedCommandSchema = z.strictObject({ jobId: recordId('job'), answer: z.string({ error: '必须是文字' }).min(1, '答案不能为空'), itemId: recordId('i').optional() });

/** 界面命令 answerJobCap。 */
export function answerJobCapCommand(ctx: HubContext, raw: unknown): { jobId: string } {
  const input = parseInput(BlockedCommandSchema, raw, '预计消耗的答复');
  answerJobCap(ctx, { jobId: input.jobId, answer: input.answer, via: 'command', ...(input.itemId === undefined ? {} : { itemId: input.itemId }) });
  return { jobId: input.jobId };
}

/** 界面命令 answerJobStall。 */
export function answerJobStallCommand(ctx: HubContext, raw: unknown): { jobId: string } {
  const input = parseInput(BlockedCommandSchema, raw, '没有进展的答复');
  answerJobStall(ctx, { jobId: input.jobId, answer: input.answer, via: 'command', ...(input.itemId === undefined ? {} : { itemId: input.itemId }) });
  return { jobId: input.jobId };
}
