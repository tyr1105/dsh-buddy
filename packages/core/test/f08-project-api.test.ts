/**
 * F08 项目容器 - UI API 测试（api/project-views.ts + 命令注册）。
 * 覆盖：
 * - 空存档与旧档（FileStore 缺 projects.json/projectTasks.json）兼容：视图返回空结构不报错；
 * - projectView 是只读视图：不写审计；负责人/成员/任务/验收项展开、失效队友 issues、
 *   计数与进度、排序（非归档在前、归档沉底）、tasksPendingCheck、artifactCount 现存引用口径；
 * - 12 条项目/任务命令经统一 commandRunner：CommandResult、中文错误、ui_ 审计、project 事件。
 * 主人取消编制后，负责人/成员直接按队友展开；本卡没有「队友开始任务」命令（F12 派活才提供），
 * 测试里统一直接 patch 任务表为 doing 模拟队友开始。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import { FileStore } from '../src/store/index.js';
import { createUiApi } from '../src/api/index.js';
import { projectView } from '../src/api/project-views.js';
import { initRoot } from '../src/memory/files.js';
import { ArtifactHeadSchema, ArtifactVersionSchema } from '../src/model/artifact.js';
import { ProjectTaskSchema } from '../src/model/project.js';
import type { WakeLedgerEntry } from '../src/model/index.js';
import type { ProjectView } from '../src/api/types.js';
import { okData } from './c04-api-fixtures.js';

/** 界面测试出口：afterCommand 真实 flush，验证命令出口没有漏掉落盘。 */
async function apiSetup() {
  const ctx = createTestContext();
  await initRoot(ctx);
  const after = vi.fn(async () => { await ctx.store.flush(); });
  const api = createUiApi(ctx, after);
  return { ctx, api, after };
}

/** 建三个队友，返回 api 与队友档案，减少各用例重复搭建。 */
async function orgWithBots() {
  const setup = await apiSetup();
  const { api } = setup;
  const b1 = okData(await api.createBot({ name: '负责队友', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
  const b2 = okData(await api.createBot({ name: '成员队友', role: 'executor', persona: '执行', aspirations: ['持续执行'] }));
  const b3 = okData(await api.createBot({ name: '候补队友', role: 'executor', persona: '执行', aspirations: ['持续执行'] }));
  return { ...setup, b1, b2, b3 };
}

describe('F08 projectView 空存档与旧档兼容', () => {
  it('空内存存档：projects 为空、计数全 0、asOf 用注入时钟', async () => {
    const { api } = await apiSetup();
    const view: ProjectView = api.projectView();
    expect(view.projects).toEqual([]);
    expect(view.counts).toEqual({
      active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0,
    });
    expect(view.asOf).toBe(Date.parse('2026-11-05T10:00:00+08:00'));
  });

  it('只读视图不产生审计，连调两次审计条数不变', async () => {
    const { api, ctx } = await apiSetup();
    const before = ctx.store.log('audit').all().length;
    api.projectView();
    api.projectView();
    expect(ctx.store.log('audit').all().length).toBe(before);
  });

  it('旧存档没有项目两表文件：FileStore.load 后视图返回空，不报错', async () => {
    const fs = new MemoryFs(new FakeClock(Date.parse('2026-11-05T10:00:00+08:00')));
    const clock = new FakeClock(Date.parse('2026-11-05T10:00:00+08:00'));
    const fileStore = new FileStore(fs, clock, '/hub', 'Asia/Shanghai', new MemoryLogger());
    await fileStore.load(); // 缺 projects.json / projectTasks.json：自然空表
    const ctx = createTestContext({ store: fileStore });
    const view = projectView(ctx);
    expect(view.projects).toEqual([]);
    expect(view.counts.total).toBe(0);
    expect(view.counts.tasksTotal).toBe(0);
  });

  it('文件存储往返：经 API 建项目与任务并 flush，新 FileStore load 后两表都读得回', async () => {
    const fs = new MemoryFs(new FakeClock(Date.parse('2026-11-05T10:00:00+08:00')));
    const clock = new FakeClock(Date.parse('2026-11-05T10:00:00+08:00'));
    const fileStore = new FileStore(fs, clock, '/hub', 'Asia/Shanghai', new MemoryLogger());
    await fileStore.load();
    const ctx = createTestContext({ store: fileStore });
    const api = createUiApi(ctx, vi.fn(async () => { await ctx.store.flush(); }));
    const project = okData(await api.saveProject({ name: '文件档项目', memberBotIds: [] }));
    okData(await api.saveTask({ projectId: project.id, title: '文件档任务' }));

    const restored = new FileStore(fs, clock, '/hub', 'Asia/Shanghai', new MemoryLogger());
    await restored.load();
    const ctx2 = createTestContext({ store: restored });
    const view = projectView(ctx2);
    expect(view.counts).toMatchObject({ total: 1, active: 1, tasksTotal: 1 });
    expect(view.projects[0]!.project.name).toBe('文件档项目');
    expect(view.projects[0]!.tasks[0]!.task.title).toBe('文件档任务');
  });
});

describe('F08 项目视图组装', () => {
  it('P34 两层只读投影：原始版本只读且与队友项目版本共用同一目录，愿景与约定照实展开', async () => {
    const { api } = await orgWithBots();
    const project = okData(await api.saveProject({
      name: '两层项目', memberBotIds: [], vision: '让团队自己跑起来', conventions: '先写验收再动手',
    }));
    const row = api.projectView().projects.find(r => r.project.id === project.id)!;
    expect(row.layers.original).toEqual({ readOnly: true, workspaceDir: project.sharedDir });
    expect(row.layers.team).toMatchObject({
      readOnly: false, vision: '让团队自己跑起来', conventions: '先写验收再动手',
      memberCount: 0, sharedDir: project.sharedDir, criterionCount: 0,
    });
  });

  it('旧项目没有愿景与约定字段：两层投影按空串兼容，不报错', async () => {
    const { api, ctx } = await apiSetup();
    const project = okData(await api.saveProject({ name: '旧形状', memberBotIds: [] }));
    // 直接把记录改成旧形状（字段缺失），模拟迁移前的历史数据被视图读到。
    const legacy = { ...project } as Record<string, unknown>;
    delete legacy.vision;
    delete legacy.conventions;
    ctx.store.table('projects').put(legacy as never);
    const row = api.projectView().projects.find(r => r.project.id === project.id)!;
    expect(row.layers.team.vision).toBe('');
    expect(row.layers.team.conventions).toBe('');
  });

  it('负责人/成员队友展开：队友名字与失效标记，验收项状态照实展开', async () => {
    const t = await orgWithBots();
    const { api, b1, b2 } = t;
    const created = okData(await api.saveProject({
      name: 'P', ownerBotId: b1.id, memberBotIds: [b1.id, b2.id],
      acceptanceCriteria: [{ text: '交付报告', verify: '主人看过' }],
    }));
    // 新增验收项一律从 open 开始；主人勾选要带 id 再保存一次。
    const criterionId = created.acceptanceCriteria[0]!.id;
    const project = okData(await api.saveProject({
      id: created.id, name: 'P', ownerBotId: b1.id, memberBotIds: [b1.id, b2.id],
      acceptanceCriteria: [{ id: criterionId, text: '交付报告', verify: '主人看过', status: 'met' }],
    }));

    const row = api.projectView().projects.find(r => r.project.id === project.id)!;
    expect(row.ownerBotId).toBe(b1.id);
    expect(row.ownerName).toBe('负责队友');
    expect(row.ownerInvalid).toBe(false);
    expect(row.members).toMatchObject([
      { botId: b1.id, name: '负责队友', invalid: false },
      { botId: b2.id, name: '成员队友', invalid: false },
    ]);
    // 验收项展开中文状态标签。
    expect(row.criteria[0]).toMatchObject({ text: '交付报告', status: 'met', statusLabel: '已满足' });
    expect(row.issues).toEqual([]);
  });

  it('失效队友：负责人档案缺失、成员与任务指派人退役后 invalid 为 true 并给具体 issues', async () => {
    const t = await orgWithBots();
    const { api, ctx, b1, b2, b3 } = t;
    const ownerProject = okData(await api.saveProject({ name: '负责失效', ownerBotId: b3.id, memberBotIds: [b3.id] }));
    const project = okData(await api.saveProject({ name: '成员失效', memberBotIds: [b1.id, b2.id] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: '派给队友乙', assigneeBotId: b2.id }));
    ctx.store.table('bots').remove(b3.id); // 档案缺失：负责人名字查不到
    okData(await api.setLifecycle(b2.id, 'retired')); // 退役：档案还在，名字照实显示

    const view = api.projectView();
    const ownerRow = view.projects.find(r => r.project.id === ownerProject.id)!;
    expect(ownerRow.ownerName).toBeNull();
    expect(ownerRow.ownerInvalid).toBe(true);
    expect(ownerRow.issues.some(i => i.code === 'owner_bot_invalid' && i.level === 'error')).toBe(true);

    const row = view.projects.find(r => r.project.id === project.id)!;
    const member = row.members.find(m => m.botId === b2.id)!;
    expect(member.invalid).toBe(true);
    expect(member.name).toBe('成员队友');
    expect(row.issues.some(i => i.code === 'member_bot_invalid')).toBe(true);
    const taskRow = row.tasks.find(x => x.task.id === task.id)!;
    expect(taskRow.assigneeInvalid).toBe(true);
    expect(taskRow.assigneeBotName).toBe('成员队友');
    expect(row.issues.some(i => i.code === 'task_assignee_invalid')).toBe(true);
  });

  it('任务计数、进度、中文状态标签与待验收计数', async () => {
    const { api, ctx, b1 } = await orgWithBots();
    const project = okData(await api.saveProject({ name: 'P', memberBotIds: [b1.id] }));
    const t1 = okData(await api.saveTask({ projectId: project.id, title: '进行中', assigneeBotId: b1.id }));
    const t2 = okData(await api.saveTask({ projectId: project.id, title: '待验收' }));
    okData(await api.saveTask({ projectId: project.id, title: '已通过' }));
    const tasks = ctx.store.table('projectTasks');
    tasks.patch(t1.id, { status: 'doing' });
    tasks.patch(t2.id, { status: 'done_pending_check' });
    tasks.patch(tasks.list()[2]!.id, { status: 'accepted' });

    const view = api.projectView();
    expect(view.counts.tasksTotal).toBe(3);
    expect(view.counts.tasksPendingCheck).toBe(1);
    const row = view.projects[0]!;
    expect(row.taskCounts).toMatchObject({ doing: 1, done_pending_check: 1, accepted: 1, total: 3 });
    expect(row.progress).toBeCloseTo(1 / 3, 10);
    const labels = Object.fromEntries(row.tasks.map(x => [x.task.title, x.statusLabel]));
    expect(labels).toMatchObject({ 进行中: '进行中', 待验收: '待验收', 已通过: '已通过' });
  });

  it('排序：非归档项目在前、归档沉底；项目内任务按状态分组排序', async () => {
    const { api, ctx } = await apiSetup();
    const archived = okData(await api.saveProject({ name: '归档项', memberBotIds: [] }));
    const live = okData(await api.saveProject({ name: '在跑项', memberBotIds: [] }));
    okData(await api.archiveProject(archived.id));
    // 在跑项里倒序灌三条任务，视图应 doing 在前、todo 居中、accepted 沉底。
    const now = ctx.clock.now();
    const mk = (id: string, title: string, status: 'todo' | 'doing' | 'accepted', createdAt: number) =>
      ProjectTaskSchema.parse({
        id, projectId: live.id, title, detail: '', assigneeBotId: null,
        status, wakeIds: [], artifactIds: [], createdAt, updatedAt: now, dueAt: null,
      });
    ctx.store.table('projectTasks').put(mk('pt_0000000001', '已通过', 'accepted', 100));
    ctx.store.table('projectTasks').put(mk('pt_0000000002', '待办', 'todo', 200));
    ctx.store.table('projectTasks').put(mk('pt_0000000003', '进行中', 'doing', 300));

    const view = api.projectView();
    expect(view.projects.map(r => r.project.id)).toEqual([live.id, archived.id]);
    const row = view.projects[0]!;
    expect(row.tasks.map(x => x.task.title)).toEqual(['进行中', '待办', '已通过']);
  });

  it('已完成项目仍有未通过任务：视图给 done_with_open_tasks 并点名任务', async () => {
    const { api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '收工项目', memberBotIds: [] }));
    okData(await api.saveTask({ projectId: project.id, title: '没做完的尾巴' }));
    okData(await api.completeProject(project.id));
    const row = api.projectView().projects[0]!;
    expect(row.statusLabel).toBe('已完成');
    const issue = row.issues.find(i => i.code === 'done_with_open_tasks');
    expect(issue).toBeDefined();
    expect(issue!.text).toContain('没做完的尾巴');
  });

  it('归档项目：issues 清空、仍在列表归档区、任务不丢', async () => {
    const { api } = await apiSetup();
    const project = okData(await api.saveProject({ name: 'P', memberBotIds: [] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: 't' }));
    okData(await api.archiveProject(project.id));
    const view = api.projectView();
    expect(view.counts).toMatchObject({ archived: 1, active: 0, total: 1 });
    const row = view.projects[0]!;
    expect(row.issues).toEqual([]);
    expect(row.tasks.map(x => x.task.id)).toEqual([task.id]);
  });
});

describe('F08 artifactCount 现存引用口径', () => {
  it('任务 artifactIds 命中产物头或版本 id 才计数，悬空 id 不计', async () => {
    const { api, ctx } = await apiSetup();
    const project = okData(await api.saveProject({ name: 'P', memberBotIds: [] }));
    const now = ctx.clock.now();
    ctx.store.table('artifactHeads').put(ArtifactHeadSchema.parse({
      id: 'ah_existing', botId: 'b_test', sourcePath: '/hub/artifacts/a.md',
      lastVersion: 1, createdAt: now, updatedAt: now,
    }));
    ctx.store.table('artifactVersions').put(ArtifactVersionSchema.parse({
      id: 'av_existing', artifactId: 'ah_existing', botId: 'b_test', number: 1,
      title: 'A', sourcePath: '/hub/artifacts/a.md', realPath: '/hub/artifacts/a.md',
      visibility: 'owner', content: '正文', bytes: 2, sha256: 'a'.repeat(64),
      commitId: 'cm_test', wakeId: 'wk_test', goalIds: [], createdAt: now,
    }));
    const mkTask = (id: string, artifactIds: string[]) => ProjectTaskSchema.parse({
      id, projectId: project.id, title: id, detail: '', assigneeBotId: null,
      status: 'todo', wakeIds: [], artifactIds, createdAt: now, updatedAt: now, dueAt: null,
    });
    ctx.store.table('projectTasks').put(mkTask('pt_0000000001', ['ah_existing', 'ah_missing']));
    ctx.store.table('projectTasks').put(mkTask('pt_0000000002', ['av_existing']));
    ctx.store.table('projectTasks').put(mkTask('pt_0000000003', []));

    const rows = api.projectView().projects[0]!.tasks;
    expect(rows.find(r => r.task.id === 'pt_0000000001')!.artifactCount).toBe(1);
    expect(rows.find(r => r.task.id === 'pt_0000000002')!.artifactCount).toBe(1);
    expect(rows.find(r => r.task.id === 'pt_0000000003')!.artifactCount).toBe(0);
  });
});

describe('F08 task wake links（任务行关联唤醒）', () => {
  /** 账本工厂：默认已封存、感知触发、主人理由可读；与 f03 办公室测试同一口径。 */
  function ledger(wakeId: string, botId: string, openedAt: number, partial: Partial<WakeLedgerEntry> = {}): WakeLedgerEntry {
    const suffix = wakeId.replace(/^w_/, '');
    return {
      id: `wl_${suffix}`, wakeId, botId, sessionId: null, variant: 'regular', status: 'committed',
      source: 'live', completeness: 'full', missing: [], openedAt, sealedAt: openedAt + 60_000,
      trigger: {
        kind: 'percept', score: 0.8, threshold: 0.6, summary: '给机器人看的摘要',
        ownerSummary: '给主人看的理由', ownerInitiated: false, subjectKey: null, queueWaitMs: null, evidenceRefs: [],
      },
      evidence: { items: [] },
      decision: { outcome: 'progress', summary: '有进展', blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: null },
      actions: { items: [] },
      result: { verification: null, worldChanges: [], refs: [], summary: null },
      steps: 3, tokens: 1000, truncated: false, bytes: 100,
      ...partial,
    };
  }

  /** 建一个带任务的项目，任务 wakeIds 直接补进任务表（F12 前派活服务还不存在）。 */
  async function taskWithWakes(wakeIds: string[]) {
    const setup = await apiSetup();
    const { api, ctx } = setup;
    const project = okData(await api.saveProject({ name: 'P', memberBotIds: [] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: 't' }));
    ctx.store.table('projectTasks').patch(task.id, { wakeIds });
    return { ...setup, project, task };
  }

  it('账本在：链接带队友名、账本 id、中文标签与主人理由，时间给可读文本', async () => {
    const { api, ctx, task } = await taskWithWakes([]);
    const bot = okData(await api.createBot({ name: '小观', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
    ctx.store.table('wakeLedger').put(ledger('w_0000000001', bot.id, ctx.clock.now() - 60_000));
    ctx.store.table('projectTasks').patch(task.id, { wakeIds: ['w_0000000001'] });

    const row = api.projectView().projects[0]!.tasks.find(x => x.task.id === task.id)!;
    expect(row.wakes).toHaveLength(1);
    expect(row.wakes[0]).toMatchObject({
      wakeId: 'w_0000000001', botId: bot.id, botName: '小观', ledgerId: 'wl_0000000001',
      // 标签一律取账本词表：常规 / 已交账 / 感知。
      variantLabel: '常规', statusLabel: '已交账', triggerLabel: '感知',
      // 给主人看的理由优先于给机器人看的摘要。
      summary: '给主人看的理由',
    });
    expect(row.wakes[0]!.openedAt).toBe(ctx.clock.now() - 60_000);
    expect(row.wakes[0]!.openedText).toBeTruthy();
  });

  it('账本查不到：保留 wakeId，其余全 null，界面据此禁用', async () => {
    const { api, task } = await taskWithWakes(['w_0000000009']);
    const row = api.projectView().projects[0]!.tasks.find(x => x.task.id === task.id)!;
    expect(row.wakes).toEqual([{
      wakeId: 'w_0000000009', botId: null, botName: null, ledgerId: null,
      variantLabel: null, statusLabel: null, triggerLabel: null, summary: null,
      openedAt: null, openedText: null,
    }]);
  });

  it('队友已删除：账本与 botId 保留、botName 为 null（右栏打不开）', async () => {
    const { api, ctx, task } = await taskWithWakes([]);
    const bot = okData(await api.createBot({ name: '将退役', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
    ctx.store.table('wakeLedger').put(ledger('w_0000000002', bot.id, ctx.clock.now() - 60_000));
    ctx.store.table('projectTasks').patch(task.id, { wakeIds: ['w_0000000002'] });
    ctx.store.table('bots').remove(bot.id);

    const row = api.projectView().projects[0]!.tasks.find(x => x.task.id === task.id)!;
    expect(row.wakes[0]).toMatchObject({ wakeId: 'w_0000000002', botId: bot.id, botName: null, ledgerId: 'wl_0000000002' });
  });

  it('重复 wakeId 去重且保留记录顺序；没有关联唤醒给空数组', async () => {
    const { api, ctx, task } = await taskWithWakes([]);
    const bot = okData(await api.createBot({ name: '小观', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
    ctx.store.table('wakeLedger').put(ledger('w_0000000001', bot.id, ctx.clock.now() - 120_000));
    ctx.store.table('wakeLedger').put(ledger('w_0000000002', bot.id, ctx.clock.now() - 60_000));
    ctx.store.table('projectTasks').patch(task.id, { wakeIds: ['w_0000000002', 'w_0000000001', 'w_0000000002'] });

    const row = api.projectView().projects[0]!.tasks.find(x => x.task.id === task.id)!;
    expect(row.wakes.map(w => w.wakeId)).toEqual(['w_0000000002', 'w_0000000001']);
    expect(row.wakes.every(w => w.botName === '小观')).toBe(true);

    // 清空后再看：没有关联唤醒就是空数组，不多给占位。
    ctx.store.table('projectTasks').patch(task.id, { wakeIds: [] });
    expect(api.projectView().projects[0]!.tasks.find(x => x.task.id === task.id)!.wakes).toEqual([]);
  });
});

describe('F08 项目/任务命令经统一出口', () => {
  it('全链路：12 条命令返回 CommandResult 数据、写 ui_ 审计、发 project 事件', async () => {
    const { api, ctx } = await apiSetup();
    const done = okData(await api.saveProject({ name: '直接收工', memberBotIds: [] }));
    okData(await api.pauseProject(done.id));
    okData(await api.resumeProject(done.id));
    okData(await api.completeProject(done.id));

    const project = okData(await api.saveProject({ name: '主项目', memberBotIds: [] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: '验收流任务' }));
    // 本卡无「开始任务」命令：直接把任务表 patch 为 doing，模拟队友已经开始。
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    okData(await api.taskBlock(task.id));
    okData(await api.taskResume(task.id));
    okData(await api.reportDone(task.id));
    const rejected = okData(await api.rejectTask({ id: task.id, rejectReason: '口径不对，重算' }));
    expect(rejected.status).toBe('doing');
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    okData(await api.reportDone(task.id));
    const accepted = okData(await api.acceptTask(task.id));
    expect(accepted.status).toBe('accepted');
    okData(await api.archiveProject(project.id));
    okData(await api.restoreProject(project.id));

    const actions = ctx.store.log('audit').all().map(a => a.action).filter(a => a.startsWith('ui_'));
    for (const name of [
      'ui_saveProject', 'ui_pauseProject', 'ui_resumeProject', 'ui_completeProject',
      'ui_saveTask', 'ui_taskBlock', 'ui_taskResume', 'ui_reportDone',
      'ui_rejectTask', 'ui_acceptTask', 'ui_archiveProject', 'ui_restoreProject',
    ]) {
      expect(actions).toContain(name);
    }
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
  });

  it('非法入参返回 ok:false 与中文 error，不留项目记录', async () => {
    const { api, ctx } = await apiSetup();
    const noName = await api.saveProject({ memberBotIds: [] });
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.error).toContain('项目保存无效');
    // 空串名字过了类型层但被业务长度规则拒绝，文案点名项目名称。
    const blankName = await api.saveProject({ name: '   ', memberBotIds: [] });
    expect(blankName.ok).toBe(false);
    if (!blankName.ok) expect(blankName.error).toContain('项目名称不能为空');
    const badProjectId = await api.saveTask({ projectId: 'prj_bad', title: 't' });
    expect(badProjectId.ok).toBe(false);
    if (!badProjectId.ok) expect(badProjectId.error).toContain('prj_');
    const noReason = await api.rejectTask({ id: 'pt_0000000001', rejectReason: '   ' });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toContain('驳回理由不能为空');
    const badPauseId = await api.pauseProject('prj_bad');
    expect(badPauseId.ok).toBe(false);
    if (!badPauseId.ok) expect(badPauseId.error).toContain('prj_');

    expect(ctx.store.table('projects').count()).toBe(0);
    expect(ctx.store.table('projectTasks').count()).toBe(0);
    // 失败命令也留 ui_ 审计，且记的是 ok:false。
    const failed = ctx.store.log('audit').all()
      .filter(a => a.action === 'ui_saveProject').map(a => JSON.parse(a.detail));
    expect(failed.some(d => d.ok === false)).toBe(true);
  });

  it('业务校验失败（负责人不是成员）经出口返回中文错误，且不生成 id', async () => {
    const t = await orgWithBots();
    const { api, ctx, b1, b2 } = t;
    const result = await api.saveProject({ name: 'P', ownerBotId: b1.id, memberBotIds: [b2.id] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('项目负责人必须是项目成员之一');
    expect(ctx.store.table('projects').count()).toBe(0);
  });
});
