/** F01 接线验收：场景 A–F 走真实 Hub 与仿真宿主，只通过公共入口观察账本结果。 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Bot, Commit, LedgerMissingPart, WakeTicket } from '../src/model/index.js';
import { BotSchema, VISIBILITY_LABELS, VERIFICATION_LEVEL_LABELS, WakeTicketSchema } from '../src/model/index.js';
import { buildOpenLedger } from '../src/ledger/entry.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import { runLedgerBackfill } from '../src/ledger/service.js';
import { createHub } from '../src/engine/hub.js';
import type { HubContext } from '../src/engine/context.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { createUiApi } from '../src/api/index.js';
import { FileStore } from '../src/store/file-store.js';
import { TABLE_NAMES } from '../src/store/interfaces.js';
import { createSimWorld, advance } from '../src/sim/runner.js';
import { noCommitBrain, simCommit } from '../src/sim/brains.js';
import { botFixture, watchFixture } from './model-fixtures.js';

const minute = 60_000;
const day = 24 * 60 * minute;
const botId = 'b_0000000001';
const wakeId = 'w_0000000001';
const at = 1_793_808_000_000;

/** 构造合法唤醒单；场景只覆盖需要差异的字段。 */
function ticket(patch: Partial<WakeTicket> = {}): WakeTicket {
  return {
    id: wakeId, botId, sessionId: 'session-one', variant: 'regular',
    reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', ownerSummary: '资料有更新', evidence: ['p_0000000001'] },
    ownerInitiated: false, packetBytes: 1200, status: 'running', startedAt: at, lastEventAt: at,
    endedAt: null, steps: 2, tokens: 300, steeredAt: null, commitId: null, error: null, ...patch,
  };
}

/** 在测试上下文里放一个在岗机器人，并建好可读写的家目录。 */
async function activeBot(ctx: HubContext): Promise<Bot> {
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, lifecycle: 'active', sessionId: null, sessionStartedAt: null,
    createdAt: now, updatedAt: now, lastThinkAt: null, lightCheckAt: null };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  return bot;
}

describe('F01 场景 A：读一次关注项唤醒', () => {
  it('关注项变化触发真实回合，账本记录触发、证据、工具动作与交账', async () => {
    const world = await createSimWorld({ bots: [{ id: botId, brain: async ({ call }) => {
      const state = await call('hub_state_get', {});
      if (!state.ok) throw new Error(state.error);
      const commit = await call('hub_commit', simCommit({ outcome: 'progress', summary: '核对到一处公开变化，已记录' }), 8);
      if (!commit.ok) throw new Error(commit.error);
      return { finalText: '完成核对', tokens: 30 };
    } }] });
    const scopes: string[] = [];
    world.hub.subscribe(event => scopes.push(event.scope));
    await world.fs.writeTextAtomic('/sim-hub/shared/notes.txt', '第一版');
    world.store.table('watches').put({ ...watchFixture, id: 'wt_0000000001', botId,
      target: '/sim-hub/shared/notes.txt', createdAt: world.clock.now(), updatedAt: world.clock.now() });
    // 第一次 tick 只建立文件基线，之后的改动才形成感知。
    await advance(world, minute);
    await world.fs.writeTextAtomic('/sim-hub/shared/notes.txt', '第二版：补充了一条新的公开信息');
    // 文件改动要等过去抖窗口（默认两分钟）才会形成感知并候选。
    await advance(world, 2 * minute);
    const wake = world.store.table('wakes').list()[0]!;
    expect(wake.status).toBe('committed');
    const rows = world.store.table('wakeLedger').list();
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry).toMatchObject({ wakeId: wake.id, botId, source: 'live', completeness: 'full', status: 'committed', missing: [] });
    expect(entry.sealedAt).not.toBeNull();
    expect(entry.trigger.evidenceRefs.length).toBeGreaterThan(0);
    expect(entry.evidence.items[0]).toMatchObject({ kind: 'percept', trust: 'untrusted' });
    expect(entry.actions.items.map(action => action.name)).toEqual(['hub_state_get', 'hub_commit']);
    expect(entry.actions.items.every(action => action.source === 'observed' && action.outcome === 'ok')).toBe(true);
    expect(entry.decision).toMatchObject({ outcome: 'progress', summary: '核对到一处公开变化，已记录' });
    expect(entry.result.summary).toBe('核对到一处公开变化，已记录');
    // 机器人详情右栏用 wakeId 关联账本，时间线仍来自 wakes 表。
    const view = await world.hub.api.bot(botId);
    expect(view.wakes[0]).toMatchObject({ id: wake.id, ledgerId: entry.id, hasLedger: true });
    expect(scopes).toContain('ledger');
  });
});

describe('F01 场景 B：回合结束未交账', () => {
  it('账本记 no_commit，决定为空，missing 含 commit，不给假结果', async () => {
    const world = await createSimWorld({ bots: [{ id: botId, brain: noCommitBrain }] });
    const sent = await world.hub.api.sendMessage(botId, '请看看当前情况');
    expect(sent.ok).toBe(true);
    await world.host.settle();
    const wake = world.store.table('wakes').list()[0]!;
    expect(wake).toMatchObject({ status: 'no_commit', syntheticCommit: true });
    const entry = world.store.table('wakeLedger').list()[0]!;
    expect(entry).toMatchObject({ status: 'no_commit', completeness: 'partial', decision: null });
    expect(entry.missing).toEqual(expect.arrayContaining(['commit', 'result']));
    expect(entry.result.summary).toBeNull();
    expect(entry.result.verification).toBeNull();
  });
});

describe('F01 场景 C：宿主投递失败', () => {
  it('账本直接封存为 error，动作与交账缺失，原因可读', async () => {
    const world = await createSimWorld({ bots: [{ id: botId }] });
    world.host.failNextDeliveries(botId, 1, '受控投递故障');
    const sent = await world.hub.api.sendMessage(botId, '请核对当前变化');
    expect(sent.ok).toBe(true);
    const wake = world.store.table('wakes').list()[0]!;
    expect(wake).toMatchObject({ status: 'error', dispatchedAt: null, endedAt: expect.any(Number) });
    const rows = world.store.table('wakeLedger').list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', source: 'live', completeness: 'partial', decision: null, actions: { items: [] } });
    expect(rows[0]!.missing).toEqual(expect.arrayContaining(['actions', 'commit']));
    expect(world.store.table('wakeLedger').count(row => row.sealedAt === null)).toBe(0);
  });
});

describe('F01 场景 D：重启调和', () => {
  it('重启后孤儿账本按 error 收口，仍在运行的唤醒保持未封存', async () => {
    const ctx = createTestContext();
    await activeBot(ctx);
    const now = ctx.clock.now();
    // 孤儿账本：唤醒单已不存在（例如源表被清理），不可能再收到终态，必须收口。
    ctx.store.table('wakeLedger').put(buildOpenLedger({ id: 'wl_0000000009', wake: ticket({ id: 'w_0000000009' }),
      queueWaitMs: null, evidence: { items: [], missingIds: [] }, now }));
    // 仍在运行的唤醒：宿主可能只是重建了 Hub 而会话还在跑，账本不能提前判死。
    ctx.store.table('wakes').put(ticket());
    ctx.store.table('wakeLedger').put(buildOpenLedger({ id: 'wl_0000000001', wake: ticket(), queueWaitMs: 0,
      evidence: { items: [{ kind: 'percept', refId: 'p_0000000001', summary: '公开资料变化', occurredAt: now, trust: 'untrusted' }], missingIds: [] }, now }));
    // 同一个存储换一个新 Hub 启动，等价于进程重启后再次 start。
    const restarted = createHub(ctx);
    await restarted.start();
    const orphan = ctx.store.table('wakeLedger').get('wl_0000000009')!;
    expect(orphan).toMatchObject({ status: 'error', completeness: 'partial', decision: null });
    expect(orphan.sealedAt).not.toBeNull();
    expect(orphan.missing).toEqual(expect.arrayContaining(['commit', 'result']));
    expect(ctx.store.table('wakeLedger').get('wl_0000000001')).toMatchObject({ status: 'running', sealedAt: null });
    expect(ctx.store.table('wakes').get(wakeId)?.status).toBe('running');
    expect(ctx.store.table('wakeLedger').count(row => row.sealedAt === null)).toBe(1);
  });
});

describe('F01 场景 E：旧档回填', () => {
  it('30 天内已结束唤醒复制为 partial 回填行，备份旧表且二次启动不重复', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    await activeBot(ctx);
    ctx.store.table('percepts').put({ id: 'p_0000000001', botId, watchId: null, source: 'file', kind: 'changed',
      summary: '文件增加一段文字', location: '/hub/shared/notes.txt', fingerprint: '0123456789abcdef', relevance: 0.8,
      novelty: 1, magnitude: 0.2, importance: 0.6, urgency: 0.5, anomaly: false, salience: 0.63, untrusted: true,
      tier: 'pile', consumedByWake: null, createdAt: now - 3 * day });
    const commit1: Commit = { id: 'c_0000000001', wakeId: 'w_0000000001', botId, outcome: 'progress', summary: '核实完成',
      worldChanges: [], evidence: [], verification: { level: 'program', notCovered: '尚未人工检查' }, blocker: null,
      nextThink: { mode: 'auto', reason: '等待新证据' }, ownerQuestion: null, reply: null, report: null, importance: 5,
      proposals: [], createdAt: now - 2 * day };
    const commit2: Commit = { ...commit1, id: 'c_0000000002', wakeId: 'w_0000000002', summary: '复核完成', createdAt: now - 4 * day };
    ctx.store.table('wakes').put(ticket({ id: 'w_0000000001', status: 'committed', startedAt: now - 3 * day,
      lastEventAt: now - 2 * day, endedAt: now - 2 * day, commitId: commit1.id }));
    ctx.store.table('wakes').put(ticket({ id: 'w_0000000002', status: 'committed', startedAt: now - 5 * day,
      lastEventAt: now - 4 * day, endedAt: now - 4 * day, commitId: commit2.id,
      reason: { kind: 'percept', score: 0.7, threshold: 0.6, summary: '资料有更新', evidence: ['p_gone'] } }));
    ctx.store.table('wakes').put(ticket({ id: 'w_0000000003', status: 'canceled', startedAt: now - 40 * day,
      lastEventAt: now - 39 * day, endedAt: now - 39 * day, reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '过期', evidence: [] } }));
    ctx.store.table('commits').put(commit1);
    ctx.store.table('commits').put(commit2);
    ctx.store.log('appraisals').append({ id: 'ev_0000000001', botId, at: now - 3 * day + 30_000, perceptIds: [],
      score: 0.92, threshold: 0.55, decision: 'woke', suppressedBy: null, text: '关注项出现变化，已唤醒' });
    // 首次升级要备份旧表：准备 v1 遗留文件，启动后应复制到 .hub/backup。
    await ctx.fs.writeTextAtomic('/hub/.hub/state/wakes.json', '[]');
    await ctx.fs.writeTextAtomic('/hub/.hub/logs/appraisals/2026-11-01.jsonl', '');
    const hub = createHub(ctx);
    await hub.start();
    const rows = ctx.store.table('wakeLedger').list().sort((a, b) => a.openedAt - b.openedAt);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.source === 'backfill' && row.completeness === 'partial' && row.actions.items.length === 0)).toBe(true);
    expect(rows[0]).toMatchObject({ wakeId: 'w_0000000002', status: 'committed', missing: expect.arrayContaining(['evidence', 'actions']) });
    expect(rows[1]).toMatchObject({ wakeId: 'w_0000000001', openedAt: now - 3 * day, sealedAt: now - 2 * day, missing: ['actions'] });
    expect(rows[1]!.trigger).toMatchObject({ score: 0.92, threshold: 0.55, summary: '关注项出现变化，已唤醒' });
    expect(rows[1]!.decision).toMatchObject({ outcome: 'progress' });
    expect(ctx.store.table('wakeLedger').count(row => row.wakeId === 'w_0000000003')).toBe(0);
    // 回填是复制不是搬迁：源表行数、状态和交账都不变。
    expect(ctx.store.table('wakes').count()).toBe(3);
    expect(ctx.store.table('wakes').get('w_0000000001')?.status).toBe('committed');
    expect(ctx.store.table('commits').count()).toBe(2);
    // 首次升级备份旧表，日志目录也一并保留证据。
    expect(await ctx.fs.readText(`/hub/.hub/backup/v1-${now}/state/wakes.json`)).toBe('[]');
    expect(await ctx.fs.readText(`/hub/.hub/backup/v1-${now}/logs/appraisals/2026-11-01.jsonl`)).toBe('');
    expect(ctx.store.table('v2Config').get('v2')).toMatchObject({ schemaVersion: 1, backfillDoneThrough: now });
    expect(ctx.store.log('audit').recent(1, row => row.action === 'ledger_backfill')[0]?.detail).toContain('"written":2');
    const second = await runLedgerBackfill(ctx, now + 1_000);
    expect(second).toMatchObject({ scanned: 2, written: 0, skipped: 2 });
    expect(ctx.store.table('wakeLedger').count()).toBe(2);
  });
});

describe('F01 场景 F：降级兼容', () => {
  it('现有实体 schema 没有账本字段，旧唤醒单多出账本字段会被拒绝', () => {
    const botProps = Object.keys((z.toJSONSchema(BotSchema) as { properties: Record<string, unknown> }).properties);
    expect(botProps).not.toContain('ledger');
    expect(botProps).not.toContain('wakeLedger');
    const wakeProps = Object.keys((z.toJSONSchema(WakeTicketSchema) as { properties: Record<string, unknown> }).properties);
    expect(wakeProps).not.toContain('ledgerId');
    expect(wakeProps).not.toContain('ledger');
    expect(() => WakeTicketSchema.parse({ ...ticket(), ledgerId: 'wl_0000000001' })).toThrow();
    expect(TABLE_NAMES).toEqual(expect.arrayContaining(['wakeLedger', 'v2Config']));
  });

  it('v2 新表落在独立文件，旧表文件仍可被 v1 解析并忽略未知文件', async () => {
    const ctx = createTestContext();
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    const bot = { ...botFixture, lifecycle: 'active' as const };
    store.table('bots').put(bot);
    store.table('wakes').put(ticket());
    const entry = buildOpenLedger({ id: 'wl_0000000001', wake: ticket(), queueWaitMs: 10,
      evidence: { items: [], missingIds: [] }, now: at });
    store.table('wakeLedger').put(entry);
    store.table('v2Config').put({ id: 'v2', schemaVersion: 1, backfillDoneThrough: null, createdAt: at, updatedAt: at });
    await store.flush();
    const files = await ctx.fs.list('/hub/.hub/state');
    expect(files).toEqual(expect.arrayContaining(['bots.json', 'wakes.json', 'wakeLedger.json', 'v2Config.json']));
    const wakesText = await ctx.fs.readText('/hub/.hub/state/wakes.json');
    const wakeRows = JSON.parse(wakesText!) as unknown[];
    expect(wakeRows).toHaveLength(1);
    expect(() => WakeTicketSchema.parse(wakeRows[0])).not.toThrow();
    expect(wakesText).not.toContain('ledgerId');
    const botsText = await ctx.fs.readText('/hub/.hub/state/bots.json');
    expect(() => BotSchema.parse((JSON.parse(botsText!) as unknown[])[0])).not.toThrow();
    expect(botsText).not.toContain('wakeLedger');
    // 模拟 v1 只认识旧表：目录里的新文件不会被它读取，也不影响旧表解析。
    const legacyNames = new Set(['bots.json', 'wakes.json', 'commits.json', 'settings.json']);
    for (const name of files.filter(file => legacyNames.has(file))) {
      const text = await ctx.fs.readText(`/hub/.hub/state/${name}`);
      expect(() => JSON.parse(text!)).not.toThrow();
    }
    expect(await ctx.fs.readText('/hub/.hub/state/wakeLedger.json')).toContain('wl_0000000001');
  });
});

describe('F01 账本只读视图', () => {
  /** 搭一个带三条账本行的只读 API，时间顺序固定。 */
  function viewFixture() {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' });
    const base = buildOpenLedger({ id: 'wl_0000000001', wake: ticket(), queueWaitMs: 10,
      evidence: { items: [{ kind: 'percept', refId: 'p_0000000001', summary: '文件增加一段文字', occurredAt: now - 3 * 60 * minute, trust: 'untrusted' }], missingIds: [] }, now: now - 3 * 60 * minute });
    const sealed = { ...base, id: 'wl_0000000002', wakeId: 'w_0000000002', status: 'committed' as const,
      sealedAt: now - 2 * 60 * minute, completeness: 'partial' as const, missing: ['actions'] as LedgerMissingPart[], decision: { outcome: 'progress' as const, summary: '核实完成',
        blocker: null, nextThink: { mode: 'auto' as const, reason: '等待新证据' }, ownerQuestion: null, report: null, importance: 5 },
      result: { verification: { level: 'program' as const, notCovered: '尚未人工检查' },
        worldChanges: [{ what: '记录了一条事实', whoCanSee: 'owner' as const, where: '/hub/notes.md' }], refs: [], summary: '核实完成' },
      actions: { items: [{ kind: 'hub_tool' as const, name: 'hub_state_get', target: null, outcome: 'ok' as const,
        source: 'observed' as const, refId: null, detail: '成功', durationMs: 3 }] } };
    const open = { ...base, id: 'wl_0000000003', wakeId: 'w_0000000003', openedAt: now - 60 * minute };
    const old = { ...base, id: 'wl_0000000004', wakeId: 'w_0000000004', openedAt: now - 5 * 60 * minute,
      sealedAt: now - 4 * 60 * minute, status: 'canceled' as const };
    for (const row of [sealed, open, old]) ctx.store.table('wakeLedger').put(row);
    const api = createUiApi(ctx, async () => undefined);
    return { ctx, api, now, sealed };
  }

  it('列表按封存时间倒序，未封存用开账时间参与排序并支持 limit/before', () => {
    const { api, now } = viewFixture();
    expect(api.wakeLedgerList(botId).map(row => row.wakeId)).toEqual(['w_0000000003', 'w_0000000002', 'w_0000000004']);
    expect(api.wakeLedgerList(botId, 2).map(row => row.wakeId)).toEqual(['w_0000000003', 'w_0000000002']);
    expect(api.wakeLedgerList(botId, 20, now - 2 * 60 * minute).map(row => row.wakeId)).toEqual(['w_0000000004']);
    expect(api.wakeLedgerList(botId)[1]).toMatchObject({ sourceLabel: '实时', completenessLabel: '不完整', hasMissing: true,
      missingLabels: ['动作'], actionCount: 1, evidenceCount: 1 });
  });

  it('详情翻译证据、动作、交账与缺失标签，世界变化标注自述', () => {
    const { api } = viewFixture();
    const detail = api.wakeLedgerDetail('w_0000000002')!;
    expect(detail.evidence[0]).toMatchObject({ kindLabel: '感知', trustLabel: '外部内容' });
    expect(detail.actions[0]).toMatchObject({ kindLabel: '中心工具', sourceLabel: '中心观察到', outcomeLabel: '成功' });
    expect(detail.verificationLabel).toBe(VERIFICATION_LEVEL_LABELS.program);
    expect(detail.worldChanges[0]).toMatchObject({ whoCanSee: 'owner', visibilityLabel: VISIBILITY_LABELS.owner });
    expect(detail.missingLabels).toEqual(['动作']);
  });

  it('没有账本返回空，参数不合法给中文错误', () => {
    const { api } = viewFixture();
    expect(api.wakeLedgerDetail('w_9999999999')).toBeNull();
    expect(() => api.wakeLedgerList('')).toThrow('botId');
    expect(() => api.wakeLedgerList(botId, 0)).toThrow('limit');
    expect(() => api.wakeLedgerList(botId, 20, -1)).toThrow('before');
    expect(() => api.wakeLedgerDetail(' ')).toThrow('wakeId');
  });

  it('机器人详情时间线用 ledgerId/hasLedger 指向账本，没有账本时明确为空', async () => {
    const { ctx, api, sealed } = viewFixture();
    ctx.store.table('wakes').put(ticket({ id: 'w_0000000002', status: 'committed', endedAt: at + minute }));
    ctx.store.table('wakes').put(ticket({ id: 'w_0000000005', status: 'error', endedAt: at }));
    const rows = (await api.bot(botId)).wakes;
    expect(rows.find(row => row.id === 'w_0000000002')).toMatchObject({ ledgerId: sealed.id, hasLedger: true });
    expect(rows.find(row => row.id === 'w_0000000005')).toMatchObject({ ledgerId: null, hasLedger: false });
    expect(V2_DEFAULTS.LEDGER_LIST_DEFAULT_LIMIT).toBe(20);
  });
});
