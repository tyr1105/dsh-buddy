/**
 * P75r5a 第 1 节的测试：复盘类回合（复盘、核对、改写）里员工不能用 hub_outbox_submit 的 notify_owner 向主人汇报。
 * 为什么：notify_owner 会在员工私聊落一条消息，还可能推送；方案要求复盘全程不打扰主人，要说明的话写进 note。
 * 用真实链路让员工真的进入对应的回合（夹具里总管、执行者、评审员都是听吩咐的）。
 * 每条断言：被拒、文字逐字、私聊消息数、推送次数、「待你处理」条数、违规次数都不变。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { submitOutbox } from '../src/gate/outbox.js';
import { WakeTicketSchema } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import {
  afterExecutorProposes, bot, callTool, nextPacket, ownerNoise, retroTurn, reviewerRejects, flow,
  type JobFix,
} from './p75h-fixtures.js';

const REFUSAL = '复盘回合不向主人汇报；要说明的写进 note。';
const ARGS = { kind: 'notify_owner', why: '告诉主人复盘结果', payload: { text: '我复盘完了，学到两条做法。', importance: 10 } };

/** 在当前回合里调用 notify_owner，断言被拒且主人一侧的各项数量都没有变化。 */
async function expectRefused(fix: JobFix, botId: string): Promise<void> {
  const before = ownerNoise(fix);
  const violations = bot(fix, botId).violations;
  const outboxBefore = fix.ctx.store.table('outbox').count();
  const result = await callTool(fix, bot(fix, botId), 'hub_outbox_submit', ARGS);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain(REFUSAL);
  expect(ownerNoise(fix)).toEqual(before);
  expect(bot(fix, botId).violations).toBe(violations);
  expect(fix.ctx.store.table('outbox').count()).toBe(outboxBefore);
}

describe('P75r5a 第 1 节：复盘类回合不向主人汇报', () => {
  it('复盘回合：执行者调用 notify_owner 被拒，文字逐字，私聊、推送、待你处理都不变', async () => {
    const { fix } = await flow({ rejectFirst: true });
    await retroTurn(fix, fix.engineer.id);
    await expectRefused(fix, fix.engineer.id);
  });

  it('核对回合：评审员调用 notify_owner 被拒', async () => {
    const { fix } = await afterExecutorProposes();
    await nextPacket(fix, fix.reviewer.id);
    await expectRefused(fix, fix.reviewer.id);
  });

  it('改写回合：执行者调用 notify_owner 被拒', async () => {
    const { fix } = await afterExecutorProposes();
    await reviewerRejects(fix);
    await nextPacket(fix, fix.engineer.id);
    await expectRefused(fix, fix.engineer.id);
  });

  it('反例：同一位员工的同一个动作，唤醒是常规回合时 notify_owner 照常成功（落一条私聊）；改成复盘回合就被拒', async () => {
    const runtime = createTestContext();
    const row = { ...botFixture, sessionId: 'session-r5a', autonomy: 'L2' as const, lifecycle: 'active' as const };
    runtime.store.table('bots').put(row);
    const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: row.id, sessionId: row.sessionId, variant: 'regular' as const };
    runtime.store.table('wakes').put(wake);
    const input = { kind: 'notify_owner', why: '常规汇报', payload: { text: '今天的事做完了。' } };
    const done = await submitOutbox(runtime, row.id, input);
    expect(done.status).toBe('done');
    expect(runtime.store.log('thread').all().filter(message => message.thread === row.id && message.kind === 'report')).toHaveLength(1);
    // 同一个唤醒改成复盘回合：被拒，文字逐字。
    runtime.store.table('wakes').put({ ...wake, variant: 'reflection' });
    await expect(submitOutbox(runtime, row.id, { ...input, why: '复盘时汇报' })).rejects.toThrow(REFUSAL);
    expect(runtime.store.log('thread').all().filter(message => message.thread === row.id && message.kind === 'report')).toHaveLength(1);
  });
});
