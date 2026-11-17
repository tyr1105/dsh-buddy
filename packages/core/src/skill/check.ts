/**
 * `hub_skill` 的 `check`（P75h 第 4 节）：核对人核对一条技能更新，通过的写进技能库，不符的最多改写一次。
 *
 * 三项检查：
 * - 出处在记录里真实存在：由中心判（check-facts.ts 的 existsVerdict），不让模型判；
 * - 更新说的事，出处里说过（consistent）、没有超出出处的范围（withinScope）：核对人判。
 * 核对人只核对「更新与出处是否一致」，不评价这条经验好不好——那是员工自己的专业判断（唤醒包里写明）。
 *
 * 三种结果：
 * - 三项都符合：写新版本（writeSkillVersion），更新 passed；写入失败（例如句数已满）更新 abandoned、原因写错误原文；
 * - 有不符、还没改写过：更新 rewrite，提交人排一次改写唤醒；
 * - 有不符、已改写过一次：更新 abandoned，原因「改写后仍不符」，只留在记录里。
 *
 * 两段式：第一段写表（更新、参与者状态、排改写唤醒）——排唤醒抛出时恢复原状；第二段才落核对卡、
 * 改这位核对人的参与者状态、试一次结束这次复盘，这一段出错只记日志，不影响已成功的第一段。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { SkillUpdate } from '../model/index.js';
import { postThread } from '../outreach/thread.js';
import { SKILL_OWNER_VISIBLE_REFUSAL, internalNameIn } from '../job/owner-text.js';
import { MERGE_ABANDON_REASON, MERGE_NOT_ACTIVE_REASON, MERGE_STALE_REASON } from './merge-reasons.js';
import { setSkillState, writeSkillVersion } from './store.js';
import { runTitleOf } from './run-title.js';
import { parseSkillKey, retroSubjectKey } from './keys.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { skillCheckCardRefId } from './card.js';
import { UPDATE_STATE_TEXT, existsVerdict, pendingChecksFor } from './check-facts.js';
import { maybeFinishRun, settleParticipantAfterWork } from './run.js';
import { offDutyReason, patchParticipant } from './retro-plan.js';

/** 工具入参（hub-skill.ts 里是 zod 定义，这里是解码后的形状）。 */
export interface CheckArgs {
  updateId: string;
  consistent: 'met' | 'unmet';
  withinScope: 'met' | 'unmet';
  note?: string;
}

/** 只能在中心叫你核对的回合里用。 */
export const NOT_CHECK_TEXT = '只能在中心叫你核对技能更新的回合里用';

// 合并类更新放弃的几句固定原因在 merge-reasons.ts（活动流也要读）；这里重新导出，原来的引用方式不变。
export { MERGE_ABANDON_REASON, MERGE_NOT_ACTIVE_REASON, MERGE_STALE_REASON };

/** 出处在记录里不存在时，核对人没有写说明的话，卡片和改写唤醒里用这句。 */
const SOURCE_MISSING_NOTE = '这条更新引用的出处在记录里已经不存在，只能写有出处的做法。';

/** 核对卡的消息正文（界面按 refId 取视图，这段文字只在取不到视图时显示）。 */
function checkCardText(skillTitle: string): string {
  return `核对　技能更新　「${skillTitle}」`;
}

/** 这条更新对应的技能名（已有技能取技能名，新建取新技能的名称）。 */
export function updateSkillTitle(ctx: HubContext, update: SkillUpdate): string {
  if (update.skillId === null) return update.newSkill?.title ?? '新技能';
  return ctx.store.table('skills').get(update.skillId)?.title ?? '技能';
}

/**
 * 核对一条技能更新。校验失败抛中文错误（什么都不写）；成功返回给模型看的一句话。
 */
export async function runCheck(ctx: HubContext, tc: { botId: string; wakeId?: string | null; sessionId: string }, args: CheckArgs): Promise<string> {
  const bot = ctx.store.table('bots').get(tc.botId);
  if (bot === null) throw new Error('botId：员工不存在');
  // 1：本回合是这位核对人的核对唤醒（skillcheck:），或评审员的合并复盘唤醒（retro:，不是改写）。
  const wake = tc.wakeId != null && tc.wakeId !== '' ? ctx.store.table('wakes').get(tc.wakeId) : null;
  const parsed = parseSkillKey(wake?.subjectKey ?? null);
  if (wake === null || parsed === null || parsed.botId !== bot.id || parsed.kind === 'tidy' || parsed.kind === 'learn' || (parsed.kind === 'retro' && parsed.rewrite)) {
    throw new Error(NOT_CHECK_TEXT);
  }
  const update = ctx.store.table('skillUpdates').get(args.updateId);
  if (update === null) throw new Error('updateId：找不到这条技能更新，请照唤醒包里写的编号');
  // 2：这条更新是这次复盘里等你核对的。
  if (update.runId !== parsed.runId) throw new Error('这条更新不在本回合的核对清单里');
  if (update.checkerId !== bot.id) throw new Error('这条更新不是由你核对的');
  // 3：同一回合对同一条更新只能核对一次（写在状态检查前面，说明原因比「状态不对」更清楚）。
  if (update.checks.some(row => row.at >= wake.startedAt)) throw new Error('本回合已经核对过这条更新，不能再核对');
  if (update.state !== 'checking') throw new Error(`这条更新现在不在核对中（${UPDATE_STATE_TEXT[update.state]}）`);
  // 4：本回合开始之后才进入核对的更新，唤醒包里没有它的句子，核对人没见过，不能在这个回合核对。
  if (update.updatedAt > wake.startedAt) throw new Error('这条更新不在本回合的核对清单里（它是本回合开始之后才提交的）');
  // 5：有 unmet 时 note 必填。
  const hasUnmet = args.consistent === 'unmet' || args.withinScope === 'unmet';
  const note = args.note?.trim() ?? '';
  if (hasUnmet && note === '') throw new Error('note：有 unmet 时必填，写哪一句不符、删去什么或改成什么就能写入');
  if ([...note].length > D.CHECK_NOTE_MAX_CHARS) throw new Error(`note：不能超过 ${D.CHECK_NOTE_MAX_CHARS} 字`);
  // P75r5b（审查 M5）：note 会原样出现在核对卡里给主人看，写入之前查内部名称（工具名、出处与更新编号、updateId），查到就拒绝、什么都不写。
  if (note !== '' && internalNameIn(note) !== null) throw new Error(SKILL_OWNER_VISIBLE_REFUSAL);

  const run = ctx.store.table('skillRuns').get(update.runId);
  if (run === null) throw new Error('复盘记录找不到了');
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = runTitleOf(ctx, run);
  const submitter = ctx.store.table('bots').get(update.botId);
  const skillTitle = updateSkillTitle(ctx, update);
  const now = ctx.clock.now();

  // 第一项由中心判。三项都符合才写入。
  const exists = existsVerdict(ctx, update);
  const allMet = exists === 'met' && args.consistent === 'met' && args.withinScope === 'met';
  const checkNote = note !== '' ? note : exists === 'unmet' ? SOURCE_MISSING_NOTE : null;
  // 核对记录里同时记下这次核对的句子：改写之后更新的句子会换成新的，核对卡要如实显示当时核对的是哪几句。
  const checkRow = {
    at: now, checkerId: bot.id, exists, consistent: args.consistent, withinScope: args.withinScope, note: checkNote,
    sentences: update.sentences.map(row => ({ text: row.text, sourceIds: [...row.sourceIds] })),
  };
  const checks = [...update.checks, checkRow];
  const nth = checks.length;
  let resultText: string;

  // ---- 第一段：写表 ----
  if (allMet) {
    // 写进技能库：已有技能新增（add），新建技能（create），合并（merge）；类别取这次复盘记录的类别（合并时取两条技能的类别）。
    try {
      // 合并：两条原技能都还在用才能合并（整理唤醒到核对之间可能被别的更新、回退或收起改变了）；
      // 写入成功之后被并入的那条收起（原因 merged），两条原技能各保留原版本，可回退。
      const mergeFrom = update.kind === 'merge' ? ctx.store.table('skills').get(update.mergeFromIds[0] ?? '') : null;
      const mergeInto = update.kind === 'merge' && update.skillId !== null ? ctx.store.table('skills').get(update.skillId) : null;
      if (update.kind === 'merge' && (mergeFrom === null || mergeInto === null || mergeFrom.state !== 'active' || mergeInto.state !== 'active')) {
        throw new Error(MERGE_NOT_ACTIVE_REASON);
      }
      // P75r5c（审查 M1）：合并只对整理时的那一版有效。整理之后、核对之前任何一条原技能有了新版本（或被回退），
      // 就不能再用整理那一刻的句子整体覆盖（会悄悄丢掉新写进去的句子）：这条合并放弃，两条技能都不变。
      if (update.kind === 'merge' && update.mergeBase !== undefined && mergeFrom !== null && mergeInto !== null
        && (mergeFrom.currentVersionNo !== update.mergeBase.fromVersionNo || mergeInto.currentVersionNo !== update.mergeBase.intoVersionNo)) {
        throw new Error(MERGE_STALE_REASON);
      }
      const version = await writeSkillVersion(ctx, {
        botId: update.botId, skillId: update.skillId, newSkill: update.newSkill,
        change: update.kind === 'merge' ? 'merge' : update.skillId === null ? 'create' : 'add',
        sentences: update.sentences.map(row => ({ text: row.text, sourceIds: [...row.sourceIds] })),
        updateId: update.id, checkedBy: bot.id,
        categories: update.kind === 'merge' ? mergeFrom!.categories : run.category === null ? [] : [run.category],
      });
      // 版本已写入：收起被并入的那条出错时只记日志（不能因此把已写入的更新记成放弃）。
      if (mergeFrom !== null) {
        try { await setSkillState(ctx, mergeFrom.id, 'collapsed', 'merged'); }
        catch (collapseError) { ctx.logger.warn('合并后收起被并入的技能失败', { skillId: mergeFrom.id, error: String(collapseError) }); }
      }
      // P75r5b（审查 8.1）：上面等待写入技能库（物化技能文件）期间，这条更新可能被别处改了状态（例如记录结束时改成放弃）。
      // 写回「已通过」之前重新读一次这条更新，状态已经不是核对中的就不写（记日志），不用等待之前读到的旧对象覆盖别人的改动。
      const latest = ctx.store.table('skillUpdates').get(update.id);
      if (latest !== null && latest.state === 'checking') {
        ctx.store.table('skillUpdates').put({ ...latest, state: 'passed', versionNo: version.no, checks: [...latest.checks, checkRow], updatedAt: ctx.clock.now() });
      } else {
        ctx.logger.warn('核对写入技能库期间这条更新的状态已变，不再写回「已通过」', { updateId: update.id, state: latest?.state ?? null });
      }
      resultText = `已写入技能库：「${updateSkillTitle(ctx, update)}」第 ${version.no} 版。`;
    } catch (error) {
      // 写入失败（例如这条技能的句数已满）：放弃，原因写错误原文；不影响同一次复盘里别的更新。
      const reason = error instanceof Error ? error.message : String(error);
      ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: reason, checks, updatedAt: ctx.clock.now() });
      resultText = `没有写入技能库，这条更新已放弃：${reason}`;
    }
  } else if (update.kind === 'merge') {
    // P75i（派活说明第一节第 5 条）：合并类更新不符时直接放弃，不进入改写（合并不改写措辞，不符就不合并）。
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: MERGE_ABANDON_REASON, checks, updatedAt: now });
    resultText = `${MERGE_ABANDON_REASON}，这条合并已放弃，两条技能都没有改动。`;
  } else if (update.rewrites === 0) {
    // 有不符、还没改写过：更新 rewrite，提交人改回 queued、排一次改写唤醒。
    const submitterBefore = run.participants.find(row => row.botId === update.botId);
    const queueSteps: (() => void)[] = [];
    try {
      ctx.store.table('skillUpdates').put({ ...update, state: 'rewrite', checks, updatedAt: now });
      // 提交人改回 queued（闸门只认 queued）；他此刻正在自己的回合里也一样（理由同 revise.ts）。
      if (submitterBefore !== undefined) patchParticipant(ctx, run.id, update.botId, 'queued');
      const wakeResult = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: update.botId, key: retroSubjectKey(run.id, update.botId, true), title });
      queueSteps.push(wakeResult.undo);
      const off = offDutyReason(ctx.store.table('bots').get(update.botId));
      if (wakeResult.entry === null && off !== null) {
        // 提交人此刻停用或归档：没有人能改写，这条更新放弃，提交人记 skipped 及原因。
        ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: '提交人此刻不在岗，没有改写', checks, updatedAt: now });
        patchParticipant(ctx, run.id, update.botId, 'skipped', off);
        resultText = '提交人此刻不在岗，这条更新已放弃。';
      } else {
        // 排不上但在岗（例如感知被去重）：保持等待改写，由兜底补排。
        resultText = `已退回${submitter?.name ?? '提交人'}改写一次。`;
      }
    } catch (error) {
      // 任何一步抛出：更新、提交人状态、队列都恢复原状。
      for (const undo of [...queueSteps].reverse()) { try { undo(); } catch (undoError) { ctx.logger.warn('核对不符后的撤销没有成功', { error: String(undoError) }); } }
      ctx.store.table('skillUpdates').put(update);
      if (submitterBefore !== undefined) patchParticipant(ctx, run.id, update.botId, submitterBefore.state, submitterBefore.reason);
      throw error instanceof Error ? error : new Error(String(error));
    }
  } else {
    // 有不符、已改写过一次：放弃，只留在记录里。
    ctx.store.table('skillUpdates').put({ ...update, state: 'abandoned', abandonReason: '改写后仍不符', checks, updatedAt: now });
    resultText = '改写后仍不符，这条更新已放弃。';
  }

  // ---- 第二段：落核对卡、改核对人的参与者状态、试一次结束（只记日志，不影响已成功的第一段） ----
  try {
    if (job !== null) postThread(ctx, { thread: job.topicId, from: bot.id, kind: 'job_card', refId: skillCheckCardRefId(update.id, nth), text: checkCardText(skillTitle) });
  } catch (error) { ctx.logger.warn('技能核对卡没有落成', { updateId: update.id, error: String(error) }); }
  try {
    // 这位核对人这一回合要核对的都核对完了：核对唤醒里参与者记 done；评审员的合并复盘唤醒里，
    // 还要等他自己的 propose（propose 或回合收尾会处理），这里不动。
    if (parsed.kind === 'skillcheck' && pendingChecksFor(ctx, run.id, bot.id, wake.startedAt).length === 0) {
      settleParticipantAfterWork(ctx, run.id, bot.id);
    }
  } catch (error) { ctx.logger.warn('核对之后的参与者状态没有更新', { runId: run.id, error: String(error) }); }
  try { maybeFinishRun(ctx, run.id); } catch (error) { ctx.logger.warn('复盘结束检查失败', { runId: run.id, error: String(error) }); }
  return resultText;
}
