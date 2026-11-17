/**
 * P80：token 数量自动换算单位。
 * 1 换算函数：任务卡第 1 节的例子表逐条，加两条性质（不含空格、整数倍不带小数点）。
 * 2 核心拼给主人看的「额度」一句（总览的 quota.usedText）用换算后的写法，回合数不换算。
 */
import { describe, expect, it } from 'vitest';
import { overview } from '../src/api/summary-views.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { getQuotaState } from '../src/quota/window.js';
import { TURN_TOKEN_RANGE_TEXT } from '../src/team/templates.js';
import { formatTokenCount } from '../src/util/token-format.js';

/** 任务卡第 1 节的例子表（输入，期望输出）。 */
const TABLE: ReadonlyArray<readonly [number, string]> = [
  [0, '0'],
  [999, '999'],
  [1000, '1K'],
  [1500, '1.5K'],
  [59970, '60K'],
  [123456, '123K'],
  [999499, '999K'],
  [999500, '1M'],
  [1065566, '1.07M'],
  [1281646, '1.28M'],
  [1636469, '1.64M'],
  [12345678, '12.3M'],
  [2500000000, '2.5B'],
  [1000000000000, '1T'],
  [1234567890123456, '1235T'],
  [-5, '0'],
  [Number.NaN, '0'],
];

describe('P80 formatTokenCount：换算规则', () => {
  it.each(TABLE)('%s 写成 %s', (input, expected) => {
    expect(formatTokenCount(input)).toBe(expected);
  });

  it('其余边界：小数先四舍五入；无穷大按 0；856 原样；各单位交界进位', () => {
    expect(formatTokenCount(856)).toBe('856');
    expect(formatTokenCount(999.4)).toBe('999');
    expect(formatTokenCount(999.5)).toBe('1K');
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokenCount(Number.NEGATIVE_INFINITY)).toBe('0');
    expect(formatTokenCount(999_500_000)).toBe('1B');
    expect(formatTokenCount(999_500_000_000)).toBe('1T');
    expect(formatTokenCount(9995)).toBe('10K');
  });

  it('性质：输出里不含空格', () => {
    for (const [input] of TABLE) expect(formatTokenCount(input)).not.toContain(' ');
    for (const n of [1, 10, 999, 1000, 54321, 7_654_321, 3_000_000_000, 5e15]) expect(formatTokenCount(n)).not.toContain(' ');
  });

  it('性质：1000、1000000、10 亿的 1 至 999 倍（正好三位有效数字）不带小数点', () => {
    for (const unit of [1_000, 1_000_000, 1_000_000_000]) {
      for (let k = 1; k <= 999; k += 1) {
        const text = formatTokenCount(k * unit);
        expect(text, `${k * unit}`).not.toContain('.');
        expect(text).toMatch(/^\d+[KMB]$/);
      }
    }
  });
});

describe('P80 核心拼给主人看的句子', () => {
  it('总览的额度一句：回合数不换算，token 换算；1636469 写成 1.64M', () => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub' }) });
    const now = ctx.clock.now();
    ctx.store.table('quota').put({ ...getQuotaState(ctx, now), windowStartAt: now, botTurns: 6, turnLimit: 40, botTokens: 1636469 });
    const text = overview(ctx).quota.usedText;
    expect(text).toBe('6 / 40 回合，1.64M token');
    expect(text).toContain('6 / 40 回合');
    expect(text).not.toContain('1636469');
  });

  it('总览的额度一句：不足 1000 的 token 原样写', () => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub' }) });
    const now = ctx.clock.now();
    ctx.store.table('quota').put({ ...getQuotaState(ctx, now), windowStartAt: now, botTurns: 1, turnLimit: 40, botTokens: 856 });
    expect(overview(ctx).quota.usedText).toBe('1 / 40 回合，856 token');
  });

  it('组队页脚的「1 个回合约……」：用 K 单位', () => {
    expect(TURN_TOKEN_RANGE_TEXT).toBe('1 个回合约 110K 到 160K token');
  });
});
