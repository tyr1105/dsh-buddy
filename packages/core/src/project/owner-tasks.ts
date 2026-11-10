/**
 * 负责人维护事务清单（P60）：聊出来要做的事由 owner 写成事务，主人在项目页只读。
 *
 * 为什么不复用主人的 saveTask 和状态机：事务清单是负责人记账用的，
 * 它要能一次写好「谁跟进、什么状态」，不需要走执行者那条一步步的状态机；
 * 但「不能是项目外的人」「已完成不能改回去」这些底线不能松。
 *
 * 建事务不叫醒任何人：会话和事务是分开的（DC40），要谁动手由 owner 在主题里 @ 他。
 * 所有校验做完才写入，失败不留半条记录，也不消耗随机数。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId, text } from '../model/primitives.js';
import { ProjectTaskSchema, type ProjectTask, type TaskStatus } from '../model/project.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { isBotOnTeam } from '../org/access.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { newId } from '../util/ids.js';
import { requireProjectOwnerBot } from './owner-rules.js';
import { OWNER_SETTABLE_TASK_STATUSES, explainOwnerStatusChange } from './task-state.js';

/** 不传 taskId 是新建（title 必填），传了是更新（只改传了的字段）。 */
export const OwnerTaskUpsertSchema = z.strictObject({
  projectId: recordId('prj'),
  taskId: recordId('pt').optional(),
  title: nonempty.trim().min(1, '事务标题不能为空').max(120, '事务标题不能超过 120 字').optional(),
  detail: text.trim().max(2000, '事务说明不能超过 2000 字').optional(),
  assigneeBotId: recordId('b').nullable().optional(),
  status: z.enum(OWNER_SETTABLE_TASK_STATUSES, {
    error: '状态必须是 todo（待办）、doing（进行中）、blocked（受阻）、done_pending_check（待确认）或 accepted（已完成）之一',
  }).optional(),
  topicId: recordId('ptp').nullable().optional(),
});
export type OwnerTaskUpsertInput = z.infer<typeof OwnerTaskUpsertSchema>;

/** 校验跟进人：必须是项目成员且在岗，派给叫不醒的人等于没派。 */
function requireAssignee(ctx: HubContext, memberBotIds: readonly string[], botId: string): void {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || !memberBotIds.includes(botId)) throw new Error(`assigneeBotId：跟进人必须是项目成员：${botId}`);
  if (!isBotOnTeam(bot)) throw new Error(`assigneeBotId：队友「${bot.name}」现在不在岗，请换一位成员跟进`);
}

/**
 * 新建或更新一件事务。
 * currentTopicId 是当前回合所在的主题：聊着聊着写下来的事，默认归到这个主题，owner 不用自己传。
 */
export function upsertTaskByOwner(ctx: HubContext, botId: string, raw: unknown, currentTopicId: string | null = null): { task: ProjectTask; created: boolean } {
  const input = parseInput(OwnerTaskUpsertSchema, raw, '事务更新');
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);
  requireProjectOwnerBot(project, botId);
  if (project.status !== 'active') throw new Error(`项目「${project.name}」当前不是进行中，暂不能改事务清单`);

  const existing = input.taskId ? ctx.store.table('projectTasks').get(input.taskId) : null;
  if (input.taskId && !existing) throw new Error(`taskId：事务不存在：${input.taskId}`);
  if (existing && existing.projectId !== project.id) throw new Error(`taskId：事务不属于项目「${project.name}」`);
  if (!existing && !input.title) throw new Error('title：新建事务必须写标题');
  if (!existing && ctx.store.table('projectTasks').count(task => task.projectId === project.id) >= V2_DEFAULTS.PROJECT_TASK_MAX) {
    throw new Error(`单个项目任务不能超过 ${V2_DEFAULTS.PROJECT_TASK_MAX} 个，请先清理不用的任务`);
  }

  // 只有跟进人真的变了才校验在不在岗：改一下标题不该因为跟进人后来暂停了就失败。
  const assigneeBotId = input.assigneeBotId === undefined ? (existing?.assigneeBotId ?? null) : input.assigneeBotId;
  if (assigneeBotId !== null && assigneeBotId !== existing?.assigneeBotId) requireAssignee(ctx, project.memberBotIds, assigneeBotId);

  // 新建时有跟进人就算开工：成员只能推进进行中的事务，留在待办它就动不了。
  const status: TaskStatus = input.status ?? existing?.status ?? (assigneeBotId === null ? 'todo' : 'doing');
  if (existing) {
    const denied = explainOwnerStatusChange(existing.status, status);
    if (denied !== null) throw new Error(denied);
  }

  const topicId = input.topicId === undefined ? (existing?.topicId ?? (existing ? null : currentTopicId)) : input.topicId;
  if (topicId !== null && ctx.store.table('projectTopics').get(topicId)?.projectId !== project.id) {
    throw new Error(`topicId：主题不属于项目「${project.name}」`);
  }

  const now = ctx.clock.now();
  const task: ProjectTask = ProjectTaskSchema.parse({
    id: existing?.id ?? newId('pt', ctx.rng),
    projectId: project.id,
    title: input.title ?? existing!.title,
    detail: input.detail ?? existing?.detail ?? '',
    assigneeBotId,
    status,
    wakeIds: existing?.wakeIds ?? [],
    artifactIds: existing?.artifactIds ?? [],
    ...(topicId !== null ? { topicId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    dueAt: existing?.dueAt ?? null,
  });
  ctx.store.table('projectTasks').put(task);
  writeOutreachAudit(ctx, existing ? 'task_update' : 'task_create', {
    id: task.id, projectId: project.id, title: task.title, assigneeBotId, from: existing?.status ?? null, to: status,
    topicId, via: 'hub_project_task_upsert', botId,
  }, botId, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return { task, created: existing === null };
}
