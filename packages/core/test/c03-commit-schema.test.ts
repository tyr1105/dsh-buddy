/** 交账协议按字段验证正反例，确保输入错误在产生任何业务副作用前被拒绝。 */
import { describe, expect, test } from 'vitest';
import { CommitInputSchema } from '../src/commit/schema.js';
import { commitArgs } from './c03-turn-fixtures.js';

describe('交账结构与条件校验', () => {
  test.each([
    ['no_change', {}], ['progress', {}], ['done', {}], ['blocked', { blocker: '缺少资料' }],
    ['needs_owner', { ownerQuestion: { text: '选哪个', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '推进需要决定' } }],
  ] as const)('接受 %s 的完整输入', (outcome, patch) => expect(CommitInputSchema.safeParse({ ...commitArgs(), outcome, ...patch }).success).toBe(true));
  test.each([
    { mode: 'auto', reason: '等变化' }, { mode: 'on_event', onEvent: '资料更新', reason: '等待资料' },
    { mode: 'after', afterMinutes: 10, reason: '短暂等待' }, { mode: 'at', at: '2026-11-06 09:00', reason: '等待早间资料' },
    { mode: 'at', at: '2026-11-06T01:00:00Z', reason: '等待资料' },
  ])('接受模式对应的参数 $mode', nextThink => expect(CommitInputSchema.safeParse({ ...commitArgs(), nextThink }).success).toBe(true));
  test.each([
    ['outcome', { outcome: 'unknown' }], ['summary', { summary: '' }], ['summary', { summary: '   ' }],
    ['summary', { summary: '中'.repeat(501) }], ['blocker', { outcome: 'blocked', blocker: ' ' }],
    ['ownerQuestion', { outcome: 'needs_owner' }], ['importance', { importance: 0 }],
    ['importance', { importance: 11 }], ['importance', { importance: 1.5 }],
    ['nextThink.reason', { nextThink: { mode: 'auto', reason: ' ' } }],
    ['nextThink.reason', { nextThink: { mode: 'auto', reason: '长'.repeat(201) } }],
    ['nextThink.at', { nextThink: { mode: 'at', reason: '等资料' } }],
    ['nextThink.at', { nextThink: { mode: 'at', at: '2026-02-30 12:00', reason: '等资料' } }],
    ['nextThink.afterMinutes', { nextThink: { mode: 'after', reason: '等资料' } }],
    ['nextThink.afterMinutes', { nextThink: { mode: 'after', afterMinutes: 0, reason: '等资料' } }],
    ['nextThink.onEvent', { nextThink: { mode: 'on_event', onEvent: ' ', reason: '等资料' } }],
    ['nextThink.at', { nextThink: { mode: 'auto', at: '2026-11-06 09:00', reason: '等资料' } }],
    ['nextThink.onEvent', { nextThink: { mode: 'after', afterMinutes: 10, onEvent: '变化', reason: '等资料' } }],
    ['proposals.0.value', { proposals: [{ title: '新点子', detail: '细节', value: -1, confidence: 0.5 }] }],
    ['proposals.0.confidence', { proposals: [{ title: '新点子', detail: '细节', value: 0.8, confidence: 1.1 }] }],
  ] as const)('拒绝无效字段 %s', (path, patch) => {
    const result = CommitInputSchema.safeParse({ ...commitArgs(), ...patch });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path.join('.') === path)).toBe(true);
  });
  test.each([['甲'], ['甲', '乙', '丙', '丁', '戊'], ['甲', '甲'], ['甲', ' ']].map(options => ({ options })))('拒绝非法问题选项 $options', ({ options }) => {
    expect(CommitInputSchema.safeParse(commitArgs({ ownerQuestion: { text: '决定', options, defaultOption: '甲', whyNeeded: '继续' } })).success).toBe(false);
  });
  test('默认选项必须实际存在', () => expect(CommitInputSchema.safeParse(commitArgs({ ownerQuestion: { text: '决定', options: ['甲', '乙'], defaultOption: '丙', whyNeeded: '继续' } })).success).toBe(false));
  test('完整保留交付和验证范围', () => {
    const args = commitArgs({ worldChanges: [{ what: '写入报告', whoCanSee: 'owner', where: '/report.md' }], evidence: ['来源一'],
      verification: { level: 'e2e', notCovered: '线下操作未覆盖' }, proposals: [{ title: '点子', detail: '细节', value: 0, confidence: 1 }] });
    expect(CommitInputSchema.parse(args)).toEqual(args);
  });
});
