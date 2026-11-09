/** M08 展示验收：在真实详情、日报与唤醒包里核对星期文案，避免休息日重新被显示成落空。 */
import { describe, expect, it } from 'vitest';
import { botView } from '../src/api/bot-view.js';
import { resolveSettings } from '../src/config/defaults.js';
import { PerceptSchema, WatchSchema, type Watch } from '../src/model/perception.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { buildDigest } from '../src/outreach/digest.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { formatExpectation } from '../src/util/expectation-text.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { turnContext } from './c03-turn-fixtures.js';
import { modelFixtures, watchFixture } from './model-fixtures.js';

const hour = 3_600_000;
const workdays = [1, 2, 3, 4, 5];

/** 固定注入时钟与上海时区；期望从模型入口解析，测试与生产保存的规范化值一致。 */
async function displayContext(time: string, weekdays: number[] | null, patch: Partial<NonNullable<Watch['expectation']>> = {}) {
  const fixture = await turnContext();
  const { ctx, bot } = fixture;
  ctx.settings = resolveSettings({ rootDir: '/hub', timezone: 'Asia/Shanghai' });
  ctx.clock.set(Date.parse(time));
  const watch = WatchSchema.parse({ ...watchFixture, botId: bot.id, kind: 'log', createdAt: Date.parse('2026-11-06T00:00:00+08:00'),
    expectation: { text: '早盘日志出现', everyMs: null, byLocalTime: '08:20', weekdays,
      lastSatisfiedAt: null, lastMissedAt: null, ...patch } });
  ctx.store.table('watches').put(watch);
  return { ...fixture, watch };
}

describe('M08 期望日期文案', () => {
  it.each([
    { name: '工作日', weekdays: workdays, text: '早盘日志出现，工作日每天 08:20 前' },
    { name: '周末', weekdays: [6, 7], text: '早盘日志出现，周末每天 08:20 前' },
    { name: '指定星期', weekdays: [1, 3, 5], text: '早盘日志出现，每周一、三、五 08:20 前' },
    { name: '每天', weekdays: null, text: '早盘日志出现，每天 08:20 前' },
  ])('机器人详情显示 $name 的实际检查日', async ({ weekdays, text }) => {
    const { ctx, bot } = await displayContext('2026-11-09T09:00:00+08:00', weekdays);
    const view = await botView(ctx, bot.id);
    expect(view.watches[0]!.expectationText).toBe(text);
  });

  it('详情中没有期望时仍返回 null', async () => {
    const { ctx, bot, watch } = await displayContext('2026-11-09T09:00:00+08:00', workdays);
    ctx.store.table('watches').patch(watch.id, { expectation: null });
    expect((await botView(ctx, bot.id)).watches[0]!.expectationText).toBeNull();
  });

  it.each([
    { weekdays: workdays, text: '早盘日志出现，工作日，每 1 小时' },
    { weekdays: [6, 7], text: '早盘日志出现，周末，每 1 小时' },
    { weekdays: [1, 3, 5], text: '早盘日志出现，每周一、三、五，每 1 小时' },
    { weekdays: null, text: '早盘日志出现，每 1 小时' },
  ])('间隔型期望保留日子与间隔 $text', async ({ weekdays, text }) => {
    const { ctx, bot } = await displayContext('2026-11-09T09:00:00+08:00', weekdays, { byLocalTime: null, everyMs: hour });
    expect((await botView(ctx, bot.id)).watches[0]!.expectationText).toBe(text);
  });

  it('同时有钟点和间隔时只写一次日期范围', async () => {
    const { watch } = await displayContext('2026-11-09T09:00:00+08:00', workdays, { everyMs: hour });
    expect(formatExpectation(watch.expectation!)).toBe('早盘日志出现，工作日每天 08:20 前，每 1 小时');
  });

  it('乱序和重复星期保存后在详情只展示一次并升序', async () => {
    const { ctx, bot } = await displayContext('2026-11-09T09:00:00+08:00', [5, 1, 3, 1]);
    expect((await botView(ctx, bot.id)).watches[0]!.expectationText).toBe('早盘日志出现，每周一、三、五 08:20 前');
  });
});

describe('M08 日报检查日', () => {
  it.each([
    ['2026-11-07', '【未出现】'], ['2026-11-08', '昨日不检查'],
  ])('%s 工作日期望按昨天显示 %s', async (day, result) => {
    const { ctx } = await displayContext(`${day}T09:00:00+08:00`, workdays,
      { lastMissedAt: Date.parse('2026-11-06T09:00:00+08:00') });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain(`期望「早盘日志出现，工作日每天 08:20 前」：${result}`);
    expect(digest).not.toContain('今天不检查');
    if (result === '昨日不检查') expect(digest).not.toContain('未出现');
  });

  it('周一期望恢复检查，日报不把周日未检查当成未出现', async () => {
    const { ctx } = await displayContext('2026-11-09T09:00:00+08:00', workdays);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('昨日不检查');
    expect(digest).not.toContain('今天不检查');
    expect(digest).not.toContain('已出现');
    expect(digest).not.toContain('未出现');
  });

  it.each([true, false])('检查日仍按昨日事实展示满足=%s', async satisfied => {
    const monday = Date.parse('2026-11-09T08:15:00+08:00');
    const { ctx } = await displayContext('2026-11-10T09:00:00+08:00', workdays,
      { lastSatisfiedAt: satisfied ? monday : null, lastMissedAt: satisfied ? null : monday });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain(satisfied ? '：已出现' : '：【未出现】');
    expect(digest).not.toContain('不检查');
  });

  it.each([true, false])('weekdays=null 的周末日报保持原昨日满足=%s 语义', async satisfied => {
    const saturday = Date.parse('2026-11-07T08:15:00+08:00');
    const { ctx } = await displayContext('2026-11-08T09:00:00+08:00', null,
      { lastSatisfiedAt: satisfied ? saturday : null, lastMissedAt: satisfied ? null : saturday });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain(`期望「早盘日志出现」：${satisfied ? '已出现' : '【未出现】'}`);
    expect(digest).not.toContain('不检查');
  });

  it('日报按设置时区的星期判断而非 UTC 日期', async () => {
    const { ctx } = await displayContext('2026-11-08T18:00:00Z', [1]);
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('团队日报 2026-11-09');
    expect(digest).toContain('昨日不检查');
    expect(digest).not.toContain('今天不检查');
  });

  it('周末期望在周一的日报仍显示周日落空', async () => {
    const { ctx } = await displayContext('2026-11-09T09:00:00+08:00', [6, 7]);
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('周末每天 08:20 前」：【未出现】');
    expect(digest).not.toContain('不检查');
  });
});

describe('M08 日报夏令时的昨日窗口', () => {
  const saturday = Date.parse('2026-03-07T08:15:00-05:00');
  const sunday = Date.parse('2026-03-08T08:15:00-04:00');

  /** 纽约春季跳时后周一回顾周日；周日只长 23 小时，不能机械减去 24 小时。 */
  async function springContext(patch: Partial<NonNullable<Watch['expectation']>> = {}) {
    const fixture = await displayContext('2026-03-09T09:00:00-04:00', [7, 1], patch);
    fixture.ctx.settings = resolveSettings({ rootDir: '/hub', timezone: 'America/New_York' });
    fixture.ctx.store.table('watches').patch(fixture.watch.id, { createdAt: Date.parse('2026-03-06T00:00:00-05:00') });
    return fixture;
  }

  it.each([true, false])('春进后周一按周日真实满足=%s 显示，不能误写昨日不检查', async satisfied => {
    const { ctx } = await springContext({ lastSatisfiedAt: satisfied ? sunday : null });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain(satisfied ? '：已出现' : '：【未出现】');
    expect(digest).not.toContain('不检查');
  });

  it.each(['timestamp', 'audit'] as const)('春进后不能把周六的 %s 满足误算作周日', async source => {
    const { ctx, watch } = await springContext({ lastSatisfiedAt: source === 'timestamp' ? saturday : null });
    if (source === 'audit') writeOutreachAudit(ctx, 'expectation_satisfied', { watchId: watch.id }, 'hub', saturday);
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('：【未出现】');
    expect(digest).not.toContain('：已出现');
    expect(digest).not.toContain('不检查');
  });

  it('春进后昨日满足审计仍能补回已被今早覆盖的时间', async () => {
    const { ctx, watch } = await springContext({ lastSatisfiedAt: Date.parse('2026-03-09T08:15:00-04:00') });
    writeOutreachAudit(ctx, 'expectation_satisfied', { watchId: watch.id }, 'hub', sunday);
    expect(buildDigest(ctx, ctx.clock.now())).toContain('：已出现');
  });

  it.each(['timestamp', 'percept'] as const)('春进后周六的 %s 落空不能覆盖周日满足', async source => {
    const { ctx, watch } = await springContext({ lastSatisfiedAt: sunday, lastMissedAt: source === 'timestamp' ? saturday : null });
    if (source === 'percept') ctx.store.table('percepts').put(PerceptSchema.parse({
      ...modelFixtures.Percept.valid as object, watchId: watch.id, kind: 'expectation_missed', createdAt: saturday,
    }));
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('：已出现');
    expect(digest).not.toContain('未出现');
  });

  it('春进后周日真实落空感知仍优先于满足事实', async () => {
    const { ctx, watch } = await springContext({ lastSatisfiedAt: sunday });
    ctx.store.table('percepts').put(PerceptSchema.parse({
      ...modelFixtures.Percept.valid as object, watchId: watch.id, kind: 'expectation_missed', createdAt: sunday + hour,
    }));
    expect(buildDigest(ctx, ctx.clock.now())).toContain('：【未出现】');
  });
});

describe('M08 唤醒包期望说明', () => {
  it('真实期望落空感知进入唤醒包时保留工作日与期限', async () => {
    const { ctx, bot, entry, ticket } = await displayContext('2026-11-09T09:00:00+08:00', workdays);
    const missed = checkExpectations(ctx, ctx.clock.now())[0]!;
    const reason = { ...entry.reason, kind: 'percept' as const, summary: missed.summary, evidence: [missed.id] };
    const packet = await buildWakePacket(ctx, bot, { ...entry, reason }, { ...ticket, reason });
    expect(packet).toContain('期望落空：早盘日志出现，工作日每天 08:20 前');
    expect(packet).toContain(missed.id);
    expect(Buffer.byteLength(packet, 'utf8')).toBeLessThanOrEqual(ctx.settings.wakePacketMaxBytes);
  });

  it('每天的期望落空摘要保持旧文本', async () => {
    const { ctx } = await displayContext('2026-11-09T09:00:00+08:00', null);
    expect(checkExpectations(ctx, ctx.clock.now())[0]!.summary).toBe('期望落空：早盘日志出现');
  });
});
