/**
 * 通知唯一入口（P76h，第五块）：整个中心只有这里决定「给主人推不推一条系统通知」。
 *
 * 为什么只留一个入口：以前员工提问、汇报、审批、告警各自调用 requestPush，推什么、什么时候推、推几条
 * 各管各的，主人被打扰的次数没法控制。现在只有四类事推送（要你确认的约定改动、审批、三轮核对不过或做不下去、
 * 长时间没有进展），另有鉴权失败这一类系统通知；其余事项只进「待你处理」，不推送。
 *
 * 流程：条目建好后 notifyOwner 先把通知写进队列（表 pushQueue），再由 flushPushQueue 统一处理——
 * 免打扰时段内的通知顺延到时段结束再发；10 分钟内的多条合成一条；同一事项 24 小时内只推一次；
 * 推送通道关闭则全部丢弃。引擎每个 tick 也会调用一次 flushPushQueue，让顺延的通知到点补发、发送失败的重试。
 *
 * requestPush（outreach/push.ts）仍负责最后一道去重、免打扰判断和写审计，且只允许在本文件里被调用。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { NOTIFY_DEFAULTS } from '../config/defaults.js';
import { PUSH_CATEGORIES, type PushQueueRow } from '../model/notify.js';
import type { InboxItem } from '../model/outreach.js';
import { nonempty, text } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { isInQuietHours, nextLocalTime } from '../util/time.js';
import { requestPush } from './push.js';

/** 通知的类别（与 model/notify.ts 的 PUSH_CATEGORIES 一致）。 */
export type NotifyCategory = (typeof PUSH_CATEGORIES)[number];

/**
 * 按条目判断它属于哪一类通知；不属于四类（也不是鉴权告警）的返回 null，表示不推送。
 * 纯函数：只看条目的类型、事项键，以及告警条目对应的告警代码（由调用方传入）。
 */
export function notifyCategoryOf(item: Pick<InboxItem, 'type' | 'subjectKey' | 'refId'>, alertCode?: string | null): NotifyCategory | null {
  const key = item.subjectKey;
  // 约定确认条目：事项键 agreement:<约定编号>:<版本号>。
  if (key.startsWith('agreement:')) return 'agreement';
  // 一件事用到回合上限：job:<事项编号>:cap:<上限>，与约定一样需要主人确认是否加回合。
  if (/^job:[^:]+:cap:/.test(key)) return 'agreement';
  // 审批（花钱、对外发布、不可撤销的动作）：按条目类型判断，不看事项键。
  if (item.type === 'approval') return 'approval';
  if (/^job:[^:]+:escalate:/.test(key)) return 'escalation';
  if (/^job:[^:]+:stall:/.test(key)) return 'stall';
  // 告警只有鉴权失败推送；其他告警（额度、掉线、隔离等）只进「待你处理」。
  if (item.type === 'alert' && alertCode === 'auth') return 'system';
  return null;
}

const NotifySchema = z.strictObject({
  category: z.enum(PUSH_CATEGORIES, { error: '通知类别必须是 agreement、approval、escalation、stall、system 之一' }),
  title: nonempty, body: text, subjectKey: nonempty, botId: nonempty.nullable(),
  inboxId: nonempty.optional(), // 由条目触发时传条目编号，发出前核对条目是否还开着
});
export type NotifyInput = z.infer<typeof NotifySchema>;

/** 串行锁：同一时刻只有一次整理在跑，避免两次整理同时发出同一批通知（写法同 requestPush）。 */
const locks = new WeakMap<HubContext, Promise<unknown>>();

/**
 * 唯一入口：把一条通知写进队列，然后立刻整理一次队列。
 * 写队列这一步在第一个 await 之前同步完成，所以调用方不等待也不会丢；任何出错只记日志，
 * 绝不向外抛——推送失败不能让已经建成的条目回滚。
 */
export async function notifyOwner(ctx: HubContext, input: NotifyInput): Promise<void> {
  try {
    const value = parseInput(NotifySchema, input, '通知');
    const now = ctx.clock.now();
    ctx.store.table('pushQueue').put({ id: newId('pq', ctx.rng), ...value, createdAt: now, sendAfter: now,
      state: 'waiting', sentAt: null, mergedInto: null });
    await flushPushQueue(ctx, now);
  }
  catch (error) {
    ctx.logger.warn('通知没有发出', String(error));
  }
}

/** 一行是否真的发出过：已发出，或被合并进另一条已发出的行；返回实际发出时间，没有返回 null。 */
function deliveredAt(ctx: HubContext, row: PushQueueRow): number | null {
  if (row.state === 'sent') return row.sentAt;
  if (row.state === 'merged' && row.mergedInto !== null) return ctx.store.table('pushQueue').get(row.mergedInto)?.sentAt ?? null;
  return null;
}

/** 发出之后，把对应「待你处理」条目的 pushed 标记补上（沿用旧字段，只用于界面显示）。 */
function markPushed(ctx: HubContext, subjectKey: string): void {
  for (const item of ctx.store.table('inbox').list(row => row.subjectKey === subjectKey && !row.pushed))
    ctx.store.table('inbox').patch(item.id, { pushed: true });
}

/** 正在整理的次数；引擎的 tick 用它判断「上一次还没结束」（例如宿主通知一直不返回）。 */
const running = new WeakMap<HubContext, number>();

/**
 * 整理队列：清理、渠道关闭丢弃、免打扰顺延、去重、合并、发出。
 * skipIfBusy 为真时，上一次整理还没结束就直接返回、不排在它后面：引擎每个 tick 都调用，
 * 宿主通知一直不返回时 tick 不能跟着卡住（旧的整理结束后下一个 tick 自然继续）。
 */
export function flushPushQueue(ctx: HubContext, now: number, options: { skipIfBusy?: boolean } = {}): Promise<void> {
  if (options.skipIfBusy && (running.get(ctx) ?? 0) > 0) return Promise.resolve();
  const previous = locks.get(ctx) ?? Promise.resolve();
  running.set(ctx, (running.get(ctx) ?? 0) + 1);
  const operation = previous.catch(() => undefined).then(() => flushOnce(ctx, now))
    .finally(() => { running.set(ctx, (running.get(ctx) ?? 1) - 1); });
  locks.set(ctx, operation);
  return operation;
}

async function flushOnce(ctx: HubContext, now: number): Promise<void> {
  const table = ctx.store.table('pushQueue');
  // 1. 清理：已结束的行保留 QUEUE_RETENTION_MS，之后删除；等待中的行永远不清理。
  for (const row of table.list(r => r.state !== 'waiting' && now - r.createdAt > NOTIFY_DEFAULTS.QUEUE_RETENTION_MS)) table.remove(row.id);
  // 2. 推送通道关闭：等待中的全部丢弃，不调用宿主。
  if (ctx.settings.pushChannel === 'none') {
    for (const row of table.list(r => r.state === 'waiting')) table.patch(row.id, { state: 'dropped' });
    return;
  }
  // 2b. 发出之前核对条目：由条目触发的行，条目已不存在（被撤销）或已不是「开着」（已处理、过期、作废、被取代）就不发。
  // 没有 inboxId 的行（直接调用 notifyOwner）没有对应条目，照发。
  for (const row of table.list(r => r.state === 'waiting' && r.inboxId !== undefined)) {
    const item = ctx.store.table('inbox').get(row.inboxId!);
    if (item === null || item.status !== 'open') table.patch(row.id, { state: 'dropped' });
  }
  // 3. 免打扰时段内：非系统类通知顺延到时段结束的那一刻。系统类（鉴权失败）与 requestPush 对 P0 的做法一致，不受免打扰限制。
  if (isInQuietHours(now, ctx.settings.quietHours, ctx.settings.timezone)) {
    const endAt = nextLocalTime(ctx.settings.quietHours.end, now, ctx.settings.timezone);
    for (const row of table.list(r => r.state === 'waiting' && r.category !== 'system' && r.sendAfter !== endAt)) table.patch(row.id, { sendAfter: endAt });
  }
  // 4. 同一事项 24 小时内已经发出过：这一行丢弃。
  const history = table.list(r => r.state === 'sent' || r.state === 'merged');
  const ready: PushQueueRow[] = [];
  for (const row of table.list(r => r.state === 'waiting' && r.sendAfter <= now)) {
    const duplicate = history.some(past => {
      const at = deliveredAt(ctx, past);
      return past.subjectKey === row.subjectKey && at !== null && at <= now && now - at < ctx.settings.dedupWindowMs;
    }) || ready.some(other => other.subjectKey === row.subjectKey);
    if (duplicate) table.patch(row.id, { state: 'dropped' });
    else ready.push(row);
  }
  ready.sort((a, b) => a.createdAt - b.createdAt);
  // 系统类（鉴权失败，P0）先单独发出，不受 10 分钟合并窗口限制：鉴权失败时员工整体干不了活，不能等；
  // 其余类别合成一批，受合并窗口限制。
  await sendGroup(ctx, ready.filter(row => row.category === 'system'), now, false);
  await sendGroup(ctx, ready.filter(row => row.category !== 'system'), now, true);
}

/** 把一批等待中的行发出：一行照原样发，多行合成「有 n 件事等你处理」。发送失败时这些行保持等待，下一个 tick 重试。 */
async function sendGroup(ctx: HubContext, rows: PushQueueRow[], now: number, respectWindow: boolean): Promise<void> {
  if (rows.length === 0) return;
  const table = ctx.store.table('pushQueue');
  // 5. 距上一次真正发出不足 10 分钟：先不发，等下一次整理（下一个 tick）。
  if (respectWindow) {
    const lastSentAt = Math.max(0, ...table.list(r => r.state === 'sent').map(r => r.sentAt ?? 0));
    if (lastSentAt > 0 && now - lastSentAt < NOTIFY_DEFAULTS.MERGE_WINDOW_MS) return;
  }
  const first = rows[0]!;
  const max = NOTIFY_DEFAULTS.MERGED_LINES_MAX;
  // 合并通知的正文：每行一个原标题，最多 MERGED_LINES_MAX 行，多出的在末行写「另有 k 件」。
  const lines = rows.slice(0, max).map(row => row.title);
  if (rows.length > max) lines.push(`另有 ${rows.length - max} 件`);
  const level = rows.some(row => row.category === 'system') ? 'P0' as const : 'P1' as const;
  const input = rows.length === 1
    ? { botId: first.botId, level, title: first.title, body: first.body, subjectKey: first.subjectKey }
    : { botId: rows.every(row => row.botId === first.botId) ? first.botId : null, level,
        title: `有 ${rows.length} 件事等你处理`, body: lines.join('\n'), subjectKey: `merged:${first.id}` };
  // 6. 真正发出。
  let result: Awaited<ReturnType<typeof requestPush>>;
  try {
    result = await requestPush(ctx, input);
  }
  catch (error) {
    ctx.logger.warn('通知发送失败，下一个 tick 重试', String(error));
    return;
  }
  if (result === 'deferred_quiet') return; // 仍在免打扰时段内：保持等待，时段结束后由下一次整理处理。
  if (result !== 'sent') {
    for (const row of rows) table.patch(row.id, { state: 'dropped' });
    return;
  }
  table.patch(first.id, { state: 'sent', sentAt: now });
  markPushed(ctx, first.subjectKey);
  for (const row of rows.slice(1)) {
    table.patch(row.id, { state: 'merged', mergedInto: first.id });
    markPushed(ctx, row.subjectKey);
  }
}
