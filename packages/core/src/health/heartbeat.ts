/** 心跳只保存健康摘要，经注入文件接口原子写入；进程号由宿主设置传入，core 不读取系统进程。 */
import { join } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { count, timestamp } from '../model/primitives.js';

export const HeartbeatSchema = z.strictObject({ pid: count.nullable(), at: timestamp, bots: count, thinking: count,
  version: z.literal('0.1.0', { error: '心跳版本必须为 0.1.0' }) });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** 成功写入之后才更新时间；文件系统失败不消耗本次心跳机会。 */
export async function maybeWriteHeartbeat(ctx: HubContext, now: number): Promise<Heartbeat | null> {
  if (ctx.runtime.lastHeartbeatAt !== null && now - ctx.runtime.lastHeartbeatAt < ctx.settings.heartbeatMs) return null;
  const heartbeat: Heartbeat = { pid: ctx.settings.heartbeatPid, at: now,
    bots: ctx.store.table('bots').count(), thinking: ctx.store.table('wakes').count(wake => wake.status === 'running'), version: '0.1.0' };
  await ctx.fs.writeTextAtomic(join(ctx.settings.rootDir, '.hub', 'heartbeat.json'), JSON.stringify(HeartbeatSchema.parse(heartbeat)));
  ctx.runtime.lastHeartbeatAt = now;
  return heartbeat;
}

/** 历史心跳损坏时不捏造停机时长；保留原文件并记录可诊断的警告。 */
export async function readLastHeartbeat(ctx: HubContext): Promise<Heartbeat | null> {
  try {
    const text = await ctx.fs.readText(join(ctx.settings.rootDir, '.hub', 'heartbeat.json'));
    if (text === null) return null;
    return HeartbeatSchema.parse(JSON.parse(text));
  } catch (error) {
    ctx.logger.warn('无法读取上次心跳，跳过基于该文件的停机推断', error);
    return null;
  }
}
