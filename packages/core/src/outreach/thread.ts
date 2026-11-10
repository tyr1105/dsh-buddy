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
import { sendOwnerTopicMessage } from '../project/topics.js';
const PostSchema = ThreadMessageSchema.pick({ thread: true, from: true, kind: true, text: true }).extend({ refId: nonempty.nullable().optional() });
export type ThreadInput = z.infer<typeof PostSchema>;
/** 校验并追加对话消息，关联真实线程后通知界面更新。线程可以是机器人、团队或项目主题（P63）。 */
export function postThread(ctx: HubContext, input: ThreadInput): ThreadMessage {
    const value = parseInput(PostSchema, input, '线程消息');
    const topic = ctx.store.table('projectTopics').get(value.thread);
    if (value.thread !== 'team' && !topic && !ctx.store.table('bots').get(value.thread))
        throw new Error('thread：机器人线程不存在');
    const row: ThreadMessage = { ...value, refId: value.refId ?? null, id: newId('m', ctx.rng), createdAt: ctx.clock.now(), readAt: value.from === 'owner' ? ctx.clock.now() : null };
    ctx.store.log('thread').append(row);
    // 事件的 botId 字段放线程 id：机器人线程放队友 id，主题线程放主题 id，只有团队线程是 null。
    ctx.emit(HUB_EVENT_SCOPES.thread, row.thread === 'team' ? null : row.thread);
    if (topic) {
        // 主题有新楼层：更新项目页的排序依据，并通知项目页刷新主题列表的预览和未读。
        ctx.store.table('projectTopics').patch(topic.id, { lastMessageAt: row.createdAt, updatedAt: row.createdAt });
        ctx.emit(HUB_EVENT_SCOPES.project, null);
    }
    return row;
}
/** 只将当前明确点名的对象直接投递；没有点名时才按总管、最近提名、首位在岗机器人回退。 */
export function sendOwnerMessage(ctx: HubContext, threadId: string, text: string): ThreadMessage {
    threadId = parseInput(nonempty, threadId, 'threadId');
    text = parseInput(nonempty.trim().min(1, '消息不能为空'), text, 'text');
    // P63：主题线程有自己的叫人规则（@ 成员或负责人），并要开启新一轮计数，不走下面的私聊路由。
    if (ctx.store.table('projectTopics').get(threadId))
        return sendOwnerTopicMessage(ctx, threadId, text);
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
    const topic = ctx.store.table('projectTopics').get(threadId) !== null;
    if (threadId !== 'team' && !topic && !ctx.store.table('bots').get(threadId))
        throw new Error('threadId：机器人不存在');
    await saveReadCursor(ctx, threadId, at);
    // 主题的未读数显示在项目页，已读后要让项目页也刷新。
    if (topic)
        ctx.emit(HUB_EVENT_SCOPES.project, null);
}
/** 把审计里的已读记录和持久化游标合并成每个线程最新的游标。 */
function readCursors(ctx: HubContext, threadIds: ReadonlySet<string>): Map<string, ReadCursor> {
    const cursors = new Map<string, ReadCursor>();
    for (const id of threadIds) {
        const persisted = cachedReadCursor(ctx, id);
        if (persisted) cursors.set(id, persisted);
    }
    for (const audit of ctx.store.log('audit').all()) {
        if (audit.action !== 'thread_read') continue;
        const row = readAuditDetail<ReadCursor & { thread: string }>(audit.detail);
        if (!row || !threadIds.has(row.thread) || typeof row.at !== 'number') continue;
        const latest = cursors.get(row.thread);
        if (!latest || row.at >= latest.at) cursors.set(row.thread, row);
    }
    return cursors;
}
/** 旧空汇报只在展示时过滤，保留原始日志；主人原话和其他消息类别不做 null 占位解释。 */
function visibleMessage(row: ThreadMessage): boolean {
    return row.from === 'owner' || !['reply', 'report'].includes(row.kind) || optionalMessageText(row.text) !== null;
}
/** 用已读游标算出这条消息的已读时间；同一毫秒的新消息只有在游标记过它的 id 时才算已读。 */
function withReadState(row: ThreadMessage, cursor: ReadCursor | undefined): ThreadMessage {
    return row.readAt === null && cursor && (row.createdAt < cursor.at || (row.createdAt === cursor.at && cursor.ids?.includes(row.id))) ? { ...row, readAt: cursor.at } : row;
}
/** 把持久化已读游标投影到线程消息，同一毫秒的新消息仍可保持未读。 */
export function threadMessages(ctx: HubContext, threadId: string): ThreadMessage[] {
    const cursor = readCursors(ctx, new Set([threadId])).get(threadId);
    return ctx.store.log('thread').all().filter(row => row.thread === threadId).filter(visibleMessage).map(row => withReadState(row, cursor));
}
/** 一个线程的摘要：未读数和最后一条消息。 */
export interface ThreadDigest {
    unread: number;
    last: ThreadMessage | null;
}
/**
 * 一次算出多条线程的摘要。项目页要显示每个主题的未读和预览，
 * 主题比队友多得多，逐条调用 threadMessages 会反复整表扫描，所以这里只扫一遍。
 */
export function threadDigests(ctx: HubContext, threadIds: readonly string[]): Map<string, ThreadDigest> {
    const wanted = new Set(threadIds);
    const cursors = readCursors(ctx, wanted);
    const digests = new Map<string, ThreadDigest>(threadIds.map(id => [id, { unread: 0, last: null }]));
    for (const raw of ctx.store.log('thread').all()) {
        if (!wanted.has(raw.thread) || !visibleMessage(raw)) continue;
        const row = withReadState(raw, cursors.get(raw.thread));
        const digest = digests.get(raw.thread)!;
        digest.last = row;
        if (row.from !== 'owner' && row.readAt === null) digest.unread += 1;
    }
    return digests;
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
