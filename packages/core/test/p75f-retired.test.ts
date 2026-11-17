/**
 * P75f 旧机制下线测试（任务卡第 6 节 9–13 条）。
 * 每条断言它要证明的机制并写明依赖的设置；夹具与真实情况一致（员工在岗、听吩咐由各用例写明）。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildTools, runTool } from '../src/tools/index.js';
import { runTick } from '../src/engine/tick.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { answerInbox, createInboxItem } from '../src/outreach/inbox.js';
import { postThread } from '../src/outreach/thread.js';
import { botFixture, goalFixture, id, modelFixtures, watchFixture } from './model-fixtures.js';
import type { WakeTicket } from '../src/model/index.js';
import { turnContext } from './c03-turn-fixtures.js';
import type { HubContext } from '../src/engine/context.js';
import type { Rule } from '../src/model/team.js';

describe('P75f 下线：三个旧工具不在工具表', () => {
  it('工具注册表里没有三个旧工具；按名字调用返回「未知机器人工具」', async () => {
    const ctx = createTestContext();
    const names = new Set(buildTools(ctx).map(tool => tool.name));
    for (const gone of ['hub_lesson_propose', 'hub_reflect_commit', 'hub_routine_save']) {
      expect(names.has(gone)).toBe(false);
    }
    ctx.store.table('bots').put({ ...botFixture, sessionId: 's-retire' });
    // 员工直接按名字调用：注册表里找不到这个工具（宿主与中心都拒绝）。
    for (const gone of ['hub_lesson_propose', 'hub_reflect_commit', 'hub_routine_save']) {
      expect(await runTool(ctx, { botId: botFixture.id, sessionId: 's-retire', wakeId: null }, gone, {}))
        .toMatchObject({ ok: false, error: expect.stringContaining('未知机器人工具') });
    }
  });
});

describe('P75f 下线：旧复盘的四类触发不再产生候选', () => {
  /** 跑一次真实 tick（安全兜底、收集与放行全接上，但没有宿主投递）。 */
  async function tickOnce(ctx: HubContext) {
    await runTick(ctx, {
      safe: async (_label, work) => { await work(); },
      collect: () => {},
      offer: () => {},
      pump: async () => {},
    });
  }
  /** 在岗、不听吩咐、额度绿灯的员工（排除其他闸门的影响）。 */
  function onDutyBot(ctx: HubContext) {
    ctx.store.table('bots').put({ ...botFixture, onDemand: false, lifecycle: 'active', consecutiveNoCommit: 0, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    return botFixture;
  }

  it('连续两次未交账：tick 后队列里没有任何 reflection 候选', async () => {
    const ctx = createTestContext();
    const bot = onDutyBot(ctx);
    ctx.store.table('bots').patch(bot.id, { consecutiveNoCommit: 2 });
    await tickOnce(ctx);
    expect(ctx.store.table('queue').count(row => row.reason.kind === 'reflection' || row.variant === 'reflection')).toBe(0);
  });

  it('目标周期到期：同样不产生 reflection 候选', async () => {
    const ctx = createTestContext();
    onDutyBot(ctx);
    ctx.store.table('goals').put({ ...goalFixture, periodEndsAt: ctx.clock.now() - 1 });
    await tickOnce(ctx);
    expect(ctx.store.table('queue').count(row => row.variant === 'reflection')).toBe(0);
  });

  it('主人在员工私聊说「以后不要这样」：同样不产生 reflection 候选', async () => {
    const ctx = createTestContext();
    const bot = onDutyBot(ctx);
    postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '以后不要这样', refId: null });
    await tickOnce(ctx);
    expect(ctx.store.table('queue').count(row => row.variant === 'reflection')).toBe(0);
  });

  it('周日 20 点且本周已三轮：同样不产生 reflection 候选', async () => {
    const ctx = createTestContext();
    // 2026-11-08 是周日；本地 20:00 之后（reflectionHour 的旧条件）。
    ctx.clock.set(Date.parse('2026-11-08T20:30:00+08:00'));
    const bot = onDutyBot(ctx);
    for (let index = 0; index < 3; index += 1) {
      // P76c：疲劳、内驱现在会读唤醒单的 reason（isSelfWork 看唤醒种类）；原来这里用关注项夹具（watchFixture）冒充唤醒单，没有 reason 字段，
      // 改用真正的唤醒单夹具，字段值（编号、员工、变体、状态、开始与结束时刻）不变，用例要证明的「周日 20 点不产生复盘候选」不变。
      ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), id: `w_${String(index + 1).padStart(10, '0')}`, botId: bot.id,
        variant: 'regular', status: 'committed', startedAt: ctx.clock.now() - (index + 1) * 3_600_000, endedAt: ctx.clock.now() - 1 });
    }
    await tickOnce(ctx);
    expect(ctx.store.table('queue').count(row => row.variant === 'reflection')).toBe(0);
  });
});

describe('P75f 下线：唤醒包与新会话提示', () => {
  it('不再有「记忆摘要」「你会的套路」两段；新会话提示为新文字', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular', { sessionId: null, sessionStartedAt: null });
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).not.toContain('## 记忆摘要');
    expect(packet).not.toContain('## 你会的套路');
    expect(packet).toContain('你的身份与规矩在 AGENTS.md，目标、议程、关注在 mind/，技能在 .agents/skills/。');
    expect(packet).not.toContain('长期记忆在 memory/MEMORY.md');
    expect(bot.id).toBeTruthy();
  });
});

describe('P75f 下线：教训提议的接受与撤回按迁移状态分流', () => {
  /** 放一条提议中的旧教训规矩和对应的开着的提议条目。 */
  function openLessonProposal(ctx: HubContext, botId: string): string {
    const rule: Rule = { id: id('ru'), scope: botId, text: '先跑一遍再交', redLine: false, source: 'lesson', status: 'proposed', createdAt: ctx.clock.now() };
    ctx.store.table('rules').put(rule);
    ctx.store.table('bots').put({ ...botFixture, id: botId, onDemand: false, lifecycle: 'active', sessionId: null, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    const item = createInboxItem(ctx, { botId, type: 'proposal', title: `教训：${rule.text}`, body: 'why', subjectKey: `proposal:${rule.id}`, refId: rule.id });
    return item.id;
  }

  it('迁移未完成（legacyRulesInEffect 为真）：接受一条旧教训提议照旧改 rules', async () => {
    const ctx = createTestContext();
    const itemId = openLessonProposal(ctx, botFixture.id);
    await answerInbox(ctx, itemId, '接受');
    const rule = ctx.store.table('rules').list()[0]!;
    expect(rule.status).toBe('active');
  });

  it('迁移完成（legacyRulesInEffect 为假）：接受一条旧教训提议不改 rules（迁移已撤回开着的提议）', async () => {
    const ctx = createTestContext();
    ctx.store.table('migrations').put({ id: 'p75-storage', state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: ctx.clock.now() });
    const itemId = openLessonProposal(ctx, botFixture.id);
    await answerInbox(ctx, itemId, '接受');
    const rule = ctx.store.table('rules').list()[0]!;
    expect(rule.status).toBe('proposed');
  });
});
