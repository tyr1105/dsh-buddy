/** 日报只拼装现有事实，不唤醒模型；按本地日统计并将安静时段或预算拦下的内容补给主人。 */
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { timestamp } from '../model/primitives.js';
import { OUTCOME_LABELS, QUOTA_LIGHT_LABELS, WAKE_KIND_LABELS } from '../model/enums.js';
import { formatDuration, isInQuietHours, localDateKey, localParts, startOfLocalDay } from '../util/time.js';
import { isExpectationCheckDay } from '../util/expectation-calendar.js';
import { expectationEffectiveAt, isExpectationStartedOnDay } from '../util/expectation-effective.js';
import { formatExpectation } from '../util/expectation-text.js';
import { approvalActionText } from '../util/action-text.js';
import { quotaProtectionText } from '../quota/window.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
import { postThread } from './thread.js';
import { pushHistory, type PushAudit } from './push.js';
import { optionalMessageText } from '../util/text.js';
import { proposalAnswer } from './inbox-options.js';
/** 计数按输入事实聚合，零条也显示，主人可以区分“没有变化”和日报丢失。 */
function counts(values: string[]): string {
    const result = new Map<string, number>();
    for (const value of values)
        result.set(value, (result.get(value) ?? 0) + 1);
    return [...result].map(([name, count]) => `${name} ${count} 次`).join('、') || '无';
}
/** 检查问题是否已在日报提醒过，避免每天重复催问同一事项。 */
function reminded(ctx: HubContext, id: string): boolean {
    return ctx.store.log('audit').all().some(row => row.action === 'question_digest_reminded' && readAuditDetail<{
        id: string;
    }>(row.detail)?.id === id);
}
/** 汇报正文是给主人的内容；审批仍只展示动作标题，避免把末行原始参数带进日报。 */
function deferredPushText(ctx: HubContext, row: PushAudit): string {
    const reason = row.result === 'deferred_quiet' ? '免打扰已推迟' : '超出打扰预算';
    if (row.title !== '机器人汇报') return `- ${row.title}（${reason}）`;
    // 只取首句并按完整字符限长；英文小数和域名中的点不当作句号。
    const firstSentence = row.body.trim().match(/^.*?(?:[。！？!?]|\.(?=\s|$)|[\r\n]|$)/u)?.[0].trim() ?? '';
    const summary = Array.from(firstSentence).slice(0, ctx.settings.c03.deferredReportMaxChars).join('');
    const name = row.botId ? ctx.store.table('bots').get(row.botId)?.name : null;
    return `- ${name ?? '队友'}的汇报：${summary}（${reason}）`;
}
/** 从昨日回合、等待事项和通知审计拼装日报，完整保留没有变化和仍未解决的事实。 */
export function buildDigest(ctx: HubContext, now: number): string {
    now = parseInput(timestamp, now, '日报时间');
    const today = startOfLocalDay(now, ctx.settings.timezone);
    // 退到今日午夜前一毫秒再取日首，夏令时的昨天也只包含一个本地自然日。
    const yesterday = startOfLocalDay(today - 1, ctx.settings.timezone);
    const lines = [`团队日报 ${localDateKey(now, ctx.settings.timezone)}`, `统计昨日：${localDateKey(yesterday, ctx.settings.timezone)}`];
    for (const bot of ctx.store.table('bots').list()) {
        const wakes = ctx.store.table('wakes').list(row => row.botId === bot.id && row.startedAt >= yesterday && row.startedAt < today && row.dispatchedAt !== null);
        const commits = ctx.store.table('commits').list(row => row.botId === bot.id && row.createdAt >= yesterday && row.createdAt < today);
        // notify_owner 与交账 report 是同一汇报语义，合并后按正文去重再取最高重要度的三条。
        const outboxReports = ctx.store.table('outbox').list(row => row.botId === bot.id && row.kind === 'notify_owner' && row.status === 'done'
            && (row.doneAt ?? row.createdAt) >= yesterday && (row.doneAt ?? row.createdAt) < today && typeof row.payload.text === 'string')
            .map(row => ({ report: row.payload.text as string, importance: typeof row.payload.importance === 'number' ? row.payload.importance : 1, createdAt: row.doneAt ?? row.createdAt }));
        const seenReports = new Set<string>();
        const reports = [...commits.map(row => ({ report: row.report, importance: row.importance, createdAt: row.createdAt })), ...outboxReports]
            // 历史空值与文字 null 在排序取前三条之前排除，避免挤掉真正的重要汇报。
            .flatMap(row => {
                const report = optionalMessageText(row.report);
                return report === null ? [] : [{ ...row, report }];
            })
            .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
            .filter(row => {
            if (seenReports.has(row.report))
                return false;
            seenReports.add(row.report);
            return true;
        }).slice(0, ctx.settings.c03.digestReportLimit);
        lines.push(`\n${bot.name}`, `昨天醒了 ${wakes.length} 次；为什么醒：${counts(wakes.map(row => WAKE_KIND_LABELS[row.reason.kind]))}`, `交账结果：${counts(commits.map(row => OUTCOME_LABELS[row.outcome]))}`);
        lines.push(...reports.map(row => `${row.importance >= ctx.settings.c03.reportDigestImportance ? '重点汇报' : '汇报'}：${row.report}`));
        const goalChanges = ctx.store.log('audit').since(yesterday, row => row.at < today && row.actor === bot.id && row.action === 'hub_goal_upsert' && /^\S+\s+active\s/.test(row.detail));
        lines.push(...goalChanges.map(row => `目标变更：${row.detail.replace(/^\S+\s+active\s+/, '')}`));
        for (const watch of ctx.store.table('watches').list(row => row.botId === bot.id && row.status === 'active' && row.expectation !== null)) {
            const expectation = watch.expectation!;
            const label = expectation.weekdays == null ? expectation.text : formatExpectation(expectation);
            // 昨日已记录的落空是事实；后来改星期、改期限或暂停恢复都不能抹去它。
            const lastMissedDueAts = expectation.lastMissedDueAts ?? [expectation.lastMissedDueAt ?? expectation.lastMissedAt];
            // 同时设置间隔和钟点时，一次补报可能包含两个本地日的期限；不能只看最早期限而丢掉另一日。
            const inYesterday = (dueAt: number | null) => dueAt !== null && dueAt >= yesterday && dueAt < today;
            const missed = (expectation.lastMissedAt !== null && lastMissedDueAts.some(inYesterday))
                || ctx.store.table('percepts').count(row => row.watchId === watch.id && row.kind === 'expectation_missed'
                    && (row.dueAts ?? [row.dueAt ?? row.createdAt]).some(inYesterday)) > 0;
            if (missed) {
                lines.push(`期望「${label}」：【未出现】（${watch.target}）`);
                continue;
            }
            // 资格只看被统计的昨天；今天休息不能让昨天的结果从日报里消失。
            if (!isExpectationCheckDay(expectation.weekdays, yesterday, ctx.settings.timezone)) {
                lines.push(`期望「${label}」：昨日不检查（${watch.target}）`);
                continue;
            }
            // 新增或重新启用的期望不能追溯要求生效前已到期的事情。
            if (!isExpectationStartedOnDay(watch, yesterday, ctx.settings.timezone)) {
                lines.push(`期望「${label}」：昨日尚未开始检查（${watch.target}）`);
                continue;
            }
            const expectationFrom = Math.max(yesterday, expectationEffectiveAt(watch));
            // 最新时间可能已被今早的事件覆盖；优先使用带日期的满足审计和落空感知还原昨天。
            const satisfied = (expectation.lastSatisfiedAt !== null && expectation.lastSatisfiedAt >= expectationFrom && expectation.lastSatisfiedAt < today)
                || ctx.store.log('audit').since(expectationFrom, row => row.action === 'expectation_satisfied' && row.at < today)
                    .some(row => readAuditDetail<{
                    watchId: string;
                }>(row.detail)?.watchId === watch.id);
            lines.push(`期望「${label}」：${satisfied ? '已出现' : '【未出现】'}（${watch.target}）`);
        }
        for (const item of ctx.store.table('inbox').list(row => row.botId === bot.id && row.type === 'question' && row.status === 'open')) {
            const waited = Math.max(0, now - item.createdAt);
            lines.push(`在等主人：${item.title}，已等 ${formatDuration(waited)}${waited >= ctx.settings.questionReminderMs && !reminded(ctx, item.id) ? '（日报提醒：已超过 24 小时）' : ''}`);
        }
        const pending = ctx.store.table('approvals').list(row => row.botId === bot.id && row.status === 'pending');
        lines.push(`待审批：${pending.map(row => `${approvalActionText(row, ctx.settings.c03.actionCommandMaxChars)}：${row.why}`).join('；') || '无'}`);
    }
    const quota = ctx.store.table('quota').get('quota');
    const alerts = ctx.store.table('alerts').list(row => row.status === 'open');
    // 日报在本轮调度之前生成，额度期限以当前时刻计算，不能复用昨日写下的相对时间。
    lines.push(`\n告警：${alerts.map(row => `[${row.level}] ${row.code === 'quota' && quota?.light === 'red'
        ? quotaProtectionText(quota, now, ctx.settings.timezone) : row.text}`).join('；') || '无'}`);
    const downtime = ctx.store.table('downtime').list(row => row.to >= yesterday && row.from <= now)
        .reduce((total, row) => total + Math.max(0, Math.min(row.to, now) - Math.max(row.from, yesterday)), 0);
    lines.push(`停机时长：${formatDuration(downtime)}`);
    lines.push(`额度用量：${quota ? `${quota.botTurns}/${quota.turnLimit} 回合，${quota.botTokens}${quota.tokenLimit === null ? '' : `/${quota.tokenLimit}`} token，${QUOTA_LIGHT_LABELS[quota.light]}` : '尚未使用'}`);
    const deferred = pushHistory(ctx).filter(row => row.at >= yesterday && row.at <= now && ['deferred_quiet', 'over_budget'].includes(row.result))
        // 曾被推迟的旧空汇报也不能从审计正文重新进入日报，其他通知保留原语义。
        .filter(row => row.title !== '机器人汇报' || optionalMessageText(row.body) !== null);
    if (deferred.length)
        lines.push('\n未单独推送', ...deferred.map(row => deferredPushText(ctx, row)));
    if (localParts(now, ctx.settings.timezone).weekday === 0) {
        const proposals = ctx.store.table('inbox').list(row => row.type === 'proposal' && row.createdAt >= now - ctx.settings.c03.weekMs && row.createdAt <= now);
        const decided = proposals.filter(row => row.status === 'answered' && proposalAnswer(row.answer ?? '') !== null);
        const accepted = decided.filter(row => proposalAnswer(row.answer ?? '') === '接受').length;
        lines.push('\n本周点子池', ...proposals.filter(row => row.answer === 'idea_pool').map(row => `- ${row.title}：${row.body}`));
        if (!proposals.some(row => row.answer === 'idea_pool'))
            lines.push('无');
        lines.push(`提议接受率：${decided.length ? `${Math.round(accepted / decided.length * 100)}%（${accepted}/${decided.length}）` : '暂无已决提议'}`);
    }
    return lines.join('\n');
}
const digestLocks = new WeakMap<HubContext, Promise<unknown>>();
// 成功日报是不可撤销的事实；当日后续 tick 不必反复扫描全部审计正文。
const sentDays = new WeakMap<HubContext, string>();
/** 每天最多一条线程日报与一次成功通知；通知失败时复用已写线程而不重新生成内容。 */
export async function maybeSendDigest(ctx: HubContext, now: number): Promise<string | null> {
    now = parseInput(timestamp, now, '日报时间');
    const today = localDateKey(now, ctx.settings.timezone);
    if (sentDays.get(ctx) === today) return null;
    const previous = digestLocks.get(ctx) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
        const p = localParts(now, ctx.settings.timezone);
        const [hour, minute] = ctx.settings.digestAt.split(':').map(Number) as [
            number,
            number
        ];
        const day = localDateKey(now, ctx.settings.timezone);
        const due = p.hour * 60 + p.minute >= hour * 60 + minute;
        const sent = new Set(ctx.store.log('audit').all().filter(row => row.action === 'digest_sent')
            .map(row => readAuditDetail<{ day: string }>(row.detail)?.day));
        // 到点就把事实写进线程；跨午夜只推迟通知，不推迟或丢掉日报本身。
        let current = ctx.store.log('thread').all().find(row => row.kind === 'digest' && row.refId === `digest:${day}`);
        if (due && !current && !sent.has(day))
            current = postThread(ctx, { thread: 'team', from: 'hub', kind: 'digest', text: buildDigest(ctx, now), refId: `digest:${day}` });
        if (isInQuietHours(now, ctx.settings.quietHours, ctx.settings.timezone)) return null;
        const pending = ctx.store.log('thread').all().filter(row => row.kind === 'digest' && row.refId?.startsWith('digest:')
            && !sent.has(row.refId.slice('digest:'.length))).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!pending) {
            if (sent.has(day)) sentDays.set(ctx, day);
            return null;
        }
        const digestDay = pending.refId!.slice('digest:'.length);
        const digest = pending.text;
        // 日报直接调用宿主，免打扰已检查且不计入单推预算。
        await ctx.host.notify({ title: `团队日报 ${digestDay}`, body: digest, level: 'P2', botId: null });
        writeOutreachAudit(ctx, 'digest_sent', { day: digestDay }, 'hub', now);
        if (digestDay === day) sentDays.set(ctx, day);
        for (const item of ctx.store.table('inbox').list(row => row.type === 'question' && row.status === 'open' && now - row.createdAt >= ctx.settings.questionReminderMs)) {
            if (!reminded(ctx, item.id))
                writeOutreachAudit(ctx, 'question_digest_reminded', { id: item.id }, 'hub', now);
        }
        return digest;
    });
    digestLocks.set(ctx, operation);
    return operation;
}
