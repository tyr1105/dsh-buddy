/** M06 验证空汇报不会进入线程、通知或日报，同时保留原始历史和有意义的 null 正文。 */
import { describe, expect, it } from 'vitest';
import { buildTools } from '../src/tools/index.js';
import { processCommit } from '../src/commit/process.js';
import { buildDigest } from '../src/outreach/digest.js';
import { postThread, threadMessages } from '../src/outreach/thread.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { threadView, inboxView, settingsView } from '../src/api/feed-views.js';
import { botView } from '../src/api/bot-view.js';
import { overview } from '../src/api/summary-views.js';
import { CommitSchema, OutboxActionSchema } from '../src/model/index.js';
import { newId } from '../src/util/ids.js';
import { modelFixtures } from './model-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';

const emptyValues = [null, '', ' \n\t ', 'null', '  null\n'];

describe('M06 空回复与汇报', () => {
  it.each(emptyValues)('hub_commit 的 reply/report=%j 不发消息或单推，存储归一为空', async value => {
    const { ctx, toolCtx, bot } = await turnContext();
    const tool = buildTools(ctx).find(row => row.name === 'hub_commit')!;
    expect(await tool.handler(ctx, toolCtx, commitArgs({ reply: value, report: value, importance: 10 }))).toMatchObject({ ok: true });
    expect(ctx.store.table('commits').list()[0]).toMatchObject({ reply: null, report: null });
    expect(ctx.store.log('thread').all()).toHaveLength(0);
    expect(threadView(ctx, bot.id).messages).toHaveLength(0);
    expect(ctx.store.table('inbox').list()).toHaveLength(0);
    expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(0);
  });

  it.each(emptyValues)('主人唤醒的空 reply=%j 仍拒绝，不能用 null 占位冒充回复', async value => {
    const { ctx, ticket, toolCtx } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { reason: { ...ticket.reason, kind: 'owner_message' }, ownerInitiated: true });
    expect(await processCommit(ctx, toolCtx, commitArgs({ reply: value }))).toMatchObject({ ok: false, error: expect.stringContaining('reply') });
    expect(ctx.store.table('commits').count()).toBe(0);
    expect(ctx.store.log('thread').all()).toHaveLength(0);
  });

  it('正常正文保留原文，含 null 的技术解释仍回复、汇报和单推', async () => {
    const { ctx, toolCtx } = await turnContext();
    const reply = '  返回值是 null，尚无新结果。\n';
    const report = '字段为 null 表示未配置，并非错误。';
    expect(await processCommit(ctx, toolCtx, commitArgs({ reply, report, importance: 9 }))).toMatchObject({ ok: true });
    expect(ctx.store.log('thread').all().map(row => row.text)).toEqual([reply, report]);
    expect(ctx.store.table('commits').list()[0]).toMatchObject({ reply, report });
    expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(1);
  });

  it('日报先排除历史空交账与出站汇报，再选三条重点，空通知不再次露出', async () => {
    const { ctx, bot } = await turnContext();
    const yesterday = ctx.clock.now() - ctx.settings.c03.dayMs;
    const commit = CommitSchema.parse(modelFixtures.Commit.valid);
    const outbox = OutboxActionSchema.parse(modelFixtures.OutboxAction.valid);
    for (const report of [...emptyValues, '正常汇报一', '正常汇报二', '值为 null 的汇报']) {
      ctx.store.table('commits').put({ ...commit, id: newId('c', ctx.rng), botId: bot.id, report, importance: report?.includes('汇报') ? 7 : 10, createdAt: yesterday });
      ctx.store.table('outbox').put({ ...outbox, id: newId('o', ctx.rng), botId: bot.id, kind: 'notify_owner', status: 'done',
        payload: { text: report, importance: report?.includes('汇报') ? 7 : 10 }, doneAt: yesterday });
    }
    for (const body of emptyValues) writeOutreachAudit(ctx, 'push', { botId: bot.id, title: '机器人汇报', body,
      level: 'P2', subjectKey: 'report:legacy', result: 'deferred_quiet' }, 'hub', yesterday);
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest.split('\n').filter(line => line.startsWith('重点汇报：'))).toEqual([
      '重点汇报：正常汇报一', '重点汇报：正常汇报二', '重点汇报：值为 null 的汇报',
    ]);
    expect(digest).not.toContain('未单独推送');
    expect(digest).not.toMatch(/汇报：\s*(?:null)?\s*$/m);
  });

  it('旧空回复和汇报不占视图未读，原日志保留，主人原话 null 仍可见', async () => {
    const { ctx, bot } = await turnContext();
    for (const text of emptyValues.filter((value): value is string => value !== null)) {
      for (const kind of ['reply', 'report'] as const) postThread(ctx, { thread: bot.id, from: bot.id, kind, text });
    }
    const owner = postThread(ctx, { thread: bot.id, from: 'owner', kind: 'reply', text: 'null' });
    const real = postThread(ctx, { thread: bot.id, from: bot.id, kind: 'report', text: '正文提到 null' });
    expect(threadMessages(ctx, bot.id).map(row => row.id)).toEqual([owner.id, real.id]);
    expect(threadView(ctx, bot.id).messages.map(row => row.text)).toEqual(['null', '正文提到 null']);
    expect(overview(ctx).bots.find(row => row.id === bot.id)?.unread).toBe(1);
    expect(ctx.store.log('thread').all()).toHaveLength(10);
  });

  it('收件箱正文不强转 null，视图中的未知值保留 null 类型', async () => {
    const { ctx, bot } = await turnContext();
    const input = { botId: bot.id, type: 'alert' as const, title: '待核实', body: '', subjectKey: 'null-audit' };
    expect(() => createInboxItem(ctx, { ...input, body: null } as unknown as Parameters<typeof createInboxItem>[1])).toThrow('body');
    const item = createInboxItem(ctx, input);
    postThread(ctx, { thread: bot.id, from: 'hub', kind: 'alert', text: '待核实', refId: item.id });
    expect(inboxView(ctx).items[0]).toMatchObject({ body: '', defaultOption: null, expiresText: null });
    expect(threadView(ctx, bot.id).messages[0]?.card).toMatchObject({ body: '', answer: null, defaultOption: null });
    expect((await botView(ctx, bot.id)).wakes[0]).toMatchObject({ summary: null, outcomeLabel: null, durationText: null });
    expect((await settingsView(ctx)).modelOptions.find(row => row.value === null)?.label).toBe('跟随宿主默认模型');
    expect(overview(ctx).team.lastMessageText).toBeNull();
  });
});
