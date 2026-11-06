/** 工具守卫是机器人会话的统一入口：普通会话不受影响，机器人越界仅隔离自己，宿主钩子永不抛异常。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { Bot, GuardDecision } from '../model/index.js';
import { parseInput } from '../engine/validation.js';
import { classifyToolCall } from './classify.js';
import { mostDangerous, type Classification, type GateContext } from './paths.js';
import { checkGitBoundaries } from './git-boundary.js';
import { decide } from './matrix.js';
import { prepareApproval, consumeTicket } from './approvals.js';
import { quarantine } from '../health/quarantine.js';
import { raiseAlert } from '../health/alerts.js';
import { findOpenWake } from '../turn/session.js';
import { toolActionLabel } from '../util/action-text.js';
import { syncAlertItems } from '../outreach/alerts.js';
/** 会话归属只从中心名册读取，不接受工具参数自报 botId。 */
export function gateContextFor(ctx: HubContext, bot: Bot): GateContext {
    return { homeDir: bot.homeDir, ownerHome: ctx.ownerHome, maxCommandDepth: ctx.settings.c03.maxCommandDepth, sharedDir: `${ctx.settings.rootDir}/shared`, rootDir: ctx.settings.rootDir,
        workDataAllowed: bot.workDataAllowed, workDataPaths: ctx.settings.workDataPaths, autonomy: bot.autonomy,
        reflection: ctx.store.table('wakes').list(w => w.botId === bot.id && w.sessionId === bot.sessionId
            && w.endedAt === null && ['running', 'delivering', 'committed'].includes(w.status) && w.variant === 'reflection').length > 0 };
}
/** 为机器人累加越界次数并在达到门槛时隔离，同时同步主人可见的告警。 */
export async function recordViolation(ctx: HubContext, botId: string, reason: string): Promise<void> {
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        return;
    const updated = ctx.store.table('bots').patch(botId, { violations: bot.violations + 1, updatedAt: ctx.clock.now() });
    if (updated.violations >= ctx.settings.violationQuarantineCount && updated.lifecycle !== 'quarantined')
        quarantine(ctx, botId, reason);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    await syncAlertItems(ctx);
}
/** 主人打断会解绑当前会话，但旧唤醒单仍保留身份，宿主取消失败时也不能变成普通会话放行。 */
function wasOwnerInterrupted(ctx: HubContext, sessionId: string): boolean {
    return ctx.store.table('wakes').count(wake => wake.sessionId === sessionId && wake.canceledBy === 'owner') > 0;
}
/** 按会话归属、权限矩阵和批准票决定执行；检查异常时拒绝本次调用并返回可读原因。 */
export function guardToolCallSync(ctx: HubContext, sessionId: string, tool: string, args: unknown, defer: (effect: Promise<unknown>) => void, verifiedAction?: Classification): GuardDecision {
    try {
        parseInput(z.strictObject({ sessionId: z.string().min(1), tool: z.string().min(1) }), { sessionId, tool }, '工具守卫');
        // 先识别打断过的身份：拒绝是落实主人的停止意图，不算越界，也不新建审批。
        if (wasOwnerInterrupted(ctx, sessionId)) return { allow: false, message: '主人已打断本回合，无需再执行工具，请停止处理' };
        const bot = ctx.store.table('bots').list(b => b.sessionId === sessionId)[0];
        if (!bot)
            return { allow: true };
        if (!['active', 'probation'].includes(bot.lifecycle)) {
            // 主人暂停或退役不取消宿主回合，已在途的回合仍必须能交账收尾。
            if (tool === 'hub_state_get') return { allow: true };
            if (['paused', 'retired'].includes(bot.lifecycle) && ['hub_commit', 'hub_reflect_commit'].includes(tool)
                && findOpenWake(ctx, sessionId)) return { allow: true };
            return { allow: false, message: '机器人当前未在岗，不能执行工具' };
        }
        const gctx = gateContextFor(ctx, bot);
        const parsedAction = verifiedAction ?? classifyToolCall(tool, args, gctx);
        // 同步宿主钩子不能读磁盘；未做异步核验的仓库写入保守要求审批。
        const action = !verifiedAction && parsedAction.gitRepos?.length
            ? mostDangerous([parsedAction, { cls: 'C', reason: '同步调用尚未核验 .git 的实际位置，需要审批', subclass: 'git_write' }]) : parsedAction;
        const completed = ctx.store.table('wakes').list(w => w.botId === bot.id && w.sessionId === sessionId && w.endedAt === null && w.status === 'committed');
        if (completed.length && !tool.startsWith('hub_') && action.readOnly !== true)
            return { allow: false, message: '本轮已交账，不能继续执行修改或对外动作' };
        if (action.cls === 'protected') {
            defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: action.reason };
        }
        // 复盘的只读边界不能用旧批准票绕过；中心工具在自己的入口按细项验证。
        if (gctx.reflection && !tool.startsWith('hub_') && action.cls !== 'A')
            return { allow: false, message: '复盘回合只读，不能执行需要审批的动作' };
        if (action.subclass === 'work_data') {
            defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: action.reason };
        }
        const decision = decide(action, bot.autonomy, bot.lifecycle, ctx.settings.l3Grants);
        if (decision === 'deny') {
            if (action.cls === 'D')
                defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: `当前自主等级不能执行：${action.reason}` };
        }
        if (decision === 'allow')
            return { allow: true };
        if (consumeTicket(ctx, bot.id, tool, args))
            return { allow: true };
        if (action.cls === 'D')
            defer(recordViolation(ctx, bot.id, action.reason));
        const prepared = prepareApproval(ctx, bot.id, tool, args, action.cls === 'D' ? 'D' : 'C', action.reason);
        defer(prepared.notify());
        const approval = prepared.approval;
        return { allow: false, message: `这个动作需要主人批准，已提交审批单 ${approval.id}。先做不依赖它的事；主人批准后中心会唤醒你，用完全相同的参数再调用一次。` };
    }
    catch (error) {
        ctx.logger.warn('动作守卫拒绝了无法安全检查的调用', String(error));
        return { allow: false, message: `动作检查失败，未执行：${error instanceof Error ? error.message : String(error)}` };
    }
}
/** 宿主权限由宿主负责；机器人请求仅拒绝并告警，不开无法跨越宿主沙箱的中心批准票。 */
export function onHostApprovalRequestSync(ctx: HubContext, sessionId: string, tool: string, summary: string, defer: (effect: Promise<unknown>) => void): 'deny' | 'pass' {
    // 迟到审批不能让主人刚取消的会话继续，也不能再打扰主人或累计机器人故障。
    if (wasOwnerInterrupted(ctx, sessionId)) return 'deny';
    const bot = ctx.store.table('bots').list(b => b.sessionId === sessionId)[0];
    if (!bot)
        return 'pass';
    try {
        parseInput(z.strictObject({ sessionId: z.string().min(1), tool: z.string().min(1), summary: z.string() }), { sessionId, tool, summary }, '宿主审批请求');
        // 中心动作批准无法代替 DSH 的权限授权；建单会让双重闸门互相消耗批准票并无限重试。
        raiseAlert(ctx, { code: 'host_approval_blocked', botId: bot.id, level: 'P1', immediate: true,
            text: `宿主权限拦截了${toolActionLabel(tool)}，本次动作未执行。请检查 DSH 会话权限；确认权限允许后再发消息让队友继续。中心未创建审批单，避免无效批准和反复重试。\n宿主原文（供核对）：${JSON.stringify({ tool, summary })}` });
        defer(syncAlertItems(ctx));
    }
    catch (error) {
        ctx.logger.warn('宿主权限告警失败，仍拒绝宿主弹框', String(error));
    }
    return 'deny';
}

/** 兼容模块级异步调用：放行结论与票据先同步决定，再等待通知副作用。 */
export async function guardToolCall(ctx: HubContext, sessionId: string, tool: string, args: unknown): Promise<GuardDecision> {
    const effects: Promise<unknown>[] = [];
    let verified: Classification | undefined;
    const bot = ctx.store.table('bots').list(b => b.sessionId === sessionId)[0];
    if (bot) {
        try { const context = gateContextFor(ctx, bot); verified = await checkGitBoundaries(ctx.fs, classifyToolCall(tool, args, context), context); }
        catch (error) { return { allow: false, message: `动作检查失败，未执行：${error instanceof Error ? error.message : String(error)}` }; }
    }
    const decision = guardToolCallSync(ctx, sessionId, tool, args, effect => { effects.push(effect); }, verified);
    await Promise.all(effects);
    return decision;
}

/** 兼容原有异步审批钩子，和 Hub 同步钩子共享审批单与异常处理。 */
export async function onHostApprovalRequest(ctx: HubContext, sessionId: string, tool: string, summary: string): Promise<'deny' | 'pass'> {
    const effects: Promise<unknown>[] = [];
    const decision = onHostApprovalRequestSync(ctx, sessionId, tool, summary, effect => { effects.push(effect); });
    await Promise.all(effects);
    return decision;
}
