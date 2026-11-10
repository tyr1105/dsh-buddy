/**
 * 「听吩咐」的硬规则（P55）：这档队友只在被点名或派活时才动。
 *
 * 为什么要做成硬规则：以前的「等活、点名才来」只是写在性格里的一句话，
 * 队友仍会定期自查、盯到变化就醒。名字叫听吩咐，就不能再自己醒，也不该偷偷花额度。
 *
 * 判断只看这次唤醒的来源，不看模型怎么想：
 * - 挡住：外界变化、累积变化、内驱、定期自查、复盘、停机补课，这些都是队友自己要动；
 * - 放行：主人消息和派活、同伴消息、收件箱回复、审批结果、议程到期、试跑、教学、失败重试，
 *   这些要么是别人叫它，要么是接着做已经交给它的活。
 */
import type { Bot, WakeKind } from '../model/index.js';

/** 听吩咐的队友不接受的唤醒来源。 */
export const ON_DEMAND_BLOCKED_KINDS: ReadonlySet<WakeKind> = new Set<WakeKind>([
  'percept', 'pile', 'drive', 'light_check', 'reflection', 'catch_up',
]);

/** 这次唤醒是否该被挡住。 */
export function onDemandBlocks(bot: Pick<Bot, 'onDemand'>, kind: WakeKind): boolean {
  return bot.onDemand && ON_DEMAND_BLOCKED_KINDS.has(kind);
}
