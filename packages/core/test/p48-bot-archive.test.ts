/**
 * P48 队友归档 / 恢复 / 删除。
 *
 * 覆盖三件事：
 * - 数据层用可恢复的 archivedAt 软标记，旧档没有该字段时按未归档读取，零迁移；
 * - 归档前置校验：未退役、仍是项目成员、身上有未结任务（进行中/待验收）都拒绝，并说清数量；
 * - 删除只清理 bots 与 botProfiles，历史线程查询不报错，引用处显示「已删除的队友」。
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { BotSchema, botIsArchived, botRosterState } from '../src/model/bot.js';
import type { Bot } from '../src/model/bot.js';
import { postThread } from '../src/outreach/thread.js';

describe('P48 状态口径与旧档兼容', () => {
  it('旧数据没有 archivedAt：解析不报错，按未归档计算', async () => {
    const { bot } = await apiFixture();
    // 模拟旧档：序列化后删掉新字段，再用 BotSchema 重新解析。
    const legacy = JSON.parse(JSON.stringify(bot)) as Record<string, unknown>;
    delete legacy.archivedAt;
    const parsed = BotSchema.parse(legacy);
    expect(parsed.archivedAt).toBeUndefined();
    expect(botIsArchived(parsed)).toBe(false);
    expect(botRosterState(parsed)).toBe('active');
  });

  it('在岗/试岗=活跃，退役=不唤醒，归档=不在名单显示，三者互斥', async () => {
    const { bot } = await apiFixture();
    const at = (patch: Partial<Bot>): Bot => ({ ...bot, ...patch });
    // 在岗与试岗都算活跃。
    expect(botRosterState(at({ lifecycle: 'active', archivedAt: null }))).toBe('active');
    expect(botRosterState(at({ lifecycle: 'probation' }))).toBe('active');
    // 退役但未归档：仍在名单里，只是不唤醒。
    expect(botRosterState(at({ lifecycle: 'retired', archivedAt: null }))).toBe('retired');
    // 归档标记优先：即使生命周期还是退役，也归入归档区。
    expect(botRosterState(at({ lifecycle: 'retired', archivedAt: 1_760_000_000_000 }))).toBe('archived');
    // 其余状态（草稿/暂停/隔离）属于非活跃，但不等于退役或归档。
    expect(botRosterState(at({ lifecycle: 'paused' }))).toBe('inactive');
    expect(botRosterState(at({ lifecycle: 'quarantined' }))).toBe('inactive');
    expect(botRosterState(at({ lifecycle: 'draft' }))).toBe('inactive');
  });
});

describe('P48 归档与恢复', () => {
  it('未退役拒绝归档并说清缺哪一项；退役后归档只写标记，历史原样保留', async () => {
    const { ctx, api, bot } = await apiFixture();
    // 先留一条历史消息，验证归档与恢复都不动线程。
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text: '我还在' });

    const blocked = okData(await api.archiveBotCheck(bot.id));
    expect(blocked).toMatchObject({ botId: bot.id, canArchive: false, projectCount: 0, openTaskCount: 0 });
    expect(blocked.reason).toContain('先退役');
    const rejected = await api.archiveBot(bot.id);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('先退役');

    okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }));
    const check = okData(await api.archiveBotCheck(bot.id));
    expect(check.canArchive).toBe(true);
    expect(check.reason).toBeNull();

    const targetCounts = () => ({
      wakes: ctx.store.table('wakes').list().length,
      ledger: ctx.store.table('wakeLedger').list().length,
      projects: ctx.store.table('projects').list().length,
      tasks: ctx.store.table('projectTasks').list().length,
      artifacts: ctx.store.table('artifactHeads').list().length,
    });
    const before = targetCounts();
    const archived = okData(await api.archiveBot(bot.id));
    expect(archived.archivedAt).toBe(ctx.clock.now());
    expect(botRosterState(archived)).toBe('archived');
    // 账本、项目、任务、产物一行不少：归档只是可恢复的显示标记。
    expect(targetCounts()).toEqual(before);
    // 总览仍返回它，左栏靠 archived 标记把它放进折叠区。
    expect(api.overview().bots.find(row => row.id === bot.id)?.archived).toBe(true);
    expect(api.thread(bot.id).messages.map(message => message.text)).toContain('我还在');
    expect(ctx.store.log('audit').all().some(row => row.action === 'ui_archiveBot')).toBe(true);

    // 恢复：回到「已退役、仍在名单里」，历史仍原样。
    const restored = okData(await api.restoreArchivedBot(bot.id));
    expect(restored.archivedAt).toBeNull();
    expect(botRosterState(restored)).toBe('retired');
    expect(api.overview().bots.find(row => row.id === bot.id)?.archived).toBe(false);
    expect(api.thread(bot.id).messages.map(message => message.text)).toContain('我还在');
    // 没归档时恢复要给中文错误，不能假装成功。
    const again = await api.restoreArchivedBot(bot.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('没有归档');
  });

  it('仍是项目成员或有未结任务时拒绝归档，并列出项目名与数量', async () => {
    const { ctx, api, bot } = await apiFixture();
    const project = okData(await api.saveProject({ name: '周报项目', memberBotIds: [bot.id] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: '写周报', assigneeBotId: bot.id }));
    // saveTask 只建待办；直接 patch 成进行中，模拟队友已开工。
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }));

    const check = okData(await api.archiveBotCheck(bot.id));
    expect(check).toMatchObject({ canArchive: false, projectCount: 1, openTaskCount: 1 });
    expect(check.projects).toEqual([{ projectId: project.id, projectName: '周报项目', member: true, openTaskCount: 1 }]);
    expect(check.reason).toContain('周报项目');
    expect(check.reason).toContain('1 个未结任务');
    expect(check.reason).toContain('还是 1 个项目的成员');
    const rejected = await api.archiveBot(bot.id);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('先交接');
    expect(ctx.store.table('bots').get(bot.id)?.archivedAt).toBeUndefined();

    // 交接：先移出成员，再把任务验收通过；两项都清了才能归档。
    okData(await api.saveProject({ id: project.id, name: '周报项目', memberBotIds: [] }));
    ctx.store.table('projectTasks').patch(task.id, { status: 'accepted' });
    const cleared = okData(await api.archiveBotCheck(bot.id));
    expect(cleared).toMatchObject({ canArchive: true, projectCount: 0, openTaskCount: 0, projects: [] });
    expect(okData(await api.archiveBot(bot.id)).archivedAt).not.toBeNull();
  });

  it('待验收也算未结；已归档项目不再拦住归档', async () => {
    const { ctx, api, bot } = await apiFixture();
    const archivedProject = okData(await api.saveProject({ name: '旧项目', memberBotIds: [bot.id] }));
    const project = okData(await api.saveProject({ name: '在跑项目', memberBotIds: [] }));
    const task = okData(await api.saveTask({ projectId: project.id, title: '收尾工作' }));
    // 成员被移走后仍有指派给他的任务：只剩任务这条约束。
    ctx.store.table('projectTasks').patch(task.id, { assigneeBotId: bot.id, status: 'done_pending_check' });
    okData(await api.archiveProject(archivedProject.id));
    okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }));

    const check = okData(await api.archiveBotCheck(bot.id));
    expect(check).toMatchObject({ canArchive: false, projectCount: 0, openTaskCount: 1 });
    expect(check.projects).toEqual([{ projectId: project.id, projectName: '在跑项目', member: false, openTaskCount: 1 }]);
    // 已归档项目是历史，不该再拦住归档。
    expect(check.reason).not.toContain('旧项目');
    expect(check.reason).toContain('待验收');
  });
});

describe('P48 删除', () => {
  it('只有已归档的队友可以删除；删除后历史引用显示「已删除的队友」', async () => {
    const { ctx, api, bot } = await apiFixture();
    // 建一条队友档案（botProfiles）与两条历史消息，验证删除范围。
    okData(await api.updateBot(bot.id, { mbti: 'INTJ' }));
    expect(ctx.store.table('botProfiles').get(bot.id)).not.toBeNull();
    postThread(ctx, { thread: bot.id, from: 'hub', kind: 'system', text: '系统记录' });
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text: '队友原话' });

    // 未归档不能删：避免把名单里的队友误删。
    const early = await api.deleteArchivedBot(bot.id);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toContain('先归档');
    expect(ctx.store.table('bots').get(bot.id)).not.toBeNull();

    okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }));
    okData(await api.archiveBot(bot.id));
    expect((await api.deleteArchivedBot(bot.id)).ok).toBe(true);

    // 配置与档案删掉，历史一行不动。
    expect(ctx.store.table('bots').get(bot.id)).toBeNull();
    expect(ctx.store.table('botProfiles').get(bot.id)).toBeNull();
    const thread = api.thread(bot.id);
    expect(thread.title).toBe('已删除的队友');
    // 退役时中心会追加一条系统消息；这里只核对删除前后原样保留的两条历史。
    expect(thread.messages.slice(0, 2).map(message => message.text)).toEqual(['系统记录', '队友原话']);
    expect(thread.messages[0]?.fromName).toBe('Agent 中心');
    expect(thread.messages[1]?.fromName).toBe('已删除的队友');
    expect(thread.messages.every(message => message.fromName !== bot.id)).toBe(true);
    expect(ctx.store.log('audit').all().some(row => row.action === 'ui_deleteArchivedBot')).toBe(true);

    // 再删一次要报不存在，而不是默默成功。
    const gone = await api.deleteArchivedBot(bot.id);
    expect(gone.ok).toBe(false);
  });
});
