/**
 * 项目负责人维护事务清单的工具（P60）：只有这个项目的负责人能用，L1 级别（试岗队友也能用）。
 *
 * 工具层只做一件事：把当前回合所在的主题交给服务层，让聊出来的事自动归到这个主题。
 * 身份只认宿主给的回合信息，模型在参数里传什么都改变不了「你是谁」。
 */
import { defineTool } from './common.js';
import { OwnerTaskUpsertSchema, upsertTaskByOwner } from '../project/owner-tasks.js';
import { TASK_STATUS_LABELS } from '../model/project.js';

export const hubProjectTaskUpsert = defineTool('hub_project_task_upsert',
  '（仅项目负责人）新建或更新项目事务清单：不传 taskId 是新建（title 必填），传了是更新；可设 assigneeBotId（跟进的成员）、status、topicId。建事务不会叫醒人，要谁动手在主题里 @ 他。成员改自己的事务用 hub_task_update。',
  OwnerTaskUpsertSchema, 'L1', (ctx, tc, args) => {
    const wake = tc.wakeId ? ctx.store.table('wakes').get(tc.wakeId) : null;
    const { task, created } = upsertTaskByOwner(ctx, tc.botId, args, wake?.topicId ?? null);
    const assignee = task.assigneeBotId ? ctx.store.table('bots').get(task.assigneeBotId)?.name ?? '已不在项目里' : '还没人跟进';
    return { ok: true, text: `已${created ? '新建' : '更新'}事务「${task.title}」（任务 ${task.id}，${assignee}，${TASK_STATUS_LABELS[task.status]}）。` };
  });
