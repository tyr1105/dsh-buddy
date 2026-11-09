/** M02 探针恢复回归：身份与额度状态一起持久化，丢失记录不能借旧审计成功或永久锁死。 */
import { expect, test } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, modelFixtures, id } from './model-fixtures.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createHub } from '../src/engine/hub.js';
import { consumeProbe, getQuotaState, maybeAllowProbe } from '../src/quota/window.js';
import { WakeTicketSchema, QueueEntrySchema } from '../src/model/index.js';
import { createInboxItem } from '../src/outreach/inbox.js';

/** 直接准备重启前持久事实，不把旧 dispatcher 的闭包作为恢复依据。 */
function fixture() {
  const ctx = createTestContext(); const now = ctx.clock.now();
  ctx.store.table('bots').put({ ...botFixture, sessionId: 'probe-session', lastThinkAt: null });
  ctx.runtime.startedAt = now - ctx.settings.startupQuietMs;
  ctx.store.table('quota').put({ ...getQuotaState(ctx, now), light: 'red', redUntil: now, probeAllowed: true });
  return { ctx, now };
}
function wake(ctx: ReturnType<typeof fixture>['ctx'], status: 'running' | 'committed', wakeId = id('w')) {
  const now = ctx.clock.now();
  return ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: wakeId,
    botId: botFixture.id, sessionId: 'probe-session', status, startedAt: now - 1000, lastEventAt: now - 1000,
    endedAt: status === 'committed' ? now : null, dispatchedAt: now - 1000 });
}
function oldAudit(ctx: ReturnType<typeof fixture>['ctx']) {
  wake(ctx, 'committed', 'w_0000000099');
  ctx.store.log('audit').append({ id: 'au_0000000099', at: ctx.clock.now() - 86_400_000, actor: 'hub', action: 'wake_dispatched',
    detail: JSON.stringify({ wakeId: 'w_0000000099', probe: true }) });
}

test('探针许可消费时原子保存wakeId，重复消费不能更换绑定', () => {
  const { ctx } = fixture();
  expect(consumeProbe(ctx, 'w_0000000001')).toBe(true);
  expect(consumeProbe(ctx, 'w_0000000002')).toBe(false);
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ probeInFlight: true, probeAllowed: false, probeWakeId: 'w_0000000001' });
});

test('非法探针id不消耗许可', () => {
  const { ctx } = fixture(); expect(() => consumeProbe(ctx, '')).toThrow('探针唤醒单');
  expect(ctx.store.table('quota').get('quota')?.probeAllowed).toBe(true);
});

test.each(['no_binding', 'old_audit', 'missing_wake', 'damaged_terminal'] as const)('重建dispatcher遇%s按失败等待并最终可再探针', kind => {
  const { ctx, now } = fixture();
  if (kind === 'old_audit') oldAudit(ctx);
  if (kind === 'damaged_terminal') { wake(ctx, 'running'); ctx.store.table('wakes').patch(id('w'), { status: 'error', endedAt: null }); }
  consumeProbe(ctx, kind === 'missing_wake' ? 'w_missing' : kind === 'damaged_terminal' ? id('w') : undefined);
  createDispatcher(ctx).finishProbe();
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: false, probeWakeId: null,
    redUntil: now + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs });
  ctx.clock.set(ctx.store.table('quota').get('quota')!.redUntil!);
  expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
});

test('只有旧成功审计不会提前完成本次仍运行探针', () => {
  const { ctx } = fixture(); oldAudit(ctx); wake(ctx, 'running'); consumeProbe(ctx, id('w'));
  createDispatcher(ctx).finishProbe();
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: true, probeWakeId: id('w') });
});

test('没有审计也能按持久绑定的真实成功探针恢复', () => {
  const { ctx } = fixture(); wake(ctx, 'committed'); consumeProbe(ctx, id('w'));
  expect(ctx.store.log('audit').all()).toHaveLength(0);
  createDispatcher(ctx).finishProbe();
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'green', probeInFlight: false, probeWakeId: null, redUntil: null });
});

test('重建真实Hub且没有投递审计，结束事件仍能恢复绑定探针', async () => {
  const { ctx } = fixture(); wake(ctx, 'running'); consumeProbe(ctx, id('w'));
  const hub = createHub(ctx); await hub.start();
  await hub.onTurnEvent({ type: 'ended', sessionId: 'probe-session', at: ctx.clock.now(), finalText: '完成', tokens: 0 });
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'green', probeInFlight: false, probeWakeId: null });
  await hub.stop();
});

test.each(['paused', 'waiting_owner'] as const)('恢复时%s候选被丢弃，保留许可直到下一真实候选作为探针', async reason => {
  const { ctx, now } = fixture();
  ctx.store.table('quota').patch('quota', { probeAllowed: false });
  const otherId = 'b_0000000002';
  ctx.store.table('bots').put({ ...botFixture, id: otherId, name: '候选机器人', sessionId: null, lifecycle: reason === 'paused' ? 'paused' : 'active' });
  const subjectKey = 'question:old';
  ctx.store.table('queue').put({ ...QueueEntrySchema.parse(modelFixtures.QueueEntry.valid), botId: otherId, subjectKey,
    reason: { kind: 'next_think', score: 0.75, threshold: 0.6, summary: '旧候选', evidence: [] }, ownerInitiated: false, notBefore: now });
  if (reason === 'waiting_owner') createInboxItem(ctx, { botId: otherId, type: 'question', title: '等回答', body: '请选择',
    options: ['继续', '暂停'], defaultOption: '暂停', subjectKey });
  const dispatcher = createDispatcher(ctx); await dispatcher.pump();
  expect(ctx.store.table('queue').count()).toBe(0);
  expect(ctx.store.table('quota').get('quota')?.probeAllowed).toBe(true);
  await dispatcher.pump();
  // M03 不再无事制造 retry；原探针成功链保留，改由真实主人工作触发。
  expect(ctx.store.table('wakes').list()).toHaveLength(0);
  expect(ctx.store.table('quota').get('quota')?.probeAllowed).toBe(true);
  ctx.store.table('queue').put({ ...QueueEntrySchema.parse(modelFixtures.QueueEntry.valid), botId: botFixture.id,
    reason: { kind: 'owner_message', score: 1, threshold: 0.6, summary: '主人请核对真实资料', evidence: ['owner-real-work'] },
    ownerInitiated: true, notBefore: now });
  await dispatcher.pump();
  expect(ctx.store.table('wakes').list()).toHaveLength(1);
  const probe = ctx.store.table('wakes').list()[0]!;
  expect(probe.botId).toBe(botFixture.id); expect(probe.status).toBe('running');
  expect(ctx.store.table('quota').get('quota')).toMatchObject({ probeInFlight: true, probeAllowed: false, probeWakeId: probe.id });
});
