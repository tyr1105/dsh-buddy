/** 同伴邮件记录：每对、每个方向按本地日独立限额，通知原文和可追溯的邮件一起保存。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { MailSchema, type Mail } from '../model/team.js';
import { byteLength } from '../util/text.js';
import { newId } from '../util/ids.js';
import { startOfLocalDay } from '../util/time.js';
import { recordPeerMessage } from '../perception/sources.js';
import { postThread } from '../outreach/thread.js';
import { assertNotOnJob } from '../job/guards.js';
import { chiefPendingNewBlock } from '../project/agreement-gate.js';
import { enqueuePeerPercept, peerBot, peerRecipient } from './common.js';
export const SendMailInputSchema = z.strictObject({ to: nonempty, text: nonempty });
/** 在每对每方向的日限额内保存同伴邮件，生成发送方私聊里的一条记录和收件方感知。 */
export async function sendMail(ctx: HubContext, from: string, input: z.infer<typeof SendMailInputSchema>, opts: { chiefDispatch?: boolean; report?: { queued: boolean } } = {}): Promise<Mail> {
    const args = parseInput(SendMailInputSchema, input, '同伴消息');
    const recipient = peerRecipient(ctx, from, args.to);
    // P74b：员工之间不直接发消息；总管与正在做事的员工之间，关于那件事的往来走这件事自己的工具。
    assertNotOnJob(ctx, from, recipient.id);
    // P74r1（R1）：总管名下有新约定或组队卡在等主人确认时，不能用自由文字的消息叫员工动手（中心分不清正文说的是哪件事，所以取保守规则）。
    if (ctx.store.table('bots').get(from)?.role === 'chief') {
        const pending = chiefPendingNewBlock(ctx, from);
        if (pending !== null)
            throw new Error(pending);
    }
    if (byteLength(args.text) > ctx.settings.peerMessageMaxBytes)
        throw new Error(`text：同伴消息不能超过 ${ctx.settings.peerMessageMaxBytes} 字节`);
    const now = ctx.clock.now();
    const day = startOfLocalDay(now, ctx.settings.timezone);
    // P72j：收件人可以写名字，之后一律用解析出的机器人 id 记账和投递。
    const toId = recipient.id;
    if (ctx.store.table('mail').count(m => m.from === from && m.to === toId && m.createdAt >= day && m.createdAt <= now) >= ctx.settings.peerDailyMessagesPerDirection) {
        throw new Error(`今天给 ${recipient.name} 的消息已达上限，请把后续事项留到下一回合`);
    }
    const mail = MailSchema.parse({ id: newId('ml', ctx.rng), from, to: toId, text: args.text, handoffId: null, createdAt: now, readAt: null });
    ctx.store.table('mail').put(mail);
    // P71：团队全景已下线，同伴消息记在发送方自己的私聊里（谁说的话就落在谁的对话），收件方照旧收到感知。
    postThread(ctx, { thread: from, from, kind: 'peer', text: `给 ${recipient.name}：${args.text}`, refId: mail.id });
    // P72l：给主人看的是短句，不含消息全文；模型看的感知摘要仍是原文。
    // P73r3 S1：指名发给这位员工，入队时不看思考门槛（directed）；入队结果写进 report，工具据此决定怎么回话。
    const queued = enqueuePeerPercept(ctx, recordPeerMessage(ctx, { botId: toId, id: mail.id, summary: args.text, at: now }),
        { ownerSummary: `${peerBot(ctx, from).name}发来一条消息，等待处理`, chiefDispatch: opts.chiefDispatch === true, directed: true });
    if (opts.report) opts.report.queued = queued !== null;
    ctx.emit(HUB_EVENT_SCOPES.bot, toId);
    ctx.emit(HUB_EVENT_SCOPES.activity, from);
    return mail;
}
