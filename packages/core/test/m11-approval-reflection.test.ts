/** M11 把复盘与批准动作完整串过真实 Hub：复盘暂时只读，不能消费或终结一次有效批准。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue, removeEntry } from '../src/scheduler/queue.js';
import { createTicket } from '../src/wake/ticket.js';
import { requestApproval, decideApproval } from '../src/gate/approvals.js';
import { hasApprovalDecision } from '../src/util/approval-candidate.js';
// P75r3 第 10 节：P75f 删掉的「M11 复盘期间批准后的真实 Hub 执行」三条与 worldFor、finishReflection 辅助函数在文件末尾恢复。
// 复盘变体回合的机制还在（队列、派活、闸门的只读判断），只是旧的触发（纠正、连续未交账）下线了：
// 恢复的测试改为直接往队列里放一条复盘变体的候选来驱动，断言与原来一致。
import { createSimWorld, advance, type SimWorld } from '../src/sim/runner.js';
import { commitBrain } from '../src/sim/brains.js';
import type { Brain } from '../src/sim/types.js';
import { createRuntime, type HubContext } from '../src/engine/context.js';
import { createBotHome } from '../src/memory/files.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { interruptBot } from '../src/api/interrupt.js';
import { guardToolCall } from '../src/gate/guard.js';
import { runTool } from '../src/tools/index.js';
import { onTurnEvent } from '../src/turn/events.js';

const hook = 'https://hooks.example.com/morning';
const directArgs = { command: `curl -X POST ${hook} -d 结果` };
const botId = 'b_m11approve';
const minute = 60_000;

/** 返回真正的审批决定候选，证据中保留审批单和感知，供验证被主人理由盖住后的间接合并。 */
async function queueContext() {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', sessionId: null, lastThinkAt: null });
  await createBotHome(ctx, ctx.store.table('bots').get(botFixture.id)!);
  ctx.clock.advance(ctx.settings.startupQuietMs);
  const approval = await requestApproval(ctx, botFixture.id, 'bash', directArgs, 'C', '推送结果');
  await decideApproval(ctx, approval.id, true);
  const entry = ctx.store.table('queue').list()[0]!;
  removeEntry(ctx, entry.id);
  const { id: _id, enqueuedAt: _at, ...candidate } = entry;
  return { ctx, candidate };
}

describe('M11 审批与只读复盘分开排队', () => {
  it.each([
    ['reflection', 'approval', 'owner'], ['reflection', 'owner', 'approval'],
    ['approval', 'reflection', 'owner'], ['approval', 'owner', 'reflection'],
    ['owner', 'reflection', 'approval'], ['owner', 'approval', 'reflection'],
  ])('入队顺序 %s → %s → %s 都保留独立复盘与审批证据', async (...order) => {
    const { ctx, candidate } = await queueContext();
    const reflection = buildCandidate(ctx, { botId: botFixture.id, kind: 'reflection', variant: 'reflection', score: 0.8, summary: '复盘收口方式' });
    const owner = buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '继续处理', messageId: 'm_owner' });
    for (const kind of order) enqueue(ctx, kind === 'approval' ? candidate : kind === 'reflection' ? reflection : owner);
    const entries = ctx.store.table('queue').list();
    expect(entries).toHaveLength(2);
    const reflect = entries.find(row => row.variant === 'reflection')!;
    const approved = entries.find(row => hasApprovalDecision(ctx, row))!;
    expect(reflect).toBeDefined();
    expect(hasApprovalDecision(ctx, reflect)).toBe(false);
    expect(approved.variant).toBe('regular');
    expect(approved.reason.evidence).toEqual(expect.arrayContaining(candidate.reason.evidence));
    removeEntry(ctx, approved.id);
    expect(ctx.store.table('queue').list()).toEqual([reflect]);
    expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('queued');
  });

  it('普通候选仍合并，只有复盘与审批需要分别保留', async () => {
    const { ctx, candidate } = await queueContext();
    enqueue(ctx, candidate);
    enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 1, summary: '普通变化' }));
    expect(ctx.store.table('queue').list()).toHaveLength(1);
    expect(ctx.store.table('queue').list()[0]?.variant).toBe('regular');
  });

  // P75f：连续未交账不再强制转复盘（旧触发下线），原「连续未交账不会把审批改成复盘……」测试删除。

  it('审批并入主人主理由后，常规唤醒包仍附审批结果并允许原参数 bash 执行', async () => {
    const { ctx, candidate } = await queueContext();
    enqueue(ctx, candidate);
    enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '继续完成', messageId: 'm_continue' }));
    enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'reflection', variant: 'reflection', score: 0.8, summary: '复盘处理方式' }));
    await createDispatcher(ctx).pump();
    const wake = ctx.store.table('wakes').list()[0]!;
    expect(wake).toMatchObject({ variant: 'regular', reason: { kind: 'owner_message' } });
    const packet = (ctx.host.calls.find(call => call.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain('## 审批结果');
    expect(packet).toContain('主人已批准，用完全相同的参数再调用一次。');
    expect(await guardToolCall(ctx, wake.sessionId!, 'bash', directArgs)).toMatchObject({ allow: true });
    expect(ctx.store.table('approvals').list()[0]?.status).toBe('used');
    expect(ctx.store.table('queue').list().map(row => row.variant)).toEqual(['reflection']);
  });

  it.each(['deferred', 'legacy'] as const)('%s 审批证据在投递前再次分离，复盘不消费，之后常规回合仍能执行', async source => {
    const { ctx, candidate } = await queueContext();
    // 保留显式设置 6：本用例要连续跑三个自己发起的回合（常规、事项键不是技能类的复盘、常规），默认的每天 2 个上限会先拦住第三个；
    // 它证明的是审批证据在投递前再次分离，与每天上限无关（P76b 加，P76c 核对后保留，只改说明）。
    ctx.settings.botDailyTurnBudget = 6;
    const dispatcher = createDispatcher(ctx);
    if (source === 'deferred') {
      enqueue(ctx, candidate);
      await dispatcher.pump();
      await interruptBot(ctx, { botId: botFixture.id });
      expect(ctx.store.table('percepts').list().some(row => row.kind === 'approval_decided' && row.deferredByOwner)).toBe(true);
    }
    const reflection = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'reflection', variant: 'reflection', score: 0.8, summary: '复盘处理方式' }))!;
    if (source === 'legacy') ctx.store.table('queue').patch(reflection.id, { reason: candidate.reason });
    ctx.clock.advance(ctx.settings.dispatchGapMs);
    await dispatcher.pump();
    const wake = ctx.store.table('wakes').list(row => row.variant === 'reflection')[0]!;
    expect(wake).toBeDefined();
    expect(hasApprovalDecision(ctx, wake)).toBe(false);
    expect(ctx.store.table('queue').list().map(row => row.variant)).toEqual(['regular']);
    expect(ctx.store.table('approvals').list()[0]?.status).toBe('approved');
    expect(ctx.store.table('percepts').list(row => row.kind === 'approval_decided').every(row => row.consumedByWake === null)).toBe(true);
    const packets = ctx.host.calls.filter(call => call.method === 'createSession').map(call => (call.args[0] as { firstMessage: string }).firstMessage);
    expect(packets.at(-1)).not.toContain('## 审批结果');
    // P75f：旧复盘交账工具已删除；在途的复盘回合改用 hub_commit 收口（机制同前：只读、不吃掉批准票）。
    expect(await runTool(ctx, { botId: botFixture.id, sessionId: wake.sessionId!, wakeId: wake.id }, 'hub_commit',
      { outcome: 'no_change', summary: '复盘完成', worldChanges: [], evidence: [], verification: { level: 'agent', notCovered: '复盘只读' },
        blocker: null, nextThink: { mode: 'auto', reason: '复盘完成' }, ownerQuestion: null, reply: null, report: null,
        importance: ctx.settings.c03.reflectCommitImportance, proposals: [] })).toMatchObject({ ok: true });
    ctx.host.sessions.get(wake.sessionId!)!.running = false;
    await onTurnEvent(ctx, { type: 'ended', sessionId: wake.sessionId!, at: ctx.clock.now(), tokens: 1000, finalText: '复盘完成' });
    ctx.clock.advance(ctx.settings.dispatchGapMs);
    await dispatcher.pump();
    const regular = ctx.store.table('wakes').list(row => row.variant === 'regular' && row.endedAt === null)[0]!;
    expect(regular).toBeDefined();
    expect(hasApprovalDecision(ctx, regular)).toBe(true);
    expect(await guardToolCall(ctx, regular.sessionId!, 'bash', directArgs)).toMatchObject({ allow: true });
    expect(ctx.store.table('approvals').list()[0]?.status).toBe('used');
    expect(ctx.store.table('queue').list()).toHaveLength(0);
  });
});

/**
 * 对齐审查剧本：先经主人消息提交待批动作，再往队列里直接放一条复盘变体的候选（原来由「纠正」触发，触发已下线）；
 * 只有真实复盘回合会挂起。notBefore 为空时下一个 tick 就会派出复盘；给了 notBefore 就留在队列里（对应原来「复盘还没轮到」的情形）。
 */
async function worldFor(kind: 'http' | 'file' | 'direct', reflectionNow = true) {
  let submitted = false;
  const packets: Array<{ variant: string; packet: string }> = [];
  const attempts: Array<{ variant: string; ok: boolean }> = [];
  const brain: Brain = async input => {
    packets.push({ variant: input.variant, packet: input.packet });
    if (input.variant === 'reflection') return { hang: true };
    if ((!submitted && input.packet.includes('交付早盘结果')) || (kind === 'direct' && input.packet.includes('用完全相同的参数再调用一次'))) {
      submitted = true;
      const result = kind === 'direct' ? await input.call('bash', directArgs) : await input.call('hub_outbox_submit', kind === 'http'
        ? { kind: 'http_post', payload: { url: hook, body: '早盘结果' }, why: '交付早盘结果' }
        : { kind: 'write_file', payload: { path: '/outside/result.md', content: '早盘结果' }, why: '交付早盘结果' });
      attempts.push({ variant: input.variant, ok: result.ok });
      if (kind !== 'direct') expect(result).toMatchObject({ ok: true });
    }
    return commitBrain(input, { outcome: 'progress', summary: '已处理', reply: '收到' });
  };
  const world = await createSimWorld({ startAt: Date.parse('2026-11-04T10:00:00+08:00'),
    settings: reflectionNow ? { paceMinMsByRole: { sentinel: minute, researcher: minute, executor: minute, chief: minute } } : {},
    bots: [{ id: botId, role: 'executor', autonomy: 'L2', brain }] });
  world.net.set(hook, { status: 200, text: 'ok', contentType: 'text/plain' });
  await world.hub.api.sendMessage(botId, '请交付早盘结果。');
  await world.host.settle();
  await advance(world, 3 * minute);
  // 直接往队列里放一条复盘变体的候选；不立刻派出时推到很久以后。
  // 世界里的存储、时钟等都是同一份；入队只读写存储和设置，用一个只装这些的上下文即可（和仿真世界建家目录时的做法一样）。
  const ctx: HubContext = { host: world.host, clock: world.clock, rng: world.rng, fs: world.fs, net: world.net, exec: world.exec,
    logger: world.logger, store: world.store, settings: world.settings, runtime: createRuntime(world.startAt), emit: () => undefined };
  const now = ctx.clock.now();
  enqueue(ctx, buildCandidate(ctx, { botId, kind: 'reflection', variant: 'reflection', score: 0.8, summary: '复盘收口方式', now,
    ...(reflectionNow ? {} : { notBefore: now + 6 * 60 * minute }) }));
  await advance(world, 2 * minute);
  return { world, packets, attempts };
}

/** 宿主真的收到交账并结束复盘回合（旧复盘交账工具已删除，改用 hub_commit）；同时维护仿真会话簿记，避免空闲检查被假在途挡住。 */
async function finishReflection(world: SimWorld) {
  const wake = world.store.table('wakes').list(row => row.variant === 'reflection' && row.endedAt === null)[0]!;
  expect(wake).toBeDefined();
  const args = { outcome: 'no_change', summary: '已经复盘', worldChanges: [], evidence: [], verification: { level: 'agent', notCovered: '复盘只读' },
    blocker: null, nextThink: { mode: 'auto', reason: '复盘完成' }, ownerQuestion: null, reply: null, report: null,
    importance: world.settings.c03.reflectCommitImportance, proposals: [] };
  expect(await world.hub.guardToolCall(wake.sessionId!, 'hub_commit', args)).toMatchObject({ allow: true });
  expect(await world.hub.tools().find(tool => tool.name === 'hub_commit')!.handler(wake.sessionId!, args)).toMatchObject({ ok: true });
  world.host.sessions.get(wake.sessionId!)!.running = false;
  for (const turn of world.host.turns.filter(row => row.sessionId === wake.sessionId && row.endedAt === null)) {
    turn.endedAt = world.clock.now(); turn.status = 'ended';
  }
  await world.hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: world.clock.now(), tokens: 1000, finalText: '复盘完成' });
  await world.host.settle();
}

describe('M11 复盘期间批准后的真实 Hub 执行', () => {
  it.each(['http', 'file'] as const)('%s 出站在复盘期间只延期，结束后只执行一次并在线程报告已完成', async kind => {
    const { world, packets } = await worldFor(kind);
    const approval = world.store.table('approvals').list()[0]!;
    const outbox = world.store.table('outbox').list()[0]!;
    expect(world.store.table('wakes').list(row => row.endedAt === null)[0]?.variant).toBe('reflection');
    expect(await world.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await advance(world, 2 * minute);
    expect(world.store.table('outbox').get(outbox.id)).toMatchObject({ status: 'pending_approval', doneAt: null });
    expect(world.store.table('approvals').get(approval.id)).toMatchObject({ status: 'approved', usedAt: null });
    expect(world.net.calls).toHaveLength(0);
    expect(await world.fs.readText('/outside/result.md')).toBeNull();
    expect(world.store.log('thread').all().filter(row => row.refId === outbox.id && row.kind === 'system')).toEqual([]);
    await finishReflection(world);
    await advance(world, minute);
    expect(world.store.table('outbox').get(outbox.id)).toMatchObject({ status: 'done', executionStarted: true });
    expect(world.store.table('approvals').get(approval.id)?.status).toBe('used');
    if (kind === 'http') expect(world.net.calls).toHaveLength(1);
    else expect(await world.fs.readText('/outside/result.md')).toBe('早盘结果');
    const expected = kind === 'http' ? '已执行你批准的：向 hooks.example.com 发送数据 → 已完成（HTTP 200）'
      : '已执行你批准的：在工作区之外写文件：/outside/result.md → 已完成（文件已写入）';
    expect(world.store.log('thread').all().filter(row => row.refId === outbox.id && row.kind === 'system').map(row => row.text)).toEqual([expected]);
    expect(packets.filter(row => row.variant === 'reflection').every(row => !row.packet.includes('## 审批结果'))).toBe(true);
    expect(packets.some(row => row.variant === 'regular' && row.packet.includes('## 审批结果'))).toBe(true);
    await advance(world, minute);
    expect(world.net.calls).toHaveLength(kind === 'http' ? 1 : 0);
    expect(world.store.log('thread').all().filter(row => row.refId === outbox.id && row.kind === 'system')).toHaveLength(1);
    await world.hub.stop();
  });

  it('有排队复盘时批准直接 bash，只在常规回合重试并消费原票，复盘仍保留', async () => {
    const { world, packets, attempts } = await worldFor('direct', false);
    expect(world.store.table('queue').list().some(row => row.variant === 'reflection')).toBe(true);
    const approval = world.store.table('approvals').list()[0]!;
    expect(await world.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await world.host.settle();
    expect(attempts).toEqual([{ variant: 'regular', ok: false }, { variant: 'regular', ok: true }]);
    expect(world.store.table('approvals').get(approval.id)?.status).toBe('used');
    expect(world.store.table('queue').list().some(row => row.variant === 'reflection')).toBe(true);
    expect(packets.filter(row => row.packet.includes('用完全相同的参数再调用一次')).every(row => row.variant === 'regular')).toBe(true);
    expect(world.store.table('approvals').list()).toHaveLength(1);
    await world.hub.stop();
  });
});
