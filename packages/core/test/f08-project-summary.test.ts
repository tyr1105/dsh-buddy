/**
 * F08 项目容器 - 汇总与问题检测纯函数测试（project/project-summary.ts）。
 * 覆盖：任务计数与进度、失效负责人/成员队友标记、归档不参与活跃汇总、
 * 五类 issues、项目与任务的稳定排序。
 * 主人取消编制后，负责人与成员都按队友 id 计算，不再有席位/部门。
 */
import { describe, expect, it } from 'vitest';
import type { Bot } from '../src/model/bot.js';
import { ProjectSchema, ProjectTaskSchema, type Project, type ProjectTask } from '../src/model/project.js';
import { botFixture } from './model-fixtures.js';
import {
  collectProjectIssues, sortProjectsForView, sortTasksForView, summarizeProject, summarizeProjects,
  TASK_SORT_GROUP,
} from '../src/project/project-summary.js';

const P1 = 'prj_0000000001';
const P2 = 'prj_0000000002';
const B1 = 'b_0000000001';
const B2 = 'b_0000000002';
const B3 = 'b_0000000003';

/** 造一个队友快照；默认在岗，可指定退役用于失效检测。 */
function bot(id: string, lifecycle: Bot['lifecycle'] = 'active'): Bot {
  return { ...botFixture, id, name: `队友${id.slice(-2)}`, lifecycle };
}

function project(over: Partial<Project> = {}): Project {
  return ProjectSchema.parse({
    id: P1, name: '项目甲', charter: '做一件事', status: 'active', ownerBotId: null,
    memberBotIds: [], sharedDir: `/hub/projects/${P1}/`, acceptanceCriteria: [],
    createdAt: 1000, updatedAt: 1000, archivedAt: null, ...over,
  });
}

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return ProjectTaskSchema.parse({
    id: 'pt_0000000001', projectId: P1, title: '任务', detail: '', assigneeBotId: null,
    status: 'todo', wakeIds: [], artifactIds: [], createdAt: 1000, updatedAt: 1000, dueAt: null, ...over,
  });
}

describe('F08 summarizeProject 计数与进度', () => {
  it('按状态计数，total 为全部任务数', () => {
    const tasks = [
      task({ id: 'pt_0000000001', status: 'todo' }),
      task({ id: 'pt_0000000002', status: 'doing' }),
      task({ id: 'pt_0000000003', status: 'blocked' }),
      task({ id: 'pt_0000000004', status: 'done_pending_check' }),
      task({ id: 'pt_0000000005', status: 'accepted' }),
      task({ id: 'pt_0000000006', status: 'accepted' }),
    ];
    const summary = summarizeProject(project(), tasks, [bot(B1)]);
    expect(summary.taskCounts).toMatchObject({
      todo: 1, doing: 1, blocked: 1, done_pending_check: 1, accepted: 2, rejected: 0, total: 6,
    });
    expect(summary.progress).toBeCloseTo(2 / 6, 10);
  });
  it('没有任务时进度为 0，不除零', () => {
    expect(summarizeProject(project(), [], [bot(B1)]).progress).toBe(0);
  });
  it('只数本项目任务', () => {
    const summary = summarizeProject(project(), [
      task({ id: 'pt_0000000001', status: 'accepted' }),
      task({ id: 'pt_0000000002', projectId: P2, status: 'doing' }),
    ], []);
    expect(summary.taskCounts.total).toBe(1);
    expect(summary.progress).toBe(1);
  });
});

describe('F08 失效队友标记', () => {
  it('负责人队友不存在或已退役 → ownerInvalid', () => {
    const bots = [bot(B1)];
    expect(summarizeProject(project({ ownerBotId: B1 }), [], bots).ownerInvalid).toBe(false);
    expect(summarizeProject(project({ ownerBotId: B2 }), [], bots).ownerInvalid).toBe(true);
    expect(summarizeProject(project({ ownerBotId: B1 }), [], [bot(B1, 'retired')]).ownerInvalid).toBe(true);
  });
  it('没有负责人不算失效', () => {
    expect(summarizeProject(project({ ownerBotId: null }), [], []).ownerInvalid).toBe(false);
  });
  it('失效成员队友列入 invalidMemberBotIds，有效成员不列', () => {
    const summary = summarizeProject(
      project({ memberBotIds: [B1, B2, B3] }), [],
      [bot(B1), bot(B2, 'retired'), /* B3 缺失 */],
    );
    expect(summary.invalidMemberBotIds).toEqual([B2, B3]);
  });
  it('归档项目不参与 summarizeProjects 活跃汇总', () => {
    const summaries = summarizeProjects({
      projects: [project({ status: 'active' }), project({ id: P2, status: 'archived', archivedAt: 2000 })],
      tasks: [], bots: [],
    });
    expect(summaries.map(s => s.projectId)).toEqual([P1]);
  });
});

describe('F08 collectProjectIssues', () => {
  it('健康项目没有问题', () => {
    const issues = collectProjectIssues(
      project({ ownerBotId: B1, memberBotIds: [B1] }),
      [task({ assigneeBotId: B1, status: 'accepted' })],
      [bot(B1)],
    );
    expect(issues).toEqual([]);
  });
  it('负责人队友失效报 error', () => {
    const issues = collectProjectIssues(project({ ownerBotId: B2, memberBotIds: [] }), [], [bot(B1)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', code: 'owner_bot_invalid', subjectBotId: B2 });
    // 正文只说人话，绝不露内部 id；id 只放在 subjectBotId 里供界面放进悬停 title。
    expect(issues[0]!.text).not.toContain(B2);
    expect(issues[0]!.text).toContain('已删除或退役');
  });
  it('成员队友失效报 warning', () => {
    const issues = collectProjectIssues(project({ memberBotIds: [B2] }), [], []);
    expect(issues[0]).toMatchObject({ level: 'warning', code: 'member_bot_invalid', subjectBotId: B2 });
    expect(issues[0]!.text).not.toContain(B2);
  });
  it('任务指派队友失效报 error', () => {
    const issues = collectProjectIssues(
      project({ memberBotIds: [B1] }), [task({ assigneeBotId: B2 })], [bot(B1)],
    );
    const found = issues.find(i => i.code === 'task_assignee_invalid')!;
    expect(found.level).toBe('error');
    expect(found.subjectBotId).toBe(B2);
    expect(found.text).not.toContain(B2);
  });
  it('任务指派给非成员队友报 error', () => {
    const issues = collectProjectIssues(
      project({ memberBotIds: [B1] }), [task({ assigneeBotId: B2 })], [bot(B1), bot(B2)],
    );
    expect(issues.some(i => i.code === 'task_assignee_not_member')).toBe(true);
    // 待认领任务不报。
    expect(collectProjectIssues(project(), [task({ assigneeBotId: null })], [])).toEqual([]);
  });
  it('已完成项目还有未通过任务报 warning 并点名任务', () => {
    const issues = collectProjectIssues(
      project({ status: 'done' }),
      [task({ title: '没做完', status: 'doing' }), task({ id: 'pt_0000000002', title: '做完了', status: 'accepted' })],
      [],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', code: 'done_with_open_tasks' });
    expect(issues[0]!.text).toContain('没做完');
  });
  it('归档项目不报问题（历史陈列）', () => {
    const issues = collectProjectIssues(project({ status: 'archived', archivedAt: 2000, ownerBotId: B2 }), [], []);
    expect(issues).toEqual([]);
  });
});

describe('F08 排序', () => {
  it('sortProjectsForView：非归档在前按 createdAt+id，归档整体沉底', () => {
    const sorted = sortProjectsForView([
      project({ id: P2, status: 'archived', archivedAt: 5000, createdAt: 500 }),
      project({ id: 'prj_0000000003', status: 'done', createdAt: 2000 }),
      project({ status: 'active', createdAt: 500 }),
    ]);
    expect(sorted.map(p => p.id)).toEqual([P1, 'prj_0000000003', P2]);
  });
  it('同创建时间按 id 稳定排序', () => {
    const sorted = sortProjectsForView([
      project({ id: 'prj_0000000009', createdAt: 100 }),
      project({ id: 'prj_0000000001', createdAt: 100 }),
    ]);
    expect(sorted.map(p => p.id)).toEqual(['prj_0000000001', 'prj_0000000009']);
  });
  it('sortTasksForView：doing/blocked/todo/pending/accepted/rejected 分组再 createdAt', () => {
    const orderedStatuses = ['doing', 'blocked', 'todo', 'done_pending_check', 'accepted', 'rejected'] as const;
    const tasks = [...orderedStatuses].reverse().map((status, index) =>
      task({ id: `pt_${String(index + 1).padStart(10, '0')}`, status, createdAt: 5000 - index }));
    const sorted = sortTasksForView(tasks);
    expect(sorted.map(t => t.status)).toEqual([...orderedStatuses]);
    // 分组序号常量顺序正确。
    expect(TASK_SORT_GROUP.doing).toBeLessThan(TASK_SORT_GROUP.accepted);
  });
});
