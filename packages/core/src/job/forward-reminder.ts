/**
 * 修订约定成功时的「转交材料」提醒（P74r12 第 1 节）。
 *
 * 为什么要有：主人在一件进行中的事的主题里发来材料，总管容易只修订约定、忘了把材料转交给执行者
 * （约定改版不会把主人的原话带给执行者）。材料有没有转交取决于模型的判断，中心替不了；
 * 中心能做的是在最容易漏掉的那一刻（修订成功）提醒一句。
 *
 * 加提醒的条件（四个都要满足）：
 * - 这一回合是主人发话叫醒的，并且在某件事的主题里（私聊里的不加）；
 * - 修订的约定对应的这件事此刻还能转交（还在进行；已完成、已停止、待你验收的不加：转交会被拒）；
 * - 这一回合到这时为止还没有为这件事转交过材料（转交过的不加）。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { canForwardNow } from './manage-common.js';
import { eventsOf, jobOfAgreement } from './store.js';

/** 提醒的那一句（逐字）。 */
export const FORWARD_REMINDER_TEXT = '这一版出自主人在这件事主题里的话。那句话里如果有执行者要用的材料（文案、数据、文件、链接），再调用 hub_job_manage，mode 写 forward，把主人的原话转交给执行者；约定改版不会把材料带过去。';

/** 这次修订成功时要不要加提醒；要加返回那句话（前面不带空格，调用方直接接在原句之后），不加返回空字符串。 */
export function forwardReminderFor(ctx: HubContext, wake: WakeTicket, agreementId: string): string {
  // 只有主人在某个主题里发话叫醒的回合。
  if (wake.ownerInitiated !== true || !wake.topicId) return '';
  const job = jobOfAgreement(ctx, agreementId);
  // 这件事要存在、在这个主题里，并且此刻转交会被接受（P74r13：还没有收尾、也不是待你验收；与 forward 共用 canForwardNow）。
  if (job === null || job.topicId !== wake.topicId || !canForwardNow(job)) return '';
  // 这一回合已经转交过（转交事件发生在本回合开始之后）就不再提醒。
  const forwarded = eventsOf(ctx, job.id).some(event => event.kind === 'forwarded' && event.at >= wake.startedAt);
  return forwarded ? '' : FORWARD_REMINDER_TEXT;
}
