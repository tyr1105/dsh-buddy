/** 将健康模块的开放告警同步到收件箱和线程；逐条隔离通知失败，恢复后关闭对应卡片。 */
import type { HubContext } from '../engine/context.js';
import { createInboxItem, closeAlertItem } from './inbox.js';
import { postThread } from './thread.js';
import { requestPush } from './push.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { reconcileOpenAlerts } from '../health/alerts.js';
import { writeOutreachAudit } from './audit.js';

/** 内部 code 只用于合并；主人看到稳定的中文名称，未知类型也不会暴露实现标记。 */
const alertNames: Readonly<Record<string, string>> = {
    quota: '额度', auth: '鉴权', deadman: '掉线', quarantine: '隔离',
    protected_verify: '受保护文件校验', host_approval_blocked: '宿主审批受阻', host_approval_wait: '宿主审批等待',
};

/** 把开放告警同步为主人可处理的卡片和线程消息，通知失败仅影响当前告警。 */
export async function syncAlertItems(ctx: HubContext): Promise<void> {
    const needsFreshCard = new Set<string>();
    // 旧档的重复故障也在本次同步修复；优先复用已有卡片，不能因选了新身份再推送一遍。
    for (const merged of reconcileOpenAlerts(ctx)) {
        const cards = ctx.store.table('inbox').list(item => item.type === 'alert' && item.refId !== null && merged.mergedIds.includes(item.refId));
        const retained = cards.find(item => item.refId === merged.id && item.status === 'open')
            ?? cards.find(item => item.status === 'open');
        // 旧档可能只有闭卡；告警仍开放时必须补一张，不能把闭卡当成主人还能处理的入口。
        if (!retained) { needsFreshCard.add(merged.id); continue; }
        for (const item of cards) if (item.id !== retained.id && item.status === 'open') {
            // 只关闭多余卡片，不能调用清零故障次数的恢复操作；这次是合并而非恢复。
            ctx.store.table('inbox').patch(item.id, { status: 'closed', answer: '同类告警已合并', answeredAt: ctx.clock.now() });
        }
        ctx.store.table('inbox').patch(retained.id, { refId: merged.id, pushed: cards.some(item => item.pushed) });
        writeOutreachAudit(ctx, 'alert_merged', { alertId: merged.id, previousAlertIds: merged.mergedIds, inboxId: retained.id });
        ctx.emit(HUB_EVENT_SCOPES.inbox, retained.botId);
        ctx.emit(HUB_EVENT_SCOPES.thread, retained.botId);
    }
    for (const alert of ctx.store.table('alerts').list()) {
        const cards = ctx.store.table('inbox').list(item => item.type === 'alert' && item.refId === alert.id)
            .reverse().sort((a, b) => b.createdAt - a.createdAt);
        const existing = cards.find(item => item.status === 'open') ?? cards[0];
        if (alert.status === 'closed') {
            if (existing?.status === 'open')
                closeAlertItem(ctx, existing.id, 'hub');
            continue;
        }
        const bot = alert.botId ? ctx.store.table('bots').get(alert.botId) : null;
        const title = `${bot?.name ?? '中心'}告警：${Object.hasOwn(alertNames, alert.code) ? alertNames[alert.code] : '异常'}`;
        // 兼容旧版本同 id 重开的存档；新发生的观测晚于关闭时间时补卡，重复 tick 不重复补。
        const reopened = existing && existing.status !== 'open'
            && alert.lastAt > (existing.answeredAt ?? existing.createdAt);
        if (existing && !reopened && !needsFreshCard.has(alert.id)) {
            // 同一告警合并次数时更新说明即可；主人已经关闭的卡片不在每个 tick 里重新打开。
            if (existing.title !== title || (existing.status === 'open' && existing.body !== alert.text)) {
                ctx.store.table('inbox').patch(existing.id, { title, ...(existing.status === 'open' ? { body: alert.text } : {}) });
                ctx.emit(HUB_EVENT_SCOPES.inbox, existing.botId);
                ctx.emit(HUB_EVENT_SCOPES.thread, existing.botId);
            }
            continue;
        }
        // 去重主题属于本轮卡片：恢复后的新轮故障仍按 P0/P1/P2 规则通知，不被旧轮的 24 小时去重吞掉。
        const item = createInboxItem(ctx, { botId: alert.botId, type: 'alert', title,
            body: alert.text, priority: alert.level, refId: alert.id,
            subjectKey: `alert:${alert.botId ?? 'hub'}:${alert.code}:${alert.episodeId ?? alert.id}:${existing?.id ?? 'first'}` });
        postThread(ctx, { thread: alert.botId ?? 'team', from: 'hub', kind: 'alert', text: alert.text, refId: item.id });
        // P2 只进收件箱与日报，不挤占提问、审批的单推预算。
        if (alert.level === 'P2') continue;
        try {
            const result = await requestPush(ctx, { botId: alert.botId, level: alert.level, title: item.title, body: alert.text, subjectKey: item.subjectKey });
            ctx.store.table('inbox').patch(item.id, { pushed: result === 'sent' });
        }
        catch (error) {
            ctx.logger.warn('告警已进收件箱，单推失败', String(error));
        }
    }
}
