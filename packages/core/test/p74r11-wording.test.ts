/**
 * P74r11 第 3 节的测试：核心生成的几句给主人看的文字改为书面表达（逐字断言），以及回执旧写法的兼容。
 *
 * 覆盖表里每一行：
 * 1 `{员工}无法继续`（说明卡和条目的标题，受阻原因的说明词）；
 * 2 说明卡正文里的 `{员工}无法继续，需要你选一个处理办法。`（卡里写的「还是做不下去，需要你再选一次」在核心里没有对应句，见 questions.md；
 *   实际存在的是这一句，已在 p74f-escalate.test.ts 里逐字断言）；
 * 3 `已失效：这件事已继续进行`；
 * 4 约定固定之后落的话里 `{执行者}已继续做……`（p74e-b2.test.ts 里逐字断言）；
 * 5、6 回执标签 `需要你处理`、`总管代你答复的问题`；
 * 旧存档里存的是旧写法的回执：模式能读，视图给出新写法。
 */
import { describe, expect, it } from 'vitest';
import { escalationTitle } from '../src/job/escalate.js';
import { EXPIRY_STATE_TEXT } from '../src/job/escalation-expiry.js';
import { computeReceiptRows, modernReceiptLabel, receiptRowsOf } from '../src/job/receipt.js';
import { jobBlockLabel } from '../src/model/job.js';
import { JobSchema } from '../src/model/job.js';
import { delivered, theJob } from './p74f-fixtures.js';

describe('表里的替换，逐字', () => {
  it('1 说明卡和条目的标题、受阻原因的说明词：{员工}无法继续', () => {
    expect(escalationTitle({ kind: 'executor', no: null }, '林舟')).toBe('林舟无法继续');
    expect(jobBlockLabel('executor', '林舟')).toBe('林舟无法继续');
    // 核对三轮未通过的标题不变。
    expect(escalationTitle({ kind: 'review_limit', no: 3 }, '林舟')).toBe('第 3 条三轮未通过');
  });

  it('3 已失效：这件事已继续进行', () => {
    expect(EXPIRY_STATE_TEXT.released).toBe('已失效：这件事已继续进行');
  });

  it('5、6 回执标签：需要你处理、总管代你答复的问题', () => {
    const rows = computeReceiptRows({ firstLockedAt: 0, acceptedAt: 3_600_000, disturbed: 3, answered: 1, reviewRounds: 1, firstRoundUnmet: 0, versionNo: 1 });
    expect(rows.map(row => row.label)).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本']);
    expect(rows[1]).toEqual({ label: '需要你处理', value: '3 次' });
    expect(rows[2]).toEqual({ label: '总管代你答复的问题', value: '1 个' });
  });
});

describe('回执旧写法的兼容', () => {
  it('旧标签换成新写法，其余标签原样', () => {
    expect(modernReceiptLabel('打扰你')).toBe('需要你处理');
    expect(modernReceiptLabel('总管替你答掉的问题')).toBe('总管代你答复的问题');
    expect(modernReceiptLabel('核对')).toBe('核对');
  });

  it('旧存档里存着旧写法的回执：记录能读，查看时给出新写法，回执卡视图通过校验', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    // 新写入的一律是新写法。
    expect(theJob(fix).receipt!.map(row => row.label)).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本']);
    // 改写成升级前的存法。
    const oldRows = theJob(fix).receipt!.map(row => ({ ...row,
      label: row.label === '需要你处理' ? '打扰你' as const : row.label === '总管代你答复的问题' ? '总管替你答掉的问题' as const : row.label }));
    expect(JobSchema.safeParse({ ...theJob(fix), receipt: oldRows }).success).toBe(true);
    fix.ctx.store.table('jobs').patch(job.id, { receipt: oldRows });
    expect(theJob(fix).receipt!.map(row => row.label)).toContain('打扰你');
    expect(receiptRowsOf(fix.ctx, theJob(fix)).map(row => row.label)).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本']);
    // 界面看到的回执卡也是新写法。
    const card = fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'receipt')!.jobCard!;
    // P76e：视图在五行之后追加第六行「消耗」（记录里仍只有五行，上面两处断言没有改）。
    expect(card.kind === 'receipt' ? card.rows.map(row => row.label) : []).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本', '消耗']);
  });
});
