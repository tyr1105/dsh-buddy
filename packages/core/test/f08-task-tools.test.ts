/**
 * F08 队友侧任务工具（尾巴批次八）——hub_task_list / hub_task_update 测试。
 * 覆盖：清单只看自己名下的任务、排除已通过与归档项目；推进三动作走状态机；
 * 越权（别人的任务）、暂停/完成/归档项目、L0、反思回合、交账后一律拒绝；
 * 审计 actor 记真实 botId、写后发 project 事件；非法动作与 id 前缀给中文错误。
 * 主人取消编制后，任务归属按 assigneeBotId 判断，不再有席位。
 */
import { describe, expect, it } from 'vitest';
import { toolFixture } from './c03-tool-fixtures.js';
import { runTool } from '../src/tools/index.js';
import { ProjectSchema, ProjectTaskSchema } from '../src/model/project.js';
import type { HubContext } from '../src/engine/context.js';
import type { ProjectStatus, TaskStatus } from '../src/model/project.js';
import { id } from './model-fixtures.js';

/** 放一个项目；默认进行中，负责人与成员都是当前队友。 */
function putProject(ctx: HubContext, botId: string, status: ProjectStatus = 'active', suffix = '001') {
  const now = ctx.clock.now();
  const project = ProjectSchema.parse({
    id: `prj_0000000${suffix}`, name: `项目 ${suffix}`, charter: '', status,
    ownerBotId: botId, memberBotIds: [botId],
    sharedDir: `/hub/projects/prj_0000000${suffix}/`, acceptanceCriteria: [],
    createdAt: now, updatedAt: now, archivedAt: status === 'archived' ? now : null,
  });
  ctx.store.table('projects').put(project);
  return project;
}

/** 放一条任务；默认进行中、指派给当前队友。 */
function putTask(
  ctx: HubContext, n: number,
  over: { status?: TaskStatus; assigneeBotId?: string | null; projectId?: string } = {},
) {
  const now = ctx.clock.now();
  const task = ProjectTaskSchema.parse({
    id: `pt_${String(n).padStart(10, '0')}`, projectId: over.projectId ?? 'prj_0000000001',
    title: `任务 ${n}`, detail: '按验收口径交付',
    assigneeBotId: over.assigneeBotId === undefined ? 'b_0000000001' : over.assigneeBotId,
    status: over.status ?? 'doing', wakeIds: [], artifactIds: [],
    createdAt: now, updatedAt: now, dueAt: null,
  });
  ctx.store.table('projectTasks').put(task);
  return task;
}

/** 标准环境：进行中项目与一条指派给自己的进行中任务。 */
function taskFixture() {
  const f = toolFixture();
  const project = putProject(f.ctx, f.bot.id);
  const task = putTask(f.ctx, 1);
  return { ...f, project, task };
}

describe('F08 hub_task_list', () => {
  it('只列自己名下未结束的任务：排除已通过、别人的任务与归档项目', async () => {
    const { ctx, tc } = taskFixture();
    putTask(ctx, 2, { status: 'blocked' });
    putTask(ctx, 3, { status: 'done_pending_check' });
    putTask(ctx, 4, { status: 'accepted' });
    // 另一个队友承接的任务不该出现。
    putTask(ctx, 5, { assigneeBotId: 'b_0000000002' });
    // 归档项目里的任务不列。
    putProject(ctx, 'b_0000000001', 'archived', '002');
    putTask(ctx, 6, { projectId: 'prj_0000000002' });

    const result = await runTool(ctx, tc, 'hub_task_list', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('任务 1');
    expect(result.text).toContain('任务 2');
    expect(result.text).toContain('任务 3');
    expect(result.text).not.toContain('任务 4');
    expect(result.text).not.toContain('任务 5');
    expect(result.text).not.toContain('任务 6');
    expect(result.text).toContain('待验收');
  });

  it('没有任务或只剩已通过任务时给中文空态，不报错', async () => {
    const empty = toolFixture();
    expect(await runTool(empty.ctx, empty.tc, 'hub_task_list', {}))
      .toMatchObject({ ok: true, text: expect.stringContaining('没有未结束的项目任务') });

    const { ctx, tc } = taskFixture();
    ctx.store.table('projectTasks').patch('pt_0000000001', { status: 'accepted' });
    expect(await runTool(ctx, tc, 'hub_task_list', {})).toMatchObject({ ok: true, text: expect.stringContaining('没有未结束') });
  });

  it('只读：L0 与反思回合都可调用', async () => {
    const { ctx, tc, bot, wake } = taskFixture();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    expect((await runTool(ctx, tc, 'hub_task_list', {})).ok).toBe(true);
    ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    expect((await runTool(ctx, tc, 'hub_task_list', {})).ok).toBe(true);
  });
});

describe('F08 hub_task_update 正常推进', () => {
  it('block：进行中→受阻，审计 actor 是队友，写后发 project 事件', async () => {
    const { ctx, tc, bot, task } = taskFixture();
    const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('受阻');
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('blocked');

    const audit = ctx.store.log('audit').all().find(a => a.action === 'task_block')!;
    expect(audit.actor).toBe(bot.id);
    expect(JSON.parse(audit.detail)).toMatchObject({
      id: task.id, from: 'doing', to: 'blocked', via: 'hub_task_update', botId: bot.id,
    });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
  });

  it('resume：受阻→进行中', async () => {
    const { ctx, tc, task } = taskFixture();
    ctx.store.table('projectTasks').patch(task.id, { status: 'blocked' });
    const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'resume' });
    expect(result.ok).toBe(true);
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('doing');
  });

  it('report_done：进行中→待验收，并提醒还没算完成', async () => {
    const { ctx, tc, task } = taskFixture();
    const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'report_done' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('待验收');
      expect(result.text).toContain('等主人验收');
    }
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('done_pending_check');
    expect(ctx.store.log('audit').all().some(a => a.action === 'task_report_done')).toBe(true);
  });
});

describe('F08 hub_task_update 拒绝越权与不可推进', () => {
  it('任务不属于当前队友：拒绝且不改状态', async () => {
    const { ctx, tc, task } = taskFixture();
    // 把任务改派给另一个队友。
    ctx.store.table('projectTasks').patch(task.id, { assigneeBotId: 'b_0000000002' });
    const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('没有指派给你') });
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('doing');
  });

  it('项目暂停/完成/归档：一律拒绝，任务保持原状', async () => {
    const { ctx, tc, task } = taskFixture();
    for (const status of ['paused', 'done', 'archived'] as const) {
      ctx.store.table('projects').patch('prj_0000000001', { status, archivedAt: status === 'archived' ? ctx.clock.now() : null });
      const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('暂不能推进');
      expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('doing');
    }
  });

  it('L0 与反思回合不能推进任务', async () => {
    const { ctx, tc, bot, wake, task } = taskFixture();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('L0') });
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L2' });
    ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只读') });
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('doing');
  });

  it('交账后与待办任务：按回合边界与状态机拒绝', async () => {
    const { ctx, tc, task } = taskFixture();
    // 待办任务不能直接标记受阻（也不能被队友自行开始）。
    ctx.store.table('projectTasks').patch(task.id, { status: 'todo' });
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只能从「进行中」发起') });
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    // 交账后的回合不再允许写事项。
    const wakeId = id('w');
    const wake = ctx.store.table('wakes').list().find(w => w.id === wakeId)!;
    ctx.store.table('wakes').patch(wake.id, { status: 'committed', commitId: id('c') });
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'block' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('已结束') });
  });

  it('非法动作与错误 id 前缀给中文错误，不改任何任务', async () => {
    const { ctx, tc, task } = taskFixture();
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'accept' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('动作必须是') });
    expect(await runTool(ctx, tc, 'hub_task_update', { taskId: 'prj_0000000001', action: 'block' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('pt_') });
    expect(ctx.store.table('projectTasks').get(task.id)?.status).toBe('doing');
  });
});
