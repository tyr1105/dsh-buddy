/**
 * 机器人工具注册表：统一导出已校验工具，所有未知名称与异常都成为中文失败结果。
 * P74b：hub_handoff、hub_claim、hub_release 移出清单，新增 hub_job_manage；P74d 加入 hub_job_work。
 * P75f：hub_lesson_propose、hub_reflect_commit、hub_routine_save 三个旧工具下线（员工的经验改由评审者核对、
 * 复盘改走 hub_skill、套路并入技能库），总数由 27 变为 24。
 * P75g：加入 hub_skill（复盘、核对、整理回合里提交技能更新），总数由 24 变为 25。
 */
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
import { hubSend } from './hub-send.js';
// F17：资料可见性两个只读工具（列表 + 按授权读取正文）。
import { hubResourceList } from './hub-resource-list.js';
import { hubResourceRead } from './hub-resource-read.js';
import { hubArtifactRead } from './hub-artifact-read.js';
// F08 尾巴批次八：队友侧项目任务工具（只读清单 + 执行者状态推进）。
import { hubTaskList } from './hub-task-list.js';
import { hubTaskUpdate } from './hub-task-update.js';
// P38：公共知识库只读工具（检索条目 + 按 id 读正文；未配置时不发请求）。
import { hubKnowledgeSearch } from './hub-knowledge-search.js';
import { hubKnowledgeRead } from './hub-knowledge-read.js';
// P60：项目负责人专用的两个工具：维护事务清单、直接更新项目背景。
import { hubProjectTaskUpsert } from './hub-project-task-upsert.js';
import { hubProjectBackgroundUpdate } from './hub-project-background-update.js';
// P69：把家目录里的成品放进项目文件夹（成员免审批）。
import { hubProjectPut } from './hub-project-put.js';
// P72b：总管提交开工前的约定（仅总管，其他员工调用会被拒绝）。
import { hubAgreementSubmit } from './hub-agreement-submit.js';
// P73d：总管为已固定的约定推荐新员工（仅总管，其他员工调用会被拒绝）。
import { hubTeamPropose } from './hub-team-propose.js';
// P74b：总管管理一件事（派活、改派；仅总管，其他员工调用会被拒绝）。
import { hubJobManage } from './hub-job-manage.js';
// P74d：一件事的执行者和核对人用的工具（提问、交回、核对、说明无法继续）。
import { hubJobWork } from './hub-job-work.js';
// P75c：总管记住主人以后都适用的规矩或偏好（仅总管，其他员工调用会被拒绝）。
import { hubMemory } from './hub-memory.js';
// P75g：复盘、核对、整理回合里提交技能更新（只在对应的技能类唤醒里能调用，服务层检查）。
import { hubSkill } from './hub-skill.js';
export * from './types.js';
/** 返回中心支持的完整工具清单，让宿主注册与统一调用使用同一组定义。 */
export function buildTools(_ctx: HubContext): HubTool[] {
    return [hubStateGet, hubCommit, hubAgendaUpsert, hubAgendaClose, hubWatchUpdate, hubWatchPropose, hubGoalUpsert, hubOutboxSubmit, hubSend, hubResourceList, hubResourceRead, hubArtifactRead, hubTaskList, hubTaskUpdate, hubKnowledgeSearch, hubKnowledgeRead, hubProjectTaskUpsert, hubProjectBackgroundUpdate, hubProjectPut, hubAgreementSubmit, hubTeamPropose, hubJobManage, hubJobWork, hubMemory, hubSkill];
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
