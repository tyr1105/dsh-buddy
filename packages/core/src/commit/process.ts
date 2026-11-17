import { recordViolation } from '../gate/guard.js';
/** 交账先锁定唯一记录，再更新状态与派生文件；文件失败保留真实交账并显式报告，避免重复执行副作用。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { CommitInputSchema, CommitToolSchema } from './schema.js';
import { pendingOwnerConfirmOf, questionBlockedText } from '../team/owner-confirm.js';
import { CHIEF_WAITING_TEXT } from '../team/setup-state.js';
import { newId } from '../util/ids.js';
import { formatShort } from '../util/time.js';
import type { Commit } from '../model/index.js';
import { ToolContextSchema, type ToolContext, type ToolResult } from '../tools/types.js';
import { createOwnerDirectWake, findOpenWake, isOpenWake } from '../turn/session.js';
import { applyNextThink } from '../agenda/next-think.js';
import { afterOutcome } from '../scheduler/pacing.js';
import { computeExpectedBy } from '../health/deadman.js';
import { appendJournal, refreshBotFiles, verifyProtectedFiles, verifyManagedFiles } from '../memory/index.js';
import { PathContainmentError } from '../io/interfaces.js';
import { relatedGoals, routeCommit, updateCommitGoals } from './effects.js';
import { recordResultCheck } from './result-check.js';
import { centralToolKindsOf, clearCentralToolKinds, completionEvidenceFor, hasCompletionClaim, hasCompletionEvidence, noteUnverifiedClaims } from './claim-evidence.js';
import { backoffReviewsAfterCommit } from '../tools/review-backoff.js';
import { removeEntry } from '../scheduler/queue.js';
import { computeDrives } from '../drives/compute.js';
import { optionalMessageText } from '../util/text.js';
import { archiveCommitArtifacts } from '../artifacts/archive.js';
import { continueJobAfterCommit } from '../job/continue.js';
import { recentAcceptedTitles } from '../job/recent-closed.js';
import { blockedActivityText } from '../job/blocked-shown.js';
import { parseSkillKey } from '../skill/keys.js';
import { SKILL_OWNER_VISIBLE_REFUSAL, internalNameIn } from '../job/owner-text.js';
/** 核对回合身份后只接收一次交账，更新目标与下次思考，并隔离各项派生写入失败。 */
export async function processCommit(ctx: HubContext, rawContext: ToolContext, rawArgs: unknown): Promise<ToolResult> {
    try {
        const toolCtx = parseInput(ToolContextSchema, rawContext, '工具上下文');
        // P72j J1 / P73d：总管名下有待确认的约定或组队卡时，那张卡是唯一的确认入口：
        // 带 ownerQuestion 交账一律拒绝（会生成第二张提问卡，且到期会按默认选项叫醒总管），needs_owner 则不再要求 ownerQuestion。
        // 判断集中在 team/owner-confirm.ts 的 pendingOwnerConfirmOf，这里只按种类给出报错文字。
        const ownerPending = toolCtx.botId !== undefined && ctx.store.table('bots').get(toolCtx.botId)?.role === 'chief'
            ? pendingOwnerConfirmOf(ctx, toolCtx.botId) : null;
        const input = parseInput(ownerPending ? CommitToolSchema : CommitInputSchema, rawArgs, '交账');
        if (ownerPending && input.ownerQuestion)
            throw new Error(questionBlockedText(ownerPending));
        // 先校验类型，再统一空值；避免模型传入文字 null 冒充给主人回复或主动汇报。
        const args = { ...input, reply: optionalMessageText(input.reply), report: optionalMessageText(input.report) };
        const bot = ctx.store.table('bots').get(toolCtx.botId);
        if (!bot || bot.sessionId !== toolCtx.sessionId)
            throw new Error('交账 botId 与 sessionId 不匹配');
        let wake = toolCtx.wakeId ? ctx.store.table('wakes').get(toolCtx.wakeId) : findOpenWake(ctx, toolCtx.sessionId);
        if (toolCtx.wakeId && !wake)
            throw new Error('交账 wakeId 不存在');
        if (wake && (wake.botId !== bot.id || wake.sessionId !== toolCtx.sessionId))
            throw new Error('交账 wakeId 与当前机器人会话不匹配');
        if (wake?.commitId)
            throw new Error('本轮已交账');
        if (wake && !isOpenWake(wake))
            throw new Error('本轮已结束，不能交账');
        if (wake?.reason.kind === 'owner_message' && !wake.ownerDirect && !args.reply?.trim())
            throw new Error('reply：主人消息唤醒的回合必须回复主人');
        // P74c（方案 5.2.4）：执行链的回合不能向主人提问。员工要问总管用 hub_job_work 的 ask，做不下去用 block；
        // 总管要主人决定的事走新版约定（主人发起的回合里）或 hub_job_manage 的 escalate（P74f-2）。否则会生成带默认答案和期限的提问，违反「需要主人确认的事只有一个入口」。
        // P74r2a：拒绝文字只写现在真能做成的做法；P74f-2 起 escalate 已存在，两条路各自的适用情形都写进来。
        // 和 P72j J1 同一做法：拒绝发生在保存交账之前，本回合改正后可以再交账。主人发起的总管回合不受影响。
        if (wake?.jobId && args.ownerQuestion) {
            if (bot.role !== 'chief')
                throw new Error('员工不直接问主人。问总管用 hub_job_work 的 ask；做不下去用 block。');
            if (!wake.ownerInitiated)
                throw new Error('这一回合是处理一件事的回合，不能直接向主人提问。能按约定回答的，用 hub_job_manage 的 answer；要换人，用 hub_job_manage 的 reassign；核对三轮仍不过、或执行者做不下去而你解决不了时，用 hub_job_manage 的 mode escalate 向主人说明并给出办法；执行者或核对人的提问在约定里推不出答案时，用 hub_agreement_submit 的 mode revise 出新版本请主人确认。');
        }
        // P75g：复盘、核对、改写、整理的回合不向主人提问（任务卡第 8 节，逐字）；有问题写进 hub_skill 的 note。
        // 和上面的拒绝同一做法：发生在保存交账之前，本回合改正后可以再交账。
        if (wake !== null && parseSkillKey(wake.subjectKey ?? null) !== null && args.ownerQuestion) {
            throw new Error('复盘回合不能向主人提问，有问题写进 note');
        }
        // P75r5b（审查 M5）：技能类回合的 reply 会以工作往来落进主题给主人看，写入之前查内部名称，查到就拒绝这次交账
        // （同样发生在保存交账之前，本回合改正后可以再交账；文字逐字固定）。
        if (wake !== null && parseSkillKey(wake.subjectKey ?? null) !== null && args.reply !== null && internalNameIn(args.reply) !== null) {
            throw new Error(SKILL_OWNER_VISIBLE_REFUSAL);
        }
        const now = ctx.clock.now();
        wake ??= createOwnerDirectWake(ctx, bot.id, toolCtx.sessionId, '主人直接聊天时的交账', now);
        // 在第一次 await 之前保存 commitId；并发重复调用只能看到“已交账”。
        const commit: Commit = { ...args, id: newId('c', ctx.rng), wakeId: wake.id, botId: bot.id, createdAt: now };
        ctx.store.table('commits').put(commit);
        ctx.store.table('wakes').patch(wake.id, { status: 'committed', commitId: commit.id, lastEventAt: now });
        // P76q 第 2 条：总管说「已改好 / 已完成」之前要能有可核对的证据（检查结果、文件变更或本回合的交付回执）；
        // P85：没有就原话不动，在这段话末尾另起一行补一句固定的话（不再改写句中的动词）；本回合中心工具已经办成的事对应的说法放行。
        // 只改给主人看的 reply、report，摘要和记录里的其余内容不动。
        // 这一步要读文件，必须排在交账锁定之后：两个并发交账只有一个能走到这里，另一个会看到「本轮已交账」。
        // 核对本身出错不挡交账：保留原文并记日志，不能让读盘故障变成一次失败的交账。
        const toolKinds = centralToolKindsOf(ctx, wake.id);
        clearCentralToolKinds(ctx, wake.id);
        // P88r1：这位总管名下最近验收完成的事的标题，说的是这些事的句子不补那一句（验收记录就是证据）；只对总管取。
        const acceptedTitles = bot.role === 'chief' ? recentAcceptedTitles(ctx, bot.id) : [];
        if (bot.role === 'chief' && [commit.reply, commit.report].some(text => text !== null && hasCompletionClaim(text, toolKinds, acceptedTitles))) {
            try {
                const evidence = await completionEvidenceFor(ctx, bot, wake, { worldChanges: commit.worldChanges, verification: commit.verification });
                if (!hasCompletionEvidence(evidence)) {
                    commit.reply = commit.reply === null ? null : noteUnverifiedClaims(commit.reply, toolKinds, acceptedTitles);
                    commit.report = commit.report === null ? null : noteUnverifiedClaims(commit.report, toolKinds, acceptedTitles);
                    ctx.store.table('commits').patch(commit.id, { reply: commit.reply, report: commit.report });
                }
            } catch (error) {
                ctx.logger.warn('完成声明核对失败，交账按原文保留', { commitId: commit.id, error: String(error) });
            }
        }
        // 主人暂停或退役不取消在途交账；完成交账时仍显示主人设置的停止状态。
        const stopped = bot.lifecycle === 'paused' || bot.lifecycle === 'retired';
        // 带提问，或 needs_owner（总管等约定确认时不带提问）都显示为在等主人。
        const waitingOwner = Boolean(args.ownerQuestion) || args.outcome === 'needs_owner';
        let updated = ctx.store.table('bots').patch(bot.id, { ...afterOutcome(bot, args.outcome, false), lastThinkAt: now,
            consecutiveNoCommit: 0, consecutiveErrors: 0, retryAt: null,
            activity: stopped ? 'resting' : waitingOwner ? 'waiting_owner' : args.outcome === 'blocked' ? 'blocked' : 'watching',
            activityText: stopped ? bot.lifecycle === 'paused' ? '已停用（你停用的）' : '已归档'
                : ownerPending?.kind === 'team' ? CHIEF_WAITING_TEXT // P73d：组队卡在等主人确认时，状态行写「等你确认新员工」
                : waitingOwner ? '在等主人回复' : args.outcome === 'blocked' ? blockedActivityText(args.blocker, wake.jobId) : '继续关注变化', updatedAt: now });
        const reviewWarning = backoffReviewsAfterCommit(ctx, commit, wake);
        // 交账重设了时间意图，旧时钟候选不能再触发第二轮轻复查。
        // P74c：执行链的候选（续排、兜底用的也是 next_think）不属于「旧的时间意图」，不能被别的回合的交账顺手清掉。
        for (const entry of ctx.store.table('queue').list(q => q.botId === bot.id && q.enqueuedAt <= now && !q.jobId && ['light_check', 'next_think'].includes(q.reason.kind)))
            removeEntry(ctx, entry.id);
        // 先独立实查，再发布验收卡；唯一交账已锁住，等待文件接口不会接受第二次交账。
        let archiveWarning = '';
        if (args.outcome === 'done' || args.outcome === 'progress') {
            try {
                const archived = await archiveCommitArtifacts(ctx, commit, relatedGoals(ctx, commit, wake));
                const missed = archived.items.filter(item => !item.versionId).length;
                archiveWarning = missed ? `注意：${missed} 个位置未归档，原因见产物列表。` : '';
            } catch {
                archiveWarning = '注意：产物归档失败，交账已保留。';
                ctx.logger.warn('产物归档失败，交账已保留', { commitId: commit.id });
            }
            await recordResultCheck(ctx, commit, relatedGoals(ctx, commit, wake));
        }
        const goalQuestions = updateCommitGoals(ctx, commit, wake);
        const patch = applyNextThink(updated, args.nextThink, now, { settings: ctx.settings,
            hasActiveGoal: ctx.store.table('goals').count(g => g.botId === bot.id && g.status === 'active') > 0,
            quotaLight: ctx.store.table('quota').get('quota')?.light ?? 'green' });
        const { warning, ...next } = patch;
        updated = ctx.store.table('bots').patch(bot.id, next);
        refreshExpectedBy(ctx, bot.id);
        // 内驱快照保存受挫事实；不在交账入口消费当天内驱唤醒名额。
        const drive = ctx.store.table('drives').get(bot.id);
        if (drive) {
            const values = computeDrives(updated, ctx.store.table('goals').list(), ctx.store.table('agenda').list(), ctx.store.table('inbox').list(), ctx.store.table('handoffs').list(), ctx.store.table('commits').list(), drive.fatigue, now, ctx.settings);
            ctx.store.table('drives').patch(bot.id, args.outcome === 'progress' || args.outcome === 'done'
                ? { stagnation: 0, obligation: 0, waiting: 0, frustration: 0, updatedAt: now } : { ...values, updatedAt: now });
        }
        const failures: string[] = [];
        let containmentRecorded = false;
        for (const [label, effect] of [
            ['保护核对', () => verifyProtectedFiles(ctx, bot.id)],
            // P75e：中心维护的技能目录在交账核对时一并核对（不计越界；出错只记日志，不进失败清单）。
            ['技能目录核对', () => verifyManagedFiles(ctx, bot.id)],
            ['结果路由', () => routeCommit(ctx, commit, wake, goalQuestions)], ['日志追加', () => appendJournal(ctx, updated, commit, wake)],
            ['视图刷新', () => refreshBotFiles(ctx, bot.id)],
        ] as const) {
            try {
                await effect();
            }
            catch (error) {
                failures.push(`${label}失败`);
                ctx.logger.error(`${label}失败，交账 ${commit.id} 已保留`, error);
                // 家目录里出现指向别处的链接，只可能是有人放进去的；同一次交账连带失败几项也只算一次越界。
                if (error instanceof PathContainmentError && !containmentRecorded) {
                    containmentRecorded = true;
                    await recordViolation(ctx, bot.id, error.message);
                }
                ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: now, actor: bot.id, action: 'commit_effect_error', detail: `${commit.id} ${label}：${String(error)}` });
            }
        }
        // P74c：执行链的续排放在结果路由之后；出错只记日志，已保存的交账不受影响。
        try {
            continueJobAfterCommit(ctx, commit, wake);
        }
        catch (error) {
            ctx.logger.error(`执行链续排失败，交账 ${commit.id} 已保留`, error);
        }
        ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
        ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
        const when = updated.nextThinkAt === null ? '有新事件时（保留轻复查）' : formatShort(updated.nextThinkAt, now, ctx.settings.timezone);
        return { ok: true, text: `已交账：${args.outcome}。下次思考：${when}（理由已记录）。${warning ?? ''}${reviewWarning}${archiveWarning}${failures.length ? `注意：${failures.join('、')}，详见中心日志。` : ''}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 未消费的紧急感知仍可形成应醒承诺，不能因一次普通交账把它遗忘。 */
export function refreshExpectedBy(ctx: HubContext, botId: string): void {
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        return;
    const urgent = ctx.store.table('percepts').list(p => p.botId === botId && p.tier === 'urgent' && p.consumedByWake === null && p.discardedAt === undefined && !p.deferredByOwner);
    ctx.store.table('bots').patch(botId, { expectedBy: computeExpectedBy(bot, urgent.length ? Math.min(...urgent.map(p => p.createdAt)) : null, ctx.settings) });
}
