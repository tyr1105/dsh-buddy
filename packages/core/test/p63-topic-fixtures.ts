/**
 * P60/P63 主题聊天的测试环境：用真实 Hub 跑完整链路（发消息、投递、交账、下一棒），
 * 只替换宿主（假宿主记录投递内容），这样测到的是真实的调度和路由，而不是某个函数的局部行为。
 */
import { expect } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { createBotHome } from '../src/memory/files.js';
import type { Bot, QueueEntry, ThreadMessage } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { okData } from './c04-api-fixtures.js';

/** 第一位是总管（默认成为负责人），其余是执行风格的成员。 */
export async function topicHub(names: string[] = ['老大', '小王', '小李'], settings: Record<string, unknown> = {}) {
  const ctx = createTestContext();
  Object.assign(ctx.settings, settings);
  const now = ctx.clock.now();
  const bots: Bot[] = [];
  for (const [index, name] of names.entries()) {
    const id = `b_${String(index + 1).padStart(10, '0')}`;
    const bot: Bot = { ...botFixture, id, name, role: index === 0 ? 'chief' : 'executor', lifecycle: 'active', homeDir: `/hub/bots/${id}`,
      sessionId: `session-${index + 1}`, sessionStartedAt: now, createdAt: now, updatedAt: now,
      lastThinkAt: null, nextThinkAt: null, lightCheckAt: null, expectedBy: null };
    ctx.store.table('bots').put(bot);
    await createBotHome(ctx, bot);
    ctx.host.sessions.set(bot.sessionId!, { exists: true, running: false, contextRatio: 0 });
    bots.push(bot);
  }
  const hub = createHub({ ...ctx, settings: { ...ctx.settings, ...settings } });
  await hub.start();
  const project = okData(await hub.api.saveProject({ name: '季度战役', memberBotIds: bots.map(bot => bot.id) }));
  return { ctx, hub, bots, project };
}

export type TopicHub = Awaited<ReturnType<typeof topicHub>>;

/** 开一个主题并返回主题 id；失败直接让用例挂掉。 */
export async function openTopic(fix: TopicHub, text: string): Promise<string> {
  return okData(await fix.hub.api.createProjectTopic({ projectId: fix.project.id, text })).topicId;
}

/** 这个主题里的全部消息，按时间从旧到新。 */
export function floors(ctx: HubContext, topicId: string): ThreadMessage[] {
  return ctx.store.log('thread').all().filter(row => row.thread === topicId);
}

/** 模拟队友交账并结束这一回合；reply 为 null 表示这一回合没说话。 */
export async function speak(fix: TopicHub, bot: Bot, reply: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  const commit = fix.hub.tools().find(tool => tool.name === 'hub_commit')!;
  const result = await commit.handler(bot.sessionId!, commitArgs({ reply, ...patch }));
  expect(result).toMatchObject({ ok: true });
  await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot.sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 500 });
}

/** 这个队友现在在跑的唤醒单；没有在跑时返回 undefined。 */
export function runningWake(ctx: HubContext, botId: string) {
  return ctx.store.table('wakes').list(wake => wake.botId === botId && wake.status === 'running')[0];
}

/** 这个队友最近一次收到的唤醒包正文。 */
export function lastPacket(fix: TopicHub, bot: Bot): string {
  const calls = fix.ctx.host.calls.filter(call => call.method === 'deliver' && call.args[0] === bot.sessionId);
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)!.args[1] as string;
}

/** 队列里某个队友在某个主题的候选。 */
export function queued(ctx: HubContext, botId: string, topicId: string): QueueEntry | undefined {
  return ctx.store.table('queue').list(row => row.botId === botId && row.topicId === topicId)[0];
}
