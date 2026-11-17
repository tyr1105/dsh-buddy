/**
 * 复盘记录的推进与兜底（P75g 第 9 节）：建唤醒单时计数、回合结束记账、丢弃时改参与者状态、
 * 结束时落复盘小结、每个 tick 的兜底巡检。
 *
 * 为什么收在这个文件：参与者状态（queued/running/done/skipped/expired/capped）是复盘进度的唯一事实，
 * 写它的入口有四个（建单、交卡、丢弃、回合结束没有交卡），集中一处才不会漏改。
 * P75h 会在 onSkillTurnEnd 里补上核对与改写唤醒的处理；本文件给它留了位置。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/wake.js';
import type { WakeTicket } from '../model/wake.js';
import type { Job, SkillRun, SkillUpdate } from '../model/index.js';
import { postThread } from '../outreach/thread.js';
import { jobTitleOf } from '../job/chain.js';
import { localDateKey, parseLocalDateTime } from '../util/time.js';
import { removeEntry } from '../scheduler/queue.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { learnSubjectKey, parseSkillKey, retroSubjectKey, skillRunOfKey, skillcheckSubjectKey, tidySubjectKey } from './keys.js';
import { offDutyReason, patchParticipant } from './retro-plan.js';
import { pendingChecksFor } from './check-facts.js';
import { retroCardRefId } from './card.js';
import { runTitleOf } from './run-title.js';
import { learnChiefId, learnEndText } from './learn-end.js';
import { busyWithJob } from './tidy-sources.js';

// ---------------------------------------------------------------------------
// 参与者做完一件事之后的状态
// ---------------------------------------------------------------------------

/**
 * 参与者在这次复盘里做完一件事（提交、核对、改写）之后的状态：一般记 done；
 * 但队列里已经有他在这次复盘里的另一条技能类候选（例如他提交之后，别人改写完又要他再核对一次）时记 queued，
 * 否则闸门只认 queued，那条候选会被当成「已经做完」丢弃。reason 只在记 done 时写（例如 no_update）。
 */
export function settleParticipantAfterWork(ctx: HubContext, runId: string, botId: string, reason: 'no_update' | null = null): void {
  const waiting = ctx.store.table('queue').list(row => row.botId === botId && skillRunOfKey(ctx, row.subjectKey)?.id === runId).length > 0;
  if (waiting) patchParticipant(ctx, runId, botId, 'queued');
  else patchParticipant(ctx, runId, botId, 'done', reason);
}

/**
 * 这位员工在这次记录的这个回合里是不是已经提交过（propose、tidy）。
 * 用来区分「回合还开着、参与者因为别人改写完要他再核对而被改回 queued、他自己的复盘还没提交」和「已经提交过了」。
 * P75i：优先看参与者行上记下的提交所在的唤醒编号（proposedWakeId）：学习与整理的记录没有主题、不落复盘卡，
 * 靠复盘卡判断对它们恒为假。参与者行没有这个字段（旧行、没有提交过）时照旧看复盘卡：
 * 提交总会落一张复盘卡（没有更新时也落），回合开始之后落过的就是这个回合提交的。
 */
export function proposedInWake(ctx: HubContext, run: SkillRun, botId: string, wake: { id: string; startedAt: number }): boolean {
  const participant = run.participants.find(row => row.botId === botId);
  if (typeof participant?.proposedWakeId === 'string') return participant.proposedWakeId === wake.id;
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  if (job === null) return false;
  const ref = retroCardRefId(run.id, botId);
  return ctx.store.log('thread').all().some(row => row.thread === job.topicId && row.from === botId && row.refId === ref && row.createdAt >= wake.startedAt);
}

/**
 * 记下这位参与者提交所在的唤醒编号；wakeId 传 undefined 表示把这个字段去掉（撤销时恢复成「原来没有这个字段」，行与提交前逐字相同）。
 * 记录或参与者不存在时什么都不做。
 */
export function setProposedWake(ctx: HubContext, runId: string, botId: string, wakeId: string | null | undefined): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null || !run.participants.some(row => row.botId === botId)) return;
  ctx.store.table('skillRuns').put({ ...run, participants: run.participants.map(row => {
    if (row.botId !== botId) return row;
    const { proposedWakeId: _old, ...rest } = row;
    return wakeId === undefined ? rest : { ...rest, proposedWakeId: wakeId };
  }) });
}

// ---------------------------------------------------------------------------
// 计数：建唤醒单、回合结束
// ---------------------------------------------------------------------------

/**
 * 建技能类唤醒单时计一个回合（wake/ticket.ts 调）：所属记录 turnsUsed 加一、参与者改 running。
 * 出错只记日志，不能挡住投递（与执行链的 countJobTurn 同一口径）。
 */
export function countSkillTurn(ctx: HubContext, ticket: WakeTicket): void {
  const parsed = parseSkillKey(ticket.subjectKey ?? null);
  if (parsed === null) return;
  try {
    // 每周整理的键里放的是周一日期，按（周一日期、员工）找记录；其余键里放的是记录编号。
    const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
    if (run === null) return;
    ctx.store.table('skillRuns').put({ ...run, turnsUsed: run.turnsUsed + 1 });
    patchParticipant(ctx, run.id, ticket.botId, 'running');
  } catch (error) {
    try { ctx.logger.error('技能类回合计数失败', error); } catch { /* 日志出错也不能挡住投递。 */ }
  }
}

/**
 * 退还一个技能类回合（P75r5b，与执行链的 refundJobTurn 并列）：建唤醒单时计了一个回合、参与者改成 running，
 * 但这次没有真正开始（投递时员工的会话正被主人占用而撤掉唤醒单、投递失败、投递超过两分钟仍没有收到开始事件）。
 * 做法：所属记录的已用回合数减一（不小于 0），参与者从 running 改回 queued；候选仍在队列里，退避之后会再投递一次。
 * 为什么要退：不退的话，参与者停在 running，闸门会把他排着的候选当成「不是排队中」丢弃，记录永远结束不了；
 * 白白用掉的回合数还会让回合上限提前用完。出错只记日志，不能挡住后面的收尾。
 */
export function refundSkillTurn(ctx: HubContext, ticket: WakeTicket): void {
  if (parseSkillKey(ticket.subjectKey ?? null) === null) return;
  try {
    const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
    if (run === null) return;
    ctx.store.table('skillRuns').put({ ...run, turnsUsed: Math.max(0, run.turnsUsed - 1) });
    if (run.participants.find(row => row.botId === ticket.botId)?.state === 'running') patchParticipant(ctx, run.id, ticket.botId, 'queued');
  } catch (error) {
    try { ctx.logger.error('退还技能类回合失败', error); } catch { /* 日志出错也不能挡住后面的收尾。 */ }
  }
}

/**
 * 主人打断一个技能类回合（turn/interrupt.ts 调用）：这个回合确实跑过，已用回合数不退；
 * 参与者从 running 改回 queued，之后由兜底补排（补排的候选照常过闸门）。
 * 为什么要改：打断不经回合收尾，参与者会一直停在 running，记录永远结束不了。
 * 参与者此刻不是 running（例如这个回合里已经提交、记成了 done）时不动。出错只记日志，不能挡住打断。
 */
export function settleInterruptedSkillTurn(ctx: HubContext, ticket: WakeTicket): void {
  if (parseSkillKey(ticket.subjectKey ?? null) === null) return;
  try {
    const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
    if (run === null) return;
    if (run.participants.find(row => row.botId === ticket.botId)?.state === 'running') patchParticipant(ctx, run.id, ticket.botId, 'queued');
  } catch (error) {
    try { ctx.logger.error('技能类回合被打断后的收尾失败', error); } catch { /* 日志出错也不能挡住打断。 */ }
  }
}

/** 回合结束时把这一回合的 token 加进所属记录（finishTurn 在 recordUsage 之后调用，tokens 是记账后的值）。 */
export function addSkillTurnTokens(ctx: HubContext, ticket: WakeTicket, tokens: number): void {
  const parsed = parseSkillKey(ticket.subjectKey ?? null);
  if (parsed === null) return;
  try {
    const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
    if (run === null) return;
    ctx.store.table('skillRuns').put({ ...run, tokens: run.tokens + Math.max(0, Math.ceil(tokens)) });
  } catch (error) {
    try { ctx.logger.error('技能类回合记账失败', error); } catch { /* 同上。 */ }
  }
}

// ---------------------------------------------------------------------------
// 丢弃的收尾（select.ts 调）
// ---------------------------------------------------------------------------

/**
 * 技能类候选被闸门丢弃时改参与者状态：skill_expired（真的等了 7 天）改 expired、skill_cap（回合用完）改 capped
 * （只在参与者还是 queued/running 时改，done/skipped 保持原样），然后试一次结束这次复盘。
 * P75r5b：skill_stale（参与者不是排队中、找不到所属记录）只丢弃候选，不改参与者的状态，所以直接返回——
 * 以前它与 skill_expired 共用一个原因码，参与者停在 running 的记录会被误记成「等待超过 7 天」。
 * 出错只记日志，不能挡住后面的候选。
 */
export function settleDroppedSkillEntry(ctx: HubContext, entry: QueueEntry, by: string, now: number): void {
  const parsed = parseSkillKey(entry.subjectKey);
  if (parsed === null) return;
  if (by !== 'skill_expired' && by !== 'skill_cap') return;
  try {
    const run = skillRunOfKey(ctx, entry.subjectKey);
    const state = run?.participants.find(row => row.botId === entry.botId)?.state;
    if (run !== null && (state === 'queued' || state === 'running')) {
      patchParticipant(ctx, run.id, entry.botId, by === 'skill_expired' ? 'expired' : 'capped',
        by === 'skill_expired' ? 'skill_expired' : 'skill_cap');
    }
    if (run !== null) void maybeFinishRun(ctx, run.id);
  } catch (error) {
    try { ctx.logger.error('技能类候选丢弃后的收尾失败', { entryId: entry.id, by, error: String(error) }); } catch { /* 同上。 */ }
  }
}

// ---------------------------------------------------------------------------
// 下一步的安排（propose 与「回合结束没有交卡」共用）
// ---------------------------------------------------------------------------

/**
 * 一次复盘提交（有更新或说明没有可写的）之后排下一步（任务卡第 7 节「下一步」）：
 * - 有更新：按核对人分组，每位核对人一次唤醒。核对人是这件事的评审员、且评审员自己也要复盘（参与者 queued）时，
 *   排评审员的复盘唤醒（P75h 的唤醒包会把待核对的更新放在前面）；否则排技能核对唤醒。
 *   核对人不在参与者名单里时加一项（role: checker、state: queued）；已在名单里且状态是 done 时改回 queued（闸门只认 queued）。
 * - 没有更新：评审员要复盘就排评审员的复盘唤醒；否则什么都不排。
 *
 * 失败抛中文错误。做过的每一步都把撤销动作登记进调用方给的 undoSteps（包括抛出之前已做的），
 * 由调用方决定整体撤销（propose 在这里失败时倒序执行，保证「队列、记录都不变」）。
 */
export function arrangeNextSteps(ctx: HubContext, runId: string, submittedBotId: string, updates: SkillUpdate[], undoSteps: (() => void)[] = []): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null) throw new Error('复盘记录找不到了');
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = runTitleOf(ctx, run);
  // 撤销步骤写进调用方给的数组：中途抛出时调用方也拿得到已经做过的步骤，整体撤销。
  const runBefore = run;
  const nameOf = (botId: string): string => botId === job?.chiefId || ctx.store.table('bots').get(botId)?.role === 'chief' ? '总管' : ctx.store.table('bots').get(botId)?.name ?? '员工';

  /** 给某位参与者排一次唤醒（key 由调用方给）；入队失败抛中文错误。 */
  const wake = (botId: string, key: string, what: string): void => {
    const result = enqueueSkillWorkUndoable(ctx, { runId, botId, key, title });
    undoSteps.push(result.undo);
    if (result.entry === null) throw new Error(`没有排上${nameOf(botId)}的${what}（对方此刻可能不在岗）`);
  };

  if (updates.length > 0) {
    // 按核对人分组，每位核对人一次唤醒。
    const byChecker = new Map<string, SkillUpdate[]>();
    for (const update of updates) {
      const list = byChecker.get(update.checkerId) ?? [];
      list.push(update);
      byChecker.set(update.checkerId, list);
    }
    for (const [checkerId, list] of byChecker) {
      const participant = runBefore.participants.find(row => row.botId === checkerId);
      // 核对人是这件事的评审员、自己也要复盘：合并为一次复盘唤醒（P75h 的唤醒包把待核对的更新放在前面）。
      const mergeRetro = job !== null && checkerId === job.reviewerId && participant !== undefined && participant.state === 'queued';
      // 核对人不在名单里时加一项；已在名单里且 done 时改回 queued（两种都要先改状态再排唤醒）。
      if (!mergeRetro) {
        const before = ctx.store.table('skillRuns').get(runId)!;
        const current = before.participants.find(row => row.botId === checkerId);
        if (current === undefined) {
          ctx.store.table('skillRuns').put({ ...before, participants: [...before.participants, { botId: checkerId, role: 'checker', sourceIds: [], state: 'queued', reason: null }] });
          undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
        } else if (current.state === 'done') {
          ctx.store.table('skillRuns').put({ ...before, participants: before.participants.map(row => row.botId === checkerId ? { ...row, state: 'queued', reason: null } : row) });
          undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
        } else if (current.state === 'skipped' && current.reason === 'no_checker') {
          // 总管自己漏判、这件事没有评审员，所以记了「没有核对人」不复盘（P75g）；现在执行者的更新由他核对：
          // 这一行改成纯核对人（去掉他自己的出处，他不复盘，免得兜底再给他排一次没有核对人的复盘），状态 queued。
          ctx.store.table('skillRuns').put({ ...before, participants: before.participants.map(row => row.botId === checkerId
            ? { ...row, role: 'checker' as const, sourceIds: [], state: 'queued' as const, reason: null } : row) });
          undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
        }
      }
      wake(checkerId, mergeRetro ? retroSubjectKey(runId, checkerId) : skillcheckSubjectKey(runId, checkerId), mergeRetro ? `复盘：${title}` : `核对技能更新：${title}`);
    }
    return;
  }
  // 没有更新：评审员要复盘就排评审员的复盘；否则什么都不排。
  // 提交的就是评审员自己时不再排他（他是 queued 只可能是别人改写完要他再核对，那条候选已经在队列里）。
  const reviewer = runBefore.participants.find(row => row.role === 'reviewer' && row.state === 'queued' && row.botId !== submittedBotId);
  if (reviewer !== undefined) wake(reviewer.botId, retroSubjectKey(runId, reviewer.botId), `复盘：${title}`);
}

// ---------------------------------------------------------------------------
// 结束与小结
// ---------------------------------------------------------------------------

/** 复盘小结的文字（任务卡第 9 节，逐字按顺序拼）。 */
export function retroSummaryText(run: SkillRun, updates: SkillUpdate[], names: Record<string, string>): string {
  const parts: string[] = [];
  const passed = updates.filter(row => row.state === 'passed');
  if (passed.length > 0) {
    let line = `${passed.length} 条技能更新核对通过，写入技能库。`;
    const rewritten = passed.filter(row => row.rewrites > 0).length;
    if (rewritten > 0) line += `其中 ${rewritten} 条改写后通过。`;
    parts.push(line);
  }
  const abandoned = updates.filter(row => row.state === 'abandoned');
  if (abandoned.length > 0) parts.push(`${abandoned.length} 条未通过核对，只留在记录里。`);
  // P75r5b（审查 L1）：「未完成核对」写的是谁的更新没有核完（提交人），不是回合用完的那位参与者的名字：
  // 核对人的回合用完时，没核完的是提交人的更新。回合用完的参与者名下没有等待处理的更新时（例如执行者自己没有提交），
  // 仍写他自己的名字（纯核对人除外：他没有自己的更新）。同一个名字只写一句。
  const unfinished = updates.filter(row => row.state === 'checking' || row.state === 'rewrite');
  const owed = new Set<string>();
  for (const row of run.participants.filter(item => item.state === 'capped')) {
    const waiting = unfinished.filter(update => (update.state === 'checking' ? update.checkerId : update.botId) === row.botId);
    const owners = waiting.length > 0 ? waiting.map(update => update.botId) : row.role === 'checker' ? [] : [row.botId];
    for (const botId of owners) {
      if (owed.has(botId)) continue;
      owed.add(botId);
      parts.push(`复盘回合用完，${names[botId] ?? '员工'}的更新未完成核对。`);
    }
  }
  for (const row of run.participants.filter(item => item.state === 'expired')) {
    parts.push(`${names[row.botId] ?? '员工'}的复盘等待超过 7 天，未进行。`);
  }
  if (parts.length === 0) parts.push('复盘没有新的技能更新。');
  return parts.join('');
}

/**
 * 结束一次复盘：所有参与者都不是 queued/running、且这次的更新都不是 checking/rewrite 时写 endedAt，
 * 在主题落复盘小结（work，from 为中心，refId retro-summary:<runId>），小结只落一次（summaryPostedAt）。
 */
export function maybeFinishRun(ctx: HubContext, runId: string): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null || run.endedAt !== null || run.summaryPostedAt !== null) return;
  // 学习：主人还没选会话时参与者是空的，这不是「做完了」，是在等主人选；不能当成没有任何事要做而结束。
  if (run.kind === 'learn' && run.learn?.sessionId == null) return;
  const busy = run.participants.some(row => row.state === 'queued' || row.state === 'running');
  if (busy) return;
  let updates = ctx.store.table('skillUpdates').list(row => row.runId === run.id);
  // 等某人处理的更新（核对中等核对人、等待改写等提交人）：负责人是 done 时说明他还有事要做（兜底会重新叫他），不能结束；
  // 负责人已经不可能再做（回合用完、等待过期、不在岗）时不能让整次复盘永远结束不了。
  const responsibleState = (update: SkillUpdate) =>
    run.participants.find(row => row.botId === (update.state === 'checking' ? update.checkerId : update.botId))?.state;
  const waiting = updates.filter(row => row.state === 'checking' || row.state === 'rewrite');
  // 负责人不在岗（skipped）的：这条更新放弃，原因写明，小结里算「未通过核对」；
  // 负责人回合用完或等待过期的：更新保持原状，由小结里「复盘回合用完」「等待超过 7 天」两句说明。
  for (const update of waiting) {
    if (responsibleState(update) !== 'skipped') continue;
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: update.state === 'checking' ? '核对人没有在岗' : '提交人没有在岗', updatedAt: ctx.clock.now() });
  }
  updates = ctx.store.table('skillUpdates').list(row => row.runId === run.id);
  if (updates.some(row => (row.state === 'checking' || row.state === 'rewrite') && !['capped', 'expired', undefined].includes(responsibleState(row)))) return;
  // P75r5b（审查 L1）：记录结束时仍在「核对中」「等待改写」的更新一律改为放弃，原因按实际写，之后不会再显示成「核对中」。
  // 小结与学习结束句仍用放弃之前的更新列表（它们按参与者状态写「回合用完」「等待超过 7 天」，不把这些更新算作「未通过核对」）。
  const finishing = updates;
  const stranded = updates.filter(row => row.state === 'checking' || row.state === 'rewrite');
  const abandonedAt = ctx.clock.now();
  for (const update of stranded) {
    const reason = responsibleState(update) === 'expired' ? '等待超过 7 天'
      : run.kind === 'learn' ? '学习回合用完' : run.kind === 'tidy' ? '整理回合用完' : '复盘回合用完';
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: reason, updatedAt: abandonedAt });
  }
  // 每周整理：没有主题也没有小结，活动流从记录表生成；写 endedAt 就是结束。
  if (run.kind === 'tidy') { ctx.store.table('skillRuns').put({ ...run, endedAt: ctx.clock.now() }); return; }
  // 学习：结束时在总管私聊以总管名义落一句结果（没有主题、不落复盘小结）。先落消息、成功之后才写结束标记：
  // 落消息失败时两个标记都没写，下一个 tick 的兜底会再试（以 summaryPostedAt 为准，不会重复落）。
  if (run.kind === 'learn') {
    const learnNow = ctx.clock.now();
    const chiefId = learnChiefId(ctx, run);
    if (chiefId !== null) postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', refId: `learn-end:${run.id}`, text: learnEndText(ctx, run, finishing) });
    ctx.store.table('skillRuns').put({ ...run, endedAt: learnNow, summaryPostedAt: learnNow });
    return;
  }
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  if (job === null) return; // 没有主题可落：先不动，等兜底（job 一般都在）。
  const names: Record<string, string> = {};
  for (const row of run.participants) names[row.botId] = ctx.store.table('bots').get(row.botId)?.name ?? '员工';
  for (const row of finishing) names[row.botId] ??= ctx.store.table('bots').get(row.botId)?.name ?? '员工';
  const now = ctx.clock.now();
  // 先落小结、成功之后才写 endedAt 与 summaryPostedAt：落小结失败时这里抛出，两个标记都没写，
  // 下一个 tick 的兜底巡检会再试一次（以 summaryPostedAt 为准幂等），不会丢小结也不会重复落。
  postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: `retro-summary:${run.id}`, text: retroSummaryText(run, finishing, names) });
  ctx.store.table('skillRuns').put({ ...run, endedAt: now, summaryPostedAt: now });
}

// ---------------------------------------------------------------------------
// 回合结束没有提交（propose 没有调用）
// ---------------------------------------------------------------------------

/**
 * 技能类唤醒的回合收尾时调用（turn/events.ts），按唤醒的种类处理「该做的事没做」：
 * - 复盘唤醒（含评审员的合并唤醒）：这位参与者仍是 running（没有调用 propose）——第一次改回 queued 并补排一次（计入上限），
 *   第二次记 done、原因 no_update，并排下一步；
 * - 核对唤醒或评审员的合并唤醒：这位核对人还有等他核对的更新没核对——第一次参与者改回 queued、补排一次核对唤醒，
 *   第二次这些更新放弃（原因「核对人没有核对」）；
 * - 改写唤醒：没有调用 revise——更新放弃（原因「没有改写」），提交人记 done。
 * - 学习唤醒（learn:）：没有调用 propose——第一次补排一次（计入上限），第二次记 done、原因 no_update，记录结束；
 * - 整理唤醒（tidy:）：没有调用 tidy——第一次补排一次（计入上限），第二次参与者记 capped，记录结束。
 * 处理完都试一次结束这次复盘。出错只记日志，不影响回合收尾。
 */
export function onSkillTurnEnd(ctx: HubContext, ticket: WakeTicket, options: { quotaInterrupted?: boolean } = {}): void {
  const parsed = parseSkillKey(ticket.subjectKey ?? null);
  if (parsed === null) return;
  try {
    // P76r2（R4）：回合是被额度打断的（报错分类为额度用完）：不是员工没有提交，不计入「第几次没有提交」，单独处理。
    if (options.quotaInterrupted === true) { onSkillQuotaInterrupted(ctx, ticket, parsed); return; }
    if (parsed.kind === 'tidy') { onTidyMissed(ctx, ticket); return; }
    if (parsed.kind === 'learn') { onProposeMissed(ctx, ticket, parsed.runId); return; }
    if (parsed.kind === 'retro' && parsed.rewrite) { onRewriteTurnEnd(ctx, ticket, parsed.runId); return; }
    const requeued = parsed.kind === 'retro' ? onProposeMissed(ctx, ticket, parsed.runId) : false;
    onCheckMissed(ctx, ticket, parsed.runId, requeued);
  } catch (error) {
    ctx.logger.error('技能类回合收尾失败', { wakeId: ticket.id, error: String(error) });
  }
}

/**
 * 技能类回合被额度打断（P76r2 R4，复盘、核对、改写、学习、每周整理五种都适用）：
 * 该做的事还没做完（没提交、没核对完、没改写、没整理）时：这一回合不算「没有提交」——
 * 参与者改回 queued；技能记录的回合数退回一个（与 refundSkillTurn 同一口径）；补排一条同键的技能候选，最早放行时刻是额度的恢复时刻
 * （真实额度用完时，恢复时刻放出的探针回合正是这条候选）。不数「第几次」，所以连续被额度打断不会让复盘以「没有新的技能更新」结束。
 * 这一回合其实已经做完了该做的事（例如已提交）时什么都不做，回合数也不退。
 * 补排之后额度恢复前，通用的出错重试和额度重排都不排（turn/events.ts 已按技能类排除），由这里补排的这一条负责。
 */
function onSkillQuotaInterrupted(ctx: HubContext, ticket: WakeTicket, parsed: NonNullable<ReturnType<typeof parseSkillKey>>): void {
  const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
  if (run === null) return;
  const state = run.participants.find(row => row.botId === ticket.botId)?.state;
  // 这一回合该做的事有没有没做完（判断口径与各种「没有提交」的处理函数一致）。
  let undone = false;
  let key = ticket.subjectKey!;
  if (parsed.kind === 'tidy') undone = state === 'running';
  else if (parsed.kind === 'skillcheck') undone = pendingChecksFor(ctx, run.id, ticket.botId, ticket.startedAt).length > 0;
  else if (parsed.rewrite) {
    undone = state === 'running' || ctx.store.table('skillUpdates').list(row => row.runId === run.id && row.botId === ticket.botId
      && row.state === 'rewrite' && row.updatedAt <= ticket.startedAt).length > 0;
  } else {
    const notProposed = state === 'running' || (state === 'queued' && !proposedInWake(ctx, run, ticket.botId, ticket));
    undone = notProposed;
    // 复盘提交过了、但评审员合并唤醒里等他核对的更新还没核完：补排的是核对唤醒（不再让他重新提交一次复盘）。
    if (!notProposed && parsed.kind === 'retro' && pendingChecksFor(ctx, run.id, ticket.botId, ticket.startedAt).length > 0) {
      undone = true;
      key = skillcheckSubjectKey(run.id, ticket.botId);
    }
  }
  if (!undone) return;
  // 退还回合数（同时把 running 改回 queued），其余状态（例如已提交记成 done、而核对没做完）也改回 queued，闸门只认 queued。
  refundSkillTurn(ctx, ticket);
  patchParticipant(ctx, run.id, ticket.botId, 'queued');
  const now = ctx.clock.now();
  const redUntil = ctx.store.table('quota').get('quota')?.redUntil ?? now;
  const result = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: ticket.botId, key,
    title: parsed.kind === 'tidy' ? '每周整理' : runTitleOf(ctx, run), notBefore: Math.max(now, redUntil) });
  // 排不上：此刻停用或归档的记 skipped 及原因；其余保持 queued，由兜底补排。
  const off = offDutyReason(ctx.store.table('bots').get(ticket.botId));
  if (result.entry === null && off !== null) patchParticipant(ctx, run.id, ticket.botId, 'skipped', off);
}

/**
 * 复盘（或学习）唤醒结束时没有提交：第一次改回 queued 并补排；第二次记 done、原因 no_update，并排下一步（学习不用排）。
 * 返回「这次补排了复盘唤醒」——补排的复盘唤醒（评审员的合并唤醒）会再次带上待核对的更新，核对那边不用另排。
 */
function onProposeMissed(ctx: HubContext, ticket: WakeTicket, runId: string): boolean {
  const run = ctx.store.table('skillRuns').get(runId);
  const state = run?.participants.find(row => row.botId === ticket.botId)?.state;
  if (run === null) return false;
  // 一般是 running；回合进行中被改回 queued（别人改写完要他再核对）而他自己的复盘还没提交的，同样算没有提交。
  const notProposed = state === 'running' || (state === 'queued' && !proposedInWake(ctx, run, ticket.botId, ticket));
  if (!notProposed) return false;
  // 这是不是第二次（同一键上已经有结束过的唤醒）。
  // P76r2（R4）：被额度打断的回合不数（quotaInterrupted）。
  const endedBefore = ctx.store.table('wakes').list(w => w.botId === ticket.botId
    && w.subjectKey === ticket.subjectKey && w.endedAt !== null && w.id !== ticket.id && w.quotaInterrupted !== true).length;
  const title = runTitleOf(ctx, run);
  const key = run.kind === 'learn' ? learnSubjectKey(run.id, ticket.botId) : retroSubjectKey(run.id, ticket.botId);
  if (endedBefore === 0) {
    // 第一次没有交卡：改回 queued，补排一次（计入上限，由闸门的 skill_cap 兜底）。
    patchParticipant(ctx, run.id, ticket.botId, 'queued');
    const result = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: ticket.botId, key, title });
    // 排不上：此刻停用或归档的记 skipped 及原因；其余保持 queued，由兜底补排。
    const off = offDutyReason(ctx.store.table('bots').get(ticket.botId));
    if (result.entry === null && off !== null) patchParticipant(ctx, run.id, ticket.botId, 'skipped', off);
    return true;
  }
  // 第二次：记 done、原因 no_update（队列里还有他的另一条候选时记 queued），排下一步（同「本回合没有更新时」）；排不上只记日志。
  settleParticipantAfterWork(ctx, run.id, ticket.botId, 'no_update');
  if (run.kind !== 'learn') {
    try {
      arrangeNextSteps(ctx, run.id, ticket.botId, []);
    } catch (error) {
      ctx.logger.warn('复盘没有交卡之后的下一步没有排上', { runId: run.id, botId: ticket.botId, error: String(error) });
    }
  }
  maybeFinishRun(ctx, run.id);
  return false;
}

/**
 * 整理唤醒结束时没有调用 tidy（参与者还是 running；调用过 tidy 的已记 done，不会走到这里）：
 * 第一次改回 queued 并补排一次（计入 TIDY_TURN_CAP）；第二次参与者记 capped，记录结束。
 * 「第几次」按这位员工在这条记录上已经结束过几个整理唤醒算（本回合不算）。
 */
function onTidyMissed(ctx: HubContext, ticket: WakeTicket): void {
  const run = skillRunOfKey(ctx, ticket.subjectKey ?? null);
  const state = run?.participants.find(row => row.botId === ticket.botId)?.state;
  if (run === null || state !== 'running') return;
  const endedBefore = ctx.store.table('wakes').list(w => w.botId === ticket.botId
    && w.subjectKey === ticket.subjectKey && w.endedAt !== null && w.id !== ticket.id && w.quotaInterrupted !== true).length;
  if (endedBefore === 0) {
    patchParticipant(ctx, run.id, ticket.botId, 'queued');
    const result = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: ticket.botId, key: ticket.subjectKey!, title: '每周整理' });
    const off = offDutyReason(ctx.store.table('bots').get(ticket.botId));
    if (result.entry === null && off !== null) patchParticipant(ctx, run.id, ticket.botId, 'skipped', off);
    return;
  }
  patchParticipant(ctx, run.id, ticket.botId, 'capped', 'skill_cap');
  maybeFinishRun(ctx, run.id);
}

/**
 * 核对唤醒（或评审员的合并复盘唤醒）结束时，这位核对人还有等他核对、且本回合清单里有的更新没核对：
 * 第一次改回 queued 并补排一次核对唤醒（计入上限）；第二次这些更新放弃。
 * 「第几次」按这位员工在这次复盘里已经结束过几个复盘或核对唤醒算（本回合不算）：第一个没做完的算第一次。
 * alreadyRequeued 为真：这次已经补排了评审员的合并复盘唤醒，它会再列出这些更新，不重复排。
 */
function onCheckMissed(ctx: HubContext, ticket: WakeTicket, runId: string, alreadyRequeued: boolean): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null) return;
  const pending = pendingChecksFor(ctx, runId, ticket.botId, ticket.startedAt);
  if (pending.length === 0) { maybeFinishRun(ctx, runId); return; }
  if (alreadyRequeued) return;
  const keys = [retroSubjectKey(runId, ticket.botId), skillcheckSubjectKey(runId, ticket.botId)];
  const endedBefore = ctx.store.table('wakes').list(w => w.botId === ticket.botId
    && keys.includes(w.subjectKey ?? '') && w.endedAt !== null && w.id !== ticket.id && w.quotaInterrupted !== true).length;
  const title = runTitleOf(ctx, run);
  if (endedBefore === 0) {
    // 第一次没核对完：参与者改回 queued，补排一次核对唤醒；排不上而此刻停用或归档的记 skipped 及原因，其余保持 queued 由兜底补排。
    patchParticipant(ctx, runId, ticket.botId, 'queued');
    const result = enqueueSkillWorkUndoable(ctx, { runId, botId: ticket.botId, key: skillcheckSubjectKey(runId, ticket.botId), title });
    const off = offDutyReason(ctx.store.table('bots').get(ticket.botId));
    if (result.entry === null && off !== null) patchParticipant(ctx, runId, ticket.botId, 'skipped', off);
    maybeFinishRun(ctx, runId);
    return;
  }
  // 第二次仍没核对：这些更新放弃，只留在记录里。
  const now = ctx.clock.now();
  for (const update of pending) {
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: '核对人没有核对', updatedAt: now });
  }
  settleParticipantAfterWork(ctx, runId, ticket.botId);
  maybeFinishRun(ctx, runId);
}

/** 改写唤醒结束时没有调用 revise：这位员工本回合清单里等他改写的更新放弃（原因「没有改写」），他记 done。 */
function onRewriteTurnEnd(ctx: HubContext, ticket: WakeTicket, runId: string): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null) return;
  const pending = ctx.store.table('skillUpdates').list(row => row.runId === runId && row.botId === ticket.botId
    && row.state === 'rewrite' && row.updatedAt <= ticket.startedAt);
  const now = ctx.clock.now();
  for (const update of pending) {
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: '没有改写', updatedAt: now });
  }
  const state = run.participants.find(row => row.botId === ticket.botId)?.state;
  if (pending.length > 0 || state === 'running') settleParticipantAfterWork(ctx, runId, ticket.botId);
  maybeFinishRun(ctx, runId);
}

// ---------------------------------------------------------------------------
// 兜底巡检（tick 里一项）
// ---------------------------------------------------------------------------

/**
 * 这位参与者自己那一项的唤醒键：复盘记录用 retro 键；学习记录里学习的员工用 learn 键；整理记录里被整理的员工用 tidy 键
 * （整理键里放的是周一日期）。核对人（checker）没有自己那一项，他的键只有核对键（见 keysOf）。
 */
function ownKeyOf(run: SkillRun, botId: string): string {
  if (run.kind === 'learn' && run.learn?.learnerId === botId) return learnSubjectKey(run.id, botId);
  if (run.kind === 'tidy' && run.weekOf != null && run.participants.some(row => row.botId === botId && row.role !== 'checker')) {
    return tidySubjectKey(run.weekOf, botId);
  }
  return retroSubjectKey(run.id, botId);
}

/** 每周整理当天过了 TIDY_LAST_HOUR 点（按这条记录建立的那一天算，用设置的时区）：不再补做。 */
export function tidyPastLastHour(ctx: HubContext, run: SkillRun, now: number): boolean {
  const day = localDateKey(run.createdAt, ctx.settings.timezone);
  const lastAt = parseLocalDateTime(`${day} ${String(D.TIDY_LAST_HOUR).padStart(2, '0')}:00`, ctx.settings.timezone);
  return now >= lastAt;
}

/**
 * 这位参与者在这次复盘里可能需要的键：自己的复盘用 retro 键；有更新在等他核对时另有 skillcheck 键
 * （评审员自己的复盘还没做时合并进复盘唤醒，不另用 skillcheck 键）；有自己的更新等他改写时另有改写键。
 */
function keysOf(ctx: HubContext, run: SkillRun, botId: string, job: Job | null, updates: SkillUpdate[]): string[] {
  const keys = [ownKeyOf(run, botId)];
  if (updates.some(row => row.state === 'rewrite' && row.botId === botId)) keys.push(retroSubjectKey(run.id, botId, true));
  if (updates.some(row => row.state === 'checking' && row.checkerId === botId) && !mergesWithOwnRetro(ctx, run, botId, job)) {
    keys.push(skillcheckSubjectKey(run.id, botId));
  }
  return keys;
}

/**
 * 核对人是这件事的评审员、自己的复盘还没做（有出处、没有结束过的复盘唤醒）时，核对合并进他的复盘唤醒
 * （同 arrangeNextSteps 的口径）；他的复盘已经做过时，核对用单独的技能核对唤醒，免得他的复盘被再提交一次。
 */
function mergesWithOwnRetro(ctx: HubContext, run: SkillRun, botId: string, job: Job | null): boolean {
  const participant = run.participants.find(row => row.botId === botId);
  if (job === null || botId !== job.reviewerId || participant === undefined || participant.sourceIds.length === 0) return false;
  const key = retroSubjectKey(run.id, botId);
  return ctx.store.table('wakes').count(w => w.botId === botId && w.subjectKey === key && w.endedAt !== null && w.quotaInterrupted !== true) === 0;
}

/**
 * 负责人已是 done、但仍有更新在等他、队列里没有他的候选、也没有在跑的唤醒：这是没人叫他（例如收尾处理中途出错），
 * 把他改回 queued，下面的补排接着处理。等他核对的更新看核对人；等待改写的更新看提交人。
 */
function reviveDoneParticipants(ctx: HubContext, run: SkillRun, updates: SkillUpdate[]): void {
  for (const update of updates) {
    if (update.state !== 'checking' && update.state !== 'rewrite') continue;
    const responsibleId = update.state === 'checking' ? update.checkerId : update.botId;
    const current = ctx.store.table('skillRuns').get(run.id)?.participants.find(row => row.botId === responsibleId);
    if (current === undefined || current.state !== 'done') continue;
    const hasCandidate = ctx.store.table('queue').list(entry => entry.botId === responsibleId).some(entry => skillRunOfKey(ctx, entry.subjectKey)?.id === run.id);
    const hasRunning = ctx.store.table('wakes').list(w => w.botId === responsibleId && w.endedAt === null).some(w => skillRunOfKey(ctx, w.subjectKey ?? null)?.id === run.id);
    if (!hasCandidate && !hasRunning) patchParticipant(ctx, run.id, responsibleId, 'queued');
  }
}

/**
 * P75r5b（审查 H1 的兜底）：参与者是 running，却既没有在跑的唤醒（未结束的唤醒单）、也没有排队的候选——
 * 上面几条收尾路径之外的遗漏，或进程重启留下的：改回 queued，之后照排队中的规则处理（补排、过期）。
 * 有在跑的唤醒时不动；有排队的候选时也不动（闸门会把它当成「不是排队中」丢弃，下一个 tick 这里再改回 queued）。
 */
function reviveStrandedRunning(ctx: HubContext, run: SkillRun): void {
  for (const participant of run.participants) {
    if (participant.state !== 'running') continue;
    const sameRun = (key: string | null | undefined): boolean => skillRunOfKey(ctx, key ?? null)?.id === run.id;
    const hasRunning = ctx.store.table('wakes').list(w => w.botId === participant.botId && w.endedAt === null).some(w => sameRun(w.subjectKey));
    const hasCandidate = ctx.store.table('queue').list(entry => entry.botId === participant.botId).some(entry => sameRun(entry.subjectKey));
    if (!hasRunning && !hasCandidate) patchParticipant(ctx, run.id, participant.botId, 'queued');
  }
}

/**
 * 兜底（任务卡第 9 节）：未结束的记录里，状态 queued 的参与者既没有排队的候选、也没有在跑的唤醒时：
 * 等了超过 7 天记 expired（P75r5b 提到「该不该他动」之前：任何排队中的参与者都适用，保证每次记录都能结束；
 * 每周整理不适用，它当天 TIDY_LAST_HOUR 点之后按另一条规则结束）；员工不在岗记 skipped；其余（例如入队失败）补排一次。
 * 只对「该他动」的参与者补排（执行者/总管自己的复盘，或有核对中的更新等他核对的核对人），
 * 正在等上一位提交的评审员不提前叫醒。然后 maybeFinishRun。
 */
export function sweepSkillRuns(ctx: HubContext, now: number): void {
  for (const run of ctx.store.table('skillRuns').list(row => row.endedAt === null)) {
    try {
      const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
      const updates = ctx.store.table('skillUpdates').list(row => row.runId === run.id);
      // 先把「负责人是 done、但没人叫他」的改回 queued，然后重新取这次复盘的记录（参与者状态可能刚变）。
      reviveDoneParticipants(ctx, run, updates);
      // P75r5b：「进行中却没有回合在跑」的参与者改回 queued（见 reviveStrandedRunning）。
      reviveStrandedRunning(ctx, ctx.store.table('skillRuns').get(run.id) ?? run);
      const fresh = ctx.store.table('skillRuns').get(run.id) ?? run;
      for (const participant of fresh.participants) {
        if (participant.state !== 'queued') continue;
        const keys = keysOf(ctx, fresh, participant.botId, job, updates);
        const hasCandidate = ctx.store.table('queue').list(entry => entry.botId === participant.botId).some(entry => keys.includes(entry.subjectKey));
        const hasRunning = ctx.store.table('wakes').list(w => w.botId === participant.botId && w.endedAt === null).some(w => keys.includes(w.subjectKey ?? ''));
        // P75i：每周整理当天过了 TIDY_LAST_HOUR 点还没做成的（排着队或还没排上），一律放弃，记 busy_all_day 并结束记录
        // （任务卡 5.2；整理的参与者不沿用「等待超过 7 天」的规则）。正在跑的回合不打断。
        if (run.kind === 'tidy' && participant.role !== 'checker' && tidyPastLastHour(ctx, run, now)) {
          if (hasRunning) continue;
          for (const entry of ctx.store.table('queue').list(row => row.botId === participant.botId && row.subjectKey === ownKeyOf(run, participant.botId))) removeEntry(ctx, entry.id);
          // P75r5c（审查 L5）：原因分开记：这位员工此刻（过了 TIDY_LAST_HOUR 点）还有在办的事，才是「一直有在办的事」；
          // 其余没有排上的原因（额度灯、全队当天的上限、重试退避等）记 no_slot。
          patchParticipant(ctx, run.id, participant.botId, 'skipped', busyWithJob(ctx, participant.botId) ? 'busy_all_day' : 'no_slot');
          continue;
        }
        if (hasCandidate || hasRunning) continue;
        // P75r5b（审查 H2）：7 天过期判断在「该不该他动」之前：任何排队中的参与者，这次记录建立超过 7 天就记等待过期。
        // 以前这一条排在「该他动」之后，按规则轮不到他动的参与者（例如角色判错、没有人会叫醒他）连过期都记不上，记录永远结束不了。
        // 每周整理不适用（上面已按 TIDY_LAST_HOUR 处理）；学习适用。
        // P75r6（复验 N4）：学习的 7 天从主人选定会话时算起（总管发起之后主人可能隔很多天才选；没有记下选会话时刻的旧记录仍按建立时刻）。
        const expireFrom = run.kind === 'learn' ? run.learn?.chosenAt ?? run.createdAt : run.createdAt;
        if (run.kind !== 'tidy' && now - expireFrom > D.WORK_EXPIRE_MS) {
          patchParticipant(ctx, run.id, participant.botId, 'expired', 'skill_expired');
          continue;
        }
        // 该他动吗：有更新在等他核对、有自己的更新在等他改写，或他是执行者/总管（自己的复盘排在前头）。
        const checkerBusy = updates.some(row => row.state === 'checking' && row.checkerId === participant.botId);
        const rewriteBusy = updates.some(row => row.state === 'rewrite' && row.botId === participant.botId);
        let lead = participant.role === 'executor' || participant.role === 'chief';
        // 评审员：执行者还在等（queued、running）时等他提交；执行者已经结束（提交过、跳过、用完回合、过期）而评审员
        // 仍没有候选时，这是没人叫他（例如执行者的回合用完没有提交），该他动了。
        if (participant.role === 'reviewer') {
          lead = !fresh.participants.some(row => row.role === 'executor' && (row.state === 'queued' || row.state === 'running'));
        }
        if (!checkerBusy && !rewriteBusy && !lead) continue;
        const off = offDutyReason(ctx.store.table('bots').get(participant.botId));
        if (off !== null) { patchParticipant(ctx, run.id, participant.botId, 'skipped', off); continue; }
        // 补排一次：等他改写的先排改写唤醒；等他核对的，评审员自己的复盘还没做时合并进复盘唤醒，否则排核对唤醒；其余排自己的复盘唤醒。
        const title = runTitleOf(ctx, run);
        const key = rewriteBusy ? retroSubjectKey(run.id, participant.botId, true)
          : checkerBusy && !mergesWithOwnRetro(ctx, fresh, participant.botId, job) ? skillcheckSubjectKey(run.id, participant.botId)
            : ownKeyOf(run, participant.botId);
        // 排不上（此刻不在岗已在上面处理；这里多半是感知被去重等）：保持 queued，下个 tick 再试。
        enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: participant.botId, key, title });
      }
      maybeFinishRun(ctx, run.id);
    } catch (error) {
      ctx.logger.error('复盘兜底巡检失败', { runId: run.id, error: String(error) });
    }
  }
}
