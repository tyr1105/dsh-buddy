/**
 * 项目容器服务层（v2 计划 3.4，第四期 F08）：主人的项目与任务命令。
 *
 * 纪律与编制/资料服务完全一致：
 * - 全部入参走 zod 校验，错误说清是哪一项不对；所有业务校验通过后才生成 id、写审计，
 *   失败命令不耗 RNG、不留半条记录；
 * - 时间只用注入时钟，id 只用注入 RNG，不碰文件系统（sharedDir 只存路径字符串，
 *   但保存时校验它必须落在 rootDir/projects 子树内，防止指向系统目录）；
 * - 每条命令写 writeOutreachAudit（actor 固定 owner）并发 project 事件（botId=null）。
 * 派活（议程/唤醒候选）见 assign.ts，唤醒包项目段见 wake/packet.ts；本文件不含队友侧 hub_project_* 工具。
 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId, text, timestamp } from '../model/primitives.js';
import type {
  AcceptanceCriterion, Project, ProjectStatus, ProjectTask, TaskStatus,
} from '../model/project.js';
import {
  AcceptanceCriterionSchema, CriterionStatusSchema, ProjectSchema, ProjectTaskSchema,
  emptyProjectContext,
} from '../model/project.js';
import type { Bot } from '../model/bot.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { recordAcceptancePassed } from './artifacts.js';
import { assertOwnerEligible, pickDefaultOwnerId } from './owner-rules.js';
import { normalizeProjectSharedDir, ensureProjectSharedDir } from './shared-dir.js';
import {
  TASK_REJECT_REASON_MAX, checkTransition, nextStatus, type TaskAction,
} from './task-state.js';

/** 验收项入参：已有项带 id（只允许改本项目已有项），新增项不带 id，新建恒为 open。 */
const CriterionInputSchema = z.strictObject({
  id: recordId('ac').optional(),
  text: nonempty.trim().min(1, '验收标准不能为空').max(300, '验收标准不能超过 300 字'),
  verify: text.trim().max(300, '验证方式不能超过 300 字').default(''),
  status: CriterionStatusSchema.optional(),
});

/** 项目保存入参；id 缺省表示新建。状态不收，状态流转只允许走暂停/恢复/完成/归档命令。 */
export const SaveProjectSchema = z.strictObject({
  id: recordId('prj').optional(),
  name: nonempty.trim().min(1, '项目名称不能为空').max(120, '项目名称不能超过 120 字'),
  charter: text.trim().max(500, '项目一句话目标不能超过 500 字').default(''),
  // P34 两层里的队友项目版本：愿景与约定允许为空；不传表示沿用旧值（老界面/老命令不丢字段）。
  vision: text.trim().max(2000, '项目愿景不能超过 2000 字').optional(),
  conventions: text.trim().max(2000, '项目约定不能超过 2000 字').optional(),
  ownerBotId: recordId('b').nullable().optional(),
  memberBotIds: z.array(recordId('b')).optional(),
  sharedDir: text.trim().min(1, '项目目录不能为空').max(1000, '项目目录不能超过 1000 字').optional(),
  acceptanceCriteria: z.array(CriterionInputSchema).optional(),
});
export type SaveProjectInput = z.infer<typeof SaveProjectSchema>;

/** 任务保存入参；status/wakeIds/artifactIds 不收，防止绕过状态机与本卡的只读纪律。 */
export const SaveTaskSchema = z.strictObject({
  id: recordId('pt').optional(),
  projectId: recordId('prj'),
  title: nonempty.trim().min(1, '任务标题不能为空').max(120, '任务标题不能超过 120 字'),
  detail: text.trim().max(2000, '任务说明不能超过 2000 字').default(''),
  assigneeBotId: recordId('b').nullable().optional(),
  dueAt: timestamp.nullable().optional(),
});
export type SaveTaskInput = z.infer<typeof SaveTaskSchema>;

/** 驳回入参：理由必填，长度与状态机口径一致。 */
export const RejectTaskSchema = z.strictObject({
  id: recordId('pt'),
  rejectReason: nonempty.trim().min(1, '驳回理由不能为空').max(TASK_REJECT_REASON_MAX, `驳回理由不能超过 ${TASK_REJECT_REASON_MAX} 字`),
});

export const ProjectIdSchema = recordId('prj');
export const TaskIdSchema = recordId('pt');

/** 项目变化统一发 project scope：全队结构，botId 固定 null。 */
function notifyProject(ctx: HubContext): void {
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 取一个存在且未退役的队友，否则中文报错说清是哪个队友。 */
function requireLiveBot(ctx: HubContext, botId: string, what: string): Bot {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.lifecycle === 'retired') throw new Error(`${what}队友不存在或已退役：${botId}`);
  return bot;
}

/** 新建或修改项目；成员按队友、去重、有上限；负责人必须是成员之一。 */
export function saveProject(ctx: HubContext, raw: unknown): Project {
  const input = parseInput(SaveProjectSchema, raw, '项目保存');
  const now = ctx.clock.now();
  const existing = input.id ? ctx.store.table('projects').get(input.id) : null;
  if (input.id && !existing) throw new Error(`项目不存在：${input.id}`);
  if (existing && existing.archivedAt !== null) throw new Error(`项目「${existing.name}」已归档，不能再修改`);

  // 1. 成员：去重、上限、队友必须存在且未退役。
  const members = [...new Set(input.memberBotIds ?? existing?.memberBotIds ?? [])];
  if (members.length > V2_DEFAULTS.PROJECT_MEMBER_MAX) {
    throw new Error(`项目成员不能超过 ${V2_DEFAULTS.PROJECT_MEMBER_MAX} 个队友，当前 ${members.length} 个`);
  }
  for (const botId of members) requireLiveBot(ctx, botId, '项目成员');

  // 2. 负责人：P60 起项目靠负责人运转，没指定（含界面传的 null）就按默认补：总管，否则第一位非建议风格的成员。
  //    选不出来（还没有合适的成员）时先留空，主人开主题时再中文报错，不挡住先建项目后加人。
  //    指定了的话，队友必须有效，且负责人必须是项目成员（不自动并入）。
  // 没传负责人时沿用旧值；旧负责人已退役或被移出成员时不卡住保存，按默认重新选一位。
  const inheritedOwner = existing?.ownerBotId ?? null;
  const inheritedUsable = inheritedOwner !== null && members.includes(inheritedOwner)
    && (ctx.store.table('bots').get(inheritedOwner)?.lifecycle ?? 'retired') !== 'retired';
  const requestedOwner = input.ownerBotId === undefined
    ? (inheritedUsable ? inheritedOwner : null)
    : input.ownerBotId;
  const ownerBotId = requestedOwner
    ?? pickDefaultOwnerId(members.map(id => ctx.store.table('bots').get(id)).filter(bot => bot !== null));
  if (ownerBotId !== null) {
    const ownerBot = requireLiveBot(ctx, ownerBotId, '项目负责人');
    if (!members.includes(ownerBotId)) {
      throw new Error('项目负责人必须是项目成员之一：请先把负责人加入成员名单');
    }
    // 只在负责人变动时校验风格：旧项目的负责人如果是建议风格，不能因此连项目名都改不了。
    if (ownerBotId !== existing?.ownerBotId) assertOwnerEligible(ownerBot);
  }

  // 3. 验收项：条数上限；带 id 的必须是本项目已有项；输入里同一 id 不得重复。
  const criterionInputs = input.acceptanceCriteria;
  if (criterionInputs !== undefined && criterionInputs.length > V2_DEFAULTS.PROJECT_CRITERION_MAX) {
    throw new Error(`验收项不能超过 ${V2_DEFAULTS.PROJECT_CRITERION_MAX} 条，当前 ${criterionInputs.length} 条`);
  }
  if (criterionInputs) {
    const seen = new Set<string>();
    for (const item of criterionInputs) {
      if (!item.id) continue;
      if (seen.has(item.id)) throw new Error(`验收项在入参里重复：${item.id}`);
      seen.add(item.id);
      if (!existing || !existing.acceptanceCriteria.some(c => c.id === item.id)) {
        throw new Error(`验收项不属于该项目，不能修改：${item.id}`);
      }
    }
  }

  // 4. 新建项目的防误操作上限（非归档项目计数，含进行中/暂停/完成）。
  if (!existing && ctx.store.table('projects').count(p => p.archivedAt === null) >= V2_DEFAULTS.PROJECT_MAX_ACTIVE) {
    throw new Error(`项目数量已达防误操作上限 ${V2_DEFAULTS.PROJECT_MAX_ACTIVE} 个，请先归档不用的项目`);
  }

  // 显式目录先校验再取随机数：失败命令不耗 RNG、不产生半条记录。
  // 目录边界与物理创建共用 shared-dir.ts：这里只校验，建目录在界面命令出口。
  const explicitSharedDir = input.sharedDir !== undefined ? normalizeProjectSharedDir(ctx, input.sharedDir) : null;
  // 全部校验通过后才取随机数。
  const id = existing?.id ?? newId('prj', ctx.rng);
  const sharedDir = explicitSharedDir ?? existing?.sharedDir
    ?? `${posix.join(ctx.settings.rootDir, 'projects', id)}/`;
  // 已有项保留 id 与原状态（入参显式给状态才覆盖）；新增项发新 ac_ id 且一律从 open 开始。
  const acceptanceCriteria: AcceptanceCriterion[] = criterionInputs === undefined
    ? (existing?.acceptanceCriteria ?? [])
    : criterionInputs.map(item => {
      if (item.id) {
        const old = existing!.acceptanceCriteria.find(c => c.id === item.id)!;
        return AcceptanceCriterionSchema.parse({ id: item.id, text: item.text, verify: item.verify, status: item.status ?? old.status });
      }
      return AcceptanceCriterionSchema.parse({ id: newId('ac', ctx.rng), text: item.text, verify: item.verify, status: 'open' });
    });

  const record: Project = ProjectSchema.parse({
    id,
    name: input.name,
    charter: input.charter,
    // 愿景/约定：显式传了就覆盖（允许清空），没传就沿用旧值；新建时缺省为空串。
    vision: input.vision !== undefined ? input.vision : (existing?.vision ?? ''),
    conventions: input.conventions !== undefined ? input.conventions : (existing?.conventions ?? ''),
    status: existing?.status ?? 'active',
    ownerBotId,
    memberBotIds: members,
    sharedDir,
    acceptanceCriteria,
    // P39：保存项目不动共享上下文与留痕——编辑上下文只走 saveProjectContext 命令，
    // 否则主人改一句项目目标就会顺手把上下文清空、或把队友的建议冲掉。
    context: existing?.context ?? emptyProjectContext(),
    contextRevisions: existing?.contextRevisions ?? [],
    // P60：背景的更新人和时间同样只由上下文命令维护，保存项目时原样带上，不能被这里冲掉。
    ...(existing?.backgroundUpdatedAt != null
      ? { backgroundUpdatedAt: existing.backgroundUpdatedAt, backgroundUpdatedBy: existing.backgroundUpdatedBy ?? null } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: existing?.archivedAt ?? null,
  });
  ctx.store.table('projects').put(record);
  writeOutreachAudit(ctx, existing ? 'project_update' : 'project_create',
    { id, name: record.name, status: record.status, ownerBotId, memberBotIds: members,
      sharedDir: record.sharedDir, criterionCount: acceptanceCriteria.length }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 修改项目状态的内部统一入口：白名单外的当前状态给出中文原因；归档同时打 archivedAt。 */
function changeProjectStatus(
  ctx: HubContext, rawId: unknown, allowed: ProjectStatus[], target: ProjectStatus, action: string,
  rejectText: string,
): Project {
  const id = parseInput(ProjectIdSchema, rawId, '项目命令');
  const now = ctx.clock.now();
  const project = ctx.store.table('projects').get(id);
  if (!project) throw new Error(`项目不存在：${id}`);
  if (!allowed.includes(project.status)) {
    throw new Error(`项目「${project.name}」当前是「${project.status}」，${rejectText}`);
  }
  const patch: Partial<Project> = { status: target, updatedAt: now };
  if (target === 'archived') patch.archivedAt = now; // 软归档：任务一条不删
  const record = ctx.store.table('projects').patch(id, patch);
  writeOutreachAudit(ctx, action, { id, name: record.name, from: project.status, to: target }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 暂停：只有进行中的项目能暂停。 */
export function pauseProject(ctx: HubContext, rawId: unknown): Project {
  return changeProjectStatus(ctx, rawId, ['active'], 'paused', 'project_pause', '只有进行中的项目能暂停');
}
/** 恢复：只有暂停的项目能恢复为进行中。 */
export function resumeProject(ctx: HubContext, rawId: unknown): Project {
  return changeProjectStatus(ctx, rawId, ['paused'], 'active', 'project_resume', '只有已暂停的项目能恢复');
}
/** 完成：进行中或已暂停的项目可标记完成；已归档不行。 */
export function completeProject(ctx: HubContext, rawId: unknown): Project {
  return changeProjectStatus(ctx, rawId, ['active', 'paused'], 'done', 'project_complete', '只有进行中或已暂停的项目能标记完成');
}
/** 归档：软归档不删任务；归档后不可改项目、不可改任务（恢复走 restoreProject）。 */
export function archiveProject(ctx: HubContext, rawId: unknown): Project {
  return changeProjectStatus(ctx, rawId, ['active', 'paused', 'done'], 'archived', 'project_archive', '只有未归档的项目能归档');
}

/**
 * 取消归档：只有已归档的项目能恢复，回到进行中并清掉 archivedAt；任务原样保留。
 * 恢复会让「未归档项目」多一个，所以要再查一次防误操作上限，避免归档-恢复绕过上限。
 */
export function restoreProject(ctx: HubContext, rawId: unknown): Project {
  const id = parseInput(ProjectIdSchema, rawId, '项目命令');
  const now = ctx.clock.now();
  const project = ctx.store.table('projects').get(id);
  if (!project) throw new Error(`项目不存在：${id}`);
  if (project.status !== 'archived') {
    throw new Error(`项目「${project.name}」当前是「${project.status}」，只有已归档的项目能恢复`);
  }
  if (ctx.store.table('projects').count(p => p.archivedAt === null) >= V2_DEFAULTS.PROJECT_MAX_ACTIVE) {
    throw new Error(`未归档项目已达防误操作上限 ${V2_DEFAULTS.PROJECT_MAX_ACTIVE} 个，请先归档不用的项目再恢复`);
  }
  const record = ctx.store.table('projects').patch(id, { status: 'active', archivedAt: null, updatedAt: now });
  writeOutreachAudit(ctx, 'project_restore', { id, name: record.name, from: project.status, to: 'active' }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 新建或修改任务；项目必须存在且未归档；指派队友必须存在且属于项目成员，空=待认领。 */
export function saveTask(ctx: HubContext, raw: unknown): ProjectTask {
  const input = parseInput(SaveTaskSchema, raw, '任务保存');
  const now = ctx.clock.now();
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，不能新建或修改任务`);
  const existing = input.id ? ctx.store.table('projectTasks').get(input.id) : null;
  if (input.id && !existing) throw new Error(`任务不存在：${input.id}`);
  if (existing && existing.projectId !== input.projectId) {
    throw new Error(`任务不属于该项目：任务 ${input.id} 属于项目 ${existing.projectId}`);
  }
  if (existing?.status === 'accepted') throw new Error(`任务「${existing.title}」已通过验收，是终态，不能再修改`);

  const assigneeBotId = input.assigneeBotId === undefined
    ? (existing?.assigneeBotId ?? null)
    : input.assigneeBotId;
  if (assigneeBotId !== null) {
    requireLiveBot(ctx, assigneeBotId, '任务指派');
    if (!project.memberBotIds.includes(assigneeBotId)) {
      throw new Error('任务只能指派给项目成员队友：请先把该队友加入项目成员');
    }
  }
  if (!existing && ctx.store.table('projectTasks').count(t => t.projectId === input.projectId) >= V2_DEFAULTS.PROJECT_TASK_MAX) {
    throw new Error(`单个项目任务不能超过 ${V2_DEFAULTS.PROJECT_TASK_MAX} 个，请先清理不用的任务`);
  }

  const id = existing?.id ?? newId('pt', ctx.rng);
  const record: ProjectTask = ProjectTaskSchema.parse({
    id,
    projectId: input.projectId,
    title: input.title,
    detail: input.detail,
    assigneeBotId,
    status: existing?.status ?? 'todo',
    wakeIds: existing?.wakeIds ?? [], // 本卡只读：派活卡再维护
    artifactIds: existing?.artifactIds ?? [],
    // P63：这件事是哪个主题聊出来的，只由负责人工具维护；主人改标题不能把它冲掉。
    ...(existing?.topicId ? { topicId: existing.topicId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    dueAt: input.dueAt === undefined ? (existing?.dueAt ?? null) : input.dueAt,
  });
  ctx.store.table('projectTasks').put(record);
  writeOutreachAudit(ctx, existing ? 'task_update' : 'task_create',
    { id, projectId: input.projectId, title: record.title, assigneeBotId, from: existing?.status ?? null }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 任务状态流转统一入口：校验项目未归档、经状态机判定，再 patch + 审计 + 发事件。 */
function moveTask(ctx: HubContext, rawId: unknown, action: TaskAction, auditAction: string): ProjectTask {
  const id = parseInput(TaskIdSchema, rawId, '任务命令');
  const now = ctx.clock.now();
  const task = ctx.store.table('projectTasks').get(id);
  if (!task) throw new Error(`任务不存在：${id}`);
  const project = ctx.store.table('projects').get(task.projectId);
  if (!project) throw new Error(`任务所属项目不存在：${task.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，任务状态不能再改`);
  const from: TaskStatus = task.status;
  const to = nextStatus(from, action); // 非法流转在这里抛中文错误
  const record = ctx.store.table('projectTasks').patch(id, { status: to, updatedAt: now });
  writeOutreachAudit(ctx, auditAction, { id, projectId: task.projectId, title: task.title, from, to }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 执行者语义：进行中 → 受阻（主人也可代操作）。 */
export function taskBlock(ctx: HubContext, rawId: unknown): ProjectTask {
  return moveTask(ctx, rawId, 'block', 'task_block');
}
/** 执行者语义：受阻 → 进行中。 */
export function taskResume(ctx: HubContext, rawId: unknown): ProjectTask {
  return moveTask(ctx, rawId, 'resume', 'task_resume');
}
/** 模拟队友交账的占位入口（供视图、测试与后续交账联动用）：进行中 → 待验收。 */
export function reportDone(ctx: HubContext, rawId: unknown): ProjectTask {
  return moveTask(ctx, rawId, 'report_done', 'task_report_done');
}
/** 主人验收通过：待验收 → 已通过（终态）。保守不强制勾完验收项，只记录主人结论。 */
export function acceptTask(ctx: HubContext, rawId: unknown): ProjectTask {
  const record = moveTask(ctx, rawId, 'accept', 'task_accept');
  // F08 尾巴：验收通过时把关联产物的最新版本一并记为「通过」（幂等，只写验收表）。
  const versionIds = recordAcceptancePassed(ctx, record);
  if (versionIds.length > 0) {
    writeOutreachAudit(ctx, 'task_accept_artifacts',
      { id: record.id, projectId: record.projectId, versionIds }, 'owner', ctx.clock.now());
  }
  return record;
}

/**
 * 主人驳回：待验收 →（驳回结论，理由必填）→ 回流进行中。
 * rejected 不持久化（避免任务停在结论态），驳回理由完整落在 task_reject 审计里。
 */
export function rejectTask(ctx: HubContext, raw: unknown): ProjectTask {
  const input = parseInput(RejectTaskSchema, raw, '任务驳回');
  const now = ctx.clock.now();
  const task = ctx.store.table('projectTasks').get(input.id);
  if (!task) throw new Error(`任务不存在：${input.id}`);
  const project = ctx.store.table('projects').get(task.projectId);
  if (!project) throw new Error(`任务所属项目不存在：${task.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，任务状态不能再改`);
  // 两条边都过状态机：待验收→驳回（验理由）、驳回→进行中（内部回流）。
  const verdict = nextStatus(task.status, 'reject', { rejectReason: input.rejectReason });
  const rework = checkTransition(verdict, 'doing');
  if (!rework.ok) throw new Error(rework.error);
  const record = ctx.store.table('projectTasks').patch(task.id, { status: 'doing', updatedAt: now });
  writeOutreachAudit(ctx, 'task_reject',
    { id: task.id, projectId: task.projectId, title: task.title, from: task.status, verdict, to: 'doing',
      rejectReason: input.rejectReason }, 'owner', now);
  notifyProject(ctx);
  return record;
}
