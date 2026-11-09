/**
 * F12 派活 - 完整入口测试（project/dispatch.ts，任务卡 V2-PH4-03）。
 * 覆盖：
 * - 入参 zod（缺项、坏 id、多余字段、留言长度）；
 * - 新派 todo→doing、blocked/rejected→doing、同一队友催办、doing/blocked 改派；
 * - 议程复用/新建/旧议程 dropped、owner_message 线程消息与唤醒候选、task_dispatch 审计；
 * - 归档/暂停/完成项目、跨项目、终态/待验收、退役/非成员/不在岗、议程上限等反例；
 * - 失败不耗 RNG；projectView 表达承接队友。
 * 主人取消编制后，派活直接按队友 id，不再有席位。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { AgendaItemSchema, type AgendaItem } from '../src/model/bot.js';
import type { Bot } from '../src/model/bot.js';
import { botFixture } from './model-fixtures.js';
import { projectView } from '../src/api/project-views.js';
import {
  archiveProject, completeProject, pauseProject, saveProject, saveTask,
} from '../src/project/service.js';
import { dispatchTask } from '../src/project/dispatch.js';

/** 派活审计（不含 UiApi 自动审计 ui_dispatchTask）。 */
function dispatchAudits(ctx: HubContext) {
  return ctx.store.log('audit').all().filter(a => a.action === 'task_dispatch');
}

/** 某队友线程里的主人原话。 */
function ownerMessages(ctx: HubContext, botId: string) {
  return ctx.store.log('thread').all().filter(m => m.thread === botId && m.from === 'owner');
}

/** 某队友的打开任务议程。 */
function openTaskAgenda(ctx: HubContext, botId: string, taskId: string) {
  return ctx.store.table('agenda')
    .list(a => a.botId === botId && a.status === 'open' && (a.note?.includes(`task:${taskId}`) ?? false));
}

/** 造一个队友档案；默认在岗，可指定生命周期用于反例。 */
function putBot(ctx: HubContext, id: string, name: string, lifecycle: Bot['lifecycle'] = 'active'): Bot {
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, id, name, lifecycle, homeDir: `/hub/bots/${id}`, createdAt: now, updatedAt: now };
  ctx.store.table('bots').put(bot);
  return bot;
}

/**
 * 标准环境：一个进行中项目（两个在岗队友都是成员）、一个项目外队友、一条待办任务。
 */
function setup(ctx: HubContext) {
  const bot = putBot(ctx, 'b_0000000002', '执行队友');
  const bot2 = putBot(ctx, 'b_0000000003', '备选队友');
  const outsiderBot = putBot(ctx, 'b_0000000004', '外人');
  const project = saveProject(ctx, { name: '季度战役', memberBotIds: [bot.id, bot2.id] });
  const task = saveTask(ctx, { projectId: project.id, title: '写竞品报告', dueAt: 1_793_900_000_000 });
  return { bot, bot2, outsiderBot, project, task };
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

describe('F12 dispatchTask 入参校验', () => {
  it('缺少 projectId/taskId/botId 分别被拒', () => {
    const ctx = createTestContext();
    const { bot, task } = setup(ctx);
    expect(() => dispatchTask(ctx, { taskId: task.id, botId: bot.id })).toThrow('projectId');
    expect(() => dispatchTask(ctx, { projectId: task.projectId, botId: bot.id })).toThrow('taskId');
    expect(() => dispatchTask(ctx, { projectId: task.projectId, taskId: task.id })).toThrow('botId');
  });

  it('id 形状不对、多余字段、留言超长分别被中文拒绝', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    expect(() => dispatchTask(ctx, { projectId: 'prj_bad', taskId: task.id, botId: bot.id }))
      .toThrow('prj_ 加 10 位');
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id, extra: 1 }))
      .toThrow();
    expect(() => dispatchTask(ctx, {
      projectId: project.id, taskId: task.id, botId: bot.id, note: '长'.repeat(501),
    })).toThrow('派活留言不能超过 500 字');
  });
});

describe('F12 dispatchTask 正例', () => {
  it('待办派活：todo→doing、建议程（不到期）、线程原话、owner_message 候选、审计与事件', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);

    const record = dispatchTask(ctx, {
      projectId: project.id, taskId: task.id, botId: bot.id, note: '先出大纲',
    });
    expect(record.status).toBe('doing');
    expect(record.assigneeBotId).toBe(bot.id);
    expect(record.updatedAt).toBe(ctx.clock.now());

    // 议程：主人任务议程，指向该任务；派活议程不设到期闹钟。
    const agendas = ctx.store.table('agenda').list(a => a.botId === bot.id);
    expect(agendas).toHaveLength(1);
    expect(agendas[0]).toMatchObject({
      kind: 'task', title: '项目任务：写竞品报告', source: 'owner', status: 'open',
      priority: 1, toOwner: false, dueAt: null,
      abandonWhen: '任务通过验收、项目归档或主人撤回派活',
    });
    expect(agendas[0]!.note).toContain(`task:${task.id}`);
    expect(agendas[0]!.note).toContain(project.sharedDir);
    expect(agendas[0]!.note).toContain('主人留言：先出大纲');

    // 线程里留主人原话，候选复用 owner_message，不新增 WakeKind。
    const messages = ownerMessages(ctx, bot.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('写竞品报告');
    expect(messages[0]!.text).toContain('先出大纲');
    const queue = ctx.store.table('queue').list(q => q.botId === bot.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ variant: 'regular', ownerInitiated: true });
    expect(queue[0]!.reason.kind).toBe('owner_message');

    // 审计完整记录本次派活事实。
    const audit = dispatchAudits(ctx)[0]!;
    expect(audit.actor).toBe('owner');
    expect(JSON.parse(audit.detail)).toMatchObject({
      id: task.id, projectId: project.id, taskId: task.id, title: '写竞品报告',
      botId: bot.id, agendaId: agendas[0]!.id, messageId: messages[0]!.id,
      from: 'todo', to: 'doing', renudge: false, reassigned: false,
      reusedAgenda: false, droppedAgendaIds: [], note: '先出大纲',
    });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
  });

  it('不带留言：议程备注无留言段、消息无「留言：」、审计 note 为 null', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    const agenda = ctx.store.table('agenda').list(a => a.botId === bot.id)[0]!;
    expect(agenda.note).not.toContain('主人留言');
    expect(ownerMessages(ctx, bot.id)[0]!.text).not.toContain('留言：');
    expect(JSON.parse(dispatchAudits(ctx)[0]!.detail).note).toBeNull();
  });

  it('受阻任务重新派出：blocked→doing；被驳回（历史瞬时态）也能回流 doing', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    ctx.store.table('projectTasks').patch(task.id, { status: 'blocked' });
    const resumed = dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    expect(resumed.status).toBe('doing');
    expect(JSON.parse(dispatchAudits(ctx)[0]!.detail)).toMatchObject({ from: 'blocked', to: 'doing' });

    const ctx2 = createTestContext();
    const f = setup(ctx2);
    ctx2.store.table('projectTasks').patch(f.task.id, { status: 'rejected' });
    const reworked = dispatchTask(ctx2, { projectId: f.project.id, taskId: f.task.id, botId: f.bot.id });
    expect(reworked.status).toBe('doing');
    expect(JSON.parse(dispatchAudits(ctx2)[0]!.detail)).toMatchObject({ from: 'rejected', to: 'doing' });
  });

  it('进行中同一队友再派=催办：状态不变、复用议程不新建、再发一条主人消息与候选、renudge=true', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    const first = dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    const firstAgendaId = ctx.store.table('agenda').list(a => a.botId === bot.id)[0]!.id;

    const again = dispatchTask(ctx, {
      projectId: project.id, taskId: task.id, botId: bot.id, note: '今天下班前给我',
    });
    expect(again.status).toBe('doing');
    expect(again.updatedAt).toBe(first.updatedAt); // 状态与队友都没变，任务行不产生新时间戳
    const agendas = ctx.store.table('agenda').list(a => a.botId === bot.id);
    expect(agendas).toHaveLength(1);
    expect(agendas[0]!.id).toBe(firstAgendaId);
    expect(openTaskAgenda(ctx, bot.id, task.id)).toHaveLength(1);
    const messages = ownerMessages(ctx, bot.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toContain('催一下');
    expect(messages[1]!.text).toContain('今天下班前给我');
    // 队列按 bot 合并：单测里没有调度放行，第二次候选并入同一行、证据变成两条。
    const queued = ctx.store.table('queue').list(q => q.botId === bot.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason.evidence).toHaveLength(2);

    const detail = JSON.parse(dispatchAudits(ctx)[1]!.detail);
    expect(detail).toMatchObject({
      from: 'doing', to: 'doing', renudge: true, reassigned: false,
      reusedAgenda: true, droppedAgendaIds: [], agendaId: firstAgendaId,
    });
    expect(detail.messageId).toBe(messages[1]!.id);
  });

  it('进行中改派：旧队友议程 dropped、新队友建议程、任务换人、reassigned=true', () => {
    const ctx = createTestContext();
    const { bot, bot2, project, task } = setup(ctx);
    dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    const oldAgendaId = ctx.store.table('agenda').list(a => a.botId === bot.id)[0]!.id;

    const moved = dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot2.id });
    expect(moved.status).toBe('doing');
    expect(moved.assigneeBotId).toBe(bot2.id);

    // 旧队友的打开议程被标 dropped，新队友有一条新的打开议程，且不带到期闹钟。
    const oldAgenda = ctx.store.table('agenda').get(oldAgendaId)!;
    expect(oldAgenda.status).toBe('dropped');
    const newAgendas = openTaskAgenda(ctx, bot2.id, task.id);
    expect(newAgendas).toHaveLength(1);
    expect(newAgendas[0]).toMatchObject({ source: 'owner', dueAt: null });

    // 唤醒候选只给新队友；线程原话也在新队友线程里。
    expect(ctx.store.table('queue').list(q => q.botId === bot.id)).toHaveLength(1); // 首次派活那条
    expect(ctx.store.table('queue').list(q => q.botId === bot2.id)).toHaveLength(1);
    expect(ownerMessages(ctx, bot2.id)[0]!.text).toContain('改派');

    const detail = JSON.parse(dispatchAudits(ctx)[1]!.detail);
    expect(detail).toMatchObject({
      from: 'doing', to: 'doing', renudge: false, reassigned: true,
      reusedAgenda: false, botId: bot2.id,
      droppedAgendaIds: [oldAgendaId],
    });
  });

  it('受阻任务改派：旧议程同样 dropped，任务恢复 doing 并换人', () => {
    const ctx = createTestContext();
    const { bot, bot2, project, task } = setup(ctx);
    dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    ctx.store.table('projectTasks').patch(task.id, { status: 'blocked' });
    const moved = dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot2.id });
    expect(moved.status).toBe('doing');
    expect(moved.assigneeBotId).toBe(bot2.id);
    expect(ctx.store.table('agenda').list(a => a.botId === bot.id)[0]!.status).toBe('dropped');
    expect(openTaskAgenda(ctx, bot2.id, task.id)).toHaveLength(1);
  });
});

describe('F12 dispatchTask 反例', () => {
  it('任务不存在 / 项目与任务不匹配（跨项目派活）→ 中文拒绝', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    const other = saveProject(ctx, { name: '另一个项目', memberBotIds: [bot.id] });
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: 'pt_0000000099', botId: bot.id }))
      .toThrow('任务不存在');
    expect(() => dispatchTask(ctx, { projectId: other.id, taskId: task.id, botId: bot.id }))
      .toThrow('任务不属于该项目');
  });

  it('归档/暂停/完成项目都拒绝，任务保持原状且不产生议程消息', () => {
    for (const flip of ['archived', 'paused', 'done'] as const) {
      const ctx = createTestContext();
      const f = setup(ctx);
      if (flip === 'archived') archiveProject(ctx, f.project.id);
      else if (flip === 'paused') pauseProject(ctx, f.project.id);
      else completeProject(ctx, f.project.id);
      expect(() => dispatchTask(ctx, { projectId: f.project.id, taskId: f.task.id, botId: f.bot.id }))
        .toThrow('只有进行中的项目能派活');
      expect(ctx.store.table('projectTasks').get(f.task.id)!.status).toBe('todo');
      expect(dispatchAudits(ctx)).toHaveLength(0);
      expect(ownerMessages(ctx, f.bot.id)).toHaveLength(0);
    }
  });

  it('已通过终态、待验收中 → 中文拒绝且状态不变', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    ctx.store.table('projectTasks').patch(task.id, { status: 'accepted' });
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id }))
      .toThrow('已通过验收，是终态');

    const ctx2 = createTestContext();
    const f = setup(ctx2);
    ctx2.store.table('projectTasks').patch(f.task.id, { status: 'done_pending_check' });
    expect(() => dispatchTask(ctx2, { projectId: f.project.id, taskId: f.task.id, botId: f.bot.id }))
      .toThrow('正在待验收');
    expect(ctx2.store.table('projectTasks').get(f.task.id)!.status).toBe('done_pending_check');
  });

  it('队友不存在、已退役、不是项目成员 → 分别中文拒绝', () => {
    const ctx = createTestContext();
    const { outsiderBot, project, task } = setup(ctx);
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: 'b_0000000099' }))
      .toThrow('队友不存在或已退役');
    const retired = putBot(ctx, 'b_0000000005', '退役队友', 'retired');
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: retired.id }))
      .toThrow('队友不存在或已退役');
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: outsiderBot.id }))
      .toThrow('不是项目成员');
  });

  it('队友不在岗（暂停）→ 中文拒绝', () => {
    const ctx = createTestContext();
    const { project, task } = setup(ctx);
    const paused = putBot(ctx, 'b_0000000005', '暂停队友', 'paused');
    ctx.store.table('projects').patch(project.id, { memberBotIds: [...project.memberBotIds, paused.id] });
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: paused.id }))
      .toThrow('只有在岗或试岗的队友能接活');
  });

  it('议程上限：新派与改派被拦，催办（复用议程）不拦', () => {
    const ctx = createTestContext();
    const { bot, bot2, project, task } = setup(ctx);
    for (let i = 0; i < ctx.settings.maxOpenAgendaPerBot; i++) putAgenda(ctx, i + 1, bot.id);
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id }))
      .toThrow(`未完成议程已达上限 ${ctx.settings.maxOpenAgendaPerBot} 条`);
    expect(ctx.store.table('projectTasks').get(task.id)!.status).toBe('todo');

    // 备选队友先接住任务；再灌满备选队友名额，第二条任务派不进去。
    dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot2.id });
    for (let i = 0; i < ctx.settings.maxOpenAgendaPerBot - 1; i++) {
      putAgenda(ctx, 100 + i, bot2.id);
    }
    const another = saveTask(ctx, { projectId: project.id, title: '第二条任务' });
    expect(() => dispatchTask(ctx, { projectId: project.id, taskId: another.id, botId: bot2.id }))
      .toThrow('未完成议程已达上限');
    expect(ctx.store.table('projectTasks').get(another.id)!.status).toBe('todo');

    // 催办复用已有议程，不再占名额，满额也能催。
    const nudge = dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot2.id });
    expect(nudge.status).toBe('doing');
    const lastAudit = JSON.parse(dispatchAudits(ctx).at(-1)!.detail);
    expect(lastAudit.renudge).toBe(true);
  });

  it('失败不耗 RNG：先失败后成功，议程/消息/审计 id 与干净环境一致', () => {
    const good = createTestContext();
    const bad = createTestContext();
    const g = setup(good);
    const b = setup(bad);
    // bad 先制造一次失败（队友不是项目成员），不应消耗任何 RNG。
    expect(() => dispatchTask(bad, { projectId: b.project.id, taskId: b.task.id, botId: b.outsiderBot.id }))
      .toThrow('不是项目成员');
    dispatchTask(good, { projectId: g.project.id, taskId: g.task.id, botId: g.bot.id });
    dispatchTask(bad, { projectId: b.project.id, taskId: b.task.id, botId: b.bot.id });

    const gd = JSON.parse(dispatchAudits(good)[0]!.detail);
    const bd = JSON.parse(dispatchAudits(bad)[0]!.detail);
    expect(bd.agendaId).toBe(gd.agendaId);
    expect(bd.messageId).toBe(gd.messageId);
    expect(dispatchAudits(bad)[0]!.id).toBe(dispatchAudits(good)[0]!.id);
  });
});

describe('F12 dispatchTask 视图表达', () => {
  it('projectView 任务行给出承接队友 id 与名字；没人接给 null', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    dispatchTask(ctx, { projectId: project.id, taskId: task.id, botId: bot.id });
    const vacant = saveTask(ctx, { projectId: project.id, title: '没人接的活' });

    const row = projectView(ctx).projects.find(p => p.project.id === project.id)!;
    const doing = row.tasks.find(t => t.task.id === task.id)!;
    expect(doing.assigneeBotId).toBe(bot.id);
    expect(doing.assigneeBotName).toBe('执行队友');
    const empty = row.tasks.find(t => t.task.id === vacant.id)!;
    expect(empty.assigneeBotId).toBeNull();
    expect(empty.assigneeBotName).toBeNull();
  });
});
