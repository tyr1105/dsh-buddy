/**
 * P73r5：额度窗口不能把主人确认过的事挡在门外。
 *
 * 1. 起始回合数 8 -> 40：灯色出现的回合数按比例设置（黄 20、橙 32、红 40）；
 * 2. 橙灯放行 chiefDispatch（总管在主人发起的回合里派的活），红灯照样拦，普通自主候选橙灯照样拦；
 * 3. 旧存档：回合上限仍是 8 且没被真实额度报错校准过的，换成 40；校准过的保持。
 * 用真实的中心上下文与假时钟，只经 recordUsage、selectNext、rollWindow 这些公开入口。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { DEFAULTS } from '../src/config/defaults.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { getQuotaState, recordUsage, rollWindow } from '../src/quota/index.js';
import type { QuotaState } from '../src/model/index.js';
import { botFixture } from './model-fixtures.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';

const minute = 60_000;
const HOUR = 60 * minute;

/** 中心里有一位员工；已度过启动静默，可直接选择候选。 */
function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put(botFixture);
  ctx.runtime.startedAt = ctx.clock.now() - 10 * minute;
  return ctx;
}
/** 记 n 个机器人回合，由真实的计量入口算出灯色。 */
function useTurns(ctx: ReturnType<typeof setup>, n: number): void {
  // wakeId 要全程唯一，否则重复回合会被当成同一次回合去重。
  const base = ctx.store.log('ledger').all().length;
  for (let i = 0; i < n; i += 1) recordUsage(ctx, { botId: botFixture.id, wakeId: `w${base + i}`, tokens: 1, steps: 1, packetBytes: 0 });
}
/** 入队一条候选；dispatch 为真时带「总管派活」标记。 */
function queue(ctx: ReturnType<typeof setup>, dispatch: boolean, subjectKey: string) {
  // 候选属于另一位员工（新入职、今天还没开过工），避免被「单人每日回合上限」这道无关的闸拦住。
  if (!ctx.store.table('bots').get('b_new')) ctx.store.table('bots').put({ ...botFixture, id: 'b_new' });
  const candidate = buildCandidate(ctx, { botId: 'b_new', kind: 'percept', score: 0.8, summary: '交来一件事', subjectKey,
    ...(dispatch ? { chiefDispatch: true } : {}) });
  return enqueue(ctx, candidate)!;
}

/**
 * P76d 修改：额度灯现在按「员工份额已用比例」分档，不再按回合数。这里把窗口估计容量设成 100 token（员工份额 70 token），
 * 每个测试回合用 1 个 token，于是黄、橙、红分别出现在第 35、56、70 个回合（原来是 20、32、40，比例都是 0.5、0.8、1）。
 */
function smallCapacity(ctx: ReturnType<typeof setup>): void {
  ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(ctx.clock.now()), capacityTokens: 100 });
}

describe('起始回合数 40 与灯色比例', () => {
  it('默认值是 40，新窗口的上限取它', () => {
    expect(DEFAULTS.INITIAL_WINDOW_TURN_LIMIT).toBe(40);
    expect(getQuotaState(setup(), 0).turnLimit).toBe(40);
  });
  it('黄、橙、红分别出现在员工份额用到五成、八成、十成时，与比例设置一致', () => {
    const ctx = setup(); smallCapacity(ctx);
    useTurns(ctx, 34); expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('green');
    useTurns(ctx, 1); expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('yellow');
    useTurns(ctx, 21); expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('orange');
    useTurns(ctx, 13); expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('orange');
    useTurns(ctx, 1); expect(getQuotaState(ctx, ctx.clock.now())).toMatchObject({ light: 'red', botTurns: 70 });
  });
});

describe('橙灯放行主人确认过的事', () => {
  it('橙灯：总管派活的候选放行；同一时刻普通自主候选仍被拦', () => {
    const ctx = setup(); smallCapacity(ctx); useTurns(ctx, 56);
    expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('orange');
    const plain = queue(ctx, false, 'watch:plain');
    expect(selectNext(ctx, ctx.clock.now())).toBeNull();
    const dispatched = queue(ctx, true, 'peer:handoff');
    expect(selectNext(ctx, ctx.clock.now())?.id).toBe(dispatched.id);
    // 普通候选仍在队列里，没有被丢弃，只是橙灯时不放行。
    expect(ctx.store.table('queue').get(plain.id)).not.toBeNull();
  });
  it('红灯：总管派活的候选也被拦', () => {
    const ctx = setup(); smallCapacity(ctx); useTurns(ctx, 70);
    expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('red');
    queue(ctx, true, 'peer:handoff');
    expect(selectNext(ctx, ctx.clock.now())).toBeNull();
  });
});

describe('旧存档的起始回合数迁移', () => {
  /** 构造一份旧存档：上限 8，其余字段按需覆盖。 */
  const legacy = (ctx: ReturnType<typeof setup>, patch: Partial<QuotaState> = {}): void => {
    ctx.store.table('quota').put({ id: 'quota', windowStartAt: ctx.clock.now(), botTurns: 7, botTokens: 0, turnLimit: 8, tokenLimit: null,
      light: 'yellow', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null, ...patch });
  };
  it('上限仍是 8、没被真实报错校准过：换成 40，灯色按新上限重算', () => {
    const ctx = setup(); legacy(ctx, { light: 'orange' });
    expect(rollWindow(ctx, ctx.clock.now())).toMatchObject({ turnLimit: 40, botTurns: 7, light: 'green' });
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ turnLimit: 40, light: 'green' });
  });
  it('被真实额度报错校准过的（有 calibratedAt 或报错记录）保持校准值', () => {
    const calibrated = setup(); legacy(calibrated, { calibratedAt: calibrated.clock.now() - HOUR });
    expect(rollWindow(calibrated, calibrated.clock.now()).turnLimit).toBe(8);
    const errored = setup(); legacy(errored, { lastError: '额度不足', lastErrorAt: errored.clock.now() - HOUR });
    expect(rollWindow(errored, errored.clock.now()).turnLimit).toBe(8);
  });
  it('红灯中的旧存档不动，等探针结果', () => {
    const ctx = setup(); legacy(ctx, { light: 'red', redUntil: ctx.clock.now() + HOUR });
    expect(rollWindow(ctx, ctx.clock.now())).toMatchObject({ turnLimit: 8, light: 'red' });
  });
  it('反例：不是旧起始值 8 的上限不被改写', () => {
    const ctx = setup(); legacy(ctx, { turnLimit: 12 });
    expect(rollWindow(ctx, ctx.clock.now()).turnLimit).toBe(12);
  });
});
