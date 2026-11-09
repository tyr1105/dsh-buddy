/** 同伴事件共用校验与入队：只接受在岗收件人，同伴正文始终视为外部资料。 */
import type { HubContext } from '../engine/context.js';
import type { Percept } from '../model/perception.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
/** 从中心名册取得同伴身份，不存在时明确拒绝协作请求。 */
export function peerBot(ctx: HubContext, id: string) {
    const bot = ctx.store.table('bots').get(id);
    if (!bot)
        throw new Error(`机器人不存在：${id}`);
    return bot;
}
/** 核对发件人与收件人并要求对方在岗，防止发给自己或无法处理的机器人。 */
export function peerRecipient(ctx: HubContext, from: string, to: string) {
    peerBot(ctx, from);
    const recipient = peerBot(ctx, to);
    if (from === to)
        throw new Error('to：不能给自己发同伴消息或交接');
    if (!['active', 'probation'].includes(recipient.lifecycle))
        throw new Error('to：收件人当前不在岗');
    return recipient;
}
/** 把有效同伴感知转成带事项键的候选，复用统一评分和调度闸门。 */
export function enqueuePeerPercept(ctx: HubContext, percept: Percept | null): void {
    if (!percept)
        return;
    enqueue(ctx, buildCandidate(ctx, { botId: percept.botId, kind: 'peer_message', score: percept.salience,
        summary: percept.summary, evidence: [percept.id], source: percept.source, perceptKind: percept.kind,
        subjectKey: `peer:${percept.location ?? percept.id}` }));
}
