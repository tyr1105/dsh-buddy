/**
 * P74r2a 的测试（一）：人员变化。
 *   G1 改派时处理旧执行者的提问：提问随改派作废，之后这件事照常往下走；
 *   G2 换核对人（reassign 的 reviewer）；有人停用时，改派怎样才算解除受阻。
 * 全部走真实 Hub（真实的启动整理、总管与评审员与真实一致的夹具、真实的显著性数值），时间用注入的假时钟，
 * 每次推进不超过 10 分钟；不用人为调高分值的候选。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { NOBODY_ASKING_TEXT } from '../src/job/answer.js';
import { voidedAskLine } from '../src/wake/job-section.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, executorInfo, firstSubmitArgs, lastPacket, MINUTE, metWithImage, nextPacket,
  reviewerInfo, sectionOf, started, theJob, threadOf, tick, type JobFix,
} from './p74d-fixtures.js';
import { commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { ownerSays, speak } from './p74b-fixtures.js';

/** 总管结束主人发起的这一回合（主人发话叫醒的回合必须带一句回复）。 */
async function chiefEnds(fix: JobFix): Promise<void> {
  await speak(fix, bot(fix, fix.chief.id), '已处理。', { outcome: 'progress' });
}

/** 总管主人发起的回合里调用 reassign。 */
function reassign(fix: JobFix, jobId: string, who: Record<string, unknown>) {
  return callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId, ...who });
}

/** 这件事的工作往来里中心写的话，按时间。 */
function workLines(fix: JobFix, topicId: string): string[] {
  return threadOf(fix.ctx, topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
}

/** 给主人看的这件事的主题和总管私聊里的全部文字，用来查有没有内部名称。 */
function ownerVisibleText(fix: JobFix, topicId: string): string {
  return [...threadOf(fix.ctx, topicId), ...threadOf(fix.ctx, fix.chief.id)].map(row => row.text).join('\n');
}

/** 这件事开着的「待你处理」条目。 */
function openJobItems(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:`));
}

/** 让时间流逝 6 小时（每次 10 分钟）；有人拿到回合就让他空手交账之外的事不做，只数回合。 */
async function sixHours(fix: JobFix): Promise<void> {
  for (let i = 0; i < 36; i += 1) await tick(fix, 10 * MINUTE);
}

/** 林舟交回、评审甲拿到核对回合并结束（没有交结论），随后评审甲被停用：这件事转受阻。 */
async function reviewerSuspendedInChecking(extra: string[] = ['小周']) {
  const s = await started(extra);
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  await lifecycleAction(s.fix.ctx, { botId: s.fix.reviewer.id, action: 'suspend' });
  expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'checking' } });
  await ownerSays(s.fix, s.fix.chief.id, '评审甲停用了，你看着办');
  return s;
}

describe('G1 改派时处理旧执行者的提问', () => {
  /** 林舟提问并结束回合，主人让总管改派给小周；返回改派结果。总管的回合还开着。 */
  async function askedThenReassigned() {
    const s = await started(['小周']);
    const asked = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: s.job.id, text: '价格要不要含税？' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '问了总管' });
    await ownerSays(s.fix, s.fix.chief.id, '换小周做吧');
    const result = await reassign(s.fix, s.job.id, { executor: '小周' });
    return { ...s, result, newcomer: s.fix.extras[0]! };
  }

  it('复现：改派成功，提问随之作废；返回文字、事件、往来都写明；总管 answer 被拒且文字是「现在没有人在等你回答」', async () => {
    const { fix, job, result } = await askedThenReassigned();
    expect(result).toEqual({ ok: true, text: '已改派给小周。林舟有一个没回答的提问，已随改派作废。' });
    expect(theJob(fix).openAsk).toBeNull();
    const asked = eventsOf(fix.ctx, job.id).find(row => row.kind === 'asked')!;
    const event = eventsOf(fix.ctx, job.id).find(row => row.kind === 'reassigned')!;
    expect(event.data).toMatchObject({ changed: ['executor'], from: fix.engineer.id, to: fix.extras[0]!.id,
      voidedAsk: { by: 'executor', eventId: asked.id, text: '价格要不要含税？' } });
    expect(workLines(fix, job.topicId)).toContain('林舟问的「价格要不要含税？」随改派作废；小周需要时会重新提问。');
    expect(ownerVisibleText(fix, job.topicId)).not.toMatch(INTERNAL);
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '不含税', basis: [{ section: 'decided', no: 1 }] });
    expect(answered).toEqual({ ok: false, error: NOBODY_ASKING_TEXT });
    expect(NOBODY_ASKING_TEXT).toContain('现在没有人在等你回答');
  });

  it('小周的唤醒包里有一行说明上一位执行者问过什么；他第一次交回之后这一行不再出现；交回不因提问被拒', async () => {
    const { fix, job, newcomer } = await askedThenReassigned();
    await chiefEnds(fix);
    const packet = await nextPacket(fix, newcomer.id);
    const line = '上一位执行者问过：价格要不要含税？（没有回答，已作废）。你需要这个答案时，重新提问。';
    expect(sectionOf(packet)).toContain(line);
    // 交回之前，函数（唤醒包用的同一个）返回这一行；旧执行者林舟的唤醒包里不会有它。
    expect(voidedAskLine(fix.ctx, theJob(fix), newcomer.id, 'executor')).toBe(line);
    expect(voidedAskLine(fix.ctx, theJob(fix), fix.engineer.id, 'executor')).toBeNull();
    const info = executorInfo(packet);
    const submitted = await callTool(fix, bot(fix, newcomer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 1, executorId: newcomer.id });
    // 他第一次交回之后，这一行不再出现。
    expect(eventsOf(fix.ctx, job.id).some(row => row.kind === 'submitted' && row.actor === newcomer.id)).toBe(true);
    expect(voidedAskLine(fix.ctx, theJob(fix), newcomer.id, 'executor')).toBeNull();
  });

  it('小周交账 progress（没有交回）后照常续排；他交回、评审甲核对通过之后推进 6 小时：没有「停住了」条目，总管的执行链回合为 0', async () => {
    const { fix, job, newcomer } = await askedThenReassigned();
    await chiefEnds(fix);
    const packet = await nextPacket(fix, newcomer.id);
    const info = executorInfo(packet);
    // 第一个回合只做了一部分、没有交回：中心照常续排（openAsk 已清，不再被挡）。
    await commitAndEnd(fix, newcomer.id, { outcome: 'progress', summary: '做了一半' });
    expect(entriesOf(fix, newcomer.id, job.id)).toHaveLength(1);
    await nextPacket(fix, newcomer.id);
    expect(await callTool(fix, bot(fix, newcomer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer.id, { outcome: 'progress', summary: '已交回' });
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    const seen = reviewerInfo(reviewerPacket);
    const passed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(passed, JSON.stringify(passed)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    const chiefBefore = wakesOf(fix, fix.chief.id, job.id).length;
    await sixHours(fix);
    // P74f：核对通过后中心交付，开着的条目恰好是一条验收条目（原来断言没有任何开着的条目）。
    expect(openJobItems(fix, job.id).map(row => row.subjectKey)).toEqual([`job:${job.id}:accept:1`]);
    expect(fix.ctx.store.table('inbox').list().filter(row => row.title.includes('没有进展'))).toHaveLength(0);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(chiefBefore);
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('反例：没有未回答的提问时改派，返回文字就是「已改派给小周。」，不多写作废的话', async () => {
    const s = await started(['小周']);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(s.fix, s.fix.chief.id, '换小周做吧');
    expect(await reassign(s.fix, s.job.id, { executor: '小周' })).toEqual({ ok: true, text: '已改派给小周。' });
    expect(eventsOf(s.fix.ctx, s.job.id).find(row => row.kind === 'reassigned')!.data).not.toHaveProperty('voidedAsk');
    expect(workLines(s.fix, s.job.topicId).some(line => line.includes('随改派作废'))).toBe(false);
  });

  it('换核对人时，被换下的核对人的提问同样作废：openAsk 清掉、新核对人的唤醒包里有说明、总管 answer 被拒', async () => {
    const s = await started(['小周']);
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    expect(await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: s.job.id, text: '第 2 条要不要真机截图？' })).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '问了总管' });
    await ownerSays(s.fix, s.fix.chief.id, '换小周来核对');
    const result = await reassign(s.fix, s.job.id, { reviewer: '小周' });
    expect(result).toEqual({ ok: true, text: '已把核对人换成小周，他会核对第 1 轮交回。评审甲有一个没回答的提问，已随改派作废。' });
    expect(theJob(s.fix)).toMatchObject({ reviewerId: s.fix.extras[0]!.id, openAsk: null });
    expect(workLines(s.fix, s.job.topicId)).toContain('评审甲问的「第 2 条要不要真机截图？」随改派作废；小周需要时会重新提问。');
    expect(await callTool(s.fix, bot(s.fix, s.fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: s.job.id, text: '要', basis: [{ section: 'decided', no: 1 }] }))
      .toEqual({ ok: false, error: NOBODY_ASKING_TEXT });
    await chiefEnds(s.fix);
    const packet = await nextPacket(s.fix, s.fix.extras[0]!.id);
    expect(sectionOf(packet)).toContain('上一位核对人问过：第 2 条要不要真机截图？（没有回答，已作废）。你需要这个答案时，重新提问。');
  });
});

describe('G2 换核对人', () => {
  it('复现：核对中评审员停用，只写 executor 被拒，文字写明要换核对人；状态仍是受阻，没有任何写入', async () => {
    const { fix, job } = await reviewerSuspendedInChecking();
    const before = fix.ctx.store.table('jobs').get(job.id);
    const result = await reassign(fix, job.id, { executor: '小周' });
    expect(result).toEqual({ ok: false, error: '这件事停住是因为评审甲已停用，换执行者解决不了。要换核对人，写 reviewer；写「总管」表示由你自己核对。' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toEqual(before);
    expect(theJob(fix).state).toBe('blocked');
    expect(entriesOf(fix, fix.extras[0]!.id, job.id)).toHaveLength(0);
  });

  it('写 reviewer（另一位在岗员工）：成功，回到核对中，新核对人拿到回合并提交核对结论，这一轮照常走完；被换下的评审甲的候选被丢弃', async () => {
    const { fix, job } = await reviewerSuspendedInChecking();
    const result = await reassign(fix, job.id, { reviewer: '小周' });
    expect(result).toEqual({ ok: true, text: '已把核对人换成小周，他会核对第 1 轮交回。' });
    const newcomer = fix.extras[0]!;
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, reviewerId: newcomer.id, round: 1, stage: 1 });
    expect(fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds).toContain(newcomer.id);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'reassigned')!.data)
      .toEqual({ changed: ['reviewer'], reviewerFrom: fix.reviewer.id, reviewerTo: newcomer.id });
    expect(workLines(fix, job.topicId)).toContain('核对人由评审甲换成小周。');
    expect(ownerVisibleText(fix, job.topicId)).not.toMatch(INTERNAL);
    await chiefEnds(fix);
    const seen = reviewerInfo(await nextPacket(fix, newcomer.id));
    const done = await callTool(fix, bot(fix, newcomer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(done, JSON.stringify(done)).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    expect(theJob(fix).state).toBe('awaiting_owner');
    // 之后 6 小时：没有任何人被叫去等已停用的评审甲，没有多余的条目。
    await commitAndEnd(fix, newcomer.id, { outcome: 'progress', summary: '核对通过' });
    const reviewerWakes = wakesOf(fix, fix.reviewer.id, job.id).length;
    await sixHours(fix);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(reviewerWakes);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    // P74f：核对通过后开着的条目恰好是验收条目（原来断言没有任何开着的条目）。
    expect(openJobItems(fix, job.id).map(row => row.subjectKey)).toEqual([`job:${job.id}:accept:1`]);
  });

  it('写 reviewer「总管」：核对人为空，总管被叫来核对并能提交结论；往来写「核对改由总管来做。」', async () => {
    const { fix, job } = await reviewerSuspendedInChecking();
    const result = await reassign(fix, job.id, { reviewer: '总管' });
    expect(result).toEqual({ ok: true, text: '核对改由你来做，第 1 轮交回等你核对。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', reviewerId: null });
    expect(workLines(fix, job.topicId)).toContain('核对改由总管来做。');
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    await chiefEnds(fix);
    const seen = reviewerInfo(await nextPacket(fix, fix.chief.id));
    const done = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('两位都停用、只换了其中一位：这次更换照常生效，这件事保持受阻，说明改为仍停用的那位；没有给新的人排唤醒；再换另一位后解除', async () => {
    const { fix, job } = await reviewerSuspendedInChecking(['小周', '小钱']);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    const [zhou, qian] = fix.extras as [typeof fix.engineer, typeof fix.engineer];
    const first = await reassign(fix, job.id, { reviewer: '小周' });
    expect(first).toEqual({ ok: true, text: '已把核对人换成小周。林舟仍处于停用，这件事还不能继续：再换一位执行者（executor），或等他恢复在岗。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', reviewerId: zhou.id, blocked: { kind: 'participant_off', text: '林舟已停用' } });
    expect(entriesOf(fix, zhou.id, job.id)).toHaveLength(0);
    expect(wakesOf(fix, zhou.id, job.id)).toHaveLength(0);
    // 再换另一位（执行者）：解除受阻回到核对中，核对人小周被叫去核对。
    const second = await reassign(fix, job.id, { executor: '小钱' });
    expect(second).toEqual({ ok: true, text: '已改派给小钱。这件事在核对中，核对退回后才轮到他返工。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, executorId: qian.id, reviewerId: zhou.id });
    expect(entriesOf(fix, zhou.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, qian.id, job.id)).toHaveLength(0);
  });

  it('两位都停用、先换执行者：同样保持受阻，文字写仍停用的是核对人', async () => {
    const { fix, job } = await reviewerSuspendedInChecking(['小周']);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    const result = await reassign(fix, job.id, { executor: '小周' });
    expect(result).toEqual({ ok: true, text: '已改派给小周。评审甲仍处于停用，这件事还不能继续：再换一位核对人（reviewer），或等他恢复在岗。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { text: '评审甲已停用' } });
    expect(entriesOf(fix, fix.extras[0]!.id, job.id)).toHaveLength(0);
  });

  it('只有执行者停用，只写 reviewer 被拒，文字要求换执行者', async () => {
    const s = await started(['小周']);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await lifecycleAction(s.fix.ctx, { botId: s.fix.engineer.id, action: 'suspend' });
    await ownerSays(s.fix, s.fix.chief.id, '林舟停用了，你看着办');
    expect(await reassign(s.fix, s.job.id, { reviewer: '小周' }))
      .toEqual({ ok: false, error: '这件事停住是因为林舟已停用，换核对人解决不了。要换执行者，写 executor。' });
    // 写 executor 则成功，解除受阻，新执行者被叫醒。
    expect(await reassign(s.fix, s.job.id, { executor: '小周' })).toEqual({ ok: true, text: '已改派给小周。' });
    expect(theJob(s.fix)).toMatchObject({ state: 'doing', blocked: null });
    expect(entriesOf(s.fix, s.fix.extras[0]!.id, s.job.id)).toHaveLength(1);
  });

  it('返工中核对人停用、换核对人：执行者被重新叫醒；他交回之后，新核对人照常被叫醒', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    const failed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' }] });
    expect(failed, JSON.stringify(failed)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对了' });
    expect(theJob(fix).state).toBe('rework');
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'rework' } });
    await ownerSays(fix, fix.chief.id, '评审甲停用了，换小周核对');
    const result = await reassign(fix, job.id, { reviewer: '小周' });
    expect(result).toEqual({ ok: true, text: '已把核对人换成小周。' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, reviewerId: fix.extras[0]!.id });
    await chiefEnds(fix);
    // 执行者被重新叫醒（受阻期间他的候选已被丢弃），交回第 2 轮。
    await nextPacket(fix, fix.engineer.id);
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '补了失败提示', deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 2 });
    expect(entriesOf(fix, fix.extras[0]!.id, job.id).length + wakesOf(fix, fix.extras[0]!.id, job.id).length).toBeGreaterThan(0);
    expect(runningOf(fix, fix.reviewer.id)).toBeUndefined();
  });

  it('换核对人的其他拒绝：核对人已经是他、新核对人是执行者本人、新核对人不在岗、executor 与 reviewer 都不写；零写入', async () => {
    const s = await started(['小周']);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(s.fix, s.fix.chief.id, '看看核对人');
    const { fix, job } = s;
    const before = fix.ctx.store.table('jobs').get(job.id);
    expect(await reassign(fix, job.id, { reviewer: '评审甲' })).toEqual({ ok: false, error: '核对人已经是评审甲' });
    expect(await reassign(fix, job.id, { reviewer: '林舟' })).toEqual({ ok: false, error: 'reviewer：核对人不能是执行者本人' });
    expect(await reassign(fix, job.id, {})).toMatchObject({ ok: false });
    expect((await reassign(fix, job.id, {})).error).toContain('executor、reviewer');
    fix.ctx.store.table('bots').patch(fix.extras[0]!.id, { lifecycle: 'paused' });
    expect(await reassign(fix, job.id, { reviewer: '小周' })).toEqual({ ok: false, error: 'reviewer：「小周」当前不在岗' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toEqual(before);
  });

  it('待你验收、已完成、已停止时换核对人被拒，文字写明现在的状态', async () => {
    const s = await started(['小周']);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(s.fix, s.fix.chief.id, '换核对人');
    for (const [state, label] of [['awaiting_owner', '待你验收'], ['done', '已完成'], ['stopped', '已停止']] as const) {
      s.fix.ctx.store.table('jobs').patch(s.job.id, { state });
      expect(await reassign(s.fix, s.job.id, { reviewer: '小周' }), state)
        .toEqual({ ok: false, error: `这件事当前是「${label}」，只有待开工、执行中、返工中、核对中、受阻时才能换核对人` });
    }
  });

  it('只用唤醒包里的文字调用成功：有人停用后主人在私聊发话，用正则取出事的编号和在岗员工名字，reassign（reviewer）成功', async () => {
    const { fix } = await reviewerSuspendedInChecking();
    const text = sectionOf(lastPacket(fix, bot(fix, fix.chief.id)));
    const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(text)?.[1];
    expect(jobId, '一览里应该有这件事的编号').toBeDefined();
    expect(text).toContain('评审甲已停用，这件事暂时没法往下做。换人：调用 hub_job_manage，mode 写 reassign，jobId 写 ' + jobId + '，reviewer 写新核对人的名字');
    const staff = /当前在岗的员工：(.+?)。/.exec(text)?.[1];
    expect(staff, '一览里应该列出在岗的员工').toBeDefined();
    const names = [...staff!.matchAll(/([^、（]+)（[^）]*）/g)].map(match => match[1]!);
    expect(names).not.toContain('评审甲');
    const pick = names.find(name => name !== '林舟')!;
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId, reviewer: pick });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking' });
  });

  it('改派给另一位的同时也可以换核对人：两项一起写，各自生效', async () => {
    const s = await started(['小周', '小钱']);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(s.fix, s.fix.chief.id, '执行和核对都换人');
    const result = await reassign(s.fix, s.job.id, { executor: '小周', reviewer: '小钱' });
    expect(result).toEqual({ ok: true, text: '已改派给小周。已把核对人换成小钱。' });
    expect(theJob(s.fix)).toMatchObject({ executorId: s.fix.extras[0]!.id, reviewerId: s.fix.extras[1]!.id });
    expect(eventsOf(s.fix.ctx, s.job.id).find(row => row.kind === 'reassigned')!.data).toMatchObject({ changed: ['executor', 'reviewer'] });
    expect(entriesOf(s.fix, s.fix.extras[0]!.id, s.job.id)).toHaveLength(1);
    expect(entriesOf(s.fix, s.fix.extras[1]!.id, s.job.id)).toHaveLength(0);
  });
});
