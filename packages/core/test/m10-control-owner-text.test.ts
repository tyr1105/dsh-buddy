/** M10 用真实控制入口核对排队、投递与活动流；模型指令和宿主原文只留在各自证据区。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, goalFixture, modelFixtures } from './model-fixtures.js';
import { createBotHome } from '../src/memory/files.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { shouldReflect } from '../src/reflect/trigger.js';
import { setLifecycle } from '../src/api/bots.js';
import { postThread, sendOwnerMessage } from '../src/outreach/thread.js';
import { botView } from '../src/api/bot-view.js';
import { activityView } from '../src/api/feed-views.js';
import { collectTimeCandidates } from '../src/agenda/clock.js';
import { catchUpCandidates } from '../src/health/downtime.js';
import { checkDeadman } from '../src/health/deadman.js';
import { enqueue } from '../src/scheduler/queue.js';
import { ownerReasonSummary } from '../src/util/owner-text.js';
import { WakeTicketSchema } from '../src/model/wake.js';
import { finishTurn, onTurnEvent } from '../src/turn/events.js';
import { onHostApprovalRequest } from '../src/gate/guard.js';
import { runTick } from '../src/engine/tick.js';
import { turnContext } from './c03-turn-fixtures.js';
import { effectivePaceMinMs } from '../src/scheduler/pacing.js';

const instructions = /请提炼|请再次调用|主人提出纠正|处理暂停期间主人留下的消息/;
/** 所有时间由注入时钟推进，家目录初始化保证测试走真实投递链。 */
async function setup(at = '2026-11-05T10:00:00+08:00') {
  const ctx = createTestContext();
  ctx.clock.set(Date.parse(at));
  const bot = { ...botFixture, lifecycle: 'active' as const, sessionId: null, lastThinkAt: null,
    lightCheckAt: null, nextThinkAt: null, expectedBy: null, activity: 'watching' as const };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  ctx.clock.advance(ctx.settings.startupQuietMs);
  return { ctx, bot };
}
/** 精确锁住完整主人句子，随后真正投递并核对唤醒记录和活动流，防止只在某一个页面过滤。 */
async function assertViews(ctx: Awaited<ReturnType<typeof setup>>['ctx'], botId: string, expected: string) {
  const entry = ctx.store.table('queue').list()[0]!;
  expect(entry.reason.ownerSummary).toBe(expected);
  expect((await botView(ctx, botId)).card.activityText).toBe(expected);
  await createDispatcher(ctx).pump();
  const view = await botView(ctx, botId);
  expect(view.card.activityText).toBe(`正在处理：${expected}`);
  expect(view.wakes[0]?.reasonText).toBe(expected);
  expect(activityView(ctx).rows.filter(row => row.kind === 'wake')[0]?.text).toBe(`唤醒：${expected}`);
  expect(view.card.activityText).not.toMatch(instructions);
  expect(view.wakes[0]?.reasonText).not.toMatch(instructions);
  expect(activityView(ctx).rows.filter(row => row.kind === 'wake')[0]?.text).not.toMatch(instructions);
  const created = ctx.host.calls.find(call => call.method === 'createSession');
  expect((created!.args[0] as { firstMessage: string }).firstMessage).toContain(entry.reason.summary);
}

describe('M10 控制候选给主人完整摘要', () => {
  it.each([
    ['correction', '按你的纠正做一次复盘'], ['no_commit', '连续两次没交账，做一次复盘'],
    ['weekly', '本周例行复盘'], ['period', `目标周期结束：${goalFixture.title}`],
  ] as const)('复盘 %s 的排队、唤醒与活动流都使用主人摘要', async (kind, expected) => {
    const { ctx, bot } = await setup(kind === 'weekly' ? '2026-11-08T20:00:00+08:00' : undefined);
    const now = ctx.clock.now();
    if (kind === 'correction') postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '以后先核对原文', refId: null });
    if (kind === 'no_commit') ctx.store.table('bots').patch(bot.id, { consecutiveNoCommit: ctx.settings.noCommitReflectionCount });
    if (kind === 'period') ctx.store.table('goals').put({ ...goalFixture, periodEndsAt: now });
    if (kind === 'weekly') for (let index = 0; index < ctx.settings.c03.reflectionWeekMinTurns; index++) {
      ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: `w_00000000${String(index).padStart(2, '0')}`,
        botId: bot.id, variant: 'regular', status: 'committed', startedAt: now - (index + 1) * 3_600_000, endedAt: now - 1 });
    }
    expect(shouldReflect(ctx, bot.id, now)?.reason.ownerSummary).toBe(expected);
    await assertViews(ctx, bot.id, expected);
  });

  it('暂停期间留言在恢复后排队，状态与唤醒记录写继续处理你的消息', async () => {
    const { ctx, bot } = await setup();
    await setLifecycle(ctx, bot.id, 'paused');
    sendOwnerMessage(ctx, bot.id, '核对公开信息');
    await setLifecycle(ctx, bot.id, 'active');
    await assertViews(ctx, bot.id, '继续处理你暂停期间留的消息');
  });

  it.each(['light_check', 'catch_up', 'deadman'] as const)('%s 候选显式给主人摘要，实际投递后仍保持', async kind => {
    const { ctx, bot } = await setup();
    const now = ctx.clock.now();
    let expected: string;
    if (kind === 'light_check') {
      ctx.store.table('bots').patch(bot.id, { lightCheckAt: now });
      enqueue(ctx, collectTimeCandidates(ctx, now)[0]!);
      expected = '做一次轻复查';
    } else if (kind === 'catch_up') {
      const gap = { id: 'd_0000000001', from: now - 3_600_000, to: now, kind: 'host_down' as const, handled: false };
      enqueue(ctx, catchUpCandidates(ctx, gap, now)[0]!);
      expected = '停机 1 小时，补看期间的变化';
    } else {
      ctx.store.table('bots').patch(bot.id, { expectedBy: now - 1 });
      enqueue(ctx, checkDeadman(ctx, now)[0]!);
      expected = '超过约定时间没有响应，重新唤醒';
    }
    await assertViews(ctx, bot.id, expected);
  });

  it('回合出错重排不把错误里的执行指令带进状态', async () => {
    const { ctx, bot } = await setup();
    const now = ctx.clock.now();
    const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id,
      status: 'running' as const, startedAt: now, lastEventAt: now, endedAt: null };
    ctx.store.table('wakes').put(wake);
    await finishTurn(ctx, wake.id, now, 'error', '连接失败：请再次调用外部接口');
    const current = ctx.store.table('bots').get(bot.id)!;
    // 回合重试仍遵守节奏闸门；推进到两种等待都结束，才能检查实际投递后的状态。
    ctx.clock.set(Math.max(current.retryAt!, now + effectivePaceMinMs(current, ctx.settings, 'green')));
    await assertViews(ctx, bot.id, '上轮处理出错，稍后重新尝试');
  });

  it('孤儿投递经真实 tick 重排后给主人说明尚未送达', async () => {
    const { ctx, bot } = await setup();
    const now = ctx.clock.now();
    ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id,
      status: 'delivering', startedAt: now - ctx.settings.c02.deliveryTimeoutMs - 1, lastEventAt: now - ctx.settings.c02.deliveryTimeoutMs - 1, endedAt: null });
    await runTick(ctx, { safe: async (_label, work) => { await work(); }, collect: () => undefined,
      offer: candidate => { enqueue(ctx, candidate); }, pump: async () => undefined });
    ctx.clock.set(ctx.store.table('bots').get(bot.id)!.retryAt!);
    await assertViews(ctx, bot.id, '上次唤醒没有送达，稍后重新尝试');
  });

  it.each([
    ['reflection', '复盘目标与做事方式'], ['light_check', '做一次轻复查'],
    ['catch_up', '补看停机期间的变化'], ['retry', '重新尝试处理待办'],
  ] as const)('旧 %s 没有主人摘要时使用完整保守句子', (kind, expected) => {
    expect(ownerReasonSummary({ kind, summary: '请提炼教训', score: 1, threshold: 0.6, evidence: [] })).toBe(expected);
  });
  it('旧恢复候选只改写精确的中心原句，主人自己的指令保持原文', () => {
    const reason = { kind: 'owner_message' as const, summary: '处理暂停期间主人留下的消息', score: 1, threshold: 0.6, evidence: [] };
    expect(ownerReasonSummary(reason)).toBe('继续处理你暂停期间留的消息');
    expect(ownerReasonSummary({ ...reason, summary: '请核对原文' })).toBe('请核对原文');
  });
});

describe('M10 宿主权限告警使用中文动作', () => {
  it.each([['bash', '运行命令'], ['write', '写入文件'], ['edit', '修改文件'], ['custom_tool', '执行工具动作']] as const)(
    '%s 的拒绝与等待正文用中文，宿主原文只在末行', async (tool, label) => {
      const { ctx, bot, ticket } = await turnContext();
      const summary = '宿主原文：请确认当前动作';
      await onHostApprovalRequest(ctx, bot.sessionId!, tool, summary);
      await onTurnEvent(ctx, { type: 'awaiting_approval', sessionId: bot.sessionId!, tool, summary, at: ticket.startedAt });
      const blocked = ctx.store.table('alerts').list(row => row.code === 'host_approval_blocked')[0]!;
      const waiting = ctx.store.table('alerts').list(row => row.code === 'host_approval_wait')[0]!;
      expect(blocked.text.split('\n')[0]).toBe(`宿主权限拦截了${label}，本次动作未执行。请检查 DSH 会话权限；确认权限允许后再发消息让队友继续。中心未创建审批单，避免无效批准和反复重试。`);
      expect(waiting.text.split('\n')[0]).toBe(`${label}正在等待宿主权限确认。中心将在 5 分钟后取消回合。`);
      for (const alert of [blocked, waiting]) {
        expect(alert.text.split('\n')[0]).not.toContain(tool);
        expect(alert.text.split('\n').at(-1)).toBe(`宿主原文（供核对）：${JSON.stringify({ tool, summary })}`);
        expect(ctx.store.table('inbox').list(card => card.refId === alert.id)[0]?.body).toBe(alert.text);
      }
    });
});
