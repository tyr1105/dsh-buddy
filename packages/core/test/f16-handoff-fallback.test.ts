/**
 * 交接省略 to 时的保守回退（编制取消后版本）。
 * 汇报链已随编制删除：显式 to > 在岗总管（创建最早）> 中文报错；
 * 同时确认唤醒包不再出现「你的岗位」段。
 */
import { describe, expect, it } from 'vitest';
import { buildWakePacket } from '../src/wake/packet.js';
import { createHandoff } from '../src/peer/handoffs.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { turnContext } from './c03-turn-fixtures.js';
import { botFixture } from './model-fixtures.js';
import type { Bot } from '../src/model/index.js';

/** 交接测试最小环境：若干在岗队友，不建真实文件也能交接（无附件）。 */
function handoffFixture(bots: Array<Partial<Bot> & { id: string }>) {
  const ctx = createTestContext();
  for (const override of bots) {
    const bot: Bot = { ...botFixture, name: `队友${override.id}`, homeDir: `/hub/bots/${override.id}`, ...override };
    ctx.store.table('bots').put(bot);
  }
  return { ctx };
}
const SENDER = { id: 'b_0000000001', name: '发起员' };
const PEER = { id: 'b_0000000002', name: '执行员' };
const CHIEF = { id: 'b_0000000003', name: '总管', role: 'chief' as const };

describe('交接省略 to 的回退', () => {
  it('没有在岗总管时报中文错，不留交接与议程', async () => {
    const { ctx } = handoffFixture([SENDER, PEER]);
    await expect(createHandoff(ctx, SENDER.id, { task: '无人可交', why: '测试' })).rejects.toThrow('to：');
    expect(ctx.store.table('handoffs').count()).toBe(0);
    expect(ctx.store.table('agenda').count()).toBe(0);
  });

  it('回退给在岗总管（创建最早的一个）', async () => {
    const { ctx } = handoffFixture([SENDER, PEER, CHIEF]);
    const handoff = await createHandoff(ctx, SENDER.id, { task: '找总管', why: '没有上级' });
    expect(handoff.to).toBe(CHIEF.id);
    expect(ctx.store.table('agenda').list(a => a.botId === CHIEF.id)).toHaveLength(1);
  });

  it('显式 to 仍按原规则送达', async () => {
    const { ctx } = handoffFixture([SENDER, PEER, CHIEF]);
    const handoff = await createHandoff(ctx, SENDER.id, { to: PEER.id, task: '点名交接', why: '就要给你' });
    expect(handoff.to).toBe(PEER.id);
  });
});

describe('唤醒包不再有岗位段', () => {
  it('常规与轻复查包都不出现「你的岗位」', async () => {
    for (const variant of ['regular', 'light_check'] as const) {
      const setup = await turnContext(variant);
      const packet = await buildWakePacket(setup.ctx, setup.bot, setup.entry, setup.ticket);
      expect(packet).not.toContain('你的岗位');
    }
  });
});
