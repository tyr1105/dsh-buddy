/** 告警先保存观测，再按连续次数开放；恢复后清零，避免偶发错误和已确认历史反复打扰主人。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { AlertSchema, type Alert } from '../model/operations.js';
import { timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';

const InputSchema = AlertSchema.pick({ code: true, botId: true, text: true, level: true }).extend({
  immediate: z.boolean({ error: 'immediate 必须是布尔值' }).optional(),
  at: timestamp.optional(),
});
export type AlertInput = z.infer<typeof InputSchema>;

/** 重启旧档后即使没有新观测，也先收拢重复开放故障；返回旧身份供收件箱复用已通知的卡片。 */
export function reconcileOpenAlerts(ctx: HubContext): Array<{ id: string; mergedIds: string[] }> {
  const groups = new Map<string, Alert[]>();
  for (const alert of ctx.store.table('alerts').list(item => item.status === 'open')) {
    const key = JSON.stringify([alert.code, alert.botId]);
    const group = groups.get(key) ?? [];
    group.push(alert);
    groups.set(key, group);
  }
  const merged: Array<{ id: string; mergedIds: string[] }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const latest = group.sort((a, b) => b.lastAt - a.lastAt)[0]!;
    // 只合并当前开放观测，已关闭历史不重复加入次数；最早与最近时刻完整保留。
    ctx.store.table('alerts').patch(latest.id, {
      count: group.reduce((sum, item) => sum + item.count, 0),
      firstAt: Math.min(...group.map(item => item.firstAt)), lastAt: Math.max(...group.map(item => item.lastAt)),
    });
    // 次数已经转入保留记录；清零被接替记录，避免它随后冒充未达门槛的新观测。
    for (const alert of group) if (alert.id !== latest.id) ctx.store.table('alerts').patch(alert.id, { status: 'closed', count: 0 });
    merged.push({ id: latest.id, mergedIds: group.map(item => item.id) });
    ctx.emit(HUB_EVENT_SCOPES.overview, latest.botId);
    ctx.emit(HUB_EVENT_SCOPES.activity, latest.botId);
  }
  return merged;
}

/** 同一轮故障在一小时内复用记录；恢复或主人确认后必须新建身份，避免旧卡挡住新告警。 */
export function raiseAlert(ctx: HubContext, input: AlertInput): Alert {
  const value = parseInput(InputSchema, input, '告警');
  const now = value.at ?? ctx.clock.now();
  // 宿主事件可能比当前时钟早到或晚到，不能用时间先后来排除已经保存的同类告警。
  const history = ctx.store.table('alerts').list(alert => alert.code === value.code && alert.botId === value.botId);
  const matching = [...history]
    // 窗口外的倒序观测会继承相同 lastAt；并列时继续当前开放故障，不能回到已关闭历史。
    .sort((a, b) => b.lastAt - a.lastAt || Number(b.status === 'open') - Number(a.status === 'open'));
  // closed + count=0 是已经恢复或确认的历史；只有仍开放或尚未达门槛的观测属于本轮。
  // 尚未开放时只允许最新建立的记录续计；更早被接替的 count=1 历史不能越过后来的确认记录复活。
  const latestObservation = history.at(-1);
  const previous = matching.find(alert => alert.status === 'open')
    ?? (latestObservation && latestObservation.count > 0 && latestObservation.count < ctx.settings.alertConsecutiveCount
      ? latestObservation : undefined);
  const merge = previous && Math.abs(now - previous.lastAt) < ctx.settings.alertMergeWindowMs;
  // 合并窗口只决定是否复用记录；没有恢复证据时，低频失败也继续累计。
  const count = (previous?.count ?? 0) + 1;
  const id = merge ? previous.id : newId('al', ctx.rng);
  // 窗口外仍保留历史记录，但同一故障只能有一条开放记录；同时收拢旧版本留下的重复项。
  for (const existing of matching) {
    if (existing.id !== id && existing.status === 'open') ctx.store.table('alerts').patch(existing.id, { status: 'closed' });
  }
  const alert: Alert = {
    id, episodeId: previous?.episodeId ?? previous?.id ?? id, code: value.code, botId: value.botId,
    text: value.text, level: value.level, count, firstAt: merge ? Math.min(previous.firstAt, now) : now,
    lastAt: Math.max(previous?.lastAt ?? now, now),
    status: value.immediate || (merge && previous.status === 'open') || count >= ctx.settings.alertConsecutiveCount ? 'open' : 'closed',
  };
  ctx.store.table('alerts').put(alert);
  ctx.emit(HUB_EVENT_SCOPES.overview, alert.botId);
  ctx.emit(HUB_EVENT_SCOPES.activity, alert.botId);
  return alert;
}

/** 关闭包含未达次数门槛的观测，并清零连续次数；下次发生是新一轮故障。 */
export function closeAlert(ctx: HubContext, code: string, botId: string | null): void {
  let changed = false;
  for (const alert of ctx.store.table('alerts').list(item => item.code === code && item.botId === botId && (item.status !== 'closed' || item.count !== 0))) {
    changed = true;
    ctx.store.table('alerts').patch(alert.id, { status: 'closed', count: 0 });
  }
  if (changed) {
    ctx.emit(HUB_EVENT_SCOPES.overview, botId);
    ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  }
}
