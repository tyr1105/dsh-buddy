/** 同伴事件共用校验与入队：只接受在岗收件人，同伴正文始终视为外部资料。 */
import type { HubContext } from '../engine/context.js';
import type { Percept } from '../model/perception.js';
import { botIsArchived, type Bot } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES, ROLE_LABELS } from '../model/enums.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import type { ToolContext } from '../tools/types.js';
import { withLabel } from '../util/name-label.js';
import type { QueueEntry, WakeTicket } from '../model/index.js';
/** 从中心名册取得同伴身份，不存在时明确拒绝协作请求。 */
export function peerBot(ctx: HubContext, id: string) {
    const bot = ctx.store.table('bots').get(id);
    if (!bot)
        throw new Error(`机器人不存在：${id}`);
    return bot;
}
/**
 * P72j J2：按「机器人 id 或员工名字」找人，hub_send、hub_project_task_upsert 和（P74b 起）hub_job_manage 共用。
 * 为什么：唤醒包和状态里给总管看的只有名字，工具却只认 b_ 开头的 id，总管找不到人就派不了活。
 * 顺序：先按 id 精确匹配；否则按名字精确匹配（去掉首尾空白），范围是没有被删除（未退役、未归档）的员工。
 * 同名多位时拒绝并列出每位的 id 和角色；找不到时列出在岗员工。只负责「找到是谁」，在岗、不是自己等校验留给调用方。
 * @param field 报错前缀里的参数名，例如 to 或 assigneeBotId。
 */
export function resolveBotRef(ctx: HubContext, ref: string, field: string, exceptId?: string): Bot {
    const key = ref.trim();
    const byId = ctx.store.table('bots').get(key);
    if (byId)
        return byId;
    const named = ctx.store.table('bots').list(b => b.name.trim() === key && b.lifecycle !== 'retired' && !botIsArchived(b));
    if (named.length === 1)
        return named[0]!;
    if (named.length > 1) {
        const rows = named.map(b => `${b.id}（${ROLE_LABELS[b.role]}）`).join('、');
        throw new Error(`${field}：有 ${named.length} 位员工都叫「${key}」：${rows}。请改用机器人 id`);
    }
    const staff = ctx.store.table('bots').list(b => b.role !== 'chief' && b.id !== exceptId
        && (ON_TEAM_LIFECYCLES as readonly string[]).includes(b.lifecycle) && !botIsArchived(b));
    const listed = staff.length ? `在岗的员工：${staff.map(b => withLabel(b.name, ROLE_LABELS[b.role])).join('、')}。写名字即可` : '目前没有在岗的员工';
    throw new Error(`${field}：没有叫「${key}」的员工。${listed}`);
}
/** 核对发件人与收件人并要求对方在岗，防止发给自己或无法处理的机器人；收件人可写名字或 id。 */
export function peerRecipient(ctx: HubContext, from: string, to: string) {
    peerBot(ctx, from);
    const recipient = resolveBotRef(ctx, to, 'to', from);
    if (from === recipient.id)
        throw new Error('to：不能给自己发同伴消息或交接');
    if (!['active', 'probation'].includes(recipient.lifecycle))
        throw new Error(`to：收件人「${recipient.name}」当前不在岗`);
    return recipient;
}
/**
 * P72l：这次同伴消息或交接，是不是「总管在主人发起的回合里派出的活」。
 * 为什么：主人确认过的事，员工应当立即开工，不该再等最短思考间隔。三个条件缺一不可：
 * 发件人是总管；发件的这个回合由主人发起（以唤醒单上已有的 ownerInitiated 为准）；调用方是 hub_send
 * （P74b 起派活走 hub_job_manage，它在服务层自己要求主人发起的回合，入队时一律带这个标记）。
 * 取本回合唤醒单的口径与 hub-agreement-submit 一致：有 wakeId 用它，没有就找该员工当前打开的唤醒单。
 */
export function isChiefOwnerTurn(ctx: HubContext, tc: ToolContext): boolean {
    const sender = ctx.store.table('bots').get(tc.botId);
    if (!sender || sender.role !== 'chief')
        return false;
    return wakeOfToolContext(ctx, tc)?.ownerInitiated === true;
}
/**
 * 本次工具调用所在回合的唤醒单（P74b 从上面抽出，派活工具也要用）：
 * 宿主给了 wakeId 就用它；没给就找这个员工当前打开的唤醒单。找不到返回 null。
 */
export function wakeOfToolContext(ctx: HubContext, tc: ToolContext): WakeTicket | null {
    return tc.wakeId
        ? ctx.store.table('wakes').get(tc.wakeId)
        : ctx.store.table('wakes').list(row => row.botId === tc.botId && row.sessionId === tc.sessionId
            && (['running', 'delivering'].includes(row.status) || (row.status === 'committed' && row.endedAt === null)))
            .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}
/**
 * 把有效同伴感知转成带事项键的候选，复用统一评分和调度闸门。
 * P72l：ownerSummary 是给主人看的短句（状态栏、动态、唤醒账本用），模型看的 summary 不变；
 * chiefDispatch 见 isChiefOwnerTurn，只让这一条候选越过冷却和最短思考间隔。
 */
export function enqueuePeerPercept(ctx: HubContext, percept: Percept | null, opts: { ownerSummary?: string; chiefDispatch?: boolean; directed?: boolean; jobId?: string } = {}): QueueEntry | null {
    if (!percept)
        return null;
    // P73r3 S1：directed 表示这是 hub_send、派活（hub_job_manage）指名发给某位员工的，入队时不看思考门槛；返回值告诉调用方是否真的入队。
    return enqueue(ctx, buildCandidate(ctx, { botId: percept.botId, kind: 'peer_message', score: percept.salience,
        summary: percept.summary, evidence: [percept.id], source: percept.source, perceptKind: percept.kind,
        subjectKey: `peer:${percept.location ?? percept.id}`,
        ...(opts.ownerSummary ? { ownerSummary: opts.ownerSummary } : {}),
        ...(opts.chiefDispatch ? { chiefDispatch: true } : {}),
        // P74b：派活、改派、恢复在岗时带上这是哪件事的唤醒（P74c 起由统一的入队函数接手）。
        ...(opts.jobId ? { jobId: opts.jobId } : {}) }), { directed: opts.directed === true });
}
