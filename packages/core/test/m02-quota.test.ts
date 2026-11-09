/** M02 额度回归：真实计量、探针状态、窗口锚点与原活动必须能跨多轮失败恢复。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { classifyError, getQuotaState, rollWindow, recordUsage, onQuotaError, maybeAllowProbe, consumeProbe, onProbeResult } from '../src/quota/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import type { Bot, WakeTicket } from '../src/model/index.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { selectNext } from '../src/scheduler/select.js';
const hour = 3_600_000;
function setup() { const ctx = createTestContext(); ctx.store.table('bots').put(botFixture); return ctx; }
function probe(ctx: ReturnType<typeof setup>) {
  const q = getQuotaState(ctx, ctx.clock.now()); ctx.clock.set(q.redUntil!);
  expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
  expect(consumeProbe(ctx)).toBe(true);
  expect(getQuotaState(ctx, ctx.clock.now())).toMatchObject({ probeInFlight: true, probeAllowed: false });
  expect(getQuotaState(ctx, ctx.clock.now()).redUntil).not.toBeNull();
}

describe('M02 [0][2][6][25] 可恢复额度', () => {
  it('零 token 首错保留未知上限，成功探针后再记账仍可继续', () => {
    const ctx = setup(); expect(onQuotaError(ctx, ctx.clock.now()).tokenLimit).toBeNull();
    probe(ctx); onProbeResult(ctx, true);
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'next', tokens: 1000, packetBytes: 0, steps: 1 });
    expect(getQuotaState(ctx, ctx.clock.now()).light).not.toBe('red');
  });
  it('旧 tokenLimit=0 的窗口过期后不会生成无出口红灯', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('quota').put({ ...getQuotaState(ctx, now), windowStartAt: now - 6 * hour, tokenLimit: 0 });
    expect(rollWindow(ctx, now)).toMatchObject({ tokenLimit: null, light: 'green', windowPending: true });
    ctx.store.table('quota').patch('quota', { light: 'red', redUntil: null });
    const repaired = rollWindow(ctx, now); expect(repaired.redUntil).toBeGreaterThan(now);
    probe(ctx); onProbeResult(ctx, true);
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'after-legacy', tokens: 1000, packetBytes: 0, steps: 1 });
    expect(getQuotaState(ctx, now).light).not.toBe('red');
  });
  it('探针额度失败不重校准，下一次成功恢复且在途不会重发', () => {
    const ctx = setup(); ctx.store.table('quota').put({ ...getQuotaState(ctx, ctx.clock.now()), botTurns: 6, botTokens: 360000 });
    const calibrated = onQuotaError(ctx, ctx.clock.now());
    expect(calibrated).toMatchObject({ turnLimit: 5, tokenLimit: 324000 });
    probe(ctx); expect(maybeAllowProbe(ctx, ctx.clock.now() + 10 * hour)).toBe(false);
    const failedAt = ctx.clock.now(); const failed = onQuotaError(ctx, failedAt);
    expect(failed).toMatchObject({ turnLimit: 5, tokenLimit: 324000, probeInFlight: false,
      redUntil: failedAt + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs });
    probe(ctx); onProbeResult(ctx, true);
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'recovered', tokens: 60000, packetBytes: 0, steps: 1 });
    expect(getQuotaState(ctx, ctx.clock.now())).toMatchObject({ light: 'green', turnLimit: 5, tokenLimit: 324000 });
    expect(onQuotaError(ctx, ctx.clock.now()).tokenLimit).toBe(324000);
  });
  it('普通探针失败再成功同样恢复，失败只等待不缩小容量', () => {
    const ctx = setup(); onQuotaError(ctx, ctx.clock.now()); probe(ctx);
    expect(onProbeResult(ctx, false).tokenLimit).toBeNull(); probe(ctx);
    expect(onProbeResult(ctx, true)).toMatchObject({ light: 'green', probeInFlight: false });
  });
  it('旧窗口已用满个人三回合也能放恢复探针，待投递窗口不累计旧账', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.runtime.startedAt -= hour;
    for (let i = 0; i < 3; i++) recordUsage(ctx, { botId: botFixture.id, wakeId: `old-${i}`, tokens: 1, packetBytes: 0, steps: 1 });
    const red = onQuotaError(ctx, now); ctx.clock.set(red.redUntil!);
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
    const entry = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'retry', score: 0.75, summary: '额度恢复探针' }))!;
    expect(selectNext(ctx, ctx.clock.now())?.id).toBe(entry.id);
    expect(getQuotaState(ctx, ctx.clock.now()).windowStartAt).toBe(now);
  });
  it('过期后多次空闲 tick 不新建窗口，下个回合按开始时间建窗', () => {
    const ctx = setup(); const first = ctx.clock.now();
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'first', tokens: 1, steps: 0, packetBytes: 0 });
    for (const n of [5, 6, 12, 24]) {
      ctx.clock.set(first + n * hour);
      expect(rollWindow(ctx, ctx.clock.now())).toMatchObject({ windowStartAt: first, windowPending: true, botTurns: 0 });
    }
    const started = ctx.clock.now() + hour; ctx.clock.set(started + 60_000);
    ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), id: 'w_1234567890', startedAt: started, dispatchedAt: started });
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'w_1234567890', tokens: 1, steps: 0, packetBytes: 0 });
    expect(getQuotaState(ctx, ctx.clock.now())).toMatchObject({ windowStartAt: started, windowPending: false, botTurns: 1 });
  });
});

it('M02 [5][19] 红灯仅休息 watching/queued，恢复原活动且不覆盖等待或隔离', () => {
  const ctx = setup();
  const variants: Array<Partial<Bot>> = [{ activity: 'watching' }, { activity: 'queued' }, { activity: 'waiting_owner' },
    { activity: 'blocked' }, { activity: 'thinking' }, { lifecycle: 'paused', activity: 'watching' },
    { lifecycle: 'quarantined', activity: 'blocked' }];
  const bots = variants.map((v, n) => ({ ...botFixture, ...v, id: `b_${String(n).padStart(10, '0')}`, activityText: `原状态 ${n}` }));
  bots.forEach(b => ctx.store.table('bots').put(b)); onQuotaError(ctx, ctx.clock.now());
  bots.forEach((b, n) => expect(ctx.store.table('bots').get(b.id)?.activity).toBe(n < 2 ? 'resting' : b.activity));
  probe(ctx); onProbeResult(ctx, true);
  bots.forEach(b => expect(ctx.store.table('bots').get(b.id)).toMatchObject({ activity: b.activity, activityText: b.activityText }));
});

describe('M02 [7] 中英文状态码边界', () => {
  it.each(['HTTP 429', 'status 429', 'code: 429', '429 Too Many Requests', 'error (429)',
    '状态码 429', '接口返回429', '错误码：429', 'HTTP 429 额度不足', '服务繁忙（429）'])('额度正例 %s', text => expect(classifyError(text)).toBe('quota'));
  it.each(['HTTP 401', 'status 403', 'code: 401', '401 Unauthorized', '(403) Forbidden',
    '状态码401', '错误码：403', '接口返回401', '请求被拒绝（403）', '状态 401'])('鉴权正例 %s', text => expect(classifyError(text)).toBe('auth'));
  it.each(['at line 4290', 'id 401xxx', 'request 7f3a40196c', 'port 54013', 'after 40312 ms',
    '第4290行错误', '请求id 401xxx', '端口54013失败', '耗时40312毫秒', '编号14290校验失败'])('普通反例 %s', text => expect(classifyError(text)).toBe('other'));
  it.each(['timed out after 14290ms', 'network request id 7f3a40196c', '连接超时14290毫秒', '网络端口54013失败'])('网络反例 %s', text => expect(classifyError(text)).toBe('network'));
});
