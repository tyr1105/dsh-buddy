/** 主人打断入口先写 core 取消事实，再通知宿主，避免同步结束回调被算作机器人失误。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { nonempty } from '../model/primitives.js';
import { input, requireBot } from './common.js';
import { interruptWake } from '../turn/interrupt.js';

/** 尚无 sessionId 的投递也能打断；迟到创建的会话由 dispatcher 负责取消。 */
export async function interruptBot(ctx: HubContext, raw: unknown) {
  const { botId } = input(z.strictObject({ botId: nonempty }), raw, '打断机器人');
  requireBot(ctx, botId);
  const wake = ctx.store.table('wakes').list(w => w.botId === botId && w.endedAt === null
    && ['running', 'delivering'].includes(w.status)).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!wake) throw new Error('它现在没在处理事情');
  const canceled = interruptWake(ctx, wake.id, ctx.clock.now())!;
  if (wake.sessionId) {
    try { await ctx.host.cancel(wake.sessionId); }
    catch (error) { throw new Error(`已记录主人打断，但宿主取消失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  return canceled;
}
