/** 总管团队视图与异常感知：不调用模型，仅把已发生的卡住、超时、隔离事实聚合给总管。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { formatDuration } from '../util/time.js';
import { recordPercept } from '../perception/percept.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { auditTool } from '../tools/common.js';
/** 汇总各机器人当前状态、等待对象和超时交接，供总管了解团队实际进度。 */
export function teamSummary(ctx: HubContext): string {
    const now = ctx.clock.now();
    const bots = ctx.store.table('bots').list(b => b.lifecycle !== 'retired');
    const lines = bots.map(bot => {
        const questions = ctx.store.table('inbox').list(i => i.botId === bot.id && i.status === 'open' && ['question', 'approval'].includes(i.type));
        const handoffs = ctx.store.table('handoffs').list(h => h.from === bot.id && h.status === 'offered');
        const waiting = questions.length ? '在等主人' : handoffs.length ? `在等 ${[...new Set(handoffs.map(h => ctx.store.table('bots').get(h.to)?.name ?? h.to))].join('、')}` : '没有在等人';
        const blocked = bot.activity === 'blocked' ? `；已卡住 ${formatDuration(Math.max(0, now - blockedSince(ctx, bot.id, now)))}` : '';
        return `${bot.name}：${bot.activityText || bot.activity}；${waiting}${blocked}`;
    });
    const overdue = ctx.store.table('handoffs').list(h => h.status === 'offered' && now - h.createdAt >= ctx.settings.handoffWaitingMs);
    lines.push(`超时交接：${overdue.length ? overdue.map(h => `[${h.id}] ${h.task}（等待 ${formatDuration(now - h.createdAt)}）`).join('；') : '无'}`);
    return lines.join('\n');
}
/** 从连续受阻交账回溯阻塞开始时刻，避免最近一次刷新掩盖长期停滞。 */
function blockedSince(ctx: HubContext, botId: string, now: number): number {
    const commits = ctx.store.table('commits').list(c => c.botId === botId && c.createdAt <= now).sort((a, b) => b.createdAt - a.createdAt);
    const recentBlocked: number[] = [];
    for (const c of commits) {
        if (c.outcome !== 'blocked')
            break;
        recentBlocked.push(c.createdAt);
    }
    return recentBlocked.length ? Math.min(...recentBlocked) : ctx.store.table('bots').get(botId)!.updatedAt;
}
/** 相同事件只报告一次；告警事实持久化，重启不会再次把旧隔离当新事件。 */
export function checkTeamSignals(ctx: HubContext, now: number): void {
    parseInput(z.number().int(), now, '当前时间');
    const chiefs = ctx.store.table('bots').list(b => b.role === 'chief' && ['active', 'probation'].includes(b.lifecycle));
    if (!chiefs.length)
        return;
    const facts: Array<{
        key: string;
        summary: string;
        refId: string;
    }> = [];
    for (const bot of ctx.store.table('bots').list()) {
        if (bot.activity === 'blocked' && now - blockedSince(ctx, bot.id, now) >= ctx.settings.c03.blockedChiefAfterMs)
            facts.push({ key: `blocked:${bot.id}:${blockedSince(ctx, bot.id, now)}`, summary: `${bot.name} 卡住超过 24 小时：${bot.activityText}`, refId: bot.id });
        const quarantineEvent = ctx.store.log('audit').recent(1, a => a.action === 'quarantine_event' && a.detail === bot.id && a.at <= now)[0];
        if (bot.lifecycle === 'quarantined')
            facts.push({ key: `quarantined:${bot.id}:${quarantineEvent?.id ?? bot.updatedAt}`, summary: `${bot.name} 已隔离：${bot.quarantineReason ?? '安全保护'}`, refId: bot.id });
    }
    for (const h of ctx.store.table('handoffs').list(h => h.status === 'offered' && now - h.createdAt >= ctx.settings.handoffWaitingMs))
        facts.push({ key: `handoff:${h.id}`, summary: `交接「${h.task}」超过接收时限`, refId: h.id });
    for (const chief of chiefs)
        for (const fact of facts) {
            const key = `${chief.id}:${fact.key}`;
            if (ctx.store.log('audit').all().some(a => a.action === 'chief_signal' && a.detail === key))
                continue;
            const percept = recordPercept(ctx, { botId: chief.id, watchId: null, source: 'system', kind: 'team_attention', summary: fact.summary,
                location: fact.refId, fingerprintMaterial: key, magnitude: 1, anomaly: false, untrusted: false, occurredAt: now });
            if (percept) {
                const score = percept.salience;
                enqueue(ctx, buildCandidate(ctx, { botId: chief.id, kind: 'percept', score, summary: fact.summary, evidence: [percept.id], subjectKey: fact.key }));
            }
            auditTool(ctx, chief.id, 'chief_signal', key);
        }
}
