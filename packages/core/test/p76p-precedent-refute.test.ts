/**
 * P76p 第 3 节：主人否掉一条先例时，旧先例要失效（不再作为 active 引用），并留下「已被你否掉」的痕迹；
 * 只改措辞时不作废整条先例。
 *
 * 两部分：
 * 1. 字面判断（ownerWordsRefute）的正例反例，直接喂文字；
 * 2. 真实链路：约定固定时写下先例，主人在验收时指出不符，总管用 reopen 退回返工，看先例状态。
 * 时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { chosenPartOf, ownerWordsRefute } from '../src/memory/precedent-refute.js';
import { memorySourceGroups } from '../src/wake/chief-sources.js';
import { memoriesOf } from './p75c-fixtures.js';
import { bot, callTool, chiefTurn, delivered, ownerTypes, reopenInfo, type JobFix } from './p74f-fixtures.js';
import type { Job } from '../src/model/job.js';
import type { Memory } from '../src/model/memory.js';

const DARK = '页面视觉风格要哪种：深色冬季配色（深蓝渐变底，白字，有冬天气息）';
const SOURCE = '报价从哪里取：公开接口';

describe('字面判断：否定词或替换词碰到原选定项才算否掉', () => {
  it('否定词后面紧跟原选定项的完整文字：否掉（公开接口；P85 同步：只认完整选定项，不再认前两个字）', () => {
    // P85 同步：原来这里还有「不要深色渐变」对上 DARK 判否掉（取了选定项前两个字「深色」）。选定项改为只认完整文字之后，
    // 主人只说前半句的写法不再判否掉；完整说出整段选定项时才判。
    expect(ownerWordsRefute('背景我要浅色白底，不要深色渐变。', DARK)).toBe(false);
    expect(ownerWordsRefute('背景不要深色冬季配色（深蓝渐变底，白字，有冬天气息）。', DARK)).toBe(true);
    expect(ownerWordsRefute('报价来源不要公开接口，改成手工表格。', SOURCE)).toBe(true);
  });

  it('只说要换成另一套说法、没有否定原词：保守不判（可能是在改别的事）', () => {
    expect(ownerWordsRefute('背景改成浅色白底。', DARK)).toBe(false);
  });

  it('只改措辞（否定词没有碰到原选定项）：不作废', () => {
    expect(ownerWordsRefute('把措辞改成「深色冬季配色（深蓝渐变底，白字）」，别的不动。', DARK)).toBe(false);
  });

  it('否定词没有碰到原选定项：不作废', () => {
    expect(ownerWordsRefute('说明里写清楚「公开接口」，不要写错别字。', SOURCE)).toBe(false);
  });

  it('与先例无关的纠正：不作废', () => {
    expect(ownerWordsRefute('页面排版太挤，字号大一点。', SOURCE)).toBe(false);
  });

  it('取选定项：冒号之前的问题不参与比对', () => {
    expect(chosenPartOf(SOURCE)).toBe('公开接口');
    expect(chosenPartOf('没有冒号的先例')).toBe('没有冒号的先例');
  });
});

/** 已交付、等验收的一件事，并确保约定固定时写下的先例已经落表。 */
async function deliveredWithPrecedents(): Promise<{ fix: JobFix; job: Job; precedents: Memory[] }> {
  const { fix, job } = await delivered();
  await flushJobHooks(fix.ctx);
  const precedents = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
  expect(precedents.map(row => row.text).sort()).toEqual([SOURCE, '多久刷新一次：每天'].sort());
  return { fix, job, precedents };
}

/** 主人在主题里指出第 1 条不符，总管用唤醒包里的编号调用 reopen。 */
async function reopenFirstItem(fix: JobFix, job: Job, text: string): Promise<void> {
  await ownerTypes(fix, job.topicId, text);
  const seen = reopenInfo(await chiefTurn(fix));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
    items: [{ no: seen.nos[0]!, problem: '没有照你的要求做', fixTo: '按你这次说的改' }], missed: '核对时没有对照你这次的要求' });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

describe('真实链路：主人在验收时否掉先例', () => {
  it('「不要公开接口，改成手工表格」：旧先例改为已被否掉，留主人原话，出处里不再出现；另一条照旧', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    await reopenFirstItem(fix, job, '第 1 条不对：报价来源不要公开接口，改成手工表格。');
    const rows = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
    const refuted = rows.find(row => row.text === SOURCE)!;
    expect(refuted.status).toBe('refuted');
    expect(refuted.endedAt).not.toBeNull();
    expect(refuted.history).toMatchObject([{ action: 'refuted', text: SOURCE,
      quote: '第 1 条不对：报价来源不要公开接口，改成手工表格。', messageIds: [expect.any(String)], wakeId: null, replyMessageId: null }]);
    expect(rows.find(row => row.text === '多久刷新一次：每天')!.status).toBe('active');
    // 下一次对齐时「可引用的出处」里没有它。
    const groups = memorySourceGroups(fix.ctx, bot(fix, fix.chief.id));
    expect(groups.precedents.join('\n')).not.toContain('公开接口');
    expect(groups.precedents.join('\n')).toContain('每天');
    // 返工照常：新说法由这次返工生效。
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('rework');
  });

  it('只改措辞（替换词后面仍带着原选定项）：两条先例都仍是 active', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    await reopenFirstItem(fix, job, '第 1 条不对：把说明改成「报价从哪里取：公开接口」的说法，措辞再清楚些。');
    const rows = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
    expect(rows.map(row => row.status)).toEqual(['active', 'active']);
  });
});
