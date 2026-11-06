/** 界面命令验收：覆盖创建、权限边界、生命周期、业务归属和失败审计，拒绝半成品进入名册。 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { requestApproval } from '../src/gate/approvals.js';
import { saveRoutine } from '../src/routines/save.js';
import { proposeWatch } from '../src/tools/hub-watch-propose.js';
import { WakeTicketSchema } from '../src/model/wake.js';
import { modelFixtures } from './model-fixtures.js';
import { apiFixture, okData } from './c04-api-fixtures.js';

const DAY = 86_400_000;
const newBot = { name: '小守', role: 'sentinel', persona: '安静盯守', aspirations: ['关注变化'] };

describe('C04 创建与档案命令', () => {
  it('创建试岗家目录、志向、主人发起 trial 并刷盘审计', async () => {
    const { ctx, bot, after } = await apiFixture();
    expect(bot.lifecycle).toBe('probation');
    expect(bot.probationEndsAt).toBe(ctx.clock.now() + ctx.settings.probationMs);
    for (const path of ['AGENTS.md', 'memory/MEMORY.md', 'mind/goals.md', 'mind/agenda.md', 'mind/watches.md'])
      expect(await ctx.fs.readText(`${bot.homeDir}/${path}`)).not.toBeNull();
    const entry = ctx.store.table('queue').list()[0]!;
    expect(entry).toMatchObject({ variant: 'trial', ownerInitiated: true, priority: 100 });
    expect(entry.reason.evidence.length).toBeGreaterThan(0);
    expect(after).toHaveBeenCalledOnce();
    expect(ctx.store.isDirty()).toBe(false);
    expect(ctx.store.log('audit').all().some(row => row.action === 'ui_createBot')).toBe(true);
  });
  it.each([
    { name: ' ' }, { name: '长'.repeat(21) }, { aspirations: [] }, { aspirations: ['一', '二', '三', '四'] },
    { role: 'unknown' }, { autonomy: 'L9' }, { model: { provider: '', model: 'x' } }, { sessionId: 'injected' },
  ])('非法创建输入不改变名册并仍刷盘：%j', async patch => {
    const { ctx, api, after } = await apiFixture();
    const result = await api.createBot({ ...newBot, ...patch });
    expect(result.ok).toBe(false);
    expect(ctx.store.table('bots').count()).toBe(1);
    expect(after).toHaveBeenCalledTimes(2);
    expect(ctx.store.log('audit').all().at(-1)?.detail).toContain('false');
  });
  it('并发同名创建只有一个成功，总管也不能重复', async () => {
    const { ctx, api } = await apiFixture();
    const results = await Promise.all([api.createBot(newBot), api.createBot(newBot)]);
    expect(results.filter(row => row.ok)).toHaveLength(1);
    expect((await api.createBot({ ...newBot, name: '总管一', role: 'chief' })).ok).toBe(true);
    expect((await api.createBot({ ...newBot, name: '总管二', role: 'chief' })).ok).toBe(false);
    expect(ctx.store.table('bots').count()).toBe(3);
  });
  it('达到六个上限后不能再建；退役保留历史但释放当前队伍名额', async () => {
    const { api, ctx, bot } = await apiFixture();
    for (let i = 0; i < 5; i++) expect((await api.createBot({ ...newBot, name: `成员${i}` })).ok).toBe(true);
    expect((await api.createBot(newBot)).ok).toBe(false);
    expect((await api.setLifecycle(bot.id, 'retired')).ok).toBe(true);
    expect((await api.createBot(newBot)).ok).toBe(true);
    expect((await api.createBot({ ...newBot, name: '另一个成员' })).ok).toBe(false);
    expect(ctx.store.table('bots').count()).toBe(7);
    expect(ctx.store.table('bots').count(row => row.lifecycle !== 'retired')).toBe(6);
  });
  it('初始目标和关注全部预检，目标归属错误不残留半成品', async () => {
    const { api, ctx } = await apiFixture();
    const invalid = await api.createBot({ ...newBot, goals: [{ title: '一', doneWhen: '有证据', period: 'week', aspirationIndex: 9 }] });
    expect(invalid.ok).toBe(false);
    expect(ctx.store.table('bots').count()).toBe(1);
    const created = okData(await api.createBot({ ...newBot, goals: [{ title: '一', doneWhen: '有证据', period: 'week' }],
      watches: [{ kind: 'http', target: 'https://example.test/a', why: '公开变化' }] }));
    expect(ctx.store.table('goals').list(row => row.botId === created.id)[0]?.createdBy).toBe('owner');
    expect(created.lightCheckAt).toBe(ctx.clock.now() + ctx.settings.paceMaxActiveGoalMs);
    expect(ctx.store.table('watches').list(row => row.botId === created.id)[0]?.intervalMs).toBe(ctx.settings.httpMinIntervalMs);
  });
  it('家目录写入失败撤回新机器人与关联记录', async () => {
    const { ctx, api } = await apiFixture();
    vi.spyOn(ctx.fs, 'writeTextAtomic').mockRejectedValueOnce(new Error('模拟文件写入失败'));
    expect((await api.createBot(newBot)).ok).toBe(false);
    expect(ctx.store.table('bots').count()).toBe(1);
    expect(ctx.store.table('aspirations').count()).toBe(1);
  });
  it('档案允许主人设 L3，拒绝同名和运行态字段', async () => {
    const { api, ctx, bot } = await apiFixture();
    expect((await api.updateBot(bot.id, { autonomy: 'L3', persona: '核实后执行', workDataAllowed: true })).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.autonomy).toBe('L3');
    const peer = okData(await api.createBot(newBot));
    expect((await api.updateBot(bot.id, { name: peer.name })).ok).toBe(false);
    expect((await api.updateBot(bot.id, { violations: 0 })).ok).toBe(false);
    expect((await api.updateBot('missing', { name: '未知' })).ok).toBe(false);
  });
});

describe('C04 生命周期', () => {
  it('试岗满三天无越界可提前转正，之前拒绝', async () => {
    const { api, ctx, bot } = await apiFixture();
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(false);
    ctx.clock.advance(3 * DAY);
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.probationEndsAt).toBeNull();
  });
  it('有越界不能提前转正，暂停恢复不能绕开试岗', async () => {
    const { api, ctx, bot } = await apiFixture();
    expect((await api.setLifecycle(bot.id, 'paused')).ok).toBe(true);
    expect(ctx.store.table('queue').count()).toBe(0);
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(false);
    expect((await api.setLifecycle(bot.id, 'probation')).ok).toBe(true);
    ctx.clock.advance(3 * DAY);
    ctx.store.table('bots').patch(bot.id, { violations: 1 });
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(false);
  });
  it('暂停中消息保留，恢复后重新进入候选', async () => {
    const { api, ctx, bot } = await apiFixture();
    await api.setLifecycle(bot.id, 'paused');
    await api.sendMessage(bot.id, '回来后核实这条消息');
    for (const row of ctx.store.table('queue').list()) ctx.store.table('queue').remove(row.id);
    await api.setLifecycle(bot.id, 'probation');
    expect(ctx.store.table('queue').list()[0]?.reason.kind).toBe('owner_message');
  });
  it('只有主人显式解除隔离会清零，隔离不能变暂停', async () => {
    const { api, ctx, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'quarantined', consecutiveErrors: 3, violations: 3,
      consecutiveNoCommit: 3, quarantineReason: '反复越界', retryAt: ctx.clock.now() + DAY });
    expect((await api.setLifecycle(bot.id, 'paused')).ok).toBe(false);
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'probation', probationEndsAt: bot.probationEndsAt, consecutiveErrors: 0, violations: 0,
      consecutiveNoCommit: 0, quarantineReason: null, retryAt: null });
  });
  it('暂停或恢复不会把在途回合伪装成空闲', async () => {
    const { api, ctx, bot } = await apiFixture();
    ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, variant: 'reflection',
      status: 'running', startedAt: ctx.clock.now(), dispatchedAt: ctx.clock.now() });
    expect((await api.setLifecycle(bot.id, 'paused')).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.activity).toBe('reflecting');
    expect((await api.setLifecycle(bot.id, 'probation')).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.activity).toBe('reflecting');
  });
  it('退役不可恢复，也不能修改档案', async () => {
    const { api, bot } = await apiFixture();
    await api.setLifecycle(bot.id, 'retired');
    expect((await api.setLifecycle(bot.id, 'active')).ok).toBe(false);
    expect((await api.updateBot(bot.id, { name: '重命名' })).ok).toBe(false);
  });
});

describe('C04 业务命令', () => {
  it('志向维护保留至少一条且最多三条，拒绝跨机器人修改', async () => {
    const { api, bot, aspiration, ctx } = await apiFixture();
    expect((await api.upsertAspiration({ id: aspiration.id, botId: bot.id, text: '新方向', status: 'archived' })).ok).toBe(false);
    for (const text of ['第二方向', '第三方向']) expect((await api.upsertAspiration({ botId: bot.id, text })).ok).toBe(true);
    expect((await api.upsertAspiration({ botId: bot.id, text: '第四方向' })).ok).toBe(false);
    const peer = okData(await api.createBot(newBot));
    expect((await api.upsertAspiration({ id: aspiration.id, botId: peer.id, text: '盗用' })).ok).toBe(false);
    expect(ctx.store.table('aspirations').get(aspiration.id)?.text).toBe(aspiration.text);
  });
  it('目标必须依附本人的志向，验收通过/不通过和放弃各有真实状态', async () => {
    const { api, ctx, bot, aspiration } = await apiFixture();
    const args = { botId: bot.id, aspirationId: aspiration.id, title: '核实事实', doneWhen: '记录来源', period: 'week' };
    expect((await api.upsertGoal({ ...args, aspirationId: 'unknown' })).ok).toBe(false);
    okData(await api.upsertGoal(args));
    const goal = ctx.store.table('goals').list()[0]!;
    expect((await api.closeGoal(goal.id, true)).ok).toBe(false);
    ctx.store.table('goals').patch(goal.id, { status: 'done_pending_check' });
    expect((await api.closeGoal(goal.id, false)).ok).toBe(true);
    expect(ctx.store.table('goals').get(goal.id)?.status).toBe('active');
    ctx.store.table('goals').patch(goal.id, { status: 'done_pending_check' });
    expect((await api.closeGoal(goal.id, true)).ok).toBe(true);
    expect(ctx.store.table('goals').get(goal.id)?.status).toBe('done');
    expect((await api.closeGoal(goal.id, 'abandoned')).ok).toBe(false);
  });
  it('目标增减调整轻复查上界，最后思考锚点不会被编辑推后', async () => {
    const { api, ctx, bot, aspiration } = await apiFixture();
    const anchor = ctx.clock.now();
    ctx.clock.advance(DAY);
    await api.upsertGoal({ botId: bot.id, aspirationId: aspiration.id, title: '核实', doneWhen: '有来源', period: 'week' });
    expect(ctx.store.table('bots').get(bot.id)?.lightCheckAt).toBe(anchor + ctx.settings.paceMaxActiveGoalMs);
    const goal = ctx.store.table('goals').list()[0]!;
    expect((await api.closeGoal(goal.id, 'abandoned')).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.lightCheckAt).toBe(anchor + ctx.settings.paceMaxIdleMs);
  });
  it('关注项拒绝非法 URL、过快轮询和工作数据；允许本地文件并建立监听', async () => {
    const { api, ctx, bot } = await apiFixture();
    const args = { botId: bot.id, kind: 'http', target: 'https://example.test/feed', why: '跟踪资料' };
    for (const patch of [{ target: 'file:///tmp/data' }, { intervalMinutes: 1 }, { filter: '/[/' }])
      expect((await api.upsertWatch({ ...args, ...patch })).ok).toBe(false);
    expect((await api.upsertWatch(args)).ok).toBe(true);
    await api.updateSettings({ workDataPaths: ['/work'] });
    expect((await api.upsertWatch({ botId: bot.id, kind: 'file', target: '/work/private', why: '想看' })).ok).toBe(false);
    expect((await api.upsertWatch({ botId: bot.id, kind: 'file', target: '/hub/shared/readme.md', why: '更新' })).ok).toBe(true);
    expect(ctx.runtime.watchDisposers.size).toBe(1);
  });
  it('非法 glob 与脚本在保存前拒绝，白名单脚本和家内已有脚本可保存', async () => {
    const { api, ctx, bot } = await apiFixture();
    const base = { botId: bot.id, why: '关注变化' };
    expect((await api.upsertWatch({ ...base, kind: 'file', target: '/hub/**/a.txt' })).ok).toBe(false);
    expect((await api.upsertWatch({ ...base, kind: 'script', target: 'node -e something' })).ok).toBe(false);
    expect((await api.upsertWatch({ ...base, kind: 'script', target: 'cat a | cat b' })).ok).toBe(false);
    expect(ctx.store.table('watches').count()).toBe(0);
    expect((await api.upsertWatch({ ...base, kind: 'script', target: 'ls' })).ok).toBe(true);
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/check.js`, 'export const result = 1');
    expect((await api.upsertWatch({ ...base, kind: 'script', target: 'node work/check.js' })).ok).toBe(true);
  });
  it('接受/拒绝关注提议走收件箱，不能重复决定', async () => {
    const { api, ctx, bot } = await apiFixture();
    await proposeWatch(ctx, bot.id, { kind: 'http', target: 'https://example.test/feed', why: '观察公开变化' });
    const watch = ctx.store.table('watches').list()[0]!;
    expect((await api.decideWatchProposal(watch.id, true)).ok).toBe(true);
    expect(ctx.store.table('watches').get(watch.id)?.status).toBe('active');
    expect((await api.decideWatchProposal(watch.id, false)).ok).toBe(false);
  });
  it('问题回答、审批决定和规矩均通过既有业务模块', async () => {
    const { api, ctx, bot } = await apiFixture();
    const question = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '选哪个', body: '需要选择',
      options: ['一', '二'], defaultOption: '二', priority: 'P1', subjectKey: 'choice', expiresAt: ctx.clock.now() + DAY });
    expect((await api.answerInbox(question.id, '一')).ok).toBe(true);
    expect((await api.answerInbox(question.id, '二')).ok).toBe(false);
    const approval = await requestApproval(ctx, bot.id, 'run_command', { command: 'send' }, 'C', '发送已核实结果');
    expect((await api.decideApproval(approval.id, true, '仅这一次')).ok).toBe(true);
    expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('approved');
    expect((await api.decideApproval(approval.id, true)).ok).toBe(false);
    expect((await api.upsertRule({ scope: bot.id, text: '先核实来源', redLine: true })).ok).toBe(true);
    expect((await api.upsertRule({ scope: 'missing', text: '不明范围' })).ok).toBe(false);
  });
  it('套路可编辑并保存文件，教学入队 teach，未知套路返回错误', async () => {
    const { api, ctx, bot } = await apiFixture();
    const routine = await saveRoutine(ctx, bot.id, { name: '检查来源', whenToUse: '有新消息', steps: ['核对地址'] });
    expect((await api.editRoutine(routine.id, { steps: ['核对日期', '核对原文'] })).ok).toBe(true);
    expect(await ctx.fs.readText(`${bot.homeDir}/playbooks/${routine.slug}.md`)).toContain('核对日期');
    expect((await api.editRoutine('unknown', { steps: [] })).ok).toBe(false);
    for (const row of ctx.store.table('queue').list()) ctx.store.table('queue').remove(row.id);
    ctx.host.digests.set('lesson', '打开资料、核对来源、记录结论');
    expect((await api.teach(bot.id, 'lesson', '学会核实')).ok).toBe(true);
    expect(ctx.store.table('queue').list()[0]?.variant).toBe('teach');
  });
  it('设置深合并、落盘并保持原值；拒绝迁移根目录及非法配置', async () => {
    const { api, ctx } = await apiFixture();
    expect((await api.updateSettings({ paceMinMsByRole: { sentinel: 600_000 } })).ok).toBe(true);
    expect(ctx.settings.paceMinMsByRole.sentinel).toBe(600_000);
    expect(ctx.settings.paceMinMsByRole.researcher).toBe(3_600_000);
    expect(ctx.store.table('settings').get('settings')?.paceMinMsByRole.sentinel).toBe(600_000);
    expect((await api.updateSettings({ rootDir: '/elsewhere' })).ok).toBe(false);
    expect((await api.updateSettings({ timezone: 'Mars/Somewhere' })).ok).toBe(false);
    expect((await api.updateSettings({ maxBots: 0 })).ok).toBe(false);
    expect((await api.updateSettings({ unexpected: 1 })).ok).toBe(false);
  });
  it('所有失败也调用调度保存出口；保存失败不能谎报成功', async () => {
    const ctx = createTestContext();
    const after = vi.fn(async () => { throw new Error('模拟保存故障'); });
    const api = createUiApi(ctx, after);
    const result = await api.sendMessage('unknown', '消息');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('保存失败') });
    expect(after).toHaveBeenCalledOnce();
    expect(ctx.store.log('audit').all().at(-1)?.action).toBe('ui_sendMessage');
  });
});
