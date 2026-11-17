/**
 * 「空转」的事实：预期的人最近连续几个回合都没有留下新文件或新证据（P76g，方案 7.6）。
 *
 * 为什么单独一个文件：停滞判断（stall-check.ts）要用它判定，「没有进展」条目的正文（stall.ts）要写「连续 {k} 个回合」，
 * 两处共用同一份算法，不会各算各的。
 *
 * 算法：读这件事的分步记账（jobUsage.turns）里这位员工已经结束（endedAt 不为空）的回合，从最近的往前数，
 * 数到某个回合开始以来「有新文件或新证据」为止。「新文件或新证据」指下面任一种：
 * - 这件事的事件：交回（submitted）、核对结论（reviewed）、提问（asked）、回答（answered）、转交材料（forwarded）、交付（delivered）；
 * - 这位员工往项目文件夹放文件（hub_project_put 成功时中心写的审计记录 project_put，动作者是这位员工）。
 *   审计记录里没有记是哪件事，所以这位员工在别的事里放的文件也算：宁可少判空转，不错判。
 * 已经为空转通知过你的（stallNotifiedAt 不为空）：只数通知之后才结束的回合，同一批回合不会再算一次。
 * 技能类回合（复盘、核对、学习、整理）不在 jobUsage.turns 里，所以员工在两个回合之间做一次复盘不影响计数。
 *
 * 只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { JobEvent } from '../model/job.js';

/** 算作「新证据」的事件种类。 */
export const SPIN_EVIDENCE_KINDS: readonly JobEvent['kind'][] = ['submitted', 'reviewed', 'asked', 'answered', 'forwarded', 'delivered'];

/**
 * 预期的人在这件事上连续几个已结束的回合没有新文件或新证据；没有已结束的回合返回 0。
 * events 是这件事的全部事件（巡检已按事分组读好）；notifiedAt 是上一次停滞通知的时间（没有为 null）。
 */
export function spinRunOf(ctx: HubContext, jobId: string, actorId: string, events: readonly JobEvent[], notifiedAt: number | null): number {
  const usage = ctx.store.table('jobUsage').get(jobId);
  if (usage === null) return 0;
  const ended = usage.turns.filter(turn => turn.botId === actorId && turn.endedAt !== null && (notifiedAt === null || turn.endedAt > notifiedAt));
  if (ended.length === 0) return 0;
  // 放文件的审计记录读一次：从最早的那个回合开始以来，这位员工的 project_put。
  const putTimes = ctx.store.log('audit').since(ended[0]!.startedAt, row => row.action === 'project_put' && row.actor === actorId).map(row => row.at);
  const evidenceTimes = [...events.filter(event => SPIN_EVIDENCE_KINDS.includes(event.kind)).map(event => event.at), ...putTimes];
  // 从最近一个回合往前数：起点越早，覆盖的证据越多；一出现证据就停。
  let run = 0;
  for (let n = 1; n <= ended.length; n += 1) {
    const start = ended[ended.length - n]!.startedAt;
    if (evidenceTimes.some(at => at >= start)) break;
    run = n;
  }
  return run;
}
