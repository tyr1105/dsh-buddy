/**
 * 项目任务清单工具（v2 计划 3.4 / F08 尾巴批次八）。
 *
 * 为什么需要：派活只把「本轮要做的任务」带进唤醒包；队友还需要一个随时可查的
 * 入口，看直接指派给自己的全部未结束任务（包括超出唤醒包条数的那几条），以及拿到
 * hub_task_update 需要的任务 id。
 *
 * 设计纪律：
 * - 只读：不进状态机、不写存储、不发事件；L0 与反思回合都可调用；
 * - 归属口径与唤醒包 project-tasks 段一致：只列任务上直接记录为本人承接、且项目
 *   未归档的任务；已通过的任务是终态，不再列出，减少干扰；
 * - 只给任务标题、状态、截止时间与项目名，不贴说明正文与验收项；细节看唤醒包。
 */
import { z } from 'zod';
import { defineTool } from './common.js';
import { isTaskAssignedTo } from './task-access.js';
import { PROJECT_STATUS_LABELS, TASK_STATUS_LABELS } from '../model/project.js';
import { formatShort } from '../util/time.js';

/** 列表无参数；保留 strictObject 让未知字段直接得到中文校验错误。 */
export const HubTaskListInputSchema = z.strictObject({});

export const hubTaskList = defineTool('hub_task_list',
  '列出指派给你的项目任务（任务 id、标题、状态、截止时间）；只读。推进状态用 hub_task_update。',
  HubTaskListInputSchema, 'all', (ctx, tc) => {
    const projects = new Map(
      ctx.store.table('projects').list(p => p.status !== 'archived').map(p => [p.id, p] as const),
    );
    const tasks = ctx.store.table('projectTasks').list(t =>
      t.status !== 'accepted'
      && isTaskAssignedTo(t, tc.botId)
      && projects.has(t.projectId));
    if (tasks.length === 0) return { ok: true, text: '你当前没有未结束的项目任务。' };

    const now = ctx.clock.now();
    const ordered = [...tasks].sort((a, b) => {
      const dueA = a.dueAt ?? Number.MAX_SAFE_INTEGER;
      const dueB = b.dueAt ?? Number.MAX_SAFE_INTEGER;
      return dueA - dueB || a.createdAt - b.createdAt;
    });
    const lines = ordered.map(task => {
      const project = projects.get(task.projectId)!;
      const due = task.dueAt === null ? '' : `，截止 ${formatShort(task.dueAt, now, ctx.settings.timezone)}`;
      // 非进行中的项目带一句状态说明，避免队友对着暂停/完成的项目继续推进。
      const paused = project.status === 'active' ? '' : `，项目${PROJECT_STATUS_LABELS[project.status]}，暂不能推进`;
      return `- [${task.id}] ${task.title}（项目「${project.name}」，${TASK_STATUS_LABELS[task.status]}${due}${paused}）`;
    });
    return { ok: true, text: `你当前有 ${ordered.length} 个未结束的项目任务：\n${lines.join('\n')}` };
  });
