/** 机器人详情将档案、注意力、历史理由和记忆组装成只读视图，保留提议中记录供主人理解。 */
import { ownerReasonSummary } from '../util/owner-text.js';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { AGENDA_KIND_LABELS, APPRAISAL_DECISION_LABELS, AUTONOMY_LABELS, GOAL_PERIOD_LABELS, GOAL_STATUS_LABELS,
  OUTCOME_LABELS, PACE_PROFILE_LABELS, VARIANT_LABELS, WATCH_KIND_LABELS } from '../model/enums.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { mbtiLabel } from '../model/mbti.js';
import { legacyRulesOf, memoriesForBot } from '../memory/memory-read.js';
import { sortMemories } from '../memory/render-memory.js';
import { formatDuration } from '../util/time.js';
import { byteLength, truncateBytes } from '../util/text.js';
import { formatExpectation } from '../util/expectation-text.js';
import { botCard, botStats } from './summary-views.js';
import { agoTime, requireBot, shortTime } from './common.js';
import type { BotView } from './types.js';
import { ARTIFACT_CHECK_LABELS, RESULT_VERDICT_LABELS } from '../model/result-check.js';
import { artifactList } from '../artifacts/views.js';
import { botMbti } from '../personality/profile.js';
import { personalityBehavior } from '../personality/behavior.js';

/**
 * 长期记忆摘录按整行截到字节上限以内（P75r3，恢复 P75f 之前 readMemorySummary 的 1.5 KB 上限）：
 * 放不下的行整行丢掉，末尾写「已截断」；连第一行都放不下时退回按字节截断。字节数一律按 UTF-8 算。
 */
function excerptByLines(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const tail = '\n…（已截断）';
  const budget = maxBytes - byteLength(tail);
  const kept: string[] = [];
  let used = 0;
  for (const row of text.split('\n')) {
    const cost = byteLength(row) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(row);
    used += cost;
  }
  return kept.length > 0 ? `${kept.join('\n')}${tail}` : truncateBytes(text, maxBytes);
}

/** 每条时间同时给格式化文案和毫秒；内存摘要从注入文件接口读取，不暴露整个文件系统。 */
export async function botView(ctx: HubContext, botId: string): Promise<BotView> {
  const bot = requireBot(ctx, botId);
  // MBTI 存在独立档案表；没有档案行按未设置显示，不替旧机器人补默认型。
  const mbti = botMbti(ctx, botId);
  // 一次建立 wakeId → 账本 id 的索引，避免每条唤醒都全表扫描。
  const ledgerByWake = new Map(ctx.store.table('wakeLedger').list().map(row => [row.wakeId, row.id]));
  const checks = ctx.store.table('resultChecks').list(row => row.botId === botId).reverse().sort((a, b) => b.createdAt - a.createdAt);
  return { artifacts: await artifactList(ctx, botId, { kind: 'owner' }),
    card: botCard(ctx, bot), profile: { persona: bot.persona, mbti, mbtiLabel: mbtiLabel(mbti), behavior: personalityBehavior(mbti, ctx.settings),
    autonomy: bot.autonomy, autonomyLabel: AUTONOMY_LABELS[bot.autonomy],
    pace: bot.pace, paceLabel: PACE_PROFILE_LABELS[bot.pace], model: bot.model, modelText: bot.model ? `${bot.model.provider} / ${bot.model.model}` : '跟随宿主默认模型',
    homeDir: bot.homeDir, sessionId: bot.sessionId, createdAt: bot.createdAt, createdText: shortTime(ctx, bot.createdAt)!,
    // P73a：没有试岗这一步，这两项固定为 null（字段保留是为了兼容界面类型）。
    probationAt: null, probationText: null, workDataAllowed: bot.workDataAllowed,
    presetSkillIds: [...bot.presetSkillIds], dshSkillNames: [...bot.dshSkillNames],
    temperament: bot.temperament, speechStyle: bot.speechStyle, brief: bot.brief, onDemand: bot.onDemand },
    aspirations: ctx.store.table('aspirations').list(row => row.botId === botId).map(row => ({ id: row.id, text: row.text, status: row.status })),
    goals: ctx.store.table('goals').list(row => row.botId === botId).map(row => ({ id: row.id, title: row.title, doneWhen: row.doneWhen,
      period: row.period, periodAt: row.periodEndsAt, periodText: `${GOAL_PERIOD_LABELS[row.period]}${row.periodEndsAt === null ? '' : `，截至${shortTime(ctx, row.periodEndsAt)}`}`,
      status: row.status, statusLabel: GOAL_STATUS_LABELS[row.status], lastProgressAt: row.lastProgressAt,
      lastProgressText: agoTime(ctx, row.lastProgressAt)!, createdBy: row.createdBy,
      checkText: (() => {
        const check = checks.find(item => item.goals.some(goal => goal.id === row.id));
        if (!check) return '尚无中心实查记录';
        const verdict = check.decisions.find(item => item.goalId === row.id);
        return verdict ? RESULT_VERDICT_LABELS[verdict.verdict]
          : `中心实查：${check.artifacts.map(item => ARTIFACT_CHECK_LABELS[item.status]).join('；') || '未提供可实查的交付位置'}；内容待你验收`;
      })() })),
    agenda: ctx.store.table('agenda').list(row => row.botId === botId).sort((a, b) => a.priority - b.priority || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
      .map(row => ({ id: row.id, kind: row.kind, kindLabel: AGENDA_KIND_LABELS[row.kind], title: row.title, dueAt: row.dueAt,
        dueText: shortTime(ctx, row.dueAt), priority: row.priority, toOwner: row.toOwner, source: row.source, status: row.status })),
    watches: ctx.store.table('watches').list(row => row.botId === botId).map(row => ({ id: row.id, kind: row.kind, kindLabel: WATCH_KIND_LABELS[row.kind],
      target: row.target, filter: row.filter, intervalMs: row.intervalMs, intervalText: row.intervalMs === null ? null : formatDuration(row.intervalMs),
      expectationText: row.expectation ? formatExpectation(row.expectation) : null,
      status: row.status, createdBy: row.createdBy, why: row.why, lastCheckedAt: row.lastCheckedAt, lastCheckedText: agoTime(ctx, row.lastCheckedAt) })),
    routines: ctx.store.table('routines').list(row => row.botId === botId).map(row => ({ id: row.id, name: row.name, whenToUse: row.whenToUse,
      steps: row.steps, runs: row.runs, updatedAt: row.updatedAt, updatedText: shortTime(ctx, row.updatedAt)! })),
    // P75r1：先列记忆（形状不变：文字与是否红线），再接旧规矩表里仍要读的规矩（迁移完成之前一并生效；已有对应记忆的不重复）。
    rules: [
      ...sortMemories(ctx, memoriesForBot(ctx, bot)).map(row => ({ id: row.id, text: row.text, redLine: row.redLine, scope: row.scope.staff === 'all' ? 'global' as const : 'bot' as const })),
      ...legacyRulesOf(ctx, bot).map(row => ({ id: row.id, text: row.text, redLine: row.redLine, scope: row.scope === 'global' ? 'global' as const : 'bot' as const })),
    ],
    // P75f：长期记忆文件已停用；视图仍显示这个文件现在的内容（迁移完成后是那一句停用说明）。
    // P75r3：恢复原来的截断（上限取设置里的 memorySummaryMaxBytes，默认 1.5 KB）：迁移未完成或失败时，这个文件还是员工自己写的原文，不能整个发给界面。
    memoryExcerpt: excerptByLines((await ctx.fs.readText(posix.join(bot.homeDir, 'memory', 'MEMORY.md')) ?? '').trim() || '尚无长期记忆。', ctx.settings.memorySummaryMaxBytes),
    wakes: ctx.store.table('wakes').list(row => row.botId === botId).reverse().sort((a, b) => b.startedAt - a.startedAt).slice(0, C04_DEFAULTS.VIEW_WAKE_LIMIT).map(row => {
      const commit = row.commitId ? ctx.store.table('commits').get(row.commitId) : null;
      const durationMs = row.endedAt === null ? null : Math.max(0, row.endedAt - row.startedAt);
      return { id: row.id, variant: row.variant, variantLabel: VARIANT_LABELS[row.variant], reasonKind: row.reason.kind,
        reasonText: ownerReasonSummary(row.reason, ctx), score: row.reason.score, threshold: row.reason.threshold, status: row.status,
        outcome: commit?.outcome ?? null, outcomeLabel: commit ? OUTCOME_LABELS[commit.outcome] : null, summary: commit?.summary ?? null,
        steps: row.steps, tokens: row.tokens, durationMs, durationText: durationMs === null ? null : formatDuration(durationMs),
        startedAt: row.startedAt, timeText: shortTime(ctx, row.startedAt)!, startedText: shortTime(ctx, row.startedAt)!,
        ledgerId: ledgerByWake.get(row.id) ?? null, hasLedger: ledgerByWake.has(row.id) };
    }),
    appraisals: ctx.store.log('appraisals').recent(C04_DEFAULTS.VIEW_APPRAISAL_LIMIT, row => row.botId === botId).map(row => ({ id: row.id,
      at: row.at, timeText: shortTime(ctx, row.at)!, decision: row.decision, decisionLabel: APPRAISAL_DECISION_LABELS[row.decision],
      suppressedBy: row.suppressedBy, text: row.text, score: row.score, threshold: row.threshold })),
    stats: botStats(ctx, botId) };
}
