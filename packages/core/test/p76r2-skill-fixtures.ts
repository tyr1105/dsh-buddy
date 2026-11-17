/**
 * P76r2 技能类回合测试的公共小工具（不是测试文件）：在 P75i 的真实链路夹具之上，补三样东西：
 * 让某位员工正在跑的回合以错误结束（fail）、一段「额度用完」的报错原文（quotaText，带恢复时刻）、学习选会话（chooseLearn）。
 * 时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import type { QueueEntry } from '../src/model/index.js';
import { bot, flow, MINUTE, THIRD_BACK, type JobFix } from './p75i-fixtures.js';

export * from './p75i-fixtures.js';
export { entriesOf, runningOf, wakesOf } from './p74c-fixtures.js';

/**
 * 有复盘的链路：核对退回过一次、验收时主人指出第 3 条不符（有可复盘的出处）；验收之后给执行者排了复盘候选。
 * 没有这些纠正的链路验收之后不排复盘，所以复盘的用例都用它。
 */
export function retroFlow() {
  return flow({ rejectFirst: true, ownerReturn: THIRD_BACK, checker: 'reviewer' });
}

/** 这位员工在队列里的全部候选。 */
export function queueOf(fix: JobFix, botId: string): QueueEntry[] {
  return fix.ctx.store.table('queue').list(row => row.botId === botId);
}

/** 先让假时钟走一分钟，再让这位员工正在跑的回合以宿主报错结束（和宿主真实回报同一入口）。 */
export async function fail(fix: JobFix, botId: string, errorText: string): Promise<void> {
  fix.ctx.clock.advance(MINUTE);
  await fix.hub.onTurnEvent({ type: 'error', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), errorText });
}

/**
 * P76a 实测到的那种额度用完报错原文：「已达到 5 小时的使用上限，将于 HH:mm 恢复」，恢复时刻是 now 之后 65 分钟（北京时间）。
 * 只有几点几分、没有秒，解析出的恢复时刻是整分钟。
 */
export function quotaText(now: number): string {
  const hm = new Date(now + 65 * MINUTE + 8 * 60 * MINUTE).toISOString().slice(11, 16);
  return `已达到 5 小时的使用上限，将于 ${hm} 恢复`;
}

/** 主人在界面上为学习选第一个会话（和点按钮同一入口）。 */
export async function chooseLearn(fix: JobFix, cardId: string): Promise<void> {
  const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === cardId)!;
  expect(await fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] })).toMatchObject({ ok: true });
}
