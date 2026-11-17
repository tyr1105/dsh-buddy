/**
 * P74r2a 的测试（二）：核对环节没有动静时的出路（G9），提问只挡提问人自己的动作（疑点 4），提问原文存在这件事的记录上（疑点 5）。
 * 全部走真实 Hub（真实的启动整理、总管与评审员与真实一致的夹具），时间用注入的假时钟，每次推进 10 分钟；
 * 「核对人没有动静」用真实的回合模拟：他拿到回合、交账却不提交核对结论，中心续排、兜底叫醒，直到停住。
 */
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_STALLED_ANSWER_TEXT } from '../src/job/answer.js';
import { REVIEW_STALLED_REASSIGN_TEXT } from '../src/job/reassign-plan.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, firstSubmitArgs, nextPacket, reviewerInfo, sectionOf, started, theJob, threadOf, tick, type JobFix,
} from './p74d-fixtures.js';
import { MINUTE } from './p74b-fixtures.js';
import { commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { blockExecutor } from '../src/job/stuck.js';

/**
 * 这件事的「待你处理」条目（任何状态）。
 * P76f：不含预计消耗条目（job:<id>:cap:）：核对人一直不动，每次叫醒都用掉回合，已用加余下会超出预算线，中心会就「将超出预计」问一次；
 * 那一条与这里要证明的「停住了」「说明」条目互不相干，预计消耗条目另有用例。
 */
function itemsOf(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${jobId}:`) && !row.subjectKey.startsWith(`job:${jobId}:cap:`));
}

/**
 * 林舟交回之后，核对人（who）一直拿到回合却不提交核对结论：每次他拿到回合就交账（不核对），时间每次推进 10 分钟，
 * 直到 until 成立（最多 60 次，即 10 小时）。返回他拿到过几个回合。
 */
async function ignoresReview(fix: JobFix, whoId: string, until: () => boolean): Promise<number> {
  let turns = 0;
  for (let i = 0; i < 60 && !until(); i += 1) {
    await tick(fix, 10 * MINUTE);
    if (runningOf(fix, whoId)) { turns += 1; await commitAndEnd(fix, whoId, { outcome: 'progress', summary: '还在看' }); }
  }
  expect(until(), '应该在 10 小时内停住').toBe(true);
  return turns;
}

describe('G9 核对人没有动静', () => {
  /** 林舟交回，评审甲拿到回合却一直不提交结论，直到这件事转受阻；返回总管（执行链）这一回合的唤醒包。 */
  async function stalledReviewer() {
    const s = await started(['小周']);
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 评审甲拿到回合却不核对（真实回合）。
    await nextPacket(s.fix, s.fix.reviewer.id);
    await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '还在看' });
    // P76g：原来由巡检的兜底（叫满两次）把这件事转受阻；兜底已删除，巡检不再转受阻。这几条证明的是「卡在核对环节」转受阻之后
    // 总管的唤醒包、拒绝文字、换核对人的做法，所以直接用 blockExecutor（执行者做不下去、续排空手而归仍走它）造出同样的状态，说明文字与原来一致。
    blockExecutor(s.fix.ctx, theJob(s.fix), '连续两次叫醒都没有进展', s.fix.ctx.clock.now(), 'hub', { idle: true }, s.fix.reviewer.id);
    const packet = await nextPacket(s.fix, s.fix.chief.id);
    return { ...s, packet };
  }

  it('总管这一回合的唤醒包：写「评审甲两次被叫醒都没有提交第 1 轮的核对结论」和换核对人的做法，不写「做不下去」「回答林舟」；answer 与只写 executor 的 reassign 被拒，文字如规定；reassign（reviewer）成功，新核对人被叫醒并能提交结论', async () => {
    const { fix, job, packet } = await stalledReviewer();
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'checking' } });
    const text = sectionOf(packet);
    expect(text).toContain('评审甲两次被叫醒都没有提交第 1 轮的核对结论。');
    expect(text).toContain(`换核对人：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，reviewer 写新核对人的名字；写「总管」表示由你自己核对。`);
    expect(text).not.toContain('做不下去');
    expect(text).not.toContain('回答林舟');
    expect(text).not.toMatch(/escalate|reopen/);
    // 工作往来按事实写（P74r1 已做，保持）。
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '评审甲一直没有提交核对结论：连续两次叫醒都没有进展。已告诉总管。')).toBe(true);
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, to: '林舟', text: '随便', basis: [{ section: 'decided', no: 1 }] });
    expect(answered).toEqual({ ok: false, error: REVIEW_STALLED_ANSWER_TEXT });
    expect(REVIEW_STALLED_ANSWER_TEXT).toBe('这件事卡在核对环节，不是在等回答。换核对人：mode reassign，reviewer 写新核对人的名字；写「总管」表示由你自己核对。');
    const wrong = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(wrong).toEqual({ ok: false, error: REVIEW_STALLED_REASSIGN_TEXT });
    expect(REVIEW_STALLED_REASSIGN_TEXT).toBe('这件事卡在核对环节，换执行者解决不了。要换核对人，写 reviewer；写「总管」表示由你自己核对。');
    expect(theJob(fix).state).toBe('blocked');
    // 照做：换核对人。执行链回合里也能换（这件事自己的唤醒）。
    const zhou = fix.extras[0]!;
    const swapped = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '小周' });
    expect(swapped, JSON.stringify(swapped)).toEqual({ ok: true, text: '已把核对人换成小周，他会核对第 1 轮交回。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, reviewerId: zhou.id });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已换核对人' });
    const seen = reviewerInfo(await nextPacket(fix, zhou.id));
    const done = await callTool(fix, bot(fix, zhou.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('总管自己核对没有动静：不转受阻，状态仍是核对中；「停住了」条目恰好一条、正文按规定；之后 2 小时没有新的总管回合；总管随后提交核对结论成功，条目撤回', async () => {
    const s = await started([], { reviewer: '总管' });
    const { fix, job } = s;
    // P76r3（R1）：核对人一直拿回合会用掉预算线，中心会先问「将超出预计」；有那条条目开着时按乙不发新的停滞通知，
    // 这一例只看停滞，所以把预算线放宽，不让预计消耗条目出现。
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 16 });
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const stalled = () => itemsOf(fix, job.id).some(row => row.title === '会员定价页：没有进展');
    await ignoresReview(fix, fix.chief.id, stalled);
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, reviewerId: null });
    const items = itemsOf(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '会员定价页：没有进展', status: 'open', options: ['再提醒一次', '暂停'] });
    // P76g：正文改为两三行（原来是「已等总管核对第 n 轮交回 …，中心已提醒两次，仍没有进展。」一行）：
    // 总管连续 3 个回合没有提交结论、接力断了时判空转；否则 2 小时没有记录、重新唤醒一次仍没有记录时判停摆。这一例走的是空转。
    // P76r3（R15）：改回只接受空转的那一句，不再两种都认，保住「连续 3 个回合不提交结论判空转」这条规则。
    const FIRST_LINE = /^总管在核对这一步连续 3 个回合没有新文件或新证据。$/;
    expect(items[0]!.body.split('\n')[0]).toMatch(FIRST_LINE);
    expect(items[0]!.body).not.toMatch(INTERNAL);
    const note = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text.includes('没有进展'));
    expect(note).toHaveLength(1);
    expect(note[0]!.text.split('\n')[0]).toMatch(FIRST_LINE);
    // 往来里没有「总管一直没有……」这种转受阻的话。
    expect(threadOf(fix.ctx, job.topicId).some(row => row.kind === 'work' && row.text.includes('总管一直没有'))).toBe(false);
    // 之后 2 小时：没有新的总管回合，条目仍只有一条。
    const chiefWakes = wakesOf(fix, fix.chief.id, job.id).length;
    for (let i = 0; i < 12; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(chiefWakes);
    expect(itemsOf(fix, job.id)).toHaveLength(1);
    // 总管之后仍然可以提交核对结论：成功，条目撤回（状态是已撤回，不再开着），这件事的条目编号清空。
    const done = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: job.id,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(done, JSON.stringify(done)).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    // P74f：核对通过后中心交付：这件事的条目编号指向新建的验收条目（原来断言为空），「停住了」条目仍然是已撤回。
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner' });
    expect(theJob(fix).inboxId).toBe(itemsOf(fix, job.id).at(-1)!.id);
    expect(itemsOf(fix, job.id)[0]).toMatchObject({ status: 'withdrawn' });
    expect(itemsOf(fix, job.id).at(-1)).toMatchObject({ status: 'open', subjectKey: `job:${job.id}:accept:1` });
  });

  it('核对人（评审甲，不是总管）没有动静：P76g 起不转受阻，状态仍是核对中；先重新唤醒、仍没有记录才通知你，「没有进展」条目恰好一条', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 16 }); // 同上：这一例只看停滞，不让预计消耗条目先占住入口
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    expect(itemsOf(fix, job.id)).toHaveLength(0);
    // 评审甲每次拿到回合就交账、不提交结论；时间每步 10 分钟，直到通知你。
    await ignoresReview(fix, fix.reviewer.id, () => itemsOf(fix, job.id).some(row => row.title === '会员定价页：没有进展'));
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
    expect(itemsOf(fix, job.id)).toHaveLength(1);
  });
});

describe('疑点 4 提问只挡提问人自己的动作', () => {
  it('核对中执行者提问被拒，零写入', async () => {
    const s = await started();
    await engineerSubmits(s.fix, s.info);
    const before = theJob(s.fix);
    const result = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: s.job.id, text: '第 2 条怎么算？' });
    expect(result).toEqual({ ok: false, error: '这件事在核对中，等核对结论出来再问。' });
    expect(theJob(s.fix)).toEqual(before);
    expect(theJob(s.fix).openAsk).toBeNull();
  });

  it('核对人提问后：他自己提交核对结论被拒；总管回答，核对人被叫醒并能提交结论', async () => {
    const s = await started();
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '价格要不要含税？' })).toMatchObject({ ok: true });
    const items = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }];
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items }))
      .toEqual({ ok: false, error: '还有一个问题在等总管回答，回答之后再提交核对结论' });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '问了总管' });
    await nextPacket(fix, fix.chief.id);
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, to: '评审甲', text: '不含税', basis: [{ section: 'decided', no: 1 }] });
    expect(answered, JSON.stringify(answered)).toEqual({ ok: true, text: '已回答评审甲。' });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已回答' });
    const packet = await nextPacket(fix, fix.reviewer.id);
    expect(sectionOf(packet)).toContain('总管刚回答你：不含税');
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('别人的提问不挡执行者交回：核对人名下的未回答提问（手工造出的旧数据）不影响执行者交回；执行者自己的提问仍挡自己', async () => {
    const s = await started();
    const { fix, job, info } = s;
    const now = fix.ctx.clock.now();
    fix.ctx.store.table('jobs').patch(job.id, { openAsk: { eventId: 'jev_aaaaaaaaaa', fromId: fix.reviewer.id, at: now, text: '别人问的' } });
    // 执行者自己没有提问，交回成功。
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '搭好了价格页', deliverables: ['交付/报价页.html'], preview: 'http://localhost:5173/',
      items: info.items.map(item => item.atDelivery ? { no: item.no, selfCheck: 'at_delivery' }
        : { no: item.no, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/报价页.html', summary: '页面文件' }] }) });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    // 执行者自己提的问仍挡他自己的交回。
    const t = await started();
    expect(await callTool(t.fix, bot(t.fix, t.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: t.job.id, text: '要不要含税？' })).toMatchObject({ ok: true });
    const refused = await callTool(t.fix, bot(t.fix, t.fix.engineer.id), 'hub_job_work', firstSubmitArgs(t.info));
    expect(refused).toEqual({ ok: false, error: '你的问题总管还没有回答，先等回答，再交回' });
  });
});

describe('疑点 5 提问原文存在这件事的记录上', () => {
  it('提问后这件事的记录上有原文；把内存里的事件清掉之后，总管的唤醒包里仍有提问原文', async () => {
    const s = await started();
    const { fix, job } = s;
    const text = '价格要不要含税？约定里没写。';
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text })).toMatchObject({ ok: true });
    expect(theJob(fix).openAsk).toMatchObject({ fromId: fix.engineer.id, text });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    // 事件日志只在内存留 14 天：这里让读事件日志的人什么也读不到，模拟事件已被清掉。
    const real = fix.ctx.store.log.bind(fix.ctx.store);
    const spy = vi.spyOn(fix.ctx.store, 'log').mockImplementation(((name: string) => {
      const log = (real as (n: string) => { all: () => unknown[] })(name);
      return name === 'jobEvents' ? { ...log, all: () => [] } : log;
    }) as never);
    try {
      const packet = await nextPacket(fix, fix.chief.id);
      expect(sectionOf(packet)).toContain(`林舟问你：${text}`);
      expect(sectionOf(packet)).not.toContain('问题原文没有留在记录里');
    } finally {
      spy.mockRestore();
    }
  });

  it('升级前的数据（记录上没有原文）回头找事件；两处都没有才说原文不在记录里', async () => {
    const s = await started();
    const { fix, job } = s;
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '旧数据的问题' })).toMatchObject({ ok: true });
    const ask = theJob(fix).openAsk!;
    // 去掉记录上的原文，模拟升级前存下的数据。
    fix.ctx.store.table('jobs').patch(job.id, { openAsk: { eventId: ask.eventId, fromId: ask.fromId, at: ask.at } });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    const packet = await nextPacket(fix, fix.chief.id);
    expect(sectionOf(packet)).toContain('林舟问你：旧数据的问题');
  });
});
