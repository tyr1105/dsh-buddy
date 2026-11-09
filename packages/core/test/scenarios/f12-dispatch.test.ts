/**
 * F12 派活端到端场景（v2 计划 6.4 第四期场景 A 与场景 F，任务卡 V2-PH4-03）。
 *
 * 场景 A：建项目→两名队友入列→建任务→dispatchTask 派给队友 A→
 *         主人发起的唤醒真实放行，唤醒包含任务段（标题、验收口径、项目目录、留言），任务 doing，wakeId 回写。
 * 场景 F：归档后任务与产物在 projectView 里仍可读，派活被中文拒绝且不新增消息/议程。
 */
import { describe, expect, it } from 'vitest';
import { createSimWorld } from '../../src/sim/runner.js';
import type { SimWorld } from '../../src/sim/runner.js';
import { ArtifactHeadSchema, ArtifactVersionSchema } from '../../src/model/artifact.js';
import type { Project, ProjectTask } from '../../src/model/project.js';
import { botIds, bots, complete, startAt } from './fixtures.js';

/** 建出来的一套项目成员；第二名队友可选。 */
interface BuiltProject {
  botAId: string;
  botBId: string | null;
  project: Project;
  task: ProjectTask;
}

/** 结果解包：仿真里所有界面命令都走 UiApi，失败直接把中文原因抛出来方便断言。
 *  注意 CommandResult 的 data 是可选字段，成功但缺数据属于接线错误，同样抛出。 */
function ok<T>(result: { ok: true; data?: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  if (result.data === undefined) throw new Error('命令成功但未返回数据');
  return result.data;
}

/** 在仿真世界里走真实命令建项目：项目成员直接是队友 id（带验收项）→任务。 */
async function buildProject(world: SimWorld, withSecondBot = true): Promise<BuiltProject> {
  const memberIds: string[] = [botIds[0]];
  let botBId: string | null = null;
  if (withSecondBot) {
    botBId = botIds[1];
    memberIds.push(botBId);
  }
  const project = ok(await world.hub.api.saveProject({
    name: '季度战役',
    memberBotIds: memberIds,
    acceptanceCriteria: [{ text: '引用 3 个公开来源', verify: '链接可打开' }],
  }));
  const task = ok(await world.hub.api.saveTask({ projectId: project.id, title: '写竞品报告', detail: '只看公开资料' }));
  return { botAId: botIds[0], botBId, project, task };
}

describe('F12 场景 A：主人点名派活端到端', () => {
  it('派活后主人发起唤醒真实放行，唤醒包含任务与验收口径，任务 doing 且回写 wakeId', async () => {
    const world = await createSimWorld({ bots: bots(2), startAt });
    const { botAId, project, task } = await buildProject(world);

    let packet = '';
    let wakeCount = 0;
    world.host.registerBrain(botIds[0], input => {
      packet = input.packet;
      wakeCount += 1;
      // 唤醒包里既有主人原话，也有项目任务段，验收口径与项目目录都要在。
      expect(input.variant).toBe('regular');
      expect(input.packet).toContain('## 你手上的项目任务');
      expect(input.packet).toContain('写竞品报告');
      expect(input.packet).toContain('引用 3 个公开来源');
      expect(input.packet).toContain('链接可打开');
      expect(input.packet).toContain(project.sharedDir);
      expect(input.packet).toContain('先出一版大纲');
      return complete(input, { outcome: 'progress', summary: '已开工写竞品报告' });
    });

    const dispatched = await world.hub.api.dispatchTask({
      projectId: project.id, taskId: task.id, botId: botAId, note: '先出一版大纲',
    });
    expect(dispatched).toMatchObject({ ok: true });
    await world.host.settle();

    // 只叫醒队友 A；队友 B 不被打扰。
    expect(wakeCount).toBe(1);
    expect(packet).toContain('写竞品报告');
    const wakesA = world.store.table('wakes').list(w => w.botId === botIds[0]);
    expect(wakesA).toHaveLength(1);
    expect(wakesA[0]).toMatchObject({ ownerInitiated: true, status: 'committed' });
    expect(world.store.table('wakes').list(w => w.botId === botIds[1])).toHaveLength(0);

    // 任务 doing、承接队友与本轮 wakeId 已回写；议程 open；线程留了主人原话。
    const row = world.store.table('projectTasks').get(task.id)!;
    expect(row.status).toBe('doing');
    expect(row.assigneeBotId).toBe(botAId);
    expect(row.wakeIds).toEqual([wakesA[0]!.id]);
    const agenda = world.store.table('agenda').list(a => a.botId === botIds[0]);
    expect(agenda).toHaveLength(1);
    expect(agenda[0]).toMatchObject({ status: 'open', dueAt: null });
    const thread = world.store.log('thread').all().filter(m => m.thread === botIds[0] && m.from === 'owner');
    expect(thread).toHaveLength(1);
    expect(thread[0]!.text).toContain('写竞品报告');

    // 两类审计都在：UiApi 通用审计 + 业务 task_dispatch。
    const audits = world.store.log('audit').all();
    expect(audits.some(a => a.action === 'ui_dispatchTask')).toBe(true);
    const dispatch = audits.find(a => a.action === 'task_dispatch')!;
    expect(dispatch).toBeDefined();
    expect(dispatch.actor).toBe('owner');
    expect(JSON.parse(dispatch.detail)).toMatchObject({
      projectId: project.id, taskId: task.id,
      botId: botAId, renudge: false, reassigned: false,
    });
  });
});

describe('F12 场景 F：归档后只读、派活拒绝', () => {
  it('归档项目：任务与产物仍可在 projectView 读到，派活被中文拒绝且不留新消息', async () => {
    const world = await createSimWorld({ bots: bots(1), startAt });
    const { botAId, project, task } = await buildProject(world, false);
    const first = await world.hub.api.dispatchTask({
      projectId: project.id, taskId: task.id, botId: botAId,
    });
    expect(first.ok).toBe(true);
    await world.host.settle();

    // 造一个产物头 + v1，并直接挂到任务上（测试只造数据，产物声明工具不在本卡）。
    const now = world.clock.now();
    const head = ArtifactHeadSchema.parse({
      id: 'ah_0000000001', botId: botIds[0], sourcePath: 'report.md', lastVersion: 1,
      createdAt: now, updatedAt: now,
    });
    world.store.table('artifactHeads').put(head);
    world.store.table('artifactVersions').put(ArtifactVersionSchema.parse({
      id: 'av_0000000001', artifactId: head.id, botId: botIds[0], number: 1,
      title: '竞品报告 v1', sourcePath: 'report.md', realPath: `${project.sharedDir}report.md`,
      visibility: 'owner', content: '正文', bytes: 2, sha256: 'a'.repeat(64),
      commitId: 'c_0000000001', wakeId: 'w_0000000001', goalIds: [], createdAt: now,
    }));
    world.store.table('projectTasks').patch(task.id, { artifactIds: [head.id] });

    // 归档：软归档不删任务。
    const archived = await world.hub.api.archiveProject(project.id);
    expect(archived.ok).toBe(true);

    // 派活被拒：中文原因，任务仍是 doing，没有新增线程消息或议程。
    const retry = await world.hub.api.dispatchTask({
      projectId: project.id, taskId: task.id, botId: botAId, note: '归档后还催',
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error).toContain('只有进行中的项目能派活');
    const stored = world.store.table('projectTasks').get(task.id)!;
    expect(stored.status).toBe('doing');
    expect(stored.assigneeBotId).toBe(botAId);
    const ownerCount = world.store.log('thread').all()
      .filter(m => m.thread === botIds[0] && m.from === 'owner').length;
    expect(ownerCount).toBe(1);
    expect(world.store.table('agenda').count(a => a.botId === botIds[0] && a.status === 'open')).toBe(1);

    // 任务、产物计数、承接队友在归档后的项目视图里仍完整可读。
    const view = await world.hub.api.projectView();
    const row = view.projects.find(p => p.project.id === project.id)!;
    expect(row).toBeDefined();
    expect(row.project.status).toBe('archived');
    const taskRow = row.tasks.find(t => t.task.id === task.id)!;
    expect(taskRow.statusLabel).toBe('进行中');
    expect(taskRow.artifactCount).toBe(1);
    expect(taskRow.assigneeBotId).toBe(botAId);
    expect(taskRow.assigneeBotName).toBe('守望');
  });
});
