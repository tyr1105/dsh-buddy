/**
 * P76c 下线的机制与新行为的测试（任务卡第 6 节第 4、7、8 条，及 4.4、4.5）。
 *
 * 1 删除的函数：src 下不再出现 botBudgetFor、dailyThinkCapFor、botTurnsInWindow、pushesLeft（整词）、isSkillWorkTicket；
 *   engine/tick.ts 不再出现 maybeSendDigest；digest.ts 只留 buildDigest 与 storedDigests（读旧数据）；
 * 2 日报不再推送：真实 Hub 跑过原来的 08:30，没有日报通知，没有 digest_generated、digest_sent 审计，线程里没有日报消息；
 * 3 推送条数不再受限：同一天第 4 条非 P0 推送照常发出（原来 over_budget）；免打扰时段内仍 deferred_quiet；去重照旧；
 * 4 员工新提的提问不到期：expiresAt 为 null；73 小时后仍开着、没有按默认处理；旧提问（带到期时间）到期仍按默认处理；
 *   开着、没有到期时间的提问把这位员工自己发起的候选一直拦在「等主人」闸门外（第一块已定的行为，这里固定它）。
 * 时间只用注入的假时钟；推进每次不超过 10 分钟。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as digestModule from '../src/outreach/digest.js';
import * as pushModule from '../src/outreach/push.js';
import * as defaultsModule from '../src/config/defaults.js';
import * as usageModule from '../src/quota/usage.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { FakeClock } from '../src/io/testing/fake-clock.js';
import type { HubContext } from '../src/engine/context.js';
import { createSimWorld, advance } from '../src/sim/runner.js';
import { requestPush, pushHistory } from '../src/outreach/push.js';
import { createInboxItem, expireInbox } from '../src/outreach/inbox.js';
import { processCommit } from '../src/commit/process.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** src 下全部 .ts 文件的路径与内容。 */
function sourceFiles(): Array<{ path: string; text: string }> {
  return (readdirSync(SRC, { recursive: true }) as string[]).filter(name => name.endsWith('.ts'))
    .map(name => ({ path: name, text: readFileSync(join(SRC, name), 'utf8') }));
}

describe('1 删除的函数', () => {
  it.each([
    ['botBudgetFor', /botBudgetFor/], ['dailyThinkCapFor', /dailyThinkCapFor/], ['botTurnsInWindow', /botTurnsInWindow/],
    ['pushesLeft（整词）', /\bpushesLeft\b/], ['isSkillWorkTicket', /isSkillWorkTicket/],
  ])('src 下没有任何地方出现 %s', (_name, pattern) => {
    const hits = sourceFiles().filter(file => pattern.test(file.text)).map(file => file.path);
    expect(hits).toEqual([]);
  });

  it('engine/tick.ts 不再出现 maybeSendDigest，也没有「日报」一项', () => {
    const tick = readFileSync(join(SRC, 'engine/tick.ts'), 'utf8');
    expect(tick).not.toContain('maybeSendDigest');
    expect(tick).not.toContain("['日报'");
  });

  it('导出：旧的几个函数都不存在；buildDigest、storedDigests 仍在（读旧数据，P76 起不再被调用）；pushHistory 保留', () => {
    expect((digestModule as Record<string, unknown>).maybeSendDigest).toBeUndefined();
    expect((pushModule as Record<string, unknown>).pushesLeft).toBeUndefined();
    expect((defaultsModule as Record<string, unknown>).botBudgetFor).toBeUndefined();
    expect((defaultsModule as Record<string, unknown>).dailyThinkCapFor).toBeUndefined();
    expect((usageModule as Record<string, unknown>).botTurnsInWindow).toBeUndefined();
    expect(typeof digestModule.buildDigest).toBe('function');
    expect(typeof digestModule.storedDigests).toBe('function');
    expect(typeof pushModule.pushHistory).toBe('function');
  });

  it('botUsageToday 保留（员工卡的今日 token 还在用），但原来给停用线用的两个选项已删除', () => {
    expect(typeof usageModule.botUsageToday).toBe('function');
    expect(usageModule.botUsageToday.length).toBe(3);
  });
});

describe('2 日报不再推送', () => {
  it('真实 Hub 跨过原来的 08:30 与免打扰结束时刻：没有日报通知，没有日报审计，线程里没有日报消息', async () => {
    const local = (value: string) => parseLocalDateTime(value, 'Asia/Shanghai');
    const world = await createSimWorld({ startAt: local('2026-11-05 07:00'), bots: [{ id: botFixture.id, name: '巡检员' }] });
    try {
      // 跨过 07:00（免打扰结束）到 09:30：原来在 08:30 的 tick 里生成并推送「团队日报」。
      await advance(world, local('2026-11-05 09:30') - world.clock.now());
      expect(world.clock.now()).toBe(local('2026-11-05 09:30'));
      expect(world.host.notifications.filter(row => row.title.startsWith('团队日报'))).toEqual([]);
      const audits = world.store.log('audit').all().filter(row => row.action === 'digest_generated' || row.action === 'digest_sent');
      expect(audits).toEqual([]);
      expect(world.store.log('thread').all().filter(row => row.kind === 'digest')).toEqual([]);
    } finally { await world.hub.stop(); }
  });
});

describe('3 推送条数不再受限，免打扰与去重照旧', () => {
  function context() {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    return ctx;
  }
  const push = (ctx: ReturnType<typeof context>, subjectKey: string, level: 'P0' | 'P1' | 'P2' = 'P1') =>
    requestPush(ctx, { botId: botFixture.id, level, title: '需要决定', body: '内容', subjectKey });

  it('同一天第 4 条非 P0 推送照常发出（原来第 3 条起 over_budget）；旧设置里的条数上限调到 1 也一样', async () => {
    const ctx = context();
    ctx.settings.dailyPushCap = 1; ctx.settings.botDailyPushCap = 1;
    const results: string[] = [];
    for (const subject of ['1', '2', '3', '4']) results.push(await push(ctx, subject));
    expect(results).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(ctx.host.calls.filter(call => call.method === 'notify')).toHaveLength(4);
    expect(pushHistory(ctx).filter(row => row.result === 'over_budget')).toEqual([]);
  });

  it('免打扰时段内的非 P0 推送仍返回 deferred_quiet、不发通知；P0 仍发出', async () => {
    const ctx = context();
    ctx.clock.set(Date.parse('2026-11-05T23:30:00+08:00'));
    expect(await push(ctx, 'night')).toBe('deferred_quiet');
    expect(ctx.host.calls.filter(call => call.method === 'notify')).toHaveLength(0);
    expect(await push(ctx, 'night-p0', 'P0')).toBe('sent');
  });

  it('24 小时内同主题仍去重（反例：不同主题不去重）', async () => {
    const ctx = context();
    expect(await push(ctx, 'same')).toBe('sent');
    expect(await push(ctx, 'same')).toBe('duplicate');
    expect(await push(ctx, 'other')).toBe('sent');
  });
});

describe('4 员工新提的普通提问不到期', () => {
  const question = {
    text: '选哪个方案', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '需要你决定方向',
  };

  /** 员工交账里带一个提问，返回这条提问的「待你处理」条目。 */
  async function askedByCommit() {
    const made = await turnContext();
    const result = await processCommit(made.ctx, made.toolCtx, commitArgs({ outcome: 'needs_owner', summary: '需要你拍板', ownerQuestion: question }));
    expect(result.ok).toBe(true);
    const item = made.ctx.store.table('inbox').list(row => row.type === 'question' && row.title === question.text)[0]!;
    return { ...made, item };
  }

  /** 每次不超过 10 分钟地推进，每次都跑一遍过期检查。 */
  async function advanceAndExpire(ctx: HubContext, total: number): Promise<void> {
    for (let spent = 0; spent < total; spent += 10 * MINUTE) {
      (ctx.clock as FakeClock).advance(Math.min(10 * MINUTE, total - spent));
      await expireInbox(ctx, ctx.clock.now());
    }
  }

  it('员工交账里的提问条目 expiresAt 为 null，默认选项照旧写在条目上；73 小时后仍开着、没有按默认处理', async () => {
    const { ctx, item } = await askedByCommit();
    expect(item.expiresAt).toBeNull();
    expect(item.defaultOption).toBe('甲');
    expect(item.status).toBe('open');
    await advanceAndExpire(ctx, 73 * HOUR);
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open', answer: null });
    expect(ctx.store.table('percepts').list(row => row.kind === 'inbox_reply')).toEqual([]);
  });

  it('旧提问（带到期时间）到期仍按默认处理：72 小时前不动，到点后按默认答案处理一次', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    const old = createInboxItem(ctx, { botId: botFixture.id, type: 'question', title: '旧提问', body: '升级前就开着', subjectKey: 'question:old',
      options: ['继续', '停止'], defaultOption: '停止' });
    expect(old.expiresAt).toBe(ctx.clock.now() + ctx.settings.questionExpiryMs);
    await advanceAndExpire(ctx, 72 * HOUR - MINUTE);
    expect(ctx.store.table('inbox').get(old.id)!.status).toBe('open');
    await advanceAndExpire(ctx, 2 * MINUTE);
    expect(ctx.store.table('inbox').get(old.id)).toMatchObject({ status: 'expired', answer: '停止' });
  });

  it('开着、没有到期时间的提问：这位员工自己发起的候选被「等主人」闸门一直拦住，until 为 null；回答之后放行', async () => {
    const { ctx, bot, item, ticket } = await askedByCommit();
    // 交账之后宿主结束了这个回合（否则它还占着「正在思考」，先被并发闸门拦住）。
    ctx.store.table('wakes').patch(ticket.id, { endedAt: ctx.clock.now() });
    ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE;
    // 分数取 0.85（低于紧急线 0.9：紧急候选本来就能越过「等主人」）；指名入队，不看思考门槛（交账那个回合让疲劳升高了）。
    const entry = enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'percept', score: 0.85, summary: '资料有变化', subjectKey: 'watch:p76c-q' }), { directed: true })!;
    expect(entry.urgent).toBe(false);
    const verdictAt = (): ReturnType<typeof evaluateGates> => {
      const now = ctx.clock.now();
      return evaluateGates(entry, buildSnapshot(ctx, bot.id, now, entry.jobId, entry.subjectKey), now, ctx.settings);
    };
    expect(verdictAt()).toEqual({ pass: false, by: 'waiting_owner', until: null, drop: false });
    await advanceAndExpire(ctx, 73 * HOUR);
    expect(verdictAt()).toEqual({ pass: false, by: 'waiting_owner', until: null, drop: false });
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '乙', answeredAt: ctx.clock.now() });
    expect(verdictAt()).toEqual({ pass: true });
  });
});
