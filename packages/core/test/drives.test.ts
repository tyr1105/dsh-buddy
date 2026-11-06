/** 内驱规则验收：每种理由都有触发与反例，并用假时钟核对每日名额与跨日暂缓。 */
import { describe, expect, it } from 'vitest';
import { computeDrives } from '../src/drives/compute.js';
import { evaluateDrives } from '../src/drives/evaluate.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { AgendaItemSchema, CommitSchema, HandoffSchema, InboxItemSchema } from '../src/model/index.js';
import type { AgendaItem, Commit, Goal, Handoff, InboxItem } from '../src/model/index.js';
import { botFixture, goalFixture, modelFixtures } from './model-fixtures.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-11-05T10:00:00+08:00');
const goal = (patch: Partial<Goal> = {}): Goal => ({ ...goalFixture, patienceMs: HOUR, lastProgressAt: now - HOUR - 1, ...patch });
const agenda = (patch: Partial<AgendaItem> = {}): AgendaItem => ({ ...AgendaItemSchema.parse(modelFixtures.AgendaItem.valid), toOwner: true, dueAt: now + HOUR, ...patch });
const inbox = (patch: Partial<InboxItem> = {}): InboxItem => ({ ...InboxItemSchema.parse(modelFixtures.InboxItem.valid), createdAt: now - 72 * HOUR,
  status: 'expired', defaultOption: '停止', answer: '停止', answeredAt: now, ...patch });
const handoff = (patch: Partial<Handoff> = {}): Handoff => ({ ...HandoffSchema.parse(modelFixtures.Handoff.valid), createdAt: now - 2 * HOUR, ...patch });
const blocked = (patch: Partial<Commit> = {}): Commit[] => [0, 1, 2].map(index => ({ ...CommitSchema.parse(modelFixtures.Commit.valid),
  id: `c_${String(index).padStart(10, '0')}`, outcome: 'blocked', blocker: '上游没有资料', createdAt: now - index, ...patch }));
const calculate = (input: { goals?: Goal[]; agenda?: AgendaItem[]; inbox?: InboxItem[]; handoffs?: Handoff[]; commits?: Commit[]; ratio?: number } = {}) =>
  computeDrives(botFixture, input.goals ?? [], input.agenda ?? [], input.inbox ?? [], input.handoffs ?? [], input.commits ?? [], input.ratio ?? 0, now);

describe('纯内驱分数', () => {
  it('没有事实时全部内驱为零', () => expect(calculate()).toEqual({ stagnation: 0, obligation: 0, waiting: 0, frustration: 0, fatigue: 0 }));
  it('刚超过耐心期触发停滞 0.65', () => expect(calculate({ goals: [goal()] }).stagnation).toBe(0.65));
  it('恰好耐心期不触发停滞', () => expect(calculate({ goals: [goal({ lastProgressAt: now - HOUR })] }).stagnation).toBe(0));
  it('超过整段耐心期才加一档', () => expect(calculate({ goals: [goal({ lastProgressAt: now - 2 * HOUR })] }).stagnation).toBe(0.75));
  it('停滞封顶 0.9', () => expect(calculate({ goals: [goal({ lastProgressAt: now - 10 * HOUR })] }).stagnation).toBe(0.9));
  it('非 active 目标不触发', () => expect(calculate({ goals: [goal({ status: 'blocked' })] }).stagnation).toBe(0));
  it('其他机器人的停滞不混入', () => expect(calculate({ goals: [goal({ botId: 'other' })] }).stagnation).toBe(0));
  it('多个目标取最强停滞分', () => expect(calculate({ goals: [goal(), goal({ lastProgressAt: now - 3 * HOUR })] }).stagnation).toBeCloseTo(0.85));
  it('两小时内承诺触发 0.8', () => expect(calculate({ agenda: [agenda({ dueAt: now + 2 * HOUR })] }).obligation).toBe(0.8));
  it('两小时之外承诺不触发', () => expect(calculate({ agenda: [agenda({ dueAt: now + 2 * HOUR + 1 })] }).obligation).toBe(0));
  it('到期承诺触发 0.95', () => expect(calculate({ agenda: [agenda({ dueAt: now })] }).obligation).toBe(0.95));
  it.each([{ toOwner: false }, { status: 'done' as const }, { dueAt: null }, { botId: 'other' }])('非有效承诺不触发 %o', patch => {
    expect(calculate({ agenda: [agenda(patch)] }).obligation).toBe(0);
  });
  it('已经按默认处理的过期问题触发等人 0.75', () => expect(calculate({ inbox: [inbox()] }).waiting).toBe(0.75));
  it.each([{ status: 'open' as const }, { answer: null }, { answeredAt: null }, { createdAt: now - 71 * HOUR }, { botId: 'other' }])('未默认处理的问题不触发 %o', patch => {
    expect(calculate({ inbox: [inbox(patch)] }).waiting).toBe(0);
  });
  it('默认处理后已有交账不重复唤醒', () => expect(calculate({ inbox: [inbox({ answeredAt: now - HOUR })], commits: blocked() }).waiting).toBe(0));
  it('交接等满两小时触发 0.7', () => expect(calculate({ handoffs: [handoff()] }).waiting).toBe(0.7));
  it.each([{ status: 'accepted' as const }, { createdAt: now - 2 * HOUR + 1 }, { from: 'other' }])('交接尚未超时或已接受不触发 %o', patch => {
    expect(calculate({ handoffs: [handoff(patch)] }).waiting).toBe(0);
  });
  it('同一阻碍连续三次触发受挫 0.8', () => expect(calculate({ commits: blocked() }).frustration).toBe(0.8));
  it('受挫按时间倒序计算而非数组位置', () => expect(calculate({ commits: blocked().reverse() }).frustration).toBe(0.8));
  it('只有两次受阻不触发', () => expect(calculate({ commits: blocked().slice(0, 2) }).frustration).toBe(0));
  it('阻碍指纹不同不触发', () => {
    const commits = blocked(); commits[0]!.blocker = '网络故障';
    expect(calculate({ commits }).frustration).toBe(0);
  });
  it('最新一条 progress 打断连续受阻', () => {
    const commits = blocked(); commits[0]!.outcome = 'progress';
    expect(calculate({ commits }).frustration).toBe(0);
  });
  it('空阻碍不冒充相同受阻事实', () => expect(calculate({ commits: blocked({ blocker: null }) }).frustration).toBe(0));
  it.each([[0, 0], [0.5, 0.5], [2, 1], [-1, 0]])('疲劳比例 %s 转为 %s', (ratio, expected) => expect(calculate({ ratio }).fatigue).toBe(expected));
  it('疲劳非有限数值给出中文错误', () => expect(() => calculate({ ratio: NaN })).toThrow('预算比例'));
  it('纯函数接受显式设置覆盖', () => {
    const settings = resolveSettings({ c02: { stagnationBase: 0.7 } });
    expect(computeDrives(botFixture, [goal()], [], [], [], [], 0, now, settings).stagnation).toBe(0.7);
  });
});

function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put(botFixture);
  return ctx;
}

describe('内驱触发与暂缓', () => {
  it('停滞候选包含目标证据与可读理由', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal());
    const candidates = evaluateDrives(ctx, now);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ subjectKey: `drive:stagnation:${goalFixture.id}`, variant: 'regular', reason: { kind: 'drive', evidence: [goalFixture.id] } });
    expect(candidates[0]!.reason.summary).toContain('复盘或换方法');
    expect(ctx.store.table('drives').get(botFixture.id)).toMatchObject({ firedToday: 1, snoozedUntil: { stagnation: now + DAY } });
  });
  it('承诺内驱单独生成候选', () => {
    const ctx = setup(); ctx.store.table('agenda').put(agenda());
    expect(evaluateDrives(ctx, now)[0]?.subjectKey).toBe('drive:obligation');
  });
  it('等人内驱单独生成候选', () => {
    const ctx = setup(); ctx.store.table('handoffs').put(handoff());
    expect(evaluateDrives(ctx, now)[0]?.subjectKey).toBe('drive:waiting');
  });
  it('受挫候选要求换方法并保留三条交账证据', () => {
    const ctx = setup(); blocked().forEach(commit => ctx.store.table('commits').put(commit));
    const candidate = evaluateDrives(ctx, now)[0]!;
    expect(candidate.reason.evidence).toHaveLength(3);
    expect(candidate.reason.summary).toContain('不要再重试同一做法');
  });
  it('四种同时满足每天只触发最高两种', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal()); ctx.store.table('agenda').put(agenda({ dueAt: now - 1 }));
    ctx.store.table('handoffs').put(handoff()); blocked().forEach(commit => ctx.store.table('commits').put(commit));
    expect(evaluateDrives(ctx, now).map(item => item.reason.score)).toEqual([0.95, 0.8]);
    expect(evaluateDrives(ctx, now + HOUR)).toEqual([]);
    expect(ctx.store.table('drives').get(botFixture.id)?.firedToday).toBe(2);
  });
  it('同种内驱当天不能重复触发', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal());
    evaluateDrives(ctx, now);
    expect(evaluateDrives(ctx, now + HOUR)).toEqual([]);
  });
  it('跨午夜重置次数但保留不足24小时的暂缓', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal()); evaluateDrives(ctx, now);
    expect(evaluateDrives(ctx, now + 15 * HOUR)).toEqual([]);
    expect(ctx.store.table('drives').get(botFixture.id)?.firedToday).toBe(0);
  });
  it('24小时暂缓到点后可再次触发', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal()); evaluateDrives(ctx, now);
    expect(evaluateDrives(ctx, now + DAY)).toHaveLength(1);
  });
  it('高疲劳使低分内驱不消耗次数', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal());
    for (let i = 0; i < 6; i += 1) ctx.store.log('ledger').append({ id: `le_${String(i).padStart(10, '0')}`, who: botFixture.id, wakeId: null, kind: 'turn', tokens: 1, at: now });
    expect(evaluateDrives(ctx, now)).toEqual([]);
    expect(ctx.store.table('drives').get(botFixture.id)).toMatchObject({ fatigue: 1, firedToday: 0 });
  });
  it('progress 清零快照但保留防打扰名额', () => {
    const ctx = setup(); ctx.store.table('goals').put(goal()); evaluateDrives(ctx, now);
    ctx.store.table('commits').put({ ...blocked()[0]!, outcome: 'progress', createdAt: now + 1 });
    expect(evaluateDrives(ctx, now + 1)).toEqual([]);
    expect(ctx.store.table('drives').get(botFixture.id)).toMatchObject({ stagnation: 0, obligation: 0, waiting: 0, frustration: 0, firedToday: 1 });
  });
  it.each(['draft', 'paused', 'quarantined', 'retired'] as const)('%s 机器人不生成内驱', lifecycle => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { lifecycle }); ctx.store.table('goals').put(goal());
    expect(evaluateDrives(ctx, now)).toEqual([]);
  });
  it('不同机器人分别计算每日名额', () => {
    const ctx = setup(); const second = { ...botFixture, id: 'b_0000000002' };
    ctx.store.table('bots').put(second); ctx.store.table('goals').put(goal());
    ctx.store.table('goals').put(goal({ id: 'g_0000000002', botId: second.id }));
    expect(evaluateDrives(ctx, now)).toHaveLength(2);
    expect(ctx.store.table('drives').list().map(item => item.firedToday)).toEqual([1, 1]);
  });
});
