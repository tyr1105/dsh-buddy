/** 普通错误仅重排单个机器人；额度与鉴权由中心保护，持续失败在第四次隔离。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { Rng } from '../io/interfaces.js';
import type { HubContext } from '../engine/context.js';
import type { Settings } from '../model/index.js';
import { resolveSettings } from '../config/defaults.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { parseInput } from '../engine/validation.js';
import { classifyError } from '../quota/errors.js';
import { onQuotaError } from '../quota/window.js';
import { raiseAlert } from '../health/alerts.js';
import { quarantine } from '../health/quarantine.js';

/** 按失败次数计算有抖动的退避，避免多个机器人同时重试。 */
export function retryDelayMs(attempt: number, rng: Rng, settings: Settings = resolveSettings()): number {
  if(!Number.isInteger(attempt) || attempt < 1) throw new Error('重排次数必须是从 1 开始的整数');
  const random = rng.next();
  if(!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('随机源必须返回 0 到 1 之间且不含 1 的数');
  const base = settings.retryBackoffMs[Math.min(attempt - 1, settings.retryBackoffMs.length - 1)]!;
  return Math.round(base * (1 + (random * 2 - 1) * settings.retryJitterRatio));
}
/** 区分额度与鉴权保护、普通重排和隔离，单个故障不影响全队。 */
export function onDispatchOrTurnError(ctx: HubContext, botId: string, errorText: string, now: number) {
  parseInput(z.strictObject({ botId: nonempty, errorText: nonempty, now: timestamp }), { botId, errorText, now }, '错误处理');
  const bot = ctx.store.table('bots').get(botId);
  if(!bot) throw new Error(`机器人不存在：${botId}`);
  const kind = classifyError(errorText);
  if(kind === 'quota') {
    onQuotaError(ctx, now);
    return { action: 'quota' as const, retryAt: null };
  }
  if(kind === 'auth') {
    raiseAlert(ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true, at: now });
    return { action: 'auth' as const, retryAt: null };
  }
  const errors = bot.consecutiveErrors + 1;
  const retryAt = now + retryDelayMs(errors, ctx.rng, ctx.settings);
  ctx.store.table('bots').patch(botId, { consecutiveErrors: errors, retryAt, updatedAt: now });
  if(errors >= ctx.settings.retryQuarantineCount) {
    quarantine(ctx, botId, `连续 ${errors} 次投递或回合失败：${errorText}`, now);
    return { action: 'quarantined' as const, retryAt: null };
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return { action: 'retry' as const, retryAt };
}
