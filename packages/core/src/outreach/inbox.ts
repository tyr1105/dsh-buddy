/**
 * 收件箱只收需要主人决策的事项；回答和默认处理共用同一路径，并落实被接受的结构化提议。
 * P65：来自项目主题的事项，主人亲手处理后，接着做的那一回合回到原主题（规则见 project/topic-followup.ts）。
 */
import { z } from 'zod';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { JOB_DEFAULTS, SKILL_DEFAULTS } from '../config/defaults.js';
import { answerJobInbox, isJobInboxItem } from '../job/inbox-answer.js';
import { bumpDisturbCount } from '../job/disturb.js';
import { capOptionsProblem, stallOptionsProblem } from '../job/block-options.js';
import { InboxItemSchema, type InboxItem } from '../model/outreach.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { recordInboxReply } from '../perception/sources.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { refreshBotFiles } from '../memory/files.js';
import { upsertRule } from '../memory/rules.js';
import { legacyRulesInEffect } from '../memory/memory-read.js';
import { decideApproval } from '../gate/approvals.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
import { postThread } from './thread.js';
import { notifyCategoryOf, notifyOwner } from './notify.js';
import { inboxDefaultOption, inboxOptions, proposalAnswer } from './inbox-options.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { confirmFromInbox, isAgreementInboxItem } from '../project/agreement-confirm.js';
import { isTeamInboxItem } from '../team/cards.js';
import { confirmTeamFromInbox } from '../team/proposals.js';
import { checkGoalAnswer } from '../commit/result-check.js';
import type { ProjectTopic } from '../model/project.js';
import { followUpNoteText, followUpTopic, startTopicFollowUp, topicReplyFields } from '../project/topic-followup.js';
const InboxInputSchema = InboxItemSchema.pick({ botId: true, type: true, title: true, body: true, subjectKey: true }).extend({
    options: z.array(nonempty).optional(), defaultOption: nonempty.nullable().optional(), priority: InboxItemSchema.shape.priority.optional(),
    refId: nonempty.nullable().optional(), expiresAt: timestamp.nullable().optional(), status: InboxItemSchema.shape.status.optional(), answer: InboxItemSchema.shape.answer.optional(),
    // P65：在哪个项目主题的回合里提出的；不在主题里提的事项不传。
    topicId: InboxItemSchema.shape.topicId,
});
export type InboxInput = z.infer<typeof InboxInputSchema>;
/** P75i：这条「待你处理」是不是教它技能的选会话提问（事项键 learn: 开头的提问）。 */
export function isLearnInboxItem(item: Pick<InboxItem, 'type' | 'subjectKey'>): boolean {
    return item.type === 'question' && item.subjectKey.startsWith('learn:');
}
/** 验收条目唯一的按钮文字（P74f）。 */
export const JOB_ACCEPT_OPTION = '验收通过';
/** 约定确认条目唯一的按钮文字（P72b）。 */
export const AGREEMENT_CONFIRM_OPTION = '按建议，定了';
const answerLocks = new WeakMap<HubContext, Map<string, Promise<unknown>>>();
/** 同一事项同时出现在收件箱和线程卡片；机器人详情也会展示等待与提议状态，因此一并刷新。 */
export function emitInboxChange(ctx: HubContext, item: Pick<InboxItem, 'botId'>): void {
    ctx.emit(HUB_EVENT_SCOPES.inbox, item.botId);
    ctx.emit(HUB_EVENT_SCOPES.thread, item.botId);
    if (item.botId) ctx.emit(HUB_EVENT_SCOPES.bot, item.botId);
}
/** 一张卡片的人工回答和到期默认串行执行，不能同时接受与拒绝。 */
async function withAnswerLock<T>(ctx: HubContext, id: string, operation: () => Promise<T>): Promise<T> {
    let locks = answerLocks.get(ctx);
    if (!locks) {
        locks = new Map();
        answerLocks.set(ctx, locks);
    }
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    locks.set(id, next);
    try {
        return await next;
    }
    finally {
        if (locks.get(id) === next)
            locks.delete(id);
    }
}
/** 校验需要主人动手的事项并补足默认期限，使回答和到期处理使用统一状态。 */
export function createInboxItem(ctx: HubContext, input: InboxInput, options: { alertCode?: string } = {}): InboxItem {
    // options.alertCode（P76h）：告警条目对应的告警代码，只用于判断通知类别，不写进条目。
    const value = parseInput(InboxInputSchema, input, '收件箱事项');
    if (value.botId && !ctx.store.table('bots').get(value.botId))
        throw new Error('botId：机器人不存在');
    // P72b 例外：约定确认条目只有一个按钮、没有默认答案、永不到期（不会自动按建议处理）；其他提问的规则不变。
    const isAgreementQuestion = value.type === 'question' && value.subjectKey.startsWith('agreement:');
    // P73c 例外：组队卡确认条目同样只有一个按钮（文字随卡片当前内容变化）、没有默认答案、永不到期。
    const isTeamQuestion = value.type === 'question' && value.subjectKey.startsWith('team:');
    // P75i 例外：教它技能的选会话条目（事项键 learn:<记录编号>）同样没有默认答案、永不到期。
    const isLearnQuestion = value.type === 'question' && value.subjectKey.startsWith('learn:');
    // P74c 例外：一件事自己的提问条目（回合用到上限、核对三轮不过、验收……）同样没有默认答案、永不到期：
    // 这类事只有主人能定，到期按默认处理等于替主人做了决定（方案 6.1 的「只有一个入口」原则）。
    const isJobQuestion = value.type === 'question' && value.subjectKey.startsWith('job:');
    if (isJobQuestion) {
        // P74f：一件事的条目按种类（事项键 job:<id>:<种类>:...）各有固定的选项，没有默认选项、不会到期。
        const jobKind = value.subjectKey.split(':')[2] ?? '';
        const options = value.options ?? [];
        if (jobKind === 'accept') {
            if (options.length !== 1 || options[0] !== JOB_ACCEPT_OPTION)
                throw new Error(`options：验收条目的选项必须恰好是「${JOB_ACCEPT_OPTION}」`);
        }
        else if (jobKind === 'escalate') {
            if (options.length < JOB_DEFAULTS.OPTIONS_MIN || options.length > JOB_DEFAULTS.OPTIONS_MAX
                || options.some(text => [...text].length > JOB_DEFAULTS.OPTION_TITLE_MAX_CHARS + 2))
                throw new Error(`options：三轮不过的条目需要 ${JOB_DEFAULTS.OPTIONS_MIN} 到 ${JOB_DEFAULTS.OPTIONS_MAX} 个办法，每个不超过 ${JOB_DEFAULTS.OPTION_TITLE_MAX_CHARS} 字`);
        }
        else if (jobKind === 'cap') {
            // 选项文字只在 job/block-options.ts 定义一次（P74r5）：这里引用，不另写字面量。
            // P76f：新条目必须是「追加 n 个回合」「缩小范围」「暂停」；旧条目的「再给 8 个回合」「暂停」两项仍认。
            const problem = capOptionsProblem(options);
            if (problem !== null)
                throw new Error(problem);
        }
        else if (jobKind === 'stall') {
            // P76g：没有进展条目的选项是「再提醒一次」「暂停」，有可接手的人时最前面再加一项「换{名字}接手」。
            const problem = stallOptionsProblem(options);
            if (problem !== null)
                throw new Error(problem);
        }
        else if (options.length < 2 || options.length > 4)
            throw new Error('options：一件事的提问条目需要 2 到 4 个选项');
        if (value.defaultOption !== null && value.defaultOption !== undefined)
            throw new Error('defaultOption：一件事的提问条目不能有默认选项（必须为 null）');
        if (value.expiresAt !== null)
            throw new Error('expiresAt：一件事的提问条目不会到期（必须显式写 null）');
        // P74f：同一件事同一时刻最多一条开着的条目：新建前撤回这件事其余开着的条目（主人面前同一件事只有一个入口）。
        const prefix = value.subjectKey.split(':').slice(0, 2).join(':') + ':';
        // P74r6：说明条目不在这里撤回：说明条目只由说明自己的流程处理（主人选了、说明失效、离开那一次受阻）。
        // 否则回合上限、验收等条目建立时会把说明条目撤掉，而说明记录没有变化，卡片仍写「等你决定」却点不了。新建说明条目本身除外（取代旧的）。
        const keepEscalate = jobKind !== 'escalate';
        for (const other of ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(prefix)
            && !(keepEscalate && row.subjectKey.startsWith(`${prefix}escalate:`)))) {
            ctx.store.table('inbox').patch(other.id, { status: 'withdrawn', answer: '这件事有了新的待办', answeredAt: ctx.clock.now() });
            emitInboxChange(ctx, other);
        }
    }
    else if (isAgreementQuestion) {
        if (value.options?.length !== 1 || value.options[0] !== AGREEMENT_CONFIRM_OPTION)
            throw new Error(`options：约定确认条目的选项必须恰好是「${AGREEMENT_CONFIRM_OPTION}」`);
        if (value.defaultOption !== null)
            throw new Error('defaultOption：约定确认条目不能有默认选项（必须为 null）');
        if (value.expiresAt !== null)
            throw new Error('expiresAt：约定确认条目不会到期（必须显式写 null）');
    }
    else if (isTeamQuestion) {
        if (value.options?.length !== 1)
            throw new Error('options：组队卡确认条目只能有一个按钮');
        if (value.defaultOption !== null)
            throw new Error('defaultOption：组队卡确认条目不能有默认选项（必须为 null）');
        if (value.expiresAt !== null)
            throw new Error('expiresAt：组队卡确认条目不会到期（必须显式写 null）');
    }
    else if (isLearnQuestion) {
        // P75i：学习选会话的条目（教它技能）：每个选项是一段最近的会话（1 到 LEARN_SESSIONS_MAX 个），没有默认选项、永不到期，
        // 理由同 job:——选哪一段只有主人能定，到期按默认处理等于替主人选了一段会话。
        const count = value.options?.length ?? 0;
        if (count < 1 || count > SKILL_DEFAULTS.LEARN_SESSIONS_MAX)
            throw new Error(`options：学习选会话的条目需要 1 到 ${SKILL_DEFAULTS.LEARN_SESSIONS_MAX} 个选项`);
        if (value.defaultOption !== null)
            throw new Error('defaultOption：学习选会话的条目不能有默认选项（必须为 null）');
        if (value.expiresAt !== null)
            throw new Error('expiresAt：学习选会话的条目不会到期（必须显式写 null）');
    }
    else {
        if (value.type === 'question' && (value.options?.length ?? 0) < 2)
            throw new Error('options：提问至少提供两个选项');
        if (value.type === 'question' && ((value.options?.length ?? 0) > 4 || !value.options?.includes(value.defaultOption ?? '')))
            throw new Error('defaultOption：须属于 2 到 4 个选项之一');
    }
    const now = ctx.clock.now();
    const ttl = value.type === 'question' ? ctx.settings.questionExpiryMs : value.type === 'approval' ? ctx.settings.approvalExpiryMs : value.type === 'proposal' ? ctx.settings.proposalExpiryMs : null;
    // P65：只有真的来自主题才写 topicId，其余事项保持旧记录的样子，不多出一个空字段。
    const { topicId, ...fields } = value;
    const row: InboxItem = { ...fields, id: newId('i', ctx.rng),
        options: inboxOptions({ type: value.type, options: value.options ?? [] }),
        defaultOption: inboxDefaultOption({ type: value.type, defaultOption: value.defaultOption ?? null }),
        priority: value.priority ?? (value.type === 'proposal' ? 'P2' : 'P1'), refId: value.refId ?? null, status: value.status ?? 'open',
        answer: value.answer ?? null, pushed: false, createdAt: now, expiresAt: value.expiresAt === undefined ? (ttl === null ? null : now + ttl) : value.expiresAt, answeredAt: null,
        ...(topicId ? { topicId } : {}) };
    ctx.store.table('inbox').put(row);
    // P74r4a：与某件事（或它的约定、发布审批）有关的条目：这件事的「打扰你」累计加一（回执用，不依赖收件箱里还留着条目）。
    if (row.status === 'open')
        bumpDisturbCount(ctx, row);
    emitInboxChange(ctx, row);
    // P76h：条目全部写完之后，按类别决定要不要推送系统通知（唯一入口 notifyOwner）。
    // 不等待结果：notifyOwner 内部自己吞掉所有错误，推送失败不能影响条目已经建成；
    // 已经不是「开着」的条目（例如没被采纳的提议）不推送。
    if (row.status === 'open') {
        const category = notifyCategoryOf(row, options.alertCode);
        if (category !== null)
            void notifyOwner(ctx, { category, title: row.title, body: row.body, subjectKey: row.subjectKey, botId: row.botId, inboxId: row.id });
    }
    return row;
}
/**
 * 把主人答案转换为感知和唤醒候选，让等待中的机器人知道同一事项已有回复。
 * P65：topic 不为空时（主人亲手处理了来自主题、主题还能接着聊的事项），同一条候选带上主题，
 * 接着做的那一回合回到主题，主题里落一句旁白；否则照旧排一条私聊的后续回合。
 */
function replyCandidate(ctx: HubContext, item: InboxItem, answer: string, at: number, ownerInitiated: boolean, topic: ProjectTopic | null = null, ownerNote = ''): void {
    if (!item.botId)
        return;
    // P79：主人答复提议时附了一句话，接在原句后面；没有附言时与原来逐字相同。
    const percept = recordInboxReply(ctx, { botId: item.botId, id: item.id, summary: `主人回复「${item.title}」：${answer}${ownerNote === '' ? '' : `。主人说：${ownerNote}`}`, at });
    const candidate = percept ? buildCandidate(ctx, { botId: item.botId, kind: 'inbox_reply', score: ctx.settings.c02.replySalience,
        ownerInitiated, summary: ownerInitiated ? '主人已回答收件箱事项' : '收件箱事项已按默认选项处理', evidence: [percept.id, item.id], inboxId: item.id, subjectKey: item.subjectKey, now: at,
        ...(topic ? topicReplyFields(topic) : {}) }) : null;
    if (candidate)
        candidate.priority = ctx.settings.c02.priorities.reply;
    if (topic)
        startTopicFollowUp(ctx, { topic, candidate, perceptId: percept?.id ?? null, note: followUpNoteText(item, answer, ownerNote), refId: item.id });
    else if (candidate)
        enqueue(ctx, candidate);
}
/** proposed 实体不能靠自然语言“同意”生效，只在此主人的明确接受命令中激活。 */
async function acceptProposal(ctx: HubContext, item: InboxItem): Promise<void> {
    if (!item.refId)
        return;
    const now = ctx.clock.now();
    const watch = ctx.store.table('watches').get(item.refId);
    if (watch && (watch.botId !== item.botId || watch.status !== 'proposed'))
        throw new Error('关注项不属于该提议，或已经不在等待接受状态');
    if (watch?.status === 'proposed' && watch.botId === item.botId) {
        const bot = ctx.store.table('bots').get(watch.botId)!;
        if (watch.expiresAt !== null && watch.expiresAt <= now)
            throw new Error('关注项已到期，不能接受旧提议');
        if (['file', 'log'].includes(watch.kind)) {
            if (!posix.isAbsolute(watch.target))
                throw new Error('target：关注路径必须是绝对路径');
            const target = posix.normalize(watch.target);
            if (!bot.workDataAllowed && ctx.settings.workDataPaths.some(path => target === posix.normalize(path) || target.startsWith(`${posix.normalize(path)}/`)))
                throw new Error('target：当前未授权读取工作数据目录');
        }
        if (ctx.store.table('watches').count(row => row.botId === watch.botId && row.status !== 'expired') > ctx.settings.maxWatchesPerBot)
            throw new Error('关注项已达到上限，暂不能接受');
        // 提议等待期间没有检查义务；主人接受后才从此刻开始计算期限。
        ctx.store.table('watches').patch(watch.id, { status: 'active', updatedAt: now,
            expectation: watch.expectation ? { ...watch.expectation,
                effectiveAt: Math.max(now, watch.expectation.effectiveAt ?? watch.createdAt), lastMissedAt: null } : null });
        await refreshBotFiles(ctx, watch.botId);
        return;
    }
    const goal = ctx.store.table('goals').get(item.refId);
    if (goal?.status === 'proposed' && goal.botId === item.botId) {
        const target = ctx.store.log('audit').recent(Number.MAX_SAFE_INTEGER, row => row.action === 'proposal_target')
            .map(row => readAuditDetail<{
            proposalId: string;
            targetId: string;
        }>(row.detail)).find(row => row?.proposalId === goal.id);
        const old = target ? ctx.store.table('goals').get(target.targetId) : null;
        if (target && (!old || old.botId !== goal.botId))
            throw new Error('提议对应的原目标不存在或不属于该机器人');
        ctx.store.table('goals').put({ ...goal, id: old?.id ?? goal.id, status: 'active', createdAt: old?.createdAt ?? goal.createdAt, updatedAt: now });
        if (old)
            ctx.store.table('goals').remove(goal.id);
        await refreshBotFiles(ctx, goal.botId);
        return;
    }
    // P75f：教训提议的接受与撤回只在迁移未完成（旧规矩表仍生效）时处理 rules；迁移完成后不再有这条路径。
    const rule = ctx.store.table('rules').get(item.refId);
    if (legacyRulesInEffect(ctx) && rule?.status === 'proposed' && (rule.scope === item.botId || rule.scope === 'global'))
        await upsertRule(ctx, {
            id: rule.id, scope: rule.scope, text: rule.text, redLine: rule.redLine, source: rule.source, status: 'active',
        });
}
/** 拒绝或撤回只关闭本提议创建的草稿，原 active 目标不受影响，也不永久占关注项配额。 */
export async function retireProposalRecord(ctx: HubContext, item: InboxItem): Promise<void> {
    if (!item.refId)
        return;
    const watch = ctx.store.table('watches').get(item.refId);
    if (watch?.status === 'proposed' && watch.botId === item.botId) {
        ctx.store.table('watches').patch(watch.id, { status: 'expired', updatedAt: ctx.clock.now() });
        await refreshBotFiles(ctx, watch.botId);
    }
    const goal = ctx.store.table('goals').get(item.refId);
    if (goal?.status === 'proposed' && goal.botId === item.botId) {
        ctx.store.table('goals').patch(goal.id, { status: 'abandoned', updatedAt: ctx.clock.now() });
        await refreshBotFiles(ctx, goal.botId);
    }
    // P75f：同上，撤回也只在迁移未完成时处理 rules。
    const rule = ctx.store.table('rules').get(item.refId);
    if (legacyRulesInEffect(ctx) && rule?.status === 'proposed' && (rule.scope === item.botId || rule.scope === 'global'))
        await upsertRule(ctx, {
            id: rule.id, scope: rule.scope, text: rule.text, redLine: rule.redLine, source: rule.source, status: 'archived',
        });
    if (item.botId) ctx.emit(HUB_EVENT_SCOPES.bot, item.botId);
}
/** 使用内部模式保留 expired 状态，同时仍执行默认回答和唤醒，保证过期与人工回答语义一致。 */
async function applyAnswer(ctx: HubContext, item: InboxItem, answer: string, expired: boolean, at = ctx.clock.now(), ownerNote = ''): Promise<InboxItem> {
    // P65：这件事来自主题、主人亲手处理、主题还能接着聊时，接着做的那一回合回到主题。
    // 到期按默认处理不是主人的回答，照旧落私聊；审批的去向由 decideApproval 按审批单自己判断。
    let topic: ProjectTopic | null = null;
    if (item.type === 'approval') {
        if (!item.refId)
            throw new Error('审批事项缺少 refId');
        // 旧 answerInbox 调用仍委托唯一的审批决定路径；新界面应直接调用 decideApproval。
        const normalized = answer.trim().toLowerCase();
        if (!['批准', '拒绝', '接受', 'approve', 'reject'].includes(normalized))
            throw new Error('answer：审批合法值为「批准」「拒绝」，请使用 decideApproval');
        const decision = await decideApproval(ctx, item.refId, ['批准', '接受', 'approve'].includes(normalized));
        expired = decision.status === 'expired';
        answer = decision.status === 'approved' ? '批准' : '拒绝';
    }
    else if (item.type === 'alert') {
        // P74r16b：「员工被中心停用」的告警多一种答复：恢复在岗，等同于在员工菜单里点「恢复在岗」。
        if (answer === ALERT_REINSTATE_ANSWER) return reinstateFromAlert(ctx, item);
        if (answer !== '知道了') throw new Error('answer：告警合法值为「知道了」');
        return closeAlertItem(ctx, item.id);
    }
    else {
        if (item.type === 'proposal') {
            const normalized = proposalAnswer(answer);
            if (normalized === null)
                throw new Error('answer：提议合法值为「接受 / 同意 / 好 / accept」或「不做 / 拒绝 / 不要 / reject」');
            answer = normalized;
            const accepted = answer === '接受';
            if (accepted)
                await acceptProposal(ctx, item);
            else {
                await retireProposalRecord(ctx, item);
                writeOutreachAudit(ctx, 'proposal_rejected', { botId: item.botId, title: item.title }, 'owner');
            }
        }
        // 一期完成验收都交给主人；只有明确通过才完成，否定及其他自由文本保守回到进行中。
        if (item.type === 'question' && item.refId) {
            const goal = ctx.store.table('goals').get(item.refId);
            if (goal?.status === 'done_pending_check' && goal.botId === item.botId) {
                await checkGoalAnswer(ctx, goal, answer, expired, at);
                ctx.store.table('goals').patch(goal.id, { status: ['通过', '验收通过', '接受'].includes(answer) ? 'done' : 'active', updatedAt: ctx.clock.now() });
                await refreshBotFiles(ctx, goal.botId);
            }
        }
        topic = expired ? null : followUpTopic(ctx, item.botId, item.topicId);
        replyCandidate(ctx, item, answer, at, !expired, topic, ownerNote);
    }
    // P79：附言记在这条条目的记录上（只有提议带附言，没有附言时不多出这个字段）。
    // P74i-m4（第 4 节）：下面私聊里落的那条答复是以主人身份写的（主人自己的气泡），所以附言不写「主人说：」，
    // 直接接在答复后面「{答复}：{附言}」；给员工看的感知概要（recordInboxReply 那一处）仍写「主人说：{附言}」。
    const result = ctx.store.table('inbox').patch(item.id, { status: expired ? 'expired' : 'answered', answer, answeredAt: at, ...(ownerNote !== '' ? { ownerNote } : {}) });
    // 答案记在卡片所在的线程：主题里的提问卡在主题里，答案已由主题旁白记下，私聊不再多一条没头没尾的回答；
    // 建议卡、审批卡在私聊里，私聊照旧记一笔（来自主题的建议另有主题旁白）。
    // P71：团队全景已下线，没有队友的全队事项（例如中心告警）只留在「待你处理」，不再往团队线程写回答。
    if (item.botId !== null && !(topic && item.type === 'question'))
        postThread(ctx, { thread: item.botId, from: expired ? 'hub' : 'owner', kind: 'reply', text: expired ? `「${item.title}」已按默认回答处理：${answer}` : `「${item.title}」：${answer}${ownerNote === '' ? '' : `：${ownerNote}`}`, refId: item.id });
    writeOutreachAudit(ctx, 'inbox_answer', { id: item.id, answer, expired }, expired ? 'hub' : 'owner');
    emitInboxChange(ctx, item);
    return result;
}
/** 串行处理一张卡片的主人回答，已过期事项按规定默认处理，避免并发接受与拒绝。 */
export async function answerInbox(ctx: HubContext, id: string, answer: string, note?: string): Promise<InboxItem> {
    id = parseInput(nonempty, id, 'id');
    answer = parseInput(z.string(), answer, 'answer').trim();
    // P79：可选附言（主人自己的话）：去掉首尾空白后不超过 200 个字，超过就拒绝；内容不做限制。空附言等于没有。
    const ownerNote = parseInput(z.string().optional(), note, 'note')?.trim() ?? '';
    if ([...ownerNote].length > 200)
        // P74i-m4（第 4 节）：错误文字给主人看，写中文、不带英文字段名。
        throw new Error('附言：不能超过 200 个字');
    return withAnswerLock(ctx, id, async () => {
        const item = ctx.store.table('inbox').get(id);
        if (!item || item.status !== 'open')
            throw new Error('id：事项不存在或已处理');
        // P72c：约定确认条目走专用路径（只认「按建议，定了」，不排通用的 inbox_reply 唤醒，不落通用回答消息）。
        if (isAgreementInboxItem(item)) {
            if (!answer) throw new Error('answer：回答不能为空');
            return confirmFromInbox(ctx, item, answer);
        }
        // P74f：一件事的条目（验收等）分流到各自的专用函数：不走通用回答、不排 inbox_reply 唤醒。
        if (isJobInboxItem(item)) {
            if (!answer) throw new Error('answer：回答不能为空');
            return answerJobInbox(ctx, item, answer);
        }
        // P73c：组队卡确认条目走专用路径（只认当前按钮文字，等同卡片确认，不排通用的 inbox_reply 唤醒）。
        if (isTeamInboxItem(item)) {
            if (!answer) throw new Error('answer：回答不能为空');
            return confirmTeamFromInbox(ctx, item, answer);
        }
        // P75i：教它技能的选会话条目：回答是列出的会话之一时走专用路径（读摘要、排学习唤醒，不排通用的 inbox_reply 唤醒、不叫醒总管）；
        // 主人自己写了一句别的话时，这次学习结束，这句话照普通提问回答的路径交给总管（叫醒总管，决策 DC64）。
        // 动态引入：skill/learn.ts 依赖本文件（建条目、发事件），静态引入会形成循环依赖（同 reinstateFromAlert 的做法）。
        if (isLearnInboxItem(item)) {
            if (!answer) throw new Error('answer：回答不能为空');
            const { answerLearnInbox } = await import('../skill/learn.js');
            const handled = await answerLearnInbox(ctx, item, answer);
            if (handled.handled) return ctx.store.table('inbox').get(item.id)!;
            return applyAnswer(ctx, item, answer, false);
        }
        // 自由文本问题只要求非空；其余类型由各自分支给出完整合法值，而不是笼统的空串错误。
        if (item.type === 'question') answer = parseInput(nonempty.min(1, '回答不能为空'), answer, 'answer');
        if (item.expiresAt !== null && item.expiresAt <= ctx.clock.now()) {
            if (item.type === 'question') {
                await applyAnswer(ctx, item, item.defaultOption ?? '暂不处理', true);
                throw new Error('事项已过期，已按默认回答处理');
            }
            if (item.type === 'proposal') {
                await retireProposalRecord(ctx, item);
                ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '到期撤回', answeredAt: ctx.clock.now() });
                emitInboxChange(ctx, item);
                throw new Error('提议已过期并撤回');
            }
        }
        // 附言只对提议有意义；其他类型即使带了也忽略（审批另有自己的备注通道 decideApproval）。
        return applyAnswer(ctx, item, answer, false, ctx.clock.now(), item.type === 'proposal' ? ownerNote : '');
    });
}
/** 检查问题、提议和告警的期限或恢复状态，落实默认回答、撤回和关闭。 */
export async function expireInbox(ctx: HubContext, now: number): Promise<void> {
    now = parseInput(timestamp, now, '过期检查时间');
    for (const item of ctx.store.table('inbox').list(row => row.status === 'open')) {
        if (item.type === 'alert' && item.refId && ctx.store.table('alerts').get(item.refId)?.status === 'closed') {
            closeAlertItem(ctx, item.id, 'hub');
            continue;
        }
        if (item.type === 'question') {
            if (item.expiresAt !== null && item.expiresAt <= now) {
                await withAnswerLock(ctx, item.id, async () => {
                    const current = ctx.store.table('inbox').get(item.id);
                    if (current?.status === 'open')
                        await applyAnswer(ctx, current, current.defaultOption ?? '暂不处理', true, now);
                });
            }
            // P76c：原来在这里给开着满 24 小时的提问写一条「日报提醒」审计（question_reminder），日报取消后没有读者，分支删除。
            // 满 24 小时的提醒由 P76g 用总管私聊提醒另行实现。
        }
        else if (item.type === 'proposal' && item.expiresAt !== null && item.expiresAt <= now) {
            await withAnswerLock(ctx, item.id, async () => {
                const current = ctx.store.table('inbox').get(item.id);
                if (current?.status !== 'open')
                    return;
                await retireProposalRecord(ctx, current);
                ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '到期撤回', answeredAt: now });
                emitInboxChange(ctx, current);
            });
        }
    }
}
/** P74r16b：员工被中心停用的告警条目上，主人选择「恢复在岗」时的答复取值（界面按钮传这个值）。 */
export const ALERT_REINSTATE_ANSWER = 'reinstate';
/** 这条告警条目对应的、此刻仍被中心停用的员工；不是员工被停用的告警，或员工已不是停用状态，返回 null。 */
export function quarantinedBotOfAlertItem(ctx: HubContext, item: Pick<InboxItem, 'type' | 'refId'>) {
    const alert = item.type === 'alert' && item.refId ? ctx.store.table('alerts').get(item.refId) : null;
    if (!alert || alert.code !== 'quarantine' || !alert.botId) return null;
    const bot = ctx.store.table('bots').get(alert.botId);
    return bot && bot.lifecycle === 'quarantined' ? bot : null;
}
/**
 * P74r16b：在「员工被中心停用」的告警条目上恢复员工在岗：调用现有的恢复入口（lifecycleAction 的 reinstate），
 * 恢复时那条告警及其条目随之关闭（api/bots.ts）；员工已经不是停用状态时拒绝，什么都不改。
 */
async function reinstateFromAlert(ctx: HubContext, item: InboxItem): Promise<InboxItem> {
    const alert = item.refId ? ctx.store.table('alerts').get(item.refId) : null;
    if (!alert || alert.code !== 'quarantine' || !alert.botId) throw new Error('answer：这条告警不能恢复在岗，合法值为「知道了」');
    const bot = quarantinedBotOfAlertItem(ctx, item);
    if (bot === null) {
        // P74r17（低-5）：按员工的实际状态回答，不再一律说「已经在岗」：已归档、被主人停用时那句不是事实。
        const current = ctx.store.table('bots').get(alert.botId);
        const name = current?.name ?? '员工';
        if (current !== null && (current.lifecycle === 'retired' || current.archivedAt != null)) throw new Error(`${name}已归档，不能恢复在岗。`);
        if (current !== null && current.lifecycle === 'paused') throw new Error(`${name}现在是你停用的，请在员工菜单里恢复在岗。`);
        throw new Error(`${name}已经在岗，不需要恢复。`);
    }
    // 动态引入：api/bots.ts 在加载时就依赖本文件所在的一串模块，静态引入会形成循环依赖，使个别模块加载时拿到未初始化的值。
    const { lifecycleAction } = await import('../api/bots.js');
    await lifecycleAction(ctx, { botId: bot.id, action: 'reinstate' });
    writeOutreachAudit(ctx, 'inbox_answer', { id: item.id, answer: ALERT_REINSTATE_ANSWER, expired: false }, 'owner');
    // 恢复时告警和条目已经由中心关闭；万一条目仍开着（告警记录对不上），在这里关闭，保证「条目随之关闭」。
    const current = ctx.store.table('inbox').get(item.id)!;
    return current.status === 'open' ? closeAlertItem(ctx, item.id, 'hub') : current;
}
/** 同时关闭告警事实与收件箱卡片，并保留是主人还是中心操作的审计记录。 */
export function closeAlertItem(ctx: HubContext, id: string, actor: 'owner' | 'hub' = 'owner'): InboxItem {
    const item = ctx.store.table('inbox').get(parseInput(nonempty, id, 'id'));
    if (!item || item.type !== 'alert')
        throw new Error('id：告警事项不存在');
    if (item.refId && ctx.store.table('alerts').get(item.refId))
        ctx.store.table('alerts').patch(item.refId, { status: 'closed', count: 0 });
    const result = ctx.store.table('inbox').patch(id, { status: 'closed', answer: actor === 'owner' ? '知道了' : '已关闭', answeredAt: ctx.clock.now() });
    writeOutreachAudit(ctx, 'alert_closed', { id }, actor);
    emitInboxChange(ctx, item);
    return result;
}
