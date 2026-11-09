/** 关注项的轻量持久化状态装进 lastValue；成功基线与失败次数一起保留，避免一次网络错误丢失对比依据。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { Watch } from '../model/perception.js';
import { byteLength, truncateBytes } from '../util/text.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

export interface WatchState {
  text?: string; seenIds?: string[]; code?: number | null; size?: number; sizes?: Record<string, number>;
  lineHashes?: string[]; totalLines?: number; fileBaseline?: boolean;
  lastError?: string | null; consecutiveFailures?: number;
}
const WatchStateSchema = z.object({
  text: z.string().optional(), seenIds: z.array(z.string()).optional(), code: z.number().int().nullable().optional(),
  size: z.number().nonnegative().optional(), sizes: z.record(z.string(), z.number().nonnegative()).optional(),
  lineHashes: z.array(z.string()).optional(), totalLines: z.number().int().nonnegative().optional(), fileBaseline: z.boolean().optional(),
  lastError: z.string().nullable().optional(), consecutiveFailures: z.number().int().nonnegative().optional(),
});
/** 解析有限容量的关注基线，坏状态回退为空以免整个轮询失败。 */
export function readWatchState(watch: Watch): WatchState {
  if (!watch.lastValue) return {};
  try {
    const parsed = WatchStateSchema.safeParse(JSON.parse(watch.lastValue));
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

/** 保留合法 JSON；先缩短正文，再删除最旧的历史 id 或文件大小记录。 */
export function encodeWatchState(ctx: HubContext, state: WatchState): string {
  const copy = structuredClone(state);
  const limit = ctx.settings.c02.watchValueMaxBytes;
  if (copy.lastError) copy.lastError = truncateBytes(copy.lastError, Math.floor(limit / 4));
  if (copy.text) copy.text = truncateBytes(copy.text, limit);
  let serialized = JSON.stringify(copy);
  while (byteLength(serialized) > limit) {
    if (copy.text) copy.text = copy.text.slice(0, Math.max(0, copy.text.length - Math.max(1, Math.ceil((byteLength(serialized) - limit) / 2))));
    else if (copy.lastError) copy.lastError = copy.lastError.slice(0, -1);
    else if (copy.lineHashes?.length) copy.lineHashes.pop();
    else if (copy.seenIds?.length) copy.seenIds.shift();
    else if (copy.sizes && Object.keys(copy.sizes).length) delete copy.sizes[Object.keys(copy.sizes)[0]!];
    else throw new Error('关注项 lastValue 的元数据超过容量');
    serialized = JSON.stringify(copy);
  }
  return serialized;
}

/** 执行成功清除连续失败计数；保留上一次指纹供下一轮比较。 */
export function saveWatchState(ctx: HubContext, watch: Watch, state: WatchState, now: number, lastFingerprint = watch.lastFingerprint): void {
  ctx.store.table('watches').patch(watch.id, { lastCheckedAt: now, lastFingerprint,
    lastValue: encodeWatchState(ctx, { ...state, lastError: null, consecutiveFailures: 0 }), updatedAt: now });
  // 即使内容未变化，详情中的最近检查时间也已变化。
  ctx.emit(HUB_EVENT_SCOPES.bot, watch.botId);
}
