/** 倒带服务：业务收口保存真实观察，界面只选择历史；断点不能被旧房间覆盖。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { OfficeFrame } from '../model/office-frame.js';
import { timestamp } from '../model/primitives.js';
import { parseInput } from '../engine/validation.js';
import { localDateKey, startOfLocalDay } from '../util/time.js';
import { officeView } from './service.js';
import type { OfficeView } from './project.js';

export interface OfficeReplayView {
  now: number;
  dayStart: number;
  timezone: string;
  selectedAt: number;
  recordedAt: number | null;
  frameId: string | null;
  room: OfficeView | null;
  missing: string | null;
  frames: Array<Pick<OfficeFrame, 'id' | 'at' | 'kind' | 'reason'>>;
}
const ReplayInput = z.strictObject({ at: timestamp.optional() });
// 即使存储故障导致断点写不进去，本进程也不把旧帧当成连续观察。
const failedAt = new WeakMap<HubContext, number>();
type FrameIndex = Pick<OfficeFrame, 'id' | 'at' | 'sequence' | 'dateKey' | 'kind' | 'reason'>[];
const indexes = new WeakMap<HubContext, { revision: number; rows: FrameIndex }>();

/** 失败边界由引擎调用；下一次成功收口先补断点，再记新的房间。 */
export function markOfficeRecordFailure(ctx: HubContext): void {
  if (!failedAt.has(ctx)) failedAt.set(ctx, ctx.clock.now());
}

/** 固定排序不依赖表插入次序，恢复文件后同毫秒的最后状态仍然一致。 */
function ordered(ctx: HubContext) {
  const table = ctx.store.table('officeFrames');
  const revision = table.revision();
  const cached = indexes.get(ctx);
  if (cached?.revision === revision) return cached.rows;
  const rows = table.listFields(['id', 'at', 'sequence', 'dateKey', 'kind', 'reason'])
    .sort((a, b) => a.at - b.at || a.sequence - b.sequence);
  indexes.set(ctx, { revision, rows });
  return rows;
}

/** 有限的断点和房间共用一个序列；连续同原因断点去重。 */
function append(ctx: HubContext, at: number, room: OfficeView | null, reason: string | null): void {
  const rows = ordered(ctx);
  const last = rows.at(-1);
  const dateKey = localDateKey(at, ctx.settings.timezone);
  if (room === null && last?.kind === 'gap' && last.reason === reason && last.dateKey === dateKey) return;
  ctx.store.table('officeFrames').put(envelope(ctx, at, room, reason));
}

/** 字节限制覆盖整条记录，包括身份与时间元数据，而不仅是房间正文。 */
function envelope(ctx: HubContext, at: number, room: OfficeView | null, reason: string | null): OfficeFrame {
  const sequence = Math.max(-1, ...ordered(ctx).filter(row => row.at === at).map(row => row.sequence)) + 1;
  return { id: `of_${at}_${sequence}`, at, sequence, dateKey: localDateKey(at, ctx.settings.timezone),
    kind: room ? 'frame' : 'gap', room, reason };
}

/** 只在入口收口时调用；忽略 asOf 比较房间，避免每个 tick 写一份相同历史。 */
export function recordOfficeFrame(ctx: HubContext, mode: 'observe' | 'start' | 'stop' = 'observe'): void {
  const now = ctx.clock.now();
  if (mode === 'start') indexes.delete(ctx);
  const table = ctx.store.table('officeFrames');
  const cutoff = now - ctx.settings.retentionMsByCollection.officeFrames;
  for (const row of ordered(ctx)) if (row.at < cutoff) table.remove(row.id);
  const failure = failedAt.get(ctx);
  if (failure !== undefined) append(ctx, failure, null, '房间记录失败，这段时间没有可靠观察');
  // 重启不能推断上次落盘后发生了什么；同毫秒重启时最新首帧即可覆盖断点。
  const previous = ordered(ctx).at(-1);
  if (mode === 'start' && previous?.kind === 'frame' && previous.at < now) {
    append(ctx, previous.at + 1, null, '中心未持续运行，这段时间没有观察记录');
  }
  if (mode === 'stop') {
    append(ctx, now, null, '中心已停止，这段时间没有观察记录');
    failedAt.delete(ctx);
    return;
  }
  const room = officeView(ctx);
  const today = localDateKey(now, ctx.settings.timezone);
  const rows = ordered(ctx);
  const latest = rows.at(-1);
  const last = latest ? table.get(latest.id) : null;
  const comparable = (view: OfficeView) => JSON.stringify({ ...view, asOf: 0 });
  if (Buffer.byteLength(JSON.stringify(envelope(ctx, now, room, null)), 'utf8') > ctx.settings.officeReplay.maxFrameBytes) {
    append(ctx, now, null, '房间超过单帧大小上限，没有保存截断房间');
    failedAt.delete(ctx);
    return;
  }
  if (mode !== 'start' && last?.room && last.dateKey === today && comparable(last.room) === comparable(room)) {
    failedAt.delete(ctx);
    return;
  }
  if (rows.filter(row => row.dateKey === today && row.kind === 'frame').length >= ctx.settings.officeReplay.maxFramesPerDay) {
    append(ctx, now, null, '当天房间记录已达上限，后续时段没有完整记录');
  } else append(ctx, now, room, null);
  failedAt.delete(ctx);
}

/** 选择当天已观察到的最后状态；旧档、首次观察之前与断点都明确返回空房间。 */
export function officeReplay(ctx: HubContext, raw: unknown): OfficeReplayView {
  const input = parseInput(ReplayInput, raw, '倒带');
  const now = ctx.clock.now();
  const dayStart = startOfLocalDay(now, ctx.settings.timezone);
  const selectedAt = input.at ?? now;
  if (selectedAt < dayStart || selectedAt > now) throw new Error('倒带时间必须在今天开始到当前时刻之间');
  const cutoff = Math.max(dayStart, now - ctx.settings.retentionMsByCollection.officeFrames);
  const rows = ordered(ctx).filter(row => row.at >= cutoff && row.at <= now);
  const chosen = rows.filter(row => row.at <= selectedAt).at(-1);
  const frame = chosen ? ctx.store.table('officeFrames').get(chosen.id) : null;
  const failure = failedAt.get(ctx);
  const interrupted = failure !== undefined && failure <= selectedAt && failure >= (frame?.at ?? -Infinity);
  return {
    now, dayStart, timezone: ctx.settings.timezone, selectedAt,
    recordedAt: interrupted ? failure : frame?.at ?? null,
    frameId: interrupted ? null : frame?.id ?? null,
    room: interrupted ? null : frame?.room ?? null,
    missing: interrupted ? '房间记录失败，这段时间没有可靠观察' : frame?.reason ??
      (frame === null ? '这个时刻没有房间记录；历史从中心实际观察开始' : null),
    frames: rows.map(({ id, at, kind, reason }) => ({ id, at, kind, reason })),
  };
}
