/**
 * P74d 的测试：核对（hub_job_work 的 review）。
 * 走真实 Hub：真实的启动整理和显著性数值、假时钟、内存文件系统；不用人为调高分值的候选。
 *
 * 覆盖：谁能核对（核对人、总管自己核对、执行者与无关员工被拒）；校验（不符缺说明或改法、沿用与抽查的规则、
 * 交付时核对的规则，全部在写入之前，问题一次列全）；三种结果（通过、退回、三轮不过）和各自的状态、唤醒、往来提示；
 * 入队失败时整体恢复；轮次由中心计数。
 */
import { describe, expect, it } from 'vitest';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, metWithImage, nextPacket, reviewerInfo, sectionOf,
  started, theJob, threadOf, writeSnapshot, type JobFix,
} from './p74d-fixtures.js';
import { commitAndEnd, wakesOf } from './p74c-fixtures.js';

/** 林舟已交回第 1 轮、评审甲拿到核对的回合。返回评审甲唤醒包里取到的 jobId 和条目序号。 */
async function reviewing(extraEngineers: string[] = [], assignExtra: Record<string, unknown> = {}) {
  const s = await started(extraEngineers, assignExtra);
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const who = assignExtra.reviewer === '总管' ? s.fix.chief : s.fix.reviewer;
  const seen = reviewerInfo(await nextPacket(s.fix, who.id));
  return { ...s, seen, who };
}

/** 调用 review。 */
function review(fix: JobFix, who: { id: string }, jobId: string, items: unknown[], extra: Record<string, unknown> = {}) {
  return callTool(fix, bot(fix, who.id), 'hub_job_work', { mode: 'review', jobId, items, ...extra });
}

/** 第 1 轮的一组合法结论：第 1 条交付时核对，第 2 条符合，第 3 条符合或不符。 */
const round1 = (third: 'met' | 'unmet') => [
  { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动', rechecked: true },
  third === 'met' ? { no: 3, verdict: 'met' } : { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' },
];

describe('12 谁能核对', () => {
  it('执行者不能核对自己的交回；总管在核对人是评审甲时不能核对；无关员工不能核对；都零写入', async () => {
    const { fix, job, seen } = await reviewing(['小周']);
    const before = writeSnapshot(fix, job.id);
    const byExecutor = await review(fix, fix.engineer, seen.jobId, round1('met'));
    expect(byExecutor).toEqual({ ok: false, error: '核对人不能是执行者本人，只有这件事的核对人能提交核对结论' });
    const byChief = await review(fix, fix.chief, seen.jobId, round1('met'));
    expect(byChief).toEqual({ ok: false, error: '只有这件事的核对人（评审甲）能提交核对结论' });
    const byStranger = await review(fix, fix.extras[0]!, seen.jobId, round1('met'));
    expect(byStranger).toEqual({ ok: false, error: 'jobId：没有这件事，或你不在这件事里。你手上的事：无' });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('核对人为空（总管自己核对）时：总管被叫去核对并能提交结论；评审甲和其他员工不行', async () => {
    const { fix, job, seen, who } = await reviewing(['小周'], { reviewer: '总管' });
    expect(who.id).toBe(fix.chief.id);
    expect(job.reviewerId).toBeNull();
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '林舟交回第 1 轮，2 条附证据，1 条交付时核对；总管正在核对。')).toBe(true);
    const before = writeSnapshot(fix, job.id);
    // 评审甲不在这件事里（这件事没有评审员），和无关员工一样被拒。
    expect(await review(fix, fix.reviewer, seen.jobId, round1('met'))).toEqual({ ok: false, error: 'jobId：没有这件事，或你不在这件事里。你手上的事：无' });
    expect((await review(fix, fix.extras[0]!, seen.jobId, round1('met'))).error).toContain('你不在这件事里');
    // 执行者也不能核对。
    expect(await review(fix, fix.engineer, seen.jobId, round1('met'))).toEqual({ ok: false, error: '核对人不能是执行者本人，只有这件事的核对人能提交核对结论' });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    const ok = await review(fix, fix.chief, seen.jobId, round1('met'));
    expect(ok, JSON.stringify(ok)).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('jobReviews').list()[0]!.reviewerId).toBe(fix.chief.id);
  });

  it('不在核对中不能核对；还有未回答的提问不能核对；没有交回记录的核对被拒', async () => {
    const { fix, job, info } = await started();
    expect((await review(fix, fix.reviewer, job.id, round1('met'))).error)
      .toBe('这件事当前是「执行中」，只有核对中时才能提交核对结论');
    await engineerSubmits(fix, info);
    await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '第 2 条的截图要不要真机？' });
    expect((await review(fix, fix.reviewer, job.id, round1('met'))).error).toBe('还有一个问题在等总管回答，回答之后再提交核对结论');
  });
});

describe('13 核对校验：全部在写入之前，问题一次列全', () => {
  it('不符缺 note 或 fixTo、符合却写 fixTo、非沿用的条目没有结论、序号越界、重复、at_delivery 用错，各被拒且写明第几条', async () => {
    const { fix, job, seen } = await reviewing();
    const before = writeSnapshot(fix, job.id);
    const refuse = async (items: unknown[], extra: Record<string, unknown> = {}) => {
      const result = await review(fix, fix.reviewer, seen.jobId, items, extra);
      expect(result.ok, JSON.stringify(items)).toBe(false);
      expect(writeSnapshot(fix, job.id), '被拒时一点都不能写').toEqual(before);
      return result.error!;
    };
    const base = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }];
    expect(await refuse([...base, { no: 3, verdict: 'unmet', fixTo: '改成这样' }])).toContain('第 3 条：不符必须用 note 写明问题是什么');
    expect(await refuse([...base, { no: 3, verdict: 'unmet', note: '问题' }])).toContain('第 3 条：不符必须用 fixTo 写明改到什么程度算过');
    expect(await refuse([...base, { no: 3, verdict: 'met', fixTo: '多余' }])).toContain('第 3 条：只有不符的条目才写 fixTo');
    expect(await refuse(base)).toContain('第 3 条：这一条本轮交回了，必须给出结论');
    expect(await refuse([...base, { no: 3, verdict: 'met' }, { no: 9, verdict: 'met' }])).toContain('第 9 条：这次交回里没有这一条');
    expect(await refuse([...base, { no: 3, verdict: 'met' }, { no: 2, verdict: 'met' }])).toContain('第 2 条：写了多次');
    expect(await refuse([{ no: 1, verdict: 'met' }, { no: 2, verdict: 'at_delivery' }, { no: 3, verdict: 'met' }]))
      .toMatch(/第 1 条：这一条在交付时核对，verdict 只能写 at_delivery[\s\S]*第 2 条：这一条不是交付时核对的条目/);
    // 一次列全。
    const all = await refuse([{ no: 1, verdict: 'met' }, { no: 3, verdict: 'unmet' }]);
    for (const part of ['第 1 条：这一条在交付时核对', '第 2 条：这一条本轮交回了，必须给出结论', '第 3 条：不符必须用 note', '第 3 条：不符必须用 fixTo']) expect(all, part).toContain(part);
    // 第 1 轮没有沿用的条目：写 carriedNote 或 spotChecked 被拒。
    expect(await refuse(round1('met'), { carriedNote: '沿用说明' })).toContain('carriedNote：这次交回没有沿用的条目');
    expect(await refuse(round1('met'), { spotChecked: [2] })).toContain('第 2 条：spotChecked 只能写仍然沿用上一轮结论的条目');
    expect((await review(fix, fix.reviewer, seen.jobId, [])).ok).toBe(false);
  });

  it('沿用与抽查：对沿用的条目写 spotChecked 正确；对非沿用的条目、或已重新写了结论的沿用条目写 spotChecked 被拒', async () => {
    const { fix, job, seen, info } = await reviewing();
    expect(await review(fix, fix.reviewer, seen.jobId, round1('unmet'))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    // 返工：只交第 3 条，第 1、2 条沿用。
    const submit = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '补上了失败提示', deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')] });
    expect(submit, JSON.stringify(submit)).toMatchObject({ ok: true });
    void info;
    const before = writeSnapshot(fix, job.id);
    const refuse = async (items: unknown[], extra: Record<string, unknown>) => {
      const result = await review(fix, fix.reviewer, job.id, items, extra);
      expect(result.ok).toBe(false);
      expect(writeSnapshot(fix, job.id)).toEqual(before);
      return result.error!;
    };
    // 抽查第 3 条（本轮交回的，不是沿用）被拒。
    expect(await refuse([{ no: 3, verdict: 'met' }], { spotChecked: [3] })).toContain('第 3 条：spotChecked 只能写仍然沿用上一轮结论的条目');
    // 抽查第 2 条，但同时给第 2 条写了新结论（推翻沿用）：不再算抽查。
    expect(await refuse([{ no: 3, verdict: 'met' }, { no: 2, verdict: 'met' }], { spotChecked: [2] })).toContain('第 2 条：spotChecked');
    // 抽查重复。
    expect(await refuse([{ no: 3, verdict: 'met' }], { spotChecked: [2, 2] })).toContain('spotChecked：序号不能重复');
    // 正确的写法：沿用的条目可以不写，抽查第 2 条，写沿用说明。
    const ok = await review(fix, fix.reviewer, job.id, [{ no: 3, verdict: 'met' }], { spotChecked: [2, 1], carriedNote: '只改了提示，不影响其余' });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobReviews').list()[1]).toMatchObject({ spotChecked: [1, 2], carriedNote: '只改了提示，不影响其余' });
  });

  it('沿用的条目可以被重新写结论（推翻沿用）：推翻成不符就按不符处理', async () => {
    const { fix, job, seen } = await reviewing();
    await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '改了', deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')] });
    const result = await review(fix, fix.reviewer, job.id, [{ no: 3, verdict: 'met' }, { no: 2, verdict: 'unmet', note: '改了之后第 2 条坏了', fixTo: '恢复刷新按钮' }]);
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已退回林舟，只改第 2 条。' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', round: 2, unmet: [{ no: 2, problem: '改了之后第 2 条坏了', fixTo: '恢复刷新按钮' }] });
  });
});

describe('14 三种结果：通过、退回、三轮不过', () => {
  it('通过：状态待你验收，不叫醒任何人，往来里有核对卡和一句提示，事件里记着结果', async () => {
    const { fix, job, seen } = await reviewing();
    const result = await review(fix, fix.reviewer, seen.jobId, round1('met'));
    expect(result).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', round: 1, unmet: [], deliveredAt: expect.any(Number) });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.filter(row => row.kind === 'job_card' && row.refId?.startsWith('review:')).at(-1)).toMatchObject({ from: fix.reviewer.id, text: '第 1 轮　通过：3 条均符合' });
    // P74f：核对通过后由中心交付，最后一条是总管名义的交付卡（原来是一句「核对通过。总管将向你交付。」）。
    expect(topic.at(-1)).toMatchObject({ from: fix.chief.id, kind: 'job_card', refId: `delivery:${job.id}#1` });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'reviewed')).toMatchObject([{ actor: fix.reviewer.id, data: { round: 1, result: 'pass', unmet: [] } }]);
    expect(fix.ctx.store.table('jobReviews').list()[0]!.items.map(item => [item.no, item.verdict])).toEqual([[1, 'at_delivery'], [2, 'met'], [3, 'met']]);
    expect(fix.ctx.store.table('jobReviews').list()[0]!.items[1]).toMatchObject({ rechecked: true, note: '截图无横向滚动' });
  });

  it('第 1 轮不通过：返工中，不符写进这件事，林舟被叫醒，提示写剩余 2 轮，核对卡写不符条数', async () => {
    const { fix, job, seen } = await reviewing();
    const result = await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    expect(result).toEqual({ ok: true, text: '已退回林舟，只改第 3 条。' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', round: 1, unmet: [{ no: 3, problem: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' }] });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.filter(row => row.kind === 'job_card').at(-1)).toMatchObject({ from: fix.reviewer.id, text: '第 1 轮　不通过：1 条不符' });
    expect(topic.at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '第 1 轮核对未通过，已退回林舟，只改第 3 条。剩余 2 轮。' });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'reviewed')).toMatchObject([{ data: { round: 1, result: 'fail', unmet: [3] } }]);
    // 退回不叫总管。
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
  });

  it('轮次由中心计数：第 2 轮不通过写剩余 1 轮；第 3 轮仍不通过转受阻（三轮不过），总管被叫醒，总管的唤醒包有各轮的改法和核对人的问题', async () => {
    const { fix, job, seen } = await reviewing();
    const submitRound = async (round: number) => {
      const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
        mode: 'submit', jobId: job.id, changeNote: `第${round}轮的做法`, deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')] });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    };
    // 第 1 轮。
    expect(await review(fix, fix.reviewer, seen.jobId, [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' },
      { no: 3, verdict: 'unmet', note: '第1轮的问题', fixTo: '第1轮的改法' }])).toMatchObject({ ok: true });
    // 第 2 轮。
    await submitRound(2);
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 2 });
    expect(await review(fix, fix.reviewer, job.id, [{ no: 3, verdict: 'unmet', note: '第2轮的问题', fixTo: '第2轮的改法' }])).toEqual({ ok: true, text: '已退回林舟，只改第 3 条。' });
    expect(threadOf(fix.ctx, job.topicId).at(-1)!.text).toBe('第 2 轮核对未通过，已退回林舟，只改第 3 条。剩余 1 轮。');
    // 第 3 轮：仍不通过。
    await submitRound(3);
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 3 });
    const last = await review(fix, fix.reviewer, job.id, [{ no: 3, verdict: 'unmet', note: '第3轮的问题', fixTo: '第3轮的改法' }]);
    expect(last).toEqual({ ok: true, text: '第 3 轮仍未通过，已告诉总管。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', round: 3, blocked: { kind: 'review_limit', no: 3, text: '第3轮的问题', resumeTo: 'rework' } });
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '第 3 轮核对仍未通过，这件事在等总管向你说明停在哪一步。' });
    expect(topic.filter(row => row.kind === 'job_card').at(-1)).toMatchObject({ text: '第 3 轮　不通过：1 条不符' });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'reviewed').map(event => event.data.result)).toEqual(['fail', 'fail', 'limit']);
    // 总管被叫醒；执行者不再被叫醒。
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '交回了' });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对了' }).catch(() => undefined);
    const packet = await nextPacket(fix, fix.chief.id);
    const text = sectionOf(packet);
    expect(text).toContain('第 3 条核对三轮仍未通过。各轮：');
    for (const round of [1, 2, 3]) {
      if (round > 1) expect(text, `第${round}轮的做法`).toContain(`第 ${round} 轮：第${round}轮的做法。核对人：第${round}轮的问题`);
      else expect(text).toContain('第 1 轮：搭好了价格页，三档价格和刷新按钮都有。核对人：第1轮的问题');
    }
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
  });

  it('不符的条目恰好是第 3 轮之前：轮次不到 3 时一律退回，不会提前三轮不过', async () => {
    const { fix, seen } = await reviewing();
    await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    expect(theJob(fix).blocked).toBeNull();
    expect(theJob(fix).state).toBe('rework');
    // 重复核对已经退回的那一轮：状态不是核对中，被拒。
    expect((await review(fix, fix.reviewer, seen.jobId, round1('unmet'))).error).toBe('这件事当前是「返工中」，只有核对中时才能提交核对结论');
  });
});

describe('15 入队失败：核对整体恢复，工具返回失败', () => {
  it('不通过时林舟刚被停用：核对被拒，核对记录、状态、事件、往来、队列全部原样；他恢复在岗后同样的核对成功', async () => {
    const { fix, job, seen } = await reviewing();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('核对结论没有记下，已恢复到核对前的状态');
    expect(result.error).toContain('没有排上林舟的队');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix).state).toBe('checking');
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'active' });
    expect(await review(fix, fix.reviewer, seen.jobId, round1('unmet'))).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', round: 1 });
  });

  // P74e 修正（主会话追加）：回合用到上限而叫不醒林舟时，核对结论不再被拒绝——照常记录，由回合上限的处理接手。
  // 原断言「核对被拒、零写入」因此改为下面的预期。通过本来就不需要叫人，不受影响。
  it('不通过时这件事的回合已用到上限：核对结论照常记录（不排林舟的唤醒），返回文字写明回合用到上限；通过不需要叫人，不受影响', async () => {
    const { fix, job, seen } = await reviewing();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: 16 });
    const failed = await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    expect(failed).toMatchObject({ ok: true, text: expect.stringContaining('这件事已用到预计消耗，返工要等主人决定是否继续') });
    expect(fix.ctx.store.table('jobReviews').list()).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap', resumeTo: 'rework' } });
  });

  it('通过时回合已用到上限：不需要叫人，照常转待你验收', async () => {
    const { fix, job, seen } = await reviewing();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: 16 });
    expect(await review(fix, fix.reviewer, seen.jobId, round1('met'))).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('第 3 轮仍不通过时总管不在岗：核对被拒并恢复', async () => {
    const { fix, job, seen } = await reviewing();
    fix.ctx.store.table('jobs').patch(job.id, { round: 3 });
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有排上总管的队');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });
});

describe('18 给主人看的文字不含内部名称；固定句', () => {
  it('核对卡和往来提示（通过、退回、三轮不过）不含工具名、员工编号、各种内部编号', async () => {
    const { fix, job, seen } = await reviewing();
    await review(fix, fix.reviewer, seen.jobId, round1('unmet'));
    const texts = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' || row.kind === 'job_card').map(row => row.text);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) expect(text, text).not.toMatch(INTERNAL);
  });
});
