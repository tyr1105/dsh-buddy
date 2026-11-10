/**
 * P60/P63 给界面的视图字段与旧数据读取：
 * 项目视图的成员、事务、背景、路径、主题，账本的项目名和事项名，
 * 以及旧存档（缺新字段、缺新表）能正常读。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import { FileStore } from '../src/store/index.js';
import { projectView } from '../src/api/project-views.js';
import { threadView } from '../src/api/feed-views.js';
import { saveProjectContext } from '../src/project/context-service.js';
import { lastPacket, openTopic, runningWake, speak, topicHub } from './p63-topic-fixtures.js';

describe('P60 项目视图字段', () => {
  it('成员带名字、角色、是否负责人；路径两个都给', async () => {
    const fix = await topicHub();
    const [owner, wang] = fix.bots;
    const row = fix.hub.api.projectView().projects[0]!;
    expect(row.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ botId: owner!.id, name: '老大', role: 'chief', roleLabel: '总管', isOwner: true, invalid: false }),
      expect.objectContaining({ botId: wang!.id, name: '小王', role: 'executor', roleLabel: '执行', isOwner: false }),
    ]));
    expect(row.path).toEqual({ workspaceDir: row.project.sharedDir, sharedDir: row.project.sharedDir });
  });

  it('事务直接给标题、跟进人名字、状态文案和主题 id', async () => {
    const fix = await topicHub();
    const [owner, wang] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const tool = fix.hub.tools().find(item => item.name === 'hub_project_task_upsert')!;
    expect(await tool.handler(owner!.sessionId!, { projectId: fix.project.id, title: '写报告', assigneeBotId: wang!.id }))
      .toMatchObject({ ok: true });
    const task = fix.hub.api.projectView().projects[0]!.tasks[0]!;
    expect(task).toMatchObject({ title: '写报告', assigneeName: '小王', statusLabel: '进行中', topicId });
    // 旧字段保留，界面重做前老代码还在读。
    expect(task.task.title).toBe('写报告');
    expect(task.assigneeBotName).toBe('小王');
  });

  it('背景带更新人和时间；没更新过时都是空，不编造', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    expect(fix.hub.api.projectView().projects[0]!.background).toEqual({ text: '', updatedBy: null, updatedByName: null, updatedAt: null, updatedText: null });
    await openTopic(fix, '开工');
    const tool = fix.hub.tools().find(item => item.name === 'hub_project_background_update')!;
    expect(await tool.handler(owner!.sessionId!, { projectId: fix.project.id, background: '第一版做完了' })).toMatchObject({ ok: true });
    const background = fix.hub.api.projectView().projects[0]!.background;
    expect(background).toMatchObject({ text: '第一版做完了', updatedBy: owner!.id, updatedByName: '老大' });
    expect(background.updatedText).not.toBeNull();
  });

  it('主人编辑背景时更新人显示主人；改别的段不更新背景时间', async () => {
    const fix = await topicHub();
    await saveProjectContext(fix.ctx, { projectId: fix.project.id, background: '主人写的背景' });
    expect(fix.hub.api.projectView().projects[0]!.background).toMatchObject({ updatedBy: 'owner', updatedByName: '主人' });
    const before = fix.ctx.store.table('projects').get(fix.project.id)!.backgroundUpdatedAt;
    fix.ctx.clock.advance(1_000);
    await saveProjectContext(fix.ctx, { projectId: fix.project.id, conventions: '只改约定' });
    expect(fix.ctx.store.table('projects').get(fix.project.id)!.backgroundUpdatedAt).toBe(before);
  });

  it('主题列表：最近有消息的在前，带未读和预览', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const older = await openTopic(fix, '第一个主题');
    await speak(fix, owner!, `这是一条很长的回复${'字'.repeat(100)}`);
    fix.ctx.clock.advance(1_000);
    const newer = await openTopic(fix, '第二个主题');
    const topics = fix.hub.api.projectView().projects[0]!.topics;
    expect(topics.map(topic => topic.id)).toEqual([newer, older]);
    expect(topics[0]).toMatchObject({ title: '第二个主题', unread: 0, lastMessagePreview: '第二个主题', lastMessageFrom: '主人' });
    expect(topics[1]).toMatchObject({ unread: 1, lastMessageFrom: '老大' });
    expect(topics[1]!.lastMessagePreview!.length).toBeLessThanOrEqual(61);
    expect(topics[1]!.lastMessageAt).toBeGreaterThan(0);
  });

  it('主题的新消息会发 thread（带主题 id）和 project 事件，界面靠它们刷新', async () => {
    const ctx = createTestContext();
    const { botFixture } = await import('./model-fixtures.js');
    const { saveProject } = await import('../src/project/service.js');
    const { createProjectTopic } = await import('../src/project/topics.js');
    ctx.store.table('bots').put({ ...botFixture });
    const project = saveProject(ctx, { name: 'P', memberBotIds: [botFixture.id] });
    ctx.events.length = 0;
    const { topicId } = createProjectTopic(ctx, { projectId: project.id, text: '开工' });
    expect(ctx.events).toContainEqual({ scope: 'thread', botId: topicId });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
    expect(threadView(ctx, topicId).title).toBe('开工');
  });
});

describe('P63 账本行的项目名和事项名', () => {
  it('主题回合给项目名和主题名', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '竞品周报怎么做');
    expect(runningWake(fix.ctx, owner!.id)).toBeDefined();
    await speak(fix, owner!, '收到');
    const rows = fix.hub.api.wakeLedgerList(owner!.id);
    expect(rows[0]).toMatchObject({ projectName: '季度战役', itemTitle: '竞品周报怎么做' });
    expect(fix.ctx.store.table('wakeLedger').list(row => row.botId === owner!.id)[0]!.trigger.topicId).toBeTruthy();
  });

  it('普通回合给空，不编造项目名', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await fix.hub.api.sendMessage(owner!.id, '私聊一句');
    await speak(fix, owner!, '收到');
    expect(fix.hub.api.wakeLedgerList(owner!.id)[0]).toMatchObject({ projectName: null, itemTitle: null });
  });

  it('推进过事务的回合给项目名和事务名', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await fix.hub.api.sendMessage(owner!.id, '私聊一句');
    const wake = runningWake(fix.ctx, owner!.id)!;
    const now = fix.ctx.clock.now();
    fix.ctx.store.table('projectTasks').put({ id: 'pt_0000000001', projectId: fix.project.id, title: '写周报', detail: '', assigneeBotId: owner!.id,
      status: 'doing', wakeIds: [wake.id], artifactIds: [], createdAt: now, updatedAt: now, dueAt: null });
    await speak(fix, owner!, '收到');
    expect(fix.hub.api.wakeLedgerList(owner!.id)[0]).toMatchObject({ projectName: '季度战役', itemTitle: '写周报' });
  });
});

describe('P60/P63 旧数据读取', () => {
  it('旧存档缺新字段、缺主题表：能读，项目页字段给空值', async () => {
    const now = Date.parse('2026-11-05T10:00:00+08:00');
    const clock = new FakeClock(now);
    const fs = new MemoryFs(clock);
    const stateDir = '/hub/.hub/state';
    await fs.writeTextAtomic(`${stateDir}/projects.json`, JSON.stringify([{
      id: 'prj_0000000001', name: '老项目', charter: '', vision: '', conventions: '', status: 'active', ownerBotId: null, memberBotIds: [],
      sharedDir: '/hub/projects/prj_0000000001/', acceptanceCriteria: [], context: { background: '', conventions: '', decisions: [], glossary: [] },
      contextRevisions: [], createdAt: now, updatedAt: now, archivedAt: null,
    }]));
    await fs.writeTextAtomic(`${stateDir}/projectTasks.json`, JSON.stringify([{
      id: 'pt_0000000001', projectId: 'prj_0000000001', title: '老任务', detail: '', assigneeBotId: null, status: 'todo',
      wakeIds: [], artifactIds: [], createdAt: now, updatedAt: now, dueAt: null,
    }]));
    const store = new FileStore(fs, clock, '/hub', 'Asia/Shanghai', new MemoryLogger());
    await store.load();
    expect(store.table('projectTopics').count()).toBe(0);
    const row = projectView(createTestContext({ store })).projects[0]!;
    expect(row.topics).toEqual([]);
    expect(row.background).toEqual({ text: '', updatedBy: null, updatedByName: null, updatedAt: null, updatedText: null });
    expect(row.tasks[0]).toMatchObject({ title: '老任务', topicId: null, assigneeName: null });
  });

  it('线程视图读不存在的主题时不抛错，沿用已删除的提示', () => {
    const ctx = createTestContext();
    expect(threadView(ctx, 'ptp_0000000099').title).toBe('已删除的队友');
  });
});

describe('P63 主题回合的唤醒包仍带基本信息', () => {
  it('带上限说明和规矩，不会因为主题段挤掉固定内容', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('## 规矩');
    expect(packet).toContain('## 本次上限');
  });
});
