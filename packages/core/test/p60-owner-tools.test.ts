/**
 * P60 项目负责人专用工具与负责人规则：
 * hub_project_task_upsert、hub_project_background_update 的权限和行为，
 * saveProject 的默认负责人，hub_task_update 交付提示，以及建议工具不再注册。
 */
import { describe, expect, it } from 'vitest';
import { toolFixture } from './c03-tool-fixtures.js';
import { buildTools, runTool } from '../src/tools/index.js';
import { hubProjectContextPropose } from '../src/tools/hub-project-context-propose.js';
import { saveProject } from '../src/project/service.js';
import { createProjectTopic } from '../src/project/topics.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import type { Bot } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';

/** 标准环境：当前队友是负责人，peer 是普通成员，还有一个项目外的队友。 */
function fixture() {
  const f = toolFixture();
  const outsider: Bot = { ...f.bot, id: 'b_0000000003', name: '外人', homeDir: '/hub/bots/b_0000000003', sessionId: 'session-c' };
  f.ctx.store.table('bots').put(outsider);
  const project = saveProject(f.ctx, { name: '季度战役', ownerBotId: f.bot.id, memberBotIds: [f.bot.id, f.peer.id] });
  const peerTc = { botId: f.peer.id, sessionId: f.peer.sessionId!, wakeId: null };
  return { ...f, outsider, project, peerTc };
}

describe('P60 hub_project_task_upsert', () => {
  it('负责人新建事务：写清谁跟进、什么状态，有跟进人默认算开工', async () => {
    const { ctx, tc, peer, project } = fixture();
    const result = await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写竞品报告', assigneeBotId: peer.id });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('已新建事务') });
    const task = ctx.store.table('projectTasks').list()[0]!;
    expect(task).toMatchObject({ projectId: project.id, title: '写竞品报告', assigneeBotId: peer.id, status: 'doing' });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
    expect(ctx.store.log('audit').all().find(row => row.action === 'task_create')?.actor).toBe(tc.botId);
  });

  it('建事务不叫醒任何人：要谁动手由负责人在主题里 @', async () => {
    const { ctx, tc, peer, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写报告', assigneeBotId: peer.id });
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.table('agenda').count(row => row.botId === peer.id && row.title === '写报告')).toBe(0);
  });

  it('没写跟进人时是待办', async () => {
    const { ctx, tc, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '先记下来' });
    expect(ctx.store.table('projectTasks').list()[0]).toMatchObject({ status: 'todo', assigneeBotId: null });
  });

  it('更新：只改传了的字段，负责人能直接标完成', async () => {
    const { ctx, tc, peer, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写报告', assigneeBotId: peer.id });
    const task = ctx.store.table('projectTasks').list()[0]!;
    expect((await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, taskId: task.id, status: 'accepted' })).ok).toBe(true);
    expect(ctx.store.table('projectTasks').get(task.id)).toMatchObject({ title: '写报告', assigneeBotId: peer.id, status: 'accepted' });
  });

  it('聊出来的事自动归到当前主题；也能显式指定别的主题', async () => {
    const { ctx, tc, wake, project } = fixture();
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '主题 A' });
    ctx.store.table('wakes').patch(wake.id, { topicId });
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '自动归属' });
    expect(ctx.store.table('projectTasks').list()[0]!.topicId).toBe(topicId);
    const other = createProjectTopic(ctx, { projectId: project.id, text: '主题 B' }).topicId;
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '手动归属', topicId: other });
    expect(ctx.store.table('projectTasks').list(row => row.title === '手动归属')[0]!.topicId).toBe(other);
  });

  it('反例：不是负责人不能用（普通成员）', async () => {
    const { ctx, peerTc, project } = fixture();
    expect(await runTool(ctx, peerTc, 'hub_project_task_upsert', { projectId: project.id, title: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('负责人') });
    expect(ctx.store.table('projectTasks').count()).toBe(0);
  });

  it('反例：跟进人不是项目成员、或不在岗', async () => {
    const { ctx, tc, peer, outsider, project } = fixture();
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x', assigneeBotId: outsider.id }))
      .toMatchObject({ ok: false, error: expect.stringContaining('项目成员') });
    ctx.store.table('bots').patch(peer.id, { lifecycle: 'paused' });
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x', assigneeBotId: peer.id }))
      .toMatchObject({ ok: false, error: expect.stringContaining('不在岗') });
  });

  it('反例：项目不是进行中、新建没标题、事务或主题不属于这个项目', async () => {
    const { ctx, tc, project } = fixture();
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id }))
      .toMatchObject({ ok: false, error: expect.stringContaining('title') });
    const elsewhere = saveProject(ctx, { name: '别的项目', ownerBotId: tc.botId, memberBotIds: [tc.botId] });
    const otherTopic = createProjectTopic(ctx, { projectId: elsewhere.id, text: '别处主题' }).topicId;
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x', topicId: otherTopic }))
      .toMatchObject({ ok: false, error: expect.stringContaining('主题不属于') });
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: elsewhere.id, title: '别处事务' });
    const task = ctx.store.table('projectTasks').list()[0]!;
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, taskId: task.id, title: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('不属于') });
    ctx.store.table('projects').patch(project.id, { status: 'paused' });
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('不是进行中') });
  });

  it('反例：已完成是终态，不能改回去；不允许设成瞬时的已驳回', async () => {
    const { ctx, tc, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写报告', status: 'accepted' });
    const task = ctx.store.table('projectTasks').list()[0]!;
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, taskId: task.id, status: 'doing' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('终态') });
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'y', status: 'rejected' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('状态必须是') });
  });

  it('L0 不能用，试岗（L1）能用，反思回合只读', async () => {
    const { ctx, tc, bot, wake, project } = fixture();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('L0') });
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'probation' });
    expect((await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'x' })).ok).toBe(true);
    ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    expect(await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: 'y' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只读') });
  });
});

describe('P60 hub_project_background_update', () => {
  it('负责人直接更新背景：写文件、记谁什么时候改的、留修订，来源是负责人更新', async () => {
    const { ctx, tc, project } = fixture();
    const now = ctx.clock.now();
    expect((await runTool(ctx, tc, 'hub_project_background_update', { projectId: project.id, background: '已经完成第一版，下一步找用户验证。' })).ok).toBe(true);
    const saved = ctx.store.table('projects').get(project.id)!;
    expect(saved.context.background).toBe('已经完成第一版，下一步找用户验证。');
    expect(saved).toMatchObject({ backgroundUpdatedAt: now, backgroundUpdatedBy: tc.botId });
    expect(saved.contextRevisions.at(-1)).toMatchObject({ source: 'owner_bot', editorKind: 'bot', editorId: tc.botId });
    expect(await ctx.fs.readText(`${project.sharedDir}context.md`)).toContain('已经完成第一版');
    expect(ctx.store.table('projectContextProposals').count()).toBe(0);
  });

  it('内容没变不留新修订', async () => {
    const { ctx, tc, project } = fixture();
    await runTool(ctx, tc, 'hub_project_background_update', { projectId: project.id, background: '同一段背景' });
    const result = await runTool(ctx, tc, 'hub_project_background_update', { projectId: project.id, background: '同一段背景' });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('没有变化') });
    expect(ctx.store.table('projects').get(project.id)!.contextRevisions).toHaveLength(1);
  });

  it('反例：普通成员不能更新；超过 2000 字、项目不是进行中都被拒', async () => {
    const { ctx, tc, peerTc, project } = fixture();
    expect(await runTool(ctx, peerTc, 'hub_project_background_update', { projectId: project.id, background: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('负责人') });
    expect(await runTool(ctx, tc, 'hub_project_background_update', { projectId: project.id, background: '字'.repeat(2001) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('2000') });
    ctx.store.table('projects').patch(project.id, { status: 'paused' });
    expect(await runTool(ctx, tc, 'hub_project_background_update', { projectId: project.id, background: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('不是进行中') });
    expect(ctx.store.table('projects').get(project.id)!.context.background).toBe('');
  });
});

describe('P60 工具注册与成员提示', () => {
  it('建议工具不再注册给队友，文件和服务保留以兼容旧数据', async () => {
    const { ctx, tc, project } = fixture();
    expect(buildTools(ctx).some(tool => tool.name === 'hub_project_context_propose')).toBe(false);
    expect(await runTool(ctx, tc, 'hub_project_context_propose', { projectId: project.id, background: 'x', note: 'y' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('未知机器人工具') });
    expect(hubProjectContextPropose.name).toBe('hub_project_context_propose');
  });

  it('成员交付：提示等负责人确认', async () => {
    const { ctx, tc, peer, peerTc, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写报告', assigneeBotId: peer.id });
    const task = ctx.store.table('projectTasks').list()[0]!;
    expect(await runTool(ctx, peerTc, 'hub_task_update', { taskId: task.id, action: 'report_done' }))
      .toMatchObject({ ok: true, text: expect.stringContaining('等项目负责人确认') });
  });

  it('负责人自己的事务：提示用工具改状态，不用等主人', async () => {
    const { ctx, tc, bot, project } = fixture();
    await runTool(ctx, tc, 'hub_project_task_upsert', { projectId: project.id, title: '写报告', assigneeBotId: bot.id });
    const task = ctx.store.table('projectTasks').list()[0]!;
    const result = await runTool(ctx, tc, 'hub_task_update', { taskId: task.id, action: 'report_done' });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('hub_project_task_upsert') });
    if (result.ok) expect(result.text).not.toContain('等主人验收');
  });
});

describe('P60 saveProject 默认负责人', () => {
  const put = (ctx: HubContext, n: number, patch: Partial<Bot>): Bot => {
    const id = `b_${String(n).padStart(10, '0')}`;
    const bot: Bot = { ...botFixture, id, name: `队友${n}`, homeDir: `/hub/bots/${id}`, ...patch };
    ctx.store.table('bots').put(bot);
    return bot;
  };

  it('没传时默认总管，界面传 null（未指定）也按默认补', () => {
    const ctx = createTestContext();
    const a = put(ctx, 1, { role: 'executor' });
    const chief = put(ctx, 2, { role: 'chief' });
    expect(saveProject(ctx, { name: 'P', memberBotIds: [a.id, chief.id] }).ownerBotId).toBe(chief.id);
    expect(saveProject(ctx, { name: 'Q', ownerBotId: null, memberBotIds: [a.id, chief.id] }).ownerBotId).toBe(chief.id);
  });

  it('没有总管就选第一位非建议风格的成员', () => {
    const ctx = createTestContext();
    const advisor = put(ctx, 1, { role: 'advisor' });
    const worker = put(ctx, 2, { role: 'researcher' });
    expect(saveProject(ctx, { name: 'P', memberBotIds: [advisor.id, worker.id] }).ownerBotId).toBe(worker.id);
  });

  it('显式指定优先于默认', () => {
    const ctx = createTestContext();
    const chief = put(ctx, 1, { role: 'chief' });
    const worker = put(ctx, 2, { role: 'executor' });
    expect(saveProject(ctx, { name: 'P', ownerBotId: worker.id, memberBotIds: [chief.id, worker.id] }).ownerBotId).toBe(worker.id);
  });

  it('反例：建议风格不能当负责人，中文报错', () => {
    const ctx = createTestContext();
    const advisor = put(ctx, 1, { role: 'advisor', name: '军师' });
    expect(() => saveProject(ctx, { name: 'P', ownerBotId: advisor.id, memberBotIds: [advisor.id] })).toThrow('建议风格');
    expect(ctx.store.table('projects').count()).toBe(0);
  });

  it('没有可选成员时允许为空（先建项目后加人）', () => {
    const ctx = createTestContext();
    const advisor = put(ctx, 1, { role: 'advisor' });
    expect(saveProject(ctx, { name: 'P', memberBotIds: [] }).ownerBotId).toBeNull();
    expect(saveProject(ctx, { name: 'Q', memberBotIds: [advisor.id] }).ownerBotId).toBeNull();
  });

  it('修改项目时沿用负责人；旧项目为空时按同规则补上', () => {
    const ctx = createTestContext();
    const worker = put(ctx, 1, { role: 'executor' });
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [worker.id] });
    expect(saveProject(ctx, { id: saved.id, name: '改名' }).ownerBotId).toBe(worker.id);
    ctx.store.table('projects').patch(saved.id, { ownerBotId: null });
    expect(saveProject(ctx, { id: saved.id, name: '再改名' }).ownerBotId).toBe(worker.id);
  });

  it('负责人退役或被移出成员时不卡住保存，重新选一位', () => {
    const ctx = createTestContext();
    const first = put(ctx, 1, { role: 'chief' });
    const second = put(ctx, 2, { role: 'executor' });
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [first.id, second.id] });
    expect(saveProject(ctx, { id: saved.id, name: 'P', memberBotIds: [second.id] }).ownerBotId).toBe(second.id);
    ctx.store.table('bots').patch(second.id, { lifecycle: 'retired' });
    expect(saveProject(ctx, { id: saved.id, name: 'P', memberBotIds: [] }).ownerBotId).toBeNull();
  });

  it('旧项目的负责人已是建议风格时，不改负责人仍能保存；改成建议风格被拒', () => {
    const ctx = createTestContext();
    const advisor = put(ctx, 1, { role: 'advisor' });
    const worker = put(ctx, 2, { role: 'executor' });
    const saved = saveProject(ctx, { name: 'P', memberBotIds: [advisor.id, worker.id] });
    ctx.store.table('projects').patch(saved.id, { ownerBotId: advisor.id });
    expect(saveProject(ctx, { id: saved.id, name: '改名', ownerBotId: advisor.id }).name).toBe('改名');
    ctx.store.table('projects').patch(saved.id, { ownerBotId: worker.id });
    expect(() => saveProject(ctx, { id: saved.id, name: '改名', ownerBotId: advisor.id })).toThrow('建议风格');
  });
});
