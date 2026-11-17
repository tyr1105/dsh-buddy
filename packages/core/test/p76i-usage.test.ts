/**
 * P76i 第 3.3 节：设置页「最近 7 天的用量」表（weeklyUsageView）。
 *
 * 范围：最近 7 个本地日（含今天）；token 一律按账本里的实测数。行：每件在范围内有回合的事一行（按 token 从多到少），
 * 其后固定三行：员工自己发起、复盘、学习与整理、你发起的对话（为 0 也列出）。固定行的预计一律「不适用」。
 * 夹具：场景 A 的三件事（北京时间 2026-11-17 14:00），回合明细和唤醒单由用例直接造；时间都用假时钟的绝对时刻。
 */
import { describe, expect, it } from 'vitest';
import { WeeklyUsageViewSchema, weeklyUsageView, weekStartOf } from '../src/api/usage-views.js';
import { WakeTicketSchema, type WakeTicket } from '../src/model/wake.js';
import type { HubContext } from '../src/engine/context.js';
import { modelFixtures } from './model-fixtures.js';
import { DAY, HOUR, NOW, at, putUsage, sceneA } from './p76i-fixtures.js';

const TZ = 'Asia/Shanghai';
/** 7 天窗口的起点：11月11日 00:00（今天 11月17日，往前 6 个本地日）。 */
const FROM = at('2026-11-11T00:00:00');

/** 一个回合明细（归一件事）。 */
const turn = (id: string, botId: string, startedAt: number, tokens: number) => ({ wakeId: `w_${id}`, step: 'exec' as const, botId, startedAt, endedAt: startedAt + 60_000, tokens });

/** 造一张唤醒单（基于合法样本）；dispatchedAt 默认等于开始时间（真正投递过）。 */
function putWake(ctx: HubContext, id: string, botId: string, patch: Partial<WakeTicket>): void {
  const base = WakeTicketSchema.parse(modelFixtures.WakeTicket.valid);
  const startedAt = patch.startedAt ?? NOW - HOUR;
  ctx.store.table('wakes').put({ ...base, id: `w_${id}`, botId, startedAt, dispatchedAt: startedAt, ownerInitiated: false, topicId: null, jobId: null,
    reason: { ...base.reason, kind: 'agenda_due', evidence: [] }, ...patch } as WakeTicket);
}
/** 账本里这张唤醒单的实测 token。 */
function putLedger(ctx: HubContext, wakeId: string, botId: string, tokenBase: number, at: number): void {
  ctx.store.log('ledger').append({ id: `le_${wakeId}`.slice(0, 13).padEnd(13, '0'), who: botId, wakeId: `w_${wakeId}`, tokens: tokenBase, kind: 'turn', at,
    tokenSource: 'host', tokenBase, accountingMultiplier: 1 });
}

describe('1 每件事的行与三行固定行', () => {
  it('三件事里有回合的两件各一行（按 token 从多到少），其后三行固定行逐字；预计取这件事当前的预计', async () => {
    const { ctx, report, guest } = await sceneA();
    putUsage(ctx, report, {}, [turn('rep0000001', report.executorId, at('2026-11-14T10:00:00'), 100_000), turn('rep0000002', report.executorId, at('2026-11-15T10:00:00'), 200_000),
      turn('rep0000003', report.executorId, at('2026-11-17T09:00:00'), 300_000)]);
    putUsage(ctx, guest, {}, [turn('gst0000001', guest.executorId, at('2026-11-12T10:00:00'), 400_000)]);
    const view = weeklyUsageView(ctx);
    expect(view.head).toEqual(['事', '回合', '预计', 'token']);
    expect(view.rows).toEqual([
      { label: '活动报名页', turns: '3', estimate: '14', tokens: '600K' },
      { label: '嘉宾介绍页', turns: '1', estimate: '8', tokens: '400K' },
      { label: '员工自己发起', turns: '0', estimate: '不适用', tokens: '0' },
      { label: '复盘、学习与整理', turns: '0', estimate: '不适用', tokens: '0' },
      { label: '你发起的对话', turns: '0', estimate: '不适用', tokens: '0' },
    ]);
    expect(WeeklyUsageViewSchema.safeParse(view).success).toBe(true);
  });

  it('token 多的排前面：把嘉宾介绍页的 token 改成比活动报名页多，顺序对调', async () => {
    const { ctx, report, guest } = await sceneA();
    putUsage(ctx, report, {}, [turn('rep0000001', report.executorId, at('2026-11-14T10:00:00'), 100_000)]);
    putUsage(ctx, guest, {}, [turn('gst0000001', guest.executorId, at('2026-11-12T10:00:00'), 900_000)]);
    expect(weeklyUsageView(ctx).rows.slice(0, 2).map(row => row.label)).toEqual(['嘉宾介绍页', '活动报名页']);
  });

  it('没有预计的事：预计一栏写「不适用」；没有任何回合的事不列', async () => {
    const { ctx, report, guest } = await sceneA();
    putUsage(ctx, report, {}, [turn('rep0000001', report.executorId, at('2026-11-14T10:00:00'), 100_000)]);
    ctx.store.table('jobEstimates').remove(report.agreementId);
    const rows = weeklyUsageView(ctx).rows;
    expect(rows[0]).toEqual({ label: '活动报名页', turns: '1', estimate: '不适用', tokens: '100K' });
    expect(rows.some(row => row.label === '嘉宾介绍页')).toBe(false); // guest 的用量行没有回合明细
    expect(guest.id).toBeTruthy();
  });

  it('固定行为 0 也列出（没有任何事时也是三行）', async () => {
    const { ctx } = await sceneA();
    const rows = weeklyUsageView(ctx).rows;
    expect(rows.map(row => row.label)).toEqual(['员工自己发起', '复盘、学习与整理', '你发起的对话']);
    expect(rows.every(row => row.turns === '0' && row.tokens === '0' && row.estimate === '不适用')).toBe(true);
  });
});

describe('2 7 天边界', () => {
  it('窗口起点是 7 个本地日前的 0 点（11月11日 00:00）；起点那一刻的回合计入，前 1 毫秒的不计；第 8 天的回合不计', async () => {
    expect(weekStartOf(NOW, TZ)).toBe(FROM);
    const { ctx, report } = await sceneA();
    putUsage(ctx, report, {}, [
      turn('edge000001', report.executorId, FROM, 10_000), // 起点：计
      turn('edge000002', report.executorId, FROM - 1, 20_000), // 前 1 毫秒（第 8 天 23:59:59.999）：不计
      turn('edge000003', report.executorId, FROM - 2 * DAY, 30_000), // 第 9 天：不计
      turn('edge000004', report.executorId, NOW, 40_000), // 此刻：计
    ]);
    expect(weeklyUsageView(ctx).rows[0]).toEqual({ label: '活动报名页', turns: '2', estimate: '14', tokens: '50K' });
  });

  it('固定行同样只算范围内的回合', async () => {
    const { ctx, fix } = await sceneA();
    putWake(ctx, 'selfin0001', fix.engineer.id, { startedAt: FROM });
    putLedger(ctx, 'selfin0001', fix.engineer.id, 7_000, FROM);
    putWake(ctx, 'selfout001', fix.engineer.id, { startedAt: FROM - 1 });
    putLedger(ctx, 'selfout001', fix.engineer.id, 9_000, FROM - 1);
    expect(weeklyUsageView(ctx).rows[0]).toEqual({ label: '员工自己发起', turns: '1', estimate: '不适用', tokens: '7K' });
  });
});

describe('3 固定三行的口径：逐个回合只归一行', () => {
  it('员工自己发起、复盘与整理、你发起的对话各归各的；一件事里的回合不重复算进固定行；没投递的不算', async () => {
    const { ctx, fix, report } = await sceneA();
    const engineer = fix.engineer.id;
    // 员工自己发起：没有人交代、不属于一件事、不是主题（2 个回合）。
    putWake(ctx, 'selfwk0001', engineer, { startedAt: NOW - 2 * HOUR }); putLedger(ctx, 'selfwk0001', engineer, 100_000, NOW - 2 * HOUR);
    putWake(ctx, 'selfwk0002', engineer, { startedAt: NOW - 3 * HOUR }); putLedger(ctx, 'selfwk0002', engineer, 50_000, NOW - 3 * HOUR);
    // 复盘类：唤醒种类是复盘、事项键是复盘的键。
    putWake(ctx, 'skillwk001', engineer, { startedAt: NOW - 4 * HOUR, subjectKey: `retro:run0000001:${engineer}`, variant: 'reflection',
      reason: { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid).reason, kind: 'reflection', evidence: [] } });
    putLedger(ctx, 'skillwk001', engineer, 200_000, NOW - 4 * HOUR);
    // 学习：教学变体、学习键，是主人发起的回合，但归「复盘、学习与整理」（先于「你发起」判断）。
    putWake(ctx, 'learnwk001', engineer, { startedAt: NOW - 5 * HOUR, subjectKey: `learn:run0000002:${engineer}`, variant: 'teach', ownerInitiated: true,
      reason: { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid).reason, kind: 'teach', evidence: [] } });
    putLedger(ctx, 'learnwk001', engineer, 300_000, NOW - 5 * HOUR);
    // 你发起的对话：你发起的一个，主题里的一个。
    putWake(ctx, 'ownerwk001', engineer, { startedAt: NOW - 6 * HOUR, ownerInitiated: true }); putLedger(ctx, 'ownerwk001', engineer, 10_000, NOW - 6 * HOUR);
    putWake(ctx, 'topicwk001', engineer, { startedAt: NOW - 7 * HOUR, topicId: report.topicId }); putLedger(ctx, 'topicwk001', engineer, 20_000, NOW - 7 * HOUR);
    // 一件事里的回合：用量行里有它，只算那件事，不进固定行。
    putWake(ctx, 'jobturn001', engineer, { startedAt: NOW - 8 * HOUR, jobId: report.id }); putLedger(ctx, 'jobturn001', engineer, 80_000, NOW - 8 * HOUR);
    putUsage(ctx, report, {}, [turn('jobturn001', engineer, NOW - 8 * HOUR, 80_000)]);
    // 没有真正投递的回合（dispatchedAt 为 null）：不算。
    putWake(ctx, 'undeliv001', engineer, { startedAt: NOW - 9 * HOUR, dispatchedAt: null }); putLedger(ctx, 'undeliv001', engineer, 999_000, NOW - 9 * HOUR);
    const rows = weeklyUsageView(ctx).rows;
    expect(rows).toEqual([
      { label: '活动报名页', turns: '1', estimate: '14', tokens: '80K' },
      { label: '员工自己发起', turns: '2', estimate: '不适用', tokens: '150K' },
      { label: '复盘、学习与整理', turns: '2', estimate: '不适用', tokens: '500K' },
      { label: '你发起的对话', turns: '2', estimate: '不适用', tokens: '30K' },
    ]);
  });
});

describe('4 给主人看的文字', () => {
  it('不含内部编号和英文（token、K、M 这样的单位除外）', async () => {
    const { ctx, report } = await sceneA();
    putUsage(ctx, report, {}, [turn('rep0000001', report.executorId, NOW - HOUR, 1_234_567)]);
    const view = weeklyUsageView(ctx);
    const texts = [...view.head, ...view.rows.flatMap(row => [row.label, row.turns, row.estimate, row.tokens])];
    for (const text of texts) {
      expect(text).not.toMatch(/job_|agr_|\bb_/);
      expect(text.replace(/token/g, '').replace(/\d+(\.\d+)?[KMBT]/g, '')).not.toMatch(/[A-Za-z]/);
    }
    expect(view.rows[0]!.tokens).toBe('1.23M');
  });
});
