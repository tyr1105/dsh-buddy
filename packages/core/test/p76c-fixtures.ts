/**
 * P76c 测试共用的夹具：往存储里直接写「今天员工做过的回合」。
 *
 * 为什么需要：P76c 之前，疲劳、内驱、隔离、闸门的「今天用了多少」数的是账本（ledger）里的行；
 * P76c 起统一数「员工自己发起的回合」，口径由唤醒单决定（quota/usage.ts 的 isSelfWork、selfWorkUsageToday）。
 * 所以测试要写的是唤醒单，而不是只写账本行。
 *
 * 约定：回合开始时刻默认是「现在往前 1 分钟」，一定落在今天（假时钟默认 10:00）、也不晚于现在；
 * 已投递（dispatchedAt 有值）、已交账结束；默认是员工自己发起的普通回合（没有 jobId、不是主人发起、不是技能类）。
 */
import type { HubContext } from '../src/engine/context.js';
import type { WakeTicket } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

let counter = 0;

/** 写一张唤醒单到存储；patch 里的字段覆盖默认值（例如 jobId、ownerInitiated、reason、subjectKey）。 */
export function addWake(ctx: HubContext, patch: Partial<WakeTicket> = {}, botId: string = botFixture.id): WakeTicket {
  counter += 1;
  const now = ctx.clock.now();
  const base = modelFixtures.WakeTicket.valid as WakeTicket;
  const wake: WakeTicket = { ...base, id: `w_${String(900_000 + counter).padStart(10, '0')}`, botId,
    ownerInitiated: false, status: 'committed', startedAt: now - 60_000, lastEventAt: now - 30_000, endedAt: now - 30_000,
    dispatchedAt: now - 60_000, tokens: 1000, ...patch };
  ctx.store.table('wakes').put(wake);
  return wake;
}

/** 连续写 n 张员工自己发起的回合；返回它们。 */
export function addSelfTurns(ctx: HubContext, n: number, patch: Partial<WakeTicket> = {}, botId: string = botFixture.id): WakeTicket[] {
  return Array.from({ length: n }, () => addWake(ctx, patch, botId));
}

/** 给一张唤醒单在账本里记一行用量（成本页、额度窗口读账本，不读唤醒单）。 */
export function addLedger(ctx: HubContext, wake: WakeTicket, tokens: number): void {
  counter += 1;
  ctx.store.log('ledger').append({ id: `le_${String(900_000 + counter).padStart(10, '0')}`, who: wake.botId, wakeId: wake.id, tokens, kind: 'turn', at: wake.startedAt });
}
