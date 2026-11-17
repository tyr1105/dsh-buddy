/**
 * 向主人说明有了结果之后，清掉总管因为这次说明写下的受阻状态（P74r14 第 2 节）。
 *
 * 为什么需要：总管用 escalate 向主人说明之后，按规矩以 blocked 交账，他的状态行写「受阻……」（等主人选办法）。
 * 主人选了办法后，这件事由中心接着安排，总管没有新的回合，状态行一直停在「受阻……等主人选择」，
 * 同时又写「下次叫醒：等你点名或派活」，两句相互矛盾，直到总管下一次被叫醒才变。
 *
 * 总管的受阻状态是交账时（commit/process.ts、turn/events.ts）写在员工记录上的 activity 与 activityText，
 * 没有记下是哪件事。所以这里按事实判断，不另加字段：
 * 1. 总管此刻的状态是受阻，并且他最近一次有交账的回合带着某件事的编号、交账结果是 blocked（受阻是做一件事的回合里写下的）；
 * 2. 这位总管名下没有别的事仍在等主人选办法（说明有效、主人没选、事仍受阻）。别的事仍在等时不清：那一条受阻仍然是真的。
 * 满足时恢复成他没有事在做时的状态和文字，与他正常做完一个回合之后的写法相同（观察、「继续关注变化」）。
 * 调用时机：主人选了办法、说明失效（约定更新等）、这件事被停止，三种都在对应的写状态之后调用。出错只记日志。
 */
import type { HubContext } from '../engine/context.js';
import { jobEscalationExpiry } from './escalation-expiry.js';

/** 总管名下是否还有别的事在等主人选办法。 */
function otherEscalationWaiting(ctx: HubContext, chiefId: string, exceptJobId: string): boolean {
  return ctx.store.table('jobs').count(row => row.id !== exceptJobId && row.chiefId === chiefId && row.state === 'blocked'
    && row.escalation != null && jobEscalationExpiry(ctx, row, row.escalation) === null) > 0;
}

/** 这次说明有了结果之后调用；按上面两条判断，该清就清，返回是否清了。 */
export function clearChiefBlockedAfterEscalation(ctx: HubContext, jobId: string): boolean {
  try {
    const job = ctx.store.table('jobs').get(jobId);
    if (job === null) return false;
    const chief = ctx.store.table('bots').get(job.chiefId);
    if (chief === null || chief.activity !== 'blocked' || !['active', 'probation'].includes(chief.lifecycle)) return false;
    const last = ctx.store.table('wakes').list(row => row.botId === chief.id && Boolean(row.commitId)).sort((a, b) => a.startedAt - b.startedAt).at(-1);
    const commit = last?.commitId ? ctx.store.table('commits').get(last.commitId) : null;
    if (last === undefined || commit == null || commit.outcome !== 'blocked' || !last.jobId) return false;
    if (otherEscalationWaiting(ctx, chief.id, job.id)) return false;
    ctx.store.table('bots').patch(chief.id, { activity: 'watching', activityText: '继续关注变化', updatedAt: ctx.clock.now() });
    return true;
  } catch (error) {
    ctx.logger.warn('说明有了结果之后清总管的受阻状态失败', { jobId, error: String(error) });
    return false;
  }
}
