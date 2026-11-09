/**
 * F08 项目容器 - 服务层测试（project/service.ts）。
 * 覆盖：项目新建/修改/暂停/恢复/完成/归档、成员与负责人队友校验、去重与上限、
 * 任务新建/修改、验收流（交账→通过/驳回回流）、失败不耗 RNG、审计与 project 事件。
 * 主人取消编制后，项目直接按队友记账：负责人/成员都是 botId，不再有部门与席位。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import type { Bot } from '../src/model/bot.js';
import { ProjectSchema, ProjectTaskSchema } from '../src/model/project.js';
import { botFixture } from './model-fixtures.js';
import {
  acceptTask, archiveProject, completeProject, pauseProject, rejectTask, reportDone,
  restoreProject, resumeProject, saveProject, saveTask, taskBlock, taskResume,
} from '../src/project/service.js';

const pad = (n: number): string => String(n).padStart(10, '0');

/** 项目/任务相关审计（project_* 与 task_*）。 */
function projectAudits(ctx: HubContext) {
  return ctx.store.log('audit').all().filter(a => a.action.startsWith('project_') || a.action.startsWith('task_'));
}

/** 直接往队友表放一个有效队友（绕开建队命令，用于灌成员上限与失效数据）。 */
function putBot(ctx: HubContext, n: number, lifecycle: Bot['lifecycle'] = 'active'): Bot {
  const now = ctx.clock.now();
  const bot: Bot = {
    ...botFixture, id: `b_${pad(n)}`, name: `队友 ${n}`, lifecycle, createdAt: now, updatedAt: now,
  };
  ctx.store.table('bots').put(bot);
  return bot;
}

/** 直接往项目表放一条有效项目（用于灌 PROJECT_MAX_ACTIVE 上限）。 */
function putProject(ctx: HubContext, n: number, status: 'active' | 'paused' | 'done' | 'archived' = 'active'): void {
  const now = ctx.clock.now();
  ctx.store.table('projects').put(ProjectSchema.parse({
    id: `prj_${pad(n)}`, name: `项目 ${n}`, charter: '', status,
    ownerBotId: null, memberBotIds: [], sharedDir: `/hub/projects/prj_${pad(n)}/`,
    acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: status === 'archived' ? now : null,
  }));
}

/** 建三个在岗队友，返回队友 id。 */
function botsFixture(ctx: HubContext) {
  return { b1: putBot(ctx, 1).id, b2: putBot(ctx, 2).id, b3: putBot(ctx, 3).id };
}

describe('F08 saveProject 新建', () => {
  it('默认值：prj_ id、active、默认 sharedDir、空验收项、审计与 project 事件', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, { name: '季度战役', memberBotIds: [] });
    expect(saved.id).toMatch(/^prj_[a-z0-9]{10}$/);
    expect(saved.status).toBe('active');
    expect(saved.sharedDir).toBe(`/hub/projects/${saved.id}/`);
    expect(saved.acceptanceCriteria).toEqual([]);
    expect(saved.archivedAt).toBeNull();
    expect(saved.ownerBotId).toBeNull();
    expect(saved.memberBotIds).toEqual([]);
    const audit = projectAudits(ctx)[0]!;
    expect(audit.action).toBe('project_create');
    expect(audit.actor).toBe('owner');
    expect(JSON.parse(audit.detail)).toMatchObject({ id: saved.id, status: 'active' });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
  });

  it('带负责人、成员、charter 与验收项：负责人必须在成员内；验收项发 ac_ id 且 open', () => {
    const ctx = createTestContext();
    const { b1, b2 } = botsFixture(ctx);
    const saved = saveProject(ctx, {
      name: 'P', charter: '一句话目标', ownerBotId: b1, memberBotIds: [b1, b2],
      acceptanceCriteria: [{ text: '报告交付', verify: '主人看过' }],
    });
    expect(saved.ownerBotId).toBe(b1);
    expect(saved.memberBotIds).toEqual([b1, b2]);
    expect(saved.acceptanceCriteria[0]).toMatchObject({ text: '报告交付', status: 'open' });
    expect(saved.acceptanceCriteria[0]!.id).toMatch(/^ac_[a-z0-9]{10}$/);
  });

  it('负责人不是成员 → 中文拒绝', () => {
    const ctx = createTestContext();
    const { b1, b2 } = botsFixture(ctx);
    expect(() => saveProject(ctx, { name: 'P', ownerBotId: b1, memberBotIds: [b2] }))
      .toThrow('项目负责人必须是项目成员之一');
  });

  it('负责人/成员队友不存在或已退役 → 中文拒绝', () => {
    const ctx = createTestContext();
    const { b1 } = botsFixture(ctx);
    expect(() => saveProject(ctx, { name: 'P', ownerBotId: 'b_0000000099', memberBotIds: [] }))
      .toThrow('项目负责人队友不存在或已退役');
    const retired = putBot(ctx, 9, 'retired');
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [retired.id] }))
      .toThrow('项目成员队友不存在或已退役');
    expect(() => saveProject(ctx, { name: 'P', ownerBotId: b1, memberBotIds: [b1, 'b_0000000098'] }))
      .toThrow('项目成员队友不存在或已退役');
  });

  it('成员队友去重保序', () => {
    const ctx = createTestContext();
    const { b1, b2, b3 } = botsFixture(ctx);
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [b2, b1, b2, b3, b1] });
    expect(saved.memberBotIds).toEqual([b2, b1, b3]);
  });

  it('成员达上限：21 个被拒，20 个通过', () => {
    const ctx = createTestContext();
    const ids = Array.from({ length: 21 }, (_unused, i) => putBot(ctx, i + 10).id);
    expect(() => saveProject(ctx, { name: '超', memberBotIds: ids }))
      .toThrow(`项目成员不能超过 ${V2_DEFAULTS.PROJECT_MEMBER_MAX} 个`);
    expect(saveProject(ctx, { name: '刚好', memberBotIds: ids.slice(0, 20) }).memberBotIds).toHaveLength(20);
  });

  it('项目数达 PROJECT_MAX_ACTIVE 后新建被拒；归档项目不占名额', () => {
    const ctx = createTestContext();
    for (let i = 0; i < V2_DEFAULTS.PROJECT_MAX_ACTIVE; i++) putProject(ctx, i + 1);
    expect(() => saveProject(ctx, { name: '超', memberBotIds: [] }))
      .toThrow(`防误操作上限 ${V2_DEFAULTS.PROJECT_MAX_ACTIVE}`);
    // 把其中一个归档（直接造一个已归档项目顶替名额）后可新建：先归档第 50 个。
    const fiftieth = ctx.store.table('projects').list()[49]!;
    ctx.store.table('projects').patch(fiftieth.id, { status: 'archived', archivedAt: ctx.clock.now() });
    expect(saveProject(ctx, { name: '腾位', memberBotIds: [] }).status).toBe('active');
  });
});

describe('P34 项目两层：愿景与约定', () => {
  it('新建不传时愿景与约定为空串；显式传入则原样保存', () => {
    const ctx = createTestContext();
    const plain = saveProject(ctx, { name: '空两栏' });
    expect(plain.vision).toBe('');
    expect(plain.conventions).toBe('');
    const saved = saveProject(ctx, {
      name: '有愿景', vision: '让团队自己跑起来', conventions: '先写验收再动手',
    });
    expect(saved.vision).toBe('让团队自己跑起来');
    expect(saved.conventions).toBe('先写验收再动手');
  });

  it('编辑不传时沿用旧值；显式传空串才清空', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, { name: 'P', vision: '旧愿景', conventions: '旧约定' });
    // 老界面只改名、不带两栏：不能把已写的愿景与约定弄丢。
    const renamed = saveProject(ctx, { id: saved.id, name: 'P2' });
    expect(renamed.vision).toBe('旧愿景');
    expect(renamed.conventions).toBe('旧约定');
    const cleared = saveProject(ctx, { id: saved.id, name: 'P2', vision: '', conventions: '' });
    expect(cleared.vision).toBe('');
    expect(cleared.conventions).toBe('');
  });

  // 真机回归（2026-11-09）：旧构建的 SaveProjectSchema 不含这四个字段，strictObject 会把
  // 整个请求判成「不支持字段 vision、conventions、ownerBotId、memberBotIds」。
  // 这里锁住兼容口径：带四字段、不带四字段、显式空值都必须能存，缺字段绝不能整单失败。
  it('P35 回归：带四个新字段 / 不带 / 显式空值都能保存', () => {
    const ctx = createTestContext();
    const { b1 } = botsFixture(ctx);
    const withFields = saveProject(ctx, {
      name: '带字段', vision: '愿景', conventions: '约定', ownerBotId: b1, memberBotIds: [b1],
    });
    expect(withFields).toMatchObject({ vision: '愿景', conventions: '约定', ownerBotId: b1, memberBotIds: [b1] });
    const emptyFields = saveProject(ctx, {
      name: '空值', vision: '', conventions: '', ownerBotId: null, memberBotIds: [],
    });
    expect(emptyFields).toMatchObject({ vision: '', conventions: '', ownerBotId: null, memberBotIds: [] });
    // 旧界面只发 name/charter：四个字段全部缺省，走默认值而不是被严格校验拒掉。
    const legacy = saveProject(ctx, { name: '旧界面', charter: '目标' });
    expect(legacy).toMatchObject({ vision: '', conventions: '', ownerBotId: null, memberBotIds: [] });
  });

  it('愿景或约定超过 2000 字 → 中文拒绝且不落记录', () => {
    const ctx = createTestContext();
    expect(() => saveProject(ctx, { name: 'P', vision: '长'.repeat(2001) }))
      .toThrow('项目愿景不能超过 2000 字');
    expect(() => saveProject(ctx, { name: 'P', conventions: '长'.repeat(2001) }))
      .toThrow('项目约定不能超过 2000 字');
    expect(ctx.store.table('projects').count()).toBe(0);
  });
});

describe('F08 saveProject 修改与验收项', () => {
  it('改名/改成员写 project_update，id 不变；验收项新增、保留、勾选状态保留', () => {
    const ctx = createTestContext();
    const { b1, b2, b3 } = botsFixture(ctx);
    const saved = saveProject(ctx, {
      name: '原名', ownerBotId: b1, memberBotIds: [b1, b2],
      acceptanceCriteria: [{ text: '第一条' }, { text: '第二条' }],
    });
    const [c1, c2] = saved.acceptanceCriteria;
    const updated = saveProject(ctx, {
      id: saved.id, name: '新名', ownerBotId: b1, memberBotIds: [b1, b2, b3],
      acceptanceCriteria: [
        { id: c1!.id, text: '第一条改', verify: '', status: 'met' },
        { text: '第三条' },
        // c2 整条被移除。
      ],
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.name).toBe('新名');
    expect(updated.memberBotIds).toEqual([b1, b2, b3]);
    expect(updated.acceptanceCriteria.map(c => c.text)).toEqual(['第一条改', '第三条']);
    expect(updated.acceptanceCriteria[0]!.id).toBe(c1!.id);
    expect(updated.acceptanceCriteria[0]!.status).toBe('met');
    expect(updated.acceptanceCriteria[1]!.status).toBe('open');
    expect(projectAudits(ctx).map(a => a.action)).toEqual(['project_create', 'project_update']);
  });

  it('验收项引用未知 id 或重复 id 被中文拒绝', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [] });
    expect(() => saveProject(ctx, {
      id: saved.id, name: 'P', acceptanceCriteria: [{ id: 'ac_0000000099', text: '外来项' }],
    })).toThrow('验收项不属于该项目');
    const c1 = saveProject(ctx, { id: saved.id, name: 'P2', acceptanceCriteria: [{ text: '一' }] }).acceptanceCriteria[0]!;
    expect(() => saveProject(ctx, {
      id: saved.id, name: 'P2',
      acceptanceCriteria: [{ id: c1.id, text: '一' }, { id: c1.id, text: '重复' }],
    })).toThrow('验收项在入参里重复');
  });

  it('验收项超过 20 条被拒', () => {
    const ctx = createTestContext();
    const criteria = Array.from({ length: 21 }, (_unused, i) => ({ text: `第 ${i} 条` }));
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], acceptanceCriteria: criteria }))
      .toThrow(`验收项不能超过 ${V2_DEFAULTS.PROJECT_CRITERION_MAX} 条`);
  });

  it('已归档项目不可改；不存在 id 被拒', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [] });
    archiveProject(ctx, saved.id);
    expect(() => saveProject(ctx, { id: saved.id, name: '改名' })).toThrow('已归档');
    expect(() => saveProject(ctx, { id: 'prj_0000000099', name: '无' })).toThrow('项目不存在');
  });

  it('失败不耗 RNG：失败后下一条项目 id 与对照环境一致', () => {
    const good = createTestContext();
    const bad = createTestContext();
    const expectedId = saveProject(good, { name: '参照', memberBotIds: [] }).id;
    expect(() => saveProject(bad, { name: '坏', ownerBotId: 'b_0000000099', memberBotIds: [] })).toThrow();
    expect(saveProject(bad, { name: '参照', memberBotIds: [] }).id).toBe(expectedId);
    expect(projectAudits(bad).map(a => a.action)).toEqual(['project_create']);
  });
});

describe('F08 项目状态流转', () => {
  it('active→paused→active；暂停后不能再暂停、active 不能直接恢复', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    expect(pauseProject(ctx, p.id).status).toBe('paused');
    expect(() => pauseProject(ctx, p.id)).toThrow('只有进行中的项目能暂停');
    expect(resumeProject(ctx, p.id).status).toBe('active');
    expect(() => resumeProject(ctx, p.id)).toThrow('只有已暂停的项目能恢复');
  });
  it('完成：active/paused 可完成；已完成/已归档不可', () => {
    const ctx = createTestContext();
    const p1 = saveProject(ctx, { name: 'P1', memberBotIds: [] });
    expect(completeProject(ctx, p1.id).status).toBe('done');
    expect(() => completeProject(ctx, p1.id)).toThrow('只有进行中或已暂停');
    const p2 = saveProject(ctx, { name: 'P2', memberBotIds: [] });
    pauseProject(ctx, p2.id);
    expect(completeProject(ctx, p2.id).status).toBe('done');
  });
  it('归档：写 archivedAt、任务一条不删、重复归档被拒', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const task = saveTask(ctx, { projectId: p.id, title: 't' });
    const archived = archiveProject(ctx, p.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(ctx.clock.now());
    expect(ctx.store.table('projectTasks').get(task.id)).not.toBeNull();
    expect(() => archiveProject(ctx, p.id)).toThrow('只有未归档的项目能归档');
  });
  it('取消归档：回到进行中、清 archivedAt、任务原样保留、审计 project_restore', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const task = saveTask(ctx, { projectId: p.id, title: 't' });
    archiveProject(ctx, p.id);
    const restored = restoreProject(ctx, p.id);
    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
    expect(ctx.store.table('projectTasks').get(task.id)).not.toBeNull();
    expect(projectAudits(ctx).map(a => a.action)).toContain('project_restore');
    // 恢复后可以继续流转任务：证明不是只改了个状态字段（block 只对 doing 生效）。
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    expect(taskBlock(ctx, task.id).status).toBe('blocked');
  });
  it('取消归档：非归档项目被拒，原因说清当前状态', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    expect(() => restoreProject(ctx, p.id)).toThrow('只有已归档的项目能恢复');
  });
  it('取消归档：未归档项目已达上限时被拒，避免归档-恢复绕过防误操作上限', () => {
    const ctx = createTestContext();
    for (let i = 1; i <= V2_DEFAULTS.PROJECT_MAX_ACTIVE; i++) putProject(ctx, i);
    putProject(ctx, V2_DEFAULTS.PROJECT_MAX_ACTIVE + 1, 'archived');
    const archivedId = `prj_${pad(V2_DEFAULTS.PROJECT_MAX_ACTIVE + 1)}`;
    expect(() => restoreProject(ctx, archivedId)).toThrow(`防误操作上限 ${V2_DEFAULTS.PROJECT_MAX_ACTIVE}`);
  });
});

describe('F08 saveTask 新建与修改', () => {
  it('新建默认 todo、空关联数组；空 assignee=待认领；成员队友可指派；审计 task_create', () => {
    const ctx = createTestContext();
    const { b1 } = botsFixture(ctx);
    const project = saveProject(ctx, { name: 'P', memberBotIds: [b1] });
    const free = saveTask(ctx, { projectId: project.id, title: '待认领' });
    expect(free.status).toBe('todo');
    expect(free.wakeIds).toEqual([]);
    expect(free.artifactIds).toEqual([]);
    expect(free.assigneeBotId).toBeNull();
    const owned = saveTask(ctx, { projectId: project.id, title: '给 A', assigneeBotId: b1, dueAt: null });
    expect(owned.assigneeBotId).toBe(b1);
    expect(projectAudits(ctx).some(a => a.action === 'task_create')).toBe(true);
  });
  it('指派给非成员或失效队友被拒', () => {
    const ctx = createTestContext();
    const { b1, b2 } = botsFixture(ctx);
    const project = saveProject(ctx, { name: 'P', memberBotIds: [b1] });
    expect(() => saveTask(ctx, { projectId: project.id, title: 'x', assigneeBotId: b2 }))
      .toThrow('任务只能指派给项目成员队友');
    expect(() => saveTask(ctx, { projectId: project.id, title: 'x', assigneeBotId: 'b_0000000099' }))
      .toThrow('任务指派队友不存在或已退役');
  });
  it('项目不存在或已归档时不能新建任务', () => {
    const ctx = createTestContext();
    expect(() => saveTask(ctx, { projectId: 'prj_0000000099', title: 'x' })).toThrow('项目不存在');
    const project = saveProject(ctx, { name: 'P', memberBotIds: [] });
    archiveProject(ctx, project.id);
    expect(() => saveTask(ctx, { projectId: project.id, title: 'x' })).toThrow('已归档');
  });
  it('单项目任务达 PROJECT_TASK_MAX 后新建被拒', () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const now = ctx.clock.now();
    for (let i = 0; i < V2_DEFAULTS.PROJECT_TASK_MAX; i++) {
      ctx.store.table('projectTasks').put(ProjectTaskSchema.parse({
        id: `pt_${pad(i + 1)}`, projectId: project.id, title: `t${i}`, detail: '', assigneeBotId: null,
        status: 'todo', wakeIds: [], artifactIds: [], createdAt: now, updatedAt: now, dueAt: null,
      }));
    }
    expect(() => saveTask(ctx, { projectId: project.id, title: '超' }))
      .toThrow(`单个项目任务不能超过 ${V2_DEFAULTS.PROJECT_TASK_MAX} 个`);
  });
  it('修改：id 不变；accepted 终态不可改；任务不属于该项目被拒', () => {
    const ctx = createTestContext();
    const { b1, b2 } = botsFixture(ctx);
    const p1 = saveProject(ctx, { name: 'P1', memberBotIds: [b1, b2] });
    const p2 = saveProject(ctx, { name: 'P2', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p1.id, title: '原标题', assigneeBotId: b1 });
    const updated = saveTask(ctx, { id: t.id, projectId: p1.id, title: '新标题', assigneeBotId: b2 });
    expect(updated.id).toBe(t.id);
    expect(updated.assigneeBotId).toBe(b2);
    expect(() => saveTask(ctx, { id: t.id, projectId: p2.id, title: '串项目' })).toThrow('任务不属于该项目');
    // 推到 accepted 后不可再改（先模拟队友开始，block 只能从 doing 发起）。
    ctx.store.table('projectTasks').patch(t.id, { status: 'doing' });
    taskBlock(ctx, t.id);
    taskResume(ctx, t.id);
    reportDone(ctx, t.id);
    acceptTask(ctx, t.id);
    expect(() => saveTask(ctx, { id: t.id, projectId: p1.id, title: '终态' })).toThrow('已通过验收');
  });
  it('失败不耗 RNG：失败后下一条任务 id 与对照环境一致', () => {
    const good = createTestContext();
    const bad = createTestContext();
    for (const ctx of [good, bad]) saveProject(ctx, { name: 'P', memberBotIds: [] });
    const expectedId = saveTask(good, { projectId: good.store.table('projects').list()[0]!.id, title: '参照' }).id;
    expect(() => saveTask(bad, { projectId: bad.store.table('projects').list()[0]!.id, title: '坏', assigneeBotId: 'b_0000000099' })).toThrow();
    expect(saveTask(bad, { projectId: bad.store.table('projects').list()[0]!.id, title: '参照' }).id).toBe(expectedId);
  });
});

describe('F08 任务状态流转与验收', () => {
  it('block/resume：doing→blocked→doing；非法起点中文拒绝', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p.id, title: 't' });
    expect(() => taskBlock(ctx, t.id)).toThrow('标记受阻'); // todo 不能直接受阻
    ctx.store.table('projectTasks').patch(t.id, { status: 'doing' }); // 模拟队友开始
    expect(taskBlock(ctx, t.id).status).toBe('blocked');
    expect(taskResume(ctx, t.id).status).toBe('doing');
    expect(() => taskResume(ctx, t.id)).toThrow('恢复任务');
  });

  it('交账：doing→done_pending_check；非 doing 交账被拒', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p.id, title: 't' });
    expect(() => reportDone(ctx, t.id)).toThrow('交账待验收');
    ctx.store.table('projectTasks').patch(t.id, { status: 'doing' });
    expect(reportDone(ctx, t.id).status).toBe('done_pending_check');
    expect(projectAudits(ctx).at(-1)!.action).toBe('task_report_done');
  });

  it('验收通过：pending→accepted（终态），写 task_accept', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p.id, title: 't' });
    expect(() => acceptTask(ctx, t.id)).toThrow('验收通过'); // todo 不能直接通过
    ctx.store.table('projectTasks').patch(t.id, { status: 'done_pending_check' });
    expect(acceptTask(ctx, t.id).status).toBe('accepted');
    expect(() => acceptTask(ctx, t.id)).toThrow('终态');
    expect(projectAudits(ctx).some(a => a.action === 'task_accept')).toBe(true);
  });

  it('驳回：必须待验收且理由必填；任务回到 doing，理由落 task_reject 审计', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p.id, title: 't' });
    expect(() => rejectTask(ctx, { id: t.id, rejectReason: '不行' })).toThrow('驳回');
    ctx.store.table('projectTasks').patch(t.id, { status: 'done_pending_check' });
    expect(() => rejectTask(ctx, { id: t.id, rejectReason: '   ' })).toThrow('驳回理由不能为空');
    const returned = rejectTask(ctx, { id: t.id, rejectReason: '数据口径错了，重算' });
    expect(returned.status).toBe('doing');
    // rejected 结论不持久化。
    expect(ctx.store.table('projectTasks').get(t.id)!.status).toBe('doing');
    const audit = projectAudits(ctx).filter(a => a.action === 'task_reject')[0]!;
    const detail = JSON.parse(audit.detail);
    expect(detail).toMatchObject({ verdict: 'rejected', to: 'doing', rejectReason: '数据口径错了，重算' });
  });

  it('归档项目的任务不能再流转', () => {
    const ctx = createTestContext();
    const p = saveProject(ctx, { name: 'P', memberBotIds: [] });
    const t = saveTask(ctx, { projectId: p.id, title: 't' });
    ctx.store.table('projectTasks').patch(t.id, { status: 'doing' });
    archiveProject(ctx, p.id);
    expect(() => reportDone(ctx, t.id)).toThrow('已归档');
    expect(() => taskBlock(ctx, t.id)).toThrow('已归档');
  });
});

describe('F08 项目目录边界', () => {
  it('显式目录允许 rootDir/projects 子树内，并补成带尾斜杠', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, {
      name: 'P', memberBotIds: [], sharedDir: '/hub/projects/custom/sub',
    });
    expect(saved.sharedDir).toBe('/hub/projects/custom/sub/');
  });

  it('相对路径被拒', () => {
    const ctx = createTestContext();
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], sharedDir: 'projects/x' }))
      .toThrow('绝对路径');
  });

  it('rootDir/projects 之外的路径被拒', () => {
    const ctx = createTestContext();
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], sharedDir: '/tmp/elsewhere' }))
      .toThrow('必须位于 /hub/projects/ 下');
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], sharedDir: '/hub/shared/x' }))
      .toThrow('必须位于 /hub/projects/ 下');
  });

  it('用 .. 跳出 projects 子树的路径在规范化后被拒', () => {
    const ctx = createTestContext();
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], sharedDir: '/hub/projects/../etc' }))
      .toThrow('必须位于 /hub/projects/ 下');
  });

  it('projects 根目录本身不能当项目目录', () => {
    const ctx = createTestContext();
    expect(() => saveProject(ctx, { name: 'P', memberBotIds: [], sharedDir: '/hub/projects/' }))
      .toThrow('必须位于 /hub/projects/ 下');
  });

  it('修改项目时显式填写越界目录被拒，原目录不变', () => {
    const ctx = createTestContext();
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [] });
    expect(() => saveProject(ctx, { id: saved.id, name: 'P2', sharedDir: '/etc' }))
      .toThrow('必须位于 /hub/projects/ 下');
    expect(ctx.store.table('projects').get(saved.id)!.sharedDir).toBe(saved.sharedDir);
  });

  it('目录校验发生在取随机数之前：失败命令不耗 RNG', () => {
    const good = createTestContext();
    const expectedId = saveProject(good, { name: '参照', memberBotIds: [] }).id;
    const bad = createTestContext();
    expect(() => saveProject(bad, { name: '坏', memberBotIds: [], sharedDir: '/etc' })).toThrow();
    expect(saveProject(bad, { name: '参照', memberBotIds: [] }).id).toBe(expectedId);
  });
});
