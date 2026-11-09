/** 对话线程记录主人和机器人原话；团队路由保留明确对象及回退说明，已读使用追加游标。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Bot } from '../model/bot.js';
import { ThreadMessageSchema, type ThreadMessage } from '../model/outreach.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { recordOwnerMessage } from '../perception/sources.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { readAuditDetail } from './audit.js';
import { cachedReadCursor, saveReadCursor, type ReadCursor } from './read-state.js';
import { optionalMessageText } from '../util/text.js';
const PostSchema = ThreadMessageSchema.pick({ thread: true, from: true, kind: true, text: true }).extend({ refId: nonempty.nullable().optional() });
export type ThreadInput = z.infer<typeof PostSchema>;
/** 校验并追加对话消息，关联真实线程后通知界面更新。 */
export function postThread(ctx: HubContext, input: ThreadInput): ThreadMessage {
    const value = parseInput(PostSchema, input, '线程消息');
    if (value.thread !== 'team' && !ctx.store.table('bots').get(value.thread))
        throw new Error('thread：机器人线程不存在');
    const row: ThreadMessage = { ...value, refId: value.refId ?? null, id: newId('m', ctx.rng), createdAt: ctx.clock.now(), readAt: value.from === 'owner' ? ctx.clock.now() : null };
    ctx.store.log('thread').append(row);
    ctx.emit(HUB_EVENT_SCOPES.thread, row.thread === 'team' ? null : row.thread);
    return row;
}
/** 只将当前明确点名的对象直接投递；没有点名时才按总管、最近提名、首位在岗机器人回退。 */
export function sendOwnerMessage(ctx: HubContext, threadId: string, text: string): ThreadMessage {
    threadId = parseInput(nonempty, threadId, 'threadId');
    text = parseInput(nonempty.trim().min(1, '消息不能为空'), text, 'text');
    if (threadId !== 'team' && !ctx.store.table('bots').get(threadId))
        throw new Error('threadId：机器人不存在');
    const message = postThread(ctx, { thread: threadId, from: 'owner', kind: 'chat', text });
    ctx.runtime.ownerActiveAt = ctx.clock.now();
    let targets = threadId === 'team' ? [] : [ctx.store.table('bots').get(threadId)!];
    if (threadId === 'team') {
        const bots = ctx.store.table('bots').list();
        const active = bots.filter(bot => ['active', 'probation'].includes(bot.lifecycle));
        const mentioned = matchingNames(text, bots, true);
        targets = mentioned.filter(bot => active.some(row => row.id === bot.id));
        if (!targets.length) {
            const chief = active.find(bot => bot.role === 'chief');
            const recent = ctx.store.log('thread').recent(Number.MAX_SAFE_INTEGER, row => row.from === 'owner')
                .map(row => matchingNames(row.text, active, false)[0]).find(bot => bot !== undefined);
            const target = chief ?? recent ?? active[0];
            if (target) targets = [target];
            if (mentioned.length || !chief)
                postThread(ctx, { thread: 'team', from: 'hub', kind: 'system', text: `${mentioned.length ? '点名的机器人目前不在岗。' : ''}${target ? `这条消息交给${target.name}处理。` : '暂时没有在岗机器人，消息已保留在线程。'}`, refId: message.id });
        }
    }
    for (const bot of targets) {
        const percept = recordOwnerMessage(ctx, { botId: bot.id, id: message.id, summary: text, at: message.createdAt });
        if (percept)
            enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
                summary: '主人发来消息', evidence: [percept.id], messageId: message.id, ownerInitiated: true }));
    }
    return message;
}
/** JSONL 不原位改历史；写读游标并在查询时投影，避免只改内存导致重启后重新未读。 */
export async function markRead(ctx: HubContext, threadId: string, at = ctx.clock.now()): Promise<void> {
    threadId = parseInput(nonempty, threadId, 'threadId');
    at = parseInput(timestamp, at, '已读时间');
    if (at > ctx.clock.now())
        throw new Error('已读时间不能晚于当前时间');
    if (threadId !== 'team' && !ctx.store.table('bots').get(threadId))
        throw new Error('threadId：机器人不存在');
    await saveReadCursor(ctx, threadId, at);
}
/** 把持久化已读游标投影到线程消息，同一毫秒的新消息仍可保持未读。 */
export function threadMessages(ctx: HubContext, threadId: string): ThreadMessage[] {
    const persisted = cachedReadCursor(ctx, threadId);
    const cursor = ctx.store.log('audit').all().filter(row => row.action === 'thread_read')
        .map(row => readAuditDetail<ReadCursor & {
        thread: string;
    }>(row.detail))
        .filter(row => row?.thread === threadId && typeof row.at === 'number')
        .reduce<ReadCursor | null>((latest, row) => !latest || row!.at >= latest.at ? row : latest, persisted);
    return ctx.store.log('thread').all().filter(row => row.thread === threadId)
        // 旧空汇报只在展示时过滤，保留原始日志；主人原话和其他消息类别不做 null 占位解释。
        .filter(row => row.from === 'owner' || !['reply', 'report'].includes(row.kind) || optionalMessageText(row.text) !== null)
        .map(row => row.readAt === null && cursor && (row.createdAt < cursor.at || (row.createdAt === cursor.at && cursor.ids?.includes(row.id))) ? { ...row, readAt: cursor.at } : row);
}

/** 从长名字开始消费匹配，名字后必须是空白、标点或结尾，避免前缀误投。 */
function matchingNames(text: string, bots: Bot[], requireAt: boolean): Bot[] {
    const matches: Array<{ bot: Bot; start: number; end: number }> = [];
    for (const bot of [...bots].sort((a, b) => b.name.length - a.name.length)) {
        const token = `${requireAt ? '@' : ''}${bot.name}`;
        let start = text.indexOf(token);
        while (start >= 0) {
            const end = start + token.length;
            const after = text[end];
            const boundary = !requireAt || !after || /[\s\p{P}\p{S}]/u.test(after);
            // 普通中文提名可与句子相连，最长名字优先仍避免前缀误投。
            if (boundary && !matches.some(m => start < m.end && end > m.start)) matches.push({ bot, start, end });
            start = text.indexOf(token, end);
        }
    }
    return [...new Map(matches.sort((a, b) => a.start - b.start).map(m => [m.bot.id, m.bot])).values()];
}
