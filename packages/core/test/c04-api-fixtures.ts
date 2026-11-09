/** 界面测试搭建完整内存中心；afterCommand 记录调用并真实 flush，验证命令出口没有遗漏。 */
import { vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import type { CommandResult } from '../src/api/types.js';

/** 每个用例独立创建上下文，机器人默认试岗，避免共享状态影响人数与计数。 */
export async function apiFixture() {
  const ctx = createTestContext();
  await initRoot(ctx);
  const after = vi.fn(async () => { await ctx.store.flush(); });
  const api = createUiApi(ctx, after);
  const bot = okData(await api.createBot({ name: '小研', role: 'researcher', persona: '先核实再行动', aspirations: ['持续核实公开信息'] }));
  return { ctx, api, after, bot, aspiration: ctx.store.table('aspirations').list()[0]! };
}
/** 断言成功时同时要求返回数据，避免测试用非空断言掩盖命令失败。 */
export function okData<T>(result: CommandResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  if (result.data === undefined) throw new Error('命令没有返回数据');
  return result.data;
}
