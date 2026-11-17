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
import { confirmByTextDetail, isConfirmPhrase } from '../project/agreement-confirm.js';
import { confirmNeedsNoChief } from '../job/agreement-hooks.js';
import { acceptByText } from '../job/accept.js';
import { typedSetupAnswer } from '../team/setup.js';
import { hubNote, markNotCorrection, noteSetupBusy, setupAskingFor, TEAM_SETUP_CONFIRM_TEXT } from '../team/setup-hold.js';
import { declineByText } from '../team/proposals.js';
import { claimTextUndo } from '../memory/undo.js';
import { claimQuotaPhrase } from '../quota/owner-phrases.js';
import { withdrawStaleQuestions } from './stale-questions.js';
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
    // P72c：总管私聊里整句「定了」之类的口令，在排唤醒之前先尝试固定约定（出错只记日志，不影响发消息）。
    if (threadId !== 'team') {
        // P73r3 S3、S5：三问进行中，总管私聊里的任何话都不叫醒总管，也不算「主人的纠正」（不触发复盘）。
        if (setupAskingFor(ctx, threadId) !== null) {
            markNotCorrection(ctx, threadId, message.id);
            // 整句确认口令不是回答、不改变三问状态；若恰好有待确认的约定，仍按口令固定它（见 confirmByText），否则请主人先答问题。
            if (isConfirmPhrase(text)) {
                const detail = confirmByTextDetail(ctx, threadId, message);
                if (detail.locked === null && detail.ambiguous === 0)
                    hubNote(ctx, threadId, TEAM_SETUP_CONFIRM_TEXT);
                return message;
            }
            // P73c：总管私聊里的话是当前问题的回答，不排唤醒（三问和推荐都不调用模型）。
            if (!typedSetupAnswer(ctx, threadId, message))
                noteSetupBusy(ctx, threadId);
            return message;
        }
        if (typedSetupAnswer(ctx, threadId, message))
            return message;
        const confirmed = confirmByTextDetail(ctx, threadId, message);
        // P74e：有两张以上约定在等确认时，「定了」不识别，中心已落一句说明，这条消息不叫醒总管。
        if (confirmed.ambiguous > 0)
            return message;
        // P74e：固定的是正在做的事的约定（B2 确认）：执行者接着做，不需要总管再出一个回合，这条消息不叫醒总管。
        if (confirmed.locked !== null && confirmNeedsNoChief(ctx, confirmed.locked.id))
            return message;
        // P74f：整句「验收通过」之类的口令验收等着验收的事；识别成功（或两件以上在等、中心已落说明）时，这条消息不叫醒总管。
        const accepted = acceptByText(ctx, threadId, message, 'chat_text');
        if (accepted.accepted !== null || accepted.ambiguous > 0)
            return message;
        // P75c：整句「撤销」「撤回」，且「已记住」所挂的回复就是这个对话里紧挨着这句话的上一条（P75r1：只认紧接着的一句）时，
        // 由记忆认领：撤销那条回复下面的全部「已记住」，这条消息不叫醒总管。放在上面几个口令机制都没有认领之后：
        // 它们认的是「定了」「验收通过」这类别的整句，与撤销口令不重叠，所以不改变它们原有的行为；
        // 不满足条件时不认领，往下照原流程走（叫醒总管，由总管判断主人要撤销什么）。
        if (claimTextUndo(ctx, threadId, message))
            return message;
        // P76d：整句「我接下来 N 小时要用」「不用留了」「用我的额度」由额度安排认领（只在总管私聊里认）：
        // 话照常落楼，中心以总管名义回一句，不叫醒总管；不满足条件时不认领，往下照原流程走。
        if (claimQuotaPhrase(ctx, threadId, message))
            return message;
        // P73c：整句「不新增」一类的话拒绝待确认的组队卡；这条消息照常排唤醒（主人说话即发起）。
        declineByText(ctx, threadId, message);
    }
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
            // P73r3 S3：三问进行中的总管不被叫醒，下面统一落固定句，这里不再说「交给他处理」。
            const held = target !== undefined && setupAskingFor(ctx, target.id) !== null;
            if (!held && (mentioned.length || !chief))
                postThread(ctx, { thread: 'team', from: 'hub', kind: 'system', text: `${mentioned.length ? '点名的机器人目前不在岗。' : ''}${target ? `这条消息交给${target.name}处理。` : '暂时没有在岗机器人，消息已保留在线程。'}`, refId: message.id });
        }
    }
    // P73r3 S3：三问进行中的总管不被叫醒；话照常保存，由中心在这个地方落一句固定的话（连续几句只落一次）。
    const awake = targets.filter(bot => setupAskingFor(ctx, bot.id) === null);
    if (awake.length < targets.length)
        noteSetupBusy(ctx, threadId);
    for (const bot of awake) {
        // P83、P85：主人这句话真的交给这位员工时，这位员工更早开着的提问才撤回（原来每句话都撤，
        // 被中心认领、不叫醒员工的口令也会把提问静默丢掉，「等你回答」闸门随之解开）。
        // 先撤回再叫醒：叫醒包里要能写出「更早的提问已撤回」。出错只记日志，不能挡住主人这句话本来要做的事。
        try { withdrawStaleQuestions(ctx, { botId: bot.id, thread: threadId, before: message.createdAt }); }
        catch (error) { ctx.logger.warn('更早的提问没有标为已撤回', { botId: bot.id, error: String(error) }); }
        wakeForOwnerMessage(ctx, bot, message);
    }
    return message;
}
/**
 * 主人的一条消息叫醒某个机器人：记感知、排一条主人发起的唤醒。
 * 从 sendOwnerMessage 末尾原样抽出（行为不变），P72c 的按钮和待你处理两条确认途径要用同一套叫醒口径。
 */
export function wakeForOwnerMessage(ctx: HubContext, bot: Bot, message: ThreadMessage): void {
    const percept = recordOwnerMessage(ctx, { botId: bot.id, id: message.id, summary: message.text, at: message.createdAt });
    if (percept)
        enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
            summary: '主人发来消息', evidence: [percept.id], messageId: message.id, ownerInitiated: true }));
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
