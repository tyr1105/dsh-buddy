/**
 * P74r2c 的测试：「怎样算做完」的条目变动之后，按原文重新对应（第二次审查 G4）。
 *
 * 走真实 Hub（真实的启动整理、假时钟、内存文件系统），时间每次推进不超过 10 分钟。
 * 场景：「会员定价页」派给林舟、评审甲核对。执行中主人改了「怎样算做完」（在最前面插入、删去、改写、调整顺序），
 * 总管 revise 出新版本，主人确认后：
 * - 交付时核对的条目（deliveryItems）、返工待改的条目（unmet）、受阻关联的条目（blocked.no）要跟着条目原文换序号；
 * - 核对中只删去条目的，中心按新编号重排最近一次交回，核对人重新被叫醒，不叫执行者；
 * - 交回的校验按原文判断哪些条目要重交、沿用的条目带着上一轮的说明和证据。
 * 断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { isCenterRemapped } from '../src/job/item-remap.js';
import { latestSubmission } from '../src/job/store.js';
import { chiefChainBody } from '../src/wake/job-section-chief.js';
import { assignArgs, commitAndEnd, wakesOf } from './p74c-fixtures.js';
import { chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, engineerSubmits, entriesOf, executorInfo, firstSubmitArgs, jobFix, lastPacket, metWithImage, nextPacket,
  putStandardFiles, reviewerInfo, reviewerThoughtRecently, runningOf, sectionOf, started, theJob, threadOf, tick, writeSnapshot, type JobFix,
} from './p74d-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';

/** 约定第 1 版的三条：与夹具一致。 */
const T1 = '打开页面能看到今天的报价';
const T2 = '点刷新后数据更新';
const T3 = '接口失败时有提示';

/** 主人说话、总管 revise 出新版本（不交账）；返回编号和工具结果。 */
async function chiefRevises(fix: JobFix, extra: Record<string, unknown>) {
  if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  await ownerSays(fix, fix.chief.id, '验收条目要调整一下');
  const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra));
  return { ...ids, result };
}

/** 主人点确认（第 2 版），并等固定后的收尾做完。 */
async function confirmV2(fix: JobFix, agreementId: string): Promise<void> {
  expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
}

/** 一件事的全部交回记录，按写入顺序。 */
const submissionsOf = (fix: JobFix, jobId: string) => fix.ctx.store.table('jobSubmissions').list(row => row.jobId === jobId);

/** 按指定的「怎样算做完」派活（第 1 条交付时核对），林舟拿到第一个回合，文件已放好。 */
async function startedWith(doneWhen: string[]) {
  const fix = await jobFix();
  await chiefDrafts(fix as never, { title: '会员定价页', doneWhen });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
  await tick(fix, 10 * MINUTE);
  reviewerThoughtRecently(fix);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  return { fix, job: theJob(fix), info };
}

/** 核对人调用 review。 */
const review = (fix: JobFix, jobId: string, items: unknown[]) =>
  callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId, items });

describe('G4 现象一：交付时核对的条目换成新序号', () => {
  // P74r7：被指定为交付时核对的第 3 条原文必须写了时间（原来是「能导出表格」）。
  const REWRITTEN = [T2, T3, '17 号前能导出表格'];

  it('删去第 1 条、末尾加一条（条数不变），不写 deliveryItems：返回文字如实说没有交付时核对的条目；固定后 deliveryItems 为空；at_delivery 被拒，附证据交回成功', async () => {
    const { fix, job } = await started();
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '去掉第 1 条，加导出', doneWhen: REWRITTEN });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).toContain('新版本里没有交付时核对的条目。');
    // 原来在交付时核对的那一条被改写（或删去）：提醒总管重新指定。
    expect(result.text).toContain(`原来在交付时核对的「${T1}」被改写了；它仍然要到交付时才能核对的话，重新提交这一版并在 deliveryItems 里写上它的新序号。`);
    // 等确认期间随新版本存在暂停信息里，这件事本身还是旧的。
    expect(theJob(fix).deliveryItems).toEqual([1]);
    expect(theJob(fix).pause).toMatchObject({ versionNo: 2, deliveryItems: [] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ deliveryItems: [], pause: null, handledVersionNo: 2 });
    // 执行者唤醒包里没有「交付时核对」的标记。
    const info = executorInfo(await nextPacket(fix, fix.engineer.id));
    expect(info.items.map(item => item.text)).toEqual(REWRITTEN);
    expect(info.items.some(item => item.atDelivery)).toBe(false);
    await putStandardFiles(fix, info);
    // 把第 1 条写成 at_delivery 被拒（它现在是普通条目）。
    const items = info.items.map(item => item.no === 1 ? { no: 1, selfCheck: 'at_delivery' } : item.no === 2 ? metWithImage(2) : metWithImage(item.no, '证据/桌面.png'));
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { items }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('第 1 条：这一条不是交付时核对的条目，selfCheck 不能写 at_delivery');
    expect(submissionsOf(fix, job.id)).toHaveLength(0);
    // 按普通条目附证据交回成功。
    expect(await engineerSubmits(fix, info)).toMatchObject({ ok: true });
    expect(latestSubmission(fix.ctx, job.id)!.items.map(item => item.selfCheck)).toEqual(['met', 'met', 'met']);
  });

  it('写了 deliveryItems（指向改写后的那一条）：返回文字写明序号，固定后生效，执行者按 at_delivery 交回成功', async () => {
    const { fix } = await started();
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '去掉第 1 条，加导出', doneWhen: REWRITTEN, deliveryItems: [3] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).toContain('交付时核对的条目（新版本）：第 3 条。');
    expect(result.text).not.toContain('被改写了');
    expect(theJob(fix).pause).toMatchObject({ deliveryItems: [3] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix).deliveryItems).toEqual([3]);
    const info = executorInfo(await nextPacket(fix, fix.engineer.id));
    expect(info.items.map(item => item.atDelivery)).toEqual([false, false, true]);
    await putStandardFiles(fix, info);
    expect(await engineerSubmits(fix, info)).toMatchObject({ ok: true });
    expect(latestSubmission(fix.ctx, theJob(fix).id)!.items.map(item => item.selfCheck)).toEqual(['met', 'met', 'at_delivery']);
  });

  it('没写 deliveryItems、原来交付时核对的那一条原文还在：只是序号变了（在最前面插入一条），deliveryItems 跟着换成 2，不出现「被改写」的提醒', async () => {
    const { fix } = await started();
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '前面加一条', doneWhen: ['加载时有提示', T1, T2, T3] });
    expect(result.text).toContain('交付时核对的条目（新版本）：第 2 条。');
    expect(result.text).not.toContain('被改写了');
    await confirmV2(fix, agreementId);
    expect(theJob(fix).deliveryItems).toEqual([2]);
  });

  it('deliveryItems 越界被拒（与派活时同一份校验），约定和这件事零写入', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '调整一下');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const before = { snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) };
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, { deliveryItems: [4] }));
    expect(result).toEqual({ ok: false, error: 'deliveryItems：序号 4 不在「怎样算做完」的范围内（1 到 3）' });
    expect({ snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) }).toEqual(before);
  });
});

/** 返工中：评审甲核对第 1 轮，第 3 条不符（页面空白），林舟的返工回合已结束。 */
async function inRework() {
  const s = await started();
  const { fix, info } = s;
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
  const reviewed = await review(fix, seen.jobId, [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动', rechecked: true },
    { no: 3, verdict: 'unmet', note: '接口失败时页面空白', fixTo: '接口失败时显示提示' }]);
  expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对了' }).catch(() => undefined);
  expect(theJob(fix)).toMatchObject({ state: 'rework', unmet: [{ no: 3 }] });
  // 林舟的返工回合：看一眼就结束，之后约定改动。
  await nextPacket(fix, fix.engineer.id);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  return s;
}

describe('G4 现象二：返工条目的问题跟着原文换序号', () => {
  it('返工中待改的是第 3 条，在最前面插入一条：固定后待改清单是第 1 条（新版本改了这一条）和第 4 条（问题原样）；唤醒包对得上；只交第 1、4 条，其余沿用并带着证据', async () => {
    const { fix, job } = await inRework();
    const { agreementId } = await chiefRevises(fix, { changeNote: '前面加载入提示', doneWhen: ['加载时有提示', T1, T2, T3] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'rework', deliveryItems: [2] });
    expect(theJob(fix).unmet).toEqual([
      { no: 1, problem: '约定第 2 版改了这一条', fixTo: '加载时有提示' },
      { no: 4, problem: '接口失败时页面空白', fixTo: '接口失败时显示提示' },
    ]);
    // 执行者唤醒包：第 4 条的原文与问题对得上。
    const packet = await nextPacket(fix, fix.engineer.id);
    const info = executorInfo(packet);
    expect(info.items[3]).toMatchObject({ no: 4, text: T3 });
    const text = sectionOf(packet);
    expect(text).toContain('第 4 条：问题：接口失败时页面空白；改到什么程度算过：接口失败时显示提示。');
    expect(text).toContain('第 1 条：问题：约定第 2 版改了这一条；改到什么程度算过：加载时有提示。');
    expect(text).not.toContain('第 3 条：问题');
    // 只交第 1、4 条即可。
    const oldSubmission = latestSubmission(fix.ctx, job.id)!;
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '补了载入提示，修了失败提示', deliverables: ['交付/报价页.html'],
      items: [metWithImage(1, '证据/桌面.png'), metWithImage(4)] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    const fresh = latestSubmission(fix.ctx, job.id)!;
    expect(fresh.versionNo).toBe(2);
    expect(fresh.items.map(item => [item.no, item.text, item.selfCheck])).toEqual([
      [1, '加载时有提示', 'met'], [2, T1, 'carried'], [3, T2, 'carried'], [4, T3, 'met']]);
    // 沿用的条目：按原文从上一次交回带过来，说明、证据编号和检查结果逐条一致。
    for (const kept of [T1, T2]) {
      const before = oldSubmission.items.find(item => item.text === kept)!;
      const after = fresh.items.find(item => item.text === kept)!;
      expect(after.note, kept).toEqual(before.note);
      expect(after.evidence, kept).toEqual(before.evidence);
    }
    expect(fresh.items.find(item => item.text === T2)!.evidence.length).toBeGreaterThan(0);
    // 所有证据编号在这次交回里不重复。
    const ids = fresh.items.flatMap(item => item.evidence.map(evidence => evidence.id));
    expect(new Set(ids).size).toBe(ids.length);
    // 核对人的唤醒包：沿用的条目追到「同一条」上一轮的结论（按原文，不按序号）。
    // 按序号会把新的第 3 条（点刷新）追到旧的第 3 条（接口失败时有提示，不符）上。
    const reviewerText = sectionOf(await nextPacket(fix, fix.reviewer.id));
    expect(reviewerText).toContain(`3. ${T2}\n自查：沿用第 1 轮结论：符合`);
    expect(reviewerText).toContain(`2. ${T1}\n自查：沿用第 1 轮结论：交付时核对`);
    expect(reviewerText).toContain(`4. ${T3}\n自查：自查符合`);
  });

  it('只交第 4 条、漏了第 1 条：被拒，写明第 1 条没有交回（待改条目必须重交）', async () => {
    const { fix, job } = await inRework();
    const { agreementId } = await chiefRevises(fix, { changeNote: '前面加载入提示', doneWhen: ['加载时有提示', T1, T2, T3] });
    await confirmV2(fix, agreementId);
    await nextPacket(fix, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '只改了失败提示', deliverables: ['交付/报价页.html'], items: [metWithImage(4)] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('第 1 条：没有交回');
  });
});

describe('核对中改约定', () => {
  const FOUR = [T1, T2, T3, '能导出表格'];

  /** 林舟交回第 1 轮（四条），评审甲拿到核对的回合后结束，不给结论。 */
  async function checking() {
    const s = await startedWith(FOUR);
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await nextPacket(s.fix, s.fix.reviewer.id);
    await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '先看一眼' });
    expect(theJob(s.fix)).toMatchObject({ state: 'checking', round: 1 });
    return s;
  }

  it('四条删去第 2 条：中心追加一条重排的交回记录（三条、证据原样）；核对人被重新叫醒，唤醒包是三条的新清单；按三条给结论成功，按旧的四条给结论被拒；执行者没有新回合；轮次不变；判断函数认得它', async () => {
    const { fix, job } = await checking();
    const original = latestSubmission(fix.ctx, job.id)!;
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '去掉刷新那条', doneWhen: [T1, T3, '能导出表格'], removals: [T2] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const executorBefore = entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length;
    await confirmV2(fix, agreementId);
    // 重排的交回记录。
    const all = submissionsOf(fix, job.id);
    expect(all).toHaveLength(2);
    const remapped = latestSubmission(fix.ctx, job.id)!;
    expect(isCenterRemapped(remapped)).toBe(true);
    expect(isCenterRemapped(original)).toBe(false);
    expect(remapped).toMatchObject({ remappedFrom: original.id, versionNo: 2, stage: original.stage, round: original.round, executorId: original.executorId });
    expect(remapped.items.map(item => [item.no, item.text])).toEqual([[1, T1], [2, T3], [3, '能导出表格']]);
    for (const item of remapped.items) {
      const before = original.items.find(row => row.text === item.text)!;
      expect({ selfCheck: item.selfCheck, note: item.note, evidence: item.evidence }).toEqual({ selfCheck: before.selfCheck, note: before.note, evidence: before.evidence });
    }
    // 原来的交回记录一字未动。
    expect(fix.ctx.store.table('jobSubmissions').get(original.id)).toEqual(original);
    expect(original.items).toHaveLength(4);
    // 轮次、状态不变；往来里有固定的一句。
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 1, stage: 1, deliveryItems: [1], handledVersionNo: 2 });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.from === 'hub' && row.kind === 'work'
      && row.text === '约定第 2 版删去了第 2 条，其余条目重新编号，核对按新编号进行。')).toBe(true);
    // 核对人被重新叫醒，唤醒包是三条的新清单。
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(seen.nos).toEqual([1, 2, 3]);
    expect(sectionOf(lastPacket(fix, bot(fix, fix.reviewer.id)))).toContain(`2. ${T3}`);
    // 按旧的四条给结论被拒，文字写明，没有写入核对记录。
    const stale = await review(fix, seen.jobId, [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }, { no: 4, verdict: 'met' }]);
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain('约定已更新为第 2 版，条目已重新编号，现在共 3 条，请按唤醒包里的新清单给结论。');
    expect(fix.ctx.store.table('jobReviews').list()).toHaveLength(0);
    // 按三条给结论成功。
    const ok = await review(fix, seen.jobId, [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '失败时有提示', rechecked: true }, { no: 3, verdict: 'met' }]);
    expect(ok, JSON.stringify(ok)).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', round: 1 });
    // 执行者始终没有新的回合。
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length).toBe(executorBefore);
  });

  it('核对中改写一条：退回返工，待改条目是改写的那一条（现有行为不变）；不追加交回记录', async () => {
    const { fix, job } = await checking();
    const { agreementId } = await chiefRevises(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, '接口失败时显示失败原因', '能导出表格'] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'rework', unmet: [{ no: 3, problem: '约定第 2 版改了这一条', fixTo: '接口失败时显示失败原因' }] });
    expect(submissionsOf(fix, job.id)).toHaveLength(1);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text.includes('其余条目重新编号'))).toBe(false);
  });

  it('改动是「删去一条同时新增一条」：有新增，按退回返工处理，待改条目是新增的那一条，原交回里没删', async () => {
    const { fix, job } = await checking();
    const { agreementId } = await chiefRevises(fix, { changeNote: '去掉刷新，加分享', doneWhen: [T1, T3, '能导出表格', '能分享链接'] });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'rework', unmet: [{ no: 4, problem: '约定第 2 版改了这一条', fixTo: '能分享链接' }] });
    expect(submissionsOf(fix, job.id)).toHaveLength(1);
  });
});

describe('调整顺序、没有进行中的事、撤销', () => {
  it('调整顺序的新版本被拒，文字写明哪一条位置变了；约定和这件事没有任何写入', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '换一下顺序');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const before = { snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) };
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, { doneWhen: [T2, T1, T3] }));
    expect(result).toEqual({ ok: false, error: `「怎样算做完」已有条目的顺序不要调整：「${T2}」的位置变了。要改内容就改写这一条；要去掉就删去，并在 removals 里写明。` });
    expect({ snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) }).toEqual(before);
  });

  it('没有进行中的事（事已停止）时传 deliveryItems 被拒，文字把这个参数名加进去；不传时的原文不变', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '再改一下');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    const only = { mode: 'revise', agreementId: ids.agreementId, changeNote: '改范围', scopeIn: ['报价列表页'], removals: ['手动刷新'] };
    const withDelivery = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { ...only, deliveryItems: [1] });
    expect(withDelivery).toEqual({ ok: false, error: 'continuing、paused、fallback、deliveryItems 只用于正在做的事重新确认约定' });
    const withPause = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { ...only, paused: ['甲'] });
    expect(withPause).toEqual({ ok: false, error: 'continuing、paused、fallback 只用于正在做的事重新确认约定' });
  });

  it('撤销这次重新确认之后：deliveryItems、待改清单都与撤销前相同，暂停（含其中的 deliveryItems）已丢弃', async () => {
    const { fix, job } = await inRework();
    const before = { deliveryItems: theJob(fix).deliveryItems, unmet: theJob(fix).unmet };
    expect(before).toMatchObject({ deliveryItems: [1], unmet: [{ no: 3 }] });
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '前面加载入提示', doneWhen: ['加载时有提示', T1, T2, T3], deliveryItems: [2] });
    // P74r7：原来指定的第 3 条（T2）原文没有时间，改指定 T1（新版本第 2 条，原文带「今天」，也就是原来在交付时核对的那一条挪了位置）。
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).pause).toMatchObject({ deliveryItems: [2] });
    await ownerSays(fix, fix.chief.id, '不改了，保持原来的');
    const withdrawn = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人说不用改' });
    expect(withdrawn).toEqual({ ok: true, text: '已取消这次重新确认，约定仍按已固定的版本执行。' });
    expect(theJob(fix)).toMatchObject({ ...before, pause: null });
    expect(theJob(fix).id).toBe(job.id);
  });
});

describe('受阻时关联的条目', () => {
  it('核对三轮不过（关联第 3 条）后，在最前面插入一条：固定后关联的序号是 4', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    const unmet = (round: number) => ({ no: 3, verdict: 'unmet', note: `第${round}轮的问题`, fixTo: `第${round}轮的改法` });
    expect(await review(fix, seen.jobId, [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, unmet(1)])).toMatchObject({ ok: true });
    for (const round of [2, 3]) {
      const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
        mode: 'submit', jobId: job.id, changeNote: `第${round}轮的做法`, deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')] });
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
      expect(await review(fix, job.id, [unmet(round)])).toMatchObject({ ok: true });
    }
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit', no: 3 } });
    // 各方的回合结束，总管看完提示后，主人发话改约定。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '交回了' }).catch(() => undefined);
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对了' }).catch(() => undefined);
    await nextPacket(fix, fix.chief.id);
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '先看一眼' });
    const { agreementId, result } = await chiefRevises(fix, { changeNote: '前面加载入提示', doneWhen: ['加载时有提示', T1, T2, T3] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await confirmV2(fix, agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', deliveryItems: [2], blocked: { kind: 'review_limit', no: 4, text: '第3轮的问题' } });
    // 总管的唤醒包逐轮列出核对人对「同一条」怎么说：各轮核对记录里它还是第 3 条，现在是第 4 条，按原文找，不按序号。
    const body = chiefChainBody(fix.ctx, theJob(fix), name => name, []);
    const tail = body.tail.join('\n');
    expect(tail).toContain('第 4 条核对三轮仍未通过。各轮：');
    for (const round of [1, 2, 3]) expect(tail).toContain(`核对人：第${round}轮的问题`);
    expect(tail).not.toContain('（没有写说明）');
  });
});
