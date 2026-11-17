/**
 * P76r2 第 6 节、第 7 节的测试。
 *
 * 第 6 节第 1、2 条（R7）：额度报错按文字识别时收窄：
 *   单独的 limit reached 不再算；与额度有关的组合才算（usage limit reached、rate limit reached、token limit reached、quota 与 reached 或 exceeded 同句）；
 *   同一句说的是上下文、步数、轮数、长度、输出的上限时，按普通出错处理（对中文的「已达上限」「使用上限」同样适用）；
 *   错误代号、状态码的判断不变，仍先于文字；P76a 实测到的每一句报错原文仍被认成额度用完。
 * 第 6 节第 3 条（R8）：同一个窗口里已经记了真实额度用完时，后面的额度报错只更新恢复时刻，不再追加报错记录。
 * 第 7 节（R9 的第二点）：掉线检测排的重试，手上有原来那张唤醒单（投递卡住的）时沿用它的归属，证据第一项放它的编号。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { classifyError } from '../src/quota/errors.js';
import { getQuotaPlan } from '../src/quota/plan.js';
import { consumeProbe, getQuotaState, maybeAllowProbe, onProbeResult, onQuotaError } from '../src/quota/index.js';
import { checkDeadman } from '../src/health/deadman.js';
import { selfWorkUsageToday, isSelfWork } from '../src/quota/usage.js';
import { botFixture } from './model-fixtures.js';
import { addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (text: string) => Date.parse(`${text}+08:00`);
/** P76a 实测到的报错原文。 */
const P76A_TEXTS = ['已达到 5 小时的使用上限，将于 15:53 恢复', '已达到 5 小时的使用上限，将在 2026-11-13 16:14:31 重置', '已达到 5 小时的使用上限',
  '{"error":{"code":"rate_limit","message":"已达到 5 小时的使用上限，将于 15:53 恢复"}}'];

describe('6.1、6.2 额度报错的文字识别收窄', () => {
  it('P76a 实测到的每一句报错原文仍被认成额度用完', () => {
    for (const text of P76A_TEXTS) expect(classifyError(text), text).toBe('quota');
  });

  it.each(['usage limit reached', 'rate limit reached', 'token limit reached', 'Usage Limit Reached for this plan', 'quota exceeded', 'Quota has been reached',
    'You have reached your quota', 'Rate Limit Reached for requests'])('额度相关的组合仍算额度用完：%s', text => {
    expect(classifyError(`请求失败：${text}`)).toBe('quota');
  });

  it.each(['context limit reached', 'max steps limit reached', 'output length limit reached', 'turn limit reached', '上下文长度已达上限', '步数已达上限',
    '输出长度超出限制', '对话轮数已达上限', 'limit reached'])('反例：不是额度用完，按普通出错处理：%s', text => {
    expect(classifyError(`请求失败：${text}`), text).toBe('other');
  });

  it('同一句里有上下文、步数等词才排除；分成两句的，另一句是额度的仍算额度用完', () => {
    expect(classifyError('上下文长度超出限制。已达到 5 小时的使用上限，将于 15:53 恢复')).toBe('quota');
    expect(classifyError('rate limit reached, context ok')).toBe('other'); // 逗号不分句：同一句里有 context
    expect(classifyError('rate limit reached; context ok')).toBe('quota'); // 分号分句：额度那一句里没有 context
  });

  it('错误代号和状态码的判断不变，仍先于文字：文字说的是上下文上限，代号是 RATE_LIMIT 或状态码是 429，照旧认额度用完', () => {
    expect(classifyError('context limit reached', 'RATE_LIMIT')).toBe('quota');
    expect(classifyError('context limit reached', undefined, 429)).toBe('quota');
    expect(classifyError('context limit reached', 'CONTEXT_TOO_LONG', 400)).toBe('other');
  });
});

describe('6.3 同一次额度用完只记一次', () => {
  function setup() {
    const ctx = createTestContext();
    ctx.clock.set(at('2026-11-13T14:48:00'));
    for (const id of ['b_0000000001', 'b_0000000002', 'b_0000000003']) {
      ctx.store.table('bots').put({ ...botFixture, id, name: id, homeDir: `/hub/bots/${id}`, lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' });
    }
    return ctx;
  }
  const text = (hm: string) => `已达到 5 小时的使用上限，将于 ${hm} 恢复`;

  it('三位员工在同一个窗口里各报一次：报错记录只多一条；恢复时刻跟着最新的报错更新；容量只校准一次', () => {
    const ctx = setup();
    onQuotaError(ctx, ctx.clock.now(), text('15:53'));
    const first = getQuotaPlan(ctx, ctx.clock.now());
    expect(first.errors).toHaveLength(1);
    ctx.clock.advance(MINUTE);
    onQuotaError(ctx, ctx.clock.now(), text('15:54'));
    ctx.clock.advance(MINUTE);
    onQuotaError(ctx, ctx.clock.now(), text('15:54'));
    const plan = getQuotaPlan(ctx, ctx.clock.now());
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toEqual(first.errors[0]);
    expect(plan.capacityTokens).toBe(first.capacityTokens);
    expect(plan.exhausted).toMatchObject({ at: first.exhausted!.at, resetAt: at('2026-11-13T15:54:00'), resetFromText: true });
    expect(getQuotaState(ctx, ctx.clock.now())).toMatchObject({ light: 'red', redUntil: at('2026-11-13T15:54:00') + 5 * MINUTE });
  });

  it('下一个窗口再报（探针回合报额度、或恢复之后又报）：照常追加', () => {
    const ctx = setup();
    onQuotaError(ctx, ctx.clock.now(), text('15:53'));
    onQuotaError(ctx, ctx.clock.now(), text('15:53'));
    expect(getQuotaPlan(ctx, ctx.clock.now()).errors).toHaveLength(1);
    // 到恢复时刻放探针，探针回合又报额度：新的额度事件，追加。
    ctx.clock.set(getQuotaState(ctx, ctx.clock.now()).redUntil!);
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
    expect(consumeProbe(ctx)).toBe(true);
    ctx.clock.advance(MINUTE);
    onQuotaError(ctx, ctx.clock.now(), `已达到 5 小时的使用上限，将于 ${new Date(ctx.clock.now() + 65 * MINUTE + 8 * HOUR).toISOString().slice(11, 16)} 恢复`);
    expect(getQuotaPlan(ctx, ctx.clock.now()).errors).toHaveLength(2);
    // 探针成功、额度恢复之后，之后的窗口再报：再追加。
    ctx.clock.set(getQuotaState(ctx, ctx.clock.now()).redUntil!);
    maybeAllowProbe(ctx, ctx.clock.now()); consumeProbe(ctx);
    onProbeResult(ctx, true);
    expect(getQuotaPlan(ctx, ctx.clock.now()).exhausted).toBeNull();
    ctx.clock.advance(10 * MINUTE);
    onQuotaError(ctx, ctx.clock.now(), text('23:50'));
    expect(getQuotaPlan(ctx, ctx.clock.now()).errors).toHaveLength(3);
  });
});

describe('7 掉线检测排的重试沿用原回合的归属', () => {
  /**
   * 一位员工的投递卡住（超过 deliveryTimeoutMs 仍是投递中）：掉线检测手上有这张唤醒单。
   * 员工是 researcher，当天已有名额；原回合是总管派出的活（chiefDispatch），不算员工自己发起。
   */
  function stuck(patch: Parameters<typeof addWake>[1] = {}) {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', expectedBy: ctx.clock.now() - HOUR });
    const original = addWake(ctx, { status: 'delivering', dispatchedAt: null, endedAt: null, startedAt: ctx.clock.now() - 10 * MINUTE, lastEventAt: ctx.clock.now() - 10 * MINUTE, ...patch }, botFixture.id);
    return { ctx, original };
  }

  it('投递卡住的原唤醒单是总管派出的活：重试带 chiefDispatch，证据第一项是原唤醒单编号；不算自己发起，且原回合没有真正投递过所以照数一个名额', () => {
    const { ctx, original } = stuck({ chiefDispatch: true });
    const [candidate] = checkDeadman(ctx, ctx.clock.now());
    expect(candidate, '前提：掉线检测排了重试').toBeDefined();
    expect(candidate!.reason.evidence[0]).toBe(original.id);
    expect(candidate).toMatchObject({ chiefDispatch: true, retryOfSelfWork: false, subjectKey: `deadman:${botFixture.id}` });
    expect(isSelfWork({ ...candidate!, reason: candidate!.reason }, 'researcher')).toBe(false);
  });

  it('原回合是员工自己发起的：重试带 retryOfSelfWork 为 true（仍算自己发起）；证据第一项是原唤醒单编号', () => {
    const { ctx, original } = stuck();
    const [candidate] = checkDeadman(ctx, ctx.clock.now());
    expect(candidate!.reason.evidence[0]).toBe(original.id);
    expect(candidate).toMatchObject({ retryOfSelfWork: true });
    expect(candidate!.chiefDispatch).toBeUndefined();
  });

  it('原回合真正投递过时，这个重试不另占当天名额（证据第一项放原唤醒单编号才有这个效果）', () => {
    const { ctx, original } = stuck();
    ctx.store.table('wakes').patch(original.id, { dispatchedAt: ctx.clock.now() - 9 * MINUTE });
    const [candidate] = checkDeadman(ctx, ctx.clock.now());
    const retry = addWake(ctx, { reason: candidate!.reason, subjectKey: candidate!.subjectKey, startedAt: ctx.clock.now() - 1_000 }, botFixture.id);
    // 原唤醒单（投递过、员工自己发起的）数一个名额，这个重试不另数。
    expect(selfWorkUsageToday(ctx, botFixture.id, ctx.clock.now()).turns).toBe(1);
    expect(retry.reason.evidence[0]).toBe(original.id);
  });

  it('没有原来那张唤醒单（没有回合卡住，只是该动没动）：不改，仍只有告警编号一项证据、不带归属标记', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', expectedBy: ctx.clock.now() - HOUR });
    const [candidate] = checkDeadman(ctx, ctx.clock.now());
    expect(candidate!.reason.evidence).toHaveLength(1);
    expect(candidate!.retryOfSelfWork).toBeUndefined();
    expect(candidate!.chiefDispatch).toBeUndefined();
  });
});
