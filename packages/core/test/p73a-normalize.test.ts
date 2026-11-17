/**
 * P73a 启动整理验收：试岗、草稿转在岗，暂停资格改在岗，已退役补归档时间，执行类统一听吩咐；
 * 幂等、不产生消息和队列条目、不改变闸门放行结果、旧存档兼容。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { normalizeStaffStatus } from '../src/team/normalize-status.js';
import { FileStore } from '../src/store/file-store.js';
import { createBotHome, initRoot } from '../src/memory/files.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue, removeEntry } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { botFixture } from './model-fixtures.js';
import type { Bot } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';

const hour = 3_600_000;
const day = 24 * hour;

/** 造一位员工档案：id 和名字不同，其余沿用夹具。 */
function bot(index: number, patch: Partial<Bot>): Bot {
  const id = `b_p73a${String(index).padStart(6, '0')}`;
  return { ...botFixture, id, name: `员工${index}`, homeDir: `/hub/bots/${id}`, ...patch };
}

/** 整理场景：七位员工，覆盖任务卡 5.2 第 7 条列出的每一种。 */
function world() {
  const ctx = createTestContext();
  const rows = {
    probation: bot(1, { role: 'sentinel', lifecycle: 'probation', autonomy: 'L3', onDemand: false, probationEndsAt: ctx.clock.now() + day }),
    draft: bot(2, { role: 'sentinel', lifecycle: 'draft', onDemand: false }),
    paused: bot(3, { role: 'sentinel', lifecycle: 'paused', pausedFrom: 'probation', onDemand: false, probationEndsAt: ctx.clock.now() + day }),
    retired: bot(4, { role: 'sentinel', lifecycle: 'retired', archivedAt: null, updatedAt: 12345 }),
    executor: bot(5, { role: 'executor', lifecycle: 'active', onDemand: false, autonomy: 'L2', pace: 'normal' }),
    sentinel: bot(6, { role: 'sentinel', lifecycle: 'active', onDemand: false, autonomy: 'L2', pace: 'normal' }),
    chief: bot(7, { role: 'chief', lifecycle: 'active', onDemand: false, autonomy: 'L1', pace: 'normal' }),
  };
  for (const row of Object.values(rows)) ctx.store.table('bots').put(row);
  ctx.runtime.startedAt -= hour;
  return { ctx, rows };
}

/** 对一位员工排一个主人消息候选，返回闸门是否放行，再把候选移出队列不留痕迹。 */
function gatePass(ctx: HubContext, botId: string): boolean {
  const entry = enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
    summary: '主人发来一条消息', evidence: [], ownerInitiated: true }));
  if (!entry) return false;
  const now = ctx.clock.now();
  const result = evaluateGates(entry, buildSnapshot(ctx, botId, now), now, ctx.settings);
  removeEntry(ctx, entry.id);
  return result.pass;
}

describe('P73a normalizeStaffStatus', () => {
  it('七种员工整理后的结果符合任务卡', async () => {
    const { ctx, rows } = world();
    const result = await normalizeStaffStatus(ctx);
    // 草稿、试岗、暂停（资格试岗）、退役无归档时间、执行类共五位有改动；值守类在岗与总管不变。
    expect(result.changed).toBe(5);
    const get = (id: string) => ctx.store.table('bots').get(id)!;
    expect(get(rows.probation.id)).toMatchObject({ lifecycle: 'active', probationEndsAt: null, autonomy: 'L2' });
    expect(get(rows.draft.id).lifecycle).toBe('active');
    expect(await ctx.fs.readText(`${rows.draft.homeDir}/AGENTS.md`)).not.toBeNull();
    expect(get(rows.paused.id)).toMatchObject({ lifecycle: 'paused', pausedFrom: 'active', probationEndsAt: null });
    expect(get(rows.retired.id)).toMatchObject({ lifecycle: 'retired', archivedAt: 12345 });
    expect(get(rows.executor.id)).toMatchObject({ onDemand: true, autonomy: 'L1', pace: 'quiet' });
    expect(get(rows.sentinel.id)).toEqual(rows.sentinel);
    expect(get(rows.chief.id)).toEqual(rows.chief);
  });

  it('第二次运行 changed 为 0，审计条数不增加', async () => {
    const { ctx } = world();
    await normalizeStaffStatus(ctx);
    const audits = () => ctx.store.log('audit').all().filter(row => row.action === 'staff_status_normalize');
    expect(audits()).toHaveLength(5);
    const detail = JSON.parse(audits()[0]!.detail);
    expect(detail).toMatchObject({ before: expect.objectContaining({ lifecycle: expect.any(String) }), after: expect.objectContaining({ lifecycle: expect.any(String) }) });
    expect(audits().every(row => row.actor === 'hub')).toBe(true);
    expect(await normalizeStaffStatus(ctx)).toEqual({ changed: 0 });
    expect(audits()).toHaveLength(5);
  });

  it('整理不产生线程消息和队列条目，也不改 activity', async () => {
    const { ctx, rows } = world();
    const activities = Object.fromEntries(Object.values(rows).map(row => [row.id, row.activity]));
    await normalizeStaffStatus(ctx);
    expect(ctx.store.log('thread').all()).toHaveLength(0);
    expect(ctx.store.table('queue').count()).toBe(0);
    for (const row of ctx.store.table('bots').list()) expect(row.activity).toBe(activities[row.id]);
  });

  it('整理前后，每位在岗员工的主人消息候选闸门放行结果相同', async () => {
    const { ctx, rows } = world();
    const onDuty = [rows.probation, rows.executor, rows.sentinel, rows.chief];
    const before = onDuty.map(row => gatePass(ctx, row.id));
    await normalizeStaffStatus(ctx);
    const after = onDuty.map(row => gatePass(ctx, row.id));
    expect(after).toEqual(before);
    expect(after.every(Boolean)).toBe(true);
  });

  it('反例：已归档的执行类员工不被改成听吩咐', async () => {
    const ctx = createTestContext();
    const archived = bot(9, { role: 'executor', lifecycle: 'retired', archivedAt: 777, onDemand: false, autonomy: 'L2', pace: 'normal' });
    ctx.store.table('bots').put(archived);
    expect(await normalizeStaffStatus(ctx)).toEqual({ changed: 0 });
    expect(ctx.store.table('bots').get(archived.id)).toEqual(archived);
  });

  it('旧存档兼容：只含旧字段、lifecycle 为 probation 的 bots 记录，Hub 启动后读出并整理为 active', async () => {
    const base = createTestContext();
    const store = new FileStore(base.fs, base.clock, base.settings.rootDir, base.settings.timezone, base.logger);
    const ctx = createTestContext({ store, fs: base.fs, clock: base.clock });
    await initRoot(ctx);
    // 旧档案：去掉所有后来新增的可缺省字段，lifecycle 为 probation。
    const legacy: Record<string, unknown> = { ...bot(1, { role: 'researcher', lifecycle: 'probation', probationEndsAt: base.clock.now() + day }) };
    for (const key of ['onDemand', 'archivedAt', 'pausedFrom', 'probationStartedAt', 'brief', 'temperament', 'speechStyle', 'dshSkillNames', 'presetSkillIds', 'workDataAllowed', 'releasedAt'])
      delete legacy[key];
    await base.fs.writeTextAtomic('/hub/.hub/state/bots.json', JSON.stringify([legacy]), { within: '/hub' });
    await store.load();
    const loaded = store.table('bots').list()[0]!;
    expect(loaded).toMatchObject({ lifecycle: 'probation', onDemand: false });
    await createBotHome(ctx, loaded);
    await store.flush(); // hub.start 会重新 load，存储里不能有未落盘的更改
    const hub = createHub(ctx);
    await hub.start();
    expect(store.table('bots').get(loaded.id)).toMatchObject({ lifecycle: 'active', probationEndsAt: null, onDemand: true, autonomy: 'L1', pace: 'quiet' });
    await hub.stop();
  });
});
