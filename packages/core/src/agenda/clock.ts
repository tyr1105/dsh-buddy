/** 意图时钟只发现到期理由：不投递、不消费议程，由调度器统一经过预算和额度闸门。 */
import type { HubContext } from '../engine/context.js';
import { agendaUrgency, buildCandidate, type Candidate } from '../appraisal/think.js';

/** 一个机器人可以有多个时间理由；随后入队时按最高分合并，证据全部保留。 */
export function collectTimeCandidates(ctx: HubContext, now: number): Candidate[] {
  const candidates: Candidate[] = [];
  // 本次同步计算不改唤醒单或议程；各取一次事实，避免每个机器人都深复制整张历史表。
  const busyBots = new Set(ctx.store.table('wakes').list(w => w.endedAt === null
    && ['running', 'delivering', 'committed'].includes(w.status)).map(w => w.botId));
  const agenda = ctx.store.table('agenda').list(item => item.status === 'open');
  for (const bot of ctx.store.table('bots').list(item => item.lifecycle === 'active' || item.lifecycle === 'probation')) {
    // 未交账或仍在等宿主终态时，不再预约旧时钟的第二轮。
    if (busyBots.has(bot.id)) continue;
    const add = (candidate: Candidate): void => {
      if (candidate.variant === 'light_check' || candidate.reason.score >= candidate.reason.threshold) candidates.push(candidate);
    };
    for (const item of agenda.filter(item => item.botId === bot.id)) {
      const score = agendaUrgency(item, now, ctx.settings);
      if (score <= 0) continue;
      const due = item.dueAt !== null && item.dueAt <= now;
      add(buildCandidate(ctx, { botId: bot.id, kind: 'agenda_due', score,
        summary: `议程「${item.title}」${due ? '已到期' : '将在一小时内到期'}`,
        evidence: [item.id], agendaId: item.id, toOwner: item.toOwner && due, now }));
    }
    if (bot.nextThinkAt !== null && bot.nextThinkAt <= now) {
      add(buildCandidate(ctx, { botId: bot.id, kind: 'next_think', score: ctx.settings.c02.nextThinkScore,
        subjectKey: `next_think:${bot.id}:${bot.nextThinkAt}`,
        summary: `已到机器人约定的下次思考时间：${bot.nextThinkReason ?? '继续检查进展'}`, now }));
    }
    if (bot.lightCheckAt !== null && bot.lightCheckAt <= now) {
      add(buildCandidate(ctx, { botId: bot.id, kind: 'light_check', variant: 'light_check',
        subjectKey: `light_check:${bot.id}:${bot.lightCheckAt}`,
        score: ctx.settings.c02.lightCheckScore, summary: '距上次思考已到最长间隔，做一次轻复查',
        ownerSummary: '做一次轻复查', now }));
    }
  }
  return candidates;
}
