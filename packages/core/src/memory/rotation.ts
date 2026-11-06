/** 会话轮换只依据显式年龄与宿主上下文比例，不读系统时间，也不在此创建宿主会话。 */
import type { Bot, HostPort, Settings } from '../model/index.js';
import { resolveSettings } from '../config/defaults.js';
/** 依据显式会话年龄、存在状态和上下文占用判断是否轮换，不创建新会话。 */
export function needsRotation(bot: Bot, sessionInfo: Awaited<ReturnType<HostPort['sessionInfo']>>, now: number, settings: Settings = resolveSettings()): boolean {
    return bot.sessionId === null || !sessionInfo.exists
        || (bot.sessionStartedAt !== null && now - bot.sessionStartedAt >= settings.sessionMaxAgeMs)
        || (sessionInfo.contextRatio !== null && sessionInfo.contextRatio >= settings.sessionContextRatio);
}
