/**
 * P76b 的测试二：「员工自己发起的工作」的判断与当天计数，以及「总管为主人派出」这一项怎样带到唤醒单上。
 * 覆盖：
 * 1 isSelfWork：七种回合各一例（员工自己发起的常规回合为真，其余六种为假），另加两个反例保证判断不过宽
 *   （复盘种类但事项键不是技能类前缀；事项键是技能类前缀但种类不是复盘——都仍是员工自己发起的）；
 * 2 selfWorkUsageToday：本地日边界、没投递的不数、别的员工的不数、别的口径管着的回合不数、开始时间晚于 now 的不数；
 * 3 chiefDispatch 带到唤醒单：带它的候选经真实放行路径生成的唤醒单上这一项为真；不带的唤醒单上没有这个键（保持旧数据的形状）。
 * 假时钟：前两组直接构造唤醒单、不推进时钟；第三组只推进启动静默的 3 分钟。
 */
import { describe, expect, it } from 'vitest';
import { buildCandidate } from '../src/appraisal/think.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createBotHome } from '../src/memory/files.js';
import { WakeTicketSchema, type WakeTicket } from '../src/model/index.js';
import { isSelfWork, selfWorkUsageToday } from '../src/quota/usage.js';
import { enqueue } from '../src/scheduler/queue.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { startOfLocalDay } from '../src/util/time.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

const MINUTE = 60_000;
const BASE = modelFixtures.WakeTicket.valid as WakeTicket;

/** 一张员工自己发起的常规唤醒单；patch 改某几项。 */
function wake(patch: Partial<WakeTicket> = {}): WakeTicket {
  return { ...BASE, ownerInitiated: false, dispatchedAt: BASE.startedAt, subjectKey: 'watch:one', ...patch };
}

describe('1 isSelfWork：七种回合', () => {
  it('员工自己发起的常规回合：真', () => {
    expect(isSelfWork(wake())).toBe(true);
  });
  it('chiefDispatch 明确为 false、旧唤醒单没有这一项：都当作不是总管派出，仍为真', () => {
    expect(isSelfWork(wake({ chiefDispatch: false }))).toBe(true);
    const { chiefDispatch: _drop, ...legacy } = wake();
    expect(isSelfWork(legacy as WakeTicket)).toBe(true);
  });
  it('你发起的（ownerInitiated）：假', () => {
    expect(isSelfWork(wake({ ownerInitiated: true }))).toBe(false);
  });
  it('带 jobId（一件事里的回合）：假；jobId 为 null 的旧形状：真', () => {
    expect(isSelfWork(wake({ jobId: 'job_aaaaaaaaaa' }))).toBe(false);
    expect(isSelfWork(wake({ jobId: null }))).toBe(true);
  });
  it('总管为主人派出（chiefDispatch 为真）：假', () => {
    expect(isSelfWork(wake({ chiefDispatch: true }))).toBe(false);
  });
  it('复盘类事项键 retro:x:y：假；技能核对、整理的前缀同样为假', () => {
    const reflection = { ...BASE.reason, kind: 'reflection' as const };
    expect(isSelfWork(wake({ reason: reflection, subjectKey: 'retro:x:y' }))).toBe(false);
    expect(isSelfWork(wake({ reason: reflection, subjectKey: 'skillcheck:x:y' }))).toBe(false);
    // P76c：判断改为引用 skill/keys.ts 的 isSkillWork（事项键要有完整的段数）；原来写的 tidy:x 只有两段，不是真实的整理键，
    // 改成真实写法 tidy:<周一日期>:<员工>（P76b 的临时函数只看前缀，所以当时这样写也能通过）。
    expect(isSelfWork(wake({ reason: reflection, subjectKey: 'tidy:2026-11-16:b_x' }))).toBe(false);
  });
  it('复盘种类但事项键不是技能类前缀、事项键缺省：仍是员工自己发起的（判断不过宽）', () => {
    const reflection = { ...BASE.reason, kind: 'reflection' as const };
    expect(isSelfWork(wake({ reason: reflection, subjectKey: 'watch:one' }))).toBe(true);
    const { subjectKey: _drop, ...noKey } = wake({ reason: reflection });
    expect(isSelfWork(noKey as WakeTicket)).toBe(true);
  });
  it('事项键是技能类前缀但种类不是复盘：仍是员工自己发起的（两个条件都要满足才算技能类）', () => {
    expect(isSelfWork(wake({ subjectKey: 'retro:x:y' }))).toBe(true);
  });
  it('教学变体（teach）：假', () => {
    expect(isSelfWork(wake({ variant: 'teach' }))).toBe(false);
  });
  it('主题回合（带 topicId）：假；topicId 为 null：真', () => {
    expect(isSelfWork(wake({ topicId: 'ptp_aaaaaaaaaa' }))).toBe(false);
    expect(isSelfWork(wake({ topicId: null }))).toBe(true);
  });
});

describe('2 selfWorkUsageToday：当天计数', () => {
  const ctx = () => {
    const c = createTestContext();
    c.store.table('bots').put(botFixture);
    return c;
  };
  /** 往表里放一张唤醒单：开始时间和 id 由参数给。 */
  let serial = 0;
  function put(c: ReturnType<typeof ctx>, startedAt: number, patch: Partial<WakeTicket> = {}): void {
    serial += 1;
    c.store.table('wakes').put(wake({ id: `w_${String(serial).padStart(10, '0')}`, botId: botFixture.id, startedAt, dispatchedAt: startedAt, ...patch }));
  }

  it('本地日边界：23:59 与次日 00:01 各一个回合，次日只数 1 个；前一天 23:59 当时只数前一天的那 1 个', () => {
    const c = ctx();
    const dayStart = startOfLocalDay(c.clock.now(), c.settings.timezone);
    put(c, dayStart - MINUTE); // 前一天 23:59
    put(c, dayStart + MINUTE); // 当天 00:01
    expect(selfWorkUsageToday(c, botFixture.id, dayStart + 10 * MINUTE)).toEqual({ turns: 1 });
    // 前一天 23:59:30 时，00:01 的回合还没开始（开始时间晚于 now 不数），前一天的那个数 1。
    expect(selfWorkUsageToday(c, botFixture.id, dayStart - 30_000)).toEqual({ turns: 1 });
  });

  it('没投递的不数：dispatchedAt 为 null；老记录没有 dispatchedAt 时，投递中和出错的不数、运行中的数', () => {
    const c = ctx();
    const now = c.clock.now();
    put(c, now - 30 * MINUTE, { dispatchedAt: null, status: 'error' });
    put(c, now - 25 * MINUTE, { dispatchedAt: undefined, status: 'delivering' });
    put(c, now - 20 * MINUTE, { dispatchedAt: undefined, status: 'error' });
    expect(selfWorkUsageToday(c, botFixture.id, now)).toEqual({ turns: 0 });
    put(c, now - 15 * MINUTE, { dispatchedAt: undefined, status: 'running' });
    put(c, now - 10 * MINUTE); // 已投递
    expect(selfWorkUsageToday(c, botFixture.id, now)).toEqual({ turns: 2 });
  });

  it('别的员工的不数；开始时间晚于 now 的不数', () => {
    const c = ctx();
    const now = c.clock.now();
    put(c, now - 5 * MINUTE);
    put(c, now - 4 * MINUTE, { botId: 'b_otherother' });
    put(c, now + MINUTE);
    expect(selfWorkUsageToday(c, botFixture.id, now)).toEqual({ turns: 1 });
    expect(selfWorkUsageToday(c, 'b_otherother', now)).toEqual({ turns: 1 });
    expect(selfWorkUsageToday(c, 'b_nobodybody', now)).toEqual({ turns: 0 });
  });

  it('别的口径管着的回合不数：你发起的、一件事里的、总管派出的、主题的、教学的各一个；员工自己发起的两个照数', () => {
    const c = ctx();
    const now = c.clock.now();
    put(c, now - 9 * MINUTE, { ownerInitiated: true });
    put(c, now - 8 * MINUTE, { jobId: 'job_aaaaaaaaaa' });
    put(c, now - 7 * MINUTE, { chiefDispatch: true });
    put(c, now - 6 * MINUTE, { topicId: 'ptp_aaaaaaaaaa' });
    put(c, now - 5 * MINUTE, { variant: 'teach' });
    put(c, now - 4 * MINUTE);
    put(c, now - 3 * MINUTE);
    expect(selfWorkUsageToday(c, botFixture.id, now)).toEqual({ turns: 2 });
  });
});

describe('3 chiefDispatch 带到唤醒单上（经真实放行路径）', () => {
  /** 与 M11 测试同样的搭法：员工在岗、有家目录、越过启动静默（只推进 3 分钟）。 */
  async function setup() {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', sessionId: null, lastThinkAt: null });
    await createBotHome(ctx, ctx.store.table('bots').get(botFixture.id)!);
    ctx.clock.advance(ctx.settings.startupQuietMs);
    return ctx;
  }
  /** 入队一条候选并放行，返回生成的唤醒单。 */
  async function release(chiefDispatch: boolean) {
    const ctx = await setup();
    const entry = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'peer_message', score: 0.8, summary: '同事交来一件事',
      subjectKey: 'mail:test', ...(chiefDispatch ? { chiefDispatch: true } : {}) }));
    expect(entry, '候选应该入队').not.toBeNull();
    expect(entry!.chiefDispatch === true).toBe(chiefDispatch);
    await createDispatcher(ctx).pump();
    const wakes = ctx.store.table('wakes').list();
    expect(wakes, '放行后应该有一张唤醒单').toHaveLength(1);
    return wakes[0]!;
  }

  it('候选带 chiefDispatch：生成的唤醒单上 chiefDispatch 为真，且能通过唤醒单的 schema；isSelfWork 为假', async () => {
    const ticket = await release(true);
    expect(ticket.chiefDispatch).toBe(true);
    expect(() => WakeTicketSchema.parse(ticket)).not.toThrow();
    expect(isSelfWork(ticket)).toBe(false);
  });

  it('候选不带 chiefDispatch：生成的唤醒单上没有这个键（保持旧数据的形状）；isSelfWork 为真', async () => {
    const ticket = await release(false);
    expect('chiefDispatch' in ticket).toBe(false);
    expect(isSelfWork(ticket)).toBe(true);
  });
});
