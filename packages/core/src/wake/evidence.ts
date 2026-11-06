/** 唤醒证据还原可读事实；中心生成的来源、时间和记录类型可信，外部引文单独保留信任标记。 */
import type { HubContext } from '../engine/context.js';
import { formatShort, formatDuration } from '../util/time.js';
export interface PacketEvidence {
    text: string;
    untrusted: boolean;
    quote?: string;
    suffix?: string;
    original?: string;
    missing?: boolean;
}
/** 只取完整字符并折叠换行，避免长摘要或多行标题吞掉其他证据。 */
function excerpt(text: string, limit?: number): string {
    return (limit === undefined ? text : [...text].slice(0, limit).join('')).replace(/\r?\n/g, ' / ');
}
/** 按证据类型查回事实；所有机器人专属记录都核对归属，过期或越权 id 只显示缺失。 */
export function packetEvidence(ctx: HubContext, botId: string, id: string, now: number): PacketEvidence {
    const when = (at: number) => formatShort(at, now, 'Asia/Shanghai');
    const percept = ctx.store.table('percepts').get(id);
    if (percept?.botId === botId) {
        // 审批可能在排队期间已执行、撤回或过期，历史感知不能重新发出旧的批准口令。
        const summary = percept.kind === 'approval_decided' ? '主人审批结果已有更新，当前状态见审批结果节'
            : excerpt(percept.summary, ctx.settings.c03.packetPerceptChars);
        return percept.untrusted
            ? { text: `${percept.source}：`, quote: summary, suffix: `（${when(percept.createdAt)}）`, untrusted: true, original: percept.summary }
            : { text: `${percept.source}：${summary}（${when(percept.createdAt)}）`, untrusted: false };
    }
    const message = ctx.store.log('thread').all().find(m => m.id === id);
    if (message && (message.thread === botId || message.thread === 'team')) {
        const untrusted = !['owner', 'hub'].includes(message.from);
        return untrusted
            ? { text: '线程：', quote: excerpt(message.text), suffix: `（${when(message.createdAt)}）`, untrusted, original: message.text }
            : { text: `线程：${excerpt(message.text)}（${when(message.createdAt)}）`, untrusted };
    }
    const agenda = ctx.store.table('agenda').get(id);
    if (agenda?.botId === botId) {
        const suffix = `（到期 ${agenda.dueAt === null ? '等事件' : when(agenda.dueAt)}）`;
        return agenda.source === 'peer'
            ? { text: '议程：', quote: excerpt(agenda.title), suffix, untrusted: true, original: agenda.title }
            : { text: `议程：${excerpt(agenda.title)}${suffix}`, untrusted: false };
    }
    const aspiration = ctx.store.table('aspirations').get(id);
    if (aspiration?.botId === botId)
        return { text: `志向：${excerpt(aspiration.text, ctx.settings.c03.packetAspirationChars)}`, untrusted: false };
    const goal = ctx.store.table('goals').get(id);
    if (goal?.botId === botId)
        return { text: `目标：${excerpt(goal.title)}`, untrusted: false };
    const inbox = ctx.store.table('inbox').get(id);
    if (inbox?.botId === botId)
        return { text: `你问过主人：${excerpt(inbox.title)} → 主人答：${excerpt(inbox.answer ?? '尚未回答')}`, untrusted: false };
    const approval = ctx.store.table('approvals').get(id);
    if (approval?.botId === botId) {
        const statuses = { pending: '待审批', approved: '已批准', rejected: '已拒绝', expired: '已过期', used: '已使用' };
        return { text: `审批单：${approval.tool} ${statuses[approval.status]}`, untrusted: false };
    }
    const downtime = ctx.store.table('downtime').get(id);
    if (downtime)
        return { text: `停机：${when(downtime.from)}，共 ${formatDuration(downtime.to - downtime.from)}`, untrusted: false };
    return { text: '（记录已过期）', untrusted: false, missing: true };
}
