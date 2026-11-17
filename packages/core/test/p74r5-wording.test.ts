/**
 * P74r5 第 1 节的测试：几处给主人看的口语说法改为书面说法（没有进展、再提醒一次、暂停、你已暂停），
 * 选项文字只在 job/block-options.ts 定义一次，条目建立、校验和答复都引用它。
 * 条目标题、正文、总管私聊那句话的完整文字由 p74r1-review-fixes、p74r2a-reviewer-stall 等既有测试逐字断言（预期已按本卡同步）。
 */
import { describe, expect, it } from 'vitest';
import { HOLD_OPTION, RETRY_OPTION, STALL_OPTIONS, budgetOptions, LEGACY_TOP_UP_OPTION } from '../src/job/block-options.js';
import { answerJobCap, answerJobStall } from '../src/job/blocked-answer.js';
import { JOB_BLOCK_LABELS } from '../src/model/job.js';
import { started } from './p74f2-fixtures.js';

describe('选项文字只定义一次', () => {
  it('常量的取值；回合上限条目建立时的校验与答复的校验用同一份', () => {
    expect(HOLD_OPTION).toBe('暂停');
    expect(RETRY_OPTION).toBe('再提醒一次');
    expect(STALL_OPTIONS).toEqual(['再提醒一次', '暂停']);
    // P76f：新条目的三个办法；旧条目的追加选项文字只用于识别旧条目。
    expect(budgetOptions(8)).toEqual(['追加 8 个回合', '缩小范围', '暂停']);
    expect(LEGACY_TOP_UP_OPTION).toBe('再给 8 个回合');
  });

  it('答复不在选项里的话：拒绝文字写出新的选项；旧说法「先停下」「再叫一次」不再被接受', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(() => answerJobCap(fix.ctx, { jobId: job.id, answer: '先停下', via: 'command' })).toThrow();
    expect(() => answerJobStall(fix.ctx, { jobId: job.id, answer: '再叫一次', via: 'command' })).toThrow();
  });

  it('受阻原因的显示：你已暂停', () => {
    expect(JOB_BLOCK_LABELS.owner_hold).toBe('你已暂停');
  });
});
