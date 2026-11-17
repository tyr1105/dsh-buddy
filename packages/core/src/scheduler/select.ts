/** 选择只是决策：返回第一个过闸者，成功投递后的移出与探针消耗由 C04 负责。 */
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/index.js';
import { listQueue, removeEntry } from './queue.js';
import { buildSnapshot, evaluateGates } from './gates.js';
import { explainSuppression, logAppraisal } from '../appraisal/log.js';
import { rollWindow } from '../quota/window.js';
import { discardRelatedPercepts } from './percept-consumption.js';
import { ownerReasonSummary } from '../util/owner-text.js';
import { settleDroppedTopicEntry } from '../project/topics.js';
import { settleDroppedJobEntry } from '../job/cap.js';
import { settleDroppedSkillEntry } from '../skill/run.js';
/**
 * 恢复后按交付时间排队（P76d，设计稿场景 E「按交付时间先后」）：
 * 额度恢复后，同一优先级里带 jobId 的执行链候选之间，按这件事的交付时间（dueAt）从早到晚放行，没有交付时间的排最后。
 * 做法：在每个优先级里，只把带 jobId 的候选按「交付时间升序、原来的先后」重新排，放回它们原来占着的位置；
 * 不带 jobId 的候选位置不动，别的比较（优先级、入队先后）一字不变。
 * 为什么不直接改比较函数：带 jobId 与不带 jobId 的候选之间没有交付时间可比，混着比较会出现 A 排在 B 前、B 排在 C 前、C 又排在 A 前的环，排序结果不确定。
 */
export function orderByJobDue(ctx: HubContext, queue: QueueEntry[]): QueueEntry[] {
  const dueOf = (entry: QueueEntry): number => ctx.store.table('jobs').get(entry.jobId!)?.dueAt ?? Number.POSITIVE_INFINITY;
  const result = [...queue];
  let start = 0;
  while (start < result.length) {
    let end = start;
    while (end < result.length && result[end]!.priority === result[start]!.priority) end += 1;
    const slots: number[] = [];
    for (let index = start; index < end; index += 1) if (typeof result[index]!.jobId === 'string' && result[index]!.jobId !== '') slots.push(index);
    // Array.prototype.sort 是稳定排序：交付时间相同（含都没有）时保持原来的先后。
    const sorted = slots.map(index => result[index]!).sort((a, b) => { const x = dueOf(a); const y = dueOf(b); return x === y ? 0 : x < y ? -1 : 1; });
    slots.forEach((index, order) => { result[index] = sorted[order]!; });
    start = end;
  }
  return result;
}
/** 遍历候选并记录被拦原因，只选择可放行项而不提前消费队列。 */
export function selectNext(ctx: HubContext, now: number): QueueEntry | null {
  // 事件入口也会选择候选，不能要求它一定先经过下一次 tick 才滚动过期额度。
  rollWindow(ctx, now);
  for (const entry of orderByJobDue(ctx, listQueue(ctx))) {
    // P74c：执行链候选带上它的 jobId，快照才会收齐这件事的状态、剩余回合与「等你回答」条目。
    // P75g：技能类候选带上事项键，快照才会收齐所属复盘记录的剩余回合与参与者状态。
    const snapshot = buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey);
    const gate = evaluateGates(entry, snapshot, now, ctx.settings);
    if (gate.pass) return entry;
    // 本轮感知可能刚刷新过原始期限；拦截时同步保存延后，防止健康步骤早于 pump 的时间缝误报。
    if (!gate.drop && snapshot.bot?.expectedBy != null) ctx.store.table('bots').patch(entry.botId, {
      expectedBy: Math.max(snapshot.bot.expectedBy, (gate.until ?? now + ctx.settings.tickMs) + ctx.settings.deadmanGraceMs),
    });
    const key = `${entry.botId}:${gate.by}`;
    const last = ctx.runtime.suppressionLogAt.get(key);
    if (last === undefined || now - last >= ctx.settings.c02.suppressionLogMs) {
      logAppraisal(ctx, { botId: entry.botId, at: now, perceptIds: entry.reason.evidence, score: entry.reason.score,
        threshold: entry.reason.threshold, decision: 'suppressed', suppressedBy: gate.by, until: gate.until,
        text: explainSuppression(entry, gate.by, gate.until, now, ctx.settings.timezone, snapshot.selfTurnsToday,ownerReasonSummary(entry.reason, ctx)) });
      ctx.runtime.suppressionLogAt.set(key, now);
    }
    if (gate.drop) {
      // 暂停保留主人消息供恢复处理；等主人同一事项则已作出明确丢弃决定。
      if (gate.by === 'waiting_owner_same_subject') discardRelatedPercepts(ctx, entry, now);
      removeEntry(ctx, entry.id);
      // P63：主题里被叫的人这一棒丢了，要把它移出等待名单并交给下一棒，讨论不能卡死。
      settleDroppedTopicEntry(ctx, entry);
      // P74c：执行链候选被丢弃时，让这件事的状态跟上事实（回合用到上限就停下并告诉主人）；出错只记日志，不能挡住后面的候选。
      try { settleDroppedJobEntry(ctx, entry, gate.by, now); }
      catch (error) { try { ctx.logger.error('执行链候选丢弃后的收尾失败', error); } catch { /* 日志出错也不能挡住调度。 */ } }
      // P75g：技能类候选因过期或上限被丢弃时，参与者状态跟上事实（expired/capped），并试一次结束这次复盘。
      try { settleDroppedSkillEntry(ctx, entry, gate.by, now); }
      catch (error) { try { ctx.logger.error('技能类候选丢弃后的收尾失败', error); } catch { /* 同上。 */ } }
    }
  }
  return null;
}
