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
import { enqueuePeerPercept, peerRecipient } from './common.js';
export const SendMailInputSchema = z.strictObject({ to: nonempty, text: nonempty });
/** 在每对每方向的日限额内保存同伴邮件，生成团队线程和收件方感知。 */
export async function sendMail(ctx: HubContext, from: string, input: z.infer<typeof SendMailInputSchema>): Promise<Mail> {
    const args = parseInput(SendMailInputSchema, input, '同伴消息');
    const recipient = peerRecipient(ctx, from, args.to);
    if (byteLength(args.text) > ctx.settings.peerMessageMaxBytes)
        throw new Error(`text：同伴消息不能超过 ${ctx.settings.peerMessageMaxBytes} 字节`);
    const now = ctx.clock.now();
    const day = startOfLocalDay(now, ctx.settings.timezone);
    if (ctx.store.table('mail').count(m => m.from === from && m.to === args.to && m.createdAt >= day && m.createdAt <= now) >= ctx.settings.peerDailyMessagesPerDirection) {
        throw new Error(`今天给 ${recipient.name} 的消息已达上限，请把后续事项留到下一回合`);
    }
    const mail = MailSchema.parse({ id: newId('ml', ctx.rng), from, to: args.to, text: args.text, handoffId: null, createdAt: now, readAt: null });
    ctx.store.table('mail').put(mail);
    postThread(ctx, { thread: 'team', from, kind: 'peer', text: `给 ${recipient.name}：${args.text}`, refId: mail.id });
    enqueuePeerPercept(ctx, recordPeerMessage(ctx, { botId: args.to, id: mail.id, summary: args.text, at: now }));
    ctx.emit(HUB_EVENT_SCOPES.bot, args.to);
    ctx.emit(HUB_EVENT_SCOPES.activity, from);
    return mail;
}
