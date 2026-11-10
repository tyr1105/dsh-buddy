/** 每个持久化模型的最小真实样例：字段来自规格，测试可按字段破坏样例验证边界。 */
import * as m from '../src/model/index.js';
import { resolveSettings } from '../src/config/defaults.js';
import type { z } from 'zod';

export const id = (prefix: string) => `${prefix}_0000000001`;
const at = 1_793_808_000_000;
const botId = id('b');
export const botFixture: m.Bot = {
  id: botId, name: '研究员', role: 'researcher', persona: '先核实再给结论', color: '#6366f1',
  lifecycle: 'active', activity: 'watching', activityText: '正在关注公开信息', autonomy: 'L1', pace: 'normal', model: null,
  homeDir: `/hub/bots/${botId}`, sessionId: null, sessionStartedAt: null, createdAt: at, probationEndsAt: null,
  noChangeStreak: 0, lastThinkAt: null, nextThinkAt: null, nextThinkReason: null, nextThinkBy: null, nextThinkMode: null,
  lightCheckAt: null, expectedBy: null, consecutiveErrors: 0, consecutiveNoCommit: 0, violations: 0,
  retryAt: null, quarantineReason: null, workDataAllowed: false, presetSkillIds: [],
  dshSkillNames: [], temperament: null, speechStyle: null, brief: '', onDemand: false, updatedAt: at,
};
export const goalFixture: m.Goal = {
  id: id('g'), botId, aspirationId: id('asp'), title: '核实三条公开事实', doneWhen: '每条有可查看的来源', period: 'week',
  periodEndsAt: null, importance: 0.6, patienceMs: 172_800_000, status: 'active', verification: 'owner',
  lastProgressAt: at, createdBy: 'owner', createdAt: at, updatedAt: at,
};
export const watchFixture: m.Watch = {
  id: id('wt'), botId, kind: 'file', target: '/hub/shared/notes.txt', filter: null, intervalMs: null,
  expectation: null, relevance: 0.8, createdBy: 'owner', status: 'active', expiresAt: null,
  lastCheckedAt: null, lastFingerprint: null, lastValue: null, why: '关注资料更新', createdAt: at, updatedAt: at,
};
const reason: m.WakeReason = { kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', evidence: [id('p')] };
const nextThink: m.NextThink = { mode: 'auto', reason: '等待新的证据' };
const commit: m.Commit = {
  id: id('c'), wakeId: id('w'), botId, outcome: 'progress', summary: '核实了一条公开事实', worldChanges: [], evidence: [],
  verification: { level: 'program', notCovered: '尚未人工检查' }, blocker: null, nextThink, ownerQuestion: null,
  reply: null, report: null, importance: 5, proposals: [], createdAt: at,
};

// 非法样例使用各模型特有约束，而不只用 null 或缺字段蒙混过关。
function fixture(schema: z.ZodType, valid: unknown, invalid: unknown) { return { schema, valid, invalid }; }
export const modelFixtures = {
  ModelChoice: fixture(m.ModelChoiceSchema, { provider: 'provider', model: 'model' }, { provider: '', model: 'model' }),
  Bot: fixture(m.BotSchema, botFixture, { ...botFixture, persona: '长'.repeat(301) }),
  Aspiration: fixture(m.AspirationSchema,
    { id: id('asp'), botId, text: '掌握公开进展', status: 'active', createdBy: 'owner', approved: true, createdAt: at },
    { id: id('asp'), botId, text: '掌握公开进展', status: 'finished', createdBy: 'owner', approved: true, createdAt: at }),
  Goal: fixture(m.GoalSchema, goalFixture, { ...goalFixture, importance: 1.1 }),
  AgendaItem: fixture(m.AgendaItemSchema,
    { id: id('a'), botId, kind: 'task', title: '核对来源', goalId: null, dueAt: null, onEvent: null, abandonWhen: '资料撤回', priority: 1, toOwner: false, source: 'bot', status: 'open', note: null, createdAt: at, updatedAt: at },
    { id: id('a'), botId, kind: 'task', title: '核对来源', goalId: null, dueAt: null, onEvent: null, abandonWhen: '', priority: 6, toOwner: false, source: 'bot', status: 'open', note: null, createdAt: at, updatedAt: at }),
  Expectation: fixture(m.ExpectationSchema,
    { text: '上午有新资料', everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: null, lastMissedAt: null },
    { text: '上午有新资料', everyMs: null, byLocalTime: '25:00', weekdays: null, lastSatisfiedAt: null, lastMissedAt: null }),
  Watch: fixture(m.WatchSchema, watchFixture, { ...watchFixture, lastValue: '中'.repeat(1400) }),
  Percept: fixture(m.PerceptSchema,
    { id: id('p'), botId, watchId: id('wt'), source: 'file', kind: 'changed', summary: '增加一段文字', location: '/hub/shared/notes.txt', fingerprint: '0123456789abcdef', relevance: 0.8, novelty: 1, magnitude: 0.2, importance: 0.6, urgency: 0.5, anomaly: false, salience: 0.63, untrusted: true, tier: 'pile', consumedByWake: null, createdAt: at },
    { id: id('p'), botId, watchId: id('wt'), source: 'file', kind: 'changed', summary: '增加一段文字', location: '/hub/shared/notes.txt', fingerprint: 'INVALID', relevance: 0.8, novelty: 1, magnitude: 0.2, importance: 0.6, urgency: 0.5, anomaly: false, salience: 0.63, untrusted: true, tier: 'pile', consumedByWake: null, createdAt: at }),
  DriveState: fixture(m.DriveStateSchema,
    { id: botId, botId, stagnation: 0.8, obligation: 0, waiting: 0, frustration: 0, fatigue: 0.2, firedToday: 1, firedDay: '2026-11-05', snoozedUntil: { stagnation: at }, updatedAt: at },
    { id: id('b').replace(/1$/, '2'), botId, stagnation: 0.8, obligation: 0, waiting: 0, frustration: 0, fatigue: 0.2, firedToday: 1, firedDay: '2026-11-05', snoozedUntil: {}, updatedAt: at }),
  WakeReason: fixture(m.WakeReasonSchema, reason, { ...reason, score: -0.1 }),
  QueueEntry: fixture(m.QueueEntrySchema,
    { id: id('q'), botId, variant: 'regular', reason, priority: 50, urgent: false, ownerInitiated: false, subjectKey: '资料', notBefore: at, enqueuedAt: at },
    { id: id('q'), botId, variant: 'unknown', reason, priority: 50, urgent: false, ownerInitiated: false, subjectKey: '资料', notBefore: at, enqueuedAt: at }),
  WakeTicket: fixture(m.WakeTicketSchema,
    { id: id('w'), botId, sessionId: null, variant: 'regular', reason, ownerInitiated: false, packetBytes: 100, status: 'running', startedAt: at, lastEventAt: at, endedAt: null, steps: 1, tokens: 1000, steeredAt: null, commitId: null, error: null },
    { id: id('w'), botId, sessionId: null, variant: 'regular', reason, ownerInitiated: false, packetBytes: -1, status: 'running', startedAt: at, lastEventAt: at, endedAt: null, steps: 1, tokens: 1000, steeredAt: null, commitId: null, error: null }),
  NextThink: fixture(m.NextThinkSchema, nextThink, { ...nextThink, reason: '' }),
  Commit: fixture(m.CommitSchema, commit, { ...commit, proposals: [{ title: '建议', detail: '说明', value: 2, confidence: 0.5 }] }),
  ThreadMessage: fixture(m.ThreadMessageSchema,
    { id: id('m'), thread: botId, from: 'owner', kind: 'chat', text: '帮我看看', refId: null, createdAt: at, readAt: null },
    { id: id('m'), thread: botId, from: 'owner', kind: 'chat', text: 42, refId: null, createdAt: at, readAt: null }),
  InboxItem: fixture(m.InboxItemSchema,
    { id: id('i'), botId, type: 'question', title: '选哪项', body: '需要选择', options: ['继续', '停止'], defaultOption: '停止', priority: 'P1', status: 'open', answer: null, refId: null, subjectKey: '资料', pushed: false, createdAt: at, expiresAt: null, answeredAt: null },
    { id: id('i'), botId, type: 'question', title: '选哪项', body: '需要选择', options: ['继续', '停止'], defaultOption: '停止', priority: 'P9', status: 'open', answer: null, refId: null, subjectKey: '资料', pushed: false, createdAt: at, expiresAt: null, answeredAt: null }),
  Approval: fixture(m.ApprovalSchema,
    { id: id('ap'), botId, actionClass: 'C', tool: 'write', argsPreview: '{}', contentHash: 'a'.repeat(64), why: '写入交付物', status: 'pending', createdAt: at, decidedAt: null, expiresAt: at + 1, usedAt: null },
    { id: id('ap'), botId, actionClass: 'B', tool: 'write', argsPreview: '{}', contentHash: 'a'.repeat(64), why: '写入交付物', status: 'pending', createdAt: at, decidedAt: null, expiresAt: at + 1, usedAt: null }),
  OutboxAction: fixture(m.OutboxActionSchema,
    { id: id('o'), botId, kind: 'write_file', payload: { path: '/hub/report.md' }, why: '交付', actionClass: 'B', approvalId: null, status: 'ready', result: null, createdAt: at, doneAt: null },
    { id: id('o'), botId, kind: 'write_file', payload: [], why: '交付', actionClass: 'B', approvalId: null, status: 'ready', result: null, createdAt: at, doneAt: null }),
  Routine: fixture(m.RoutineSchema,
    { id: id('r'), botId, name: '核实', slug: '核实', whenToUse: '有新资料', steps: ['打开来源'], learnedFrom: null, runs: 0, lastRunAt: null, createdAt: at, updatedAt: at },
    { id: id('r'), botId, name: '核实', slug: '核实', whenToUse: '有新资料', steps: ['打开来源'], learnedFrom: null, runs: -1, lastRunAt: null, createdAt: at, updatedAt: at }),
  Mail: fixture(m.MailSchema,
    { id: id('ml'), from: botId, to: id('b'), text: '请复核', handoffId: null, createdAt: at, readAt: null },
    { id: id('ml'), from: '', to: id('b'), text: '请复核', handoffId: null, createdAt: at, readAt: null }),
  Handoff: fixture(m.HandoffSchema,
    { id: id('h'), from: botId, to: id('b'), task: '复核', files: [], status: 'offered', agendaId: null, createdAt: at, updatedAt: at },
    { id: id('h'), from: botId, to: id('b'), task: '复核', files: [7], status: 'offered', agendaId: null, createdAt: at, updatedAt: at }),
  Claim: fixture(m.ClaimSchema,
    { id: id('cl'), resource: '/hub/file', botId, why: '避免重复写入', expiresAt: at, createdAt: at },
    { id: id('cl'), resource: '/hub/file', botId, why: '避免重复写入', expiresAt: '明天', createdAt: at }),
  Rule: fixture(m.RuleSchema,
    { id: id('ru'), scope: 'global', text: '先核实', redLine: true, source: 'owner', status: 'active', createdAt: at },
    { id: id('ru'), scope: 'global', text: '先核实', redLine: 'true', source: 'owner', status: 'active', createdAt: at }),
  LedgerEntry: fixture(m.LedgerEntrySchema,
    { id: id('le'), who: botId, wakeId: id('w'), tokens: 1000, kind: 'turn', at },
    { id: id('le'), who: botId, wakeId: id('w'), tokens: -1000, kind: 'turn', at }),
  QuotaState: fixture(m.QuotaStateSchema,
    { id: 'quota', windowStartAt: at, botTurns: 0, botTokens: 0, turnLimit: 8, tokenLimit: null, light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null },
    { id: 'other', windowStartAt: at, botTurns: 0, botTokens: 0, turnLimit: 8, tokenLimit: null, light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null }),
  Alert: fixture(m.AlertSchema,
    { id: id('al'), botId: null, code: 'network', text: '网络失败', level: 'P2', count: 2, firstAt: at, lastAt: at, status: 'open' },
    { id: id('al'), botId: null, code: 'network', text: '网络失败', level: 'P2', count: 1.5, firstAt: at, lastAt: at, status: 'open' }),
  Downtime: fixture(m.DowntimeSchema,
    { id: id('d'), from: at, to: at + 100, kind: 'sleep', handled: false },
    { id: id('d'), from: at, to: at - 100, kind: 'sleep', handled: false }),
  AppraisalLog: fixture(m.AppraisalLogSchema,
    { id: id('ev'), botId, at, perceptIds: [], score: 0.8, threshold: 0.6, decision: 'suppressed', suppressedBy: 'quota', text: '额度保护' },
    { id: id('ev'), botId, at, perceptIds: [], score: 0.8, threshold: 0.6, decision: 'suppressed', suppressedBy: 'bad_reason', text: '额度保护' }),
  AuditEntry: fixture(m.AuditEntrySchema,
    { id: id('au'), at, actor: 'owner', action: '创建机器人', detail: '创建研究员' },
    { id: 'au_BAD', at, actor: 'owner', action: '创建机器人', detail: '创建研究员' }),
  Settings: fixture(m.SettingsSchema, resolveSettings(), { ...resolveSettings(), tickMs: -1 }),
  TurnLimits: fixture(m.TurnLimitsSchema, { steps: 30, durationMs: 1200000, tokens: 60000 }, { steps: 0, durationMs: 1200000, tokens: 60000 }),
  MessageSource: fixture(m.MessageSourceSchema, { kind: 'agent-hub', wakeId: id('w'), botId, variant: 'regular' }, { kind: 'other', wakeId: id('w'), botId, variant: 'regular' }),
  TurnEvent: fixture(m.TurnEventSchema, { type: 'step', sessionId: 'session-1', at, steps: 1, tokens: null }, { type: 'step', sessionId: 'session-1', at, steps: -1, tokens: null }),
  ExternalSessionEvent: fixture(m.ExternalSessionEventSchema, { type: 'finished', sessionId: 's', title: '资料', at, summary: '完成' }, { type: 'unknown', sessionId: 's', title: '资料', at, summary: '完成' }),
  GuardDecision: fixture(m.GuardDecisionSchema, { allow: false, message: '需审批' }, { allow: false }),
};
