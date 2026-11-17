/**
 * P74r12 第 4 至 7 节的测试：
 * 4 回执「核对」一行的写法（四种组合，逐字）；
 * 5 reopen 成功的返回文字加一句（逐字；真实流程里的逐字断言在 p74f-accept.test.ts）；
 * 6 进度行的延迟说明：这位员工自己有回合在跑写「正在忙别的事」，别人的回合占着位置写「排队中，等正在进行的回合结束」；
 * 7 两句书面表达：回合没有响应、要继续做请新建一件事务（逐字）。
 */
import { describe, expect, it } from 'vitest';
import { jobDelayNote } from '../src/job/delay.js';
import { REOPEN_REPLY_REMINDER } from '../src/job/reopen.js';
import { computeReceiptRows } from '../src/job/receipt.js';
import { explainOwnerStatusChange } from '../src/project/task-state.js';
import { assigned, jobFix, runningOf, tick, wakesOf, MINUTE, type JobFix } from './p74c-fixtures.js';
import { started } from './p74d-fixtures.js';

const rowOf = (input: { reviewRounds: number; firstRoundUnmet: number; ownerReturned?: number }) =>
  computeReceiptRows({ firstLockedAt: 0, acceptedAt: 3_600_000, disturbed: 1, answered: 0, versionNo: 1, ...input }).find(row => row.label === '核对')!.value;

describe('4 回执「核对」一行', () => {
  it('只核对了 1 轮并通过：1 轮，一次通过', () => {
    expect(rowOf({ reviewRounds: 1, firstRoundUnmet: 0 })).toBe('1 轮，一次通过');
  });
  it('第 1 轮有退回的条目：{n} 轮，第 1 轮退回 {k} 条', () => {
    expect(rowOf({ reviewRounds: 2, firstRoundUnmet: 1 })).toBe('2 轮，第 1 轮退回 1 条');
  });
  it('核对了多轮、第 1 轮没有退回：{n} 轮，都通过', () => {
    expect(rowOf({ reviewRounds: 2, firstRoundUnmet: 0 })).toBe('2 轮，都通过');
  });
  it('主人指出过不符：在值后面加「；你指出不符 {m} 次」（三种值各一次）', () => {
    expect(rowOf({ reviewRounds: 2, firstRoundUnmet: 0, ownerReturned: 1 })).toBe('2 轮，都通过；你指出不符 1 次');
    expect(rowOf({ reviewRounds: 1, firstRoundUnmet: 0, ownerReturned: 2 })).toBe('1 轮，一次通过；你指出不符 2 次');
    expect(rowOf({ reviewRounds: 3, firstRoundUnmet: 2, ownerReturned: 1 })).toBe('3 轮，第 1 轮退回 2 条；你指出不符 1 次');
  });
  it('没有核对：无', () => {
    expect(rowOf({ reviewRounds: 0, firstRoundUnmet: 0 })).toBe('无');
  });
});

describe('5 reopen 成功的返回文字', () => {
  it('追加的那一句逐字', () => {
    expect(REOPEN_REPLY_REMINDER).toBe('回复主人时写明三样：返工哪几条、核对当时为什么没有发现、预计什么时候再交。');
  });
});

describe('7 两句书面表达', () => {
  it('回合没有响应：10 分钟没有任何事件的回合被中心停止，错误文字逐字', async () => {
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    await tick(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '回合没有响应，中心已停止等待并安排重试' });
  });

  it('已完成的事务不能再改状态：…要继续做请新建一件事务', () => {
    const text = explainOwnerStatusChange('accepted', 'doing');
    expect(text).toMatch(/要继续做请新建一件事务$/);
    expect(text).not.toContain('接着做');
  });
});

describe('6 进度行的延迟说明', () => {
  /** 派活后、候选还排着、总管的回合结束，10 分钟已过（越过启动静默和放行间隔）。 */
  async function queuedScene(fix: JobFix) {
    const { job } = await assigned(fix);
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    fix.ctx.clock.advance(10 * MINUTE);
    return { job: fix.ctx.store.table('jobs').get(job.id)!, now: fix.ctx.clock.now() };
  }

  it('这位员工自己有回合在跑（不属于这件事）：林舟正在忙别的事', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    fix.ctx.store.table('wakes').put({ ...wakesOf(fix, fix.chief.id)[0]!, id: 'w_0000000555', botId: fix.engineer.id, jobId: undefined,
      status: 'running', endedAt: null, commitId: null, startedAt: now });
    expect(jobDelayNote(fix.ctx, job, now)).toBe('林舟正在忙别的事');
  });

  it('别人的回合占着全局的位置、林舟自己没有回合：排队中，等正在进行的回合结束', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    // 全局只允许同时跑 1 个回合，评审甲有一个回合在跑。
    fix.ctx.settings.maxConcurrentThinks = 1;
    fix.ctx.settings.ownerActiveConcurrentThinks = 1;
    fix.ctx.store.table('wakes').put({ ...wakesOf(fix, fix.chief.id)[0]!, id: 'w_0000000556', botId: fix.reviewer.id, jobId: undefined,
      status: 'running', endedAt: null, commitId: null, startedAt: now });
    expect(jobDelayNote(fix.ctx, job, now)).toBe('排队中，等正在进行的回合结束');
  });
});
