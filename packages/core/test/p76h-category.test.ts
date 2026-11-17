/**
 * P76h 第 1 条：通知类别判断 notifyCategoryOf（纯函数）。
 * 表中每一行一例（正例），不属于四类的各种条目逐一列举（反例，应为 null）。
 * 纯函数不涉及时钟、免打扰与推送渠道，所以本文件没有这些前提。
 */
import { describe, expect, it } from 'vitest';
import { notifyCategoryOf } from '../src/outreach/notify.js';

type Item = Parameters<typeof notifyCategoryOf>[0];
const item = (type: Item['type'], subjectKey: string, refId: string | null = null): Item => ({ type, subjectKey, refId });

describe('P76h 通知类别：表中每一行一例', () => {
  it('约定确认条目（事项键 agreement: 开头）归 agreement', () => {
    expect(notifyCategoryOf(item('question', 'agreement:ag_aaaaaaaaaa:2'))).toBe('agreement');
  });
  it('一件事用到回合上限（job:<id>:cap:）归 agreement', () => {
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:cap:12'))).toBe('agreement');
  });
  it('审批（type 为 approval）归 approval，不看事项键', () => {
    expect(notifyCategoryOf(item('approval', 'approval:ap_aaaaaaaaaa'))).toBe('approval');
    expect(notifyCategoryOf(item('approval', '随便什么键'))).toBe('approval');
  });
  it('三轮不过（job:<id>:escalate:）归 escalation，带修订序号的也是', () => {
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:escalate:3'))).toBe('escalation');
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:escalate:3~2'))).toBe('escalation');
  });
  it('没有进展（job:<id>:stall:）归 stall', () => {
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:stall:4'))).toBe('stall');
  });
  it('鉴权告警（告警条目且告警代码为 auth）归 system', () => {
    expect(notifyCategoryOf(item('alert', 'alert:hub:auth:al_aaaaaaaaaa:first', 'al_aaaaaaaaaa'), 'auth')).toBe('system');
  });
});

describe('P76h 通知类别：不属于四类的一律为 null（不推送）', () => {
  it('员工提问', () => {
    expect(notifyCategoryOf(item('question', 'question:i_aaaaaaaaaa'))).toBeNull();
  });
  it('验收（一件事的验收条目、员工目标的验收题）', () => {
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:accept:1'))).toBeNull();
    expect(notifyCategoryOf(item('question', 'goal_check:g_aaaaaaaaaa'))).toBeNull();
  });
  it('组队卡', () => {
    expect(notifyCategoryOf(item('question', 'team:tpr_aaaaaaaaaa'))).toBeNull();
  });
  it('提议', () => {
    expect(notifyCategoryOf(item('proposal', 'proposal:b_0000000001:换个做法'))).toBeNull();
  });
  it('技能库的选会话提问', () => {
    expect(notifyCategoryOf(item('question', 'learn:sr_aaaaaaaaaa'))).toBeNull();
  });
  it('额度告警、掉线告警、隔离告警（告警条目但代码不是 auth）', () => {
    for (const code of ['quota', 'deadman', 'quarantine']) {
      expect(notifyCategoryOf(item('alert', `alert:hub:${code}:al_aaaaaaaaaa:first`, 'al_aaaaaaaaaa'), code), code).toBeNull();
    }
  });
  it('告警条目没有传告警代码时也不推送（只有明确是 auth 才推）', () => {
    expect(notifyCategoryOf(item('alert', 'alert:hub:auth:al_aaaaaaaaaa:first', 'al_aaaaaaaaaa'))).toBeNull();
  });
  it('反例：事项键只是长得像（job 前缀但种类不是 cap/escalate/stall）不归任何一类', () => {
    expect(notifyCategoryOf(item('question', 'job:jb_aaaaaaaaaa:other:1'))).toBeNull();
    expect(notifyCategoryOf(item('question', 'jobx:jb_aaaaaaaaaa:cap:1'))).toBeNull();
  });
  it('反例：非告警条目带 auth 代码也不算系统类', () => {
    expect(notifyCategoryOf(item('question', 'question:i_aaaaaaaaaa'), 'auth')).toBeNull();
  });
});
