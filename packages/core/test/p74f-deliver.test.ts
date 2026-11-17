/**
 * P74f 的测试：交付（核对通过之后由中心把结果交给主人）、「待你处理」的一件事条目规则、同一时刻的条目共存。
 * 走真实 Hub：真实的核对、状态机、巡检，假时钟（每次推进不超过 10 分钟）。
 * 断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import { createInboxItem } from '../src/outreach/inbox.js';
import { delivered, deliveryCard, openItems, threadOf, tick, MINUTE, INTERNAL, type JobFix } from './p74f-fixtures.js';
import { eventsOf, wakesOf } from './p74c-fixtures.js';

describe('3 核对通过之后由中心交付', () => {
  it('主题一句话加交付卡、总管私聊一句、「待你处理」一条（一个按钮、无默认选项、不到期）；总管没有新唤醒', async () => {
    const { fix, job } = await delivered();
    const topic = threadOf(fix.ctx, job.topicId);
    const sentence = topic.find(row => row.from === fix.chief.id && row.kind === 'reply' && row.text.includes('已做完'));
    expect(sentence?.text).toBe('会员定价页已做完，3 条「怎样算做完」全部符合，评审甲已逐条核对。请你验收。');
    expect(deliveryCard(fix, job)).toMatchObject({ from: fix.chief.id, refId: `delivery:${job.id}#1`, text: '会员定价页　按约定第 1 版' });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === fix.chief.id && row.text === '会员定价页待你验收，内容在这件事的主题里。')).toBe(true);
    const items = openItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'question', botId: fix.chief.id, subjectKey: `job:${job.id}:accept:1`, refId: job.id, topicId: job.topicId,
      title: '会员定价页：待你验收', body: '3 条「怎样算做完」全部符合，已逐条核对。哪条不符合，在对话里写序号和问题。',
      options: ['验收通过'], defaultOption: null, expiresAt: null, priority: 'P1' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ inboxId: items[0]!.id, state: 'awaiting_owner' });
    // 总管没有新的唤醒，也没有排队。
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id && row.jobId === job.id)).toHaveLength(0);
    // 事件：reviewed 之后有一条 delivered，带交付时核对的结果。
    const events = eventsOf(fix.ctx, job.id).map(row => row.kind);
    expect(events.indexOf('delivered')).toBeGreaterThan(events.indexOf('reviewed'));
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'delivered')!.data).toMatchObject({ stage: 1, deliveryChecks: [{ no: 1, ok: true }] });
    for (const row of [...topic, ...threadOf(fix.ctx, fix.chief.id)]) if (row.kind !== 'work') expect(row.text).not.toMatch(INTERNAL);
  });

  it('总管自己核对时说「我已逐条核对」', async () => {
    const { fix, job } = await delivered([], { reviewer: '总管' });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '会员定价页已做完，3 条「怎样算做完」全部符合，我已逐条核对。请你验收。')).toBe(true);
  });

  it('交付时核对的条目：按时交付判符合；过了交付时间判不符，主题那句话写「第 1 条已过交付时间」', async () => {
    // 过期：核对通过之前，把交付时间改到过去（按时的例子是上一条测试）。
    const { fix, job } = await delivered([], { deliveryItems: [1] });
    // 事后再造一件过期的事：改交付时间并重新让巡检补齐，验证判定口径。
    const late = { ...job, dueAt: (job.deliveredAt ?? 0) - 1 };
    fix.ctx.store.table('jobs').put(late);
    for (const item of openItems(fix, job.id)) fix.ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '测试', answeredAt: fix.ctx.clock.now() });
    fix.ctx.store.table('jobs').put({ ...late, delivery: null, inboxId: null });
    await tick(fix, MINUTE);
    const last = eventsOf(fix.ctx, job.id).filter(row => row.kind === 'delivered').at(-1)!;
    expect(last.data).toMatchObject({ deliveryChecks: [{ no: 1, ok: false, note: '已过交付时间' }] });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '会员定价页已做完，2 条全部符合，第 1 条已过交付时间。请你验收。')).toBe(true);
  });
});

describe('巡检兜底：缺验收条目时补齐，不重复', () => {
  it('验收条目被撤回、交付记录还在：下一个 tick 补一条新的，交付卡不再多落', async () => {
    const { fix, job } = await delivered();
    const cards = () => threadOf(fix.ctx, job.topicId).filter(row => row.kind === 'job_card' && row.refId?.startsWith('delivery:')).length;
    expect(cards()).toBe(1);
    for (const item of openItems(fix, job.id)) fix.ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '测试', answeredAt: fix.ctx.clock.now() });
    await tick(fix, MINUTE);
    expect(openItems(fix, job.id)).toHaveLength(1);
    expect(cards()).toBe(1);
    await tick(fix, MINUTE);
    expect(openItems(fix, job.id)).toHaveLength(1);
  });
});

describe('4 「待你处理」里一件事条目的强制检查', () => {
  const base = (fix: JobFix, jobId: string, kind: string, options: string[]) => ({
    botId: fix.chief.id, type: 'question' as const, title: 't', body: 'b', options, defaultOption: null, expiresAt: null, priority: 'P1' as const,
    refId: jobId, subjectKey: `job:${jobId}:${kind}`,
  });

  it('验收条目：选项必须恰好是「验收通过」；有默认选项或会到期都被拒', async () => {
    const { fix, job } = await delivered();
    const wrong = { ...base(fix, job.id, 'accept:9', ['验收通过', '再看看']) };
    expect(() => createInboxItem(fix.ctx, wrong)).toThrow('验收条目的选项必须恰好是「验收通过」');
    expect(() => createInboxItem(fix.ctx, { ...base(fix, job.id, 'accept:9', ['验收通过']), defaultOption: '验收通过' })).toThrow('不能有默认选项');
    expect(() => createInboxItem(fix.ctx, { ...base(fix, job.id, 'accept:9', ['验收通过']), expiresAt: fix.ctx.clock.now() + 1000 })).toThrow('不会到期');
  });

  it('三轮不过条目 2 到 3 个办法；回合上限条目恰好「再给 N 个回合」「先停下」（N 取默认值）', async () => {
    const { fix, job } = await delivered();
    expect(() => createInboxItem(fix.ctx, base(fix, job.id, 'escalate:1', ['A　只有一个办法']))).toThrow('需要 2 到 3 个办法');
    // P76f：新条目必须是「追加 n 个回合」「缩小范围」「暂停」；旧条目的「再给 8 个回合」「暂停」两项仍认；其余写法被拒。
    expect(() => createInboxItem(fix.ctx, base(fix, job.id, 'cap:16', ['再给 3 个回合', '暂停']))).toThrow('预计消耗条目的选项必须是');
    expect(createInboxItem(fix.ctx, base(fix, job.id, 'cap:16', ['再给 8 个回合', '暂停'])).options).toEqual(['再给 8 个回合', '暂停']);
  });
});

describe('12 同一时刻的条目互不撤回；同一件事新建条目时撤回它自己的旧条目', () => {
  it('另一件事的条目不受影响；同一件事新建 job 条目时，旧的那条被撤回', async () => {
    const { fix, job } = await delivered();
    // 另一件事（造一条别的事的验收条目）和约定确认条目，与这件事的条目共存。
    const other = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '别的事：待你验收', body: 'b', options: ['验收通过'],
      defaultOption: null, expiresAt: null, priority: 'P1', refId: 'job_zzzzzzzzzz', subjectKey: 'job:job_zzzzzzzzzz:accept:1' });
    const confirm = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '约定', body: 'b', options: ['按建议，定了'],
      defaultOption: null, expiresAt: null, priority: 'P1', refId: 'agr_zzzzzzzzzz', subjectKey: 'agreement:agr_zzzzzzzzzz:1' });
    const mine = openItems(fix, job.id)[0]!;
    const next = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '会员定价页：回合用到上限', body: 'b', options: ['再给 8 个回合', '暂停'],
      defaultOption: null, expiresAt: null, priority: 'P1', refId: job.id, subjectKey: `job:${job.id}:cap:16` });
    expect(fix.ctx.store.table('inbox').get(mine.id)).toMatchObject({ status: 'withdrawn' });
    expect(openItems(fix, job.id).map(row => row.id)).toEqual([next.id]);
    expect(fix.ctx.store.table('inbox').get(other.id)!.status).toBe('open');
    expect(fix.ctx.store.table('inbox').get(confirm.id)!.status).toBe('open');
  });
});
