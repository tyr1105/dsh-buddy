/**
 * F12 派活 - 服务层测试（project/assign.ts）。
 * 覆盖：待办任务派给在岗队友后 todo→doing、队友写入任务、任务议程、主人发起唤醒候选、
 * 审计与 project 事件；以及归档/暂停项目、非待办任务、非成员队友、退役/不在岗队友、
 * 议程上限等反例与失败不耗 RNG。主人取消编制后，承接人直接是 botId，不再有席位。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { AgendaItemSchema, type AgendaItem } from '../src/model/bot.js';
import type { Bot } from '../src/model/bot.js';
import { botFixture } from './model-fixtures.js';
import {
  archiveProject, pauseProject, saveProject, saveTask,
} from '../src/project/service.js';
import { assignTask } from '../src/project/assign.js';

/** 派活相关审计。 */
function assignAudits(ctx: HubContext) {
  return ctx.store.log('audit').all().filter(a => a.action === 'task_assign');
}

/** 造一个队友档案；默认在岗，可指定生命周期用于反例。 */
function putBot(ctx: HubContext, id: string, name: string, lifecycle: Bot['lifecycle'] = 'active'): Bot {
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, id, name, lifecycle, homeDir: `/hub/bots/${id}`, createdAt: now, updatedAt: now };
  ctx.store.table('bots').put(bot);
  return bot;
}

/**
 * 标准环境：两个队友（一个项目成员、一个项目外队友）、一个进行中项目、一条待办任务。
 */
function setup(ctx: HubContext) {
  const bot = putBot(ctx, 'b_0000000002', '执行队友');
  const outsiderBot = putBot(ctx, 'b_0000000003', '外人');
  const project = saveProject(ctx, { name: '季度战役', memberBotIds: [bot.id] });
  const task = saveTask(ctx, { projectId: project.id, title: '写竞品报告', dueAt: 1_793_900_000_000 });
  return { bot, outsiderBot, project, task };
}

/** 直接塞一条打开议程（绕开服务层，只用于灌上限）。 */
function putAgenda(ctx: HubContext, n: number, botId: string): AgendaItem {
  const now = ctx.clock.now();
  const row = AgendaItemSchema.parse({
    id: `a_${String(n).padStart(10, '0')}`, botId, kind: 'task', title: `旧议程 ${n}`, goalId: null,
    dueAt: null, onEvent: null, abandonWhen: '测试清理', priority: 3, toOwner: false, source: 'bot',
    status: 'open', note: null, createdAt: now, updatedAt: now,
  });
  ctx.store.table('agenda').put(row);
  return row;
}

describe('F12 assignTask 正例', () => {
  it('派给在岗队友：任务 todo→doing、写入队友、建任务议程、排队主人唤醒、写审计与 project 事件', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);

    const assigned = assignTask(ctx, { taskId: task.id, botId: bot.id });
    expect(assigned.status).toBe('doing');
    expect(assigned.assigneeBotId).toBe(bot.id);

    // 议程：主人的任务议程，指向该任务，继承任务截止时间。
    const agenda = ctx.store.table('agenda').list(a => a.botId === bot.id);
    expect(agenda).toHaveLength(1);
    expect(agenda[0]).toMatchObject({
      kind: 'task', title: '项目任务：写竞品报告', source: 'owner', status: 'open',
      priority: 1, toOwner: false, dueAt: 1_793_900_000_000,
      abandonWhen: '任务通过验收、项目归档或主人撤回派活',
    });
    expect(agenda[0]!.note).toContain(`task:${task.id}`);
    expect(agenda[0]!.note).toContain(project.sharedDir);

    // 唤醒候选：复用 owner_message，主人发起，越过高门槛。
    const queue = ctx.store.table('queue').list(row => row.botId === bot.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ variant: 'regular', ownerInitiated: true });
    expect(queue[0]!.reason).toMatchObject({
      kind: 'owner_message', summary: '主人派活：写竞品报告', score: ctx.settings.c02.ownerSalience,
    });

    // 审计与事件。
    const audit = assignAudits(ctx)[0]!;
    expect(audit.actor).toBe('owner');
    expect(JSON.parse(audit.detail)).toMatchObject({
      id: task.id, projectId: project.id, title: '写竞品报告',
      botId: bot.id, agendaId: agenda[0]!.id, from: 'todo', to: 'doing',
    });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
    expect(ctx.events).toContainEqual({ scope: 'bot', botId: bot.id });
  });

  it('不传队友时沿用任务上已指派的队友', () => {
    const ctx = createTestContext();
    const { project, bot } = setup(ctx);
    const task = saveTask(ctx, { projectId: project.id, title: '复用队友', assigneeBotId: bot.id });
    const assigned = assignTask(ctx, { taskId: task.id });
    expect(assigned.assigneeBotId).toBe(bot.id);
    expect(assigned.status).toBe('doing');
    expect(ctx.store.table('agenda').count(a => a.botId === bot.id)).toBe(1);
  });
});

describe('F12 assignTask 反例', () => {
  it('项目已归档/已暂停 → 中文拒绝且任务保持待办', () => {
    const archivedCtx = createTestContext();
    const a = setup(archivedCtx);
    archiveProject(archivedCtx, a.project.id);
    expect(() => assignTask(archivedCtx, { taskId: a.task.id, botId: a.bot.id }))
      .toThrow('只有进行中的项目能派活');
    expect(archivedCtx.store.table('projectTasks').get(a.task.id)!.status).toBe('todo');

    const pausedCtx = createTestContext();
    const p = setup(pausedCtx);
    pauseProject(pausedCtx, p.project.id);
    expect(() => assignTask(pausedCtx, { taskId: p.task.id, botId: p.bot.id }))
      .toThrow('只有进行中的项目能派活');
  });

  it('任务不是待办 / 任务不存在 / 任务没有承接队友 → 中文拒绝', () => {
    const ctx = createTestContext();
    const { bot, task } = setup(ctx);
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    expect(() => assignTask(ctx, { taskId: task.id, botId: bot.id }))
      .toThrow('只有待办任务能派活');
    expect(() => assignTask(ctx, { taskId: 'pt_0000000099', botId: bot.id }))
      .toThrow('任务不存在');
    // 新建一条待办任务且不指派：不传队友时没有可沿用的承接人。
    const free = saveTask(ctx, { projectId: task.projectId, title: '没人接' });
    expect(() => assignTask(ctx, { taskId: free.id }))
      .toThrow('任务还没有承接队友');
  });

  it('队友不存在、已退役、不是项目成员 → 分别中文拒绝', () => {
    const ctx = createTestContext();
    const { outsiderBot, task } = setup(ctx);
    expect(() => assignTask(ctx, { taskId: task.id, botId: 'b_0000000099' }))
      .toThrow('队友不存在或已退役');
    const retired = putBot(ctx, 'b_0000000004', '退役队友', 'retired');
    expect(() => assignTask(ctx, { taskId: task.id, botId: retired.id }))
      .toThrow('队友不存在或已退役');
    expect(() => assignTask(ctx, { taskId: task.id, botId: outsiderBot.id }))
      .toThrow('不是项目成员');
  });

  it('队友不在岗（暂停）→ 中文拒绝', () => {
    const ctx = createTestContext();
    const { project, task } = setup(ctx);
    const paused = putBot(ctx, 'b_0000000004', '暂停队友', 'paused');
    // 直接加入成员名单，模拟队友在项目里但被暂停。
    ctx.store.table('projects').patch(project.id, { memberBotIds: [...project.memberBotIds, paused.id] });
    expect(() => assignTask(ctx, { taskId: task.id, botId: paused.id }))
      .toThrow('只有在岗或试岗的队友能接活');
  });

  it('队友未完成议程达上限 → 中文拒绝', () => {
    const ctx = createTestContext();
    const { bot, task } = setup(ctx);
    for (let i = 0; i < ctx.settings.maxOpenAgendaPerBot; i++) putAgenda(ctx, i + 1, bot.id);
    expect(() => assignTask(ctx, { taskId: task.id, botId: bot.id }))
      .toThrow(`未完成议程已达上限 ${ctx.settings.maxOpenAgendaPerBot} 条`);
    expect(ctx.store.table('projectTasks').get(task.id)!.status).toBe('todo');
  });

  it('失败不耗 RNG：失败后派活生成的议程 id 与对照环境一致', () => {
    const good = createTestContext();
    const bad = createTestContext();
    const g = setup(good);
    const b = setup(bad);
    // 在 bad 里先制造一次失败（队友不是项目成员），它不应消耗 RNG。
    expect(() => assignTask(bad, { taskId: b.task.id, botId: b.outsiderBot.id })).toThrow('不是项目成员');
    const goodTask = assignTask(good, { taskId: g.task.id, botId: g.bot.id });
    const badTask = assignTask(bad, { taskId: b.task.id, botId: b.bot.id });
    expect(badTask.id).toBe(goodTask.id);
    const goodAgenda = good.store.table('agenda').list()[0]!;
    const badAgenda = bad.store.table('agenda').list()[0]!;
    expect(badAgenda.id).toBe(goodAgenda.id);
  });
});
