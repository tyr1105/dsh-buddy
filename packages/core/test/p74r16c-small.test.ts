/**
 * P74r16c 第 4 至 7 节的测试：
 * 4 台账：返回文字放宽之后不能丢掉最新的动作（只有 hub_ 开头的工具放宽到 800 字；行上限 16 KiB；超限先截文字、后丢动作）；
 * 5 停用原因的写法统一（checkQuarantine 的越界一支）；
 * 6 最低自主等级的员工，沙箱会拦的写入同样不计越界；
 * 7 日报里的 token 数用换算后的写法。
 */
import { describe, expect, it } from 'vitest';
import type { Bot, WakeTicket } from '../src/model/index.js';
import { V2_DEFAULTS, resolveSettings } from '../src/config/defaults.js';
import { wakeLedgerDetail } from '../src/api/ledger-views.js';
import { guardToolCallSync, type ToolCallHostReport } from '../src/gate/guard.js';
import { checkQuarantine } from '../src/health/quarantine.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { appendLedgerAction, openLedgerForWake, recordDshToolAction } from '../src/ledger/service.js';
import { QUOTA_LIGHT_LABELS } from '../src/model/enums.js';
import { buildDigest } from '../src/outreach/digest.js';
import { getQuotaState } from '../src/quota/window.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';

const botId = 'b_0000000001';
const wakeId = 'w_0000000001';

// ---------------------------------------------------------------------------
// 第 4 节：台账
// ---------------------------------------------------------------------------

function ticket(): WakeTicket {
  const at = 1_793_808_000_000;
  return {
    id: wakeId, botId, sessionId: 'session-one', variant: 'regular',
    reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', ownerSummary: '资料有更新', evidence: ['p_0000000001'] },
    ownerInitiated: false, packetBytes: 1200, status: 'running', startedAt: at, lastEventAt: at,
    endedAt: null, steps: 2, tokens: 300, steeredAt: null, commitId: null, error: null,
  };
}

/** 放入一个在岗机器人和一条运行中的唤醒单，开出账本（与 f02-process-drill 相同的做法）。 */
function seed() {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  ctx.store.table('bots').put({ ...botFixture, activity: 'thinking', updatedAt: now } as Bot);
  ctx.store.table('percepts').put({
    id: 'p_0000000001', botId, watchId: null, source: 'file', kind: 'changed',
    summary: '文件增加一段文字', location: '/hub/shared/notes.txt', fingerprint: '0123456789abcdef',
    relevance: 0.8, novelty: 1, magnitude: 0.2, importance: 0.6, urgency: 0.5, anomaly: false,
    salience: 0.63, untrusted: true, tier: 'pile', consumedByWake: null, createdAt: now - 60_000,
  });
  ctx.store.table('wakes').put(ticket());
  openLedgerForWake(ctx, wakeId, null);
  return ctx;
}

/** n 个互不相同的汉字（避免把「截断」误判成「重复字被压缩」）。 */
const text = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + from + i)).join('');
const actionsOf = (ctx: HubContext) => wakeLedgerDetail(ctx, wakeId)!.actions;
const hubCall = (ctx: HubContext, n: number, length = 700) => recordDshToolAction(ctx, wakeId,
  { name: 'hub_job_manage', args: { mode: 'answer', n }, isError: false, resultText: text(length, n), callId: `hub-${n}` });
const bashCall = (ctx: HubContext, n: number, length = 700) => recordDshToolAction(ctx, wakeId,
  { name: 'bash', args: { command: `node test-${n}.js` }, isError: false, resultText: text(length, n), callId: `bash-${n}` });

describe('4 台账：行上限与返回文字的上限', () => {
  it('行上限是 16 KiB，hub_ 工具的返回文字上限是 800 字，其余是 160 字', () => {
    expect(V2_DEFAULTS.LEDGER_ROW_MAX_BYTES).toBe(16 * 1024);
    expect(V2_DEFAULTS.LEDGER_TOOL_RESULT_MAX_CHARS).toBe(800);
    expect(V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS).toBe(160);
  });

  it('一个回合 5 次 hub_ 工具调用、每次返回 700 字：5 条动作都在，返回文字一字不少', () => {
    const ctx = seed();
    for (let n = 0; n < 5; n += 1) hubCall(ctx, n);
    const actions = actionsOf(ctx);
    expect(actions).toHaveLength(5);
    actions.forEach((action, n) => expect(action.detail).toBe(text(700, n)));
    expect(wakeLedgerDetail(ctx, wakeId)!.entry.truncated).toBe(false);
  });

  it('20 次普通工具调用各返回 700 字：每条 160 字，动作一条不少', () => {
    const ctx = seed();
    for (let n = 0; n < 20; n += 1) bashCall(ctx, n);
    const actions = actionsOf(ctx);
    expect(actions).toHaveLength(20);
    actions.forEach((action, n) => expect(action.detail).toBe(text(160, n)));
    // 反例：同样 20 次，若返回文字都按 800 字算就会超过行上限（证明这条测的是 160 字的限制，不是碰巧装得下）。
    expect(20 * 800 * 3).toBeGreaterThan(V2_DEFAULTS.LEDGER_ROW_MAX_BYTES);
  });

  it('必然超限的一行：先把较长的返回文字从最早的动作开始截回 160 字，动作一条不丢，最新的一条动作原样还在', () => {
    const ctx = seed();
    // 12 次 hub_ 工具调用各 800 字：全按 800 字是 12 x 2400 字节，超过 16 KiB。
    for (let n = 0; n < 12; n += 1) hubCall(ctx, n, 800);
    const view = wakeLedgerDetail(ctx, wakeId)!;
    expect(view.entry.bytes).toBeLessThanOrEqual(V2_DEFAULTS.LEDGER_ROW_MAX_BYTES);
    expect(view.entry.truncated).toBe(true);
    expect(view.actions).toHaveLength(12);
    const lengths = view.actions.map(action => [...action.detail].length);
    // 最新的一条原样（800 字）；被截的是靠前的，而且是连续的一段前缀：先截最早的，截到不超限为止。
    expect(view.actions[11]!.detail).toBe(text(800, 11));
    const firstFull = lengths.findIndex(length => length === 800);
    expect(firstFull).toBeGreaterThan(0);
    expect(lengths.slice(0, firstFull).every(length => length === 160)).toBe(true);
    expect(lengths.slice(firstFull).every(length => length === 800)).toBe(true);
  });

  it('截完文字仍然超限，才丢动作：留下的每条都已截回 160 字', () => {
    const ctx = seed();
    // 30 条动作（动作数上限）各 800 字：全部截回 160 字之后仍超过 16 KiB，只能再丢动作。
    for (let n = 0; n < 30; n += 1) hubCall(ctx, n, 800);
    const view = wakeLedgerDetail(ctx, wakeId)!;
    expect(view.entry.bytes).toBeLessThanOrEqual(V2_DEFAULTS.LEDGER_ROW_MAX_BYTES);
    expect(view.actions.length).toBeGreaterThan(0);
    expect(view.actions.length).toBeLessThan(30);
    expect(view.actions.every(action => [...action.detail].length <= 160)).toBe(true);
    // 截断的写法与账本其他摘要一致：留 159 字加省略号。
    expect(view.actions[0]!.detail).toBe(`${text(159, 0)}…`);
  });

  it('反例：hub_tool 一类（中心自己记的动作）摘要仍是 160 字', () => {
    const ctx = seed();
    appendLedgerAction(ctx, wakeId, { kind: 'hub_tool', name: 'hub_commit', target: null, outcome: 'error', source: 'observed', refId: null, detail: text(700), durationMs: 1 });
    expect([...actionsOf(ctx)[0]!.detail].length).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// 第 5 节：停用原因的写法统一
// ---------------------------------------------------------------------------

describe('5 停用原因的写法统一', () => {
  it('越界达到次数：原因是「越界的动作累计 3 次」（不再是「越界尝试达到 3 次」）', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, violations: 3 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBe('越界的动作累计 3 次');
  });

  it('反例：越界只有 2 次，不停用', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, violations: 2 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });

  it('累计次数随实际次数写（4 次写 4 次）', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, violations: 4 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBe('越界的动作累计 4 次');
  });
});

// ---------------------------------------------------------------------------
// 第 6 节：最低自主等级的员工，沙箱会拦的写入同样不计越界
// ---------------------------------------------------------------------------

const owner = '/Users/owner', root = `${owner}/AgentHub`, home = `${root}/bots/b_0000000001`;
const SANDBOX: ToolCallHostReport = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'] };

function l0Setup() {
  const ctx = createTestContext({ ownerHome: owner });
  ctx.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const bot = { ...botFixture, sessionId: 'session-r16c', homeDir: home, autonomy: 'L0' as const, lifecycle: 'active' as const };
  ctx.store.table('bots').put(bot);
  return { ctx, bot };
}

/** 走同步守卫入口，并等所有副作用（记越界）做完。 */
async function guard(ctx: HubContext, sessionId: string, tool: string, args: unknown, host?: ToolCallHostReport) {
  const effects: Promise<unknown>[] = [];
  const decision = guardToolCallSync(ctx, sessionId, tool, args, effect => { effects.push(effect); }, undefined, host);
  await Promise.all(effects);
  return decision;
}

describe('6 最低自主等级：沙箱会拦的写入不计越界', () => {
  it('沙箱开着，写系统目录 3 次：拒绝文字不变，越界计数不变，没有被停用', async () => {
    const { ctx, bot } = l0Setup();
    for (let i = 0; i < 3; i += 1) {
      const decision = await guard(ctx, bot.sessionId, 'exec', { command: 'echo x > /etc/hosts' }, SANDBOX);
      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.message).toMatch(/^当前自主等级不能执行：/);
    }
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ violations: 0, lifecycle: 'active' });
  });

  it('反例：没有确认沙箱，写系统目录 3 次：照旧每次计一次越界，第三次停用', async () => {
    const { ctx, bot } = l0Setup();
    for (let i = 0; i < 3; i += 1) {
      const decision = await guard(ctx, bot.sessionId, 'exec', { command: 'echo x > /etc/hosts' });
      expect(decision.allow).toBe(false);
      expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(i + 1);
    }
    expect(ctx.store.table('bots').get(bot.id)!.lifecycle).toBe('quarantined');
  });

  it('反例：沙箱开着，写凭据类文件：照旧每次计越界', async () => {
    const { ctx, bot } = l0Setup();
    for (let i = 0; i < 2; i += 1) {
      const decision = await guard(ctx, bot.sessionId, 'write', { file_path: `${owner}/.ssh/id_rsa`, content: 'x' }, SANDBOX);
      expect(decision.allow).toBe(false);
    }
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 第 7 节：日报里的 token 数
// ---------------------------------------------------------------------------

describe('7 日报里的 token 数用换算后的写法', () => {
  const quotaLine = (ctx: HubContext) => buildDigest(ctx, ctx.clock.now()).split('\n').find(row => row.startsWith('额度用量：'));

  it('「额度用量：x/y 回合，N/上限 token」两个 token 数都换算，回合数不变', () => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub' }) });
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('quota').put({ ...getQuotaState(ctx, ctx.clock.now()), botTurns: 12, turnLimit: 40, botTokens: 1_636_469, tokenLimit: 5_000_000 });
    const light = QUOTA_LIGHT_LABELS[ctx.store.table('quota').get('quota')!.light];
    expect(quotaLine(ctx)).toBe(`额度用量：12/40 回合，1.64M/5M token，${light}`);
  });

  it('反例：没有上限时只写已用数（换算）；不足 1000 原样写数字', () => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub' }) });
    ctx.store.table('bots').put(botFixture);
    const base = getQuotaState(ctx, ctx.clock.now());
    const light = QUOTA_LIGHT_LABELS[base.light];
    ctx.store.table('quota').put({ ...base, botTurns: 3, turnLimit: 40, botTokens: 250_000, tokenLimit: null });
    expect(quotaLine(ctx)).toBe(`额度用量：3/40 回合，250K token，${light}`);
    ctx.store.table('quota').put({ ...base, botTurns: 3, turnLimit: 40, botTokens: 999, tokenLimit: 5_000_000 });
    expect(quotaLine(ctx)).toBe(`额度用量：3/40 回合，999/5M token，${light}`);
  });
});
