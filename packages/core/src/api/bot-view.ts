/** 机器人详情将档案、注意力、历史理由和记忆组装成只读视图，保留提议中记录供主人理解。 */
import { ownerReasonSummary } from '../util/owner-text.js';
import type { HubContext } from '../engine/context.js';
import { AGENDA_KIND_LABELS, APPRAISAL_DECISION_LABELS, AUTONOMY_LABELS, GOAL_PERIOD_LABELS, GOAL_STATUS_LABELS,
  OUTCOME_LABELS, PACE_PROFILE_LABELS, VARIANT_LABELS, WATCH_KIND_LABELS } from '../model/enums.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { readMemorySummary } from '../memory/files.js';
import { formatDuration } from '../util/time.js';
import { formatExpectation } from '../util/expectation-text.js';
import { botCard, botStats } from './summary-views.js';
import { agoTime, requireBot, shortTime } from './common.js';
import type { BotView } from './types.js';

/** 每条时间同时给格式化文案和毫秒；内存摘要从注入文件接口读取，不暴露整个文件系统。 */
export async function botView(ctx: HubContext, botId: string): Promise<BotView> {
  const bot = requireBot(ctx, botId);
  return { card: botCard(ctx, bot), profile: { persona: bot.persona, autonomy: bot.autonomy, autonomyLabel: AUTONOMY_LABELS[bot.autonomy],
    pace: bot.pace, paceLabel: PACE_PROFILE_LABELS[bot.pace], model: bot.model, modelText: bot.model ? `${bot.model.provider} / ${bot.model.model}` : '跟随宿主默认模型',
    homeDir: bot.homeDir, sessionId: bot.sessionId, createdAt: bot.createdAt, createdText: shortTime(ctx, bot.createdAt)!,
    probationAt: bot.probationEndsAt, probationText: shortTime(ctx, bot.probationEndsAt), workDataAllowed: bot.workDataAllowed },
    aspirations: ctx.store.table('aspirations').list(row => row.botId === botId).map(row => ({ id: row.id, text: row.text, status: row.status })),
    goals: ctx.store.table('goals').list(row => row.botId === botId).map(row => ({ id: row.id, title: row.title, doneWhen: row.doneWhen,
      period: row.period, periodAt: row.periodEndsAt, periodText: `${GOAL_PERIOD_LABELS[row.period]}${row.periodEndsAt === null ? '' : `，截至${shortTime(ctx, row.periodEndsAt)}`}`,
      status: row.status, statusLabel: GOAL_STATUS_LABELS[row.status], lastProgressAt: row.lastProgressAt,
      lastProgressText: agoTime(ctx, row.lastProgressAt)!, createdBy: row.createdBy })),
    agenda: ctx.store.table('agenda').list(row => row.botId === botId).sort((a, b) => a.priority - b.priority || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
      .map(row => ({ id: row.id, kind: row.kind, kindLabel: AGENDA_KIND_LABELS[row.kind], title: row.title, dueAt: row.dueAt,
        dueText: shortTime(ctx, row.dueAt), priority: row.priority, toOwner: row.toOwner, source: row.source, status: row.status })),
    watches: ctx.store.table('watches').list(row => row.botId === botId).map(row => ({ id: row.id, kind: row.kind, kindLabel: WATCH_KIND_LABELS[row.kind],
      target: row.target, filter: row.filter, intervalMs: row.intervalMs, intervalText: row.intervalMs === null ? null : formatDuration(row.intervalMs),
      expectationText: row.expectation ? formatExpectation(row.expectation) : null,
      status: row.status, createdBy: row.createdBy, why: row.why, lastCheckedAt: row.lastCheckedAt, lastCheckedText: agoTime(ctx, row.lastCheckedAt) })),
    routines: ctx.store.table('routines').list(row => row.botId === botId).map(row => ({ id: row.id, name: row.name, whenToUse: row.whenToUse,
      steps: row.steps, runs: row.runs, updatedAt: row.updatedAt, updatedText: shortTime(ctx, row.updatedAt)! })),
    rules: ctx.store.table('rules').list(row => (row.scope === botId || row.scope === 'global') && row.status === 'active')
      .map(row => ({ id: row.id, text: row.text, redLine: row.redLine, scope: row.scope === 'global' ? 'global' : 'bot' })),
    memoryExcerpt: await readMemorySummary(ctx, bot),
    wakes: ctx.store.table('wakes').list(row => row.botId === botId).reverse().sort((a, b) => b.startedAt - a.startedAt).slice(0, C04_DEFAULTS.VIEW_WAKE_LIMIT).map(row => {
      const commit = row.commitId ? ctx.store.table('commits').get(row.commitId) : null;
      const durationMs = row.endedAt === null ? null : Math.max(0, row.endedAt - row.startedAt);
      return { id: row.id, variant: row.variant, variantLabel: VARIANT_LABELS[row.variant], reasonKind: row.reason.kind,
        reasonText: ownerReasonSummary(row.reason, ctx), score: row.reason.score, threshold: row.reason.threshold, status: row.status,
        outcome: commit?.outcome ?? null, outcomeLabel: commit ? OUTCOME_LABELS[commit.outcome] : null, summary: commit?.summary ?? null,
        steps: row.steps, tokens: row.tokens, durationMs, durationText: durationMs === null ? null : formatDuration(durationMs),
        startedAt: row.startedAt, timeText: shortTime(ctx, row.startedAt)!, startedText: shortTime(ctx, row.startedAt)! };
    }),
    appraisals: ctx.store.log('appraisals').recent(C04_DEFAULTS.VIEW_APPRAISAL_LIMIT, row => row.botId === botId).map(row => ({ id: row.id,
      at: row.at, timeText: shortTime(ctx, row.at)!, decision: row.decision, decisionLabel: APPRAISAL_DECISION_LABELS[row.decision],
      suppressedBy: row.suppressedBy, text: row.text, score: row.score, threshold: row.threshold })),
    stats: botStats(ctx, botId) };
}
