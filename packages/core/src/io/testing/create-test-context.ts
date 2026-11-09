/** 一次创建完整可重复的测试环境：默认时刻是北京时间 2026-11-05 10:00，所有 I/O 都留在内存。 */
import { createRuntime } from '../../engine/context.js';
import type { HubContext } from '../../engine/context.js';
import { resolveSettings } from '../../config/defaults.js';
import { MemoryStore } from '../../store/memory-store.js';
import { FakeClock } from './fake-clock.js';
import { SeededRng } from './seeded-rng.js';
import { MemoryFs } from './memory-fs.js';
import { FakeNet } from './fake-net.js';
import { FakeExec } from './fake-exec.js';
import { FakeHost } from './fake-host.js';
import { MemoryLogger } from './memory-logger.js';

/** 组合可覆盖的内存依赖与固定时刻，减少各模块测试的重复搭建。 */
export function createTestContext<T extends Partial<HubContext> = Record<never, never>>(overrides?: T) {
  const clock = new FakeClock(Date.parse('2026-11-05T10:00:00+08:00'));
  const logger = new MemoryLogger();
  const events: Array<{ scope: string; botId: string | null }> = [];
  const base = { store: new MemoryStore(), clock, rng: new SeededRng(1), fs: new MemoryFs(overrides?.clock ?? clock, overrides?.logger ?? logger),
    net: new FakeNet(), exec: new FakeExec(), host: new FakeHost(), logger, settings: resolveSettings({ rootDir: '/hub' }),
    runtime: createRuntime((overrides?.clock ?? clock).now()), events,
    /** 收集界面更新范围，供测试断言通知对象而不连接真实界面。 */
    emit(scope: string, botId?: string | null) { events.push({ scope, botId: botId ?? null }); } };
  return { ...base, ...overrides } as unknown as Omit<typeof base, keyof T> & T;
}
