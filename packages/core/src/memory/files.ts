/** 家目录与保护文件只经注入的文件接口维护；结束回合时与中心版本比对，恢复被越界修改的文件。 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot, Commit, WakeTicket } from '../model/index.js';
import { BotSchema } from '../model/bot.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { sha256Hex } from '../util/hash.js';
import { truncateBytes } from '../util/text.js';
import { localDateKey, localParts } from '../util/time.js';
import { checkQuarantine, quarantine } from '../health/quarantine.js';
import { postThread } from '../outreach/thread.js';
import { loadThreadReadState } from '../outreach/read-state.js';
import { writeOutreachAudit, readAuditDetail } from '../outreach/audit.js';
import { renderBotAgentsMd, renderRootAgentsMd, renderMindFiles } from './render.js';
/** 校验并取得机器人档案，让文件操作只针对中心名册中存在的身份。 */
function botById(ctx: HubContext, botId: string): Bot {
    const bot = ctx.store.table('bots').get(parseInput(nonempty, botId, 'botId'));
    if (!bot)
        throw new Error('botId：机器人不存在');
    return bot;
}
const fileLocks = new WeakMap<HubContext, Map<string, Promise<unknown>>>();
/** 同一机器人的中心刷新和终态核验共用串行边界，合法并发刷新不能被误判为篡改。 */
async function withFileLock<T>(ctx: HubContext, botId: string, operation: () => Promise<T>): Promise<T> {
    let locks = fileLocks.get(ctx);
    if (!locks) {
        locks = new Map();
        fileLocks.set(ctx, locks);
    }
    const next = (locks.get(botId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    locks.set(botId, next);
    try {
        return await next;
    }
    finally {
        if (locks.get(botId) === next)
            locks.delete(botId);
    }
}
/** 建立中心共享目录和全体守则，并恢复已读状态以保持重启后的线程一致。 */
export async function initRoot(ctx: HubContext): Promise<void> {
    for (const path of ['', 'bots', 'shared/handoffs', '.hub'])
        await ctx.fs.mkdirp(posix.join(ctx.settings.rootDir, path));
    await ctx.fs.writeTextAtomic(posix.join(ctx.settings.rootDir, 'AGENTS.md'), renderRootAgentsMd(ctx));
    await loadThreadReadState(ctx);
}
/** 为机器人建立记忆、套路和工作目录，保留已有长期记忆并生成受保护视图。 */
export async function createBotHome(ctx: HubContext, input: Bot): Promise<void> {
    const bot = parseInput(BotSchema, input, '机器人家目录');
    for (const path of ['', 'mind', 'memory/journal', 'playbooks', '.agents/skills', 'work'])
        await ctx.fs.mkdirp(posix.join(bot.homeDir, path));
    const memoryPath = posix.join(bot.homeDir, 'memory/MEMORY.md');
    if (await ctx.fs.readText(memoryPath) === null)
        await ctx.fs.writeTextAtomic(memoryPath, '# 长期记忆\n\n只记录已经确认、适合长期保留的事实与经验。\n');
    await refreshBotFiles(ctx, bot.id);
}
/** 每次合法修改都记最新基线，审计不在家目录中，机器人不能通过改文件改掉基线。 */
export async function refreshBotFiles(ctx: HubContext, botId: string): Promise<void> {
    await withFileLock(ctx, botId, () => refreshFiles(ctx, botId));
}
/** 先核验旧保护基线再重建身份与视图，记录新基线以区分合法刷新和越界修改。 */
async function refreshFiles(ctx: HubContext, botId: string): Promise<void> {
    const bot = botById(ctx, botId);
    // 合法刷新前先按上一次中心版本核验，防止刷新顺手覆盖篡改痕迹而漏记越界。
    if (ctx.store.log('audit').recent(1, row => row.actor === bot.id && row.action === 'protected_files').length)
        await verifyFiles(ctx, botId);
    const files = { 'AGENTS.md': renderBotAgentsMd(ctx, bot), ...renderMindFiles(ctx, bot) };
    const hashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { hash: sha256Hex(content) }]));
    const last = ctx.store.log('audit').recent(1, row => row.actor === bot.id && row.action === 'protected_files')[0];
    const previous = last ? readAuditDetail<{ files: Record<string, { hash: string }> }>(last.detail)?.files : null;
    for (const [path, content] of Object.entries(files))
        if (previous?.[path]?.hash !== hashes[path]?.hash)
            await ctx.fs.writeTextAtomic(posix.join(bot.homeDir, path), content);
    // 恢复正文单独覆盖保存一份；审计仅保留文件名与哈希，避免每轮复制全部历史。
    await ctx.fs.writeTextAtomic(posix.join(ctx.settings.rootDir, '.hub', 'protected-files', `${bot.id}.json`), JSON.stringify(files));
    if (JSON.stringify(previous) !== JSON.stringify(hashes))
        writeOutreachAudit(ctx, 'protected_files', { files: hashes }, bot.id);
}
/** 在同一机器人文件锁内核验保护文件，避免并发合法刷新被误判为篡改。 */
export async function verifyProtectedFiles(ctx: HubContext, botId: string): Promise<string[]> {
    return withFileLock(ctx, botId, () => verifyFiles(ctx, botId));
}
/** 对照中心保存的内容哈希恢复被修改的文件，并把同轮异常记为一次越界。 */
async function verifyFiles(ctx: HubContext, botId: string): Promise<string[]> {
    const bot = botById(ctx, botId);
    // 同一毫秒可能连续刷新，追加次序中的最后一份才是最终基线。
    const recorded = ctx.store.log('audit').all().filter(row => row.actor === bot.id && row.action === 'protected_files').at(-1);
    const baseline = recorded ? readAuditDetail<{
        files: Record<string, {
            hash: string;
            content?: string;
        }>;
    }>(recorded.detail)?.files : null;
    const snapshotText = await ctx.fs.readText(posix.join(ctx.settings.rootDir, '.hub', 'protected-files', `${bot.id}.json`));
    const snapshot = snapshotText ? JSON.parse(snapshotText) as Record<string, string> : {};
    const generated = { 'AGENTS.md': renderBotAgentsMd(ctx, bot), ...renderMindFiles(ctx, bot) };
    const changed: string[] = [];
    for (const [path, content] of Object.entries(generated)) {
        const expected = baseline?.[path] ?? { hash: sha256Hex(content), content };
        const actual = await ctx.fs.readText(posix.join(bot.homeDir, path));
        if (actual !== null && sha256Hex(actual) === expected.hash)
            continue;
        changed.push(path);
        const recovery = snapshot[path] ?? expected.content ?? content;
        if (baseline?.[path] && sha256Hex(recovery) !== expected.hash)
            throw new Error(`保护文件 ${path} 的中心快照损坏，无法安全恢复`);
        await ctx.fs.writeTextAtomic(posix.join(bot.homeDir, path), recovery);
    }
    if (changed.length) {
        // 同一轮核对多个文件仍计一次越界，下一轮再次篡改才产生新的一次。
        const current = botById(ctx, botId);
        ctx.store.table('bots').patch(botId, { violations: current.violations + 1, updatedAt: ctx.clock.now() });
        writeOutreachAudit(ctx, 'protected_restored', { paths: changed }, botId);
        postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: `受保护文件发生变化，中心已恢复：${changed.join('、')}。已记一次越界。` });
        const reason = checkQuarantine(ctx, botId, ctx.clock.now());
        if (reason)
            quarantine(ctx, botId, reason);
    }
    return changed;
}
/** 读取长期记忆并按字节预算截断，避免记忆正文挤占唤醒包。 */
export async function readMemorySummary(ctx: HubContext, bot: Bot): Promise<string> {
    return truncateBytes(await ctx.fs.readText(posix.join(bot.homeDir, 'memory/MEMORY.md')) ?? '尚无长期记忆。', ctx.settings.memorySummaryMaxBytes);
}
/** 交账按上海日期追加，幂等键采用 commit.id，恢复重试不会写两段相同日志。 */
export async function appendJournal(ctx: HubContext, bot: Bot, commit: Commit, ticket: WakeTicket): Promise<void> {
    const path = posix.join(bot.homeDir, 'memory/journal', `${localDateKey(commit.createdAt, ctx.settings.timezone)}.md`);
    const marker = `<!-- commit:${commit.id} -->`;
    if ((await ctx.fs.readText(path))?.includes(marker))
        return;
    const p = localParts(commit.createdAt, ctx.settings.timezone);
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    await ctx.fs.appendText(path, `\n${marker}\n## ${time} ${commit.outcome}\n\n理由：${ticket.reason.summary}\n结果：${commit.summary}\n世界变化：${commit.worldChanges.map(row => `${row.what}（${row.whoCanSee}，${row.where}）`).join('；') || '无'}\n证据：${commit.evidence.join('；') || '无'}\n验证：${commit.verification.level}；未覆盖：${commit.verification.notCovered || '无'}\n下次思考：${commit.nextThink.mode}；${commit.nextThink.reason}\n`);
}
