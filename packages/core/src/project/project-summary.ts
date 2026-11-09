/**
 * 项目汇总与问题检测（纯函数，v2 计划 3.4/3.5 投影纪律；主人取消编制后改为按队友）。
 *
 * 这里只做计算，不读存储、不读时钟、不发事件：输入项目、任务、队友快照，
 * 输出任务计数、进度、失效队友标记和问题列表。视图层（api/project-views.ts）只负责组装，
 * 服务层负责阻止新矛盾；旧档/手改档里已有的矛盾在这里被诚实列出，绝不自动替主人改项目。
 */
import type { Bot } from '../model/bot.js';
import type { Project, ProjectTask, TaskStatus } from '../model/project.js';
import { TASK_STATUS_LABELS } from '../model/project.js';

/** 一个项目内任务按状态的计数；total 含全部状态（含已通过、已驳回结论残留）。 */
export interface TaskStatusCounts {
  todo: number;
  doing: number;
  blocked: number;
  done_pending_check: number;
  accepted: number;
  rejected: number;
  total: number;
}

/** 项目问题代码；中文文案必须点到具体队友或任务，方便主人定位。 */
export const PROJECT_ISSUE_CODES = [
  'owner_bot_invalid', // 负责人队友不存在或已退役
  'member_bot_invalid', // 成员队友不存在或已退役
  'task_assignee_invalid', // 任务指派队友不存在或已退役
  'task_assignee_not_member', // 任务指派给了不属于项目成员的队友
  'done_with_open_tasks', // 已完成项目里还有未通过验收的任务
] as const;
export type ProjectIssueCode = typeof PROJECT_ISSUE_CODES[number];

/**
 * 一条项目问题；error 建议先修，warning 是提醒。
 *
 * 文案纪律：正文只说人话（如「队友已删除或退役」），绝不把内部 bot id 拼进正文或
 * 行内标签；需要排障时由界面把 subjectBotId 放进悬停 title，主人看不见裸 id。
 */
export interface ProjectIssue {
  level: 'error' | 'warning';
  code: ProjectIssueCode;
  text: string;
  /** 问题指向的失效队友 id（仅排障用，界面只放进 title）；没有具体队友时缺省。 */
  subjectBotId?: string;
}

/** 单项目汇总：任务计数、验收进度、失效负责人/成员标记。 */
export interface ProjectSummary {
  projectId: string;
  taskCounts: TaskStatusCounts;
  /** 验收进度 = 已通过任务数 / 任务总数；没有任务时为 0，避免除零。 */
  progress: number;
  /** 负责人队友失效（不存在或已退役）；没有负责人不算问题。 */
  ownerInvalid: boolean;
  /** 失效成员队友 id（不存在或已退役），去重保序。 */
  invalidMemberBotIds: string[];
}

/** 空计数，保证每个状态键都存在，界面不用猜缺哪个字段。 */
function emptyCounts(): TaskStatusCounts {
  return { todo: 0, doing: 0, blocked: 0, done_pending_check: 0, accepted: 0, rejected: 0, total: 0 };
}

/** 队友是否仍可用于项目：存在且未退役。项目不随队友退役自动改，只暴露问题。 */
function botUsable(botsById: Map<string, Bot>, botId: string): boolean {
  const bot = botsById.get(botId);
  return bot !== undefined && bot.lifecycle !== 'retired';
}

/** 统计一个项目的任务；只数 projectId 完全一致的任务。 */
export function summarizeProject(project: Project, tasks: ProjectTask[], bots: Bot[]): ProjectSummary {
  const botsById = new Map(bots.map(b => [b.id, b]));
  const taskCounts = emptyCounts();
  for (const task of tasks) {
    if (task.projectId !== project.id) continue;
    taskCounts[task.status] += 1;
    taskCounts.total += 1;
  }
  const memberSet = new Set(project.memberBotIds);
  const invalidMemberBotIds = [...memberSet]
    .filter(botId => !botUsable(botsById, botId));
  return {
    projectId: project.id,
    taskCounts,
    progress: taskCounts.total === 0 ? 0 : taskCounts.accepted / taskCounts.total,
    ownerInvalid: project.ownerBotId !== null && !botUsable(botsById, project.ownerBotId),
    invalidMemberBotIds,
  };
}

/** 汇总所需的完整事实快照；纯函数只读它。 */
export interface ProjectSummaryData {
  projects: Project[];
  tasks: ProjectTask[];
  bots: Bot[];
}

/**
 * 批量汇总；按 v2 计划 4.6，归档项目不参与活跃汇总，只在视图的归档区展示。
 * 顺序与输入项目一致，调用方需要稳定顺序时先排好序再传入。
 */
export function summarizeProjects(data: ProjectSummaryData): ProjectSummary[] {
  return data.projects
    .filter(project => project.status !== 'archived')
    .map(project => summarizeProject(project, data.tasks, data.bots));
}

/**
 * 列出单个项目的问题。归档项目是历史陈列，不再报问题；
 * 新矛盾本应由服务层拦住，这里只负责把旧档里的矛盾摆出来。
 */
export function collectProjectIssues(project: Project, tasks: ProjectTask[], bots: Bot[]): ProjectIssue[] {
  if (project.status === 'archived') return [];
  const botsById = new Map(bots.map(b => [b.id, b]));
  const issues: ProjectIssue[] = [];
  const botName = (botId: string): string => botsById.get(botId)?.name ?? botId;

  // 1. 负责人队友失效。失效队友查不到名字，正文不猜名字也不露 id，只给固定中文占位。
  if (project.ownerBotId !== null && !botUsable(botsById, project.ownerBotId)) {
    issues.push({
      level: 'error', code: 'owner_bot_invalid', subjectBotId: project.ownerBotId,
      text: `项目「${project.name}」的负责人已删除或退役，请重新指定负责人`,
    });
  }

  // 2. 成员队友失效（去重，成员数组本身已由服务层去重，这里仍按 Set 防手改档重复）。
  for (const botId of new Set(project.memberBotIds)) {
    if (!botUsable(botsById, botId)) {
      issues.push({
        level: 'warning', code: 'member_bot_invalid', subjectBotId: botId,
        text: `项目「${project.name}」有一名成员已删除或退役，请调整成员名单`,
      });
    }
  }

  const memberSet = new Set(project.memberBotIds);
  const projectTasks = tasks.filter(task => task.projectId === project.id);

  // 3/4. 任务指派问题：队友失效是 error；队友有效但不在成员名单里也是 error（派给了项目外人）。
  for (const task of projectTasks) {
    const assignee = task.assigneeBotId;
    if (assignee === null) continue;
    if (!botUsable(botsById, assignee)) {
      issues.push({
        level: 'error', code: 'task_assignee_invalid', subjectBotId: assignee,
        text: `任务「${task.title}」指派的队友已删除或退役`,
      });
    } else if (!memberSet.has(assignee)) {
      issues.push({
        level: 'error', code: 'task_assignee_not_member',
        text: `任务「${task.title}」指派给了非项目成员「${botName(assignee)}」`,
      });
    }
  }

  // 5. 已完成项目却还有没验收通过的任务（已归档项目在上面已整体跳过）。
  if (project.status === 'done') {
    const open = projectTasks.filter(task => task.status !== 'accepted');
    if (open.length > 0) {
      issues.push({
        level: 'warning', code: 'done_with_open_tasks',
        text: `项目已标记完成，但仍有 ${open.length} 个任务未通过验收：${open.map(t => `「${t.title}」`).join('、')}`,
      });
    }
  }
  return issues;
}

/**
 * 任务在项目内的分组顺序：进行中与受阻最靠前，待办、待验收居中，
 * 通过与驳回结论沉底；组内按创建时间、id 稳定排序。
 */
export const TASK_SORT_GROUP: Record<TaskStatus, number> = {
  doing: 0, blocked: 1, todo: 2, done_pending_check: 3, accepted: 4, rejected: 5,
};

/** 同时间按 id 字典序，保证任何输入下输出顺序确定。 */
export function byTimeThenId<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 项目排序：非归档在前（按创建时间、id），归档项目整体沉底。 */
export function sortProjectsForView(projects: Project[]): Project[] {
  const live = projects.filter(p => p.status !== 'archived').sort(byTimeThenId);
  const archived = projects.filter(p => p.status === 'archived').sort(byTimeThenId);
  return [...live, ...archived];
}

/** 任务排序：先按状态分组顺序，再按创建时间、id。 */
export function sortTasksForView(tasks: ProjectTask[]): ProjectTask[] {
  return tasks.slice().sort((a, b) =>
    TASK_SORT_GROUP[a.status] - TASK_SORT_GROUP[b.status] || byTimeThenId(a, b));
}

/** 任务状态中文标签给视图层复用，避免各处自己拼。 */
export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status];
}
