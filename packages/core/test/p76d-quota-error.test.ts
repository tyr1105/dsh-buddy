/**
 * P76d 测试三：真实额度报错——认出来、恢复时间解析、容量校准、被动记录、不建条目不推送、探针恢复、被打断的事照常放行。
 *
 * 按 P76a 的裁定（docs/progress/P76a.md）：宿主对限流报错自己重试，连续几次都失败之后才交给中心，所以中心收到这类报错时额度确实已用完；
 * 中心拿到的只有报错里的一句话，恢复时间在这句话里 -> 「正文完整到达」：解析函数要调用，解析到就用它。
 * 下面用到的报错原文都是 P76a 实测记录里的句子：
 *   「已达到 5 小时的使用上限，将于 15:53 恢复」；「已达到 5 小时的使用上限，将在 2026-11-13 16:14:31 重置」。
 * 时间只用注入的假时钟，每次推进不超过 10 分钟（跨窗口的用例直接把假时钟设到目标时刻）。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot } from '../src/model/index.js';
import type { QuotaPlan } from '../src/model/quota-plan.js';
import { BUDGET_DEFAULTS } from '../src/config/defaults.js';
import { classifyError } from '../src/quota/errors.js';
import { parseResetAt } from '../src/quota/reset-text.js';
import { calibrateCapacity, defaultQuotaPlan, getQuotaPlan } from '../src/quota/plan.js';
import { consumeProbe, getQuotaState, maybeAllowProbe, onProbeResult, onQuotaError, recordUsage } from '../src/quota/index.js';
import { onDispatchOrTurnError } from '../src/scheduler/retry.js';
import { pushHistory } from '../src/outreach/push.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { advance, createSimWorld } from '../src/sim/runner.js';
import { quietBrain } from '../src/sim/brains.js';
import type { Brain } from '../src/sim/types.js';
import { botFixture } from './model-fixtures.js';
import { addWake } from './p76c-fixtures.js';
import { MINUTE, bot as botOf, commitAndEnd, entriesOf, jobFix, runningJob, runningOf, tick, wakesOf } from './p74c-fixtures.js';

const HOUR = 60 * MINUTE;
const TZ = 'Asia/Shanghai';
const at = (text: string) => Date.parse(`${text}+08:00`);
/** P76a 实测到的两句报错原文。 */
const SENTENCE_CLOCK = '已达到 5 小时的使用上限，将于 15:53 恢复';
const SENTENCE_DATED = '已达到 5 小时的使用上限，将在 2026-11-13 16:14:31 重置';

describe('1 识别：报错原文、错误代号、状态码', () => {
  it('P76a 实测到的每一句报错原文都被认成额度用完', () => {
    for (const text of [SENTENCE_CLOCK, SENTENCE_DATED, '已达到 5 小时的使用上限']) expect(classifyError(text), text).toBe('quota');
  });

  // P76r2 第 6 节同步（R7）：原来这里有一项单独的 limit reached；现在单独的 limit reached 不再算额度用完（context limit reached 之类会误认），
  // 只认与额度有关的组合，所以这一项换成 usage limit reached 和 token limit reached（原意：补上的英文「limit reached」写法仍被认出）。
  it.each(['使用上限', '限额', '已达上限', 'usage limit reached', 'token limit reached', 'Rate limit reached for requests', 'rate_limit_exceeded', 'RATE_LIMIT'])('补上的关键词：%s', word => {
    expect(classifyError(`请求失败：${word}`)).toBe('quota');
  });

  it('反例：普通的超时、网络断开、参数错误、运行结果不对，不被认成额度用完', () => {
    expect(classifyError('请求超时，没有收到响应')).not.toBe('quota');
    expect(classifyError('ECONNRESET')).toBe('network');
    expect(classifyError('网络断开')).toBe('network');
    expect(classifyError('参数错误：缺少必填项 name')).toBe('other');
    expect(classifyError('运行结果不正确')).toBe('other');
  });

  it('先看错误代号和状态码，再看文字：代号含 RATE_LIMIT 或 QUOTA（不分大小写）、状态码 429，正文没有任何关键词也认；其他代号和状态码不认', () => {
    expect(classifyError('服务暂时繁忙', 'RATE_LIMIT')).toBe('quota');
    expect(classifyError('服务暂时繁忙', 'account_quota_exceeded')).toBe('quota');
    expect(classifyError('服务暂时繁忙', undefined, 429)).toBe('quota');
    expect(classifyError('服务暂时繁忙', 'TIMEOUT', 504)).toBe('other');
    expect(classifyError('服务暂时繁忙', null, null)).toBe('other');
    // 代号、状态码和文字不一致时，代号和状态码优先：文字像鉴权，状态码是 429，按额度用完。
    expect(classifyError('401 Unauthorized', 'RATE_LIMIT')).toBe('quota');
    expect(classifyError('401 Unauthorized')).toBe('auth');
  });
});

describe('2 恢复时间解析（parseResetAt）', () => {
  const parse = (text: string, now: string) => parseResetAt(text, at(now), TZ);

  it('「将于 07:53 恢复」：现在 06:48 -> 今天 07:53', () => {
    expect(parse('将于 07:53 恢复', '2026-11-13T06:48:00')).toBe(at('2026-11-13T07:53:00'));
  });
  it('「将于 00:30 恢复」：现在 23:50 -> 次日 00:30', () => {
    expect(parse('将于 00:30 恢复', '2026-11-13T23:50:00')).toBe(at('2026-11-14T00:30:00'));
  });
  it('P76a 实测句：「将于 15:53 恢复」（现在 14:48）', () => {
    expect(parse(SENTENCE_CLOCK, '2026-11-13T14:48:00')).toBe(at('2026-11-13T15:53:00'));
  });
  it('P76a 实测句：「将在 2026-11-13 16:14:31 重置」（现在 15:30）：认带日期的完整时刻，不是今天的 16:14', () => {
    expect(parse(SENTENCE_DATED, '2026-11-13T15:30:00')).toBe(at('2026-11-13T16:14:31'));
    // 对照：不带日期的写法同一个时刻只到分钟。
    expect(parse('将于 16:14 恢复', '2026-11-13T15:30:00')).toBe(at('2026-11-13T16:14:00'));
  });
  it('带日期的时刻不能被当成「钟点」：现在是 15 日 00:10，正文写 2026-11-15 04:30:00，取 15 日 04:30，不是次日 04:30 以外的别的时刻', () => {
    expect(parse('将在 2026-11-15 04:30:00 重置', '2026-11-15T00:10:00')).toBe(at('2026-11-15T04:30:00'));
  });
  it('带日期的时刻按设置的时区理解（不带时区时）：同一句话在东京时区早一小时', () => {
    // 现在是上海 14:30（东京 15:30）；同一句「16:14:31」在东京时区是 16:14:31+09:00，比上海时区的 16:14:31+08:00 早一小时。
    expect(parseResetAt('将在 2026-11-13 16:14:31 重置', at('2026-11-13T14:30:00'), 'Asia/Tokyo')).toBe(Date.parse('2026-11-13T16:14:31+09:00'));
    expect(parseResetAt('将在 2026-11-13 16:14:31 重置', at('2026-11-13T14:30:00'), TZ)).toBe(at('2026-11-13T16:14:31'));
  });
  it('ISO 时间（带时区）：2026-11-13T07:53:00+08:00，以及 Z 结尾', () => {
    expect(parse('reset at 2026-11-13T07:53:00+08:00', '2026-11-13T06:48:00')).toBe(at('2026-11-13T07:53:00'));
    expect(parse('reset at 2026-11-12T23:53:00Z', '2026-11-13T06:48:00')).toBe(Date.parse('2026-11-12T23:53:00Z'));
  });
  it('「65 分钟后」「1 小时 5 分钟后」「in 2 hours」「in 90 minutes」', () => {
    const now = at('2026-11-13T06:48:00');
    expect(parse('请 65 分钟后重试', '2026-11-13T06:48:00')).toBe(now + 65 * MINUTE);
    expect(parse('请 1 小时 5 分钟后重试', '2026-11-13T06:48:00')).toBe(now + 65 * MINUTE);
    expect(parse('请 2 小时后再试', '2026-11-13T06:48:00')).toBe(now + 2 * HOUR);
    expect(parse('try again in 2 hours', '2026-11-13T06:48:00')).toBe(now + 2 * HOUR);
    expect(parse('try again in 90 minutes', '2026-11-13T06:48:00')).toBe(now + 90 * MINUTE);
  });
  it('顺序：同一句话里有带日期的完整时刻，又有别的钟点和「N 分钟后」时，取带日期的；有钟点又有「N 分钟后」时取钟点', () => {
    expect(parse('已用 3 分钟后的数据，将在 2026-11-13 16:14:31 重置，约 16:10 左右', '2026-11-13T15:30:00')).toBe(at('2026-11-13T16:14:31'));
    expect(parse('将于 16:00 恢复（约 30 分钟后）', '2026-11-13T15:30:00')).toBe(at('2026-11-13T16:00:00'));
  });

  it('反例：「将于 13:00 恢复」现在 06:48（超过 5 小时 10 分钟）-> null；没有时间的正文 -> null', () => {
    expect(parse('将于 13:00 恢复', '2026-11-13T06:48:00')).toBeNull();
    expect(parse('已达到 5 小时的使用上限', '2026-11-13T06:48:00')).toBeNull();
    expect(parse('', '2026-11-13T06:48:00')).toBeNull();
  });
  it('范围边界：正好 5 小时 10 分钟取，多 1 毫秒不取；过去的带日期时刻不取；不存在的钟点或日期不取', () => {
    const now = at('2026-11-13T06:48:00');
    const edge = now + BUDGET_DEFAULTS.RESET_TEXT_MAX_AHEAD_MS;
    expect(parseResetAt('将于 11:58 恢复', now, TZ)).toBe(edge);
    expect(parseResetAt('将在 2026-11-13 11:58:00 重置', now, TZ)).toBe(edge);
    expect(parseResetAt('将在 2026-11-13 11:58:01 重置', now, TZ)).toBeNull();
    expect(parseResetAt('将在 2026-11-13 06:00:00 重置', now, TZ)).toBeNull();
    expect(parseResetAt('将于 25:61 恢复', now, TZ)).toBeNull();
    expect(parseResetAt('将在 2026-02-30 10:00:00 重置', now, TZ)).toBeNull();
  });
});

describe('3 报错：按裁定写 redUntil 与窗口起点；解析不到时退回估计', () => {
  /** 一位在岗员工，假时钟设到指定时刻。 */
  function setup(now: string) {
    const ctx = createTestContext();
    ctx.clock.set(at(now));
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' });
    return ctx;
  }

  it('解析到恢复时间：redUntil = 恢复时刻 + 5 分钟，两处窗口起点都回推为「恢复时刻 - 5 小时」，exhausted.resetFromText 为真', () => {
    const ctx = setup('2026-11-13T14:48:00');
    const quota = onQuotaError(ctx, ctx.clock.now(), SENTENCE_CLOCK);
    const resetAt = at('2026-11-13T15:53:00');
    expect(quota).toMatchObject({ light: 'red', redUntil: resetAt + ctx.settings.quotaResetGraceMs, windowStartAt: resetAt - ctx.settings.quotaWindowMs, lastErrorAt: ctx.clock.now() });
    expect(getQuotaPlan(ctx, ctx.clock.now())).toMatchObject({ windowStartAt: resetAt - ctx.settings.quotaWindowMs,
      exhausted: { at: ctx.clock.now(), resetAt, resetFromText: true } });
    expect(getQuotaPlan(ctx, ctx.clock.now()).errors).toEqual([{ at: ctx.clock.now(), text: SENTENCE_CLOCK, resetAt, pluginTokens: 0 }]);
  });

  it('带日期的写法同样解析：将在 2026-11-13 16:14:31 重置', () => {
    const ctx = setup('2026-11-13T15:30:00');
    const quota = onQuotaError(ctx, ctx.clock.now(), SENTENCE_DATED);
    const resetAt = at('2026-11-13T16:14:31');
    expect(quota.redUntil).toBe(resetAt + 5 * MINUTE);
    expect(getQuotaPlan(ctx, ctx.clock.now()).exhausted).toEqual({ at: ctx.clock.now(), resetAt, resetFromText: true });
  });

  it('解析不到（没有时间 / 超出 5 小时 10 分钟）：退回现状的估计（窗口起点 + 5 小时 + 5 分钟），resetFromText 为假，窗口起点不动', () => {
    for (const text of ['已达到 5 小时的使用上限', '已达到 5 小时的使用上限，将于 23:00 恢复']) {
      const ctx = setup('2026-11-13T14:48:00');
      const windowStart = at('2026-11-13T13:00:00');
      ctx.store.table('quota').put({ ...getQuotaState(ctx, ctx.clock.now()), windowStartAt: windowStart });
      ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(windowStart, windowStart) });
      const quota = onQuotaError(ctx, ctx.clock.now(), text);
      expect(quota).toMatchObject({ redUntil: windowStart + 5 * HOUR + 5 * MINUTE, windowStartAt: windowStart });
      expect(getQuotaPlan(ctx, ctx.clock.now())).toMatchObject({ windowStartAt: windowStart,
        exhausted: { resetAt: windowStart + 5 * HOUR, resetFromText: false } });
      expect(getQuotaPlan(ctx, ctx.clock.now()).errors[0]!.resetAt).toBeNull();
    }
  });

  it('不带报错文字调用（旧调用方）也按估计处理', () => {
    const ctx = setup('2026-11-13T14:48:00');
    const quota = onQuotaError(ctx, ctx.clock.now());
    expect(quota.redUntil).toBe(ctx.clock.now() + 5 * HOUR + 5 * MINUTE);
    expect(getQuotaPlan(ctx, ctx.clock.now()).exhausted?.resetFromText).toBe(false);
  });

  it('被动记录：正文去掉换行、最多 300 字；最多保留 20 条，丢最早的', () => {
    const ctx = setup('2026-11-13T14:48:00');
    onQuotaError(ctx, ctx.clock.now(), `第一行\n第二行\r\n${'字'.repeat(400)}`);
    const row = getQuotaPlan(ctx, ctx.clock.now()).errors[0]!;
    expect([...row.text]).toHaveLength(300);
    expect(row.text).not.toMatch(/[\r\n]/);
    expect(row.text.startsWith('第一行 第二行 ')).toBe(true);
    // P76r2 第 6 节同步（R8）：同一个窗口里再报错只更新恢复时刻、不再追加记录；这条用例的原意是「记录最多 20 条」，
    // 所以每次报错之间先模拟一次恢复（探针成功，真实额度用完的标记清空），让每次都是不同的额度事件。
    for (let i = 0; i < 25; i += 1) {
      ctx.store.table('quotaWindows').patch('quota', { exhausted: null });
      ctx.store.table('quota').patch('quota', { light: 'green', redUntil: null });
      onQuotaError(ctx, ctx.clock.now() + i, `第 ${i} 次`);
    }
    const errors = getQuotaPlan(ctx, ctx.clock.now()).errors;
    expect(errors).toHaveLength(BUDGET_DEFAULTS.QUOTA_ERRORS_MAX);
    expect(errors.at(-1)!.text).toBe('第 24 次');
    expect(errors[0]!.text).toBe('第 5 次');
  });
});

describe('4 校准：只往小处，有下限', () => {
  /** 报错发生时本窗口插件看得到的员工用量给定（写进额度记录），依次触发报错。 */
  function errorWith(ctx: HubContext, pluginTokens: number) {
    // P76r2 第 6 节同步（R8）：每次报错是一次独立的额度事件；同一个窗口里再报错不再校准，所以先模拟一次恢复（真实额度用完的标记清空）。
    ctx.store.table('quotaWindows').patch('quota', { staffTokens: pluginTokens, ownerTokens: 0, exhausted: null });
    ctx.store.table('quota').patch('quota', { light: 'green', redUntil: null });
    onQuotaError(ctx, ctx.clock.now(), '已达到 5 小时的使用上限');
    return getQuotaPlan(ctx, ctx.clock.now());
  }
  it('第一次报错 pluginTokens 800 万 -> 容量 800 万；第二次 900 万 -> 仍 800 万；第三次 500 万 -> 500 万；pluginTokens 50 万 -> 200 万（下限）', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(ctx.clock.now()) });
    ctx.store.table('quota').put({ ...getQuotaState(ctx, ctx.clock.now()) });
    expect(errorWith(ctx, 8_000_000)).toMatchObject({ capacityTokens: 8_000_000, capacitySource: 'calibrated' });
    expect(errorWith(ctx, 9_000_000)).toMatchObject({ capacityTokens: 8_000_000, capacitySource: 'calibrated' });
    expect(errorWith(ctx, 5_000_000)).toMatchObject({ capacityTokens: 5_000_000 });
    expect(errorWith(ctx, 500_000)).toMatchObject({ capacityTokens: BUDGET_DEFAULTS.MIN_WINDOW_TOKENS });
  });
  it('只往小处校准：容量 800 万之后，连续三次报错时插件看到的用量都是 900 万（最近三次的最小值 900 万大于当前容量），容量仍是 800 万', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(ctx.clock.now()) });
    ctx.store.table('quota').put({ ...getQuotaState(ctx, ctx.clock.now()) });
    expect(errorWith(ctx, 8_000_000).capacityTokens).toBe(8_000_000);
    for (let i = 0; i < 3; i += 1) expect(errorWith(ctx, 9_000_000).capacityTokens).toBe(8_000_000);
  });
  it('纯函数：第一次（initial）取 max(下限, 用量)；已校准取 max(下限, min(当前, 最近三次最小值))；最近三次不含更早的', () => {
    const rows = (...tokens: number[]) => tokens.map(pluginTokens => ({ at: 1, text: 'x', resetAt: null, pluginTokens }));
    expect(calibrateCapacity({ capacitySource: 'initial', capacityTokens: 10_000_000, errors: [] }, 1_000_000)).toBe(BUDGET_DEFAULTS.MIN_WINDOW_TOKENS);
    expect(calibrateCapacity({ capacitySource: 'initial', capacityTokens: 10_000_000, errors: [] }, 8_000_000)).toBe(8_000_000);
    expect(calibrateCapacity({ capacitySource: 'calibrated', capacityTokens: 8_000_000, errors: rows(100_000, 8_000_000, 8_000_000) }, 8_000_000)).toBe(8_000_000);
    expect(calibrateCapacity({ capacitySource: 'calibrated', capacityTokens: 8_000_000, errors: rows(3_000_000, 8_000_000, 9_000_000) }, 9_000_000)).toBe(8_000_000);
    expect(calibrateCapacity({ capacitySource: 'calibrated', capacityTokens: 8_000_000, errors: rows(3_000_000, 4_000_000, 9_000_000) }, 9_000_000)).toBe(4_000_000);
  });
});

describe('5 报错不建条目、不推送；员工文字；探针恢复', () => {
  function setup() {
    const ctx = createTestContext();
    ctx.clock.set(at('2026-11-13T14:48:00'));
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' });
    return ctx;
  }
  const counts = (ctx: HubContext) => ({ inbox: ctx.store.table('inbox').count(), alerts: ctx.store.table('alerts').count(), pushes: pushHistory(ctx).length,
    openInbox: ctx.store.table('inbox').count(item => item.status === 'open') });

  it('报错前后「待你处理」条目数、告警数、推送审计条数都不变；员工文字是「在等额度恢复，约 HH:mm 继续」', () => {
    const ctx = setup();
    const before = counts(ctx);
    onQuotaError(ctx, ctx.clock.now(), SENTENCE_CLOCK);
    expect(counts(ctx)).toEqual(before);
    expect(counts(ctx)).toEqual({ inbox: 0, alerts: 0, pushes: 0, openInbox: 0 });
    // 15:53 恢复，再加 5 分钟等待：员工约 15:58 继续。
    expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ activity: 'resting', activityText: '在等额度恢复，约 15:58 继续' });
  });

  it('探针成功后 exhausted 为空，灯按员工份额重算（探针回合用了员工份额的 85%：橙灯）；探针失败（非额度原因）exhausted 保留、再等一个窗口', () => {
    const ctx = setup();
    onQuotaError(ctx, ctx.clock.now(), SENTENCE_CLOCK);
    ctx.clock.set(getQuotaState(ctx, ctx.clock.now()).redUntil!);
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
    expect(consumeProbe(ctx)).toBe(true);
    // 探针回合：用掉员工份额的 85%（容量按报错时 0 用量校准到下限 200 万，份额 140 万；记 119 万）。
    const probe = addWake(ctx, {}, botFixture.id);
    recordUsage(ctx, { botId: botFixture.id, wakeId: probe.id, tokens: 1_190_000, steps: 1, packetBytes: 0 });
    expect(getQuotaPlan(ctx, ctx.clock.now()).staffTokens).toBe(1_190_000);
    expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('red'); // 探针在途，仍是红灯
    expect(onProbeResult(ctx, true)).toMatchObject({ light: 'orange', redUntil: null, probeInFlight: false });
    expect(getQuotaPlan(ctx, ctx.clock.now()).exhausted).toBeNull();
    expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ activity: 'watching', activityText: '继续关注变化' });
    expect(counts(ctx)).toEqual({ inbox: 0, alerts: 0, pushes: 0, openInbox: 0 });

    // 失败的一次（另起一份）：exhausted 保留，期限顺延整个窗口加等待。
    const failed = setup();
    onQuotaError(failed, failed.clock.now(), SENTENCE_CLOCK);
    failed.clock.set(getQuotaState(failed, failed.clock.now()).redUntil!);
    maybeAllowProbe(failed, failed.clock.now()); consumeProbe(failed);
    const result = onProbeResult(failed, false);
    expect(result).toMatchObject({ light: 'red', redUntil: failed.clock.now() + 5 * HOUR + 5 * MINUTE });
    expect(getQuotaPlan(failed, failed.clock.now()).exhausted).not.toBeNull();
  });

  it('旧存档（没有额度记录的红灯，P76d 之前真实报错留下的）按真实额度用完处理：放探针，探针成功恢复', () => {
    const ctx = setup();
    const now = ctx.clock.now();
    ctx.store.table('quota').put({ id: 'quota', windowStartAt: now - HOUR, botTurns: 5, botTokens: 100, turnLimit: 40, tokenLimit: null, light: 'red',
      redUntil: now + 4 * HOUR + 5 * MINUTE, probeAllowed: false, lastError: '额度不足', lastErrorAt: now - 30 * MINUTE });
    expect(getQuotaPlan(ctx, now).exhausted).toBeNull();
    expect(maybeAllowProbe(ctx, now + 4 * HOUR + 4 * MINUTE)).toBe(false);
    expect(maybeAllowProbe(ctx, now + 4 * HOUR + 5 * MINUTE)).toBe(true);
    expect(getQuotaPlan(ctx, now).exhausted).toMatchObject({ resetFromText: false });
    consumeProbe(ctx);
    ctx.clock.set(now + 4 * HOUR + 5 * MINUTE);
    expect(onProbeResult(ctx, true).light).toBe('green');
  });
});

describe('6 额度用完的报错不计入连续出错次数、不排按出错退避的重试；普通出错照旧', () => {
  const NOW = at('2026-11-13T14:48:00');

  it('同一位员工连续 6 次额度用完的报错：连续出错次数始终是 0，没有退避时刻，没有被停用；对照：普通出错第 1 次计 1、排退避，到第 4 次停用', () => {
    const ctx = createTestContext();
    ctx.clock.set(NOW);
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    for (let i = 0; i < 6; i += 1) {
      expect(onDispatchOrTurnError(ctx, botFixture.id, SENTENCE_CLOCK, NOW + i * MINUTE)).toEqual({ action: 'quota', retryAt: null });
      expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ consecutiveErrors: 0, retryAt: null, lifecycle: 'active' });
    }
    const ordinary = createTestContext();
    ordinary.clock.set(NOW);
    ordinary.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    expect(onDispatchOrTurnError(ordinary, botFixture.id, 'read ECONNRESET', NOW)).toMatchObject({ action: 'retry' });
    expect(ordinary.store.table('bots').get(botFixture.id)).toMatchObject({ consecutiveErrors: 1, lifecycle: 'active' });
    expect(ordinary.store.table('bots').get(botFixture.id)!.retryAt).toBeGreaterThan(NOW);
    for (let i = 1; i <= 2; i += 1) onDispatchOrTurnError(ordinary, botFixture.id, 'read ECONNRESET', NOW + i * MINUTE);
    expect(onDispatchOrTurnError(ordinary, botFixture.id, 'read ECONNRESET', NOW + 3 * MINUTE)).toMatchObject({ action: 'quarantined' });
    expect(ordinary.store.table('bots').get(botFixture.id)!.lifecycle).toBe('quarantined');
  });

  it('错误代号、状态码一并交来时同样走额度路径：正文没有任何关键词，代号 RATE_LIMIT 或状态码 429 也不计入连续出错次数', () => {
    const ctx = createTestContext();
    ctx.clock.set(NOW);
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    expect(onDispatchOrTurnError(ctx, botFixture.id, '服务暂时繁忙', NOW, { errorCode: 'RATE_LIMIT' })).toEqual({ action: 'quota', retryAt: null });
    expect(onDispatchOrTurnError(ctx, botFixture.id, '服务暂时繁忙', NOW, { statusCode: 429 })).toEqual({ action: 'quota', retryAt: null });
    expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ consecutiveErrors: 0, retryAt: null });
    // 反例：别的代号和状态码照旧按普通出错处理。
    expect(onDispatchOrTurnError(ctx, botFixture.id, '服务暂时繁忙', NOW, { errorCode: 'SERVER', statusCode: 503 })).toMatchObject({ action: 'retry' });
    expect(ctx.store.table('bots').get(botFixture.id)!.consecutiveErrors).toBe(1);
  });

  it('真实回合：三位员工各有一个回合报错（宿主交来的只有那一句话）：没有人被停用，没有退避重试的候选；到恢复时刻放一个探针回合，探针成功恢复', async () => {
    const hang: Brain = async () => ({ hang: true });
    const ids = ['b_0000000001', 'b_0000000002', 'b_0000000003'];
    const world = await createSimWorld({ startAt: at('2026-11-13T14:48:00'), settings: { maxConcurrentThinks: 3, ownerActiveConcurrentThinks: 3 },
      bots: ids.map((id, index) => ({ id, name: `员工${index + 1}`, brain: hang })) });
    for (const id of ids) await world.hub.api.sendMessage(id, '做一下今天的事');
    await world.host.settle();
    expect(world.store.table('wakes').list(row => row.endedAt === null)).toHaveLength(3);
    world.clock.advance(MINUTE);
    for (const id of ids) {
      const sessionId = world.store.table('bots').get(id)!.sessionId!;
      world.host.sessions.get(sessionId)!.running = false;
      await world.hub.onTurnEvent({ type: 'error', sessionId, at: world.clock.now(), errorText: SENTENCE_CLOCK });
    }
    for (const id of ids) {
      expect(world.store.table('bots').get(id), id).toMatchObject({ consecutiveErrors: 0, retryAt: null, lifecycle: 'active' });
    }
    // P76r1（4b）同步：三位员工的回合都是主人发来消息叫醒的，被额度报错打断后各留一条候选（原来断言队列里没有任何 retry 候选）；
    // 原意（没有「按出错退避」的重试）不变：这三条的理由都是「额度用完，恢复后继续上一轮的事」，带「主人发起」。
    const kept = world.store.table('queue').list(entry => entry.reason.kind === 'retry');
    expect(kept).toHaveLength(3);
    for (const entry of kept) expect(entry).toMatchObject({ ownerInitiated: true, reason: { summary: '额度用完，恢复后继续上一轮的事' } });
    expect(world.store.table('queue').list(entry => entry.reason.summary.includes('按出错退避'))).toEqual([]);
    expect(world.store.table('alerts').list(alert => alert.code === 'quota')).toEqual([]);
    const plan = world.store.table('quotaWindows').get('quota')!;
    // P76r2 第 6 节同步（R8）：三位员工在同一个窗口里各报一次，是同一次额度用完，报错记录只记一条（原来是三条）。
    expect(plan.errors).toHaveLength(1);
    const redUntil = world.store.table('quota').get('quota')!.redUntil!;
    expect(redUntil).toBe(at('2026-11-13T15:58:00'));
    // 到恢复时刻：放一个探针回合；探针成功后恢复。
    // P76r1（4b）同步：原来此刻只有「许可」（probeAllowed），要再发一句「试一下」才有探针；现在被保留的主人发起的候选在恢复时刻就是探针，
    // 所以不再需要第二句话，改为断言探针回合就是保留下来的候选（唤醒原因 retry、带「主人发起」）。三位员工都换成安静的脑，任何一位当探针都能结束。
    for (const id of ids) world.host.registerBrain(id, quietBrain);
    await advance(world, redUntil - world.clock.now());
    await world.host.settle();
    expect(world.store.table('wakes').list(row => row.reason.kind === 'retry' && row.ownerInitiated).length).toBeGreaterThanOrEqual(1);
    await advance(world, MINUTE);
    expect(world.store.table('quota').get('quota')!.light).toBe('green');
    expect(world.store.table('quotaWindows').get('quota')!.exhausted).toBeNull();
    await world.hub.stop();
  });

  it('真实回合：宿主交来错误代号和状态码、正文没有关键词，同样亮红灯、不计出错次数（经真实的回合事件入口）', async () => {
    const world = await createSimWorld({ startAt: at('2026-11-13T14:48:00'), bots: [{ id: 'b_0000000001', name: '员工一', brain: async () => ({ hang: true }) }] });
    await world.hub.api.sendMessage('b_0000000001', '做一下今天的事');
    await world.host.settle();
    const sessionId = world.store.table('bots').get('b_0000000001')!.sessionId!;
    world.host.sessions.get(sessionId)!.running = false;
    world.clock.advance(MINUTE);
    await world.hub.onTurnEvent({ type: 'error', sessionId, at: world.clock.now(), errorText: '服务暂时繁忙', errorCode: 'RATE_LIMIT', statusCode: 429 });
    expect(world.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    expect(world.store.table('bots').get('b_0000000001')).toMatchObject({ consecutiveErrors: 0, retryAt: null });
    await world.hub.stop();
  });

  it('被打断的是一件事里的回合：这件事的下一步留在队列里（不写「按出错退避」），恢复时刻探针回合放行它，探针成功之后接着做；进度行写恢复时间', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const engineerId = fix.engineer.id;
    await tick(fix, MINUTE);
    const sessionId = botOf(fix, engineerId).sessionId!;
    const now = fix.ctx.clock.now();
    const hm = (value: number) => new Date(value + 8 * HOUR).toISOString().slice(11, 16);
    const resetAt = now + 65 * MINUTE;
    await fix.hub.onTurnEvent({ type: 'error', sessionId, at: now, errorText: `已达到 5 小时的使用上限，将于 ${hm(resetAt)} 恢复` });
    // 只有「几点」没有秒：解析出的时刻是整分钟，向下取整到分钟之后的那个时刻。
    const resetMinute = Math.floor(resetAt / MINUTE) * MINUTE;
    const quota = fix.ctx.store.table('quota').get('quota')!;
    expect(quota).toMatchObject({ light: 'red', redUntil: resetMinute + 5 * MINUTE });
    expect(botOf(fix, engineerId)).toMatchObject({ consecutiveErrors: 0, retryAt: null, lifecycle: 'active' });
    // 没有退避重试的候选；这件事的下一步排在队列里，等额度恢复。
    const queued = entriesOf(fix, engineerId, job.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason.summary).toBe('额度用完，恢复后继续上一轮的事');
    expect(queued[0]!.reason.summary).not.toContain('按出错退避');
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBe(`额度恢复，约 ${hm(quota.redUntil!)} 继续`);
    // 恢复之前一直等：推进 10 分钟、再推进 10 分钟，没有新回合。
    await tick(fix, 10 * MINUTE); await tick(fix, 10 * MINUTE);
    expect(runningOf(fix, engineerId)).toBeUndefined();
    expect(entriesOf(fix, engineerId, job.id)).toHaveLength(1);
    // 到恢复时刻：放一个探针回合，被打断的这件事的下一步就是它。
    fix.ctx.clock.set(quota.redUntil!);
    await fix.hub.tick();
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: true });
    expect(runningOf(fix, engineerId)).toMatchObject({ jobId: job.id });
    expect(wakesOf(fix, engineerId, job.id)).toHaveLength(2);
    await commitAndEnd(fix, engineerId, { outcome: 'progress', summary: '额度恢复后接着做' });
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'green', redUntil: null });
    expect(fix.ctx.store.table('quotaWindows').get('quota')!.exhausted).toBeNull();
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote ?? '').not.toContain('额度恢复');
  });
});
