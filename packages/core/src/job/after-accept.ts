/**
 * 验收通过之后的后续动作（P74f 留的位置，P75b 填第一版）：写「同类任务记录」。
 *
 * 做什么：一件事验收通过后，中心按记录写 jobOutcomes 一行：类别、执行者、核对人、核对轮数、验收返工次数、回合数、
 * 这位执行者这个类别的第几次。不复盘的事（一次通过、没人纠正）也写这一行，所以它不花额度、不调用模型。
 * 以后 P75g 会在 afterJobAccepted 里接着安排复盘；本卡只写这一行。
 *
 * 为什么这样设计：
 * - 数字全部取自记录，不依赖内存里只保留 14 天的事件日志：返工次数数的是这件事记录上的 ownerReturns（主人验收时
 *   指出不符的记录），核对轮数用 receipt.ts 的 realReviews（只排除中心自己生成的那一份核对记录，与交付回执的算法一致）。
 * - 以 jobId 为键幂等：已有这一行就直接返回，重复调用、验收出错后兜底补做都不会产生第二行。
 * - 调用方 onJobAccepted 保持同步签名并放在「出错只记日志、不影响验收结果」的位置（accept.ts 不改）；
 *   这里的异步函数出错由 onJobAccepted 接住记日志，下一个 tick 的兜底补做。
 * - 兜底不设时间范围（返工次数不再依赖只保留 14 天的事件日志）：状态已完成、有验收时间、没有记录的事都补；
 *   为了不在每次心跳里扫全部已完成的事，兜底记下「两张表的变更序号」，序号没变且上次没有缺口就不再扫。
 */
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { JobOutcomeSchema, type JobOutcome } from '../model/skill.js';
import { jobCategory } from '../project/agreement-category.js';
import { jobTitleOf } from './chain.js';
import { realReviews } from './receipt.js';
import { planRetro } from '../skill/retro-plan.js';
import { finalizeJobUsage } from './usage.js';

/**
 * 写这件事的同类任务记录。已有记录、这件事不存在、或还没验收（没有验收时间）都直接返回；
 * 字段不合格时抛出中文错误（由调用方接住记日志），不会写入半行。
 */
export async function afterJobAccepted(ctx: HubContext, jobId: string): Promise<void> {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null || job.acceptedAt === null) return;
  // 幂等：以 jobId 为键，已有就不再写。
  if (ctx.store.table('jobOutcomes').get(job.id) !== null) return;
  const category = jobCategory(ctx, job.id);
  const reviews = realReviews(ctx.store.table('jobReviews').list(row => row.jobId === job.id));
  // seq：这位执行者这个类别已有记录数加 1。
  const earlier = ctx.store.table('jobOutcomes').count(row => row.executorId === job.executorId && row.category === category);
  const row = parseInput(JobOutcomeSchema, {
    id: job.id, category, executorId: job.executorId, reviewerId: job.reviewerId, title: jobTitleOf(ctx, job),
    rounds: reviews.length,
    // 返工次数：主人验收时指出不符的记录条数（没有指出过时没有这个数组，按 0）。
    reworks: (job.ownerReturns ?? []).length,
    turns: job.turnsUsed, seq: earlier + 1, acceptedAt: job.acceptedAt,
  }, '同类任务记录');
  ctx.store.table('jobOutcomes').put(row);
  // P75g：写完同类任务记录之后安排复盘（幂等；出处、参与者、提示、第一位参与者的唤醒都在里面）。
  // 安排复盘的表没写成时（planRetro 里只有这一段会抛出）把刚写的这一行同类任务记录撤回再抛出：
  // 这一行是兜底（sweepJobOutcomes）判断「这件事补做过没有」的依据，留着它兜底就不会再补做复盘。
  try { await planRetro(ctx, job.id); }
  catch (error) { ctx.store.table('jobOutcomes').remove(job.id); throw error; }
}

/**
 * 验收通过后的后续动作入口（同步签名，由 acceptJob 第二段最后调用，调用点不改）。
 * 异步部分出错只记日志，不影响验收结果；漏写的记录由兜底（sweepJobOutcomes）补上。
 */
export function onJobAccepted(ctx: HubContext, jobId: string): void {
  // P76e：先定稿这件事的用量（同步、出错只记日志）：验收那一刻的回合与 token 合计固定下来，同类估计以后只读定稿的行。
  finalizeJobUsage(ctx, jobId);
  afterJobAccepted(ctx, jobId).catch((error: unknown) => {
    ctx.logger.error('同类任务记录没有写成，稍后由兜底补上', error);
  });
}

/** 兜底上次确认「没有缺口」时两张表的变更序号；序号没变就不必再扫（按 ctx 记，换一个中心实例就重新扫一次）。 */
const settledRevisions = new WeakMap<HubContext, string>();

/**
 * 兜底：状态已完成、有验收时间、没有同类任务记录的事，补写一行。每个 tick 调用一次。
 * 不设时间范围：很久以前验收、没有记录的事也会补上（返工次数读的是这件事记录上的 ownerReturns，不依赖事件日志）。
 * 做一件事出错不影响别的事；只要有一件没补成，就不记「已确认」，下个 tick 再试。
 */
export async function sweepJobOutcomes(ctx: HubContext): Promise<void> {
  const stamp = `${ctx.store.table('jobs').revision()}:${ctx.store.table('jobOutcomes').revision()}`;
  if (settledRevisions.get(ctx) === stamp) return;
  const done = new Set(ctx.store.table('jobOutcomes').listFields(['id']).map(row => row.id));
  // 只取 id、状态、验收时间三个字段，不为判断「缺不缺」复制每件事的整条记录。
  const missing = ctx.store.table('jobs').listFields(['id', 'state', 'acceptedAt'])
    .filter(row => row.state === 'done' && row.acceptedAt != null && !done.has(row.id))
    .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0)); // 按验收时间从早到晚补，seq 才与实际顺序一致
  let failed = false;
  for (const row of missing) {
    try { await afterJobAccepted(ctx, row.id); } catch (error) {
      failed = true;
      ctx.logger.error('同类任务记录兜底没有补成', { jobId: row.id, error: String(error) });
    }
  }
  // 补完之后再取一次序号：补写本身会让 jobOutcomes 的序号变化，记下的是「补完之后」的状态。
  if (!failed) settledRevisions.set(ctx, `${ctx.store.table('jobs').revision()}:${ctx.store.table('jobOutcomes').revision()}`);
}

/**
 * 读取：这位员工在某个类别下的全部同类任务记录，按验收时间从早到晚（同一时间按 seq）。
 * 技能详情的「同类任务对比」（P75e）用它取第 1 次和最近两次。
 */
export function outcomesFor(ctx: HubContext, botId: string, category: string): JobOutcome[] {
  return ctx.store.table('jobOutcomes').list(row => row.executorId === botId && row.category === category)
    .sort((a, b) => a.acceptedAt - b.acceptedAt || a.seq - b.seq);
}
