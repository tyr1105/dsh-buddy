/**
 * F12 唤醒包「项目任务」段测试。
 * 覆盖：没有任务整段省略；只带本队友名下的进行中/受阻任务；只带进行中项目；
 * 标题、说明、验收口径、项目目录、最近产物版本；条数与字数上限；
 * 以及接入唤醒包后把真实 wakeId 追加到任务、轻复查不出现该段。
 * 主人取消编制后，任务归属按 assigneeBotId 判断，不再有席位。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import {
  archiveProject, pauseProject, saveProject, saveTask, taskBlock,
} from '../src/project/service.js';
import { assignTask } from '../src/project/assign.js';
import { buildProjectTasksSection } from '../src/wake/project-tasks.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { ArtifactHeadSchema, ArtifactVersionSchema } from '../src/model/artifact.js';
import type { ProjectTask } from '../src/model/project.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';

/** 标准环境：一个在岗队友、一个项目（自己是成员）、一条待办任务。 */
function setup(ctx: HubContext) {
  const bot = { ...botFixture, id: 'b_0000000007', name: '执行队友', homeDir: '/hub/bots/b_0000000007' };
  ctx.store.table('bots').put(bot);
  const project = saveProject(ctx, { name: '季度战役', memberBotIds: [bot.id] });
  const task = saveTask(ctx, { projectId: project.id, title: '写竞品报告' });
  return { bot, project, task };
}

/** 给任务塞一条产物头 + 两个版本，返回头 id。 */
function putArtifact(ctx: HubContext, botId: string, title: string): string {
  const now = ctx.clock.now();
  const head = ArtifactHeadSchema.parse({
    id: 'ah_0000000001', botId, sourcePath: 'report.md', lastVersion: 2, createdAt: now, updatedAt: now,
  });
  ctx.store.table('artifactHeads').put(head);
  for (const number of [1, 2]) {
    ctx.store.table('artifactVersions').put(ArtifactVersionSchema.parse({
      id: `av_000000000${number}`, artifactId: head.id, botId, number,
      title: number === 2 ? `${title}（定稿）` : title, sourcePath: 'report.md', realPath: '/hub/report.md',
      visibility: 'owner', content: `第 ${number} 版正文`, bytes: 12, sha256: 'a'.repeat(64),
      commitId: 'c_0000000001', wakeId: 'w_0000000001', goalIds: [], createdAt: now,
    }));
  }
  return head.id;
}

/** 直接改任务关联产物（服务层没有该入口，测试只造数据）。 */
function linkArtifacts(ctx: HubContext, task: ProjectTask, ids: string[]): void {
  ctx.store.table('projectTasks').patch(task.id, { artifactIds: ids });
}

describe('F12 项目任务段', () => {
  it('没有进行中的任务时整段不出现', () => {
    const ctx = createTestContext();
    const { bot, task } = setup(ctx);
    expect(buildProjectTasksSection(ctx, bot)).toBeNull();
    // 待办还没派，不带进唤醒包。
    expect(task.status).toBe('todo');
  });

  it('带标题、说明、验收口径、项目目录与最近产物，并只列未满足的验收项', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    ctx.store.table('projects').patch(project.id, {
      acceptanceCriteria: [
        { id: 'ac_0000000001', text: '引用 3 个公开来源', verify: '链接可打开', status: 'open' },
        { id: 'ac_0000000002', text: '已经做完的事', verify: '', status: 'met' },
      ],
    });
    const headId = putArtifact(ctx, bot.id, '竞品报告');
    linkArtifacts(ctx, task, [headId]);
    const assigned = assignTask(ctx, { taskId: task.id, botId: bot.id });

    const result = buildProjectTasksSection(ctx, bot)!;
    expect(result.taskIds).toEqual([assigned.id]);
    const body = result.section.body;
    expect(result.section.key).toBe('project-tasks');
    expect(result.section.title).toContain('你手上的项目任务');
    expect(body).toContain('写竞品报告');
    expect(body).toContain('项目「季度战役」');
    expect(body).toContain('进行中');
    expect(body).toContain('引用 3 个公开来源（验证：链接可打开）');
    expect(body).not.toContain('已经做完的事');
    expect(body).toContain(project.sharedDir);
    // 只展示最近一版，旧版不出现。
    expect(body).toContain('v2「竞品报告（定稿）」');
    expect(body).not.toContain('v1');
  });

  it('产物 id 直接指向版本时也能展示；没有产物写「暂无」', () => {
    const ctx = createTestContext();
    const { bot, task } = setup(ctx);
    putArtifact(ctx, bot.id, '竞品报告');
    // 再加一条任务，只关联版本 id；原任务不关联产物。
    const second = saveTask(ctx, { projectId: task.projectId, title: '补附录' });
    linkArtifacts(ctx, second, ['av_0000000001']);
    assignTask(ctx, { taskId: task.id, botId: bot.id });
    assignTask(ctx, { taskId: second.id, botId: bot.id });
    const body = buildProjectTasksSection(ctx, bot)!.section.body;
    expect(body).toContain('v1「竞品报告」');
    expect(body).toContain('最近产物：暂无');
  });

  it('只有进行中的项目、只有本队友的任务会出现；受阻任务也算在手', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    // 旁观队友与任务：不出现。
    const otherBot = { ...botFixture, id: 'b_0000000008', name: '旁观队友', homeDir: '/hub/bots/b_0000000008' };
    ctx.store.table('bots').put(otherBot);
    ctx.store.table('projects').patch(project.id, { memberBotIds: [...project.memberBotIds, otherBot.id] });
    const otherTask = saveTask(ctx, { projectId: project.id, title: '别人的活', assigneeBotId: otherBot.id });
    assignTask(ctx, { taskId: otherTask.id, botId: otherBot.id });
    // 本队友任务：先派活再标记受阻。
    assignTask(ctx, { taskId: task.id, botId: bot.id });
    taskBlock(ctx, task.id);
    let body = buildProjectTasksSection(ctx, bot)!.section.body;
    expect(body).toContain('写竞品报告');
    expect(body).toContain('受阻');
    expect(body).not.toContain('别人的活');

    // 项目暂停后整段消失。
    pauseProject(ctx, project.id);
    expect(buildProjectTasksSection(ctx, bot)).toBeNull();
  });

  it('归档项目的任务不带进唤醒包', () => {
    const ctx = createTestContext();
    const { bot, project, task } = setup(ctx);
    assignTask(ctx, { taskId: task.id, botId: bot.id });
    archiveProject(ctx, project.id);
    expect(buildProjectTasksSection(ctx, bot)).toBeNull();
  });

  it('条数、验收项、说明长度与产物条数受上限约束', () => {
    const ctx = createTestContext();
    const { bot, project } = setup(ctx);
    ctx.store.table('projects').patch(project.id, {
      acceptanceCriteria: Array.from({ length: 6 }, (_, i) => ({
        id: `ac_${String(i + 1).padStart(10, '0')}`, text: `验收 ${i + 1}`, verify: '', status: 'open',
      })),
    });
    const headId = putArtifact(ctx, bot.id, '报告');
    const longDetail = '很长的说明'.repeat(100);
    for (let i = 1; i <= 6; i++) {
      const task = saveTask(ctx, { projectId: project.id, title: `任务 ${i}`, detail: longDetail });
      linkArtifacts(ctx, task, [headId]);
      assignTask(ctx, { taskId: task.id, botId: bot.id });
    }
    const result = buildProjectTasksSection(ctx, bot)!;
    expect(result.taskIds).toHaveLength(V2_DEFAULTS.PROJECT_TASKS_PER_PACKET);
    expect(result.section.body).toContain('另有 2 条未列出');
    expect(result.section.body).toContain('…');
    expect(result.section.body).not.toContain(longDetail);
    const shownTasks = result.section.body.split('\n').filter(line => line.startsWith('- 任务：'));
    expect(shownTasks).toHaveLength(V2_DEFAULTS.PROJECT_TASKS_PER_PACKET);
  });
});

describe('F12 项目任务段接入唤醒包', () => {
  it('常规回合包含该段，并把真实 wakeId 追加到任务（重复构建不重复追加）', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular');
    const project = saveProject(ctx, { name: '季度战役', memberBotIds: [bot.id] });
    const task = saveTask(ctx, { projectId: project.id, title: '写竞品报告' });
    assignTask(ctx, { taskId: task.id, botId: bot.id });

    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('## 你手上的项目任务');
    expect(packet).toContain('写竞品报告');
    expect(ctx.store.table('projectTasks').get(task.id)!.wakeIds).toEqual([ticket.id]);

    // 同一唤醒重复构建：不重复追加。
    await buildWakePacket(ctx, bot, entry, ticket);
    expect(ctx.store.table('projectTasks').get(task.id)!.wakeIds).toEqual([ticket.id]);
  });

  it('轻复查不出现项目任务段，也不追加 wakeId', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('light_check');
    const project = saveProject(ctx, { name: '季度战役', memberBotIds: [bot.id] });
    const task = saveTask(ctx, { projectId: project.id, title: '写竞品报告' });
    assignTask(ctx, { taskId: task.id, botId: bot.id });

    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).not.toContain('## 你手上的项目任务');
    expect(ctx.store.table('projectTasks').get(task.id)!.wakeIds).toEqual([]);
  });
});
