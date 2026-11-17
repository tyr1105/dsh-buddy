/**
 * 中心审批按完整内容哈希绑定一次性批准；界面决定和过期都生成明确的结果感知。
 * P65：在项目主题回合里申请的审批记下来源主题，主人批准或拒绝后接着做的那一回合回到原主题。
 */
import { flushPushQueue } from '../outreach/notify.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ApprovalSchema, type Approval, type ApprovalAsk } from '../model/outreach.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { sha256Hex, stableStringify } from '../util/hash.js';
import { createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { recordApprovalDecision } from '../perception/sources.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { describeAction, approvalDisplayText } from '../util/action-text.js';
import { APPROVAL_TEXT_VERSION, hostCommandRiskNote, isHostCommand, ownerApprovalSentence, ownerReasonText } from '../util/approval-sentence.js';
import { memberProjectDirs } from './gate-context.js';
import { isOpenWake } from '../turn/session.js';
import { approvalModelSummary, approvalOwnerSummary } from '../util/owner-text.js';
import { noteTopicOfOpenWake, topicIdOfOpenWake } from '../project/topics.js';
import { asksOf, type Classification } from './paths.js';
import { followUpTopic, startTopicFollowUp } from '../project/topic-followup.js';
import { emitJobTopic } from '../job/store.js';
import { voidReplacedLaunchApproval } from '../job/launch-replace.js';
import { launchDirShownForApproval } from '../job/launch-local-dir.js';
import { announceJobApproval, approvalThreadOf, beginJobApproval, declineLaunchStep, launchApprovalSentence, launchSubmissionOf, noteJobOf, putPlainNote, executingJobOf,
    type ApprovalNoteInput, type BegunJobApproval } from '../job/launch-approval.js';
import { sameLocalDirPath } from '../project/local-dir.js';
/** 为工具名和规范化参数生成稳定哈希，确保批准不能移用于另一组参数。 */
export function approvalContentHash(tool: string, args: unknown): string {
    return sha256Hex(tool + stableStringify(args));
}
/** 把分类结果里「要主人确认的事」转成能存进审批单的样子：路径最多留 8 个，空值丢掉。 */
export function approvalAsksOf(action: Classification): ApprovalAsk[] {
    return asksOf(action).map(ask => ({ cls: ask.cls, reason: ask.reason,
        ...(ask.subclass ? { subclass: ask.subclass } : {}), ...(ask.detail ? { detail: ask.detail } : {}),
        ...(ask.download === true ? { download: true } : {}), ...(ask.blocked === true ? { blocked: true } : {}),
        ...(ask.paths?.length ? { paths: ask.paths.filter(Boolean).slice(0, 8) } : {}),
        ...(ask.hint === undefined ? {} : { hint: ask.hint }), ...(ask.moreAfter === undefined ? {} : { moreAfter: ask.moreAfter }) })).slice(0, 24);
}
/** 长命令同时保留开头和危险尾部，卡片不以只显示前缀掩盖最后的动作。 */
export function approvalPreview(args: unknown, maxBytes: number, edgeChars: number): string {
    const value = stableStringify(args);
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    const chars = Array.from(value);
    return `${chars.slice(0, edgeChars).join('')}\n……中间省略……\n${chars.slice(-edgeChars).join('')}`;
}
/**
 * P69 A8：审批单上给界面用的三样新东西。
 * 一句话（actionText）按分类结果生成，不带原始命令；为什么（ownerReason）取队友的 why，没有就用它此刻在做的事；
 * 风险提示（riskNote）目前只有中心代跑命令那句沙箱提醒。没有分类结果（老的调用方式）时不生成，沿用旧写法和旧版本号。
 */
function ownerFacts(ctx: HubContext, botId: string, tool: string, args: unknown, asks: readonly ApprovalAsk[] | undefined, ownerWhy: string | undefined, notes?: ApprovalNoteInput):
    { actionText: string; version: 2 | 3; ownerReason?: string; riskNote?: string } {
    const sentence = ownerApprovalSentence(tool, args, asks, { ownerHome: ctx.ownerHome, commandMaxChars: ctx.settings.c03.actionCommandMaxChars });
    if (sentence === null) return { actionText: describeAction(tool, args, ctx.settings.c03.actionCommandMaxChars), version: 2 };
    const wake = ctx.store.table('wakes').list(row => row.botId === botId && isOpenWake(row)).sort((a, b) => b.startedAt - a.startedAt)[0];
    const topicTitle = wake?.topicId ? ctx.store.table('projectTopics').get(wake.topicId)?.title : undefined;
    const ownerReason = ownerReasonText({ ownerWhy, topicTitle, wakeKind: wake?.reason.kind });
    // P74r18b：风险提示按这位员工的真实可写范围生成（点名员工；在项目里才写「项目文件夹」）。
    const bot = ctx.store.table('bots').get(botId);
    // P81：这张审批将是某件事的发布审批、约定里有发布位置时，提示句里写上这个文件夹（主人批准时看到的就是它；运行前核对也认这句话）。
    const localShown = isHostCommand(tool, args) ? launchDirShownForApproval(ctx, botId, notes?.replace === true) : undefined;
    const riskNote = isHostCommand(tool, args) ? hostCommandRiskNote(bot?.name ?? '员工', bot ? memberProjectDirs(ctx, bot.id).length > 0 : false, localShown) : undefined;
    return { actionText: sentence, version: APPROVAL_TEXT_VERSION, ...(ownerReason ? { ownerReason } : {}), ...(riskNote ? { riskNote } : {}) };
}
/**
 * 对同一待批内容复用审批单，同时建立主人可操作的收件箱和线程记录。
 * P69：第 7 个参数 asks 是分类器给出的「待确认事项清单」（含类别、子类、对象），原样存进审批单，
 * 供审批卡生成人话用；可以不传（旧调用方式不变），此时审批单上没有这一项，文案沿用旧写法。
 * 第 8 个参数 ownerWhy 是队友自己写的申请理由（出站动作的 why），用来填「为什么」。
 */
export function prepareApproval(ctx: HubContext, botId: string, tool: string, args: unknown, cls: 'C' | 'D', why: string, asks?: readonly ApprovalAsk[], ownerWhy?: string, notes?: ApprovalNoteInput): { approval: Approval; notify: () => Promise<void> } {
    const input = parseInput(z.strictObject({ botId: nonempty, tool: nonempty, cls: z.enum(['C', 'D']), why: nonempty }), { botId, tool, cls, why }, '审批申请');
    if (!ctx.store.table('bots').get(botId))
        throw new Error('审批 botId 对应的机器人不存在');
    const now = ctx.clock.now();
    const contentHash = approvalContentHash(tool, args);
    const existing = ctx.store.table('approvals').list(a => a.botId === botId && a.contentHash === contentHash && a.status === 'pending' && a.expiresAt > now)[0];
    const facts = ownerFacts(ctx, botId, tool, args, asks, ownerWhy, notes);
    const actionText = facts.actionText;
    // P81r1（S6）：这次提交会不会成为发布审批、约定里现在的发布位置是什么；旧审批旁表里记的是不是同一处。
    // 不是同一处时旧卡不能复用（主人看到的提示句与实际要放开的位置不一致），作废旧卡、新建一张。
    const launchSubmission = launchSubmissionOf(ctx, botId, notes?.replace === true);
    const existingLocalDir = existing === undefined ? null : ctx.store.table('approvalNotes').get(existing.id)?.launchLocalDir ?? null;
    const launchDirMoved = existing !== undefined && launchSubmission !== null && !sameLocalDirPath(existingLocalDir, launchSubmission.localDir);
    if (existing !== undefined && !launchDirMoved) {
        // 原内容再次申请时拿到了完整参数：原票和截止时间保持，修正旧摘要与卡片，不重新打扰主人。
        if (existing.actionTextVersion === 2 || existing.actionTextVersion === 3) return { approval: existing, notify: async () => undefined };
        const updated = ctx.store.table('approvals').patch(existing.id, { actionText, actionTextVersion: facts.version,
            ...(facts.ownerReason ? { ownerReason: facts.ownerReason } : {}), ...(facts.riskNote ? { riskNote: facts.riskNote } : {}),
            argsPreview: approvalPreview(args, ctx.settings.c03.approvalPreviewMaxBytes, ctx.settings.c03.approvalPreviewEdgeChars) });
        const display = approvalDisplayText(updated, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars, stableStringify(args));
        for (const card of ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === updated.id)) {
            ctx.store.table('inbox').patch(card.id, display);
        }
        ctx.emit(HUB_EVENT_SCOPES.inbox, botId);
        ctx.emit(HUB_EVENT_SCOPES.activity, botId);
        ctx.emit(HUB_EVENT_SCOPES.bot, botId);
        return { approval: updated, notify: async () => undefined };
    }
    // P65：记下这张审批是在哪个主题的回合里申请的（和下面那句主题提示同一个口径），
    // 主人批准或拒绝后，接着做的那一回合回到这个主题；不在主题回合里申请的不记。
    const topicId = topicIdOfOpenWake(ctx, botId);
    const row = parseInput(ApprovalSchema, { id: newId('ap', ctx.rng), botId, tool, actionText, actionTextVersion: facts.version, actionClass: input.cls,
        ...(facts.ownerReason ? { ownerReason: facts.ownerReason } : {}), ...(facts.riskNote ? { riskNote: facts.riskNote } : {}),
        argsPreview: approvalPreview(args, ctx.settings.c03.approvalPreviewMaxBytes, ctx.settings.c03.approvalPreviewEdgeChars), contentHash, why,
        status: 'pending', createdAt: now, decidedAt: null, expiresAt: now + ctx.settings.approvalExpiryMs, usedAt: null,
        ...(topicId ? { topicId } : {}), ...(asks?.length ? { asks: asks.map(ask => ({ ...ask })) } : {}) }, '审批单');
    // 同步落表先于任何 await，同一事件循环内的重复申请不会产生两张单。
    ctx.store.table('approvals').put(row);
    // P74g：这位员工正在做一件事的执行链回合时，这张审批属于这件事：先写旁表、发布准备时改发布状态（有撤销），
    // 之后任何一步失败，审批单和这些改动一起撤回，不留下半截状态。三行有值但不属于任何一件事时，只写旁表。
    const job = executingJobOf(ctx, botId);
    // 发布位置变了的旧卡作废之后，新卡要按「取代」建：beginJobApproval 据此把这件事指向新卡（原来那张仍待批准时）。
    const notesForJob = launchDirMoved ? { ...notes, replace: true } : notes;
    let begun: BegunJobApproval | null = null;
    if (job !== null) {
        try { begun = beginJobApproval(ctx, job, row.id, notesForJob ?? {}, now); }
        catch (error) { ctx.store.table('approvals').remove(row.id); throw error; }
    }
    const hasNotes = notes !== undefined && (notes.cost !== undefined || notes.undo !== undefined || notes.after !== undefined);
    let plainUndo: (() => void) | null = null;
    if (begun === null && hasNotes) {
        try { plainUndo = putPlainNote(ctx, row.id, notes, now); }
        catch (error) { ctx.store.table('approvals').remove(row.id); throw error; }
    }
    // P74r13：这张审批是这件事的发布审批时，给主人看的一句话换成「按约定对外发布：{约定里的发布方式}」，
    // 审批卡第一行、「待你处理」条目的标题、之后对话里的系统行都取审批单上的这句话；普通审批不变。
    let shown: Approval = row;
    if (begun !== null && begun.launching) {
        const sentence = launchApprovalSentence(ctx, begun.job);
        if (sentence !== null) shown = ctx.store.table('approvals').patch(row.id, { actionText: sentence });
    }
    const { title, body } = approvalDisplayText(shown, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars, stableStringify(args));
    let inbox: ReturnType<typeof createInboxItem>;
    try {
        inbox = createInboxItem(ctx, { botId, type: 'approval', title, body,
            options: ['批准', '拒绝'], defaultOption: '拒绝', priority: 'P1', refId: row.id, subjectKey: `approval:${row.id}`, expiresAt: row.expiresAt,
            ...(topicId ? { topicId } : {}) });
    }
    catch (error) {
        begun?.undo(); plainUndo?.(); ctx.store.table('approvals').remove(row.id);
        throw error;
    }
    // P74g：属于一件事的审批卡落在总管私聊，前面先以总管的名义说明；其余审批落在申请的员工私聊（原样）。
    // P74r19：新的发布命令取代了原来在等批准的那条：新卡建好之后才作废旧的（新卡没建成时旧的原样保留），
    // 不叫醒任何人；总管私聊不重复落「下一步是对外发布，需要你批准」那句（announceJobApproval 的 replaced 参数）。
    // P81r1（S6）：同一内容已有一张等批准的审批、而它记下的发布位置与约定里现在的不同时，同样在新卡建好之后作废旧卡。
    const oldToVoid = begun?.replaced ?? (launchDirMoved && existing !== undefined ? existing.id : null);
    if (oldToVoid !== null) {
        try { voidReplacedLaunchApproval(ctx, oldToVoid, now); }
        catch (error) { ctx.logger.warn('取代发布命令时没有作废原来那条审批', { approvalId: oldToVoid, error: String(error) }); }
    }
    if (begun !== null) announceJobApproval(ctx, begun.job, begun.launching, row.id, begun.replaced !== null);
    postThread(ctx, { thread: begun === null ? botId : begun.job.chiefId, from: 'hub', kind: 'approval', text: body, refId: inbox.id });
    // P63：审批的去处不变，只在主题里留一句提示，主人才知道这边在等它批准。
    noteTopicOfOpenWake(ctx, botId, '这一步要你批准，已放进「待你处理」；批准后它会继续处理。', inbox.id);
    /**
     * P76h：审批自己的推送已删除；条目建立时 createInboxItem 已按类别（approval）经 notifyOwner 推送。
     * 保留 notify 这个入口只为不改调用方（宿主钩子和 requestApproval 仍会调用它）：它不再自己推送，
     * 只是等通知队列整理完（含此前已在整理的那一次），让调用方知道这张审批的通知已经处理过。
     */
    const notify = async (): Promise<void> => { await flushPushQueue(ctx, ctx.clock.now()); };
    ctx.emit(HUB_EVENT_SCOPES.activity, botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return { approval: shown, notify };
}

/** 既有异步入口仍等待通知结束，与同步钩子共用同一审批落表逻辑。 */
export async function requestApproval(ctx: HubContext, botId: string, tool: string, args: unknown, cls: 'C' | 'D', why: string, asks?: readonly ApprovalAsk[], ownerWhy?: string, notes?: ApprovalNoteInput): Promise<Approval> {
    const prepared = prepareApproval(ctx, botId, tool, args, cls, why, asks, ownerWhy, notes);
    await prepared.notify();
    return prepared.approval;
}
/** 先更新状态再生成感知；重复点击不能重新发票或反转已有决定。 */
export async function decideApproval(ctx: HubContext, id: string, approve: boolean, note = ''): Promise<Approval> {
    parseInput(z.strictObject({ id: nonempty, approve: z.boolean(), note: z.string() }), { id, approve, note }, '审批决定');
    const row = ctx.store.table('approvals').get(id);
    if (!row)
        throw new Error('审批单不存在');
    if (row.status !== 'pending')
        throw new Error('审批单已经处理，不能重复决定');
    const now = ctx.clock.now();
    const status = row.expiresAt <= now ? 'expired' : approve ? 'approved' : 'rejected';
    // P74r18b：批准一条由中心代为执行的出站动作之后，立刻开始一次执行的触发点在界面命令入口（api/index.ts 的 decideApproval、answerInbox，
    // 调用 gate/outbox.ts 的 startApprovedRunFor），不在这里：这里只管记下决定，保持「批准只是记录决定、执行是另一步」，
    // 让只测决定本身的单元测试不被执行抢先。巡检里的执行（executeReadyOutbox）保留作兜底。
    return finishDecision(ctx, row, status, note, now);
}
/** 这张审批批准之后由中心代为执行（出站动作）：批准的那一刻不叫醒员工，等结果出来再叫（P74r18b）。 */
function runsByCenter(row: Pick<Approval, 'tool'>, status: Approval['status']): boolean {
    return status === 'approved' && row.tool === 'hub_outbox_execute';
}
/** 统一落实批准、拒绝和过期结果，更新收件箱并生成机器人可追溯的结果候选。 */
function finishDecision(ctx: HubContext, row: Approval, status: 'approved' | 'rejected' | 'expired', note: string, now: number): Approval {
    // P74g：这张审批属于一件事时，跟进的候选带 jobId（执行者批准后的唤醒走执行链规则）；
    // 拒绝或过期、而且这件事正在等这张发布审批时，先把发布状态改成「暂不发布」（写失败会抛出，审批保持待处理，主人可再点一次）。
    const job = noteJobOf(ctx, row.id);
    const declined = status === 'approved' ? null : declineLaunchStep(ctx, row.id, status, now);
    let updated: Approval;
    try { updated = ctx.store.table('approvals').patch(row.id, { status, decidedAt: now }); }
    catch (error) { declined?.undo(); throw error; }
    const summary = approvalModelSummary(row, status, note);
    const ownerSummary = approvalOwnerSummary(row, status, note, ctx);
    ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: now, actor: status === 'expired' ? 'hub' : 'owner', action: 'approval_decided', detail: stableStringify({ id: row.id, status, note }) });
    for (const inbox of ctx.store.table('inbox').list(i => i.refId === row.id && i.type === 'approval' && i.status === 'open')) {
        ctx.store.table('inbox').patch(inbox.id, { status: status === 'expired' ? 'expired' : 'answered', answer: status === 'approved' ? '批准' : '拒绝', answeredAt: now });
    }
    // P74r18b：由中心代为执行的出站动作，批准的那一刻不再叫醒员工（命令还没运行，他这一回合什么都做不了），
    // 所以不记感知、不建候选；命令运行完之后由 gate/outbox-wake.ts（或发布结果 job/launch-result.ts）带着结果叫他。
    // 主题里仍落「你批准了……」这句旁白，主人和读主题的人看得到。
    const quiet = runsByCenter(row, status);
    const percept = quiet ? null : recordApprovalDecision(ctx, { botId: row.botId, id: `${row.id}:${status}`, summary, at: now });
    // P65：在主题里申请、主人亲手批准或拒绝、主题还能接着聊时，接着做的那一回合回到主题，
    // 并和主题里其他回合一样算主人发起；过期是中心处理的，照旧落私聊。
    const topic = status === 'expired' ? null : followUpTopic(ctx, row.botId, row.topicId);
    if (quiet) {
        if (topic) startTopicFollowUp(ctx, { topic, candidate: null, perceptId: null, note: ownerSummary, refId: row.id });
        postThread(ctx, { thread: approvalThreadOf(ctx, row.id, row.botId), from: 'hub', kind: 'system', text: ownerSummary, refId: row.id });
        // 这件事的进度行要从「在等你」改成「中心运行发布命令」：发布状态本身没变，所以单独通知打开着的主题刷新。
        if (job) emitJobTopic(ctx, job);
        ctx.emit(HUB_EVENT_SCOPES.activity, row.botId);
        ctx.emit(HUB_EVENT_SCOPES.inbox, row.botId);
        ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
        return updated;
    }
    const candidate = buildCandidate(ctx, { botId: row.botId, kind: 'approval_decided', score: ctx.settings.c02.replySalience, summary, ownerSummary,
        evidence: [row.id, ...(percept ? [percept.id] : [])], subjectKey: `approval:${row.id}`, now,
        ...(topic ? { topicId: topic.id, ownerInitiated: true } : {}), ...(job ? { jobId: job.id } : {}),
        // P76r1：主人亲手批准或拒绝之后的接续回合不算员工自己发起的（quota/usage.ts 的 isSelfWork）；
        // 被中心按到期处理（expired）的不带，仍算自己发起的。故意不改成 ownerInitiated：那会改变回合上限档位和额度灯下的放行。
        ...(status === 'expired' ? {} : { ownerDecided: true }) });
    candidate.priority = ctx.settings.c02.priorities.reply;
    // 审批卡在私聊里，私聊照旧记一笔结果；来自主题的，主题里另落一句同样的话（「你批准了：……」）。
    // 属于一件事的审批，卡在总管私聊里，结果也记在那里。
    if (topic) startTopicFollowUp(ctx, { topic, candidate, perceptId: percept?.id ?? null, note: ownerSummary, refId: row.id });
    else {
        const queued = enqueue(ctx, candidate);
        // P74g：带 jobId 的候选和感知收集器另建的普通候选不会合并（合并键含 jobId），要先标「已评估」，
        // 否则同一次批准会叫醒两次，其中一次不带这件事（做法同 job/chain.ts）。
        if (job && percept && percept.evaluatedAt === undefined)
            ctx.store.table('percepts').patch(percept.id, { evaluatedAt: now, ...(queued === null ? { discardedAt: now } : {}) });
    }
    postThread(ctx, { thread: approvalThreadOf(ctx, row.id, row.botId), from: 'hub', kind: 'system', text: ownerSummary, refId: row.id });
    declined?.announce();
    ctx.emit(HUB_EVENT_SCOPES.activity, row.botId);
    ctx.emit(HUB_EVENT_SCOPES.inbox, row.botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
    return updated;
}
/** 只消费当前机器人相同参数且未过期的一次性批准票，防止重复执行。 */
export function consumeTicket(ctx: HubContext, botId: string, tool: string, args: unknown, expectedApprovalId?: string): boolean {
    parseInput(z.strictObject({ botId: nonempty, tool: nonempty }), { botId, tool }, '批准票');
    const now = ctx.clock.now();
    const hash = approvalContentHash(tool, args);
    const row = ctx.store.table('approvals').list(a => (!expectedApprovalId || a.id === expectedApprovalId)
        && a.botId === botId && a.tool === tool && a.contentHash === hash && a.status === 'approved' && a.usedAt === null && a.expiresAt > now)[0];
    if (!row)
        return false;
    ctx.store.table('approvals').patch(row.id, { status: 'used', usedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.activity, botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return true;
}
/** 把已到期的待批或已批准票据转为过期，并通知机器人停止原动作。 */
export async function expireApprovals(ctx: HubContext, now: number): Promise<void> {
    parseInput(timestamp, now, '审批过期时间');
    for (const row of ctx.store.table('approvals').list(a => ['pending', 'approved'].includes(a.status) && a.expiresAt <= now)) {
        finishDecision(ctx, row, 'expired', '', now);
    }
}
