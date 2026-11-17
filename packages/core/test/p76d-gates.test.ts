/**
 * P76d 测试二：闸门第 7 步（额度）的全部情形：6 种情形 x 5 类候选，每一格一例（共 30 例），再加三个重点例子和边界。
 *
 * 夹具与真实情况一致：总管是自动创建的那一位（听吩咐、安静节奏）；执行员工听吩咐；调研员不听吩咐（员工自己发起的工作只发生在他身上）。
 * 每条用例写明：窗口估计容量、员工份额比例（默认 0.7）、员工已用 token、当前灯与红灯种类、是否在「你自己要用」的时段；
 * 断言拦截原因码和恢复时刻本身。额度状态一律写进存档、经真实快照（buildSnapshot）进闸门，红灯种类由真实代码算出，不手写进快照。
 * 候选入口：候选本身用真实的 buildCandidate 生成；一件事的事实（执行链）和复盘记录的事实（技能类）直接给快照，因为这里只测额度这一步。
 * 时间只用注入的假时钟，没有推进。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QueueEntry } from '../src/model/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { raiseAlert } from '../src/health/alerts.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import { botFixture } from './model-fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const JOB_ID = 'job_0000000001';
const OTHER_JOB_ID = 'job_0000000002';

function world() {
  const ctx = createTestContext();
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE; // 越过启动静默
  const base: Bot = { ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(), lifecycle: 'active' };
  const chief: Bot = { ...base, id: 'b_0000000010', name: '总管', role: 'chief', onDemand: true, pace: 'quiet', homeDir: '/hub/bots/b_0000000010' };
  const executor: Bot = { ...base, id: 'b_0000000011', name: '执行员', role: 'executor', onDemand: true, homeDir: '/hub/bots/b_0000000011' };
  const researcher: Bot = { ...base, id: 'b_0000000012', name: '调研员', role: 'researcher', onDemand: false, homeDir: '/hub/bots/b_0000000012' };
  for (const bot of [chief, executor, researcher]) ctx.store.table('bots').put(bot);
  return { ctx, chief, executor, researcher };
}
type World = ReturnType<typeof world>;

/** 五类候选：你发起的、总管派活、执行链（带 jobId）、技能类、员工自己发起的。 */
type Category = 'owner' | 'chiefDispatch' | 'chain' | 'skill' | 'self';
const CATEGORIES: readonly Category[] = ['owner', 'chiefDispatch', 'chain', 'skill', 'self'];
const CATEGORY_LABEL: Record<Category, string> = { owner: '你发起的', chiefDispatch: '总管派活', chain: '执行链（带 jobId）', skill: '技能类', self: '员工自己发起的' };

/** 候选和它的快照（执行链、技能类另给一件事、一次复盘的事实，只为让更靠前的闸门放行）。 */
function entryOf(w: World, category: Category, jobId = JOB_ID): QueueEntry {
  const now = w.ctx.clock.now();
  const input = {
    owner: { botId: w.researcher.id, kind: 'owner_message', score: 0.9, summary: '主人发来消息', ownerInitiated: true },
    chiefDispatch: { botId: w.executor.id, kind: 'peer_message', score: 0.9, summary: '总管派来一件事', chiefDispatch: true, subjectKey: 'peer:handoff' },
    chain: { botId: w.executor.id, kind: 'peer_message', score: 0.9, summary: '这件事的下一步', jobId, subjectKey: `jobwake:${jobId}:${w.executor.id}` },
    skill: { botId: w.executor.id, kind: 'reflection', variant: 'reflection', score: 0.5, summary: '复盘', subjectKey: retroSubjectKey('sr_0000000001', w.executor.id) },
    // 分数 0.6：低于「紧急」线，不是紧急候选（紧急的员工自己发起的候选在橙灯下放行，单独一条用例写）。
    self: { botId: w.researcher.id, kind: 'percept', score: 0.6, summary: '资料有变化', subjectKey: 'watch:p76d' },
  }[category];
  return { ...buildCandidate(w.ctx, input as never), id: 'q_0000000001', enqueuedAt: now } as QueueEntry;
}
function verdictOf(w: World, entry: QueueEntry) {
  const now = w.ctx.clock.now();
  const snapshot = { ...buildSnapshot(w.ctx, entry.botId, now, entry.jobId, entry.subjectKey),
    job: entry.jobId ? { state: 'doing', launchState: 'none', chiefId: w.chief.id, participants: [w.executor.id, w.chief.id], turnsLeft: 10, ownerAskOpen: false } : null,
    skillRun: entry.subjectKey.startsWith('retro:') ? { id: 'sr_0000000001', kind: 'retro', jobId: null, turnsLeft: 5,
      participants: { [w.executor.id]: 'queued' }, launchBusy: false } : null };
  return { snapshot, result: evaluateGates(entry, snapshot as never, now, w.ctx.settings) };
}

/** 六种额度情形。容量 100 万、份额 0.7（员工份额 70 万）；窗口起点是一小时前，所以本窗口结束在一小时后往后 4 小时。 */
type Situation = 'auth' | 'exhausted' | 'hold' | 'staff_full' | 'orange' | 'open';
const SITUATIONS: readonly Situation[] = ['auth', 'exhausted', 'hold', 'staff_full', 'orange', 'open'];
function setSituation(w: World, situation: Situation, extra: { borrow?: string[] } = {}) {
  const { ctx } = w;
  const now = ctx.clock.now();
  const windowStartAt = now - HOUR;
  const quota = { id: 'quota' as const, windowStartAt, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null, light: 'green' as const,
    redUntil: null as number | null, probeAllowed: false, lastError: null, lastErrorAt: null } as import('../src/model/index.js').QuotaState;
  const plan = { ...defaultQuotaPlan(now, windowStartAt), capacityTokens: 1_000_000, borrowJobIds: extra.borrow ?? [] };
  const times = { redUntil: now + 4 * HOUR, hold: now + 2 * HOUR, windowEnd: windowStartAt + 5 * HOUR, exhaustedUntil: now + HOUR + 5 * MINUTE };
  if (situation === 'auth') raiseAlert(ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true, at: now });
  if (situation === 'exhausted') {
    Object.assign(quota, { light: 'red', redUntil: times.exhaustedUntil, lastError: '额度不足', lastErrorAt: now });
    Object.assign(plan, { exhausted: { at: now, resetAt: now + HOUR, resetFromText: true } });
  }
  if (situation === 'hold') Object.assign(plan, { ownerHoldUntil: times.hold });
  if (situation === 'staff_full') { Object.assign(quota, { light: 'red', redUntil: times.redUntil }); Object.assign(plan, { staffTokens: 700_000 }); }
  if (situation === 'orange') { Object.assign(quota, { light: 'orange' }); Object.assign(plan, { staffTokens: 560_000 }); }
  ctx.store.table('quota').put(quota);
  ctx.store.table('quotaWindows').put(plan);
  return times;
}

/** 闸门表：情形 x 候选类 -> 放行，或拦住的恢复时刻（null 表示没有恢复时刻）。 */
function expectedFor(situation: Situation, category: Category, times: ReturnType<typeof setSituation>): { pass: true } | { until: number | null } {
  switch (situation) {
    case 'auth': return { until: null };
    case 'exhausted': return { until: times.exhaustedUntil };
    case 'hold': return category === 'owner' ? { pass: true } : { until: times.hold };
    case 'staff_full': return category === 'owner' ? { pass: true } : { until: times.redUntil };
    case 'orange': return category === 'chiefDispatch' || category === 'chain' || category === 'owner' ? { pass: true } : { until: times.windowEnd };
    default: return { pass: true };
  }
}

describe('闸门第 7 步：6 种情形 x 5 类候选（每格一例）', () => {
  const cases = SITUATIONS.flatMap(situation => CATEGORIES.map(category => [situation, category] as const));
  it.each(cases)('情形「%s」下，%s', (situation, category) => {
    const w = world();
    const times = setSituation(w, situation);
    const { snapshot, result } = verdictOf(w, entryOf(w, category));
    // 前提：红灯种类和灯由真实代码算出，不是手写的。
    expect(snapshot.redKind).toBe(situation === 'exhausted' ? 'exhausted' : situation === 'staff_full' ? 'staff_full' : null);
    expect(snapshot.quota.light).toBe(situation === 'exhausted' || situation === 'staff_full' ? 'red' : situation === 'orange' ? 'orange' : 'green');
    const expected = expectedFor(situation, category, times);
    if ('pass' in expected) expect(result).toEqual({ pass: true });
    else expect(result).toEqual({ pass: false, by: 'quota', until: expected.until, drop: false });
  });
  it('候选类的名称与情形的名称都写进用例名了（防止表被悄悄改）', () => {
    expect(cases).toHaveLength(30);
    expect(CATEGORIES.map(category => CATEGORY_LABEL[category])).toEqual(['你发起的', '总管派活', '执行链（带 jobId）', '技能类', '员工自己发起的']);
  });
});

describe('三个重点例子', () => {
  it('员工份额用完（红灯 staff_full）时，你发起的回合放行；同一时刻员工自己发起的被拦、恢复时刻是本窗口结束', () => {
    const w = world();
    const times = setSituation(w, 'staff_full');
    expect(verdictOf(w, entryOf(w, 'owner')).result).toEqual({ pass: true });
    expect(verdictOf(w, entryOf(w, 'self')).result).toEqual({ pass: false, by: 'quota', until: times.redUntil, drop: false });
  });

  it('员工份额用完时，执行链被拦；这件事加进 borrowJobIds（用我的额度）之后放行，别的事仍被拦', () => {
    const w = world();
    const times = setSituation(w, 'staff_full');
    expect(verdictOf(w, entryOf(w, 'chain')).result).toEqual({ pass: false, by: 'quota', until: times.redUntil, drop: false });
    setSituation(w, 'staff_full', { borrow: [JOB_ID] });
    expect(verdictOf(w, entryOf(w, 'chain')).result).toEqual({ pass: true });
    expect(verdictOf(w, entryOf(w, 'chain', OTHER_JOB_ID)).result).toEqual({ pass: false, by: 'quota', until: times.redUntil, drop: false });
    // 借用只对带 jobId 的执行链候选有效：总管派活（没有 jobId）、技能类、员工自己发起的仍被拦。
    for (const category of ['chiefDispatch', 'skill', 'self'] as const) {
      expect(verdictOf(w, entryOf(w, category)).result, category).toMatchObject({ pass: false, by: 'quota' });
    }
  });

  it('橙灯时执行链放行、技能类被拦（恢复时刻是本窗口结束）', () => {
    const w = world();
    const times = setSituation(w, 'orange');
    expect(verdictOf(w, entryOf(w, 'chain')).result).toEqual({ pass: true });
    expect(verdictOf(w, entryOf(w, 'skill')).result).toEqual({ pass: false, by: 'quota', until: times.windowEnd, drop: false });
  });

  it('橙灯下紧急的员工自己发起的候选放行（现状）；员工份额用完时同样的紧急候选也被拦', () => {
    const orange = world();
    setSituation(orange, 'orange');
    const urgent = { ...entryOf(orange, 'self'), urgent: true } as QueueEntry;
    expect(verdictOf(orange, urgent).result).toEqual({ pass: true });
    expect(verdictOf(orange, entryOf(orange, 'self')).result).toMatchObject({ pass: false, by: 'quota' });
    const full = world();
    setSituation(full, 'staff_full');
    expect(verdictOf(full, { ...entryOf(full, 'self'), urgent: true } as QueueEntry).result).toMatchObject({ pass: false, by: 'quota' });
  });
});

describe('边界与顺序', () => {
  it('你自己要用：到点（now 等于 ownerHoldUntil）立即恢复，不留一个空窗；差 1 毫秒仍拦', () => {
    const w = world();
    const times = setSituation(w, 'hold');
    expect(verdictOf(w, entryOf(w, 'self')).result).toMatchObject({ pass: false, until: times.hold });
    w.ctx.clock.set(times.hold - 1);
    expect(verdictOf(w, entryOf(w, 'self')).result).toMatchObject({ pass: false, until: times.hold });
    w.ctx.clock.set(times.hold);
    expect(verdictOf(w, entryOf(w, 'self')).result).toEqual({ pass: true });
  });

  it('属于主题对话的候选（topicId）按你发起的处理：你自己要用、员工份额用完时都放行；员工自己发起的同条件被拦', () => {
    for (const situation of ['hold', 'staff_full'] as const) {
      const w = world();
      setSituation(w, situation);
      const topic = { ...entryOf(w, 'self'), ownerInitiated: false, topicId: 'ptp_0000000001' } as QueueEntry;
      expect(verdictOf(w, topic).result, situation).toEqual({ pass: true });
      expect(verdictOf(w, entryOf(w, 'self')).result, situation).toMatchObject({ pass: false, by: 'quota' });
    }
  });

  it('顺序：鉴权失败先于一切；真实额度用完先于你自己要用（你发起的也被拦）；你自己要用先于员工份额用完（恢复时刻取你自己要用的）', () => {
    const auth = world();
    setSituation(auth, 'exhausted');
    raiseAlert(auth.ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true, at: auth.ctx.clock.now() });
    expect(verdictOf(auth, entryOf(auth, 'owner')).result).toEqual({ pass: false, by: 'quota', until: null, drop: false });

    const both = world();
    const times = setSituation(both, 'exhausted');
    both.ctx.store.table('quotaWindows').patch('quota', { ownerHoldUntil: both.ctx.clock.now() + 2 * HOUR });
    expect(verdictOf(both, entryOf(both, 'owner')).result).toEqual({ pass: false, by: 'quota', until: times.exhaustedUntil, drop: false });

    const holdAndFull = world();
    const t2 = setSituation(holdAndFull, 'staff_full');
    holdAndFull.ctx.store.table('quotaWindows').patch('quota', { ownerHoldUntil: holdAndFull.ctx.clock.now() + 2 * HOUR });
    expect(verdictOf(holdAndFull, entryOf(holdAndFull, 'owner')).result).toEqual({ pass: true });
    expect(verdictOf(holdAndFull, entryOf(holdAndFull, 'self')).result).toEqual({ pass: false, by: 'quota', until: holdAndFull.ctx.clock.now() + 2 * HOUR, drop: false });
    expect(t2.redUntil).toBeGreaterThan(holdAndFull.ctx.clock.now() + 2 * HOUR);
  });

  it('探针：真实额度用完、探针已放行时放行一个候选（现状）；没放行时全拦', () => {
    const w = world();
    setSituation(w, 'exhausted');
    expect(verdictOf(w, entryOf(w, 'self')).result).toMatchObject({ pass: false, by: 'quota' });
    w.ctx.store.table('quota').patch('quota', { probeAllowed: true });
    expect(verdictOf(w, entryOf(w, 'self')).result).toEqual({ pass: true });
    expect(verdictOf(w, entryOf(w, 'owner')).result).toEqual({ pass: true });
  });

  it('旧的手写快照没有红灯种类：灯是红色就按真实额度用完处理，连你发起的也拦（升级前的行为）', () => {
    const w = world();
    const entry = entryOf(w, 'owner');
    const now = w.ctx.clock.now();
    const snapshot = buildSnapshot(w.ctx, entry.botId, now);
    const legacy = { ...snapshot, quota: { ...snapshot.quota, light: 'red' as const, redUntil: now + HOUR } };
    delete (legacy as { redKind?: unknown }).redKind;
    delete (legacy as { ownerHoldUntil?: unknown }).ownerHoldUntil;
    delete (legacy as { borrowJobIds?: unknown }).borrowJobIds;
    expect(evaluateGates(entry, legacy, now, w.ctx.settings)).toEqual({ pass: false, by: 'quota', until: now + HOUR, drop: false });
  });

  it('真实调度：员工份额用完时选择器选到你发起的候选，员工自己发起的候选被留在队列里（记评估日志、不丢弃）', () => {
    const w = world();
    setSituation(w, 'staff_full');
    const self = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'percept', score: 0.95, summary: '资料有变化', subjectKey: 'watch:p76d' }))!;
    const owner = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.chief.id, kind: 'owner_message', score: 0.9, summary: '主人发来消息', ownerInitiated: true }))!;
    expect(selectNext(w.ctx, w.ctx.clock.now())?.id).toBe(owner.id);
    expect(w.ctx.store.table('queue').get(self.id)).not.toBeNull();
    // 对照：真实额度用完时，同样的两个候选都选不出来。
    const full = world();
    setSituation(full, 'exhausted');
    enqueue(full.ctx, buildCandidate(full.ctx, { botId: full.chief.id, kind: 'owner_message', score: 0.9, summary: '主人发来消息', ownerInitiated: true }));
    expect(selectNext(full.ctx, full.ctx.clock.now())).toBeNull();
  });
});

describe('恢复后按交付时间排队（设计稿场景 E）', () => {
  /** 一位执行者名下的两件事，各有一条执行链候选；候选的入队顺序与交付时间相反。 */
  function twoJobs(dueA: number | null, dueB: number | null) {
    const w = world();
    const putJob = (id: string, dueAt: number | null) => w.ctx.store.table('jobs').put({ id, dueAt } as never);
    putJob(JOB_ID, dueA); putJob(OTHER_JOB_ID, dueB);
    return w;
  }
  it('同优先级：交付时间早的先放行，不管谁先入队', async () => {
    const { orderByJobDue } = await import('../src/scheduler/select.js');
    const w = twoJobs(Date.parse('2026-11-08T18:00:00+08:00'), Date.parse('2026-11-06T18:00:00+08:00'));
    const first = { ...entryOf(w, 'chain', JOB_ID), id: 'q_0000000001', enqueuedAt: 1 };
    const second = { ...entryOf(w, 'chain', OTHER_JOB_ID), id: 'q_0000000002', enqueuedAt: 2 };
    expect(orderByJobDue(w.ctx, [first, second]).map(row => row.id)).toEqual(['q_0000000002', 'q_0000000001']);
    // 反例：交付时间相同（或都没有）时保持原来的先后；优先级不同时不跨优先级重排。
    const same = twoJobs(100, 100);
    expect(orderByJobDue(same.ctx, [first, second]).map(row => row.id)).toEqual(['q_0000000001', 'q_0000000002']);
    expect(orderByJobDue(w.ctx, [{ ...first, priority: 5 }, { ...second, priority: 1 }]).map(row => row.id)).toEqual(['q_0000000001', 'q_0000000002']);
  });
  it('没有交付时间的排在最后；不带 jobId 的候选位置不动', async () => {
    const { orderByJobDue } = await import('../src/scheduler/select.js');
    const w = twoJobs(null, Date.parse('2026-11-06T18:00:00+08:00'));
    // 三条候选取同一个优先级（真实队列已经按优先级排好，同一优先级里才比较交付时间）。
    const noDue = { ...entryOf(w, 'chain', JOB_ID), id: 'q_0000000001', enqueuedAt: 1, priority: 1 };
    const plain = { ...entryOf(w, 'self'), id: 'q_0000000002', enqueuedAt: 2, priority: 1 };
    const due = { ...entryOf(w, 'chain', OTHER_JOB_ID), id: 'q_0000000003', enqueuedAt: 3, priority: 1 };
    expect(orderByJobDue(w.ctx, [noDue, plain, due]).map(row => row.id)).toEqual(['q_0000000003', 'q_0000000002', 'q_0000000001']);
  });
  it('真实调度：额度恢复后两件事的执行链候选都能放行时，先选交付时间早的那件', () => {
    const w = twoJobs(Date.parse('2026-11-08T18:00:00+08:00'), Date.parse('2026-11-06T18:00:00+08:00'));
    // 两件事都是进行中、执行者是同一位，候选各自入队；用真实选择器（真实闸门）。
    for (const id of [JOB_ID, OTHER_JOB_ID]) {
      w.ctx.store.table('jobs').put({ ...(w.ctx.store.table('jobs').get(id) as object), id, state: 'doing', launch: { state: 'none' },
        chiefId: w.chief.id, executorId: w.executor.id, reviewerId: null, participants: [w.executor.id, w.chief.id], turnCap: 16, turnsUsed: 1, agreementId: 'agr_0000000001' } as never);
    }
    const late = { ...entryOf(w, 'chain', JOB_ID), id: 'q_0000000001', enqueuedAt: w.ctx.clock.now() - 2 * MINUTE };
    const early = { ...entryOf(w, 'chain', OTHER_JOB_ID), id: 'q_0000000002', enqueuedAt: w.ctx.clock.now() - MINUTE };
    w.ctx.store.table('queue').put(late); w.ctx.store.table('queue').put(early);
    // 选择器放行第一个通过闸门的候选；入队更早的是交付晚的那条，没有排序时会选它。两条的闸门条件相同，所以选中谁完全由排序决定。
    expect(selectNext(w.ctx, w.ctx.clock.now())?.id).toBe('q_0000000002');
    // 对照：交付时间改成相反，选中的跟着变。
    w.ctx.store.table('jobs').patch(JOB_ID, { dueAt: Date.parse('2026-11-05T18:00:00+08:00') });
    expect(selectNext(w.ctx, w.ctx.clock.now())?.id).toBe('q_0000000001');
  });
});
