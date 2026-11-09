/** 成本与预算口径交叉核对，覆盖来源、跨日、旧日志、在途和重启持久化。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { costView } from '../src/api/cost-views.js';
import { createUiApi } from '../src/api/index.js';
import { botUsageToday, recordUsage } from '../src/quota/usage.js';
import { LedgerEntrySchema, type LedgerEntry, type WakeTicket } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { FileStore } from '../src/store/file-store.js';

const setup = () => {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now() - 10 * 86_400_000 });
  return ctx;
};
const wake = (ctx: ReturnType<typeof setup>, suffix: string, patch: Partial<WakeTicket> = {}): WakeTicket => {
  const row = { ...modelFixtures.WakeTicket.valid as WakeTicket, id: `w_${suffix.padStart(10, '0')}`,
    startedAt: ctx.clock.now(), lastEventAt: ctx.clock.now(), dispatchedAt: ctx.clock.now(), ...patch };
  ctx.store.table('wakes').put(row);
  return row;
};
const bill = (ctx: ReturnType<typeof setup>, wakeId: string, tokens: number | null = 100) =>
  recordUsage(ctx, { botId: botFixture.id, wakeId, tokens, steps: 2, packetBytes: 300 });
const today = (ctx: ReturnType<typeof setup>) => costView(ctx, ctx.clock.now()).days[0]!;

describe('F13 每日成本', () => {
  it('包含主人发起，预算仍排除；总数与真实两笔账一致', () => {
    const ctx = setup(); const own = wake(ctx, '1', { ownerInitiated: true });
    bill(ctx, own.id); bill(ctx, wake(ctx, '2').id, 200);
    expect(today(ctx).total).toMatchObject({ turns: 2, ownerTurns: 1, unknownOwnerTurns: 0,
      tokens: 360, hostTokens: 300, estimatedTokens: 0, unknownTokens: 0, pending: 0 });
    expect(botUsageToday(ctx, botFixture.id, ctx.clock.now())).toEqual({ turns: 1, tokens: 240 });
    expect(today(ctx).bots[0]?.tokens).toBe(360);
  });
  it('宿主零与缺失分开，估算按包字节和步骤，历史保留当时倍率', () => {
    const ctx = setup(); bill(ctx, wake(ctx, '1').id, 0);
    ctx.settings = { ...ctx.settings, tokenAccountingMultiplier: 1.5 };
    const entry = bill(ctx, wake(ctx, '2').id, null);
    ctx.settings = { ...ctx.settings, tokenAccountingMultiplier: 2 };
    expect(entry).toMatchObject({ tokenSource: 'estimate', tokenBase: 4100, accountingMultiplier: 1.5, tokens: 6150 });
    expect(today(ctx).total).toMatchObject({ turns: 2, tokens: 6150, hostTokens: 0, estimatedTokens: 4100 });
  });
  it('跨午夜按结账时间归日，不按回合开始时间或宿主本机时区', () => {
    const ctx = setup(); ctx.clock.set(Date.parse('2026-11-05T23:59:59+08:00'));
    const late = wake(ctx, '1'); bill(ctx, wake(ctx, '2').id, 100);
    ctx.clock.advance(1000); bill(ctx, late.id, 200);
    const days = costView(ctx, ctx.clock.now()).days;
    expect(days[0]).toMatchObject({ date: '2026-11-06', total: { turns: 1, tokens: 240 } });
    expect(days[1]).toMatchObject({ date: '2026-11-05', total: { turns: 1, tokens: 120 } });
  });
  it('回合重复结算只记一笔，失败且有消费仍有费用', () => {
    const ctx = setup(); const row = wake(ctx, '1', { status: 'error', endedAt: ctx.clock.now(), error: '失败' });
    bill(ctx, row.id); bill(ctx, row.id, 999);
    expect(today(ctx).total).toMatchObject({ turns: 1, tokens: 120, pending: 0 });
  });
  it('已交账但宿主没结束仍在途，投递失败与未来回合不算', () => {
    const ctx = setup();
    wake(ctx, '1', { status: 'committed' });
    wake(ctx, '2', { dispatchedAt: null, status: 'error', endedAt: ctx.clock.now() });
    wake(ctx, '3', { startedAt: ctx.clock.now() + 1, dispatchedAt: ctx.clock.now() + 1 });
    expect(today(ctx).total).toMatchObject({ turns: 0, tokens: 0, pending: 1 });
    bill(ctx, 'w_0000000001');
    expect(today(ctx).total).toMatchObject({ turns: 1, pending: 0 });
  });
  it('旧日志来源未知，唤醒缺失仍保留金额与归属，主人独立用量排除', () => {
    const ctx = setup();
    const old: LedgerEntry = { id: 'le_0000000001', who: 'b_missing', wakeId: 'w_old',
      kind: 'turn', tokens: 321, at: ctx.clock.now() };
    ctx.store.log('ledger').append(old);
    ctx.store.log('ledger').append({ ...old, id: 'le_0000000002', who: 'owner', tokens: 999 });
    expect(LedgerEntrySchema.parse(old)).toEqual(old);
    expect(today(ctx).bots).toContainEqual(expect.objectContaining({ botId: 'b_missing', name: 'b_missing', archived: true, tokens: 321 }));
    expect(today(ctx).total).toMatchObject({ tokens: 321, hostTokens: 0, estimatedTokens: 0,
      unknownTokens: 321, unknownMeasurements: 1, unknownOwnerTurns: 1 });
  });
  it('日志中的发起标记不依赖唤醒保留，压缩和其它用量只计 token', () => {
    const ctx = setup(); const row = wake(ctx, '1', { ownerInitiated: true }); bill(ctx, row.id);
    ctx.store.table('wakes').remove(row.id);
    ctx.store.log('ledger').append({ id: 'le_0000000009', who: botFixture.id, wakeId: null, tokens: 30,
      kind: 'compaction', at: ctx.clock.now() });
    expect(today(ctx).total).toMatchObject({ turns: 1, ownerTurns: 1, tokens: 150, unknownTokens: 30 });
  });
  it('只取最近七个日历日与截至当前的记录，夏令时日仍完整', () => {
    const ctx = setup(); ctx.settings = { ...ctx.settings, timezone: 'America/New_York' };
    ctx.clock.set(Date.parse('2026-11-02T00:00:00-05:00'));
    const base: LedgerEntry = { id: 'le_0000000001', who: botFixture.id, wakeId: null, kind: 'other',
      tokens: 7, at: Date.parse('2026-11-01T00:30:00-04:00') };
    ctx.store.log('ledger').append(base);
    ctx.store.log('ledger').append({ ...base, id: 'le_0000000002', tokens: 9, at: Date.parse('2026-11-01T23:30:00-05:00') });
    ctx.store.log('ledger').append({ ...base, id: 'le_0000000003', tokens: 100, at: ctx.clock.now() + 1 });
    ctx.store.log('ledger').append({ ...base, id: 'le_0000000004', tokens: 100, at: Date.parse('2026-10-25T23:59:00-04:00') });
    const result = costView(ctx, ctx.clock.now());
    expect(result.days.map(row => row.date)).toEqual(['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27']);
    expect(result.days[1]?.total.tokens).toBe(16);
    expect(result.days.reduce((sum, row) => sum + row.total.tokens, 0)).toBe(16);
  });
  it('零成本与缺数据区别：有队友的空账有零行，无项目明确未分摊', () => {
    const ctx = setup();
    expect(today(ctx).bots[0]).toMatchObject({ botId: botFixture.id, turns: 0, tokens: 0 });
    expect(costView(ctx, ctx.clock.now()).projectStatus).toBe('unallocated');
  });
  it('概览读取不推进额度、不发事件、不落账', async () => {
    const ctx = setup(); bill(ctx, wake(ctx, '1').id);
    await ctx.store.flush(); const before = structuredClone(ctx.store.log('ledger').all()), events = ctx.events.length;
    const api = createUiApi(ctx, async () => { throw new Error('读取不应触发命令'); });
    expect(api.overview().costs?.days[0]?.total.tokens).toBe(120);
    expect(api.overview().costs).toEqual(api.overview().costs);
    expect(ctx.store.log('ledger').all()).toEqual(before);
    expect(ctx.store.isDirty()).toBe(false);
    expect(ctx.events).toHaveLength(events);
  });
  it('新来源字段可真实刷盘和重载，旧行不因可选字段丢失', async () => {
    const ctx = setup(); const store = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    const fresh = bill(ctx, wake(ctx, '1').id);
    store.log('ledger').append(fresh);
    store.log('ledger').append({ id: 'le_0000000009', who: botFixture.id, wakeId: null, kind: 'other', tokens: 5, at: ctx.clock.now() });
    await store.flush();
    const restored = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    await restored.load();
    expect(restored.log('ledger').all()).toEqual(store.log('ledger').all());
  });
});
