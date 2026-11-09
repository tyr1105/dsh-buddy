/**
 * F14 用真实候选排队、提议路由和交账验证性格能影响行为。
 * 反例覆盖硬闸、重要消息和旧档，不能靠提示词出现某个数字冒充执行生效。
 */
import { describe, expect, it } from 'vitest';
import { F14_DEFAULTS, resolveSettings, resolveStartupSettings, thresholdFor } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';
import { saveBotMbti, botMbti } from '../src/personality/profile.js';
import { personalityBehavior, personalityThreshold } from '../src/personality/behavior.js';
import { buildCandidate, type CandidateInput } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { recordPercept } from '../src/perception/percept.js';
import { submitProposal, proposalResultText } from '../src/outreach/proposals.js';
import { readAuditDetail } from '../src/outreach/audit.js';
import { processCommit } from '../src/commit/process.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { byteLength } from '../src/util/text.js';
import { openLedgerForWake, sealLedgerForWake } from '../src/ledger/service.js';
import { wakeLedgerDetail } from '../src/api/ledger-views.js';
import { MBTI_TYPES } from '../src/model/enums.js';
import { AgendaItemSchema } from '../src/model/index.js';
import type { BotProfile, MbtiType } from '../src/model/index.js';

/** 只改独立性格档案，Bot 和假时钟保持完全相同。 */
function setup(mbti: MbtiType | null = null) {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, pace: 'normal', lifecycle: 'active', lastThinkAt: null });
  ctx.runtime.startedAt = ctx.clock.now() - 600_000;
  if (mbti !== null) saveBotMbti(ctx, botFixture.id, mbti);
  return ctx;
}
const ordinary = { botId: botFixture.id, kind: 'percept' as const, score: 0.62, summary: '有新证据' };
const suggestion = { title: '试试新方法', detail: '有明确证据和可验证结果', value: 0.65, confidence: 0.55 };

describe('普通自主门槛确实参与排队', () => {
  it('同一证据 E 入队、I 暂不入队，I 达到边界又可入队，记录真实门槛', () => {
    const active = setup('ENTJ'), quiet = setup('INTJ');
    expect(enqueue(active, buildCandidate(active, ordinary))).not.toBeNull();
    expect(enqueue(quiet, buildCandidate(quiet, ordinary))).toBeNull();
    expect(quiet.store.log('appraisals').all().at(-1)).toMatchObject({ threshold: 0.65, score: 0.62, decision: 'suppressed' });
    expect(enqueue(quiet, buildCandidate(quiet, { ...ordinary, score: 0.65 }))).not.toBeNull();
    expect(enqueue(quiet, buildCandidate(quiet, { ...ordinary, score: 0.6499 }))).toBeNull();
  });

  it.each(MBTI_TYPES)('%s 使用 E/I 而非其他三个字母，低于原底线都拒绝', type => {
    const ctx = setup(type);
    expect(enqueue(ctx, buildCandidate(ctx, ordinary)) === null).toBe(type.startsWith('I'));
    expect(enqueue(ctx, buildCandidate(ctx, { ...ordinary, score: 0.59 }))).toBeNull();
  });

  it('疲劳与节奏先按原公式计算，性格只在上面追加', () => {
    const ctx = setup('INTJ'), now = ctx.clock.now();
    for (let n = 0; n < 3; n++) ctx.store.log('ledger').append({ id: `le_test${n}`, who: botFixture.id, wakeId: null, tokens: 10, kind: 'turn', at: now });
    ctx.store.table('bots').patch(botFixture.id, { pace: 'quiet' });
    const candidate = buildCandidate(ctx, { ...ordinary, score: 0.8 });
    expect(candidate.reason.threshold).toBeCloseTo(thresholdFor(0.5, 'quiet', ctx.settings) + 0.05);
    expect(personalityThreshold(1.05, personalityBehavior('INTJ', ctx.settings), false)).toBe(1.05);
  });

  it.each([
    { kind: 'owner_message' }, { kind: 'inbox_reply' }, { kind: 'approval_decided' },
    { kind: 'light_check', variant: 'light_check' }, { kind: 'catch_up', variant: 'catch_up' },
    { kind: 'retry' }, { kind: 'trial', variant: 'trial' }, { kind: 'teach', variant: 'teach' },
    { kind: 'reflection', variant: 'reflection' }, { urgent: true }, { anomaly: true },
    { score: 0.90 }, { toOwner: true }, { ownerInitiated: true }, { kind: 'drive', driveName: 'obligation' },
  ] satisfies Partial<CandidateInput>[])('主人、紧急、承诺和特殊回合豁免 %#', patch => {
    const a = setup('INTJ'), b = setup('ENTJ');
    expect(buildCandidate(a, { ...ordinary, ...patch }).reason.threshold)
      .toBe(buildCandidate(b, { ...ordinary, ...patch }).reason.threshold);
  });

  it('真实议程的主人承诺不因候选省略 toOwner 被追加门槛', () => {
    const ctx = setup('INTJ');
    const agenda = AgendaItemSchema.parse(modelFixtures.AgendaItem.valid);
    ctx.store.table('agenda').put({ ...agenda, toOwner: true, dueAt: ctx.clock.now() });
    expect(buildCandidate(ctx, { ...ordinary, kind: 'agenda_due', agendaId: agenda.id }).reason.threshold).toBe(0.6);
  });

  it('I 和 E 仍受额度、日上限、冷却、最短间隔和等待主人硬闸约束', () => {
    for (const type of ['INTJ', 'ENTJ'] as const) {
      const ctx = setup(type), now = ctx.clock.now();
      const entry = enqueue(ctx, buildCandidate(ctx, { ...ordinary, score: 0.8 }))!;
      const snapshot = buildSnapshot(ctx, botFixture.id, now);
      expect(evaluateGates(entry, snapshot, now, ctx.settings)).toEqual({ pass: true });
      expect(evaluateGates(entry, { ...snapshot, quota: { ...snapshot.quota, light: 'red', probeAllowed: false } }, now, ctx.settings)).toMatchObject({ by: 'quota' });
      expect(evaluateGates(entry, { ...snapshot, todayTurns: 100 }, now, ctx.settings)).toMatchObject({ by: 'daily_cap' });
      expect(evaluateGates(entry, { ...snapshot, subjectWakeAt: new Map([[entry.subjectKey, now]]) }, now, ctx.settings)).toMatchObject({ by: 'cooldown' });
      expect(evaluateGates(entry, { ...snapshot, bot: { ...snapshot.bot!, lastThinkAt: now } }, now, ctx.settings)).toMatchObject({ by: 'pace_min' });
      expect(evaluateGates(entry, { ...snapshot, openOwnerAskCount: 1 }, now, ctx.settings)).toMatchObject({ by: 'waiting_owner' });
    }
  });

  it('感知记录与实际候选使用同一门槛，紧急和异常不会多加', () => {
    for (const anomaly of [false, true]) {
      const ctx = setup('INTJ'), now = ctx.clock.now();
      const percept = recordPercept(ctx, { botId: botFixture.id, watchId: null, source: 'http', kind: 'changed',
        summary: '页面有更新', location: 'https://example.test', fingerprintMaterial: 'new', magnitude: 0.4, anomaly, untrusted: true, occurredAt: now })!;
      const candidate = buildCandidate(ctx, { ...ordinary, score: percept.salience, evidence: [percept.id] });
      expect(ctx.store.log('appraisals').all().at(-1)?.threshold).toBe(candidate.reason.threshold);
      expect(candidate.reason.threshold).toBe(anomaly ? 0.6 : 0.65);
    }
  });
});

describe('提议去向与底线', () => {
  it('同一普通建议 E 待主人处理，I 进点子池；强证据 I 也能主动提议', async () => {
    const active = setup('ENTJ'), quiet = setup('INTJ');
    expect(await submitProposal(active, botFixture.id, suggestion)).toMatchObject({ status: 'open', answer: null });
    const pooled = (await submitProposal(quiet, botFixture.id, suggestion))!;
    expect(pooled).toMatchObject({ status: 'closed', answer: 'idea_pool' });
    expect(proposalResultText(quiet, pooled)).toContain('点子池');
    expect(quiet.store.log('thread').all().filter(row => row.kind === 'proposal')).toHaveLength(0);
    expect(await submitProposal(quiet, botFixture.id, { ...suggestion, title: '证据更充分', value: 0.7, confidence: 0.6 })).toMatchObject({ status: 'open' });
    const audit = quiet.store.log('audit').all().find(row => row.action === 'proposal_submitted')!;
    expect(readAuditDetail(audit.detail)).toMatchObject({ mbti: 'INTJ', minValue: 0.7, minConfidence: 0.6, admitted: false });
  });

  it.each([{ value: 0.6999, confidence: 1 }, { value: 1, confidence: 0.5999 }])('I 两个底线独立生效 %j', async scores => {
    const ctx = setup('INTJ');
    expect(await submitProposal(ctx, botFixture.id, { ...suggestion, ...scores })).toMatchObject({ answer: 'idea_pool' });
  });

  it('E 不能降低原价值/置信度底线，性格不能越过周上限与拒绝冷却', async () => {
    for (const type of ['ENTJ', 'INTJ'] as const) {
      const ctx = setup(type);
      expect(await submitProposal(ctx, botFixture.id, { ...suggestion, value: 0.59, confidence: 1 })).toMatchObject({ answer: 'idea_pool' });
      expect(await submitProposal(ctx, botFixture.id, { ...suggestion, title: '没把握', value: 1, confidence: 0.49 })).toMatchObject({ answer: 'idea_pool' });
      for (let n = 0; n < 3; n++) expect(await submitProposal(ctx, botFixture.id, { ...suggestion, title: `高价值${n}`, value: 1, confidence: 1 })).toMatchObject({ status: 'open' });
      expect(await submitProposal(ctx, botFixture.id, { ...suggestion, title: '本周第四条', value: 1, confidence: 1 })).toMatchObject({ answer: 'idea_pool' });
      const rejected = ctx.store.table('inbox').list(row => row.title === '高价值0')[0]!;
      ctx.store.table('inbox').patch(rejected.id, { status: 'closed', answer: '不做', answeredAt: ctx.clock.now() });
      expect(await submitProposal(ctx, botFixture.id, { ...suggestion, title: rejected.title, value: 1, confidence: 1 })).toBeNull();
    }
  });
});

describe('实际汇报与事实保存', () => {
  it.each(['INTJ', 'ENTJ'] as const)('%s 长汇报按策略节略，完整交账保留，回复/提问不变且重复交账不重复发', async type => {
    const { ctx, bot, toolCtx, ticket } = await turnContext();
    saveBotMbti(ctx, bot.id, type);
    openLedgerForWake(ctx, ticket.id, 0);
    const report = '结论：这是一份较长的报告。\n' + '𠮷事实与路径'.repeat(100);
    const reply = '完整回复'.repeat(100), question = '要你决定的选项'.repeat(50);
    const result = await processCommit(ctx, toolCtx, commitArgs({ report, reply, ownerQuestion: {
      text: question, whyNeeded: '需要主人选择', options: ['继续', '停止'], defaultOption: '停止',
    } }));
    expect(result.ok).toBe(true);
    const commit = ctx.store.table('commits').list()[0]!;
    expect(commit.report).toBe(report);
    const message = ctx.store.log('thread').all().find(row => row.kind === 'report')!;
    expect([...message.text]).toHaveLength(type.startsWith('I') ? 160 : 300);
    expect(message.text).toContain('汇报已节略');
    expect(message.refId).toBe(commit.id);
    expect(message.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(ctx.store.log('thread').all().find(row => row.kind === 'reply')?.text).toBe(reply);
    expect(ctx.store.table('inbox').list().find(row => row.type === 'question')?.title).toBe(question);
    expect(ctx.store.table('wakes').get(ticket.id)?.commitId).toBe(commit.id);
    // 使用真实账本封存和界面 API，确认节略只在消息，账本仍能读取原报告。
    ctx.store.table('wakes').patch(ticket.id, { endedAt: ctx.clock.now() });
    sealLedgerForWake(ctx, ticket.id);
    // 账本快照按 F01 压缩，详情从原交账读取全文；同时验证两者，不能放宽账本原有限额。
    const ledger = wakeLedgerDetail(ctx, ticket.id)!;
    expect(ledger.fullReport).toBe(report);
    expect(ledger.entry.truncated).toBe(true);
    expect(ledger.entry.decision?.report).not.toContain('汇报已节略');
    const before = ctx.store.log('thread').all().length;
    expect((await processCommit(ctx, toolCtx, commitArgs({ report }))).ok).toBe(false);
    expect(ctx.store.log('thread').all()).toHaveLength(before);
  });

  it.each(['owner', 'important', 'short', 'unset'] as const)('%s 汇报不节略', async kind => {
    const { ctx, bot, toolCtx, ticket } = await turnContext();
    if (kind !== 'unset') saveBotMbti(ctx, bot.id, 'INTJ');
    if (kind === 'owner') ctx.store.table('wakes').patch(ticket.id, { ownerInitiated: true });
    const report = kind === 'short' ? '已核实，无新变化。' : '需要完整展示的报告'.repeat(50);
    expect((await processCommit(ctx, toolCtx, commitArgs({ report, importance: kind === 'important' ? 9 : 5 }))).ok).toBe(true);
    expect(ctx.store.log('thread').all().find(row => row.kind === 'report')?.text).toBe(report);
    expect(ctx.store.log('audit').all().filter(row => row.action === 'personality_report_shortened')).toHaveLength(0);
  });

  it('原交账已过保留期时明确没有全文，不能把压缩快照冒充原文', async () => {
    const { ctx, bot, toolCtx, ticket } = await turnContext();
    saveBotMbti(ctx, bot.id, 'INTJ');
    openLedgerForWake(ctx, ticket.id, 0);
    expect((await processCommit(ctx, toolCtx, commitArgs({ report: '很长的汇报'.repeat(200) }))).ok).toBe(true);
    ctx.store.table('wakes').patch(ticket.id, { endedAt: ctx.clock.now() });
    sealLedgerForWake(ctx, ticket.id);
    const commit = ctx.store.table('commits').list()[0]!;
    ctx.store.table('commits').remove(commit.id);
    expect(wakeLedgerDetail(ctx, ticket.id)?.fullReport).toBeNull();
    expect(wakeLedgerDetail(ctx, ticket.id)?.entry.truncated).toBe(true);
  });
});

describe('旧档、生效时机与实际策略可见', () => {
  it('无档案/清空/脏值保留原规则，自由文本 persona 不猜性格', () => {
    const ctx = setup();
    ctx.store.table('bots').patch(botFixture.id, { persona: '外向活泼主动' });
    const original = buildCandidate(ctx, ordinary);
    expect(original.reason.threshold).toBe(0.6);
    saveBotMbti(ctx, botFixture.id, 'INTJ');
    expect(buildCandidate(ctx, ordinary).reason.threshold).toBe(0.65);
    saveBotMbti(ctx, botFixture.id, null);
    expect(buildCandidate(ctx, ordinary)).toEqual(original);
    ctx.store.table('botProfiles').put({ id: botFixture.id, botId: botFixture.id, mbti: 'INVALID', updatedAt: ctx.clock.now() } as unknown as BotProfile);
    expect(botMbti(ctx, botFixture.id)).toBeNull();
    expect(buildCandidate(ctx, ordinary)).toEqual(original);
    expect('mbti' in ctx.store.table('bots').get(botFixture.id)!).toBe(false);
  });

  it('更改影响新候选，不追溯重写已排队的历史门槛', () => {
    const ctx = setup('ENTJ');
    const previous = enqueue(ctx, buildCandidate(ctx, ordinary))!;
    saveBotMbti(ctx, botFixture.id, 'INTJ');
    expect(buildCandidate(ctx, ordinary).reason.threshold).toBe(0.65);
    expect(ctx.store.table('queue').get(previous.id)?.reason.threshold).toBe(0.6);
  });

  it('旧设置补默认、嵌套覆盖有效，负偏移和无界长度中文拒绝', () => {
    const old = { ...resolveSettings() } as Record<string, unknown>;
    delete old.personality;
    expect(resolveSettings(old).personality).toEqual(F14_DEFAULTS);
    const settings = resolveStartupSettings(old, { personality: { introvertWakeOffset: 0, introvertReportMaxChars: 80 } });
    expect(personalityBehavior('INTJ', settings)).toMatchObject({ wakeOffset: 0, reportMaxChars: 80, proposalMinValue: 0.7 });
    expect(() => resolveSettings({ personality: { introvertWakeOffset: -0.01 } })).toThrow('personality.introvertWakeOffset');
    expect(() => resolveSettings({ personality: { extrovertReportMaxChars: 501 } })).toThrow('普通汇报最多');
    expect(() => resolveSettings({ personality: { introvertReportMaxChars: 0 } })).toThrow('personality.introvertReportMaxChars');
  });

  it('API 档案读真实策略、可清空且无读副作用；唤醒包写实际数值并守 6KB', async () => {
    const { ctx, api } = await apiFixture();
    const bot = ctx.store.table('bots').list()[0]!;
    expect((await api.bot(bot.id)).profile.behavior).toBeNull();
    okData(await api.updateBot(bot.id, { mbti: 'INTJ' }));
    const before = ctx.store.log('audit').all();
    expect((await api.bot(bot.id)).profile.behavior).toMatchObject({ wakeOffset: 0.05, reportMaxChars: 160, proposalMinValue: 0.7, proposalMinConfidence: 0.6 });
    expect(ctx.store.log('audit').all()).toEqual(before);
    okData(await api.updateBot(bot.id, { mbti: null }));
    expect((await api.bot(bot.id)).profile.behavior).toBeNull();
    for (const type of ['INTJ', 'ENTJ'] as const) {
      const turn = await turnContext();
      saveBotMbti(turn.ctx, turn.bot.id, type);
      const packet = await buildWakePacket(turn.ctx, turn.bot, turn.entry, turn.ticket);
      expect(packet).toContain('## 本轮行为偏好');
      expect(packet).toContain(type === 'INTJ' ? '最多 160 字' : '最多 300 字');
      expect(packet).toContain('没有建议就不提');
      expect(packet).toContain('硬闸不变');
      expect(byteLength(packet)).toBeLessThanOrEqual(6144);
    }
  });
});
