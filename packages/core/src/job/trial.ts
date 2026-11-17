/**
 * 试用反馈（P74f，方案 5.8 末段）：一位员工参与的第一件验收通过的事，验收后总管私聊里落一句话，
 * 说他这第一件事做得怎么样、主人验收时有没有指出问题，让主人对新员工的表现有数。
 *
 * 为什么由中心生成：数字都来自交回、核对、主人指出不符的记录，不调用模型，也不叫醒总管。
 * 「第一件事」和「已经落过」都不靠内存里只保留 14 天的事件日志（补充要求 3.6）：
 * - 第一件事：这位员工作为执行者（或核对人）还没有别的已完成的事；
 * - 已经落过：这件事记录上的 trialReported；落完同时追加一条 trial_reported 事件（只作为记录，不作为判断依据）。
 * 总管自己核对的事没有评审员，只有执行者那一句。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { staffPostName } from '../team/workload.js';
import { isCenterRemapped } from './item-remap.js';
import { appendJobEvent } from './store.js';
import { realReviews } from './receipt.js';
import { withLabel } from '../util/name-label.js';
import { softly } from './work-common.js';

/** 主人验收时指出的不符一共几条。 */
function ownerFlagged(job: Job, since = 0): number {
  return (job.ownerReturns ?? []).filter(row => row.at >= since).reduce((sum, row) => sum + row.items.length, 0);
}

/** 执行者那一句的文字（纯函数，数字由调用方给出）。 */
export function executorTrialText(input: { name: string; post: string | null; submits: number; firstUnmet: number; flagged: number }): string {
  const first = input.firstUnmet === 0 ? '第一次就全部符合' : `第 1 次有 ${input.firstUnmet} 条不符`;
  const owner = input.flagged === 0 ? '没有指出不符' : `指出了 ${input.flagged} 条不符`;
  // P74r9 第 5 节：括号里写岗位名称（组队时的岗位）；没有岗位名称时不写括号。
  return `${withLabel(input.name, input.post)}的第一件事做完了：交回 ${input.submits} 次，${first}，你验收时${owner}。`;
}

/** 评审员那一句的文字。P74r9 第 5 节：括号里写岗位名称（原来写死「评审」，与后面的「核对」重复）；没有岗位名称时不写括号。 */
export function reviewerTrialText(input: { name: string; post: string | null; rounds: number; flagged: number }): string {
  const owner = input.flagged === 0 ? '没有发现漏判' : `指出了 ${input.flagged} 条核对漏掉的问题`;
  return `${withLabel(input.name, input.post)}的第一件事做完了：核对 ${input.rounds} 轮，你验收时${owner}。`;
}

/** 这位员工在别的事里有没有「已完成」的参与：有就不是第一件。 */
function hadEarlierDone(ctx: HubContext, job: Job, botId: string, as: 'executor' | 'reviewer'): boolean {
  return ctx.store.table('jobs').count(row => row.id !== job.id && row.state === 'done'
    && (as === 'executor' ? row.executorId === botId : row.reviewerId === botId)) > 0;
}

/** 验收通过后调用（第二段，出错只记日志）：对执行者和评审员各判断一次，该落就落。 */
export function reportTrialFeedback(ctx: HubContext, jobId: string): void {
  softly(ctx, '试用反馈', () => {
    const job = ctx.store.table('jobs').get(jobId);
    if (job === null) return;
    const reported = new Set(job.trialReported ?? []);
    const lines: Array<{ botId: string; text: string }> = [];
    const submissions = ctx.store.table('jobSubmissions').list(row => row.jobId === job.id).sort((a, b) => a.createdAt - b.createdAt);
    const own = submissions.filter(row => row.executorId === job.executorId && !isCenterRemapped(row));
    // 核对人真实做过的核对（只排除中心自己生成的那一份，见 receipt.ts 的 realReviews）。
    const reviews = realReviews(ctx.store.table('jobReviews').list(row => row.jobId === job.id).sort((a, b) => a.createdAt - b.createdAt));
    const executor = ctx.store.table('bots').get(job.executorId);
    if (executor !== null && !reported.has(executor.id) && !hadEarlierDone(ctx, job, executor.id, 'executor')) {
      // P74r4a 第 5 条：执行者那一句只取这位执行者自己的交回和对它们的核对；改派过的事，前任的交回不算给后任。
      // 「第 1 次有几条不符」取对这位执行者第一次交回的那次核对。
      const ownIds = new Set(own.map(row => row.id));
      const first = reviews.find(review => ownIds.has(review.submissionId));
      lines.push({ botId: executor.id, text: executorTrialText({
        name: executor.name, post: staffPostName(ctx, executor), submits: own.length,
        firstUnmet: first === undefined ? 0 : first.items.filter(item => item.verdict === 'unmet').length,
        // P74r6（N11）：「你验收时指出了 N 条不符」只算这位执行者接手之后的（从他第一次交回起），前任时期的指出不算给后任。
        flagged: ownerFlagged(job, own[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) }) });
    }
    const reviewer = job.reviewerId === null ? null : ctx.store.table('bots').get(job.reviewerId);
    if (reviewer !== null && !reported.has(reviewer.id) && !hadEarlierDone(ctx, job, reviewer.id, 'reviewer')) {
      lines.push({ botId: reviewer.id, text: reviewerTrialText({ name: reviewer.name, post: staffPostName(ctx, reviewer), rounds: reviews.filter(row => row.reviewerId === reviewer.id).length, flagged: ownerFlagged(job) }) });
    }
    for (const line of lines) {
      postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: line.text });
      reported.add(line.botId);
      ctx.store.table('jobs').put({ ...ctx.store.table('jobs').get(job.id)!, trialReported: [...reported] });
      appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'trial_reported', to: ['owner'], refId: null, data: { botId: line.botId } });
    }
  });
}
