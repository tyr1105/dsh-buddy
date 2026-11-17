/**
 * P76d 测试四：总管私聊里的两种整句口令——「我接下来 N 小时要用」（你自己要用）和「用我的额度」。
 *
 * 夹具与真实情况一致：真实的中心（Hub），总管是自动创建的那一位（听吩咐、安静节奏），执行员工听吩咐；
 * 口令经真实的 sendOwnerMessage 进来。每一条「生效」的用例都断言三件事：落在对话里的话（逐字）、额度记录的字段、总管没有被叫醒
 * （队列里没有总管的候选、也没有新的总管回合）。「不认领」的用例断言相反：话照常落楼、总管被叫醒、额度记录不变、没有中心回的话。
 */
import { describe, expect, it } from 'vitest';
import { sendOwnerMessage, postThread } from '../src/outreach/thread.js';
import { getQuotaPlan, defaultQuotaPlan } from '../src/quota/plan.js';
import { DUE_RISK_REF_PREFIX } from '../src/quota/owner-phrases.js';
import { BUDGET_DEFAULTS } from '../src/config/defaults.js';
import { MINUTE, assigned, jobFix, wakesOf, type JobFix } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';

const HOUR = 60 * MINUTE;
const at = (text: string) => Date.parse(`${text}+08:00`);

/** 钟点文字（上海时区，独立于被测代码的写法）。 */
const clock = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(11, 16);

/** 总管私聊里的消息（从旧到新）。 */
const chiefThread = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id);
/** 总管在队列里因主人消息排着的候选，和总管已经开过的回合数。 */
const chiefWakeups = (fix: JobFix) => ({
  queued: fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id && row.reason.kind === 'owner_message').length,
  wakes: wakesOf(fix, fix.chief.id).length,
});
const plan = (fix: JobFix) => getQuotaPlan(fix.ctx, fix.ctx.clock.now());

/** 一个干净的开始：时间设在傍晚 18:00，总管私聊里没有多余的候选。 */
async function start() {
  const fix = await jobFix();
  fix.ctx.clock.set(at('2026-11-13T18:00:00'));
  return { fix, base: chiefWakeups(fix) };
}
/** 同上，但先派出一件事（派活要在夹具自己的时间里做，之后再把假时钟设到傍晚 18:00）。 */
async function startWithJob() {
  const fix = await jobFix();
  const { job } = await assigned(fix);
  fix.ctx.clock.set(at('2026-11-13T18:00:00'));
  return { fix, job, base: chiefWakeups(fix) };
}

describe('1 我接下来 N 小时要用', () => {
  it.each([
    ['我接下来两小时要用', 2], ['我接下来 2 小时要用', 2], ['  我接下来2个小时要用DSH。', 2], ['我接下来一小时要用', 1],
    ['我接下来二小时要用', 2], ['我接下来三个小时要用', 3], ['我接下来四小时要用，', 4], ['我接下来5小时要用dsh', 5], ['我接下来５小时要用', 5],
  ] as const)('「%s」生效：%i 小时，落话逐字，不叫醒总管', async (text, hours) => {
    const { fix, base } = await start();
    const now = fix.ctx.clock.now();
    sendOwnerMessage(fix.ctx, fix.chief.id, text);
    expect(plan(fix).ownerHoldUntil).toBe(now + hours * HOUR);
    const messages = chiefThread(fix);
    expect(messages.at(-2)).toMatchObject({ from: 'owner', text: text.trim() });
    expect(messages.at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply',
      text: `好的，员工在 ${clock(now + hours * HOUR)} 前不开新回合，正在做的回合做完为止。` });
    expect(chiefWakeups(fix)).toEqual(base);
  });

  it('逐字例句：现在 18:00，说「我接下来两小时要用」，总管回「好的，员工在 20:00 前不开新回合，正在做的回合做完为止。」；额度记录的字段只有 ownerHoldUntil 变化', async () => {
    const { fix, base } = await start();
    const before = plan(fix);
    sendOwnerMessage(fix.ctx, fix.chief.id, '我接下来两小时要用');
    expect(chiefThread(fix).at(-1)!.text).toBe('好的，员工在 20:00 前不开新回合，正在做的回合做完为止。');
    expect(plan(fix)).toEqual({ ...before, ownerHoldUntil: at('2026-11-13T20:00:00'), updatedAt: fix.ctx.clock.now() });
    expect(chiefWakeups(fix)).toEqual(base);
  });

  it('跨日：晚上 23:00 说「我接下来三小时要用」，时间文字带月日', async () => {
    const { fix } = await start();
    fix.ctx.clock.set(at('2026-11-13T23:00:00'));
    sendOwnerMessage(fix.ctx, fix.chief.id, '我接下来三小时要用');
    expect(chiefThread(fix).at(-1)!.text).toBe('好的，员工在 11月14日 02:00 前不开新回合，正在做的回合做完为止。');
  });

  it.each([
    '我接下来 6 小时要用', '我接下来六小时要用', '我接下来 0 小时要用', '我接下来 10 小时要用', '我接下来可能要用',
    '我接下来两小时要用，你们先别动', '我接下来要用', '接下来两小时要用', '我接下来两小时要用吗',
  ])('「%s」不认领：话照常落楼、叫醒总管、额度记录不变、中心不回话', async text => {
    const { fix, base } = await start();
    const before = plan(fix);
    sendOwnerMessage(fix.ctx, fix.chief.id, text);
    expect(plan(fix)).toEqual(before);
    expect(plan(fix).ownerHoldUntil).toBeNull();
    expect(chiefThread(fix).at(-1)).toMatchObject({ from: 'owner', text });
    expect(chiefWakeups(fix).queued).toBe(base.queued + 1);
  });

  it('上限取自常量：超过 OWNER_HOLD_MAX_HOURS（5）不认领', () => {
    expect(BUDGET_DEFAULTS.OWNER_HOLD_MAX_HOURS).toBe(5);
  });

  it('只在总管私聊里认：员工私聊、项目主题里说同一句不认领（话落楼、照常叫人，额度记录不变）', async () => {
    const { fix, job } = await startWithJob();
    const before = plan(fix);
    sendOwnerMessage(fix.ctx, fix.engineer.id, '我接下来两小时要用');
    expect(plan(fix)).toEqual(before);
    expect(threadOf(fix.ctx, fix.engineer.id).at(-1)).toMatchObject({ from: 'owner', text: '我接下来两小时要用' });
    sendOwnerMessage(fix.ctx, job.topicId, '我接下来两小时要用');
    expect(plan(fix)).toEqual(before);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.from === 'owner' && row.text === '我接下来两小时要用')).toBe(true);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text.includes('不开新回合'))).toBe(false);
  });
});

describe('2 不用留了', () => {
  it('在你自己要用的时段内：取消，落「已取消，员工照常开工。」，不叫醒总管', async () => {
    const { fix, base } = await start();
    sendOwnerMessage(fix.ctx, fix.chief.id, '我接下来两小时要用');
    expect(plan(fix).ownerHoldUntil).not.toBeNull();
    fix.ctx.clock.advance(10 * MINUTE);
    sendOwnerMessage(fix.ctx, fix.chief.id, '不用留了。');
    expect(plan(fix).ownerHoldUntil).toBeNull();
    expect(chiefThread(fix).at(-2)).toMatchObject({ from: 'owner', text: '不用留了。' });
    expect(chiefThread(fix).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '已取消，员工照常开工。' });
    expect(chiefWakeups(fix)).toEqual(base);
  });

  it('时段外（没设过）：按普通消息，叫醒总管，不回话', async () => {
    const { fix, base } = await start();
    sendOwnerMessage(fix.ctx, fix.chief.id, '不用留了');
    expect(chiefThread(fix).at(-1)).toMatchObject({ from: 'owner', text: '不用留了' });
    expect(chiefWakeups(fix).queued).toBe(base.queued + 1);
  });

  it('时段外（已到点，视为空）：按普通消息，叫醒总管；到点本身不落任何消息', async () => {
    const { fix, base } = await start();
    sendOwnerMessage(fix.ctx, fix.chief.id, '我接下来一小时要用');
    const countAtSet = chiefThread(fix).length;
    fix.ctx.clock.advance(HOUR);
    expect(chiefThread(fix)).toHaveLength(countAtSet);
    sendOwnerMessage(fix.ctx, fix.chief.id, '不用留了');
    expect(chiefThread(fix).at(-1)).toMatchObject({ from: 'owner', text: '不用留了' });
    expect(chiefWakeups(fix).queued).toBe(base.queued + 1);
    expect(plan(fix).ownerHoldUntil).not.toBeNull(); // 记录里的截止时刻不清也无妨：过期就视为空，读的地方都比较 now
  });
});

describe('3 用我的额度', () => {
  /** 额度状态：员工份额用完（红灯 staff_full）；窗口起点一小时前。 */
  function staffFull(fix: JobFix) {
    const now = fix.ctx.clock.now();
    fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt: now - HOUR, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
      light: 'red', redUntil: now - HOUR + 5 * HOUR, probeAllowed: false, lastError: null, lastErrorAt: null });
    fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, now - HOUR), capacityTokens: 1_000_000, staffTokens: 700_000 });
  }
  /** 总管在私聊里落一条「会误交付时间」的提示（P76h 照这个约定写：refId 以 duerisk: 开头，后面是 jobId 列表）。 */
  function dueRiskHint(fix: JobFix, jobIds: string[], thread = fix.chief.id) {
    return postThread(fix.ctx, { thread, from: fix.chief.id, kind: 'reply', text: '额度用完之前，这件事可能赶不上交付时间。', refId: `${DUE_RISK_REF_PREFIX}${jobIds.join(',')}` });
  }
  async function scene() {
    const { fix, job, base } = await startWithJob();
    const title = fix.ctx.store.table('agreements').get(job.agreementId)!.title;
    staffFull(fix);
    return { fix, job, title, base: { ...base, ...chiefWakeups(fix) } };
  }

  it('员工份额用完、提示 24 小时内：整句「用我的额度」生效：这件事进 borrowJobIds，落话逐字，不叫醒总管', async () => {
    const { fix, job, title, base } = await scene();
    dueRiskHint(fix, [job.id]);
    fix.ctx.clock.advance(3 * HOUR);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([job.id]);
    expect(chiefThread(fix).at(-2)).toMatchObject({ from: 'owner', text: '用我的额度' });
    expect(chiefThread(fix).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply', text: `好的，${title}现在用你留出的额度接着做，本窗口结束前有效。` });
    expect(chiefWakeups(fix)).toEqual(base);
  });

  it('提示里有两件事：落话里的标题用顿号连起来，两件事都进 borrowJobIds；不存在的事不算；重复说不重复加', async () => {
    const { fix, job, title } = await scene();
    const jobs = fix.ctx.store.table('jobs');
    const agreements = fix.ctx.store.table('agreements');
    agreements.put({ ...agreements.get(job.agreementId)!, id: 'agr_0000000099', title: '另一件事' });
    jobs.put({ ...job, id: 'job_0000000099', agreementId: 'agr_0000000099' });
    dueRiskHint(fix, [job.id, 'job_0000000099', 'job_0000000088']);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([job.id, 'job_0000000099']);
    expect(chiefThread(fix).at(-1)!.text).toBe(`好的，${title}、另一件事现在用你留出的额度接着做，本窗口结束前有效。`);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([job.id, 'job_0000000099']);
  });

  it('边界：提示之后正好 24 小时仍生效，多 1 毫秒不生效', async () => {
    const { fix, job, base } = await scene();
    const hint = dueRiskHint(fix, [job.id]);
    fix.ctx.clock.set(hint.createdAt + BUDGET_DEFAULTS.BORROW_REPLY_WINDOW_MS + 1);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(fix).queued).toBe(base.queued + 1);
    fix.ctx.clock.set(hint.createdAt + BUDGET_DEFAULTS.BORROW_REPLY_WINDOW_MS);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([job.id]);
  });

  it('不满足条件按普通消息叫醒总管、额度记录不变、不回话：灯不是员工份额用完（绿灯 / 真实额度用完）、没有提示、提示在别处', async () => {
    // 灯是绿的
    const green = await scene();
    green.fix.ctx.store.table('quota').put({ ...green.fix.ctx.store.table('quota').get('quota')!, light: 'green', redUntil: null });
    green.fix.ctx.store.table('quotaWindows').patch('quota', { staffTokens: 0 });
    dueRiskHint(green.fix, [green.job.id]);
    sendOwnerMessage(green.fix.ctx, green.fix.chief.id, '用我的额度');
    expect(plan(green.fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(green.fix).queued).toBe(green.base.queued + 1);
    expect(chiefThread(green.fix).at(-1)).toMatchObject({ from: 'owner' });
    // 真实额度用完（红灯是另一种）
    const exhausted = await scene();
    exhausted.fix.ctx.store.table('quotaWindows').patch('quota', { exhausted: { at: exhausted.fix.ctx.clock.now(), resetAt: exhausted.fix.ctx.clock.now() + HOUR, resetFromText: true } });
    dueRiskHint(exhausted.fix, [exhausted.job.id]);
    sendOwnerMessage(exhausted.fix.ctx, exhausted.fix.chief.id, '用我的额度');
    expect(plan(exhausted.fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(exhausted.fix).queued).toBe(exhausted.base.queued + 1);
    // 没有提示
    const none = await scene();
    sendOwnerMessage(none.fix.ctx, none.fix.chief.id, '用我的额度');
    expect(plan(none.fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(none.fix).queued).toBe(none.base.queued + 1);
    // 提示落在别的对话里（员工私聊）：总管私聊里没有
    const elsewhere = await scene();
    dueRiskHint(elsewhere.fix, [elsewhere.job.id], elsewhere.fix.engineer.id);
    sendOwnerMessage(elsewhere.fix.ctx, elsewhere.fix.chief.id, '用我的额度');
    expect(plan(elsewhere.fix).borrowJobIds).toEqual([]);
    // 提示里的事已经不存在
    const gone = await scene();
    dueRiskHint(gone.fix, ['job_0000000077']);
    sendOwnerMessage(gone.fix.ctx, gone.fix.chief.id, '用我的额度');
    expect(plan(gone.fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(gone.fix).queued).toBe(gone.base.queued + 1);
  });

  it('不是整句不认领；员工私聊里说同一句也不认领', async () => {
    const { fix, job, base } = await scene();
    dueRiskHint(fix, [job.id]);
    sendOwnerMessage(fix.ctx, fix.chief.id, '请用我的额度吧');
    expect(plan(fix).borrowJobIds).toEqual([]);
    expect(chiefWakeups(fix).queued).toBe(base.queued + 1);
    sendOwnerMessage(fix.ctx, fix.engineer.id, '用我的额度');
    expect(plan(fix).borrowJobIds).toEqual([]);
  });
});
