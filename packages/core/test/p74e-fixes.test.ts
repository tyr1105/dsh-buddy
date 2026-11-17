/**
 * P74e 对 P74d 的两处修正（主会话追加）的测试。
 *
 * 一、回合用到上限时，交回和提交核对结论不能被拒绝：
 *    执行者在最后一个回合里做完了，照常记录交回；不排下一个人的唤醒；这件事转为因回合上限受阻，
 *    「待你处理」里放一条回合上限条目，「现在卡在」写明在等谁做什么；记下来的「受阻前的状态」足够主人追加回合后叫醒对的人。
 *    因为别的原因（例如核对人已停用）叫不醒下一个人的，仍然整体恢复并拒绝。
 * 二、唤醒包里给执行者的调用说明，每一种证据要填哪些内容都写明白：只按这段文字填写，交回一次成功。
 *
 * 全部走真实的 Hub（真实的启动整理和分值），时间用假时钟。
 */
import { describe, expect, it } from 'vitest';
import { applyJobAction } from '../src/job/state.js';
import { expectedActorOf } from '../src/job/chain.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, firstSubmitArgs, lastPacket, nextPacket,
  putFile, reviewerInfo, sectionOf, started, theJob, threadOf, writeSnapshot,
} from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';

/** 这件事「待你处理」里的条目。 */
function itemsOf(fix: Awaited<ReturnType<typeof started>>['fix'], jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${jobId}:`));
}

/** 林舟交回，评审甲拿到核对的回合，返回评审甲从自己的唤醒包里取到的值。 */
async function reviewerReady(fix: Awaited<ReturnType<typeof started>>['fix'], info: Parameters<typeof engineerSubmits>[1]) {
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const packet = await nextPacket(fix, fix.reviewer.id);
  return reviewerInfo(packet);
}

/** 三条条目的核对结论：第 3 条不符。 */
function reviewItems(unmet: boolean) {
  return [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动' },
    unmet ? { no: 3, verdict: 'unmet', note: '接口失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' } : { no: 3, verdict: 'met', note: '复查通过' }];
}

describe('修正一：回合用到上限时，交回和核对结论不被拒绝', () => {
  it('最后一个回合交回成功且没有丢失：记录入库、状态转为因回合上限受阻、不排评审员的唤醒、返回文字与事实相符', async () => {
    // P76e：预算线按预计算（首次估计是 8）；这条证明的是「用到预算线时交回不丢」，机制与线的取值无关，显式设回 16（文案里的 16、再给 8 个照旧）。
    const { fix, job, info } = await started([], { turnCap: 16 });
    // 林舟正在跑的就是最后一个回合。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result).toEqual({ ok: true, text: '已交回第 1 轮。这件事已用到预计消耗，核对要等主人决定是否继续。' });
    // 交回记录入库、轮次占用、事件已记；没有给评审甲排唤醒。
    const submissions = fix.ctx.store.table('jobSubmissions').list();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ jobId: job.id, round: 1, executorId: fix.engineer.id });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'submitted')).toHaveLength(1);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    // 状态：因回合上限受阻，受阻前是核对中（主人追加回合之后据此叫醒评审甲）。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', round: 1, blocked: { kind: 'turn_cap', resumeTo: 'checking' } });
    // 「待你处理」恰好一条回合上限条目，无默认、不到期，「现在卡在」与事实相符。
    const items = itemsOf(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId: fix.chief.id, status: 'open', defaultOption: null, expiresAt: null,
      title: '会员定价页：已用到预计消耗', options: ['追加 2 个回合', '缩小范围', '暂停'], subjectKey: `job:${job.id}:cap:16` });
    // P76f：有预计的事，正文改为预计消耗的几行（见 budget-text.ts），「目前停在」仍在最后一行。
    expect(items[0]!.body.split('\n')[0]).toMatch(/^已用 \d+ 回合，预计 9，估计共需 \d+ 回合。$/);
    expect(items[0]!.body.split('\n').at(-1)).toBe('目前停在：等评审甲核对第 1 轮交回');
    expect(theJob(fix).inboxId).toBe(items[0]!.id);
    // 往来里的提示不说「正在核对」；总管私聊落一句回合上限。给主人看的文字没有内部名称。
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.at(-1)).toMatchObject({ from: 'hub', kind: 'work',
      text: '林舟交回第 1 轮，2 条附证据，1 条交付时核对；已用到预计消耗，核对要等你决定是否继续。' });
    // P76f：总管私聊落的是预计消耗那一句（「已用到预计的 9 回合，已停下，在等你决定。」），仍恰好一句。
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.text.includes('已用到预计的 9 回合'))).toHaveLength(1);
    expect(items[0]!.title + items[0]!.body + topic.map(row => row.text).join('')).not.toMatch(INTERNAL);
    // 记下来的「受阻前的状态」足够恢复：解除受阻后回到核对中，在等评审甲。
    const resumed = applyJobAction(theJob(fix), { type: 'unblock' }, fix.ctx.clock.now());
    expect(resumed.state).toBe('checking');
    expect(expectedActorOf(resumed)).toBe(fix.reviewer.id);
    // 之后巡检不会重复建条目，也不会叫醒任何人。
    for (let i = 0; i < 6; i += 1) { fix.ctx.clock.advance(30 * 60_000); await fix.hub.tick(); }
    expect(itemsOf(fix, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
  });

  it('核对退回时回合用到上限：核对结论入库，状态因回合上限受阻（受阻前返工中），「现在卡在」写明等林舟返工第 3 条', async () => {
    // P76e：显式把预算线设回 16（见上一条的说明）。
    const { fix, job, info } = await started([], { turnCap: 16 });
    const seen = await reviewerReady(fix, info);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: reviewItems(true) });
    expect(result).toEqual({ ok: true, text: '核对结论已记下，第 3 条不符。这件事已用到预计消耗，返工要等主人决定是否继续。' });
    expect(fix.ctx.store.table('jobReviews').list()).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap', resumeTo: 'rework' },
      unmet: [{ no: 3, problem: '接口失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' }] });
    const items = itemsOf(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.body.split('\n').at(-1)).toBe('目前停在：等林舟返工第 3 条');
    expect(items[0]!.body.split('\n')[0]).toMatch(/^已用 \d+ 回合，预计 9，估计共需 \d+ 回合。$/);
    expect(threadOf(fix.ctx, job.topicId).at(-1)!.text).toBe('第 1 轮核对未通过，只改第 3 条。已用到预计消耗，返工要等你决定是否继续。');
    const resumed = applyJobAction(theJob(fix), { type: 'unblock' }, fix.ctx.clock.now());
    expect(resumed.state).toBe('rework');
    expect(expectedActorOf(resumed)).toBe(fix.engineer.id);
  });

  it('第 3 轮仍不符且回合用到上限：保持「核对三轮不过」的受阻原因，补上回合上限条目，「现在卡在」写明等总管向你说明', async () => {
    // P76e：显式把预算线设回 16（见上面的说明）。
    const { fix, job, info } = await started([], { turnCap: 16 });
    const seen = await reviewerReady(fix, info);
    fix.ctx.store.table('jobs').patch(job.id, { round: 3, turnsUsed: job.turnCap });
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: reviewItems(true) });
    expect(result).toEqual({ ok: true, text: '核对结论已记下，第 3 轮仍未通过。这件事已用到预计消耗，总管的说明要等主人决定是否继续。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit', no: 3 } });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    const items = itemsOf(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.body.split('\n').at(-1)).toBe('目前停在：第 3 条核对三轮仍未通过，等总管向你说明');
    expect(items[0]!.body.split('\n')[0]).toMatch(/^已用 \d+ 回合，预计 9，估计共需 \d+ 回合。$/);
  });

  it('核对通过时回合用到上限：本来就不需要叫人，照常转待你验收', async () => {
    const { fix, job, info } = await started();
    const seen = await reviewerReady(fix, info);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: reviewItems(false) })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('别的原因叫不醒下一个人仍然拒绝并恢复：评审甲已停用时交回被拒（即使回合也用到了上限）、零写入', async () => {
    const { fix, job, info } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('交回失败，已恢复到交回前的状态');
    expect(result.error).toContain('没有排上评审甲的队');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(itemsOf(fix, job.id)).toHaveLength(0);
  });

  it('别的原因叫不醒仍然拒绝：核对退回时林舟已停用，核对被拒并恢复', async () => {
    const { fix, job, info } = await started();
    const seen = await reviewerReady(fix, info);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: reviewItems(true) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('核对结论没有记下，已恢复到核对前的状态');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('回合没有用到上限时一切照旧：交回后评审甲被叫醒，没有回合上限条目', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    expect(theJob(fix).state).toBe('checking');
    expect(itemsOf(fix, job.id)).toHaveLength(0);
  });
});

describe('修正二：唤醒包里给执行者的调用说明写全每种证据要填什么', () => {
  it('只按唤醒包里「交回」说明的文字填写（每项证据 kind 加 summary，文件和截图加 path，链接加 url，测试可加 command），交回一次成功', async () => {
    const { fix, job, info } = await started();
    const text = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    // 说明里写明了：每项都要 kind 和 summary；各类另外要什么。
    expect(text).toContain('evidence 的每一项都要写 kind 和 summary');
    expect(text).toContain('file 和 image 另写 path');
    expect(text).toContain('link 另写 url');
    expect(text).toContain('test 的 summary 写测试做了什么、结果如何，可以另加 command');
    expect(text).toContain('not_met 的条目要另写 note');
    // 只用说明里点名的字段，四种证据都用上。
    await putFile(fix, info, '交付/说明.md', '说明');
    const args = {
      mode: 'submit', jobId: info.jobId, changeNote: '按说明逐项填写',
      items: info.items.map(item => item.atDelivery ? { no: item.no, selfCheck: 'at_delivery' }
        : item.no === 2 ? { no: 2, selfCheck: 'met', evidence: [
          { kind: 'image', path: '证据/手机.png', summary: '手机　390 宽' },
          { kind: 'link', url: 'http://localhost:5173/', summary: '本机预览页' }] }
          : { no: item.no, selfCheck: 'met', evidence: [
            { kind: 'file', path: '交付/说明.md', summary: '说明文件' },
            { kind: 'test', summary: '依次提交 81 条，第 81 条显示名额已满', command: 'pnpm test signup' }] }),
      deliverables: ['交付/报价页.html'],
    };
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('checking');
    expect(job.id).toBe(info.jobId);
  });

  it('反例：照说明里的字段，漏写 summary 就被拒（说明里写的要求和工具实际要求一致）', async () => {
    const { fix, info } = await started();
    const args = firstSubmitArgs(info, {
      items: info.items.map(item => item.atDelivery ? { no: item.no, selfCheck: 'at_delivery' }
        : { no: item.no, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/报价页.html' }] }),
    });
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('summary');
    expect(theJob(fix).state).toBe('doing');
  });
});
