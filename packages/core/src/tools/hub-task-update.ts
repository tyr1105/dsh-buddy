/**
 * 项目任务状态工具（队友侧，v2 计划 3.4 / F08 尾巴批次八）。
 *
 * 让队友自己推进「已经指派给自己」的任务：标记受阻、恢复、交账待验收。
 * 为什么不做「开始」：开始由主人派活完成（todo→doing），队友只能接手已经在进行
 * 的活，避免一个待办被队友自行开工、绕过主人派活。
 *
 * 纪律：
 * - 只认任务上记录的承接队友 id；不接受任务 id 之外的任何归属参数，防止冒充别人；
 * - 项目必须进行中；暂停/完成/归档项目里的任务一律拒绝；
 * - 流转只走 project/task-state.ts 的 nextStatus，不裸写状态字符串；
 * - 审计 actor 记真实 botId，动作名沿用主人命令的 task_block/task_resume/task_report_done，
 *   用 actor 区分是谁做的；写后发 project scope，项目页立即刷新。
 */
import { z } from 'zod';
import { defineTool } from './common.js';
import { isTaskAssignedTo } from './task-access.js';
import { recordId } from '../model/primitives.js';
import { PROJECT_STATUS_LABELS, TASK_STATUS_LABELS } from '../model/project.js';
import { nextStatus } from '../project/task-state.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

/** 队友能做的三个动作；验收通过与驳回属于主人，不开放。 */
export const HubTaskUpdateInputSchema = z.strictObject({
  taskId: recordId('pt'),
  action: z.enum(['block', 'resume', 'report_done'], {
    error: '动作必须是 block（标记受阻）、resume（恢复）或 report_done（交账待验收）',
  }),
});
export type HubTaskUpdateInput = z.infer<typeof HubTaskUpdateInputSchema>;

/** 动作到审计名的映射：与主人命令共用同一套动作词，靠 actor 区分执行者。 */
const AUDIT_ACTIONS = {
  block: 'task_block',
  resume: 'task_resume',
  report_done: 'task_report_done',
} as const;

/** 交账后给队友的提示要强调「还没完」：通过验收才算完成。 */
const DONE_HINT = '，等主人验收；验收通过前不要把它当成已完成';

export const hubTaskUpdate = defineTool('hub_task_update',
  '推进指派给你的项目任务：block 标记受阻、resume 恢复进行中、report_done 交账待验收；只有进行中/受阻任务能用。',
  HubTaskUpdateInputSchema, 'L1', (ctx, tc, args) => {
    const task = ctx.store.table('projectTasks').get(args.taskId);
    if (!task) throw new Error(`任务不存在：${args.taskId}`);

    // 归属：任务上记录的承接队友必须就是当前队友本人。
    if (!isTaskAssignedTo(task, tc.botId)) {
      throw new Error('这个任务没有指派给你，不能改它的状态');
    }

    const project = ctx.store.table('projects').get(task.projectId);
    if (!project) throw new Error(`任务所属项目不存在：${task.projectId}`);
    if (project.status !== 'active') {
      throw new Error(`项目「${project.name}」当前是「${PROJECT_STATUS_LABELS[project.status]}」，任务暂不能推进`);
    }

    const from = task.status;
    const to = nextStatus(from, args.action); // 非法流转在这里给中文原因
    const now = ctx.clock.now();
    const record = ctx.store.table('projectTasks').patch(task.id, { status: to, updatedAt: now });
    writeOutreachAudit(ctx, AUDIT_ACTIONS[args.action], {
      id: record.id, projectId: record.projectId, title: record.title,
      from, to, via: 'hub_task_update', botId: tc.botId,
    }, tc.botId, now);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    return {
      ok: true,
      text: `任务「${record.title}」已从「${TASK_STATUS_LABELS[from]}」变为「${TASK_STATUS_LABELS[to]}」${args.action === 'report_done' ? DONE_HINT : ''}。`,
    };
  });
