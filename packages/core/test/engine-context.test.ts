/** 共享测试环境与公开入口的组合校验，确保各模块能使用同一套注入依赖且互不污染。 */
import { it, expect } from 'vitest';
import { testing, resolveSettings, buildCandidate, enqueue, selectNext, recordOwnerMessage, recordInboxReply, InboxItemSchema } from '../src/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

it('默认北京时钟与每实例集合隔离，支持替换注入接口', () => {
  const a = testing.createTestContext(); const b = testing.createTestContext();
  expect(a.clock.now()).toBe(Date.parse('2026-11-05T10:00:00+08:00'));
  a.runtime.suppressionLogAt.set('bot:quota', 1); a.emit('bots', 'bot');
  expect(b.runtime.suppressionLogAt.size).toBe(0); expect(b.events).toEqual([]);
  const clock = new testing.FakeClock(42); const ctx = testing.createTestContext({ clock });
  expect(ctx.runtime.startedAt).toBe(42); expect(ctx.clock).toBe(clock);
});
it('新配置可以局部覆盖，不污染下一份设置并拒绝非法并发', () => {
  const s = resolveSettings({ c02: { pollConcurrency: 1, priorities: { drive: 55 } }, heartbeatPid: 123 });
  expect(s.c02.pollConcurrency).toBe(1); expect(s.c02.priorities.drive).toBe(55); expect(s.c02.priorities.owner).toBe(100);
  expect(resolveSettings().c02.pollConcurrency).toBe(3);
  expect(() => resolveSettings({ c02: { pollConcurrency: 4 } })).toThrow('pollConcurrency');
});
it('主人消息从感知证据恢复真实 messageId，经公共出口立即选择而不调用宿主', () => {
  const ctx = testing.createTestContext(); ctx.store.table('bots').put(botFixture);
  const p = recordOwnerMessage(ctx, { botId: botFixture.id, id: 'm_original', summary: '核对进展', at: ctx.clock.now() })!;
  const candidate = buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: p.salience, summary: p.summary, evidence: [p.id] });
  expect(candidate.subjectKey).toBe('owner:m_original'); enqueue(ctx, candidate);
  expect(selectNext(ctx, ctx.clock.now())?.reason.kind).toBe('owner_message'); expect(ctx.host.calls).toEqual([]);
});
it('回复感知证据追溯至收件箱的原事项键', () => {
  const ctx = testing.createTestContext(); ctx.store.table('bots').put(botFixture);
  const inbox = { ...InboxItemSchema.parse(modelFixtures.InboxItem.valid), subjectKey: 'watch:original' }; ctx.store.table('inbox').put(inbox);
  const p = recordInboxReply(ctx, { botId: botFixture.id, id: inbox.id, summary: '继续', at: ctx.clock.now() })!;
  expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'inbox_reply', score: p.salience, summary: p.summary, evidence: [p.id] }).subjectKey).toBe('watch:original');
});
it('假宿主记录调用不启动任何真实会话', async () => {
  const ctx = testing.createTestContext(); const source = { kind: 'agent-hub' as const, wakeId: 'wake', botId: botFixture.id, variant: 'regular' as const };
  const { sessionId } = await ctx.host.createSession({ botId: botFixture.id, title: '测试', cwd: '/hub', rolePresetId: 'role', permissionPresetId: 'permission', model: null, firstMessage: '开始', source });
  await ctx.host.deliver(sessionId, '继续', source); await ctx.host.steer(sessionId, '收口'); await ctx.host.cancel(sessionId);
  expect(await ctx.host.sessionInfo(sessionId)).toMatchObject({ exists: true, running: false });
  expect(ctx.host.calls.map(call => call.method)).toEqual(['createSession', 'deliver', 'steer', 'cancel', 'sessionInfo']);
});
