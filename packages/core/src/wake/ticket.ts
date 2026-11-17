/** 唤醒单先占投递位置：成功投递时间由宿主编排补写，避免失败投递被当成真实思考。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { QueueEntrySchema, type QueueEntry, type WakeTicket } from '../model/wake.js';
import { nonempty } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { countJobTurn } from '../job/turns.js';
import { countSkillTurn } from '../skill/run.js';
/** 先保存可追踪的投递中唤醒单，成功投递时间由宿主编排另行确认。 */
export function createTicket(ctx: HubContext, input: QueueEntry, sessionId: string | null): WakeTicket {
    const entry = parseInput(QueueEntrySchema, input, '唤醒候选');
    parseInput(nonempty.nullable(), sessionId, '会话');
    const bot = ctx.store.table('bots').get(entry.botId);
    if (!bot)
        throw new Error('唤醒候选 botId 对应的机器人不存在');
    const now = ctx.clock.now();
    // P75f：连续未交账不再强制转成复盘回合（旧复盘触发已全部下线），唤醒单保持候选本来的变体。
    const ticket: WakeTicket = { id: newId('w', ctx.rng), botId: bot.id, sessionId,
        variant: entry.variant,
        ...(entry.topicId ? { topicId: entry.topicId } : {}),
        // P74：执行链的唤醒带着是哪件事，交账时据此把回复落到这件事的主题。
        ...(entry.jobId ? { jobId: entry.jobId } : {}),
        // P76b：总管为主人派出的活；候选上为真才写，不为真就不写这个键（旧数据的形状不变）。
        ...(entry.chiefDispatch === true ? { chiefDispatch: true } : {}),
        // P76r1：主人亲手作出决定之后的接续回合；同样只在为真时才写这个键。
        ...(entry.ownerDecided === true ? { ownerDecided: true } : {}),
        // P76r1 小修：重试的原回合是不是自己发起；true 和 false 都带（没有就不写键）。
        ...(entry.retryOfSelfWork !== undefined ? { retryOfSelfWork: entry.retryOfSelfWork } : {}),
        reason: entry.reason, subjectKey: entry.subjectKey, ownerInitiated: entry.ownerInitiated,
        dispatchedAt: null, packetBytes: 0, status: 'delivering', startedAt: now, lastEventAt: now,
        endedAt: null, steps: 0, tokens: 0, tokensKnown: false, steeredAt: null, awaitingApprovalAt: null,
        commitId: null, error: null };
    ctx.store.table('wakes').put(ticket);
    // P74c：执行链的回合在这里计数（一处写入、一处函数，见 job/turns.ts）。
    countJobTurn(ctx, ticket);
    // P75g：技能类回合（复盘、核对、整理）在这里计数——所属记录 turnsUsed 加一、参与者改 running。
    countSkillTurn(ctx, ticket);
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
    return ticket;
}
