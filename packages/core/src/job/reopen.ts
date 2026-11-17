/**
 * 主人指出不符：hub_job_manage 的 reopen（P74f，方案 5.5 末段）。
 *
 * 主人验收时说「第 4 条不对：……」，总管用 reopen 对到条目返工：只返工被指出的那几条，其余保持通过。
 * 条件：调用者是这件事的总管；这一回合是主人发话叫醒的；这件事正等主人验收；序号都在当前约定的「怎样算做完」里、不重复。
 * 否则拒绝，文字说明只能在主人验收这件事时按主人指出的条目返工。
 *
 * 分三段（方案 6.4）：校验；写状态（有备份，全部成功才算数：状态转返工中、阶段加 1、轮数归零；验收条目撤回；
 * 主人指出的记录落在这件事上；事件；给执行者排唤醒，叫不醒就整体恢复）；主人看得见的话。
 * 主人指出的记录（阶段、条目序号和原文、问题、改到什么程度算过、核对为什么漏了、主人那句话的消息编号、时间）
 * 除了事件，还落在这件事的 ownerReturns 上：第四块验收之后复盘要读，不受事件日志只保留近 14 天的影响。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { JobSchema, type JobUnmet } from '../model/job.js';
import { refutePrecedentsByOwnerWords } from '../memory/precedent-refute.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import { evidenceMessageIds } from '../wake/chief-packet.js';
import type { JobManageArgs } from './assign.js';
import { jobTitleOf } from './chain.js';
import { lockedVersionOf } from './files.js';
import { agreementPendingNo } from './deliver.js';
import { assertOpen, chiefJobOf, currentWake, isOwnerTurn, requireChief, requireFields } from './manage-common.js';
import { mentionsOwnerWord, ownerTextProblem } from './owner-text.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { queueWake, runUndo, softly, type UndoSteps } from './work-common.js';

/** 不满足条件时的拒绝文字（原文）。 */
export const REOPEN_REFUSED_TEXT = '只能在主人验收这件事时，按主人指出的条目返工';

/** 这一回合里叫醒总管的那条主人消息的编号；取不到为 null。 */
function ownerMessageId(ctx: HubContext, tc: ToolContext): string | null {
  const wake = currentWake(ctx, tc);
  if (wake === null) return null;
  const ids = evidenceMessageIds(ctx, wake);
  const rows = ctx.store.log('thread').recent(200, row => row.from === 'owner' && ids.has(row.id));
  return rows.length === 0 ? null : rows.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a)).id;
}

/** P74r12：reopen 成功的返回文字在原句之后加的一句（逐字）。 */
export const REOPEN_REPLY_REMINDER = '回复主人时写明三样：返工哪几条、核对当时为什么没有发现、预计什么时候再交。';

/** reopen 的入口：返回给模型看的一句话。 */

export async function runJobReopen(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '按主人指出的条目返工');
  requireFields('reopen', args, ['jobId', 'items', 'missed']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '返工');
  if (!isOwnerTurn(ctx, tc) || job.state !== 'awaiting_owner') throw new Error(REOPEN_REFUSED_TEXT);
  const pendingNo = agreementPendingNo(ctx, job);
  if (pendingNo !== null) throw new Error(`约定第 ${pendingNo} 版在等主人确认，确认之后再按主人指出的条目返工`);
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) throw new Error('这件事的约定找不到了，不能返工');
  const doneWhen = lockedVersionOf(agreement).content.doneWhen;
  const items = args.items!;
  if (items.length < 1 || items.length > D.REOPEN_ITEMS_MAX) throw new Error(`items：要写 1 到 ${D.REOPEN_ITEMS_MAX} 条`);
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (item.no < 1 || item.no > doneWhen.length) errors.push(`第 ${item.no} 条：「怎样算做完」一共 ${doneWhen.length} 条，没有这一条`);
    else if (seen.has(item.no)) errors.push(`第 ${item.no} 条：写了多次`);
    seen.add(item.no);
    // P74r14：每一条的问题和改到什么程度会显示给主人，称呼写「你」。
    for (const [name, text] of [['problem', item.problem], ['fixTo', item.fixTo]] as const) {
      const problem = ownerTextProblem(`第 ${item.no} 条的 ${name}`, text, { noOwnerWord: true });
      if (problem !== null && mentionsOwnerWord(text)) errors.push(problem);
    }
  }
  if (errors.length > 0) throw new Error(`返工被拒，没有写入任何东西：${errors.join('；')}`);
  const missed = args.missed!.trim();
  if (missed === '' || [...missed].length > D.NOTE_MAX_CHARS) throw new Error(`missed：1 到 ${D.NOTE_MAX_CHARS} 个字`);

  // ---- 第二段：写状态，有备份 ----
  const now = ctx.clock.now();
  const sorted = [...items].sort((a, b) => a.no - b.no);
  const unmet: JobUnmet[] = sorted.map(item => ({ no: item.no, problem: item.problem.trim(), fixTo: item.fixTo.trim() }));
  const nos = unmet.map(item => item.no).join('、');
  const messageId = ownerMessageId(ctx, tc);
  const record = { stage: job.stage, at: now, missed, messageId,
    items: unmet.map(item => ({ no: item.no, text: doneWhen[item.no - 1]!, problem: item.problem, fixTo: item.fixTo })) };
  const next = JobSchema.parse({ ...applyJobAction(job, { type: 'owner_return', unmet }, now), inboxId: null, ownerReturns: [...(job.ownerReturns ?? []), record] });
  const executor = ctx.store.table('bots').get(job.executorId);
  const executorName = executor?.name ?? '执行者';
  const eventId = newId('jev', ctx.rng);
  const open = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
  const undo: UndoSteps = [];
  try {
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    for (const item of open) {
      ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: `未通过：第 ${nos} 条`, answeredAt: now });
      undo.push(() => { ctx.store.table('inbox').put(item); });
    }
    queueWake(ctx, { job: next, botId: job.executorId, why: 'returned', eventId,
      summary: `主人验收「${jobTitleOf(ctx, job)}」时指出第 ${nos} 条不符，请只改这几条` }, undo, executorName);
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: chief.id, kind: 'owner_returned', to: [job.executorId], refId: messageId,
      data: { stage: job.stage, items: unmet, missed } });
  } catch (error) {
    await runUndo(ctx, undo, '返工', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`返工没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_owner_return', { jobId: job.id, nos: unmet.map(item => item.no) }, chief.id, now);
  // P76p：主人这句话明确否掉了这份约定里某条先例的选定项时，把旧先例改为「已被否掉」，不再作为出处引用。
  // 只动记忆，不影响返工；出错只记日志。新说法由这次返工和之后的约定版本生效。
  const ownerRow = messageId === null ? null : ctx.store.log('thread').all().find(row => row.id === messageId && row.from === 'owner') ?? null;
  if (ownerRow !== null) {
    try {
      await refutePrecedentsByOwnerWords(ctx, job.agreementId, ownerRow.text,
        { threadId: job.topicId, messageIds: [ownerRow.id], quote: ownerRow.text });
    } catch (error) {
      ctx.logger.warn('主人否掉的先例没有改成已被否掉', { jobId: job.id, error: String(error) });
    }
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.executorId);
  for (const item of open) emitInboxChange(ctx, item);

  // ---- 第三段：主人看得见的话 ----
  softly(ctx, '主题里的返工提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'system', refId: job.id, text: `返工中：第 ${nos} 条。在等：${executorName}。` });
  });
  // P74r12：成功之后提醒总管回复主人时要写的三样（实测里总管只写了返工哪一条）。
  return `已退回${executorName}返工第 ${nos} 条，核对人会在新一轮里核对。${REOPEN_REPLY_REMINDER}`;
}
