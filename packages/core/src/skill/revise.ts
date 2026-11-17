/**
 * `hub_skill` 的 `revise`（P75h 第 5 节）：提交人按核对人的意见改写自己的技能更新，只能改写一次。
 *
 * 校验：调用者是提交人；更新状态 rewrite、还没改写过；本回合是这位员工的改写唤醒（retro:…:rewrite）；
 * 句子的条数、字数、出处与提交（propose）共用同一份校验（skill/sentences.ts）；
 * 出处只能是这次记录里给这位员工的出处（唤醒包里的 src 编号，对照参与者的 sourceIds）。
 *
 * 结果：句子换成新的，rewrites 记 1，状态回到 checking；提交人参与者 done；核对人改回 queued、排一次技能核对唤醒；
 * 落一张改写卡（复盘卡，标题后加「（改写）」）。排核对人的唤醒失败时撤回全部写入并返回失败。
 */
import type { HubContext } from '../engine/context.js';
import { postThread } from '../outreach/thread.js';
import { runTitleOf } from './run-title.js';
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { parseSkillKey, skillcheckSubjectKey } from './keys.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { rewriteCardRefId } from './card.js';
import { UPDATE_STATE_TEXT } from './check-facts.js';
import { maybeFinishRun, settleParticipantAfterWork } from './run.js';
import { patchParticipant } from './retro-plan.js';
import { srcIndex, validateSentences, type SentenceArg } from './sentences.js';
import { internalNameRefusal } from './skill-text.js';

/** 工具入参（解码后的形状）。 */
export interface ReviseArgs { updateId: string; sentences: SentenceArg[] }

/** 只能在中心叫你改写的回合里用。 */
export const NOT_REWRITE_TEXT = '只能在中心叫你改写技能更新的回合里用';

/** 改写卡的消息正文（界面按 refId 取视图，取不到时才显示这段文字）。 */
function rewriteCardText(name: string, title: string): string {
  return `复盘　${name}　${title}（改写）`;
}

/** 改写一条技能更新。校验失败抛中文错误；排核对唤醒失败恢复原状并抛出；成功返回给模型看的一句话。 */
export async function runRevise(ctx: HubContext, tc: { botId: string; wakeId?: string | null; sessionId: string }, args: ReviseArgs): Promise<string> {
  const bot = ctx.store.table('bots').get(tc.botId);
  if (bot === null) throw new Error('botId：员工不存在');
  // 1：本回合是这位员工的改写唤醒。
  const wake = tc.wakeId != null && tc.wakeId !== '' ? ctx.store.table('wakes').get(tc.wakeId) : null;
  const parsed = parseSkillKey(wake?.subjectKey ?? null);
  if (wake === null || parsed === null || parsed.kind !== 'retro' || !parsed.rewrite || parsed.botId !== bot.id) throw new Error(NOT_REWRITE_TEXT);
  const update = ctx.store.table('skillUpdates').get(args.updateId);
  if (update === null) throw new Error('updateId：找不到这条技能更新，请照唤醒包里写的编号');
  if (update.runId !== parsed.runId) throw new Error('这条更新不在本回合的改写清单里');
  if (update.botId !== bot.id) throw new Error('这条更新不是你提交的，不能改写');
  // P75i：合并类更新（每周整理）不能改写：核对不符时直接放弃（skill/check.ts）。
  if (update.kind === 'merge') throw new Error('合并类更新不能改写');
  // 2：只能改写一次；要处在等待改写的状态；改写清单是回合开始之前就已退回的更新。
  if (update.rewrites >= D.REWRITE_MAX) throw new Error('这条更新已经改写过一次，不能再改写');
  if (update.state !== 'rewrite') throw new Error(`这条更新现在不在等待改写的状态（${UPDATE_STATE_TEXT[update.state]}）`);
  if (update.updatedAt > wake.startedAt) throw new Error('这条更新不在本回合的改写清单里（它是本回合开始之后才退回的）');
  const run = ctx.store.table('skillRuns').get(update.runId);
  const participant = run?.participants.find(row => row.botId === bot.id);
  if (run === null || participant === undefined) throw new Error(NOT_REWRITE_TEXT);
  // P75r6 第 2 节第 5 条（复验 N9）：改写后的句子会写进技能库给主人看，先查内部名称，查到就拒绝、什么都不写。
  const refusal = internalNameRefusal(args.sentences.map(sentence => sentence.text));
  if (refusal !== null) throw new Error(refusal);
  // 3：句子与提交共用同一份校验（条数、字数、src 编号、不能只有验收结果）；一次列全。
  const checked = validateSentences(ctx, participant.sourceIds, args.sentences, '改写');
  if (checked.errors.length > 0) throw new Error(`提交被拒，没有写入任何东西：${checked.errors.join('；')}`);
  const checker = ctx.store.table('bots').get(update.checkerId);
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = runTitleOf(ctx, run);
  const checkerName = checker === null ? '核对人' : update.checkerId === job?.chiefId ? '总管' : checker.name;

  // ---- 第一段：写更新、改参与者状态、排核对人的再次核对；任一步失败恢复原状 ----
  const now = ctx.clock.now();
  const runBefore = run;
  const undoSteps: (() => void)[] = [];
  try {
    ctx.store.table('skillUpdates').put({
      ...update, state: 'checking', rewrites: update.rewrites + 1, updatedAt: now,
      sentences: args.sentences.map(sentence => ({
        text: sentence.text.trim(),
        sourceIds: sentence.sources.map(src => participant.sourceIds[srcIndex(src, participant.sourceIds.length)!]!),
      })),
    });
    undoSteps.push(() => { ctx.store.table('skillUpdates').put(update); });
    // 核对人改回 queued（闸门只认 queued）：不在名单里先加一项；已经在名单里的改回 queued。
    // 核对人此刻正在自己的回合里（running，例如评审员的合并唤醒还没结束）时也改回 queued：闸门遇到 running 的参与者会把候选丢弃，
    // 排给他的这条再核对就丢了。他正在进行的 propose 不受影响（propose 允许「回合还开着、被改回 queued、本回合还没提交」）。
    const current = ctx.store.table('skillRuns').get(run.id)!;
    const checkerRow = current.participants.find(row => row.botId === update.checkerId);
    if (checkerRow === undefined) {
      ctx.store.table('skillRuns').put({ ...current, participants: [...current.participants, { botId: update.checkerId, role: 'checker', sourceIds: [], state: 'queued', reason: null }] });
    } else {
      patchParticipant(ctx, run.id, update.checkerId, 'queued');
    }
    undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
    const wakeResult = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: update.checkerId, key: skillcheckSubjectKey(run.id, update.checkerId), title });
    undoSteps.push(wakeResult.undo);
    if (wakeResult.entry === null) throw new Error(`没有排上${checkerName}的再次核对（对方此刻可能不在岗）`);
    // 提交人这一回合做完了：done（若队列里还有自己的别的技能类候选，保持 queued）。
    settleParticipantAfterWork(ctx, run.id, bot.id);
    undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
  } catch (error) {
    for (const step of [...undoSteps].reverse()) {
      try { step(); } catch (undoError) { ctx.logger.warn('改写失败后的撤销没有成功', { error: String(undoError) }); }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // ---- 第二段：落改写卡、试一次结束（都只记日志，不影响已成功的第一段） ----
  try {
    if (job !== null) postThread(ctx, { thread: job.topicId, from: bot.id, kind: 'job_card', refId: rewriteCardRefId(run.id, bot.id, update.id), text: rewriteCardText(bot.name, title) });
  } catch (error) { ctx.logger.warn('改写卡没有落成', { updateId: update.id, error: String(error) }); }
  try { maybeFinishRun(ctx, run.id); } catch (error) { ctx.logger.warn('复盘结束检查失败', { runId: run.id, error: String(error) }); }
  return `已提交改写，等${checkerName}再核对一次。`;
}
