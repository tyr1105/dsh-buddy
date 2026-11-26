/** 交账后的可见结果集中路由：只推进有证据关联的目标，提问和提议复用收件箱统一规则。 */
import type { HubContext } from '../engine/context.js';
import type { Commit, Goal, WakeTicket, InboxItem } from '../model/index.js';
import { createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { submitProposal } from '../outreach/proposals.js';
import { optionalMessageText } from '../util/text.js';
import { resultCheckBody } from './result-check.js';
import { botMbti } from '../personality/profile.js';
import { personalityBehavior, personalityReport } from '../personality/behavior.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postAgreementCards } from '../project/agreement-cards.js';
import { postTeamCardsOfWake } from '../team/cards.js';
import { isPickTurn } from '../team/pick-key.js';
import { eventsOf } from '../job/store.js';
import { attachMemoryReply } from '../memory/service.js';
import { parseSkillKey } from '../skill/keys.js';
import { postLearnCards } from '../skill/learn-card.js';
/** 不把一个完成声明误套给所有目标；证据可引用目标或带 goalId 的议程。 */
export function relatedGoals(ctx: HubContext, commit: Commit, wake: WakeTicket): Goal[] {
    // P74c：执行链的回合做的是一件已约定的事，不推进员工自己的长期目标，也不生成目标验收提问。
    if (wake.jobId)
        return [];
    // P75g：复盘、核对、改写、整理的回合同样不推进目标、不生成目标验收提问（任务卡第 8 节）。
    if (parseSkillKey(wake.subjectKey ?? null) !== null)
        return [];
    const evidence = new Set([...commit.evidence, ...wake.reason.evidence]);
    for (const id of [...evidence]) {
        const agenda = ctx.store.table('agenda').get(id);
        if (agenda?.botId === commit.botId && agenda.goalId)
            evidence.add(agenda.goalId);
    }
    const goals = ctx.store.table('goals').list(g => g.botId === commit.botId && ['active', 'blocked'].includes(g.status));
    const explicit = goals.filter(g => evidence.has(g.id));
    // P63：主题里说的话不等于推进了队友自己的长期目标，只认明确引用的目标；否则说一句「完成了」就会弹验收卡。
    return explicit.length ? explicit : wake.variant !== 'reflection' && !wake.topicId && goals.length === 1 ? goals : [];
}
/** 把交账回复、汇报、问题和提议送到相应线程与收件箱，先保留事实再处理可能失败的单推。 */
export async function routeCommit(ctx: HubContext, commit: Commit, wake: WakeTicket, goalQuestions: InboxItem[] = []): Promise<void> {
    const { botId } = commit;
    // P75g（任务卡第 8 节）：复盘、核对、改写、整理回合的交账单独路由——reply、report 不落私聊、
    // 不落「没有回复」的提示、不推送；本回合没有落复盘卡（或核对卡）时，reply 以 work 落到这件事的主题
    // （refId 归入「复盘」折叠组）；落了卡时不再落。提问在交账入口已被拒（processCommit）。
    // 提议（proposals）：复盘回合只读，本不该提议；这里一律不送进「待你处理」（任务卡第 10 节：全程不给主人发通知），
    // 静默忽略（保守默认，见进度记录与 docs/questions.md）。
    const skillKey = parseSkillKey(wake.subjectKey ?? null);
    if (skillKey !== null) {
        const run = ctx.store.table('skillRuns').get(skillKey.runId);
        const job = run?.jobId == null ? null : ctx.store.table('jobs').get(run.jobId);
        if (job !== null) {
            const cardPosted = ctx.store.log('thread').all().some(row => row.thread === job.topicId && row.from === botId
                && row.kind === 'job_card' && row.createdAt >= wake.startedAt
                && (row.refId?.startsWith('retro:') === true || row.refId?.startsWith('skillcheck:') === true));
            const reply = optionalMessageText(commit.reply);
            if (!cardPosted && reply !== null) {
                postThread(ctx, { thread: job.topicId, from: botId, kind: 'work', text: reply, refId: `retro-summary:${skillKey.runId}:${wake.id}` });
            }
        }
        return;
    }
    // P74c（方案 5.7.3）：执行链回合（唤醒单带 jobId）的话落在这件事的主题里，作为「工作往来」，不落私聊。
    const job = wake.jobId ? ctx.store.table('jobs').get(wake.jobId) : null;
    // P63：票据属于项目主题时，回复、汇报和提问都落回主题，让所有人看到同一条聊天。
    const thread = job?.topicId ?? wake.topicId ?? botId;
    // 路由也检查正文，兼容历史交账与中心合成交账，空值不占线程和打扰预算。
    let reply = optionalMessageText(commit.reply);
    const report = optionalMessageText(commit.report);
    // 本回合这位员工已经产生了交回、核对、回答、转交、说明或提问：卡片和提示已经把话说了，reply 不再重复落一遍；report 照落。
    if (job && reply !== null && eventsOf(ctx, job.id).some(event => event.actor === botId && event.at >= wake.startedAt
        && ['submitted', 'reviewed', 'answered', 'forwarded', 'escalated', 'asked'].includes(event.kind)))
        reply = null;
    // W11：挑人回合里总管已经出了组队卡，中心在卡前替它落了结论（挑了谁、各做什么），reply 不再落，免得主人连看两句同样的话。
    const pickedHere = isPickTurn(wake) && ctx.store.table('teamProposals').count(row => row.wakeId === wake.id && row.pickedBy === 'chief') > 0;
    if (pickedHere)
        reply = null;
    // P76h：交账不再推送（员工提问、目标验收提问、汇报都只落线程和「待你处理」）；goalQuestions 保留为参数，调用方不用改。
    void goalQuestions;
    // 执行链回合：用 work 类型（折叠进「工作往来」），refId 是交账 id（视图据此写「谁 → 谁」）；不出现「机器人没有回复」。
    if (job) {
        if (reply !== null)
            postThread(ctx, { thread, from: botId, kind: 'work', text: reply, refId: commit.id });
    }
    else if (wake.syntheticCommit && wake.reason.kind === 'owner_message')
        postThread(ctx, { thread, from: 'hub', kind: 'system', text: '机器人没有回复', refId: commit.id });
    else if (reply !== null) {
        const posted = postThread(ctx, { thread, from: botId, kind: 'reply', text: reply, refId: commit.id });
        // P75c：这一回合记下的规矩或偏好，「已记住」挂在这条回复下面（回复落下之后立刻挂；出错只记日志，回合结束时还会检查一次）。
        try {
            attachMemoryReply(ctx, wake.id, thread, posted.id);
        }
        catch (error) {
            ctx.logger.error(`「已记住」挂靠失败，交账 ${commit.id} 已保留`, error);
        }
    }
    else if (wake.reason.kind === 'owner_message' && !wake.ownerDirect && !pickedHere)
        postThread(ctx, { thread, from: 'hub', kind: 'system', text: '机器人没有回复', refId: commit.id });
    // P75i：总管这一回合请主人选会话（teach）建了「待你处理」的条目时，回复落下之后紧跟着在总管私聊落一张提问卡；
    // 没有回复时也落。出错只记日志（回合结束时 turn/events.ts 还会检查一次）。
    try {
        postLearnCards(ctx, wake);
    }
    catch (error) {
        ctx.logger.error(`学习选会话的提问卡没有落成，交账 ${commit.id} 已保留`, error);
    }
    if (report !== null) {
        // 只节略普通自主汇报的展示；主人要求与重要汇报全文保留，原交账不改。
        const behavior = personalityBehavior(botMbti(ctx, botId), ctx.settings);
        const displayed = personalityReport(report, behavior, wake.ownerInitiated || wake.ownerDirect === true
          || wake.reason.kind === 'owner_message' || commit.importance >= ctx.settings.c03.reportPushImportance);
        postThread(ctx, { thread, from: botId, kind: job ? 'work' : 'report', text: displayed, refId: commit.id });
        if (displayed !== report) writeOutreachAudit(ctx, 'personality_report_shortened', {
            botId, commitId: commit.id, wakeId: wake.id, maxChars: behavior!.reportMaxChars,
            originalChars: [...report].length, displayedChars: [...displayed].length,
        }, botId);
    }
    // P72b：本回合提交的约定在 reply、report 之后发卡，线程顺序是「一句结论 → 建主题旁白 → 约定卡」。
    // 发卡出错只记日志，不能挡住后面的提问、提议和单推。
    try {
        postAgreementCards(ctx, wake.id);
    }
    catch (error) {
        ctx.logger.error(`约定发卡失败，交账 ${commit.id} 已保留`, error);
    }
    // P73d：本回合推荐的新员工（组队卡）同样在 reply 之后发卡，并建「待你处理」条目；出错同样只记日志。
    try {
        postTeamCardsOfWake(ctx, wake.id);
    }
    catch (error) {
        ctx.logger.error(`组队卡发卡失败，交账 ${commit.id} 已保留`, error);
    }
    if (commit.ownerQuestion) {
        const q = commit.ownerQuestion;
        // P65：主题回合里提的问题记下来源主题，主人回答后接着做的那一回合回到这个主题。
        const item = createInboxItem(ctx, { botId, type: 'question', title: q.text, body: q.whyNeeded,
            options: q.options, defaultOption: q.defaultOption, priority: 'P1', refId: commit.id,
            // P76c：员工新提的普通提问不再到期（原来按 questionExpiryMs 72 小时到期、按默认选项处理）。
            // 默认选项仍写在条目上，但不会被自动采用；已有的旧提问保持原到期时间。
            // 注意：开着、没有到期时间的提问会让这位员工自己发起的候选一直被「等主人」闸门拦住（openOwnerAskUntil 为 null），这是第一块已定的行为。
            expiresAt: null,
            subjectKey: `question:${commit.id}`, ...(wake.topicId ? { topicId: wake.topicId } : {}) });
        // 问题以自己的收件箱身份去重，不能封锁通用思考预约。
        ctx.store.table('inbox').patch(item.id, { subjectKey: `question:${item.id}` });
        item.subjectKey = `question:${item.id}`;
        postThread(ctx, { thread, from: botId, kind: 'question', text: `${q.text}\n${q.whyNeeded}`, refId: item.id });
        // 收件箱的去处不变；主题里提一句，主人知道这个问题也在「待你处理」里。
        if (wake.topicId) postThread(ctx, { thread, from: 'hub', kind: 'system', text: '这个问题也放进了「待你处理」，回答后它会继续处理。', refId: item.id });
    }
    // P65：交账里的建议按本回合明确记来源主题（不是主题回合就记 null），不去猜别的回合。
    for (const proposal of commit.proposals)
        await submitProposal(ctx, botId, { ...proposal, refId: commit.id, topicId: wake.topicId ?? null });
    if (wake.topicId && commit.proposals.length > 0)
        postThread(ctx, { thread, from: 'hub', kind: 'system', text: `它提了 ${commit.proposals.length} 条建议，放进了「待你处理」。`, refId: commit.id });
    // P76h：这里原来按重要度单推汇报、并逐条推送员工提问，整段已删除：汇报只落线程，提问只进「待你处理」。
}
/** done 只是申请验收；规则验收一期也交给主人，避免自报完成直接改变最终状态。 */
export function updateCommitGoals(ctx: HubContext, commit: Commit, wake: WakeTicket): InboxItem[] {
    const questions: InboxItem[] = [];
    // P74c：执行链的回合不推进目标、不生成目标验收提问。
    if (wake.jobId || (commit.outcome !== 'progress' && commit.outcome !== 'done'))
        return questions;
    // P74f（裁定 15）：总管交账 done 不再生成目标验收提问。总管名下的事由中心交付、由主人在交付卡上验收，
    // 再生成一条「做完了，请验收」会让主人面前同一件事出现两个验收入口；其他员工的目标验收照旧。
    const byChief = ctx.store.table('bots').get(commit.botId)?.role === 'chief';
    for (const goal of relatedGoals(ctx, commit, wake)) {
        ctx.store.table('goals').patch(goal.id, { lastProgressAt: commit.createdAt, updatedAt: commit.createdAt,
            ...(commit.outcome === 'done' && !byChief ? { status: 'done_pending_check' as const } : {}) });
        if (commit.outcome === 'done' && !byChief) {
            const item = createInboxItem(ctx, { botId: commit.botId, type: 'question', title: `${goal.title} 做完了，请验收`,
                body: resultCheckBody(goal, commit, ctx.store.table('resultChecks').get(commit.id)), options: ['通过', '未通过'], defaultOption: '未通过',
                priority: 'P1', refId: goal.id, subjectKey: `goal_check:${goal.id}` });
            postThread(ctx, { thread: commit.botId, from: commit.botId, kind: 'question', text: item.title, refId: item.id });
            questions.push(item);
        }
    }
    return questions;
}
