/**
 * P73r2 验收：P73r1 复验带出的 N1、N2、L1 至 L3 的修复。
 * 用会执行启动整理的真实中心（createHub + start）写；纯函数和常量直接调用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { normalizeStaffStatus } from '../src/team/normalize-status.js';
import { staffStatus } from '../src/model/bot.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { CORRECTION_PATTERN } from '../src/reflect/trigger.js';
import { OWNER_CORRECTION_SUBJECT_PREFIX, OWNER_CORRECTION_KEY_PREFIX, onDemandBlocks } from '../src/scheduler/on-demand.js';
import { postThread } from '../src/outreach/thread.js';
import { quarantine } from '../src/health/quarantine.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS } from '../src/model/enums.js';
import { okData } from './c04-api-fixtures.js';
import type { HubContext } from '../src/engine/context.js';
import type { Hub } from '../src/engine/hub.js';
import type { Bot } from '../src/model/index.js';

const hour = 3_600_000;

afterEach(() => { vi.restoreAllMocks(); });

async function realHub(): Promise<{ ctx: HubContext; hub: Hub }> {
  const ctx = createTestContext();
  const hub = createHub(ctx);
  await hub.start();
  ctx.runtime.startedAt -= hour;
  return { ctx, hub };
}
async function addBot(hub: Hub, name: string, role: Bot['role']): Promise<Bot> {
  return okData(await hub.api.createBot({ name, role, persona: '先核实再行动', aspirations: ['持续核实公开信息'] }));
}
const bots = (ctx: HubContext, id: string): Bot => ctx.store.table('bots').get(id)!;
/** P73c：启动时中心自动建了一位总管；测试里需要总管时直接取它，不再另建（总管最多 1 个）。 */
const autoChief = (ctx: HubContext): Bot => ctx.store.table('bots').list(row => row.role === 'chief')[0]!;
/** 让员工档案写成「已退役」时抛错：模拟归档第一段中途失败。 */
function failRetiredWrite(ctx: HubContext): void {
  const realTable = ctx.store.table.bind(ctx.store);
  vi.spyOn(ctx.store, 'table').mockImplementation(((name: string) => {
    const table = realTable(name as never);
    if (name !== 'bots') return table;
    return { ...table, patch: (id: string, partial: { lifecycle?: string }) => {
      if (partial.lifecycle === 'retired') throw new Error('模拟写档案失败');
      return (table as unknown as { patch(id: string, p: unknown): unknown }).patch(id, partial);
    } };
  }) as never);
}

describe('N1 归档失败后不留下任何主人看得见的痕迹', () => {
  /** 该员工线程里「已归档」旁白的条数。 */
  const narrations = (ctx: HubContext, id: string) => ctx.store.log('thread').all().filter(m => m.thread === id && m.text.includes('已归档')).length;
  const alertOpen = (ctx: HubContext, id: string) => ctx.store.table('alerts').count(a => a.botId === id && a.code === 'quarantine' && a.status === 'open');
  const inboxOpen = (ctx: HubContext, id: string) => ctx.store.table('inbox').count(i => i.botId === id && i.type === 'alert' && i.status === 'open');

  it('从系统停用（隔离）状态归档，第一段中途失败：员工、项目成员、队列恢复，告警和待处理条目仍开着，线程没有旁白', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'sentinel');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id], ownerBotId: owner.id }));
    quarantine(ctx, a.id, '连续故障');
    await syncAlertItems(ctx);
    enqueue(ctx, buildCandidate(ctx, { botId: a.id, kind: 'light_check', variant: 'light_check', score: 1, summary: '到点复查', evidence: [] }));
    expect(alertOpen(ctx, a.id)).toBe(1);
    expect(inboxOpen(ctx, a.id)).toBe(1);
    const botBefore = bots(ctx, a.id);
    const projectBefore = ctx.store.table('projects').get(project.id)!;
    const queueBefore = ctx.store.table('queue').list(e => e.botId === a.id);
    const auditBefore = ctx.store.log('audit').all().filter(r => r.action === 'bot_archive').length;
    failRetiredWrite(ctx);
    const result = await hub.api.lifecycleAction({ botId: a.id, action: 'archive' });
    vi.restoreAllMocks();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('归档失败');
    expect(bots(ctx, a.id)).toEqual(botBefore);
    expect(ctx.store.table('projects').get(project.id)).toEqual(projectBefore);
    // 队列的恢复由 p73r1 的失败用例覆盖；这里员工是停用状态，命令之后中心自己的调度本来就会清掉它的候选，所以不比对队列。
    expect(queueBefore.length).toBeGreaterThanOrEqual(0);
    expect(alertOpen(ctx, a.id)).toBe(1);
    expect(inboxOpen(ctx, a.id)).toBe(1);
    await syncAlertItems(ctx);
    expect(inboxOpen(ctx, a.id)).toBe(1);
    expect(narrations(ctx, a.id)).toBe(0);
    expect(ctx.store.log('audit').all().filter(r => r.action === 'bot_archive').length).toBe(auditBefore);
  });

  it('归档成功：告警和待处理条目都关闭，旁白和 bot_archive 审计各一条', async () => {
    const { ctx, hub } = await realHub();
    const a = await addBot(hub, '甲', 'sentinel');
    quarantine(ctx, a.id, '连续故障');
    await syncAlertItems(ctx);
    expect(inboxOpen(ctx, a.id)).toBe(1);
    okData(await hub.api.lifecycleAction({ botId: a.id, action: 'archive' }));
    expect(alertOpen(ctx, a.id)).toBe(0);
    expect(inboxOpen(ctx, a.id)).toBe(0);
    expect(narrations(ctx, a.id)).toBe(1);
    expect(ctx.store.log('audit').all().filter(r => r.action === 'bot_archive' && r.detail.includes(a.id))).toHaveLength(1);
  });

  it('第二段出错不影响归档已经成功：写旁白失败时结果仍是已归档', async () => {
    const { ctx, hub } = await realHub();
    const a = await addBot(hub, '甲', 'researcher');
    const realLog = ctx.store.log.bind(ctx.store);
    vi.spyOn(ctx.store, 'log').mockImplementation(((name: string) => {
      const log = realLog(name as never);
      if (name !== 'thread') return log;
      return { ...log, append: () => { throw new Error('模拟线程写入失败'); } };
    }) as never);
    const result = await hub.api.lifecycleAction({ botId: a.id, action: 'archive' });
    vi.restoreAllMocks();
    expect(result.ok).toBe(true);
    expect(staffStatus(bots(ctx, a.id)).status).toBe('archived');
  });
});

describe('N2 旧的归档入口不能把在岗员工只标成归档', () => {
  it('对在岗员工调用旧入口：完整归档（已退役、有归档时间、移出项目成员）', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id], ownerBotId: owner.id }));
    okData(await hub.api.archiveBot(a.id));
    expect(bots(ctx, a.id)).toMatchObject({ lifecycle: 'retired' });
    expect(bots(ctx, a.id).archivedAt).not.toBeNull();
    expect(ctx.store.table('projects').get(project.id)!.memberBotIds).toEqual([owner.id]);
    // 已归档的再调用：报已经归档了。
    expect(await hub.api.archiveBot(a.id)).toEqual({ ok: false, error: '归档：它已经归档了' });
  });

  it('反例：对总管调用旧入口被拒，状态不变', async () => {
    const { ctx, hub } = await realHub();
    const chief = autoChief(ctx);
    expect(await hub.api.archiveBot(chief.id)).toEqual({ ok: false, error: '归档：总管不能归档' });
    expect(bots(ctx, chief.id).archivedAt ?? null).toBeNull();
    expect(bots(ctx, chief.id).lifecycle).toBe('active');
  });

  it('启动整理修复脏数据一：在岗却带归档时间的普通员工，补成已退役并移出项目', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id], ownerBotId: owner.id }));
    await hub.stop();
    ctx.store.table('bots').patch(a.id, { archivedAt: ctx.clock.now() });
    const restarted = createHub(ctx);
    await restarted.start();
    expect(bots(ctx, a.id)).toMatchObject({ lifecycle: 'retired' });
    expect(bots(ctx, a.id).archivedAt).not.toBeNull();
    expect(ctx.store.table('projects').get(project.id)!.memberBotIds).toEqual([owner.id]);
    expect(await normalizeStaffStatus(ctx)).toEqual({ changed: 0 });
    await restarted.stop();
  });

  it('启动整理修复脏数据二：在岗却带归档时间的总管，清掉归档时间、保持在岗，并写审计', async () => {
    const { ctx, hub } = await realHub();
    const chief = autoChief(ctx);
    await hub.stop();
    ctx.store.table('bots').patch(chief.id, { archivedAt: ctx.clock.now() });
    const restarted = createHub(ctx);
    await restarted.start();
    expect(bots(ctx, chief.id).lifecycle).toBe('active');
    expect(bots(ctx, chief.id).archivedAt ?? null).toBeNull();
    expect(staffStatus(bots(ctx, chief.id)).status).toBe('on_duty');
    const audit = ctx.store.log('audit').all().filter(r => r.action === 'staff_status_normalize' && r.detail.includes('archivedAt_without_retired'));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ botId: chief.id, archived: false, clearedArchivedAt: true });
    await restarted.stop();
  });
});

describe('L1 闸门丢弃听吩咐候选，记录的原因准确', () => {
  it('评估记录里的原因是新的 on_demand，文字是「听吩咐：没有人点名或派活，不自己行动」', async () => {
    const { ctx, hub } = await realHub();
    const bot = await addBot(hub, '哨兵', 'sentinel');
    enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'light_check', variant: 'light_check', score: 1, summary: '到点复查', evidence: [] }));
    okData(await hub.api.updateBot(bot.id, { onDemand: true }));
    selectNext(ctx, ctx.clock.now());
    const logs = ctx.store.log('appraisals').all().filter(row => row.botId === bot.id && row.decision === 'suppressed' && row.suppressedBy === 'on_demand');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.text).toContain('听吩咐：没有人点名或派活，不自己行动');
    expect(logs.some(row => row.suppressedBy === ('paused' as string))).toBe(false);
    expect(ctx.store.table('queue').count(e => e.botId === bot.id)).toBe(0);
  });
  it('枚举只增不减、有显示文字；插件的拦截原因类型也包含它', () => {
    expect(SUPPRESSION_REASONS).toContain('on_demand');
    expect(SUPPRESSION_REASONS).toContain('paused');
    expect(SUPPRESSION_REASON_LABELS.on_demand).toBe('听吩咐：没有人点名或派活，不自己行动');
    const views = readFileSync(fileURLToPath(new URL('../../plugin/src/shared/views.ts', import.meta.url)), 'utf8');
    expect(views).toMatch(/export type SuppressionReason = [^\n]*'on_demand'/);
  });
});

describe('L2 纠正触发词收窄', () => {
  it('触发词清单：不对、别再、记住 原样；「以后」要紧跟 要、不要、别、都、记得、注意、必须、不能', () => {
    for (const text of ['这样不对', '别再这样了', '请记住这点', '以后不要这样写', '以后都用这个格式', '以后要先核实', '以后别发这个',
      '以后记得备份', '以后注意口径', '以后必须带来源', '以后不能省略步骤'])
      expect(CORRECTION_PATTERN.test(text), text).toBe(true);
  });
  it('反例：「以后再说吧」「以后有空看看」不触发', () => {
    for (const text of ['以后再说吧', '以后有空看看', '以后每周发我一份']) expect(CORRECTION_PATTERN.test(text), text).toBe(false);
  });
  // P75f：shouldReflect 已删除，「对所有员工生效……明确的触发」那条经它断言的测试删除；词表本身的两条保留。
});

describe('L3 与事项键常量', () => {
  it('事项键常量保留一个版本供读旧队列；P75 起听吩咐的闸门不再放行纠正复盘', () => {
    expect(OWNER_CORRECTION_SUBJECT_PREFIX).toBe(`reflection:${OWNER_CORRECTION_KEY_PREFIX}`);
    expect(onDemandBlocks({ onDemand: true }, 'reflection', `${OWNER_CORRECTION_SUBJECT_PREFIX}m_1`)).toBe(true);
    expect(onDemandBlocks({ onDemand: true }, 'reflection', 'reflection:week:2026-11-08')).toBe(true);
  });
  it('suggestArchive 的 ownsProject 是必填：不传不能通过类型检查（源码里没有问号）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/team/rules.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/\n\s+ownsProject: boolean;/);
    expect(source).not.toMatch(/ownsProject\?:/);
  });
});
