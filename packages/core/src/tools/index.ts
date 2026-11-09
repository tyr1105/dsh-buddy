/** 机器人工具注册表：统一导出十五个已校验工具，所有未知名称与异常都成为中文失败结果。 */
import type { HubContext } from '../engine/context.js';
import type { ToolContext, ToolResult, HubTool } from './types.js';
import { hubStateGet } from './hub-state-get.js';
import { hubCommit } from './hub-commit.js';
import { hubAgendaUpsert } from './hub-agenda-upsert.js';
import { hubAgendaClose } from './hub-agenda-close.js';
import { hubWatchUpdate } from './hub-watch-update.js';
import { hubWatchPropose } from './hub-watch-propose.js';
import { hubGoalUpsert } from './hub-goal-upsert.js';
import { hubOutboxSubmit } from './hub-outbox-submit.js';
import { hubLessonPropose } from './hub-lesson-propose.js';
import { hubReflectCommit } from './hub-reflect-commit.js';
import { hubSend } from './hub-send.js';
import { hubHandoff } from './hub-handoff.js';
import { hubClaim } from './hub-claim.js';
import { hubRelease } from './hub-release.js';
import { hubRoutineSave } from './hub-routine-save.js';
export * from './types.js';
/** 返回中心支持的完整工具清单，让宿主注册与统一调用使用同一组定义。 */
export function buildTools(_ctx: HubContext): HubTool[] {
    return [hubStateGet, hubCommit, hubAgendaUpsert, hubAgendaClose, hubWatchUpdate, hubWatchPropose, hubGoalUpsert, hubOutboxSubmit, hubLessonPropose, hubReflectCommit, hubSend, hubHandoff, hubClaim, hubRelease, hubRoutineSave];
}
/** 按名称查找并执行工具，未知名称和异常统一转为可读失败结果。 */
export async function runTool(ctx: HubContext, toolCtx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    try {
        const tool = buildTools(ctx).find(item => item.name === name);
        if (!tool)
            return { ok: false, error: `未知机器人工具：${name}` };
        return await tool.handler(ctx, toolCtx, rawArgs);
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '工具执行失败' };
    }
}
