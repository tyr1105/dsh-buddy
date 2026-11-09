/**
 * F08 项目容器 - 任务状态机纯函数测试（project/task-state.ts）。
 * 覆盖：全部合法/非法转移、驳回理由必填与长度、accepted 终态、nextStatus 动作映射。
 * 每条规则至少一个正例一个反例。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_TASK_TRANSITIONS, TASK_REJECT_REASON_MAX, canTransition, checkTransition,
  explainTransition, nextStatus,
} from '../src/project/task-state.js';
import type { TaskStatus } from '../src/model/project.js';

const REASON = '差一点，把第三节数据补上';

describe('F08 合法转移', () => {
  it.each(LEGAL_TASK_TRANSITIONS.filter(edge => edge.to !== 'rejected'))(
    '$from → $to 合法',
    ({ from, to }) => {
      expect(canTransition(from, to)).toBe(true);
      expect(explainTransition(from, to)).toBeNull();
    },
  );
  it('done_pending_check → rejected 带非空理由合法', () => {
    expect(canTransition('done_pending_check', 'rejected', { rejectReason: REASON })).toBe(true);
  });
  it('全部合法边都能在 checkTransition 拿到 ok:true', () => {
    for (const edge of LEGAL_TASK_TRANSITIONS) {
      const result = checkTransition(edge.from, edge.to, { rejectReason: REASON });
      expect(result.ok).toBe(true);
    }
  });
});

describe('F08 驳回理由规则', () => {
  it('无理由拒绝', () => {
    expect(canTransition('done_pending_check', 'rejected')).toBe(false);
    expect(canTransition('done_pending_check', 'rejected', { rejectReason: null })).toBe(false);
    expect(explainTransition('done_pending_check', 'rejected', { rejectReason: '   ' })).toContain('驳回必须填写理由');
  });
  it('超过 500 字拒绝', () => {
    const long = '理'.repeat(TASK_REJECT_REASON_MAX + 1);
    expect(canTransition('done_pending_check', 'rejected', { rejectReason: long })).toBe(false);
    expect(explainTransition('done_pending_check', 'rejected', { rejectReason: long })).toContain('不能超过 500 字');
  });
  it('恰好 500 字通过', () => {
    const reason = '理'.repeat(TASK_REJECT_REASON_MAX);
    expect(canTransition('done_pending_check', 'rejected', { rejectReason: reason })).toBe(true);
  });
  it('理由只对驳回边生效：其他转移不要求理由', () => {
    expect(canTransition('doing', 'done_pending_check', {})).toBe(true);
    expect(canTransition('todo', 'doing', { rejectReason: '' })).toBe(true);
  });
});

describe('F08 非法转移一正一反', () => {
  const illegal: Array<[TaskStatus, TaskStatus, string]> = [
    ['todo', 'blocked', '先开始'],
    ['todo', 'done_pending_check', '先开始'],
    ['todo', 'accepted', '先开始'],
    ['doing', 'todo', '不能退回待办'],
    ['doing', 'accepted', '不能直接标记已通过'],
    ['blocked', 'done_pending_check', '先恢复'],
    ['blocked', 'blocked', '重复转移'],
    ['done_pending_check', 'doing', '只能由主人'],
    ['done_pending_check', 'blocked', '只能由主人'],
    ['accepted', 'doing', '终态'],
    ['accepted', 'done_pending_check', '终态'],
    ['rejected', 'todo', '只能回到进行中'],
    ['rejected', 'accepted', '只能回到进行中'],
    ['doing', 'doing', '重复转移'],
  ];
  it.each(illegal)('%s → %s 被中文拒绝（%s）', (from, to, hint) => {
    expect(canTransition(from, to, { rejectReason: REASON })).toBe(false);
    expect(explainTransition(from, to, { rejectReason: REASON })).toContain(hint);
  });
  it('accepted 是终态：任意出口都拒绝', () => {
    for (const to of ['todo', 'doing', 'blocked', 'done_pending_check', 'rejected'] as TaskStatus[]) {
      expect(canTransition('accepted', to)).toBe(false);
    }
  });
});

describe('F08 nextStatus 动作映射', () => {
  it('七个动作映射到正确目标状态', () => {
    expect(nextStatus('todo', 'start')).toBe('doing');
    expect(nextStatus('doing', 'block')).toBe('blocked');
    expect(nextStatus('blocked', 'resume')).toBe('doing');
    expect(nextStatus('doing', 'report_done')).toBe('done_pending_check');
    expect(nextStatus('done_pending_check', 'accept')).toBe('accepted');
    expect(nextStatus('done_pending_check', 'reject', { rejectReason: REASON })).toBe('rejected');
    expect(nextStatus('rejected', 'rework')).toBe('doing');
  });
  it('动作起点不对时中文报错', () => {
    expect(() => nextStatus('todo', 'block')).toThrow('标记受阻');
    expect(() => nextStatus('accepted', 'accept')).toThrow();
    expect(() => nextStatus('blocked', 'report_done')).toThrow('交账待验收');
  });
  it('reject 动作缺理由在状态机层被拦', () => {
    expect(() => nextStatus('done_pending_check', 'reject')).toThrow('驳回必须填写理由');
  });
});
