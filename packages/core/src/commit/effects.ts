/** 交账后的可见结果集中路由：只推进有证据关联的目标，提问和提议复用收件箱统一规则。 */
import type { HubContext } from '../engine/context.js';
import type { Commit, Goal, WakeTicket, InboxItem } from '../model/index.js';
import { createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { requestPush, type PushInput } from '../outreach/push.js';
import { submitProposal } from '../outreach/proposals.js';
import { fingerprint } from '../util/hash.js';
import { optionalMessageText } from '../util/text.js';
/** 不把一个完成声明误套给所有目标；证据可引用目标或带 goalId 的议程。 */
export function relatedGoals(ctx: HubContext, commit: Commit, wake: WakeTicket): Goal[] {
    const evidence = new Set([...commit.evidence, ...wake.reason.evidence]);
    for (const id of [...evidence]) {
        const agenda = ctx.store.table('agenda').get(id);
        if (agenda?.botId === commit.botId && agenda.goalId)
            evidence.add(agenda.goalId);
    }
    const goals = ctx.store.table('goals').list(g => g.botId === commit.botId && ['active', 'blocked'].includes(g.status));
    const explicit = goals.filter(g => evidence.has(g.id));
    return explicit.length ? explicit : wake.variant !== 'reflection' && goals.length === 1 ? goals : [];
}
/** 把交账回复、汇报、问题和提议送到相应线程与收件箱，先保留事实再处理可能失败的单推。 */
export async function routeCommit(ctx: HubContext, commit: Commit, wake: WakeTicket, goalQuestions: InboxItem[] = []): Promise<void> {
    const { botId } = commit;
    // 路由也检查正文，兼容历史交账与中心合成交账，空值不占线程和打扰预算。
    const reply = optionalMessageText(commit.reply);
    const report = optionalMessageText(commit.report);
    const pushes: Array<{
        input: PushInput;
        inboxId?: string;
    }> = goalQuestions.map(item => ({ inboxId: item.id,
        input: { botId, level: 'P1', title: item.title, body: item.body, subjectKey: item.subjectKey } }));
    if (wake.syntheticCommit && wake.reason.kind === 'owner_message')
        postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: '机器人没有回复', refId: commit.id });
    else if (reply !== null)
        postThread(ctx, { thread: botId, from: botId, kind: 'reply', text: reply, refId: commit.id });
    else if (wake.reason.kind === 'owner_message' && !wake.ownerDirect)
        postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: '机器人没有回复', refId: commit.id });
    if (report !== null) {
        postThread(ctx, { thread: botId, from: botId, kind: 'report', text: report, refId: commit.id });
    }
    if (commit.ownerQuestion) {
        const q = commit.ownerQuestion;
        const item = createInboxItem(ctx, { botId, type: 'question', title: q.text, body: q.whyNeeded,
            options: q.options, defaultOption: q.defaultOption, priority: 'P1', refId: commit.id,
            subjectKey: `question:${commit.id}` });
        // 问题以自己的收件箱身份去重，不能封锁通用思考预约。
        ctx.store.table('inbox').patch(item.id, { subjectKey: `question:${item.id}` });
        item.subjectKey = `question:${item.id}`;
        postThread(ctx, { thread: botId, from: botId, kind: 'question', text: `${q.text}\n${q.whyNeeded}`, refId: item.id });
        pushes.unshift({ inboxId: item.id, input: { botId, level: 'P1', title: q.text, body: q.whyNeeded, subjectKey: item.subjectKey } });
    }
    for (const proposal of commit.proposals)
        await submitProposal(ctx, botId, { ...proposal, refId: commit.id });
    if (report !== null && commit.importance >= ctx.settings.c03.reportPushImportance)
        pushes.push({ input: {
                botId, level: 'P2', title: '机器人汇报', body: report, subjectKey: `report:${botId}:${fingerprint(report)}`,
            } });
    // 先保存所有线程与收件箱，再逐个申请通知；一条通知失败不能吃掉后面的提问或提议。
    const failures: string[] = [];
    for (const push of pushes) {
        try {
            const result = await requestPush(ctx, push.input);
            if (push.inboxId)
                ctx.store.table('inbox').patch(push.inboxId, { pushed: result === 'sent' });
        }
        catch (error) {
            failures.push(String(error));
        }
    }
    if (failures.length)
        throw new Error(`交账内容已保存，单推失败：${failures.join('；')}`);
}
/** done 只是申请验收；规则验收一期也交给主人，避免自报完成直接改变最终状态。 */
export function updateCommitGoals(ctx: HubContext, commit: Commit, wake: WakeTicket): InboxItem[] {
    const questions: InboxItem[] = [];
    if (commit.outcome !== 'progress' && commit.outcome !== 'done')
        return questions;
    for (const goal of relatedGoals(ctx, commit, wake)) {
        ctx.store.table('goals').patch(goal.id, { lastProgressAt: commit.createdAt, updatedAt: commit.createdAt,
            ...(commit.outcome === 'done' ? { status: 'done_pending_check' as const } : {}) });
        if (commit.outcome === 'done') {
            const item = createInboxItem(ctx, { botId: commit.botId, type: 'question', title: `${goal.title} 做完了，请验收`,
                body: `完成标准：${goal.doneWhen}\n交账：${commit.summary}`, options: ['通过', '未通过'], defaultOption: '未通过',
                priority: 'P1', refId: goal.id, subjectKey: `goal_check:${goal.id}` });
            postThread(ctx, { thread: commit.botId, from: commit.botId, kind: 'question', text: item.title, refId: item.id });
            questions.push(item);
        }
    }
    return questions;
}
