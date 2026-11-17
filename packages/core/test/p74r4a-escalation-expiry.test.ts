/**
 * P74r4a 第 1、2 条的测试：办法卡和「待你处理」条目上看得到「选了会改什么」；一次说明随约定版本失效（第三次审查 K1、K2、K5）。
 *
 * K1：总管写的标题是「再给林舟一轮」，实际会删去第 1 条：卡片视图、条目视图、条目正文里都有中心生成的那一行。
 * K2：说明之后约定出了新版本（在最前面插入一条、删去一条、主人亲口的小改动直接生效、待确认后又撤销）：
 *     说明立即失效、条目撤回、卡片状态文字写明原因、旧卡选办法被拒；总管被叫醒并可以重新说明；
 *     重新说明后选带改动的办法，被改的是卡住的那一条，新插入的那一条在待核对的范围里，核对通过之前不会进入待你验收。
 * 全部走真实 Hub，总管只用唤醒包里的文字调用，假时钟每次不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { ESCALATION_EXPIRED_TEXT, ESCALATION_EXPIRED_WAKE_TEXT, ESCALATION_WITHDRAWN_WAKE_TEXT } from '../src/job/escalation-expiry.js';
import { lockedVersionOf } from '../src/job/files.js';
import { commitAndEnd, entriesOf, runningOf } from './p74c-fixtures.js';
import { reviewerInfo } from './p74d-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, escalateItem, lastPacket, limitFix, nextPacket, ownerSays, sectionOf, speak, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

const DONES = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '能导出表格'];
const FIRST = '页面在手机上能看';
const REWRITE = '接口失败时页面有提示或有备用文案';
const OTHER = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };

/** 把第 no 条改成 text 的办法。 */
const rewriteOf = (no: number, text: string = REWRITE) => ({ title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no, text } });

/** 总管有回合开着就结束它。 */
async function chiefEnds(fix: JobFix, reply?: string): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理', ...(reply === undefined ? {} : { reply }) });
}

/** 说明之后：主人发话，总管 revise 出新版本（等确认），总管交账。返回约定编号。 */
async function reviseAfterEscalation(fix: JobFix, extra: Record<string, unknown>): Promise<string> {
  await chiefEnds(fix);
  await ownerSays(fix, fix.chief.id, '约定里的条目要调整一下');
  const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
  return ids.agreementId;
}

/** 主人确认第 version 版，收尾做完。 */
async function confirm(fix: JobFix, agreementId: string, version: number): Promise<void> {
  expect(await fix.hub.api.confirmAgreement({ agreementId, version })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
}

/** 现在固定的约定里的「怎样算做完」。 */
function lockedDone(fix: JobFix, agreementId: string): string[] {
  return lockedVersionOf(fix.ctx.store.table('agreements').get(agreementId)!).content.doneWhen;
}

/** 这件事开着的「待你处理」条目的事项键前缀（job: 和 agreement: 两类）。 */
function openKeys(fix: JobFix): string[] {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open').map(row => row.subjectKey.split(':')[0] + ':' + row.subjectKey.split(':')[2]);
}

describe('K1：「待你处理」里也看得到选了会改什么', () => {
  it('标题写「再给林舟一轮」、实际删去第 1 条：卡片视图、条目视图、条目正文里都有同一行；中心提供的字段由卡片和条目共用', async () => {
    const { fix, job } = await limitFix(DONES);
    const sneaky = { title: '再给林舟一轮', detail: '让林舟再试一次；代价是多花一轮时间', change: { no: 1, text: null } };
    const { result } = await escalateFromPacket(fix, [sneaky, OTHER]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const line = '选了会删去「怎样算做完」第 1 条：打开页面能看到今天的报价';
    // 卡片视图。
    const card = escalationCardView(fix.ctx, `escalation:${job.id}#1`)!;
    expect(card.options.map(row => row.changeLine)).toEqual([line, null]);
    // 条目视图：带同一张卡的完整视图。
    const view = fix.hub.api.inbox().items.find(row => row.id === escalateItem(fix, job.id)!.id)!;
    expect(view.escalationCard).toEqual(card);
    // 条目正文：在「卡在哪」之后逐个办法列出，带改动的办法下一行是原文。
    expect(escalateItem(fix, job.id)!.body).toBe(['接口失败时的提示，页面一直做不到让人看得懂', 'A　再给林舟一轮', line, 'B　换一位执行者再试'].join('\n'));
    expect(view.body).toContain(line);
    // 其余条目不带这个字段。
    expect(fix.hub.api.inbox().items.filter(row => row.id !== view.id).every(row => row.escalationCard === undefined)).toBe(true);
  });

  it('带改动的办法中心生成不出这一行（序号不在「怎样算做完」里）：整份被拒，一条都不写', async () => {
    const { fix, job } = await limitFix(DONES);
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const jobId = /mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)![1]!;
    const before = JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list()]);
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId, stuckAt: '卡在失败提示', suggested: 0, reason: '改动最小',
      options: [{ title: '再给林舟一轮', detail: '让林舟再试一次；代价是多花一轮时间', change: { no: 7, text: null } }, OTHER] });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('选了会改什么');
    expect(JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list()])).toBe(before);
    expect(theJob(fix).escalation).toBeUndefined();
    expect(job.id).toBe(jobId);
  });
});

describe('K2：说明之后约定又变了，说明随版本失效', () => {
  it('说明之后在最前面插入一条并固定第 2 版：说明失效、条目撤回、卡片写明原因；旧卡选办法被拒；总管被叫醒并重新说明；选办法后改的是卡住的那一条，新插入的那一条要核对', async () => {
    const { fix, job } = await limitFix();
    const first = await escalateFromPacket(fix, [rewriteOf(3), OTHER]);
    expect(first.result).toMatchObject({ ok: true });
    const v1 = lockedDone(fix, job.agreementId);
    expect(escalateItem(fix, job.id)).toBeDefined();
    const agreementId = await reviseAfterEscalation(fix, { changeNote: '加手机', doneWhen: [FIRST, ...v1] });

    // 待确认期间：说明立即失效，条目撤回，编号清空；「待你处理」里只有约定的确认条目；仍然受阻，受阻原因不变。
    expect(escalateItem(fix, job.id)).toBeUndefined();
    expect(openKeys(fix)).toEqual(['agreement:2']);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' }, inboxId: null, escalation: { chosen: null, invalid: 'reconfirming' } });
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：约定在重新确认', selectable: false, chosen: null });
    // 待确认期间：旧卡选办法被拒；总管调用说明被拒。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: '约定第 2 版在等你确认，确认后再选办法。' });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);

    // 主人确认第 2 版：说明仍失效（原因改为约定已更新），选办法被拒、文字如上；总管的唤醒立即排上（不用等兜底巡检的 30 分钟）。
    await confirm(fix, agreementId, 2);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：约定已更新', selectable: false });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: ESCALATION_EXPIRED_TEXT });
    expect(ESCALATION_EXPIRED_TEXT).toBe('约定已经更新，这张卡上的办法是按旧版本写的，已失效。总管会按新版本重新处理。');
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit', no: 4 }, inboxId: null });
    // 总管被叫醒，唤醒包里写明失效；总管只用包里的文字重新说明（卡住的条目现在是第 4 条），成功。
    const packet = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(packet).toContain('上一次给主人的办法因为约定更新已失效；请按现在的约定重新判断：能解决就解决，仍要主人决定就重新说明。');
    expect(ESCALATION_EXPIRED_WAKE_TEXT).toContain('已失效');
    expect(packet).toContain('第 4 条核对三轮仍未通过');
    const again = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '接口失败时的提示，页面一直做不到让人看得懂',
      suggested: 0, reason: '最小的改动，其余条目不受影响', options: [rewriteOf(4), OTHER] });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已把办法交给主人' });
    expect(theJob(fix).escalation).toMatchObject({ rev: 1, versionNo: 2, no: 4, chosen: null });
    expect(theJob(fix).escalation!.invalid).toBeUndefined();
    expect(openKeys(fix)).toEqual(['job:escalate']);

    // 主人选带改动的办法：被改的是卡住的那一条，新插入的那一条在待核对的范围里。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 1 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(lockedDone(fix, agreementId)).toEqual([FIRST, v1[0], v1[1], REWRITE]);
    expect(theJob(fix)).toMatchObject({ state: 'checking', recheckNos: [1, 4], handledVersionNo: 3 });
    // 核对人只给被改的那一条的结论：被拒（新插入的那一条还没做，必须给结论）；核对通过之前不会进入待你验收。
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    const partial = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [{ no: 4, verdict: 'met' }] });
    expect(partial.ok).toBe(false);
    expect(String(partial.error)).toContain('第 1 条');
    expect(theJob(fix).state).toBe('checking');
    // 新插入的那一条判不符：退回返工，同样不会进入待你验收。
    const reviewed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'unmet', note: '手机上没有看过', fixTo: '手机尺寸下能看到完整页面' }, { no: 4, verdict: 'met' }] });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('rework');
    expect(openKeys(fix).filter(key => key.startsWith('job:accept'))).toEqual([]);
  });

  it('说明之后删去一条并固定：说明失效，总管被叫醒并可以重新说明', async () => {
    const { fix, job } = await limitFix(DONES);
    await escalateFromPacket(fix, [rewriteOf(3), OTHER]);
    const agreementId = await reviseAfterEscalation(fix, { changeNote: '去掉导出', doneWhen: [DONES[0], DONES[1], DONES[2]], removals: [DONES[3]] });
    await confirm(fix, agreementId, 2);
    // m1：确认之后记下的原因由 reconfirming 改为 updated。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', inboxId: null, escalation: { invalid: 'updated' } });
    expect(escalateItem(fix, job.id)).toBeUndefined();
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：约定已更新', selectable: false });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: ESCALATION_EXPIRED_TEXT });
    expect(sectionOf(await nextPacket(fix, fix.chief.id))).toContain(ESCALATION_EXPIRED_WAKE_TEXT);
    // 重新说明成功（卡住的仍是第 3 条）。
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '接口失败时的提示做不到', suggested: 0, reason: '改动最小',
      options: [rewriteOf(3), OTHER] })).toMatchObject({ ok: true });
  });

  it('说明之后主人亲口的小改动直接生效（amend）：说明失效，总管被叫醒', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [rewriteOf(3), OTHER]);
    await ownerSays(fix, fix.chief.id, '那句话说得更准确些');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const amended = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'amend', agreementId: ids.agreementId, changeNote: '把一句话说得更准确', summary: '做一个能查看每日报价、可以手动刷新的小页面' });
    expect(amended, JSON.stringify(amended)).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(escalateItem(fix, job.id)).toBeUndefined();
    expect(theJob(fix)).toMatchObject({ state: 'blocked', inboxId: null, escalation: { invalid: 'updated' } });
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：约定已更新', selectable: false });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: ESCALATION_EXPIRED_TEXT });
    await chiefEnds(fix, '好的，已改。');
    expect(sectionOf(await nextPacket(fix, fix.chief.id))).toContain(ESCALATION_EXPIRED_WAKE_TEXT);
  });

  it('说明之后出了待确认版本、主人不确认、总管撤销：撤销之后总管被叫醒并可以重新说明；待确认期间总管不被叫醒', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [rewriteOf(3), OTHER]);
    const agreementId = await reviseAfterEscalation(fix, { changeNote: '加手机', doneWhen: [FIRST, ...lockedDone(fix, job.agreementId)] });
    // 待确认期间：「待你处理」里只有约定的确认条目；总管调用说明被拒，文字如上。
    expect(openKeys(fix)).toEqual(['agreement:2']);
    const before = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id).length;
    const blockedCall = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '卡在失败提示', suggested: 0, reason: '改动最小', options: [rewriteOf(4), OTHER] });
    expect(blockedCall).toEqual({ ok: false, error: '约定第 2 版在等主人确认，确认之后再向主人说明。' });
    for (let i = 0; i < 6; i += 1) await tick(fix, 10 * MINUTE);
    expect(runningOf(fix, fix.chief.id)).toBeUndefined();
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id).length).toBe(before);
    // 主人不确认，总管撤销这次重新确认。
    await ownerSays(fix, fix.chief.id, '不用加了，还是原来的');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人不要这一条了' })).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '好的，仍按第 1 版。', { outcome: 'progress' });
    await flushJobHooks(fix.ctx);
    // 撤销之后总管的唤醒立即排上（回合开着时由中心排的候选还在队里，不用等兜底巡检的 30 分钟）。
    expect(entriesOf(fix, fix.chief.id, job.id).length + (runningOf(fix, fix.chief.id) ? 1 : 0)).toBeGreaterThan(0);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', pause: null, inboxId: null, escalation: { invalid: 'withdrawn' } });
    // m1：撤销之后记下的原因由 reconfirming 改为 withdrawn，拒绝文字按原因区分。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: '这张卡上的办法在约定重新确认期间已失效。总管会重新处理。' });
    expect(sectionOf(await nextPacket(fix, fix.chief.id))).toContain(ESCALATION_WITHDRAWN_WAKE_TEXT);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '接口失败时的提示做不到', suggested: 0, reason: '改动最小',
      options: [rewriteOf(3), OTHER] })).toMatchObject({ ok: true });
  });
});
