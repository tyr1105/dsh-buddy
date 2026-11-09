/** 感知测试共用独立的机器人与关注项基线；每次调用创建新上下文，防止测试相互污染。 */
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import type { Watch } from '../src/model/perception.js';

export function perceptionContext(watch?: Partial<Watch>) {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  ctx.store.table('bots').put({ ...botFixture, createdAt: now, updatedAt: now });
  if (watch) ctx.store.table('watches').put({ ...watchFixture, createdAt: now, updatedAt: now, ...watch });
  return ctx;
}
export function response(text: string, status = 200) { return { text, status, contentType: 'text/plain' }; }
export const minute = 60_000;
export const hour = 60 * minute;
