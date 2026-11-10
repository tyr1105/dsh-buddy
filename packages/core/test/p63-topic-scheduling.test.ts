/**
 * P63 主题回合的调度与额度：
 * 不同主题不合并、subjectKey 不撞冷却、不走感知再排一条私聊、
 * 主题回合不计窗口也不占自主额度（账本照记），服务商真报额度错误时仍暂停。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { onQuotaError } from '../src/quota/index.js';
import { saveProject } from '../src/project/service.js';
import { createProjectTopic } from '../src/project/topics.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { QueueEntrySchema, WakeTicketSchema, type Bot } from '../src/model/index.js';
import { floors, openTopic, queued, runningWake, speak, topicHub } from './p63-topic-fixtures.js';

/** 不启动 Hub 的最小环境：只看入队结果，不发生投递。 */
function plain() {
  const ctx = createTestContext();
  const owner: Bot = { ...botFixture, id: 'b_0000000001', name: '老大', role: 'chief' };
  const member: Bot = { ...botFixture, id: 'b_0000000002', name: '小王', role: 'executor' };
  ctx.store.table('bots').put(owner);
  ctx.store.table('bots').put(member);
  const project = saveProject(ctx, { name: '季度战役', memberBotIds: [owner.id, member.id] });
  return { ctx, owner, member, project };
}

describe('P63 同一队友的候选怎么合并', () => {
  it('不同主题不合并：各排一条，互不吞掉', () => {
    const { ctx, owner, project } = plain();
    const a = createProjectTopic(ctx, { projectId: project.id, text: '主题 A' }).topicId;
    const b = createProjectTopic(ctx, { projectId: project.id, text: '主题 B' }).topicId;
    expect(ctx.store.table('queue').count(row => row.botId === owner.id)).toBe(2);
    expect(queued(ctx, owner.id, a)).toBeDefined();
    expect(queued(ctx, owner.id, b)).toBeDefined();
  });

  it('同一主题合并成一条，两句话的证据都留着', () => {
    const { ctx, owner, project } = plain();
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '第一句' });
    const second = sendOwnerMessage(ctx, topicId, '第二句');
    expect(ctx.store.table('queue').count(row => row.botId === owner.id)).toBe(1);
    expect(queued(ctx, owner.id, topicId)!.reason.evidence).toContain(second.id);
  });

  it('排队中的同伴点名被主人的新消息接管：理由变成主人消息，证据都留着', () => {
    const { ctx, owner, member, project } = plain();
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '@小王 先看' });
    const first = queued(ctx, member.id, topicId)!;
    ctx.store.table('queue').patch(first.id, { reason: { ...first.reason, kind: 'peer_message', score: ctx.settings.c02.replySalience } });
    const second = sendOwnerMessage(ctx, topicId, '@小王 再看一眼');
    const merged = queued(ctx, member.id, topicId)!;
    expect(merged.reason.kind).toBe('owner_message');
    expect(merged.reason.evidence).toEqual(expect.arrayContaining([second.id, ...first.reason.evidence]));
    expect(owner.id).toBeTruthy();
  });

  it('主题候选和私聊候选不合并', () => {
    const { ctx, owner, project } = plain();
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '主题里的话' });
    sendOwnerMessage(ctx, owner.id, '私聊的话');
    const rows = ctx.store.table('queue').list(row => row.botId === owner.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.topicId === topicId)).toHaveLength(1);
    expect(rows.filter(row => !row.topicId)).toHaveLength(1);
  });

  it('旧数据：没有 topicId 的候选和唤醒单能读，按不属于主题处理', () => {
    const { topicId: _a, ...oldEntry } = { ...(modelFixtures.QueueEntry.valid as Record<string, unknown>), topicId: undefined };
    expect(QueueEntrySchema.safeParse(oldEntry).success).toBe(true);
    expect(WakeTicketSchema.safeParse(modelFixtures.WakeTicket.valid).success).toBe(true);
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture });
    ctx.store.table('queue').put({ ...QueueEntrySchema.parse(oldEntry), botId: botFixture.id });
    // 新的私聊候选按「无主题」并进这条旧候选，不会多出一条。
    enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '新消息', ownerInitiated: true, messageId: 'm_1' }));
    expect(ctx.store.table('queue').count()).toBe(1);
  });
});

describe('P63 subjectKey 与闸门', () => {
  it('subjectKey 带消息 id，同一主题的两句话是两个事项', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '第一句');
    const firstKey = runningWake(fix.ctx, owner!.id)!.subjectKey;
    expect(firstKey).toMatch(new RegExp(`^topic:${topicId}:m_`));
    await speak(fix, owner!, '收到');
    await fix.hub.api.sendMessage(topicId, '第二句');
    const second = runningWake(fix.ctx, owner!.id)!;
    expect(second.subjectKey).not.toBe(firstKey);
  });

  it('不撞 6 小时冷却：刚说完的队友立刻能被再次叫醒', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '第一句');
    await speak(fix, owner!, '收到');
    fix.ctx.clock.advance(1_000);
    await fix.hub.api.sendMessage(topicId, '第二句');
    expect(runningWake(fix.ctx, owner!.id)).toBeDefined();
  });

  it('主题回合不等最短间隔、不占自主额度；普通同伴消息反例会被拦', () => {
    const { ctx, owner, project } = plain();
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '开工' });
    const entry = queued(ctx, owner.id, topicId)!;
    const now = ctx.clock.now();
    ctx.store.table('bots').patch(owner.id, { lastThinkAt: now });
    const snapshot = { ...buildSnapshot(ctx, owner.id, now), todayTurns: 100, windowTurns: 100 };
    expect(evaluateGates(entry, snapshot, now, ctx.settings)).toEqual({ pass: true });
    const ordinary = { ...entry, ownerInitiated: false, urgent: false };
    expect(evaluateGates(ordinary, snapshot, now, ctx.settings).pass).toBe(false);
  });

  it('感知收集器不会把主题消息再排成一条私聊唤醒', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '第一句');
    fix.ctx.clock.advance(60_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count(wake => wake.botId === owner!.id)).toBe(1);
    expect(fix.ctx.store.table('queue').count(row => row.botId === owner!.id && !row.topicId)).toBe(0);
    expect(fix.ctx.store.table('percepts').count(row => row.botId === owner!.id)).toBe(0);
    expect(floors(fix.ctx, topicId)).toHaveLength(1);
  });

  it('总管下一次的自主候选不会被排队中的主题回合吞掉', async () => {
    const fix = await topicHub(['老大', '小王', '小李']);
    const [, wang, li] = fix.bots;
    const topicId = await openTopic(fix, '@小王 @小李 看下');
    expect(queued(fix.ctx, li!.id, topicId)).toBeDefined();
    enqueue(fix.ctx, buildCandidate(fix.ctx, { botId: li!.id, kind: 'next_think', score: 0.9, summary: '到点想一想' }));
    expect(fix.ctx.store.table('queue').count(row => row.botId === li!.id)).toBe(2);
    expect(runningWake(fix.ctx, wang!.id)).toBeDefined();
  });
});

describe('P63 额度', () => {
  it('主题回合：不加窗口回合和 token，账本照记，成本表看得到', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const wakeId = runningWake(fix.ctx, owner!.id)!.id;
    await speak(fix, owner!, '收到');
    const quota = fix.ctx.store.table('quota').get('quota');
    expect(quota?.botTurns ?? 0).toBe(0);
    expect(quota?.botTokens ?? 0).toBe(0);
    const ledger = fix.ctx.store.log('ledger').all().filter(row => row.wakeId === wakeId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.tokens).toBeGreaterThan(0);
    expect(fix.hub.api.overview().costs!.days.reduce((sum, day) => sum + day.total.turns, 0)).toBe(1);
  });

  it('反例：私聊回合照旧计入窗口', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await fix.hub.api.sendMessage(owner!.id, '私聊一句');
    await speak(fix, owner!, '收到');
    expect(fix.ctx.store.table('quota').get('quota')?.botTurns).toBe(1);
  });

  it('主题回合不减少队友的自主额度', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    const snapshot = buildSnapshot(fix.ctx, owner!.id, fix.ctx.clock.now());
    expect(snapshot.todayTurns).toBe(0);
    expect(snapshot.windowTurns).toBe(0);
  });

  it('服务商真报额度错误时红灯暂停：消息保留，主题里有说明，恢复前不投递', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    onQuotaError(fix.ctx, fix.ctx.clock.now());
    const topicId = await openTopic(fix, '开工');
    expect(runningWake(fix.ctx, owner!.id)).toBeUndefined();
    expect(queued(fix.ctx, owner!.id, topicId)).toBeDefined();
    expect(floors(fix.ctx, topicId).some(row => row.kind === 'system' && row.text.includes('额度不足'))).toBe(true);
  });
});
