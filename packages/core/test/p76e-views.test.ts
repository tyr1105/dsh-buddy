/**
 * P76e：给主人看的消耗文字（约定卡「预计消耗」、进度行第三行与明细、回执第六行、总管唤醒包一行）。
 *
 * 纯函数逐字断言；真实 Hub 走一遍确认接线（总管自动创建、听吩咐；执行类员工听吩咐）。
 * token 数一律用带单位的短写法（380K、1.64M），不写「万」；给主人看的文字不含内部编号、工具名、英文步骤名。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { receiptCardView } from '../src/api/job-delivery-views.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { estimateCardOf } from '../src/job/estimate-text.js';
import { estimateJob, latestEstimate } from '../src/job/estimate.js';
import { chiefCostLine, costLineOf, costTurnRows, receiptCostValue } from '../src/job/usage-text.js';
import type { EstimateVersion, JobUsage } from '../src/model/budget.js';
import { chiefChainBody } from '../src/wake/job-section-chief.js';
import { chiefDrafts, jobFix } from './p74b-fixtures.js';
import { assigned } from './p74c-fixtures.js';
import { delivered } from './p74f-fixtures.js';

/** 用量行：五步给 [回合, token]。 */
function usage(steps: Partial<Record<'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch', [number, number]>>, extra: Partial<JobUsage> = {}): JobUsage {
  const pick = (key: 'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch') => ({ turns: steps[key]?.[0] ?? 0, tokens: steps[key]?.[1] ?? 0 });
  return { id: 'job_aaaaaaaaaa', agreementId: 'agr_aaaaaaaaaa', category: '其他', turns: [], finalizedAt: null, updatedAt: 1, ...extra,
    steps: { align: pick('align'), exec: pick('exec'), review: pick('review'), rework: pick('rework'), chief: pick('chief'), launch: pick('launch') } };
}

/** 一项预计：默认份额（对齐 1，共 9 回合）。 */
const DEFAULT_ESTIMATE: EstimateVersion = estimateJob({
  hasReviewer: true, hasLaunch: false, align: { turns: 1, tokens: 0 }, history: [], turnSamples: {}, versionNo: 1, reason: 'lock', createdAt: 1,
});
const HISTORY_ESTIMATE: EstimateVersion = { ...DEFAULT_ESTIMATE, basis: 'history', historyCount: 3, steps: { ...DEFAULT_ESTIMATE.steps, chief: 0 }, total: 8 };

const TZ = 'Asia/Shanghai';

describe('1 约定卡「预计消耗」（逐字）', () => {
  it('默认份额、有核对人、有发布步骤：每一行、依据、末句', () => {
    const view = estimateCardOf(DEFAULT_ESTIMATE, { executorName: '林舟', reviewerName: '评审甲', hasLaunch: true });
    expect(view).toEqual({
      title: '预计消耗',
      headline: '9 回合，约 1.08M 到 2.7M token。',
      lines: [
        '对齐 1 回合（总管，已用）',
        '执行 3 回合（林舟）',
        '核对 1 回合（评审甲，每轮 1 回合，最多 3 轮）',
        '返工预留 3 回合（核对不通过时使用；未用到的不消耗）',
        '总管预留 1 回合（回答员工的问题）',
        '对外发布另计，最多 4 回合。',
      ],
      basisLine: '首次估计：没有同类事的记录，按每一步的默认份额估计。',
      footer: '1 回合指一位员工被唤醒后连续工作一轮。用到 9 回合仍未做完时，我会先问你，不会自行超出。',
    });
  });

  it('没有核对人：核对一行写「总管核对」；没有发布步骤：没有发布那一行；总管预留为 0：没有那一行；依据是同类记录', () => {
    const view = estimateCardOf(HISTORY_ESTIMATE, { executorName: '林舟', reviewerName: null, hasLaunch: false });
    expect(view.lines).toEqual([
      '对齐 1 回合（总管，已用）',
      '执行 3 回合（林舟）',
      '核对 1 回合（总管核对，每轮 1 回合，最多 3 轮）',
      '返工预留 3 回合（核对不通过时使用；未用到的不消耗）',
    ]);
    expect(view.basisLine).toBe('按 3 件同类事的记录估计。');
    expect(view.footer).toBe('1 回合指一位员工被唤醒后连续工作一轮。用到 8 回合仍未做完时，我会先问你，不会自行超出。');
  });

  it('派活前约定里没有人选：执行者、核对人写通用称呼', () => {
    const view = estimateCardOf(DEFAULT_ESTIMATE, { executorName: '执行者', reviewerName: '核对人', hasLaunch: false });
    expect(view.lines[1]).toBe('执行 3 回合（执行者）');
    expect(view.lines[2]).toBe('核对 1 回合（核对人，每轮 1 回合，最多 3 轮）');
  });

  it('token 区间：换算后下限与上限写法相同时只写一个；小于 1000 原样写数字；不再出现「万」「不到 1 万」', () => {
    expect(estimateCardOf({ ...DEFAULT_ESTIMATE, tokenLow: 380_000, tokenHigh: 380_400 }, { executorName: 'a', reviewerName: null, hasLaunch: false }).headline).toBe('9 回合，约 380K token。');
    expect(estimateCardOf({ ...DEFAULT_ESTIMATE, tokenLow: 0, tokenHigh: 900 }, { executorName: 'a', reviewerName: null, hasLaunch: false }).headline).toBe('9 回合，约 0 到 900 token。');
    expect(estimateCardOf({ ...DEFAULT_ESTIMATE, tokenLow: 1_640_000, tokenHigh: 2_100_000 }, { executorName: 'a', reviewerName: null, hasLaunch: false }).headline).toBe('9 回合，约 1.64M 到 2.1M token。');
    for (const text of Object.values(estimateCardOf(DEFAULT_ESTIMATE, { executorName: 'a', reviewerName: 'b', hasLaunch: true }).lines)) expect(text).not.toMatch(/万/);
  });

  it('真实约定：待确认的版本取 draft（执行者、核对人写通用称呼）；派活后取这件事的人、有发布步骤时多一行；旧约定（没有预计）和被取代的旧版本没有这一段', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    const pending = fix.ctx.store.table('agreements').list()[0]!;
    const draftView = agreementCardView(fix.ctx, pending, pending.versions[0]!);
    expect(draftView.estimate).toMatchObject({ title: '预计消耗', basisLine: '首次估计：没有同类事的记录，按每一步的默认份额估计。' });
    expect(draftView.estimate!.lines.slice(0, 3)).toEqual(['对齐 1 回合（总管，已用）', '执行 3 回合（执行者）', '核对 1 回合（核对人，每轮 1 回合，最多 3 轮）']);
    // 旧约定：没有预计，这一段不出现（视图上没有 estimate 键，含义等同 null；这样既有的插件预览快照逐字不变）。
    fix.ctx.store.table('jobEstimates').remove(pending.id);
    const legacy = agreementCardView(fix.ctx, pending, pending.versions[0]!);
    expect(legacy.estimate ?? null).toBeNull();
    expect('estimate' in legacy).toBe(false);
    // 被取代的版本：不显示。
    fix.ctx.store.table('jobEstimates').put({ id: pending.id, versions: [DEFAULT_ESTIMATE] });
    expect(agreementCardView(fix.ctx, pending, { ...pending.versions[0]!, state: 'superseded' }).estimate ?? null).toBeNull();

    const other = await jobFix();
    const { job, agreementId } = await assigned(other, { launch: true });
    const agreement = other.ctx.store.table('agreements').get(agreementId)!;
    const locked = agreementCardView(other.ctx, agreement, agreement.versions.find(row => row.state === 'locked')!);
    expect(locked.estimate!.lines).toEqual([
      '对齐 1 回合（总管，已用）',
      '执行 3 回合（林舟）',
      '核对 1 回合（评审甲，每轮 1 回合，最多 3 轮）',
      '返工预留 3 回合（核对不通过时使用；未用到的不消耗）',
      '总管预留 1 回合（回答员工的问题）',
      '对外发布另计，最多 4 回合。',
    ]);
    // 总管自己核对：核对一行写「总管核对」。
    other.ctx.store.table('jobs').patch(job.id, { reviewerId: null });
    expect(agreementCardView(other.ctx, agreement, agreement.versions.find(row => row.state === 'locked')!).estimate!.lines[2]).toBe('核对 1 回合（总管核对，每轮 1 回合，最多 3 轮）');
  });
});

describe('2 进度行第三行与明细（逐字）', () => {
  it('对齐中：没有预计「消耗：已用 2 回合（对齐）」，有预计前面加「预计 9 回合，」', () => {
    expect(costLineOf(usage({ align: [2, 0] }), null, {}, TZ, true).costLine).toBe('消耗：已用 2 回合（对齐）');
    expect(costLineOf(usage({ align: [2, 0] }), DEFAULT_ESTIMATE, {}, TZ, true).costLine).toBe('消耗：预计 9 回合，已用 2 回合（对齐）');
  });

  it('执行中（只有对齐和执行）：只写回合数大于 0 的项，对齐总写；token 带单位', () => {
    const line = costLineOf(usage({ align: [1, 120_000], exec: [2, 400_000] }), DEFAULT_ESTIMATE, {}, TZ).costLine;
    expect(line).toBe('消耗：3 / 9 回合，已用 520K token　对齐 1，执行 2');
  });

  it('返工之后（含返工与核对）：分布按固定顺序列出回合数大于 0 的项；发布另列', () => {
    const rework = usage({ align: [1, 120_000], exec: [3, 1_000_000], review: [2, 300_000], rework: [1, 220_000], launch: [1, 80_000] });
    expect(costLineOf(rework, DEFAULT_ESTIMATE, {}, TZ).costLine).toBe('消耗：7 / 9 回合，已用 1.72M token　对齐 1，执行 3，核对 2，返工 1，发布 1'); // P84（K5）：已用不含发布回合，分布仍列「发布 1」
    const chief = usage({ align: [1, 0], exec: [1, 0], chief: [2, 0] });
    expect(costLineOf(chief, DEFAULT_ESTIMATE, {}, TZ).costLine).toBe('消耗：4 / 9 回合，已用 0 token　对齐 1，执行 1，总管 2');
  });

  it('没有预计：「消耗：已用 {used} 回合，{x} token」；小于 1000 的原样写数字', () => {
    expect(costLineOf(usage({ align: [1, 120_000], exec: [2, 400_000] }), null, {}, TZ).costLine).toBe('消耗：已用 3 回合，520K token');
    expect(costLineOf(usage({ align: [1, 100], exec: [1, 200] }), null, {}, TZ).costLine).toBe('消耗：已用 2 回合，300 token');
  });

  it('没有用量行（旧数据）：没有这一行，明细为空', () => {
    expect(costLineOf(null, DEFAULT_ESTIMATE, {}, TZ)).toEqual({ costLine: null, costTurns: [] });
  });

  it('明细一行：时间「M月D日 HH:mm」（北京时间）、名字、中文步骤、「380K token」；还没记账写「进行中」；已删除的员工写「已删除的员工」', () => {
    const at = Date.UTC(2026, 10, 13, 2, 5); // 北京时间 11 月 13 日 10:05
    const rows = costTurnRows(usage({}, { turns: [
      { wakeId: 'w_0000000001', step: 'exec', botId: 'b_0000000002', startedAt: at, endedAt: at + 60_000, tokens: 380_000 },
      { wakeId: 'w_0000000002', step: 'review', botId: 'b_0000000003', startedAt: at + 120_000, endedAt: null, tokens: 0 },
      { wakeId: 'w_0000000003', step: 'chief', botId: 'b_0000000009', startedAt: at + 180_000, endedAt: at + 200_000, tokens: 900 },
    ] }), { b_0000000002: '林舟', b_0000000003: '评审甲' }, TZ);
    expect(rows).toEqual([
      { at: '11月13日 10:05', who: '林舟', step: '执行', tokens: '380K token' },
      { at: '11月13日 10:07', who: '评审甲', step: '核对', tokens: '进行中' },
      { at: '11月13日 10:08', who: '已删除的员工', step: '总管', tokens: '900 token' },
    ]);
  });

  it('真实流程：对齐中、已交付两种进度行', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    expect(jobProgressForTopic(fix.ctx, agreement.topicId)).toMatchObject({ costLine: '消耗：预计 9 回合，已用 1 回合（对齐）', costTurns: [] });
    const done = await delivered();
    const progress = jobProgressForTopic(done.fix.ctx, done.job.topicId)!;
    // P87：派活的回合是你说「定了」之后总管执行的，单列一栏：「已用 x token」之后、分布之前多一句，明细多一行「你发起」（六步的数字不变）。
    expect(progress.costLine).toMatch(/^消耗：3 \/ 9 回合，已用 \S+ token，另有你发起的 1 回合 \S+ token　对齐 1，执行 1，核对 1$/);
    expect(progress.costLine).not.toMatch(/万/);
    expect(progress.costTurns).toHaveLength(3);
    expect(progress.costTurns![0]).toMatchObject({ who: '老大', step: '你发起', tokens: '500 token' });
    expect(progress.costTurns![1]).toMatchObject({ who: '林舟', step: '执行', tokens: '500 token' });
    expect(progress.costTurns![2]).toMatchObject({ who: '评审甲', step: '核对', tokens: '500 token' });
  });
});

describe('3 回执第六行与总管唤醒包一行（逐字）', () => {
  it('有预计「{实际} 回合，预计 {total}；约 {x} token」；没有预计「{实际} 回合；约 {x} token」', () => {
    const row = usage({ align: [1, 140_000], exec: [4, 1_500_000] }, { finalUsed: 7, finalTokens: 1_640_000 });
    expect(receiptCostValue(row, DEFAULT_ESTIMATE)).toBe('7 回合，预计 9；约 1.64M token');
    expect(receiptCostValue(row, null)).toBe('7 回合；约 1.64M token');
    expect(receiptCostValue(usage({}, { finalUsed: 5, finalTokens: 380_000 }), null)).toBe('5 回合；约 380K token');
    expect(receiptCostValue(usage({}, { finalUsed: 1, finalTokens: 999 }), null)).toBe('1 回合；约 999 token');
  });

  it('没有定稿数的旧行按现有合计；没有用量行时不加这一行', () => {
    expect(receiptCostValue(usage({ align: [1, 100_000], exec: [2, 280_000] }), DEFAULT_ESTIMATE)).toBe('3 回合，预计 9；约 380K token');
    expect(receiptCostValue(null, DEFAULT_ESTIMATE)).toBeNull();
  });

  it('真实流程：回执卡有第六行，记录里仍只有五行；验收之后发布的回合不计入「实际」', async () => {
    const { fix, job } = await delivered([], { launch: true });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const stored = fix.ctx.store.table('jobs').get(job.id)!;
    expect(stored.receipt!.map(row => row.label)).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本']);
    const card = receiptCardView(fix.ctx, `receipt:${job.id}`)!;
    expect(card.rows).toHaveLength(6);
    // P87：派活的回合是你说「定了」之后总管执行的，末尾多一句「另有你发起的 1 回合，约 {x} token」；前半句不变。
    expect(card.rows[5]).toMatchObject({ label: '消耗', value: expect.stringMatching(/^3 回合，预计 9；约 \S+ token；另有你发起的 1 回合，约 \S+ token$/) });
    // 发布这一步又记了回合：回执的数字不变。
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, launch: { turns: 3, tokens: 777_000 } } });
    expect(receiptCardView(fix.ctx, `receipt:${job.id}`)!.rows[5]!.value).toBe(card.rows[5]!.value);
  });

  it('总管唤醒包：已用 / 预计；没有预计时只写已用', () => {
    expect(chiefCostLine(usage({ align: [1, 0], exec: [2, 0], launch: [1, 0] }), DEFAULT_ESTIMATE)).toBe('消耗：已用 4 / 预计 9 回合');
    expect(chiefCostLine(usage({ align: [1, 0], exec: [2, 0] }), null)).toBe('消耗：已用 3 回合');
    expect(chiefCostLine(null, null)).toBe('消耗：已用 0 回合');
  });

  it('真实流程：执行链唤醒的总管段和一览里都有这一行', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    expect(latestEstimate(fix.ctx, agreementId)!.total).toBe(9);
    const body = chiefChainBody(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!, name => name, []);
    expect(body.head[1]).toBe('消耗：已用 1 / 预计 9 回合');
  });
});

describe('4 给主人看的文字不含内部编号、工具名、英文步骤名', () => {
  it('预计、进度行、明细、回执里的句子一律书面中文', async () => {
    const texts: string[] = [];
    const card = estimateCardOf(DEFAULT_ESTIMATE, { executorName: '林舟', reviewerName: '评审甲', hasLaunch: true });
    texts.push(card.title, card.headline, ...card.lines, card.basisLine, card.footer);
    const row = usage({ align: [1, 100_000], exec: [2, 400_000], review: [1, 100_000], rework: [1, 100_000], chief: [1, 1], launch: [1, 1] }, { finalUsed: 7, finalTokens: 700_000, turns: [
      { wakeId: 'w_0000000001', step: 'exec', botId: 'b_0000000002', startedAt: 1, endedAt: 2, tokens: 5 }] });
    const view = costLineOf(row, DEFAULT_ESTIMATE, { b_0000000002: '林舟' }, TZ);
    texts.push(view.costLine!, ...view.costTurns.flatMap(item => Object.values(item)));
    texts.push(costLineOf(row, null, {}, TZ).costLine!, costLineOf(row, DEFAULT_ESTIMATE, {}, TZ, true).costLine!, receiptCostValue(row, DEFAULT_ESTIMATE)!);
    for (const text of texts) expect(text, text).not.toMatch(/job_|agr_|b_[0-9a-z]|w_[0-9a-z]|\b(?:exec|review|rework|launch|chief|align|token(?:s|Low|High))\b(?!$)/);
    // token 一词本身是单位，只允许作为「… token」出现。
    expect(texts.join('')).not.toMatch(/万/);
  });
});
