/**
 * 技能类回合的统一入队（P75g 第 4 节）：复盘、技能核对、改写、每周整理的唤醒都只走这里。
 *
 * 写法照执行链的 enqueueJobWakeUndoable（P74c）：入队可撤回（「全部成功才算数」的流程中途失败时原样放回）、
 * 按 directed 处理（指名叫人，不看思考门槛）、感知先记一条（带唯一 id，避开去重窗口）再作为候选的证据。
 *
 * 与执行链的区别（派活说明第二节第 3 条）：候选不带 jobId。复盘、核对自己的回合上限记在 skillRuns 上
 * （闸门读它），不带 jobId 才不会落进「一件事 150 万 token 兜底线、60 分钟总时长」那一套；
 * 属于哪件事只记在复盘记录（skillRuns.jobId）里。
 *
 * 唤醒种类固定写 reflection（任务卡第 4 节）：闸门的 isSkillWork 认的就是「种类为复盘且事项键是技能类前缀」；
 * 种类写成别的，听吩咐的例外和技能类的三道闸都不会生效。
 */
import type { HubContext } from '../engine/context.js';
import { buildCandidate } from '../appraisal/think.js';
import type { QueueEntry } from '../model/wake.js';
import { recordPeerMessage } from '../perception/sources.js';
import { enqueue } from '../scheduler/queue.js';
import { isOnDutyNow } from '../job/chain.js';
import { parseSkillKey, skillWorkSummary } from './keys.js';

/** 一次入队要排的东西：runId 只用于生成感知 id；键由调用方给（复盘、核对、整理各自的键函数）。 */
export interface SkillWakeInput {
  runId: string;
  botId: string;
  /** 事项键（retro:/skillcheck:/tidy: 之一，见 skill/keys.ts）。 */
  key: string;
  /** 这件事的标题（拼进「复盘：{标题}」这类说明；整理没有标题可以写空字符串）。 */
  title: string;
  /** P76r2：候选的最早放行时刻（可省略，默认现在）。回合被额度打断之后补排的候选带额度的恢复时刻。 */
  notBefore?: number;
}

export interface SkillWakeResult {
  /** 入队成功时的候选；员工不在岗、感知被去重时为 null。 */
  entry: QueueEntry | null;
  /** 把队列、员工状态、这次的感知恢复到入队前。 */
  undo: () => void;
}

/** 没有指定事件 id 时生成唯一的感知标识：同一员工、同一键，序号依次加一，避开去重窗口。 */
function nextPerceptId(ctx: HubContext, input: SkillWakeInput): string {
  const prefix = `${input.runId}:${input.key}:`;
  let seq = 1;
  while (ctx.store.table('percepts').count(row => row.botId === input.botId && row.location === `${prefix}${seq}`) > 0) seq += 1;
  return `${prefix}${seq}`;
}

/**
 * 排一次技能类唤醒，并返回「撤销」闭包。员工此刻不在岗时不入队（entry 为 null），
 * 调用方据此把参与者记为 skipped（原因码 owner_paused 或 archived）。
 */
export function enqueueSkillWorkUndoable(ctx: HubContext, input: SkillWakeInput): SkillWakeResult {
  const queueBefore = ctx.store.table('queue').list(row => row.botId === input.botId);
  const botBefore = ctx.store.table('bots').get(input.botId);
  const undo = (percept: string | null): (() => void) => (): void => {
    for (const entry of ctx.store.table('queue').list(row => row.botId === input.botId)) ctx.store.table('queue').remove(entry.id);
    for (const entry of queueBefore) ctx.store.table('queue').put(entry);
    if (botBefore) ctx.store.table('bots').put(botBefore);
    if (percept !== null) ctx.store.table('percepts').remove(percept);
  };
  if (!isOnDutyNow(ctx, input.botId)) return { entry: null, undo: undo(null) };
  const now = ctx.clock.now();
  const summary = skillWorkSummary(input.key, input.title);
  const percept = recordPeerMessage(ctx, { botId: input.botId, id: nextPerceptId(ctx, input), summary, at: now });
  if (percept === null) return { entry: null, undo: undo(null) };
  // 种类 reflection、变体 reflection；分值取「下次思考」的固定分；摘要与活动流摘要同一句（任务卡第 4 节）。
  // P75i：学习唤醒（learn: 键）是主人发起的回合：种类 teach、变体 teach、ownerInitiated 为真（任务卡 4.2），
  // 闸门按主人发起的回合放行（越过冷却、不计自主预算、橙灯放行）。
  const learn = parseSkillKey(input.key)?.kind === 'learn';
  const notBefore = input.notBefore === undefined ? {} : { notBefore: input.notBefore };
  const candidate = buildCandidate(ctx, learn ? {
    botId: input.botId, kind: 'teach', variant: 'teach', evidence: [percept.id], ownerInitiated: true,
    summary, ownerSummary: summary, score: ctx.settings.c02.nextThinkScore, subjectKey: input.key, ...notBefore,
  } : {
    botId: input.botId, kind: 'reflection', variant: 'reflection', evidence: [percept.id],
    summary, ownerSummary: summary, score: ctx.settings.c02.nextThinkScore, subjectKey: input.key, ...notBefore,
  });
  // directed：指名叫人，不看思考门槛；候选不带 jobId（见文件头）。
  const entry = enqueue(ctx, candidate, { directed: true });
  // 这条感知的候选已经由这里建好；标记「已评估」，感知评估不会再按它另建一条普通候选。
  ctx.store.table('percepts').patch(percept.id, { evaluatedAt: now, ...(entry === null ? { discardedAt: now } : {}) });
  return { entry, undo: undo(percept.id) };
}

/** 简化版：返回入队的候选；没有入队返回 null。 */
export function enqueueSkillWork(ctx: HubContext, input: SkillWakeInput): QueueEntry | null {
  return enqueueSkillWorkUndoable(ctx, input).entry;
}
