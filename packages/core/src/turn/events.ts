/** 回合事件按会话归属推进；重复终态不再记账，单个宿主或文件异常只记本机器人的错误。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { interruptWake } from './interrupt.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { TurnEventSchema, type TurnEvent } from '../model/host.js';
import type { WakeTicket } from '../model/wake.js';
import { newId } from '../util/ids.js';
import { beginQuotaWindow, restBotsForQuota } from '../quota/window.js';
import { recordUsage } from '../quota/usage.js';
import { onDispatchOrTurnError, retryCarry } from '../scheduler/retry.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue, removeEntry } from '../scheduler/queue.js';
import { checkQuarantine, quarantine } from '../health/quarantine.js';
import { raiseAlert } from '../health/alerts.js';
import { processCommit, refreshExpectedBy } from '../commit/process.js';
import { verifyProtectedFiles, verifyManagedFiles } from '../memory/index.js';
import { postThread } from '../outreach/thread.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { findOpenWake, createOwnerDirectWake } from './session.js';
import { toolActionLabel } from '../util/action-text.js';
import { blockedActivityText } from '../job/blocked-shown.js';
import { recordDshToolAction, sealLedgerForWake } from '../ledger/service.js';
import { settleFinishedTopicWake } from '../project/topics.js';
import { confirmByTextDetail } from '../project/agreement-confirm.js';
import { acceptByText } from '../job/accept.js';
import { flushJobHooks } from '../job/agreement-hooks.js';
import { attachMemoryReply } from '../memory/service.js';
import { ensureNotesShown } from '../memory/note-reply.js';
import { addSkillTurnTokens, onSkillTurnEnd } from '../skill/run.js';
import { postLearnCards } from '../skill/learn-card.js';
import { parseSkillKey } from '../skill/keys.js';
/** 清理的只可能是本次放行前的旧候选，回合进行期间主人新发的消息必须保留。 */
export async function finishTurn(ctx: HubContext, wakeId: string, at: number, status: WakeTicket['status'], errorText?: string,
    /** P74r13：noRetry 为真时只记下原因，不按「出错」退避、也不排自动重试（一件事里的回合被中心结束后转受阻，由总管处理）。 */
    /** P76d：宿主报错对象上的错误代号与状态码（可省略），交给错误分类判断是不是额度用完。 */
    options: { noRetry?: boolean; errorCode?: string; statusCode?: number } = {}): Promise<void> {
    const previous = ctx.store.table('wakes').get(wakeId);
    if (!previous || previous.endedAt !== null)
        return;
    const wake = ctx.store.table('wakes').patch(wakeId, { status, endedAt: at, lastEventAt: Math.max(previous.lastEventAt, at), error: errorText ?? previous.error });
    const usage = recordUsage(ctx, { botId: wake.botId, wakeId, tokens: wake.tokensKnown ? wake.tokens : null, steps: wake.steps, packetBytes: wake.packetBytes });
    // P75g：技能类回合结束时把这一回合的 token 加进所属复盘记录；参与者状态的收尾（没有提交时补排或记 no_update）也在这里。
    try { addSkillTurnTokens(ctx, ctx.store.table('wakes').get(wakeId) ?? wake, usage.tokens); }
    catch (error) { ctx.logger.error('技能类回合记账失败', error); }
    for (const entry of ctx.store.table('queue').list(q => q.botId === wake.botId && q.enqueuedAt <= wake.startedAt
        && (q.topicId ?? null) === (wake.topicId ?? null)
        && q.reason.kind === wake.reason.kind && q.reason.evidence.every(id => wake.reason.evidence.includes(id))))
        removeEntry(ctx, entry.id);
    const failure = errorText && options.noRetry !== true
        ? onDispatchOrTurnError(ctx, wake.botId, errorText, at, { errorCode: options.errorCode, statusCode: options.statusCode })
        : null;
    // P76r2（R4）：报错分类是额度用完时，在唤醒单上记一笔，并把分类结果交给技能记录的收尾：被额度打断不算「没有提交」。
    // 技能记录的收尾放在报错处理之后：补排的技能候选要用到额度的恢复时刻（onQuotaError 写入）。
    const quotaInterrupted = failure?.action === 'quota';
    if (quotaInterrupted) ctx.store.table('wakes').patch(wakeId, { quotaInterrupted: true });
    try { onSkillTurnEnd(ctx, ctx.store.table('wakes').get(wakeId) ?? wake, { quotaInterrupted }); }
    catch (error) { ctx.logger.error('技能类回合收尾失败', error); }
    // P76r2（R2、R3）：技能类回合（复盘、核对、改写、整理、学习）不排通用的重试，也不排额度打断之后的重排：
    // 技能记录自己的补排与兜底（skill/run.ts）负责，否则会多出一个没有技能段、不受任何上限约束的普通回合，学习还会多一条主人一侧的候选。
    const skillWake = parseSkillKey(wake.subjectKey ?? null) !== null;
    try {
        await verifyProtectedFiles(ctx, wake.botId);
    }
    catch (error) {
        ctx.logger.error('回合结束时保护文件核对失败', error);
        raiseAlert(ctx, { code: 'protected_verify', botId: wake.botId, level: 'P1', immediate: true, text: '保护文件核对失败，请检查家目录', at });
    }
    // P75e：回合结束再核对中心维护的技能目录（恢复、搬走杂项）；不计越界，出错只记日志。
    try {
        await verifyManagedFiles(ctx, wake.botId);
    }
    catch (error) {
        ctx.logger.warn('回合结束时中心维护文件核对失败', error);
    }
    // P76r1：把刚结束的唤醒单交给停用判断（用量那一支只在自己发起的回合结束时检查）。
    const isolation = checkQuarantine(ctx, wake.botId, at, wake);
    if (isolation)
        quarantine(ctx, wake.botId, isolation, at);
    const bot = ctx.store.table('bots').get(wake.botId)!;
    if (bot.lifecycle === 'paused' || bot.lifecycle === 'retired') {
        // 收尾不能把主人暂停/退役覆盖成“继续关注”，也不为停止中的机器人排重试。
        ctx.store.table('bots').patch(bot.id, { activity: 'resting',
            activityText: bot.lifecycle === 'paused' ? '已停用（你停用的）' : '已归档', updatedAt: at });
    }
    else if (bot.lifecycle !== 'quarantined' && bot.activity !== 'resting') {
        const commit = wake.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
        const waiting = !wake.ownerDirect && (commit?.ownerQuestion || commit?.outcome === 'needs_owner');
        const blocked = !wake.ownerDirect && commit?.outcome === 'blocked';
        ctx.store.table('bots').patch(bot.id, { activity: waiting ? 'waiting_owner' : blocked ? 'blocked' : 'watching',
            activityText: waiting ? '在等主人回复' : blocked ? blockedActivityText(commit.blocker, wake.jobId) : '继续关注变化',
            lastThinkAt: bot.lastThinkAt === null || !wake.commitId ? at : bot.lastThinkAt, updatedAt: at });
        // P63：主题回合失败不再单独重试，下面按「这一棒跳过」推进讨论，重试只会隔一会儿插错话。
        if (errorText && options.noRetry !== true && bot.retryAt !== null && !wake.topicId && !skillWake)
            enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'retry',
                score: ctx.settings.c02.deadmanRetryScore, evidence: [wake.id], summary: `上轮出错，按退避重试：${errorText}`,
                ownerSummary: '上轮处理出错，稍后重新尝试', notBefore: bot.retryAt, now: at,
                // P74c、P76r1：重试沿用原回合的归属（你发起、总管派出、主题、事情编号）。
                ...retryCarry(wake, bot.role) }));
    }
    // P76d：额度用完的报错不计入连续出错次数、也不按出错退避重试（onDispatchOrTurnError 已不碰 consecutiveErrors 和 retryAt）。
    // 被打断的回合如果属于一件已约定的事（带 jobId），这件事的下一步不能丢：重新排一条候选（理由里不写「按出错退避」，没有退避时刻），
    // 候选一直留在队列里，恢复时刻由探针回合放行、探针成功之后照常放行（放行时仍走同样的闸门）。
    // 不属于一件事的回合（你的消息、员工自己发起的、主题回合）保持原来的做法：不重排。你的消息已经由中心说明过「消息已保留」（见 engine/dispatch.ts），
    // 员工自己发起的工作恢复后会由新的理由重新产生；而「空队列到期只保留许可」这条既有用例明确要求报错之后队列为空。
    // P76r1（4b）：一件事里的、主人发起的（含主人消息叫醒的）、主题里的回合被额度报错打断，都重排一条候选，带原回合的归属。
    // 主人在宿主会话里直聊的回合（ownerDirect）不重排：那边没有消息线程在等回复。员工自己发起的回合不重排。
    // 同一位员工的多条重排候选在队列里按（员工、主题、事情）合并，所以只会留一条。
    // P76r2（R6）：总管替主人派出的活（chiefDispatch）属于主人交代的事，被额度打断同样重排（它的感知在投递时已被消费，不重排就没人再叫醒）。
    // P76r2（R2、R3）：技能类回合除外（见上面 skillWake），由技能记录补排。
    const ownerSideWake = (wake.ownerInitiated && !wake.ownerDirect) || Boolean(wake.topicId) || wake.chiefDispatch === true;
    if (failure?.action === 'quota' && !skillWake && (wake.jobId || ownerSideWake) && ['active', 'probation'].includes(bot.lifecycle)) {
        const redUntil = ctx.store.table('quota').get('quota')?.redUntil ?? at;
        enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'retry', score: ctx.settings.c02.deadmanRetryScore,
            evidence: [wake.id], summary: '额度用完，恢复后继续上一轮的事', ownerSummary: '在等额度恢复后继续', notBefore: redUntil, now: at,
            ...retryCarry(wake, bot.role) }));
    }
    // 出错时仍在 thinking 的机器人直到收尾才可休息；收尾只刷新保护状态，不把普通回合结束算作额度新故障。
    const quota = ctx.store.table('quota').get('quota');
    if (quota?.light === 'red' && !quota.probeInFlight) restBotsForQuota(ctx, quota, at);
    refreshExpectedBy(ctx, wake.botId);
    // 回合终态是唯一同时看到「最终状态 + 交账」的位置；只封存已存在的账本行，
    // 不给主人直聊这种没有投递的回合凭空补账本。
    try { sealLedgerForWake(ctx, wake.id); }
    catch (error) { try { ctx.logger.error('封存唤醒账本失败', error); } catch { /* 账本故障不阻断回合收尾。 */ } }
    // P63：不管这一回合是说了话、没说话还是出错，都在这里决定主题的下一棒交给谁。
    try { settleFinishedTopicWake(ctx, ctx.store.table('wakes').get(wake.id)!); }
    catch (error) { try { ctx.logger.error('主题讨论推进失败', error); } catch { /* 主题故障不阻断回合收尾。 */ } }
    // P75c：这一回合记下的规矩或偏好若还没有回复可挂，补落一句「已记住」（不能让它无处显示）。
    try { ensureNotesShown(ctx, wake); }
    catch (error) { try { ctx.logger.error('补落「已记住」失败', error); } catch { /* 不阻断回合收尾。 */ } }
    // P75i：总管这一回合请主人选会话（teach）建的提问卡若还没有落（没有回复、回复没落成），补落一张（落过的不重复）。
    try { postLearnCards(ctx, wake); }
    catch (error) { try { ctx.logger.error('补落学习选会话的提问卡失败', error); } catch { /* 不阻断回合收尾。 */ } }
    await syncAlertItems(ctx);
    ctx.emit(HUB_EVENT_SCOPES.activity, wake.botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, wake.botId);
}
/** 合成交账沿用正常退避与视图刷新，但不能把它当成机器人完成了交账协议。 */
async function synthesizeNoCommit(ctx: HubContext, wake: WakeTicket, at: number): Promise<void> {
    const bot = ctx.store.table('bots').get(wake.botId)!;
    ctx.store.table('wakes').patch(wake.id, { syntheticCommit: true });
    const result = await processCommit(ctx, { botId: bot.id, sessionId: wake.sessionId!, wakeId: wake.id }, {
        outcome: 'no_change', summary: '未交账', worldChanges: [], evidence: [], verification: { level: 'none', notCovered: '机器人未提交交账' },
        blocker: null, nextThink: { mode: 'auto', reason: '未交账，等待新事件并保留轻复查' }, ownerQuestion: null,
        reply: wake.reason.kind === 'owner_message' ? '本轮未交账，中心尚未收到有效答复。' : null,
        report: null, importance: ctx.settings.c03.syntheticCommitImportance, proposals: [],
    });
    if (!result.ok)
        throw new Error(result.error);
    ctx.store.table('bots').patch(bot.id, { consecutiveNoCommit: bot.consecutiveNoCommit + 1, updatedAt: at });
}
/** 校验并处理宿主回合事件，将步骤、结束、错误和主人直聊转为可追溯的中心状态。 */
export async function onTurnEvent(ctx: HubContext, raw: TurnEvent): Promise<void> {
    try {
        const e = parseInput(TurnEventSchema, raw, '回合事件');
        const bot = ctx.store.table('bots').list(b => b.sessionId === e.sessionId)[0];
        if (!bot)
            return;
        let wake = findOpenWake(ctx, e.sessionId);
        if (e.type === 'owner_direct') {
            beginQuotaWindow(ctx, e.at);
            ctx.runtime.ownerActiveAt = e.at;
            if (!wake)
                wake = createOwnerDirectWake(ctx, bot.id, e.sessionId, e.text, e.at);
            else
                ctx.store.table('wakes').patch(wake.id, { ownerInitiated: true, ownerDirect: true,
                    variant: 'regular', reason: { kind: 'owner_message', score: ctx.settings.c02.ownerSalience, threshold: 0, summary: e.text.trim() || '主人直接交谈', evidence: wake.reason.evidence } });
            ctx.store.table('bots').patch(bot.id, { activity: 'thinking', activityText: '正在回答主人', updatedAt: e.at });
            // P63：主题回合里的直聊也落回主题，否则回复在主题里、主人的话却在私聊里，对不上。
            const directThread = wake.topicId ?? bot.id;
            const directMessage = postThread(ctx, { thread: directThread, from: 'owner', kind: 'chat', text: e.text, refId: wake.id });
            // P72g A6：主人在总管的 DSH 会话窗口里直接打「定了」，和在私聊、主题里打字走同一套识别
            // （整句口令才算，「定了吗」不算）；confirmByText 自己兜底所有异常，不影响回合推进。
            // P74e：规则同私聊：两张以上待确认时不识别，中心落一句说明；固定的是正在做的事的约定时，收尾（重写主题文件、叫醒执行者）
            // 在这里等做完。这一回合本来就是主人在 DSH 会话里直接聊起的，没有「再叫醒总管」这一步可省，
            // 所以返回值只用来等收尾。
            // P75r1：这里不再认领文字撤销：这一回合里总管的会话已经在处理「撤销」这句话（需要时它会调用 hub_memory），
            // 中心再处理一次会变成两边各做一件事。
            confirmByTextDetail(ctx, directThread, directMessage);
            // P74f：同样识别整句验收口令（规则同私聊、主题里打字）；这一回合本来就是主人在会话里直接聊起的，没有「叫醒」要省。
            acceptByText(ctx, directThread, directMessage, 'direct_text');
            await flushJobHooks(ctx);
            ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
            ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
            return;
        }
        if (!wake || e.at < wake.startedAt || e.at < wake.lastEventAt)
            return;
        if (e.type === 'interrupted') {
            interruptWake(ctx, wake.id, e.at);
            return;
        }
        if (e.type === 'started') {
            beginQuotaWindow(ctx, e.at);
            ctx.store.table('wakes').patch(wake.id, { status: wake.commitId ? 'committed' : 'running', dispatchedAt: wake.dispatchedAt ?? e.at, lastEventAt: e.at });
            ctx.store.table('bots').patch(bot.id, { activity: wake.variant === 'reflection' ? 'reflecting' : wake.variant === 'catch_up' ? 'catching_up' : 'thinking', updatedAt: e.at });
        }
        else if (e.type === 'step') {
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: e.at, steps: Math.max(wake.steps, e.steps),
                ...(e.tokens === null ? {} : { tokens: Math.max(wake.tokens, e.tokens), tokensKnown: true }) });
        }
        else if (e.type === 'tool_call') {
            // 过程下钻：把 DSH 工具调用写进本条唤醒的账本。记录失败不能影响回合推进。
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: Math.max(wake.lastEventAt, e.at) });
            try {
                recordDshToolAction(ctx, wake.id, {
                    name: e.name, args: e.args, isError: e.isError, resultText: e.resultText, callId: e.callId,
                });
            }
            catch (error) {
                ctx.logger.error('记录 DSH 工具动作失败', error);
            }
        }
        else if (e.type === 'awaiting_approval') {
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: e.at, awaitingApprovalAt: wake.awaitingApprovalAt ?? e.at });
            raiseAlert(ctx, { code: 'host_approval_wait', botId: bot.id, level: 'P1', immediate: true, at: e.at,
                text: `${toolActionLabel(e.tool)}正在等待宿主权限确认。中心将在 5 分钟后取消回合。\n宿主原文（供核对）：${JSON.stringify({ tool: e.tool, summary: e.summary })}` });
            await syncAlertItems(ctx);
        }
        else if (e.type === 'error')
            await finishTurn(ctx, wake.id, e.at, 'error', e.errorText, { errorCode: e.errorCode, statusCode: e.statusCode });
        else {
            if (e.tokens !== null)
                ctx.store.table('wakes').patch(wake.id, { tokens: Math.max(wake.tokens, e.tokens), tokensKnown: true });
            // 先核对，避免合成交账刷新视图时覆盖篡改证据。
            try {
                await verifyProtectedFiles(ctx, bot.id);
                // P75e：中心维护的技能目录同样在回合结束核对（不计越界，出错只记日志）。
                await verifyManagedFiles(ctx, bot.id);
            }
            catch (error) {
                ctx.logger.error('结束事件的保护文件预检查失败，将继续完成回合记账', error);
            }
            const afterCheck = ctx.store.table('wakes').get(wake.id)!;
            // 文件核对等待期间主人可能已打断；不能再合成未交账或修改该终态。
            if (afterCheck.endedAt !== null) return;
            if (!afterCheck.commitId && !afterCheck.ownerDirect) {
                try {
                    await synthesizeNoCommit(ctx, afterCheck, e.at);
                }
                catch (error) {
                    ctx.logger.error('合成交账失败，仍将结束回合并保留错误', error);
                }
            }
            const latest = ctx.store.table('wakes').get(wake.id)!;
            if (latest.ownerDirect && !latest.commitId && latest.endedAt === null && e.finalText.trim()) {
                const threadId = latest.topicId ?? bot.id;
                const posted = postThread(ctx, { thread: threadId, from: bot.id, kind: 'reply', text: e.finalText, refId: wake.id });
                // P75c：主人直聊没有交账时，会话的最后一段话就是这一回合的回复，「已记住」挂在它下面。
                try { attachMemoryReply(ctx, wake.id, threadId, posted.id); }
                catch (error) { ctx.logger.error('「已记住」挂靠失败', error); }
            }
            await finishTurn(ctx, wake.id, e.at, latest.commitId && !latest.syntheticCommit ? 'committed' : 'no_commit');
            if (wake.ownerDirect)
                ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: e.at, actor: bot.id, action: 'owner_direct_end', detail: wake.id });
        }
        ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
        ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    }
    catch (error) {
        ctx.logger.error('回合事件处理失败，已隔离本次事件', error);
    }
}
