/** 会话轮换只依据显式年龄、宿主上下文比例与模型是否被换过，不读系统时间，也不在此创建宿主会话。 */
import type { Bot, HostPort, Settings } from '../model/index.js';
import { resolveSettings } from '../config/defaults.js';

/**
 * 两个模型选择是否相同（P74r10）：两边都是空值（跟随宿主默认）算相同；
 * 都不是空值时，厂商和模型名都相同才算相同；一边空一边不空算不同。
 */
export function sameModelChoice(a: Bot['model'], b: Bot['model']): boolean {
    if (a === null || b === null) return a === b;
    return a.provider === b.provider && a.model === b.model;
}

/**
 * 员工的模型是否与当前会话建立时用的模型不一致（P74r10）。
 * 为什么重建而不是在旧会话上切换：不同模型接着同一段对话历史，工具调用的格式可能对不上。
 * 记录上没有 sessionModel（升级前建的会话）表示不知道，不判不一致。
 */
export function sessionModelChanged(bot: Bot): boolean {
    return bot.sessionModel !== undefined && !sameModelChoice(bot.sessionModel, bot.model);
}

/** 依据显式会话年龄、存在状态、上下文占用和模型变更判断是否轮换，不创建新会话。 */
export function needsRotation(bot: Bot, sessionInfo: Awaited<ReturnType<HostPort['sessionInfo']>>, now: number, settings: Settings = resolveSettings()): boolean {
    return bot.sessionId === null || !sessionInfo.exists
        || (bot.sessionStartedAt !== null && now - bot.sessionStartedAt >= settings.sessionMaxAgeMs)
        || (sessionInfo.contextRatio !== null && sessionInfo.contextRatio >= settings.sessionContextRatio)
        || sessionModelChanged(bot);
}
