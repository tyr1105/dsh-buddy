/** 界面视图验收：字段契约、同戳分页、实时卡片状态和七日主动性统计都来自真实存储记录。 */
import { describe, expect, it, vi } from 'vitest';
import { apiFixture } from './c04-api-fixtures.js';
import { postThread } from '../src/outreach/thread.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { newId } from '../src/util/ids.js';
import { AgendaItemSchema, CommitSchema, WakeTicketSchema } from '../src/model/index.js';
import { modelFixtures } from './model-fixtures.js';
import { saveRoutine } from '../src/routines/save.js';
import { proposeWatch } from '../src/tools/hub-watch-propose.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('C04 总览与详情视图', () => {
  it('总览保留 15.1 字段与中文标签，试岗预算减半，空历史明确显示未知', async () => {
    const { api, ctx, bot } = await apiFixture();
    const view = api.overview();
    expect(view.bots[0]).toMatchObject({ id: bot.id, roleLabel: '调研', initials: '小研', lifecycleLabel: '试岗',
      todayThinks: 0, todayBudget: 3, todayTokens: 0, unread: 0, waitingOwner: false, lastOutcome: null, lastActiveAt: null });
    expect(view.inbox).toEqual({ total: 0, approvals: 0, questions: 0, proposals: 0, alerts: 0 });
    expect(view.quota.light).toBe('green');
    expect(view.quota.resetAt).toBeNull();
    expect(view.nowAt).toBe(ctx.clock.now());
    expect(view.nowText).toMatch(/今天/);
    expect(view.health.ok).toBe(false);
    ctx.runtime.lastHeartbeatAt = ctx.clock.now();
    expect(api.overview().health.ok).toBe(true);
    ctx.clock.advance(ctx.settings.hostDownAfterMs + 1);
    expect(api.overview().health.ok).toBe(false);
    const detail = await api.bot(bot.id);
    expect(detail.stats).toEqual({ thinks7d: 0, intervalCv: null, selfPacedRatio: null, selfInitiated7d: 0, proposalAcceptRate: null, tokens7d: 0 });
    expect(detail.profile.createdAt).toBe(bot.createdAt);
    expect(detail.memoryExcerpt).toContain('长期记忆');
    await expect(api.bot('missing')).rejects.toThrow('机器人不存在');
  });
  it('关注提议、套路、规矩和目标都直接进入详情并携带时间', async () => {
    const { api, ctx, bot, aspiration } = await apiFixture();
    await proposeWatch(ctx, bot.id, { kind: 'http', target: 'https://example.test/new', why: '核实变化' });
    await api.upsertGoal({ botId: bot.id, aspirationId: aspiration.id, title: '周目标', doneWhen: '有三条来源', period: 'week' });
    await api.upsertRule({ scope: 'global', text: '不凭空编造', redLine: true });
    await saveRoutine(ctx, bot.id, { name: '核实来源', whenToUse: '新消息到来', steps: ['找原文', '核对日期'] });
    const view = await api.bot(bot.id);
    expect(view.watches[0]).toMatchObject({ status: 'proposed', createdBy: 'bot', kindLabel: '网页', intervalMs: 900_000 });
    expect(view.routines[0]).toMatchObject({ name: '核实来源', updatedAt: ctx.clock.now(), updatedText: expect.stringContaining('今天') });
    expect(view.rules[0]).toMatchObject({ scope: 'global', redLine: true });
    expect(view.goals[0]).toMatchObject({ title: '周目标', statusLabel: '进行中', lastProgressAt: ctx.clock.now() });
    expect(view.goals[0]!.periodText).toContain('周');
  });
  it('七日统计排除未投递尝试和旧历史，按自定节奏与真实提议回答计算比例', async () => {
    const { api, ctx, bot } = await apiFixture();
    const now = ctx.clock.now();
    const offsets = [-7 * HOUR, -6 * HOUR, 0];
    for (const [index, offset] of offsets.entries()) {
      const wakeId = newId('w', ctx.rng);
      const commitId = newId('c', ctx.rng);
      ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: wakeId, botId: bot.id,
        status: 'committed', startedAt: now + offset, dispatchedAt: now + offset, endedAt: now + offset + 1000, commitId });
      ctx.store.table('commits').put({ ...CommitSchema.parse(modelFixtures.Commit.valid), id: commitId, wakeId, botId: bot.id,
        createdAt: now + offset, nextThink: index === 0 ? { mode: 'auto', reason: '等变化' }
          : index === 1 ? { mode: 'after', afterMinutes: 360, reason: '等汇总完成' } : { mode: 'on_event', onEvent: '新资料', reason: '没有新资料不必醒' } });
      ctx.store.log('ledger').append({ id: newId('le', ctx.rng), who: bot.id, wakeId, tokens: 100, kind: 'turn', at: now + offset });
    }
    ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: newId('w', ctx.rng), botId: bot.id,
      status: 'error', startedAt: now, dispatchedAt: null });
    ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: newId('w', ctx.rng), botId: bot.id,
      status: 'committed', startedAt: now - 8 * DAY, dispatchedAt: now - 8 * DAY });
    ctx.store.table('agenda').put({ ...AgendaItemSchema.parse(modelFixtures.AgendaItem.valid), id: newId('a', ctx.rng), botId: bot.id,
      source: 'bot', createdAt: now, updatedAt: now });
    for (const answer of ['接受', '拒绝']) {
      const proposal = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: `建议${answer}`, body: '改善核实方法',
        options: ['接受', '拒绝'], defaultOption: null, priority: 'P2', subjectKey: `idea:${answer}`, expiresAt: now + DAY });
      ctx.store.table('inbox').patch(proposal.id, { status: 'answered', answer, answeredAt: now });
    }
    const stats = (await api.bot(bot.id)).stats;
    expect(stats).toMatchObject({ thinks7d: 3, selfPacedRatio: 2 / 3, selfInitiated7d: 3, proposalAcceptRate: 0.5, tokens7d: 300 });
    expect(stats.intervalCv).toBeCloseTo(5 / 7);
    const detail = await api.bot(bot.id);
    expect(detail.wakes[0]).toHaveProperty('reasonText');
    expect(detail.wakes.find(row => row.durationMs === 1000)?.durationText).toBe('1 秒');
  });
  it('同毫秒的最近结果和唤醒按实际插入顺序显示最新', async () => {
    const { api, ctx, bot } = await apiFixture();
    const wakes: string[] = [];
    for (const outcome of ['no_change', 'progress'] as const) {
      const wakeId = newId('w', ctx.rng);
      const commitId = newId('c', ctx.rng);
      wakes.push(wakeId);
      ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: wakeId, botId: bot.id,
        startedAt: ctx.clock.now(), commitId });
      ctx.store.table('commits').put({ ...CommitSchema.parse(modelFixtures.Commit.valid), id: commitId, wakeId, botId: bot.id,
        createdAt: ctx.clock.now(), outcome });
    }
    expect(api.overview().bots[0]?.lastOutcome).toBe('progress');
    expect((await api.bot(bot.id)).wakes.map(row => row.id)).toEqual(wakes.reverse());
  });
  it('读取所有视图不改任何表或触发调度', async () => {
    const { api, ctx, bot, after } = await apiFixture();
    const audits = ctx.store.log('audit').all().length;
    api.overview(); api.thread(bot.id); api.inbox(); api.activity(); await api.settings(); await api.bot(bot.id); await api.recentSessions();
    expect(after).toHaveBeenCalledTimes(1);
    expect(ctx.store.log('audit').all()).toHaveLength(audits);
    expect(ctx.store.isDirty()).toBe(false);
  });
});

describe('C04 线程、活动与设置视图', () => {
  it('同一毫秒的消息通过 id 分页不丢失，分页无效时明确报错', async () => {
    const { api, ctx, bot } = await apiFixture();
    const ids = ['一', '二', '三', '四'].map(text => postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text }).id);
    const newest = api.thread(bot.id, { limit: 2 });
    expect(newest.messages.map(row => row.id)).toEqual(ids.slice(2));
    expect(newest.hasMore).toBe(true);
    const older = api.thread(bot.id, { before: newest.oldestId!, limit: 2 });
    expect(older.messages.map(row => row.id)).toEqual(ids.slice(0, 2));
    expect(older.hasMore).toBe(false);
    expect(() => api.thread(bot.id, { before: 'missing' })).toThrow('游标不存在');
    expect(() => api.thread(bot.id, { limit: 0 })).toThrow('至少');
    expect(() => api.activity({ limit: 201 })).toThrow('过多');
  });
  it('已读持久化，之后同戳新消息保持未读，poke 以主人消息入队', async () => {
    const { api, ctx, bot } = await apiFixture();
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text: '收到' });
    expect(api.overview().bots[0]!.unread).toBe(1);
    expect((await api.markThreadRead(bot.id)).ok).toBe(true);
    expect(api.overview().bots[0]!.unread).toBe(0);
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text: '同刻新消息' });
    expect(api.overview().bots[0]!.unread).toBe(1);
    expect((await api.markThreadRead('missing')).ok).toBe(false);
    expect((await api.pokeBot(bot.id)).ok).toBe(true);
    expect(api.thread(bot.id).messages.at(-1)?.fromName).toBe('主人');
    expect((await api.pokeBot('missing')).ok).toBe(false);
  });
  it('线程卡片反映回答真实状态，收件箱按紧急度排序且不再显示已回答项', async () => {
    const { api, ctx, bot } = await apiFixture();
    const question = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '选方向', body: '需要决定',
      options: ['甲', '乙'], defaultOption: '乙', priority: 'P1', subjectKey: 'direction', expiresAt: ctx.clock.now() + DAY });
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'question', text: question.title, refId: question.id });
    const alert = createInboxItem(ctx, { botId: null, type: 'alert', title: '全体停摆', body: '请检查宿主', options: [],
      defaultOption: null, priority: 'P0', subjectKey: 'down', expiresAt: null });
    expect(api.inbox().items.map(row => row.id)).toEqual([alert.id, question.id]);
    expect(api.thread(bot.id).messages[0]?.card).toMatchObject({ inboxId: question.id, status: 'open', expiresAt: question.expiresAt });
    expect(api.overview().bots[0]!.waitingOwner).toBe(true);
    await api.answerInbox(question.id, '甲');
    expect(api.inbox().items.map(row => row.id)).toEqual([alert.id]);
    expect(api.thread(bot.id).messages[0]?.card).toMatchObject({ status: 'answered', answer: '甲' });
  });
  it('活动流显示生命周期和中心启动，过滤保护文件等内部记录', async () => {
    const { api, ctx, bot } = await apiFixture();
    writeOutreachAudit(ctx, 'hub_started', { at: ctx.clock.now() });
    await api.setLifecycle(bot.id, 'paused');
    const view = api.activity();
    expect(view.rows.some(row => row.kind === 'system' && row.text === '中心已启动')).toBe(true);
    expect(view.rows.some(row => row.kind === 'lifecycle' && row.botId === bot.id)).toBe(true);
    expect(view.rows.some(row => row.text.includes('protected_files'))).toBe(false);
    expect(view.rows.every(row => Number.isFinite(row.at) && row.timeText.includes('今天'))).toBe(true);
  });
  it('设置副本不能修改内部状态，模型选项仅来自名册，最近会话有排序和时间', async () => {
    const { api, ctx, bot } = await apiFixture();
    await api.updateBot(bot.id, { model: { provider: 'test', model: 'small' } });
    const settings = await api.settings();
    expect(settings.pushChannelOptions).toEqual(['dsh', 'macos', 'none']);
    expect(settings.modelOptions.map(row => row.label)).toEqual(['跟随宿主默认模型', 'test / small']);
    settings.settings.quietHours.start = '19:00';
    expect(ctx.settings.quietHours.start).toBe('23:00');
    vi.spyOn(ctx.host, 'listRecentSessions').mockResolvedValue([
      { sessionId: 'old', title: '旧教学', updatedAt: ctx.clock.now() - HOUR }, { sessionId: 'new', title: '新教学', updatedAt: ctx.clock.now() },
    ]);
    const rows = await api.recentSessions();
    expect(rows.map(row => row.sessionId)).toEqual(['new', 'old']);
    expect(rows[0]).toMatchObject({ updatedAt: ctx.clock.now(), updatedText: expect.stringContaining('今天') });
  });
});
