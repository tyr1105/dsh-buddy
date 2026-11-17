/**
 * P76r2 第 4 节的测试（R5）：员工份额用完（红灯）期间，主人改了留给员工的比例。
 * 以前：存着的灯不重算；闸门的快照用新设置反推红灯种类，把员工份额的红灯当成真实额度用完，主人自己的消息也被拦到窗口结束。
 * 现在：界面改设置的入口（api.updateSettings）改了员工份额比例或灯的三档比例时按新设置重算灯并保存，由红变不红时恢复被额度挡住的员工；
 *   快照里红灯的种类按额度记录判断（有「真实额度用完」标记，或探针在途，才是真实额度用完），不再反推。
 *
 * 夹具：容量 100 万、员工已用 70 万（员工份额比例 0.7 时正好用完，红灯、员工份额用完）；员工是 researcher；灯三档比例为默认（黄 0.5、橙 0.8、红 1）。
 * 两条候选：主人发给员工的消息（主人发起）、员工自己的一次思考；用真实快照和真实闸门判断，不靠额度灯碰巧放行或拦下。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import type { HubContext } from '../src/engine/context.js';
import type { QueueEntry } from '../src/model/index.js';
import { createBotHome } from '../src/memory/files.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { defaultQuotaPlan, getQuotaPlan } from '../src/quota/plan.js';
import { maybeAllowProbe } from '../src/quota/window.js';
import { botFixture } from './model-fixtures.js';

const MINUTE = 60_000;
const CAPACITY = 1_000_000;
const STAFF_USED = 700_000;

async function setup(kind: 'staff_full' | 'exhausted') {
  const ctx = createTestContext();
  const bot = { ...botFixture, lifecycle: 'active' as const };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const hub = createHub(ctx);
  await hub.start();
  const now = ctx.clock.now();
  ctx.runtime.startedAt = now - 10 * MINUTE;
  const windowEnd = now + ctx.settings.quotaWindowMs;
  ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now), capacityTokens: CAPACITY, capacitySource: 'calibrated', staffTokens: STAFF_USED,
    ...(kind === 'exhausted' ? { exhausted: { at: now, resetAt: windowEnd - ctx.settings.quotaResetGraceMs, resetFromText: false } } : {}) });
  ctx.store.table('quota').put({ id: 'quota', windowStartAt: now, botTurns: 3, botTokens: STAFF_USED, turnLimit: 40, tokenLimit: null, light: 'red',
    redUntil: kind === 'exhausted' ? windowEnd + ctx.settings.quotaResetGraceMs : windowEnd, probeAllowed: false, lastError: null, lastErrorAt: null });
  // 这位员工因额度在休息（红灯时中心让他休息）；恢复时应放回原来的状态。
  ctx.store.table('bots').patch(bot.id, { activity: 'resting', activityText: '在等额度恢复，约 15:00 继续',
    quotaRest: { activity: 'watching', activityText: '正在关注公开信息' } });
  return { ctx, hub, botId: bot.id };
}
type World = Awaited<ReturnType<typeof setup>>;

/** 主人发给员工的消息（主人发起）。 */
function ownerEntry(ctx: HubContext, botId: string): QueueEntry {
  return { ...buildCandidate(ctx, { botId, kind: 'owner_message', score: 1, summary: '看一下进展', evidence: [], ownerInitiated: true }), id: 'q_0000000001', enqueuedAt: ctx.clock.now() };
}
/** 员工自己的一次思考（不是主人发起、不是任何别人交代的事）。 */
function selfEntry(ctx: HubContext, botId: string): QueueEntry {
  return { ...buildCandidate(ctx, { botId, kind: 'next_think', score: 0.9, summary: '自己想一想', evidence: [] }), id: 'q_0000000002', enqueuedAt: ctx.clock.now() };
}
const gate = (ctx: HubContext, entry: QueueEntry) => {
  const now = ctx.clock.now();
  return evaluateGates(entry, buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey), now, ctx.settings);
};
const snapshot = (w: World) => buildSnapshot(w.ctx, w.botId, w.ctx.clock.now());
const light = (w: World) => w.ctx.store.table('quota').get('quota')!;

describe('4 员工份额用完时改份额比例', () => {
  it('前提：比例 0.7 时是红灯、员工份额用完；主人的消息放行，员工自己的思考被拦到窗口结束', async () => {
    const w = await setup('staff_full');
    expect(light(w)).toMatchObject({ light: 'red' });
    expect(snapshot(w).redKind).toBe('staff_full');
    expect(gate(w.ctx, ownerEntry(w.ctx, w.botId))).toEqual({ pass: true });
    expect(gate(w.ctx, selfEntry(w.ctx, w.botId))).toMatchObject({ pass: false, by: 'quota', until: light(w).redUntil });
  });

  it('调到 0.9：灯按数字重算（不再是红灯）；主人的消息放行；被挡住的员工恢复', async () => {
    const w = await setup('staff_full');
    expect(await w.hub.api.updateSettings({ botQuotaShare: 0.9 })).toMatchObject({ ok: true });
    // 员工已用 70 万，份额变成 90 万，比例约 0.78：达到黄线、没到橙线。
    expect(light(w)).toMatchObject({ light: 'yellow', redUntil: null });
    expect(snapshot(w).redKind).toBeNull();
    expect(gate(w.ctx, ownerEntry(w.ctx, w.botId))).toEqual({ pass: true });
    expect(w.ctx.store.table('bots').get(w.botId)).toMatchObject({ activity: 'watching', activityText: '正在关注公开信息', quotaRest: null });
    // 员工自己的思考也不再因为额度被拦（这里只证明额度这一步放行：不是 quota）。
    const self = gate(w.ctx, selfEntry(w.ctx, w.botId));
    expect(self.pass || self.by).not.toBe('quota');
  });

  it('调到 0.5：仍是员工份额用完（份额 50 万、已用 70 万）；主人的消息仍放行；员工自己的仍被拦', async () => {
    const w = await setup('staff_full');
    expect(await w.hub.api.updateSettings({ botQuotaShare: 0.5 })).toMatchObject({ ok: true });
    expect(light(w)).toMatchObject({ light: 'red' });
    expect(snapshot(w).redKind).toBe('staff_full');
    expect(gate(w.ctx, ownerEntry(w.ctx, w.botId))).toEqual({ pass: true });
    expect(gate(w.ctx, selfEntry(w.ctx, w.botId))).toMatchObject({ pass: false, by: 'quota' });
    expect(w.ctx.store.table('bots').get(w.botId)).toMatchObject({ activity: 'resting' });
  });

  it('改的是灯的比例也重算：员工已用 60 万、份额 70 万（比例约 0.86，橙灯）；把橙线调到 0.9，灯变黄；把红线调到 0.8，灯变红、员工休息', async () => {
    const w = await setup('staff_full');
    // 改成橙灯的起点：员工已用 60 万，存着的灯是橙灯，员工没有在休息。
    w.ctx.store.table('quotaWindows').patch('quota', { staffTokens: 600_000 });
    w.ctx.store.table('quota').patch('quota', { light: 'orange', redUntil: null });
    w.ctx.store.table('bots').patch(w.botId, { activity: 'watching', activityText: '正在关注公开信息', quotaRest: null });
    expect(await w.hub.api.updateSettings({ quotaOrangeRatio: 0.9 })).toMatchObject({ ok: true });
    expect(light(w)).toMatchObject({ light: 'yellow' });
    expect(await w.hub.api.updateSettings({ quotaRedRatio: 0.8, quotaOrangeRatio: 0.7 })).toMatchObject({ ok: true });
    expect(light(w)).toMatchObject({ light: 'red', redUntil: light(w).windowStartAt + w.ctx.settings.quotaWindowMs });
    expect(snapshot(w).redKind).toBe('staff_full');
    expect(w.ctx.store.table('bots').get(w.botId)).toMatchObject({ activity: 'resting' });
  });

  it('反例：改的不是额度相关的设置：灯和员工状态都不动', async () => {
    const w = await setup('staff_full');
    const before = { quota: light(w), bot: w.ctx.store.table('bots').get(w.botId) };
    expect(await w.hub.api.updateSettings({ botDailyTurnBudget: 3 })).toMatchObject({ ok: true });
    expect(light(w)).toEqual(before.quota);
    expect(w.ctx.store.table('bots').get(w.botId)).toMatchObject({ activity: 'resting' });
  });
});

describe('4 快照里红灯的种类按额度记录判断，不靠重算反推', () => {
  it('员工份额的红灯，设置被直接改成 0.9 而灯没有重算（旧存档、别的入口）：种类仍是员工份额用完，主人的消息放行', async () => {
    const w = await setup('staff_full');
    w.ctx.settings = { ...w.ctx.settings, botQuotaShare: 0.9 };
    expect(light(w).light).toBe('red');
    expect(snapshot(w).redKind).toBe('staff_full');
    expect(gate(w.ctx, ownerEntry(w.ctx, w.botId))).toEqual({ pass: true });
  });

  it('真实额度用完时改这些设置：仍是真实额度用完，灯仍是红，主人的消息也拦；探针的规则不变（恢复时刻才放探针）', async () => {
    const w = await setup('exhausted');
    expect(snapshot(w).redKind).toBe('exhausted');
    expect(await w.hub.api.updateSettings({ botQuotaShare: 0.9 })).toMatchObject({ ok: true });
    expect(light(w)).toMatchObject({ light: 'red' });
    expect(getQuotaPlan(w.ctx, w.ctx.clock.now()).exhausted).not.toBeNull();
    expect(snapshot(w).redKind).toBe('exhausted');
    expect(gate(w.ctx, ownerEntry(w.ctx, w.botId))).toMatchObject({ pass: false, by: 'quota', until: light(w).redUntil });
    // 探针：恢复时刻之前不放；到恢复时刻放一个。
    expect(maybeAllowProbe(w.ctx, w.ctx.clock.now())).toBe(false);
    w.ctx.clock.set(light(w).redUntil!);
    expect(maybeAllowProbe(w.ctx, w.ctx.clock.now())).toBe(true);
    expect(w.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeAllowed: true });
  });
});
