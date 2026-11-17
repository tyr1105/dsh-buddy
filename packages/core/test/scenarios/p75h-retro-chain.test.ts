/**
 * P75h 场景：验收之后的复盘全链（设计稿 A、B 的完整一条）。
 *
 * 真实的中心 + 假宿主 + 真实工具；员工都是听吩咐、安静节奏、I 型；额度绿灯。
 * 主人提需求、总管提交约定（类别「表单页」）、主人说「定了」、总管派活给林舟（评审甲核对）；
 * 林舟交回，评审甲第 1 轮退回第 3 条，林舟返工，评审甲通过，中心交付；主人在主题里打字指出第 3 条仍不对，
 * 总管 reopen，林舟返工，评审甲通过；主人在主题里说过一句「以后提示文字别用感叹号」；主人点「验收通过」。
 * 之后：主题出现「有 3 条可学的出处，林舟、评审甲各复盘一次。」；
 * 林舟复盘（提交一项两句）→ 评审甲的合并唤醒（核对通过，并提交自己的「表单类交付核对」）→ 总管的技能核对唤醒（核对通过）。
 * 全程每次唤醒都只用唤醒包里的文字调用工具；验收之后对主人保持安静；第二件同类的事一次通过、不复盘。
 */
import { describe, expect, it } from 'vitest';
import { topicFloorsForTopic } from '../../src/api/job-topic-views.js';
import { jobCardView } from '../../src/api/job-card-views.js';
import { skillDetailView } from '../../src/api/skill-views.js';
import { postThread } from '../../src/outreach/thread.js';
import { versionsOfSkill, selfSkillPath } from '../../src/skill/files.js';
import { agreementIdIn } from '../p73d-fixtures.js';
import { newAgreementArgs } from '../p72b-fixtures.js';
import { MINUTE, assignArgs, bot, callTool, commitAndEnd, jobFix, lockedAndAwake, runningOf, speak, tick, type JobFix } from '../p74c-fixtures.js';
import { executorInfo, lastPacket, metWithImage, putStandardFiles, reviewerInfo, firstSubmitArgs } from '../p74d-fixtures.js';
import { PASS_ITEMS, reopenInfo, ownerTypes } from '../p74f-fixtures.js';
import { ownerSays } from '../p72b-fixtures.js';
import {
  FAIL_THIRD, INTERNAL_NAMES, THIRD_BACK, ownerNoise, retroSectionOf, seedSkill, srcsIn, threadOf, lightOf,
} from '../p75h-fixtures.js';
import { checkSectionOf, updatesIn } from '../p75h-fixtures.js';

/** 每 10 秒调度一次，等这位员工拿到回合；超过 2 分钟视为失败。返回等了多久（毫秒）。 */
async function waitRunning(fix: JobFix, botId: string, what: string): Promise<number> {
  let waited = 0;
  while (!runningOf(fix, botId) && waited < 120_000) {
    await tick(fix, 10_000);
    waited += 10_000;
  }
  expect(runningOf(fix, botId), `${what}：${waited / 1000} 秒内应该被放行`).toBeDefined();
  return waited;
}

/** 林舟针对某一条重新交回（标准证据），回合结束。 */
async function resubmit(fix: JobFix, jobId: string, no: number): Promise<void> {
  await waitRunning(fix, fix.engineer.id, `林舟拿到第 ${no} 条返工的回合`);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId, changeNote: '按意见改了', deliverables: ['交付/报价页.html'],
    items: [metWithImage(no, '证据/桌面.png')] })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
}

/** 评审甲核对一轮，回合结束。 */
async function review(fix: JobFix, jobId: string, items: unknown[]): Promise<void> {
  await waitRunning(fix, fix.reviewer.id, '评审甲拿到核对的回合');
  expect(reviewerInfo(lastPacket(fix, bot(fix, fix.reviewer.id))).jobId).toBe(jobId);
  expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId, items })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成' });
}

describe('场景 P75h：验收之后的复盘全链', () => {
  it('技能类唤醒恰好 3 次且 2 分钟内放行；技能库写入；折叠组 5 条；对主人保持安静；没有内部名称；第二件同类的事不复盘、对比有两行', async () => {
    const fix = await jobFix();
    fix.ctx.clock.advance(10 * MINUTE);
    // 前提（不靠额度灯碰巧放行）：员工听吩咐、在岗，额度绿灯；林舟已有「表单页做法」第 1 版（类别表单页）。
    for (const who of [fix.chief, fix.engineer, fix.reviewer]) expect(bot(fix, who.id)).toMatchObject({ onDemand: true, lifecycle: 'active' });
    const skillId = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);

    // 1. 需求、约定（类别表单页）、定了、派活。
    const packet = await lockedAndAwake(fix, '会员定价页', { category: '表单页' });
    const agreementId = agreementIdIn(packet);
    expect(fix.ctx.store.table('agreementTags').get(agreementId)).toMatchObject({ category: '表单页' });
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    const jobId = job.id;

    // 2. 林舟交回；评审甲第 1 轮退回第 3 条；林舟返工；评审甲通过；中心交付。
    await waitRunning(fix, fix.engineer.id, '林舟拿到第一个回合');
    const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    await putStandardFiles(fix, info);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await review(fix, jobId, FAIL_THIRD);
    await resubmit(fix, jobId, 3);
    await review(fix, jobId, [{ no: 3, verdict: 'met' }]);
    expect(fix.ctx.store.table('jobs').get(jobId)).toMatchObject({ state: 'awaiting_owner', stage: 1 });

    // 3. 主人在主题里打字指出第 3 条仍不对；总管 reopen；林舟返工；评审甲通过。
    await ownerTypes(fix, job.topicId, THIRD_BACK.text);
    await waitRunning(fix, fix.chief.id, '总管拿到主人发话的回合');
    const chiefSeen = reopenInfo(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: chiefSeen.jobId,
      items: [{ no: 3, problem: THIRD_BACK.problem, fixTo: '按你说的改好' }], missed: '核对时没有试到这一条，这次要试' })).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已退回返工，预计今天内再交给你。', { outcome: 'progress' });
    await resubmit(fix, jobId, 3);
    await review(fix, jobId, [{ no: 3, verdict: 'met' }]);
    expect(fix.ctx.store.table('jobs').get(jobId)).toMatchObject({ state: 'awaiting_owner', stage: 2 });

    // 4. 主人在主题里说过一句纠正（派活到验收之间），然后点「验收通过」。
    postThread(fix.ctx, { thread: job.topicId, from: 'owner', kind: 'chat', text: '以后提示文字别用感叹号' });
    expect(lightOf(fix, fix.engineer.id)).toBe('green');
    expect(await fix.hub.api.acceptJob({ jobId, stage: 2 })).toMatchObject({ ok: true });
    const calm = ownerNoise(fix);
    const acceptedAt = fix.ctx.clock.now();

    // 5. 主题里出现复盘提示（给主人看的唯一一句）。
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.text.startsWith('有 ')).map(row => row.text))
      .toEqual(['有 3 条可学的出处，林舟、评审甲各复盘一次。']);

    // 6. 林舟的复盘：只靠唤醒包里的文字，一项两句，每句一个出处。
    const waits: number[] = [];
    waits.push(await waitRunning(fix, fix.engineer.id, '林舟拿到复盘回合'));
    const execPacket = lastPacket(fix, bot(fix, fix.engineer.id));
    const srcs = srcsIn(execPacket);
    const reviewSrc = srcs.find(row => row.kind === '评审意见')!;
    const correctionSrc = srcs.find(row => row.label.includes('验收第'))!;
    expect(retroSectionOf(execPacket)).toContain('你在会员定价页主题里说的');
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{ skill: '表单页做法', sentences: [
      { text: '失败时页面要显示明确的失败提示', sources: [reviewSrc.src] }, { text: '改完先自己断开接口试一遍', sources: [correctionSrc.src] }] }] }))
      .toMatchObject({ ok: true, text: '已提交 1 条技能更新，等评审甲核对。' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交。' });

    // 7. 评审甲的合并唤醒：先核对林舟的更新（通过），再提交自己的复盘（新建「表单类交付核对」）。
    waits.push(await waitRunning(fix, fix.reviewer.id, '评审甲拿到合并唤醒'));
    const reviewerPacket = lastPacket(fix, bot(fix, fix.reviewer.id));
    expect(reviewerPacket.indexOf('## 本轮核对技能更新：')).toBeGreaterThan(-1);
    expect(reviewerPacket.indexOf('## 本轮核对技能更新：')).toBeLessThan(reviewerPacket.indexOf('## 本轮复盘：'));
    const checkedUpdate = updatesIn(reviewerPacket)[0]!;
    // P75r5b 同步（围栏）：出处原文放进不可信围栏，标签留在围栏外（原来写在同一行「…：「原文」」）。
    expect(checkSectionOf(reviewerPacket)).toContain('出处 会员定价页验收第 3 条：\n<<<untrusted\n第 3 条还是不对：失败时页面没有任何提示\nuntrusted>>>');
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: checkedUpdate.id, consistent: 'met', withinScope: 'met' }))
      .toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 2 版。' });
    const mine = srcsIn(reviewerPacket)[0]!;
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [{ title: '表单类交付核对', whenToUse: '核对表单页时', sentences: [
      { text: '核对表单页时断开接口试一次失败提示', sources: [mine.src] }] }] })).toMatchObject({ ok: true, text: '已提交 1 条技能更新，等总管核对。' });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对与复盘完成', reply: '完成。' });

    // 8. 总管的技能核对唤醒：核对评审甲的更新（通过）。
    waits.push(await waitRunning(fix, fix.chief.id, '总管拿到技能核对唤醒'));
    const chiefPacket = lastPacket(fix, bot(fix, fix.chief.id));
    expect(chiefPacket).toContain('## 本轮核对技能更新：会员定价页');
    expect(chiefPacket).not.toContain('## 本轮复盘：');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_skill', { mode: 'check', updateId: updatesIn(chiefPacket)[0]!.id, consistent: 'met', withinScope: 'met' }))
      .toMatchObject({ ok: true, text: '已写入技能库：「表单类交付核对」第 1 版。' });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '核对完成' });

    // —— 断言 ——
    // 技能类唤醒从验收到结束恰好 3 次（林舟 1、评审员 1、总管 1），每次都在假时钟 2 分钟内放行。
    const skillWakes = fix.ctx.store.table('wakes').list(row => /^(retro|skillcheck|tidy):/.test(row.subjectKey ?? '') && row.startedAt >= acceptedAt);
    expect(skillWakes).toHaveLength(3);
    expect([fix.engineer.id, fix.reviewer.id, fix.chief.id].map(id => skillWakes.filter(row => row.botId === id).length)).toEqual([1, 1, 1]);
    for (const waited of waits) expect(waited).toBeLessThanOrEqual(2 * MINUTE);

    // 林舟「表单页做法」第 2 版两句、出处各一；评审员「表单类交付核对」第 1 版；技能文件已物化。
    const mine2 = fix.ctx.store.table('skills').get(skillId)!;
    expect(mine2.currentVersionNo).toBe(2);
    const v2 = versionsOfSkill(fix.ctx, skillId).find(row => row.no === 2)!;
    expect(v2.sentences.filter(row => row.addedInNo === 2).map(row => [row.text, row.sourceIds.length])).toEqual([
      ['失败时页面要显示明确的失败提示', 1], ['改完先自己断开接口试一遍', 1]]);
    const reviewerSkill = fix.ctx.store.table('skills').list(row => row.botId === fix.reviewer.id && row.title === '表单类交付核对')[0]!;
    expect(versionsOfSkill(fix.ctx, reviewerSkill.id).map(row => row.no)).toEqual([1]);
    expect(await fix.ctx.fs.readText(selfSkillPath(bot(fix, fix.engineer.id), mine2))).toContain('改完先自己断开接口试一遍');
    expect(await fix.ctx.fs.readText(selfSkillPath(bot(fix, fix.reviewer.id), reviewerSkill))).toContain('核对表单页时断开接口试一次失败提示');
    expect(fix.hub.allowedSkillNames(fix.reviewer.id)).toContain(reviewerSkill.dirName);

    // 主题「复盘」折叠组 5 条：林舟复盘卡、评审员复盘卡、评审员核对卡、总管核对卡、小结。
    const groups = topicFloorsForTopic(fix.ctx, job.topicId, threadOf(fix.ctx, job.topicId)).items.filter(item => item.kind === 'fold');
    const retroGroup = groups.find(item => item.kind === 'fold' && 'label' in item && item.label === '复盘')!;
    expect(retroGroup).toMatchObject({ kind: 'fold', count: 5, label: '复盘' });
    const refs = (retroGroup as { messages: Array<{ message: { refId: string | null; text: string }; fromName: string }> }).messages.map(row => row.message);
    expect(refs.filter(row => row.refId?.startsWith('retro:') === true)).toHaveLength(2);
    expect(refs.filter(row => row.refId?.startsWith('skillcheck:') === true)).toHaveLength(2);
    expect(refs.at(-1)).toMatchObject({ text: '2 条技能更新核对通过，写入技能库。' });
    // 评审员核对卡（给林舟）与总管核对卡（给评审员）：视图逐字。
    const checkCards = refs.filter(row => row.refId?.startsWith('skillcheck:') === true).map(row => jobCardView(fix.ctx, row.refId!));
    expect(checkCards.map(view => view && view.kind === 'skill_check' ? [view.title, view.stateText, view.footer] : null)).toEqual([
      ['技能更新　「表单页做法」第 2 版', '已写入', null], ['技能更新　「表单类交付核对」第 1 版', '已写入', null]]);

    // 对主人保持安静：「待你处理」条目数、单推次数、所有私聊消息数与验收刚完成时相同。
    expect(ownerNoise(fix)).toEqual(calm);
    // 给主人看的全部消息（主题、总管私聊、各卡片视图）不含内部名称。
    const shown = [...threadOf(fix.ctx, job.topicId), ...threadOf(fix.ctx, fix.chief.id)].filter(row => row.kind !== 'job_card').map(row => row.text);
    shown.push(...refs.flatMap(row => row.refId !== null && /^(retro|skillcheck):/.test(row.refId) ? [JSON.stringify(jobCardView(fix.ctx, row.refId))] : []));
    for (const text of shown) expect(INTERNAL_NAMES.test(text), text).toBe(false);
    for (const text of shown) expect(text, text).not.toMatch(/hub_|\bsrc\d|su_|sk_|\bb_[0-9a-z]{10}/);

    // 同类任务记录：第一件 rounds 3、reworks 1。
    expect(fix.ctx.store.table('jobOutcomes').get(jobId)).toMatchObject({ rounds: 3, reworks: 1, seq: 1, category: '表单页' });
    expect(fix.ctx.store.table('skillRuns').list()).toHaveLength(1);
    expect(fix.ctx.store.table('skillRuns').list()[0]!.endedAt).not.toBeNull();

    // 9. 第二件同类的事（会议室预约页）：一次通过、没有纠正，不复盘。
    await ownerSays(fix, fix.chief.id, '再做个会议室预约页');
    await waitRunning(fix, fix.chief.id, '总管拿到第二件事的需求回合');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', newAgreementArgs({ title: '会议室预约页', category: '表单页' }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await waitRunning(fix, fix.chief.id, '总管拿到第二件事的约定已定回合');
    const secondAgreement = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)), '会议室预约页');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', assignArgs(secondAgreement, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    const second = fix.ctx.store.table('jobs').list().find(row => row.id !== jobId)!;
    await waitRunning(fix, fix.engineer.id, '林舟拿到第二件事的第一个回合');
    const info2 = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    await putStandardFiles(fix, info2);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info2))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await review(fix, second.id, PASS_ITEMS);
    expect(await fix.hub.api.acceptJob({ jobId: second.id, stage: 1 })).toMatchObject({ ok: true });
    // 不复盘：没有新的复盘记录、没有复盘提示；同类任务记录第二行 seq 为 2、一次通过。
    expect(fix.ctx.store.table('skillRuns').list()).toHaveLength(1);
    expect(threadOf(fix.ctx, second.topicId).filter(row => row.text.startsWith('有 ') && row.from === 'hub')).toEqual([]);
    expect(fix.ctx.store.table('jobOutcomes').get(second.id)).toMatchObject({ seq: 2, rounds: 1, reworks: 0, category: '表单页' });
    expect(fix.ctx.store.table('jobOutcomes').list(row => row.executorId === fix.engineer.id)).toHaveLength(2);
    // 林舟「表单页做法」的对比视图有两行（第 1 次和最近一次）。
    const compare = skillDetailView(fix.ctx, skillId).compare!;
    expect(compare.rows.map(row => [row.seqText, row.title, row.rounds, row.reworks])).toEqual([
      ['第 1 次', '会员定价页', 3, 1], ['第 2 次', '会议室预约页', 1, 0]]);
    expect(compare.note).toBe('第 2 次核对一次通过。');
  });
});
