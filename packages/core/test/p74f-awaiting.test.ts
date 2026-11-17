/**
 * P74f 的测试：「待你验收」期间约定又出了新版本（补充要求第 2 节）。
 * 新版本提交：验收条目撤回、交付卡显示「在等你确认」、按钮和打字验收被拒或不识别、巡检不补条目；
 * 新版本固定：新增或改写条目 -> 退回返工；只删去 -> 重排后重新交付；没有变 -> 重新放出验收条目；撤销 -> 同没有变。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { speak } from './p74b-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';
import { delivered, deliveredWith, openItems, ownerTypes, chiefTurn, bot, callTool, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import type { Job } from '../src/model/job.js';

const T1 = '打开页面能看到今天的报价';
const T2 = '点刷新后数据更新';
const T3 = '接口失败时有提示';

/** 已交付、等主人验收时，主人提出要改，总管出了第 2 版请主人确认（总管交账 needs_owner）。 */
async function pending(extra: Record<string, unknown> = {}, four = false): Promise<{ fix: JobFix; job: Job; agreementId: string }> {
  const { fix, job } = four ? await deliveredWith([T1, T2, T3, '能导出表格']) : await delivered();
  await ownerTypes(fix, job.topicId, '文案里要求暗色模式，和约定不一样');
  const packet = await chiefTurn(fix);
  const ids = idsIn(packet);
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementIdIn(packet), extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '这和已定的第 1 版冲突，请你确认。', { outcome: 'needs_owner' });
  return { fix, job, agreementId: ids.agreementId };
}

const confirmV2 = async (fix: JobFix, agreementId: string): Promise<void> => {
  expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
};
const waiting = (fix: JobFix, jobId: string) => openItems(fix, jobId).filter(row => row.subjectKey.includes(':accept:'));

describe('新版本提交成功时', () => {
  it('验收条目撤回；交付卡不可验收并写「约定第 2 版在等你确认」；按钮被拒；打字不识别；巡检不补条目', async () => {
    const { fix, job } = await pending();
    expect(waiting(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:accept:1`)[0]).toMatchObject({ status: 'withdrawn' });
    const card = fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'delivery')!.jobCard!;
    expect(card).toMatchObject({ stateText: '待你验收', actions: { accept: false, hint: '约定第 2 版在等你确认，确认后再验收。' } });
    const refused = await fix.hub.api.acceptJob({ jobId: job.id, stage: 1 });
    expect(refused).toEqual({ ok: false, error: '约定第 2 版在等你确认，确认后再验收。' });
    await ownerTypes(fix, job.topicId, '验收通过');
    expect(theJob(fix).state).toBe('awaiting_owner');
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(waiting(fix, job.id)).toHaveLength(0);
  });
});

describe('新版本固定之后', () => {
  it('「怎样算做完」没有变：重新放出验收条目（同一个事项键已有被撤回的记录也建得出来），交付卡恢复可验收，随后验收成功', async () => {
    const { fix, job, agreementId } = await pending();
    await confirmV2(fix, agreementId);
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(waiting(fix, job.id)).toHaveLength(1);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:accept:1`).map(row => row.status).sort()).toEqual(['open', 'withdrawn']);
    expect(fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'delivery')!.jobCard).toMatchObject({ actions: { accept: true } });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: 1 })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('done');
  });

  it('改写了「怎样算做完」的一条：退回返工（阶段加 1），验收条目撤回', async () => {
    const { fix, job, agreementId } = await pending({ doneWhen: [T1, T2, '接口失败时有提示并写明原因'] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, unmet: [{ no: 3 }] });
    expect(waiting(fix, job.id)).toHaveLength(0);
  });

  it('只删去一条：按新编号重排最近一次交回和通过的那次核对，重新交付（新的验收条目，交付卡按两条显示），验收成功', async () => {
    const { fix, job, agreementId } = await pending({ doneWhen: [T1, T3, '能导出表格'], removals: [T2] }, true);
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', stage: 1, handledVersionNo: 2 });
    const subs = fix.ctx.store.table('jobSubmissions').list(row => row.jobId === job.id);
    expect(subs).toHaveLength(2);
    expect(subs.at(-1)!.items.map(item => item.text)).toEqual([T1, T3, '能导出表格']);
    const reviews = fix.ctx.store.table('jobReviews').list(row => row.jobId === job.id);
    expect(reviews).toHaveLength(2);
    expect(reviews.at(-1)!.items.map(item => [item.no, item.verdict])).toEqual([[1, 'at_delivery'], [2, 'met'], [3, 'met']]);
    expect(waiting(fix, job.id)).toHaveLength(1);
    // P74f-2（主会话裁定 2、3）：重新交付的卡带修订号，两张卡的 refId 不同；只有最新的一张可以验收，旧卡显示失效、没有验收按钮。
    const cards = threadOf(fix.ctx, job.topicId).filter(row => row.kind === 'job_card' && row.refId?.startsWith(`delivery:${job.id}#1`));
    expect(cards.map(row => row.refId)).toEqual([`delivery:${job.id}#1`, `delivery:${job.id}#1~1`]);
    const views = fix.hub.api.thread(job.topicId).messages.filter(row => row.jobCard?.kind === 'delivery').map(row => row.jobCard!);
    const view = views.at(-1)!;
    expect(view.kind === 'delivery' && view.items.map(item => item.text)).toEqual([T1, T3, '能导出表格']);
    expect(view).toMatchObject({ actions: { accept: true }, revision: 1 });
    expect(views.at(-2)).toMatchObject({ stateText: '已失效：已重新交付', actions: { accept: false }, revision: 0 });
    // 对着旧卡验收被拒；对着新卡验收成功。
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: 1, revision: 0 })).toMatchObject({ ok: false, error: '这张卡已不是最新的，请在最新的交付卡上验收' });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: 1, revision: 1 })).toMatchObject({ ok: true });
  });

  it('总管撤销这次重新确认：同「没有变」，验收条目重新放出', async () => {
    const { fix, job } = await pending();
    await ownerTypes(fix, job.topicId, '还是不改了，保持原样');
    await chiefTurn(fix);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId: fix.ctx.store.table('agreements').list()[0]!.id, reason: '主人说保持原样' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(waiting(fix, job.id)).toHaveLength(1);
    expect(fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'delivery')!.jobCard).toMatchObject({ actions: { accept: true } });
  });
});
