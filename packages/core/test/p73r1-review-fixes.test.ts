/**
 * P73r1 验收：P73a、P73b 经独立审查后的修复（R1 至 R7）。
 *
 * 测试方式：R1 至 R5 一律用「会执行启动整理的真实中心」（createHub + start），不用跳过整理的仿真世界；
 * 只有明确是纯函数的（R4 模型档位、R6.3 归档建议、R6.4 性格提示词长度）直接调函数。
 * 每条修复至少一个正例、一个反例。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { normalizeStaffStatus, ARCHIVED_OWNER_ALERT_PREFIX } from '../src/team/normalize-status.js';
import { staffStatus } from '../src/model/bot.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { onDemandBlocks } from '../src/scheduler/on-demand.js';
import { postThread } from '../src/outreach/thread.js';
import { quarantine } from '../src/health/quarantine.js';
import { isLightModelName, modelTiers } from '../src/team/model-tiers.js';
import { suggestArchive, type ArchiveRow } from '../src/team/rules.js';
import { MBTI_TYPES } from '../src/model/enums.js';
import { mbtiPrompt } from '../src/model/mbti.js';
import { MBTI_DEFAULTS } from '../src/config/defaults.js';
import { byteLength } from '../src/util/text.js';
import { okData } from './c04-api-fixtures.js';
import type { FakeClock } from '../src/io/testing/fake-clock.js';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import type { HubContext } from '../src/engine/context.js';
import type { Hub } from '../src/engine/hub.js';
import type { Bot } from '../src/model/index.js';
import type { HubModelOption } from '../src/api/models.js';

const hour = 3_600_000;
const day = 24 * hour;

afterEach(() => { vi.restoreAllMocks(); });

/** 真实中心：执行启动整理的 Hub。ctx 与 Hub 共用同一个存储和时钟，测试可以直接读写表。 */
async function realHub(): Promise<{ ctx: HubContext; hub: Hub }> {
  const ctx = createTestContext();
  const hub = createHub(ctx);
  await hub.start();
  // 闸门快照读取 ctx.runtime.startedAt：把启动时刻拨到一小时前，避开启动静默。
  ctx.runtime.startedAt -= hour;
  return { ctx, hub };
}
/** 经界面命令创建员工。 */
async function addBot(hub: Hub, name: string, role: Bot['role']): Promise<Bot> {
  return okData(await hub.api.createBot({ name, role, persona: '先核实再行动', aspirations: ['持续核实公开信息'] }));
}
/** P73c：启动时中心自动建了一位总管；测试里需要总管时直接取它，不再另建（总管最多 1 个）。 */
function autoChief(ctx: HubContext): Bot {
  return ctx.store.table('bots').list(row => row.role === 'chief')[0]!;
}
/** 读最新的员工档案。 */
function bots(ctx: HubContext, id: string): Bot {
  return ctx.store.table('bots').get(id)!;
}
/** 某位员工的主人消息候选（主人发起，闸门不拦）。 */
function ownerCandidate(ctx: HubContext, botId: string) {
  return enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
    summary: '主人发来一条消息', evidence: [], ownerInitiated: true }));
}

describe('R1 归档要么全部完成，要么什么都不变', () => {
  it('审查报告 F1 的复现步骤：同项目里另有已归档成员时，归档成功且成员名单里没有他', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const b = await addBot(hub, '乙', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id, b.id], ownerBotId: owner.id }));
    // 旧数据：乙是旧「退役」员工，已归档却仍留在成员名单里。
    ctx.store.table('bots').patch(b.id, { lifecycle: 'retired', archivedAt: ctx.clock.now() });
    const result = await hub.api.lifecycleAction({ botId: a.id, action: 'archive' });
    expect(result.ok).toBe(true);
    const saved = ctx.store.table('projects').get(project.id)!;
    expect(saved.memberBotIds).not.toContain(a.id);
    expect(saved.memberBotIds).toContain(owner.id);
    expect(bots(ctx, a.id)).toMatchObject({ lifecycle: 'retired' });
    expect(bots(ctx, a.id).archivedAt).not.toBeNull();
    expect(ctx.store.log('audit').all().some(row => row.action === 'bot_archive' && row.detail.includes(a.id))).toBe(true);
  });

  it('反例：归档中途一步失败，员工档案、项目成员、队列、隔离告警原样保留，并报错', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'sentinel');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id], ownerBotId: owner.id }));
    // 排一条自主候选：中心启动静默期内闸门不放行，它会一直留在队列里，不会被命令之后的派发带走。
    enqueue(ctx, buildCandidate(ctx, { botId: a.id, kind: 'light_check', variant: 'light_check', score: 1, summary: '到点复查', evidence: [] }));
    const botBefore = bots(ctx, a.id);
    const projectBefore = ctx.store.table('projects').get(project.id)!;
    const queueBefore = ctx.store.table('queue').list(entry => entry.botId === a.id);
    expect(queueBefore).toHaveLength(1);
    // 让第一段的最后一步（把员工档案改成已归档）失败；P73r2 起写审计属于第二段，不再参与回滚。
    const realTable = ctx.store.table.bind(ctx.store);
    vi.spyOn(ctx.store, 'table').mockImplementation(((name: string) => {
      const table = realTable(name as never);
      if (name !== 'bots') return table;
      return { ...table, patch: (id: string, partial: { lifecycle?: string }) => {
        if (partial.lifecycle === 'retired') throw new Error('模拟写档案失败');
        return (table as unknown as { patch(id: string, p: unknown): unknown }).patch(id, partial);
      } };
    }) as never);
    const result = await hub.api.lifecycleAction({ botId: a.id, action: 'archive' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('归档失败');
    vi.restoreAllMocks();
    expect(bots(ctx, a.id)).toEqual(botBefore);
    expect(ctx.store.table('projects').get(project.id)).toEqual(projectBefore);
    expect(ctx.store.table('queue').list(entry => entry.botId === a.id)).toEqual(queueBefore);
    // 状态恢复之后可以正常再归档一次。
    expect((await hub.api.lifecycleAction({ botId: a.id, action: 'archive' })).ok).toBe(true);
  });

  it('旧入口 archiveBot（补归档）同样全有或全无：成功时移出成员，被拒时什么都不变', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id], ownerBotId: owner.id }));
    // 负责人经旧入口补归档：被拒，项目和档案不变。
    ctx.store.table('bots').patch(owner.id, { lifecycle: 'retired', archivedAt: null });
    const before = ctx.store.table('projects').get(project.id)!;
    expect((await hub.api.archiveBot(owner.id)).ok).toBe(false);
    expect(ctx.store.table('projects').get(project.id)).toEqual(before);
    expect(bots(ctx, owner.id).archivedAt ?? null).toBeNull();
    // 普通成员：旧退役数据补归档成功，并被移出成员名单。
    ctx.store.table('bots').patch(a.id, { lifecycle: 'retired', archivedAt: null });
    expect((await hub.api.archiveBot(a.id)).ok).toBe(true);
    expect(ctx.store.table('projects').get(project.id)!.memberBotIds).not.toContain(a.id);
  });

  it('启动整理：遗留的已归档成员被移出项目，并在整理审计里写明；反例：未归档成员保留', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const b = await addBot(hub, '乙', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id, b.id], ownerBotId: owner.id }));
    await hub.stop();
    // 半改状态：甲已归档但还在成员名单里。
    ctx.store.table('bots').patch(a.id, { lifecycle: 'retired', archivedAt: ctx.clock.now() });
    const restarted = createHub(ctx);
    await restarted.start();
    const members = ctx.store.table('projects').get(project.id)!.memberBotIds;
    expect(members).toEqual([owner.id, b.id]);
    const audit = ctx.store.log('audit').all().filter(row => row.action === 'staff_status_normalize' && row.detail.includes('removedFromProjects'));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ botId: a.id, removedFromProjects: [{ id: project.id, name: '周报' }] });
    // 幂等：再整理一次没有改动。
    expect(await normalizeStaffStatus(ctx)).toEqual({ changed: 0 });
    await restarted.stop();
  });
});

describe('R2 旧的退役入口走同一套拦截', () => {
  it('审查报告 F2 的复现步骤：总管和项目负责人经 retire、setLifecycle 都被拒绝，状态不变', async () => {
    const { ctx, hub } = await realHub();
    const chief = autoChief(ctx);
    const owner = await addBot(hub, '负责人', 'sentinel');
    okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id], ownerBotId: owner.id }));
    expect(await hub.api.lifecycleAction({ botId: chief.id, action: 'retire' })).toEqual({ ok: false, error: '归档：总管不能归档' });
    const byAction = await hub.api.lifecycleAction({ botId: owner.id, action: 'retire' });
    expect(byAction.ok).toBe(false);
    if (!byAction.ok) expect(byAction.error).toContain('负责人');
    expect((await hub.api.setLifecycle(owner.id, 'retired')).ok).toBe(false);
    expect((await hub.api.setLifecycle(chief.id, 'retired')).ok).toBe(false);
    expect(staffStatus(bots(ctx, owner.id)).status).toBe('on_duty');
    expect(staffStatus(bots(ctx, chief.id)).status).toBe('on_duty');
  });

  it('正例：普通员工经 retire、setLifecycle 与 archive 结果相同（已归档、有归档时间、移出项目）', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const a = await addBot(hub, '甲', 'researcher');
    const b = await addBot(hub, '乙', 'researcher');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id, a.id, b.id], ownerBotId: owner.id }));
    expect((await hub.api.lifecycleAction({ botId: a.id, action: 'retire' })).ok).toBe(true);
    expect((await hub.api.setLifecycle(b.id, 'retired')).ok).toBe(true);
    for (const id of [a.id, b.id]) {
      expect(staffStatus(bots(ctx, id)).status).toBe('archived');
      expect(bots(ctx, id).archivedAt).not.toBeNull();
    }
    expect(ctx.store.table('projects').get(project.id)!.memberBotIds).toEqual([owner.id]);
  });

  it('已归档的项目负责人不能被删除；启动整理对这类项目只告警一次，不自动换负责人', async () => {
    const { ctx, hub } = await realHub();
    const owner = await addBot(hub, '负责人', 'sentinel');
    const project = okData(await hub.api.saveProject({ name: '周报', memberBotIds: [owner.id], ownerBotId: owner.id }));
    await hub.stop();
    // 旧数据：负责人已是归档状态。
    ctx.store.table('bots').patch(owner.id, { lifecycle: 'retired', archivedAt: ctx.clock.now() });
    const restarted = createHub(ctx);
    await restarted.start();
    const text = '项目「周报」的负责人「负责人」已归档，请在项目设置里换一位负责人。';
    const openAlerts = () => ctx.store.table('alerts').list(alert => alert.code === `${ARCHIVED_OWNER_ALERT_PREFIX}${project.id}` && alert.status === 'open');
    expect(openAlerts()).toHaveLength(1);
    expect(openAlerts()[0]!.text).toBe(text);
    // 再整理、再启动都不重复告警，负责人也不被自动更换。
    await normalizeStaffStatus(ctx);
    await restarted.stop();
    const third = createHub(ctx);
    await third.start();
    expect(ctx.store.table('alerts').list(alert => alert.code.startsWith(ARCHIVED_OWNER_ALERT_PREFIX))).toHaveLength(1);
    expect(ctx.store.table('projects').get(project.id)).toMatchObject({ ownerBotId: owner.id, memberBotIds: [owner.id] });
    // 删除被拒，文字与告警一致。
    expect(await third.api.deleteArchivedBot(owner.id)).toEqual({ ok: false, error: text });
    expect(ctx.store.table('bots').get(owner.id)).not.toBeNull();
    // 主人换了负责人以后可以删除，旧告警下次整理时关闭。
    const other = await addBot(third, '新负责人', 'sentinel');
    ctx.store.table('projects').patch(project.id, { ownerBotId: other.id, memberBotIds: [other.id] });
    expect((await third.api.deleteArchivedBot(owner.id)).ok).toBe(true);
    await normalizeStaffStatus(ctx);
    expect(openAlerts()).toHaveLength(0);
    await third.stop();
  });
});

describe('R3 听吩咐的员工：主人纠正引起的复盘例外已随 P75f 删除', () => {
  /** 压制日志条数：入队总闸挡住时写的那一类。 */
  const suppressed = (ctx: HubContext, botId: string) => ctx.store.log('appraisals').all()
    .filter(row => row.botId === botId && row.text.includes('听吩咐：没有人点名或派活')).length;

  // P75f：shouldReflect 已删除，旧复盘触发（含主人纠正）不再产生候选；原四条测试删除，保留闸门行为的新断言。
  it('主人纠正后也不再产生复盘候选，多个 tick 之后压制记录不增长', async () => {
    const { ctx, hub } = await realHub();
    const bot = await addBot(hub, '小研', 'researcher');
    expect(bots(ctx, bot.id).onDemand).toBe(true);
    postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '这样不对，以后记住先核实', refId: null });
    const before = suppressed(ctx, bot.id);
    for (let tick = 0; tick < 5; tick += 1) {
      (ctx.clock as FakeClock).advance(ctx.settings.tickMs);
      await hub.tick();
    }
    expect(suppressed(ctx, bot.id)).toBe(before);
    expect(ctx.store.table('queue').count(entry => entry.botId === bot.id)).toBe(0);
  });

  it('onDemandBlocks：纠正复盘与其他复盘一律挡住（P75f 起不再有例外）', () => {
    expect(onDemandBlocks({ onDemand: true }, 'reflection', 'reflection:message:m_1')).toBe(true);
    expect(onDemandBlocks({ onDemand: true }, 'reflection', 'reflection:week:2026-11-08')).toBe(true);
    expect(onDemandBlocks({ onDemand: true }, 'reflection')).toBe(true);
  });
});

describe('R4 轻档模型按完整的词匹配', () => {
  const option = (model: string, label = model): HubModelOption => ({ provider: 'p', model, label }) as HubModelOption;
  it('不是轻档：gemini-2.5-pro、MiniMax-M2、airoboros-70b、claude-fable-5', () => {
    for (const name of ['gemini-2.5-pro', 'MiniMax-M2', 'airoboros-70b', 'claude-fable-5'])
      expect(isLightModelName(name), name).toBe(false);
    for (const name of ['gemini-2.5-pro', 'MiniMax-M2', 'airoboros-70b', 'claude-fable-5'])
      expect(modelTiers([option(name)], null).lightAvailable, name).toBe(false);
  });
  it('是轻档：gpt-4o-mini、gemini-2.5-flash、glm-4-air、claude-haiku-4、deepseek-flash（不区分大小写）', () => {
    for (const name of ['gpt-4o-mini', 'gemini-2.5-flash', 'glm-4-air', 'claude-haiku-4', 'deepseek-flash', 'GPT-4O-MINI'])
      expect(isLightModelName(name), name).toBe(true);
    const tiers = modelTiers([option('gemini-2.5-pro'), option('gpt-4o-mini', 'GPT-4o mini')], null);
    expect(tiers).toMatchObject({ lightAvailable: true, lightLabel: 'GPT-4o mini' });
  });
  it('目录为空或读不到时不提供轻档', () => {
    expect(modelTiers([], null).lightAvailable).toBe(false);
    expect(modelTiers(null, null).lightAvailable).toBe(false);
  });
});

describe('R5 调度时也检查听吩咐', () => {
  it('队列里预先放一条轻复查候选，员工改为听吩咐后，这条候选不被派发并被清掉', async () => {
    const { ctx, hub } = await realHub();
    const bot = await addBot(hub, '哨兵', 'sentinel');
    // 值守类原本是自己会醒的；排一条轻复查候选。
    const queued = enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'light_check', variant: 'light_check',
      score: 1, summary: '到点复查', evidence: [] }));
    expect(queued).not.toBeNull();
    expect(ctx.store.table('queue').count(entry => entry.botId === bot.id)).toBe(1);
    const hostCalls = (ctx.host as FakeHost).calls.length;
    // 运行中改成听吩咐（命令之后中心自己的调度也会走到这道闸门，这里再显式选一次）。
    okData(await hub.api.updateBot(bot.id, { onDemand: true }));
    expect(bots(ctx, bot.id).onDemand).toBe(true);
    expect(selectNext(ctx, ctx.clock.now())).toBeNull();
    expect((ctx.host as FakeHost).calls.length).toBe(hostCalls);
    expect(ctx.store.table('queue').count(entry => entry.botId === bot.id)).toBe(0);
    // 反例：主人消息的候选照常放行。
    const owner = ownerCandidate(ctx, bot.id)!;
    expect(selectNext(ctx, ctx.clock.now())?.id).toBe(owner.id);
  });

  it('反例：不听吩咐的员工的轻复查候选不会被这道检查丢弃', async () => {
    const { ctx, hub } = await realHub();
    const bot = await addBot(hub, '哨兵', 'sentinel');
    const queued = enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'light_check', variant: 'light_check',
      score: 1, summary: '到点复查', evidence: [] }))!;
    const now = ctx.clock.now();
    const gate = evaluateGates(queued, buildSnapshot(ctx, bot.id, now), now, ctx.settings);
    expect(gate.pass === false && gate.drop === true && gate.by === 'on_demand').toBe(false);
  });
});

describe('R6 其余五条', () => {
  it('R6.1 恢复归档一律拒绝，文字固定，员工保持归档', async () => {
    const { ctx, hub } = await realHub();
    const bot = await addBot(hub, '甲', 'researcher');
    okData(await hub.api.lifecycleAction({ botId: bot.id, action: 'archive' }));
    expect(await hub.api.restoreArchivedBot(bot.id)).toEqual({ ok: false, error: '归档后不能恢复为在岗；记录仍可查看' });
    expect(staffStatus(bots(ctx, bot.id)).status).toBe('archived');
    expect(bots(ctx, bot.id).archivedAt).not.toBeNull();
  });

  it('R6.2 从停用（系统隔离）直接归档，隔离告警一并关闭；反例：未归档时告警仍开放', async () => {
    const { ctx, hub } = await realHub();
    const a = await addBot(hub, '甲', 'researcher');
    const b = await addBot(hub, '乙', 'researcher');
    quarantine(ctx, a.id, '连续故障');
    quarantine(ctx, b.id, '连续故障');
    const open = (id: string) => ctx.store.table('alerts').count(alert => alert.botId === id && alert.code === 'quarantine' && alert.status === 'open');
    expect(open(a.id)).toBe(1);
    okData(await hub.api.lifecycleAction({ botId: a.id, action: 'archive' }));
    expect(open(a.id)).toBe(0);
    expect(open(b.id)).toBe(1);
  });

  it('R6.3 归档建议只从现在能归档的员工里选；没有可选的返回空', () => {
    const now = 100 * day;
    const row = (over: Partial<ArchiveRow>): ArchiveRow => ({
      botId: 'x', name: 'x', role: 'executor', templateId: 'engineer', lastWorkAt: now, openWorkCount: 0, lastThinkAt: now, ownsProject: false, ...over });
    // 审查报告 F8 的复现：甲很久以前领了活、至今在办；乙近期接过活、没有在办。
    const rows = [row({ botId: 'a', name: '甲', lastWorkAt: 1, openWorkCount: 3 }), row({ botId: 'b', name: '乙', openWorkCount: 0 })];
    expect(suggestArchive(rows, now)?.botId).toBe('b');
    // 项目负责人被排除。
    const owners = [row({ botId: 'a', name: '甲', lastWorkAt: 1, ownsProject: true }), row({ botId: 'b', name: '乙' })];
    expect(suggestArchive(owners, now)?.botId).toBe('b');
    // 总管、负责人、有在办事务的都不能选：返回空。
    const none = [row({ botId: 'z', name: '总管', role: 'chief', templateId: 'project-manager' }),
      row({ botId: 'a', name: '甲', ownsProject: true }), row({ botId: 'b', name: '乙', openWorkCount: 1 })];
    expect(suggestArchive(none, now)).toBeNull();
  });

  it('R6.4 性格提示词最长字节数：实测值与 defaults.ts 注释里写的数字一致，且不超过上限', () => {
    const longest = Math.max(...MBTI_TYPES.map(type => byteLength(mbtiPrompt(type)!)));
    expect(longest).toBeLessThanOrEqual(MBTI_DEFAULTS.PROMPT_MAX_BYTES);
    expect(MBTI_DEFAULTS.PROMPT_MAX_BYTES).toBe(1024);
    const source = readFileSync(fileURLToPath(new URL('../src/config/defaults.ts', import.meta.url)), 'utf8');
    const stated = /实测最长 (\d+) 字节/.exec(source);
    expect(stated, '注释里要写「实测最长 N 字节」').not.toBeNull();
    expect(Number(stated![1])).toBe(longest);
  });
});

describe('R7 测试覆盖补回', () => {
  it('主人用 updateBot 给总管设置自主等级和节奏能生效', async () => {
    const { ctx, hub } = await realHub();
    const chief = autoChief(ctx);
    okData(await hub.api.updateBot(chief.id, { autonomy: 'L3', pace: 'active', onDemand: false }));
    expect(bots(ctx, chief.id)).toMatchObject({ autonomy: 'L3', pace: 'active', onDemand: false });
  });
  it('主人用 updateBot 给值守类设置自主等级和节奏能生效；反例：执行类传入的这几项被忽略', async () => {
    const { ctx, hub } = await realHub();
    const sentinel = await addBot(hub, '哨兵', 'sentinel');
    const researcher = await addBot(hub, '小研', 'researcher');
    okData(await hub.api.updateBot(sentinel.id, { autonomy: 'L3', pace: 'active', onDemand: false }));
    expect(bots(ctx, sentinel.id)).toMatchObject({ autonomy: 'L3', pace: 'active', onDemand: false });
    okData(await hub.api.updateBot(researcher.id, { autonomy: 'L3', pace: 'active', onDemand: false }));
    expect(bots(ctx, researcher.id)).toMatchObject({ autonomy: 'L1', pace: 'quiet', onDemand: true });
  });
});
