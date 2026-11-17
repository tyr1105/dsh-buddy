/**
 * 学习与每周整理的核对人（P75i 第 4.3、5.4 节，派活说明第二节第 5 条）。
 *
 * 规则：团队里最近一次核对过这位员工交回的评审员（按 jobReviews 的时间），没有时总管；
 * 核对人不能是提交人自己，也不能是此刻不在岗的员工。
 * 提交人是评审员本人时，上面的「核对过他交回」找不到，落到总管；提交人是总管时，总管不能核对自己，
 * 改找全队最近核对过任何一件事的在岗评审员。这几种情形都找不到时返回 null，由调用方按各自的做法处理：
 * 学习没有这种情形（总管一定在岗，且提交人不会是总管）；整理这位员工本周只做收起。
 *
 * 只读存储，不写任何东西。「在岗」的口径与复盘一致：skill/retro-plan.ts 的 offDutyReason。
 */
import type { HubContext } from '../engine/context.js';
import { realReviews } from '../job/receipt.js';
import { offDutyReason } from './retro-plan.js';

/** 这位员工此刻在岗（没有停用、没有归档）。 */
function onDuty(ctx: HubContext, botId: string): boolean {
  return offDutyReason(ctx.store.table('bots').get(botId)) === null;
}

/** 找核对人；找不到返回 null。 */
export function findSkillChecker(ctx: HubContext, submitterId: string): string | null {
  // 1：最近一次核对过这位员工交回的评审员（核对的是他作为执行者的事）。
  const ownJobs = new Set(ctx.store.table('jobs').list(row => row.executorId === submitterId).map(row => row.id));
  const reviews = realReviews(ctx.store.table('jobReviews').list())
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const usable = (id: string): boolean => id !== submitterId && onDuty(ctx, id);
  const own = reviews.find(row => ownJobs.has(row.jobId) && usable(row.reviewerId));
  if (own !== undefined) return own.reviewerId;
  // 2：总管（提交人不是总管、总管在岗时）。
  const chief = ctx.store.table('bots').list(row => row.role === 'chief').find(row => usable(row.id));
  if (chief !== undefined) return chief.id;
  // 3：提交人就是总管：全队最近核对过任何一件事的在岗评审员。
  const any = reviews.find(row => usable(row.reviewerId));
  return any?.reviewerId ?? null;
}
