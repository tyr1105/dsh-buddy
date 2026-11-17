/** 普通错误仅重排单个机器人；额度与鉴权由中心保护，持续失败在第四次隔离。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { Rng } from '../io/interfaces.js';
import type { HubContext } from '../engine/context.js';
import type { Settings, WakeTicket } from '../model/index.js';
import type { CandidateInput } from '../appraisal/think.js';
import { resolveSettings } from '../config/defaults.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { parseInput } from '../engine/validation.js';
import { classifyError } from '../quota/errors.js';
import { onQuotaError } from '../quota/window.js';
import { isSelfWork } from '../quota/usage.js';
import { raiseAlert } from '../health/alerts.js';
import { quarantine } from '../health/quarantine.js';

/**
 * P76r1：重试候选沿用原回合的归属：「你发起」「总管为你派出」「主题编号」「事情编号（含事项键）」「你作出决定之后的接续」一并带过去。
 * 这样重试与原回合同一口径：你发起的回合出错，重试不被每天上限拦住；自己发起的回合重试仍是自己发起的（数名额时不另占，见 quota/usage.ts）。
 */
export function retryCarry(wake: WakeTicket, botRole: string | undefined): Partial<CandidateInput> {
  return {
    // P76r1 小修：原回合按 isSelfWork 判断的结论（需要员工角色，所以多收 botRole）；true 和 false 都带，
    // 这样团队信号、发给总管的同伴消息这类理由丢失之后，重试也不会被当成自己发起的。
    retryOfSelfWork: isSelfWork(wake, botRole),
    ...(wake.ownerInitiated ? { ownerInitiated: true } : {}),
    ...(wake.chiefDispatch ? { chiefDispatch: true } : {}),
    ...(wake.ownerDecided ? { ownerDecided: true } : {}),
    ...(wake.topicId ? { topicId: wake.topicId } : {}),
    // P74c：执行链的回合，重试候选带同一个 jobId，继续按执行链处理。
    ...(wake.jobId ? { jobId: wake.jobId, subjectKey: `jobwake:${wake.jobId}:${wake.botId}` } : {}),
  };
}

/** 按失败次数计算有抖动的退避，避免多个机器人同时重试。 */
export function retryDelayMs(attempt: number, rng: Rng, settings: Settings = resolveSettings()): number {
  if(!Number.isInteger(attempt) || attempt < 1) throw new Error('重排次数必须是从 1 开始的整数');
  const random = rng.next();
  if(!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('随机源必须返回 0 到 1 之间且不含 1 的数');
  const base = settings.retryBackoffMs[Math.min(attempt - 1, settings.retryBackoffMs.length - 1)]!;
  return Math.round(base * (1 + (random * 2 - 1) * settings.retryJitterRatio));
}
/**
 * 区分额度与鉴权保护、普通重排和隔离，单个故障不影响全队。
 * P76d：宿主报错对象上的错误代号、状态码（可省略）一并交来：判断是不是额度用完时先看它们，再看文字（quota/errors.ts）。
 * 认成额度用完之后不按普通出错处理：不计入连续出错次数（否则额度一用完，几位员工各自报错几次就会被停用）、
 * 不设按出错退避的重试时刻（bot.retryAt 保持原样）；被打断的回合由回合收尾重新排一条候选，等恢复探针放行（turn/events.ts 的 finishTurn）。
 */
export function onDispatchOrTurnError(ctx: HubContext, botId: string, errorText: string, now: number,
  extra: { errorCode?: string | null; statusCode?: number | null } = {}) {
  parseInput(z.strictObject({ botId: nonempty, errorText: nonempty, now: timestamp }), { botId, errorText, now }, '错误处理');
  const bot = ctx.store.table('bots').get(botId);
  if(!bot) throw new Error(`机器人不存在：${botId}`);
  const kind = classifyError(errorText, extra.errorCode, extra.statusCode);
  if(kind === 'quota') {
    onQuotaError(ctx, now, errorText);
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
