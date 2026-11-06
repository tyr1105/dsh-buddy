/** M09 控制候选的状态只讲主人可读的事实；试跑、教学和内驱的执行提示仍完整交给机器人。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { enqueue } from '../src/scheduler/queue.js';
import { evaluateDrives } from '../src/drives/evaluate.js';
import { enqueueTeach } from '../src/routines/teach.js';
import { setLifecycle } from '../src/api/bots.js';
import { botView } from '../src/api/bot-view.js';
import { ownerReasonSummary } from '../src/util/owner-text.js';
import { AgendaItemSchema, CommitSchema, HandoffSchema, InboxItemSchema } from '../src/model/index.js';
import { apiFixture } from './c04-api-fixtures.js';
import { botFixture, goalFixture, modelFixtures } from './model-fixtures.js';

const HOUR = 3_600_000;
const instructions = /请试跑并交账|主人让你|请整理|主人教你|请及时处理|按默认继续|催一下或改派|复盘或换方法|换方法或求助|不要再重试/;

/** 以真实家目录和向前推进的时钟准备调度，保护文件基线不会被测试倒置时间破坏。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, sessionId: null, lastThinkAt: null, lifecycle: 'active' as const };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  ctx.clock.advance(ctx.settings.startupQuietMs);
  return { ctx, bot };
}

/** 排队与思考都使用主人摘要，同时检查真正交给宿主的唤醒包保留原提示。 */
async function assertSeparated(ctx: Awaited<ReturnType<typeof setup>>['ctx'], botId: string) {
  const entry = ctx.store.table('queue').list()[0]!;
  expect(entry.reason.summary).toMatch(instructions);
  expect(entry.reason.ownerSummary).toBeTruthy();
  expect(entry.reason.ownerSummary).not.toMatch(instructions);
  expect((await botView(ctx, botId)).card.activityText).toBe(entry.reason.ownerSummary);
  await createDispatcher(ctx).pump();
  const view = await botView(ctx, botId);
  expect(view.card.activityText).toBe(`正在处理：${entry.reason.ownerSummary}`);
  expect(view.card.activityText).not.toMatch(instructions);
  const packet = (ctx.host.calls.find(call => call.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
  expect(packet).toContain(entry.reason.summary);
}

describe('M09 试跑与教学的主人文字', () => {
  it.each([['trial', '新队友开始试跑'], ['teach', '已收到教学会话'], ['drive', '复查目标与待办进展']] as const)('旧 %s 候选缺少主人摘要时也不回显模型指令', (kind, expected) => {
    const reason = { kind, summary: '请整理方法，不要再重试同一做法', evidence: [], score: 1, threshold: 0.6 };
    expect(ownerReasonSummary(reason)).not.toMatch(instructions);
    expect(ownerReasonSummary(reason)).toBe(expected);
    expect(reason.summary).toBe('请整理方法，不要再重试同一做法');
  });

  it('创建队友的试跑指令不进入 queued 和 thinking 状态', async () => {
    const { ctx, bot } = await apiFixture();
    await assertSeparated(ctx, bot.id);
  });

  it('草稿队友开始试岗的指令与主人状态分开', async () => {
    const { ctx, bot } = await setup();
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'draft' });
    await setLifecycle(ctx, bot.id, 'probation');
    await assertSeparated(ctx, bot.id);
  });

  it.each(['', '请整理当前交付流程'])('教学附言 %s 留在模型上下文，状态只说已收到会话', async note => {
    const { ctx, bot } = await setup();
    await enqueueTeach(ctx, bot.id, 'lesson-session', note);
    await assertSeparated(ctx, bot.id);
  });
});

describe('M09 内驱事实与执行提示分开', () => {
  it.each(['stagnation', 'obligation', 'waiting-question', 'waiting-handoff', 'frustration'])('%s 的提示只留在模型理由', async name => {
    const { ctx, bot } = await setup();
    const now = ctx.clock.now();
    if (name === 'stagnation') ctx.store.table('goals').put({ ...goalFixture, patienceMs: HOUR, lastProgressAt: now - 2 * HOUR });
    if (name === 'obligation') ctx.store.table('agenda').put({ ...AgendaItemSchema.parse(modelFixtures.AgendaItem.valid), toOwner: true, dueAt: now });
    if (name === 'waiting-question') ctx.store.table('inbox').put({ ...InboxItemSchema.parse(modelFixtures.InboxItem.valid),
      createdAt: now - ctx.settings.questionExpiryMs, status: 'expired', defaultOption: '停止', answer: '停止', answeredAt: now });
    if (name === 'waiting-handoff') ctx.store.table('handoffs').put({ ...HandoffSchema.parse(modelFixtures.Handoff.valid), createdAt: now - 2 * HOUR });
    if (name === 'frustration') for (let index = 0; index < ctx.settings.c02.frustrationCount; index += 1) {
      ctx.store.table('commits').put({ ...CommitSchema.parse(modelFixtures.Commit.valid), id: `c_${String(index).padStart(10, '0')}`,
        outcome: 'blocked', blocker: '上游没有资料', createdAt: now - index });
    }
    const candidates = evaluateDrives(ctx, now);
    expect(candidates).toHaveLength(1);
    enqueue(ctx, candidates[0]!);
    await assertSeparated(ctx, bot.id);
  });
});
