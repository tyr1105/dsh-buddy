/**
 * P74r12 第 2 节的测试：「暂停，等你确认」清单每行的内容（冒号之后）最多 60 个字，不出现空行或只剩「……」的行；
 * 约定固定之后落的话不再拼清单，只写暂停的总处数（逐字的那一句在 p74e-b2.test.ts 的「主人确认：四条途径」里断言）。
 */
import { describe, expect, it } from 'vitest';
import { buildPause, pauseContent, pausedCount, touchedItems } from '../src/job/pause.js';
import { contentFixture } from './p72a-agreement-fixtures.js';

describe('清单每行的内容', () => {
  it('每一行内容不为空、不是「……」；带序号的栏写「{栏名}第 n 条：{内容}」，没有序号的栏写「{栏名}：{内容}」', () => {
    const locked = contentFixture();
    const next = contentFixture();
    next.summary = '做一个能查看每日报价、并且带提醒的小页面';
    next.scopeIn = ['报价列表页', '手动刷新', '价格提醒'];
    next.doneWhen = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时显示「加载失败」，并且不白屏、不报错'];
    const lines = touchedItems(locked, next).map(item => item.line);
    // P74r16b 第 3.1 节：清单不再列「一句话」；其余各项不变。
    expect(lines).toEqual([
      '这次做第 3 条：价格提醒', '怎样算做完第 3 条：接口失败时显示「加载失败」，并且不白屏、不报错',
    ]);
    for (const line of lines) {
      const content = line.slice(line.indexOf('：') + 1);
      expect(content.trim()).not.toBe('');
      expect(content).not.toMatch(/^…+$/);
    }
  });

  it('恰好 60 个字不加「…」，61 个字截到 60 个字并加「…」；栏名和序号不算在内', () => {
    const locked = contentFixture();
    const next = contentFixture();
    next.scopeIn = [...locked.scopeIn, '甲'.repeat(60)];
    expect(touchedItems(locked, next).map(item => item.line)).toEqual([`这次做第 3 条：${'甲'.repeat(60)}`]);
    next.scopeIn = [...locked.scopeIn, '甲'.repeat(61)];
    expect(touchedItems(locked, next).map(item => item.line)).toEqual([`这次做第 3 条：${'甲'.repeat(60)}…`]);
    // 纯函数本身：空白压成一格；空内容不留空行。
    expect(pauseContent('甲  乙\n丙')).toBe('甲 乙 丙');
    expect(pauseContent('   ')).toBe('（没有文字）');
  });

  it('清单超过 6 行时最后一行写「另有 n 处，见约定卡」，暂停的总处数仍记全', () => {
    const locked = contentFixture();
    const many = contentFixture();
    many.scopeIn = ['甲甲甲', '乙乙乙', '丙丙丙', '丁丁丁', '戊戊戊', '己己己'];
    many.doneWhen = ['子子子', '丑丑丑', '寅寅寅'];
    const pause = buildPause(2, locked, many, { continuing: ['无关的一项'], paused: ['额外的一项'], fallback: undefined });
    expect(pause.paused).toHaveLength(6);
    expect(pause.paused[5]).toMatch(/^另有 \d+ 处，见约定卡$/);
    expect(pausedCount(pause)).toBeGreaterThan(6);
    // 旧数据没有总处数：按显示的行数和最后一行的「另有 n 处」算。
    const old = { paused: ['甲', '乙', '另有 4 处，见约定卡'] };
    expect(pausedCount(old)).toBe(6);
    expect(pausedCount({ paused: ['甲', '乙'] })).toBe(2);
  });
});
