/** 仿真世界把内存依赖和真实 Hub 装在一起，用假时钟逐次 tick，保证七天实验无需真实等待。 */
import { z } from 'zod';
import { createHub } from '../engine/hub.js';
import { createRuntime, type HubContext } from '../engine/context.js';
import { createBotHome } from '../memory/files.js';
import { BotSchema, type Bot, type Settings } from '../model/index.js';
import { resolveSettings, SIM_DEFAULTS } from '../config/defaults.js';
import { MemoryStore } from '../store/memory-store.js';
import { FakeClock } from '../io/testing/fake-clock.js';
import { SeededRng } from '../io/testing/seeded-rng.js';
import { MemoryFs } from '../io/testing/memory-fs.js';
import { FakeNet } from '../io/testing/fake-net.js';
import { FakeExec } from '../io/testing/fake-exec.js';
import { MemoryLogger } from '../io/testing/memory-logger.js';
import { SimHost } from './sim-host.js';
import { quietBrain } from './brains.js';
import type { Brain } from './types.js';
export { metrics } from './metrics.js';

export type SimBotInput = Partial<Bot> & { id: string; brain?: Brain };
export interface SimWorldInput { bots: SimBotInput[]; startAt?: number; settings?: Partial<Settings>; seed?: number }

/** 补齐档案的机械字段；仿真默认在岗 L2，预算仍完全遵循中心设置。 */
function makeBot(input: SimBotInput, now: number, settings: Settings): Bot {
  const { brain: _brain, ...overrides } = input;
  return BotSchema.parse({ name: input.id, role: 'sentinel', persona: '按证据行动，简明交账', color: '#507080',
    lifecycle: 'active', activity: 'watching', activityText: '正在关注变化', autonomy: 'L2', pace: 'normal', model: settings.defaultModel,
    homeDir: `${settings.rootDir}/bots/${input.id}`, sessionId: null, sessionStartedAt: null, createdAt: now, probationEndsAt: null,
    noChangeStreak: 0, lastThinkAt: null, nextThinkAt: null, nextThinkReason: null, nextThinkBy: null, nextThinkMode: null,
    lightCheckAt: null, expectedBy: null, consecutiveErrors: 0, consecutiveNoCommit: 0, violations: 0, retryAt: null,
    quarantineReason: null, workDataAllowed: false, updatedAt: now, ...overrides });
}

/** 组装可重复世界并完成 start；bots 是场景初始数据，UI 创建流程由独立冷启动场景验证。 */
export async function createSimWorld(input: SimWorldInput) {
  const startAt = z.number().int('仿真开始时间必须是整数毫秒').parse(input.startAt ?? SIM_DEFAULTS.startAt);
  const seed = z.number().int('仿真种子必须是整数').parse(input.seed ?? SIM_DEFAULTS.seed);
  const settings = resolveSettings({ rootDir: '/sim-hub', ...input.settings });
  const clock = new FakeClock(startAt);
  const rng = new SeededRng(seed);
  const logger = new MemoryLogger();
  const fs = new MemoryFs(clock, logger);
  const net = new FakeNet();
  const exec = new FakeExec();
  const store = new MemoryStore(settings);
  const host = new SimHost(clock);
  host.setDefaultBrain(quietBrain);
  const setupContext: HubContext = { host, clock, rng, fs, net, exec, logger, store, settings,
    runtime: createRuntime(startAt), emit: () => undefined };
  for (const inputBot of input.bots) {
    const bot = makeBot(inputBot, startAt, settings);
    if (store.table('bots').get(bot.id)) throw new Error(`仿真机器人 id 重复：${bot.id}`);
    store.table('bots').put(bot);
    host.registerBrain(bot.id, inputBot.brain ?? quietBrain);
    await createBotHome(setupContext, bot);
  }
  const hub = createHub({ host, clock, rng, fs, net, exec, logger, store, settings });
  host.attach(hub);
  const world = { hub, store, clock, fs, net, exec, host, logger, rng, settings, startAt };
  await hub.start();
  await host.settle();
  return world;
}
export type SimWorld = Awaited<ReturnType<typeof createSimWorld>>;
export interface AdvanceOptions {
  tickEveryMs?: number;
  /** 在每个 tick 前注入这一时刻的世界变化，可使用同一个 SeededRng 重放。 */
  beforeTick?(world: SimWorld, index: number): void | Promise<void>;
}

/** 精确推进到终点；末尾不足一个 tick 的余量也执行一次，避免悄悄少仿真一段时间。 */
export async function advance(world: SimWorld, ms: number, options: AdvanceOptions = {}): Promise<void> {
  z.number().nonnegative('推进时间不能为负').parse(ms);
  const tickEveryMs = z.number().positive('tick 间隔必须大于零').parse(options.tickEveryMs ?? world.settings.tickMs);
  const end = world.clock.now() + ms;
  if (!Number.isFinite(end)) throw new Error('仿真结束时间必须是有限毫秒数');
  let index = 0;
  await world.host.settle();
  while (world.clock.now() < end) {
    world.clock.advance(Math.min(tickEveryMs, end - world.clock.now()));
    await options.beforeTick?.(world, index++);
    await world.hub.tick();
    await world.host.settle();
  }
}
