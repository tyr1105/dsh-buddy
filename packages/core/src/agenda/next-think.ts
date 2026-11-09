/** 机器人只预约下一次思考：校验交账意图，并把时间夹在有效节奏与最长复查窗口之间。 */
import { parseInput } from '../engine/validation.js';
import type { Bot, NextThink, QuotaState, Settings } from '../model/index.js';
import { NextThinkSchema } from '../model/wake.js';
import { paceMaxMsFor } from '../config/defaults.js';
import { effectivePaceMinMs } from '../scheduler/pacing.js';
import { parseFlexibleTime } from '../util/time.js';

export interface NextThinkContextInfo { settings: Settings; hasActiveGoal: boolean; quotaLight?: QuotaState['light'] }
export type NextThinkPatch = Partial<Bot> & { warning?: string };

const inputSchema = NextThinkSchema.superRefine((value, ctx) => {
  if (!value.reason.trim()) ctx.addIssue({ code: 'custom', path: ['reason'], message: '下次思考理由不能只包含空白' });
  if (value.mode === 'at' && value.at === undefined) ctx.addIssue({ code: 'custom', path: ['at'], message: '指定时刻模式必须填写 at 时间' });
  if (value.mode === 'after' && value.afterMinutes === undefined) ctx.addIssue({ code: 'custom', path: ['afterMinutes'], message: '延后模式必须填写 afterMinutes 分钟数' });
  if (value.mode === 'on_event' && value.onEvent === undefined) ctx.addIssue({ code: 'custom', path: ['onEvent'], message: '等事件模式必须填写 onEvent 事件说明' });
});

/** 解析失败回退 auto 并显式返回 warning；无效输入仍按中文字段错误拒绝。 */
export function applyNextThink(bot: Bot, nextThink: NextThink, now: number, ctxInfo: NextThinkContextInfo): NextThinkPatch {
  const value = parseInput(inputSchema, nextThink, '下次思考');
  const max = paceMaxMsFor(ctxInfo.hasActiveGoal, ctxInfo.settings);
  const patch: NextThinkPatch = { nextThinkAt: null, nextThinkBy: value.mode === 'auto' ? 'hub' : 'bot',
    nextThinkMode: value.mode, nextThinkReason: value.reason, lightCheckAt: now + max, updatedAt: now };
  if (value.mode === 'on_event' || value.mode === 'auto') return patch;
  const requested = value.mode === 'at' ? parseFlexibleTime(value.at!, ctxInfo.settings.timezone) : now + value.afterMinutes! * 60_000;
  if (requested === null || !Number.isFinite(requested)) {
    return { ...patch, nextThinkMode: 'auto', nextThinkBy: 'hub', warning: `下次思考时间「${value.at ?? value.afterMinutes}」无法解析，已改为自动等待并保留轻复查` };
  }
  // 若用户设置的最短间隔超过最大间隔，最长复查优先，保证夹紧结果有界。
  const min = Math.min(max, effectivePaceMinMs(bot, ctxInfo.settings, ctxInfo.quotaLight ?? 'green'));
  return { ...patch, nextThinkAt: Math.min(now + max, Math.max(now + min, requested)) };
}

/** 调整目标后依然以最后一次真实思考为锚点；未思考过则以创建时间作保守基线。 */
export function refreshLightCheck(bot: Bot, now: number, settings: Settings, hasActiveGoal: boolean): Partial<Bot> {
  return { lightCheckAt: (bot.lastThinkAt ?? bot.createdAt) + paceMaxMsFor(hasActiveGoal, settings), updatedAt: now };
}
