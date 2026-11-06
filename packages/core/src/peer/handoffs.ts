/** 交接单保留文件副本与议程联系；先检查全部来源再复制，避免把家目录外资料带入共享区。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { posix as path } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { HandoffSchema, type Handoff } from '../model/team.js';
import { AgendaItemSchema } from '../model/bot.js';
import { newId } from '../util/ids.js';
import { recordHandoff, recordPeerMessage } from '../perception/sources.js';
import { postThread } from '../outreach/thread.js';
import { refreshBotFiles } from '../memory/index.js';
import { auditTool } from '../tools/common.js';
import { classifyPath } from '../gate/paths.js';
import { gateContextFor, recordViolation } from '../gate/guard.js';
import { resolveRealTarget } from '../gate/real-path.js';
import { enqueuePeerPercept, peerRecipient, peerBot } from './common.js';
export const HandoffInputSchema = z.strictObject({ to: nonempty, task: nonempty, files: z.array(nonempty).optional(), why: nonempty });
/** 按完整目录段检查文件归属，避免名称前缀相似的外部目录混入授权范围。 */
const inside = (file: string, base: string) => file === base || file.startsWith(`${base}/`);
/** 检查交接文件边界并复制到共享目录，同时建立接收方议程和可追溯的交接感知。 */
export async function createHandoff(ctx: HubContext, from: string, input: z.infer<typeof HandoffInputSchema>): Promise<Handoff> {
    const args = parseInput(HandoffInputSchema, input, '交接');
    const recipient = peerRecipient(ctx, from, args.to);
    const sender = peerBot(ctx, from);
    if (ctx.store.table('agenda').count(a => a.botId === args.to && a.status === 'open') >= ctx.settings.maxOpenAgendaPerBot)
        throw new Error('收件人未完成议程已达上限');
    const gate = gateContextFor(ctx, sender);
    const sources: string[] = [];
    for (const source of args.files ?? []) {
        if (!path.isAbsolute(source))
            throw new Error('files：交接文件必须使用绝对路径');
        const full = path.normalize(source);
        const action = classifyPath(full, false, gate);
        if (action.cls === 'protected' || action.subclass === 'work_data') {
            await recordViolation(ctx, sender.id, action.reason);
            throw new Error(`files：${action.reason}`);
        }
        if (!inside(full, path.normalize(sender.homeDir)) && !inside(full, path.join(ctx.settings.rootDir, 'shared')))
            throw new Error(`files：不能复制发起方家目录或 shared 之外的文件：${source}`);
        if (!sender.workDataAllowed && ctx.settings.workDataPaths.some(base => inside(full, path.normalize(base))))
            throw new Error('files：尚未授权读取工作数据目录');
        sources.push(full);
    }
    const realSources: string[] = [];
    for (const source of sources) {
        const real = await ctx.fs.realpath(source);
        const action = classifyPath(real, false, gate);
        if (action.cls === 'protected' || action.subclass === 'work_data') {
            await recordViolation(ctx, sender.id, action.reason);
            throw new Error(`files：${action.reason}`);
        }
        const home = await ctx.fs.realpath(sender.homeDir);
        const shared = await resolveRealTarget(ctx.fs, path.join(ctx.settings.rootDir, 'shared'));
        if (!inside(real.toLowerCase(), home.toLowerCase()) && !inside(real.toLowerCase(), shared.toLowerCase()))
            throw new Error('files：不能复制发起方家目录或 shared 之外的符号链接目标');
        // 工作数据配置也解析真实位置，覆盖 /var 与 /private/var 别名及目录链接。
        if (!sender.workDataAllowed) {
            const workRoots = await Promise.all(ctx.settings.workDataPaths.map(base => resolveRealTarget(ctx.fs, base)));
            if (workRoots.some(base => inside(real.toLowerCase(), base.toLowerCase())))
                throw new Error('files：尚未授权读取工作数据目录');
        }
        realSources.push(real);
        const stat = await ctx.fs.stat(source);
        if (!stat || stat.isDir)
            throw new Error(`files：来源必须是已存在的文件：${source}`);
    }
    const now = ctx.clock.now();
    const id = newId('h', ctx.rng);
    const folder = path.join(ctx.settings.rootDir, 'shared', 'handoffs', id);
    const sharedRoot = path.join(ctx.settings.rootDir, 'shared');
    const realShared = await resolveRealTarget(ctx.fs, sharedRoot);
    const realFolder = await resolveRealTarget(ctx.fs, folder);
    if (!inside(realFolder.toLowerCase(), realShared.toLowerCase()))
        throw new Error('files：交接目标符号链接位于 shared 之外');
    await ctx.fs.mkdirp(folder);
    const files: string[] = [];
    // 给同名附件加序号，确保不同来源不会相互覆盖。
    for (const [index, source] of realSources.entries()) {
        const target = path.join(folder, `${index + 1}-${path.basename(source)}`);
        const realTarget = await resolveRealTarget(ctx.fs, target);
        if (!inside(realTarget.toLowerCase(), realShared.toLowerCase()))
            throw new Error('files：交接目标符号链接位于 shared 之外');
        await ctx.fs.copy(source, realTarget);
        files.push(target);
    }
    // 复制时可能已有其他交接占满名额；落表前再核对，并清理本次尚未发布的副本。
    if (ctx.store.table('agenda').count(a => a.botId === args.to && a.status === 'open') >= ctx.settings.maxOpenAgendaPerBot) {
        await ctx.fs.remove(folder);
        throw new Error('收件人未完成议程已达上限');
    }
    const agenda = AgendaItemSchema.parse({ id: newId('a', ctx.rng), botId: args.to, kind: 'task', title: args.task,
        goalId: null, dueAt: null, onEvent: null, abandonWhen: '发起方撤回或 7 天未处理', priority: ctx.settings.c03.handoffAgendaPriority,
        toOwner: false, source: 'peer', status: 'open', note: args.why, createdAt: now, updatedAt: now });
    const handoff = HandoffSchema.parse({ id, from, to: args.to, task: args.task, files, status: 'offered', agendaId: agenda.id, createdAt: now, updatedAt: now });
    ctx.store.table('handoffs').put(handoff);
    ctx.store.table('agenda').put(agenda);
    postThread(ctx, { thread: 'team', from, kind: 'handoff', text: `交给 ${recipient.name}：${args.task}\n原因：${args.why}\n文件：${files.join('、') || '无'}`, refId: id });
    enqueuePeerPercept(ctx, recordHandoff(ctx, { botId: args.to, id, summary: `${sender.name} 交接：${args.task}；议程 ${agenda.id}；文件 ${files.join('、') || '无'}`, at: now }));
    await refreshBotFiles(ctx, args.to);
    ctx.emit(HUB_EVENT_SCOPES.bot, args.to);
    ctx.emit(HUB_EVENT_SCOPES.activity, from);
    return handoff;
}
/** 只有收件人真实修改议程才算接单，未读感知本身不算承诺。 */
export function acceptHandoffForAgenda(ctx: HubContext, botId: string, agendaId: string): void {
    parseInput(z.strictObject({ botId: nonempty, agendaId: nonempty }), { botId, agendaId }, '接收交接');
    const row = ctx.store.table('handoffs').list(h => h.to === botId && h.agendaId === agendaId && h.status === 'offered')[0];
    if (row) {
        ctx.store.table('handoffs').patch(row.id, { status: 'accepted', updatedAt: ctx.clock.now() });
        ctx.emit(HUB_EVENT_SCOPES.activity, row.from);
    }
}
/** 随接收方议程完成或放弃同步交接状态，并把结果通知原发起方。 */
export function closeHandoffForAgenda(ctx: HubContext, botId: string, agendaId: string, status: 'done' | 'dropped'): void {
    parseInput(z.strictObject({ botId: nonempty, agendaId: nonempty, status: z.enum(['done', 'dropped']) }), { botId, agendaId, status }, '关闭交接');
    const row = ctx.store.table('handoffs').list(h => h.to === botId && h.agendaId === agendaId && ['offered', 'accepted'].includes(h.status))[0];
    if (!row)
        return;
    const now = ctx.clock.now();
    const recipient = peerBot(ctx, botId);
    ctx.store.table('handoffs').patch(row.id, { status: status === 'done' ? 'done' : 'declined', updatedAt: now });
    const summary = `${recipient.name} ${status === 'done' ? '完成了' : '拒绝了'}交接：${row.task}`;
    postThread(ctx, { thread: 'team', from: botId, kind: 'handoff', text: summary, refId: row.id });
    enqueuePeerPercept(ctx, recordPeerMessage(ctx, { botId: row.from, id: `${row.id}:${status}`, summary, at: now }));
    ctx.emit(HUB_EVENT_SCOPES.bot, row.from);
    ctx.emit(HUB_EVENT_SCOPES.activity, row.from);
}
/** C02 直接读取 offered 的创建时间计算等人内驱；这里只追加一次标记并处理七天失效。 */
export async function expireHandoffs(ctx: HubContext, now: number): Promise<void> {
    parseInput(z.number().int(), now, '当前时间');
    for (const row of ctx.store.table('handoffs').list(h => ['offered', 'accepted'].includes(h.status))) {
        if (now - row.createdAt >= ctx.settings.c03.handoffExpiryMs) {
            ctx.store.table('handoffs').patch(row.id, { status: 'expired', updatedAt: now });
            ctx.emit(HUB_EVENT_SCOPES.activity, row.from);
            if (row.agendaId && ctx.store.table('agenda').get(row.agendaId)?.status === 'open') {
                ctx.store.table('agenda').patch(row.agendaId, { status: 'dropped', note: '交接超过 7 天未处理，已过期', updatedAt: now });
                await refreshBotFiles(ctx, row.to);
                ctx.emit(HUB_EVENT_SCOPES.bot, row.to);
            }
            enqueuePeerPercept(ctx, recordPeerMessage(ctx, { botId: row.from, id: `${row.id}:expired`, summary: `交接「${row.task}」已过期`, at: now }));
        }
        else if (row.status === 'offered' && now - row.createdAt >= ctx.settings.handoffWaitingMs) {
            if (!ctx.store.log('audit').all().some(a => a.action === 'handoff_waiting' && a.detail === row.id))
                auditTool(ctx, row.from, 'handoff_waiting', row.id);
        }
    }
}
