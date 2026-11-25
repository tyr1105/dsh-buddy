/** 工具守卫是机器人会话的统一入口：普通会话不受影响，机器人越界仅隔离自己，宿主钩子永不抛异常。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { Bot, GuardDecision } from '../model/index.js';
import { parseInput } from '../engine/validation.js';
import { posix } from 'node:path';
import { classifyToolCall, TOOL_SHAPES } from './classify.js';
import { classifyPath, isProtected, isQuietRefusal, mostDangerous, resolveGatePath, type Classification, type GateContext } from './paths.js';
import { lexShell, type ShellJoin } from './shell-lexer.js';
import { unwrap } from './wrappers.js';
import { commandArguments } from './tool-targets.js';
import { C03_DEFAULTS } from '../config/defaults.js';
import { nativeGateContext, type ToolCallHostReport } from './gate-context.js';
import { isSandboxBlocked, sandboxGuidance } from './sandbox-rules.js';
import { checkGitBoundaries } from './git-boundary.js';
import { decide } from './matrix.js';
import { chiefDeliverableMap, chiefDeliverableRefusal } from './chief-deliverable.js';
import { prepareApproval, consumeTicket, approvalAsksOf } from './approvals.js';
import { quarantine } from '../health/quarantine.js';
import { raiseAlert } from '../health/alerts.js';
import { findOpenWake } from '../turn/session.js';
import { markSkillUsed } from '../skill/store.js';
import { toolActionLabel } from '../util/action-text.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { launchEndedRefusal, LAUNCH_ENDED_TOOL_REFUSAL_TEXT } from '../job/launch-cancel.js';
// 分类上下文的计算搬到了 gate-context.ts（审批单也要用它，放在这里会绕成圈）；这里原样转出，别处的引用路径不变。
export { gateContextFor, nativeGateContext, memberProjectDirs, type ToolCallHostReport } from './gate-context.js';
/**
 * P75r3：建符号链接（ln）不在命令分类器的识别名单里，分类器看不出链接建在哪里。
 * 这里单独把 ln 命令找出来，只检查「链接所在的位置」是不是技能库的三处（含 .agents、.agents/skills、playbooks 这三个精确路径）：
 * 是就判为 skill_dir_readonly（拒绝，不计越界）；P75r4 起，链接所在的位置若是中心管理的文件（员工的 AGENTS.md、mind/、memory/journal/ 等），
 * 按受保护的写入处理（拒绝并计越界）；其余情况返回 null，不改变原有分类。
 * 能识别的写法：ln -s、合写的 -st 目录、--target-directory 目录（空格或等号）、命令前的变量赋值、busybox ln、command ln；
 * P75r5a：cd 之后的目录按连接符区分（cd 失败时后面的命令其实在原目录执行）：
 * `cd X && ln …` 只在 X；`cd X || ln …` 只在原目录；`;`、换行、`&` 之后原目录和 X 都可能；cd 的参数认不出（-、含 $ 或反引号、~ 以外的展开）时也都可能。
 * 每条 ln 因此带着「它执行时可能所在的全部目录」，由 classifyLinkCreation 逐个目录判断。
 * 链接指向哪里不查：ln -s .agents/skills s 只是在别处建一个指进来的链接，经它的写入最终落在三处里面，由回合结束和投递前的核对恢复。
 * 只认直接写出的 ln 和 sh -c、env 这类能展开的包装；更隐蔽的写法由核对兜底。
 */
interface LinkCommand { words: string[]; dirs: GateContext[] }
/** 看不出命令在哪个目录执行、链接可能建在中心管理的位置上时，给员工看的拒绝文字。 */
const AMBIGUOUS_LINK_REASON = '看不出这条命令执行时在哪个目录，链接可能建在中心管理的位置上。把 cd 和 ln 用 && 连起来，或者写绝对路径。';
/** 按工作目录去重合并：同一个目录只留一份。 */
function mergeDirs(...lists: GateContext[][]): GateContext[] {
    const seen = new Map<string, GateContext>();
    for (const list of lists) for (const item of list) if (!seen.has(item.cwd ?? '')) seen.set(item.cwd ?? '', item);
    return [...seen.values()];
}
/**
 * cd 的参数能不能静态认出目录：不是以 - 开头（- 本身、-- 、-P、-L 这类选项）、不含 $ 或反引号（含命令替换留下的占位）、不是 ~ 以外的展开。
 * P75r5b（审查 8.2）：以 - 开头的一律按「认不出」处理（cd -- .agents、cd -P x、cd -L x 带选项时，选项后面才是目录，这里不去解析选项）；
 * 调用处另外保证 cd 后面不是恰好一个参数时也按「认不出」处理。
 */
function cdTargetKnown(arg: string): boolean {
    if (arg.startsWith('-') || /[$`]|__dynamic__/.test(arg)) return false;
    return !(arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/'));
}
function linkCommandsOf(command: string, starts: GateContext[], depth = 0, out: LinkCommand[] = []): LinkCommand[] {
    if (depth > 3) return out;
    const maxDepth = starts[0]?.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth;
    const parsed = lexShell(command, depth, maxDepth, starts[0]?.sandboxed === true ? { sandbox: true } : undefined);
    const visit = (rawWords: string[], dirs: GateContext[], level: number): void => {
        // P75r4 第 4 节：命令前面的变量赋值（FOO=1 ln …）不是程序名，先跳过。
        let start = 0;
        while (start < rawWords.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawWords[start]!)) start += 1;
        let words = rawWords.slice(start);
        if (level > 3 || words.length === 0) return;
        let program = posix.basename(words[0]!).toLowerCase();
        // busybox 的第一个词是它要运行的小程序名：busybox ln … 等同于 ln …。
        if (program === 'busybox' && words.length > 1) { words = words.slice(1); program = posix.basename(words[0]!).toLowerCase(); }
        if (program === 'ln') { out.push({ words, dirs }); return; }
        // 包装（sh -c、env 等）在每个可能的目录下各展开一次；展开结果相同的合并，保持「这一条命令在哪些目录下」的完整性。
        const groups = new Map<string, { script?: string; words?: string[]; dirs: GateContext[] }>();
        for (const dir of dirs) {
            const inner = unwrap(program, words.slice(1), dir);
            if (inner?.script === undefined && !inner?.words) continue;
            const key = JSON.stringify([inner.script ?? null, inner.words ?? null]);
            const target = inner.cwd ? { ...dir, cwd: inner.cwd } : dir;
            const group = groups.get(key) ?? { ...(inner.script !== undefined ? { script: inner.script } : { words: inner.words }), dirs: [] };
            group.dirs = mergeDirs(group.dirs, [target]);
            groups.set(key, group);
        }
        for (const group of groups.values()) {
            if (group.script !== undefined) linkCommandsOf(group.script, group.dirs, depth + level + 1, out);
            else if (group.words) visit(group.words, group.dirs, level + 1);
        }
    };
    // 跟踪「这一段执行时可能在哪些目录」：
    // possible 是执行到这里时可能所在的全部目录；refined 是紧跟在一个 cd 之后、由同一种连接符（&& 或 ||）一路连下来的这一串里能确定的目录。
    let possible = mergeDirs(starts);
    let refined: { dirs: GateContext[]; join: ShellJoin } | null = null;
    let pendingCd: { ok: GateContext[]; fail: GateContext[] } | null = null;
    for (const part of parsed.parts) {
        // 上一段是 cd：这一段用 && 连着，就只在 cd 成功之后的目录；用 || 连着，只在 cd 失败之后（还是原目录）；其余不确定。
        if (pendingCd !== null) {
            refined = part.joinedBy === '&&' ? { dirs: pendingCd.ok, join: '&&' } : part.joinedBy === '||' ? { dirs: pendingCd.fail, join: '||' } : null;
            pendingCd = null;
        }
        let dirs: GateContext[];
        if (refined !== null && part.joinedBy === refined.join) dirs = refined.dirs;
        else { refined = null; dirs = possible; }
        visit(part.words, dirs, 0);
        if (part.words[0] === 'cd') {
            // P75r5b（审查 8.2）：cd 后面不是恰好一个参数（没有参数、带选项再带目录、多个参数）时目标认不出，按「认不出」处理。
            const arg = part.words.length === 2 ? part.words[1]! : null;
            // 成功之后的目录：参数认得出就是各目录分别解析的结果；认不出就退回「全部可能的目录」（偏保守）。
            // 认不出又带着看起来是目录的词（cd -- .agents、cd -P x）时，把这些词当成可能的去处也算进去：
            // 目标确实可能就是它，只是不敢断定，于是 cd 之后的 ln 要在「原目录」和「这个目录」两处都判断，只在一处命中就拒绝。
            const guesses = arg !== null ? [] : part.words.slice(1).filter(word => cdTargetKnown(word));
            const ok = arg !== null && cdTargetKnown(arg) ? mergeDirs(dirs.map(dir => ({ ...dir, cwd: resolveGatePath(arg, dir) })))
                : mergeDirs(possible, dirs, ...guesses.map(word => dirs.map(dir => ({ ...dir, cwd: resolveGatePath(word, dir) }))));
            possible = mergeDirs(possible, ok);
            pendingCd = { ok, fail: dirs };
        }
    }
    return out;
}
/** 一条 ln 命令会在哪些位置建链接（拿不准最后一个词是不是目录时两种都算）。 */
function linkLocationsOf(words: string[]): string[] {
    const operands: string[] = [];
    let targetDir: string | null = null;
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index]!;
        if (word === '--') { operands.push(...words.slice(index + 1)); break; }
        // 长选项：--target-directory 目录（空格分隔）、--target-directory=目录；--suffix 带值，值不是操作数。
        if (word === '--target-directory') { targetDir = words[index + 1] ?? null; index += 1; continue; }
        if (word.startsWith('--target-directory=')) { targetDir = word.slice('--target-directory='.length); continue; }
        if (word === '--suffix') { index += 1; continue; }
        if (word.startsWith('--')) continue;
        // 短选项（可能几个合写，如 -st、-sft、-tDIR）：逐个字母看，t 的值是同一个词里 t 后面的部分，没有就取下一个词；S 的值同理，只是跳过。
        if (word.startsWith('-') && word !== '-') {
            const letters = [...word.slice(1)];
            for (let at = 0; at < letters.length; at += 1) {
                if (letters[at] !== 't' && letters[at] !== 'S') continue;
                const attached = letters.slice(at + 1).join('');
                const value = attached !== '' ? attached : (words[index + 1] ?? null);
                if (attached === '') index += 1;
                if (letters[at] === 't') targetDir = value;
                break;
            }
            continue;
        }
        operands.push(word);
    }
    const base = (path: string): string => posix.basename(path.replace(/\/+$/, '')) || path;
    if (targetDir !== null) return operands.map(source => posix.join(targetDir!, base(source)));
    if (operands.length === 0) return [];
    if (operands.length === 1) return [base(operands[0]!)];
    const last = operands[operands.length - 1]!;
    return operands.length === 2 ? [last, posix.join(last, base(operands[0]!))] : operands.slice(0, -1).map(source => posix.join(last, base(source)));
}
/** 把工具调用里的 ln 命令检查一遍，命中技能库三处返回只读判定，否则返回 null。 */
function classifyLinkCreation(tool: string, args: unknown, gctx: GateContext): Classification | null {
    if (tool.startsWith('hub_') || args === null || typeof args !== 'object' || Array.isArray(args)) return null;
    const input = args as Record<string, unknown>;
    const shape = TOOL_SHAPES.find(item => item.names.includes(tool));
    if (shape?.kind !== 'exec') return null;
    const command = shape.command?.(input);
    if (!command) return null;
    const argv = commandArguments(input);
    const cwd = typeof (input.cwd ?? input.workdir) === 'string' ? String(input.cwd ?? input.workdir) : gctx.cwd;
    const base: GateContext = { ...gctx, cwd };
    const found: LinkCommand[] = argv ? [{ words: [command, ...argv], dirs: [base] }].filter(item => posix.basename(item.words[0]!).toLowerCase() === 'ln') : linkCommandsOf(command, [base]);
    // 链接所在的位置：技能库三处按「只读、不计越界」处理（原有）；P75r4 起中心管理的文件（员工的 AGENTS.md、mind/、memory/journal/ 等，
    // 以现有的 isProtected 为准）按受保护的写入处理：拒绝并计越界。其余情况不改变原有分类。
    // P75r5a：每条 ln 在它的每个可能目录下各判一次：
    // - 每个目录下都命中：都是受保护就拒绝并计越界；其余（都是技能库只读，或两种混着）按技能库只读处理，拒绝、不计越界；
    // - 只在一部分目录下命中：看不出命令在哪个目录执行，拒绝、不计越界（计越界三次员工会被停用，只留给看得清的情形），文字告诉员工怎样写；
    // - 都不命中：不改变原有分类。
    const verdicts: Classification[] = [];
    for (const item of found) {
        const locations = linkLocationsOf(item.words);
        const perDir = item.dirs.map(dir => locations
            .map(location => ({ item: classifyPath(location, true, dir), path: resolveGatePath(location, dir) }))
            .filter(({ item: hit, path }) => hit.cls === 'protected' && (isQuietRefusal(hit.subclass) || isProtected(path, dir)))
            .map(({ item: hit }) => hit));
        const hitDirs = perDir.filter(hits => hits.length > 0);
        if (hitDirs.length === 0) continue;
        if (hitDirs.length < perDir.length) { verdicts.push({ cls: 'protected', subclass: 'skill_dir_readonly', reason: AMBIGUOUS_LINK_REASON }); continue; }
        const worst = hitDirs.map(hits => mostDangerous(hits));
        const counts = (hit: Classification): boolean => !isQuietRefusal(hit.subclass);
        verdicts.push(worst.every(counts) ? mostDangerous(worst) : worst.find(hit => !counts(hit))!);
    }
    return verdicts.length > 0 ? mostDangerous(verdicts) : null;
}
/** 为机器人累加越界次数并在达到门槛时隔离，同时同步主人可见的告警。 */
export async function recordViolation(ctx: HubContext, botId: string, reason: string): Promise<void> {
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        return;
    const updated = ctx.store.table('bots').patch(botId, { violations: bot.violations + 1, updatedAt: ctx.clock.now() });
    // P74r16a：停用原因写清累计次数和最近一次的理由（主人看到的告警正文就是它），不再只剩最后一次的那句理由。
    if (updated.violations >= ctx.settings.violationQuarantineCount && updated.lifecycle !== 'quarantined')
        quarantine(ctx, botId, `越界的动作累计 ${updated.violations} 次（最近一次：${reason}）`);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    await syncAlertItems(ctx);
}
/** 主人打断会解绑当前会话，但旧唤醒单仍保留身份，宿主取消失败时也不能变成普通会话放行。 */
function wasOwnerInterrupted(ctx: HubContext, sessionId: string): boolean {
    return ctx.store.table('wakes').count(wake => wake.sessionId === sessionId && wake.canceledBy === 'owner') > 0;
}
/**
 * 按会话归属、权限矩阵和批准票决定执行；检查异常时拒绝本次调用并返回可读原因。
 * P69：最后一个参数 host 是宿主在这次工具调用时报进来的沙箱情况（现查现报，不缓存）；
 * 不传、或传了没有明确确认沙箱，行为和原来完全一样。
 */
export function guardToolCallSync(ctx: HubContext, sessionId: string, tool: string, args: unknown, defer: (effect: Promise<unknown>) => void, verifiedAction?: Classification, host?: ToolCallHostReport): GuardDecision {
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
            // P75f：旧复盘交账工具已下线；在途回合只用 hub_commit 交账收尾。
            if (['paused', 'retired'].includes(bot.lifecycle) && tool === 'hub_commit'
                && findOpenWake(ctx, sessionId)) return { allow: true };
            return { allow: false, message: '机器人当前未在岗，不能执行工具' };
        }
        // DSH 每执行一条命令都会重新解析工作目录的真实位置。家目录一旦被换成指向别处的符号链接，
        // 下一条命令的沙箱可写范围就跟着变成别处，所以必须在工具真正执行前拦下。
        // hub_ 工具不经过 DSH 沙箱，放行让回合能交账收尾；它们的写入有文件层边界兜底。
        if (!tool.startsWith('hub_') && ctx.fs.isSymlinkSync(bot.homeDir)) {
            const message = '家目录被替换成了符号链接，已拒绝本次工具调用';
            defer(recordViolation(ctx, bot.id, message));
            return { allow: false, message };
        }
        // P75e 第 9 节：员工调用 DSH 的 skill 工具时，技能名（参数 name）是这位员工在用的自己积累技能时记「最近用到」。
        // 只写一个时间字段，不改变守卫的决定；出错吞掉只记日志（markSkillUsed 内部兜底）。
        if (tool === 'skill') {
            const skillName = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as { name?: unknown }).name : undefined;
            if (typeof skillName === 'string') markSkillUsed(ctx, bot.id, skillName, ctx.clock.now());
        }
        // 队友自己的工具用这份上下文：沙箱确认开着才带项目目录和临时目录，否则完全是旧规则。
        const gctx = nativeGateContext(ctx, bot, host);
        const baseAction = verifiedAction ?? classifyToolCall(tool, args, gctx);
        // P75r3：命令里的 ln 要在技能库三处建链接时，判为只读（分类器认不出 ln）；没有命中不改变原分类。
        const linkAction = classifyLinkCreation(tool, args, gctx);
        const parsedAction = linkAction ? mostDangerous([baseAction, linkAction]) : baseAction;
        // 同步宿主钩子不能读磁盘；未做异步核验的仓库写入保守要求审批。
        // 结果本来就是 C、D 时，加这一条前后等价，却会给「待确认事项」多塞一条，所以只在 A、B 时合并。
        const action = !verifiedAction && parsedAction.gitRepos?.length && (parsedAction.cls === 'A' || parsedAction.cls === 'B')
            ? mostDangerous([parsedAction, { cls: 'C', reason: '同步调用尚未核验 .git 的实际位置，需要审批', subclass: 'git_write' }]) : parsedAction;
        const completed = ctx.store.table('wakes').list(w => w.botId === bot.id && w.sessionId === sessionId && w.endedAt === null && w.status === 'committed');
        if (completed.length && !tool.startsWith('hub_') && action.readOnly !== true)
            return { allow: false, message: '本轮已交账，不能继续执行修改或对外动作' };
        if (action.cls === 'protected') {
            // P75e：中心维护的技能库三处写入被拒但不计越界——这三处以前允许写，旧会话里的员工照旧写不是有意越界，
            // 计越界会让员工被停用（方案 16 节第 10 项的裁定）；回合结束有核对恢复兜底。
            if (isQuietRefusal(action.subclass)) return { allow: false, message: action.reason };
            defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: action.reason };
        }
        // 复盘的只读边界不能用旧批准票绕过；中心工具在自己的入口按细项验证。
        // P75r6 第 1 节（复验 N1）：技能类回合（复盘、核对、改写、学习、整理，统一由 gctx.reflection 表示）里，员工自己的工具只放行「只读」的动作：
        // 读文件、只读命令放行；写、改、删文件（家目录、共享目录、项目文件夹里的也一样）、web_fetch、web_search（读到的文字里
        // 一段注入的话可以让员工把内容拼进网址发出去）以及其他不是只读的动作一律拒绝，不计越界。文字沿用原来的只读拒绝文字。
        // 例外：DSH 的 skill、job_list、job_output 三个只读工具作用在本会话内部，分类里保守地标成「非只读」（交账后不能改清单），
        // 但它们本身只是读，技能类回合照常放行。
        if (gctx.reflection && !tool.startsWith('hub_')) {
            const shape = TOOL_SHAPES.find(item => item.names.includes(tool));
            const web = shape?.kind === 'web_search' || shape?.kind === 'web_fetch';
            const sessionRead = shape?.kind === 'read' && action.subclass === 'session_internal';
            if (web || (action.readOnly !== true && !sessionRead)) return { allow: false, message: '复盘回合只读，不能执行需要审批的动作' };
        }
        if (action.subclass === 'work_data') {
            defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: action.reason };
        }
        // P76q 第 1 条：总管自己写一件已派出去的活的交付物时拦下，告诉它交给执行者改。
        // P82：约定还不存在时也不能自己往中心数据目录之外写（见 chief-deliverable.ts）。
        // 放在审批之前：不能先建一张写文件的审批，再让主人面对「总管要自己做」的选择。
        // 不计越界（这是分工问题，不是安全问题）；hub_ 工具与写给主人看的说明不受影响。
        if (bot.role === 'chief' && !tool.startsWith('hub_')) {
            const refusal = chiefDeliverableRefusal(action.writePaths ?? [], chiefDeliverableMap(ctx, bot.id));
            if (refusal !== null) return { allow: false, message: refusal };
        }
        const decision = decide(action, bot.autonomy, bot.lifecycle, ctx.settings.l3Grants);
        if (decision === 'deny') {
            // P74r16c：最低自主等级的员工，沙箱开着、而且这次属于「沙箱本来就会拦的写入」时，同样不计越界（与下面指路那一支一致）；
            // 拒绝文字不变。没有确认沙箱、或不是沙箱会拦的 D 类，仍然计越界。
            if (action.cls === 'D' && (tool.startsWith('hub_') || !isSandboxBlocked(action, gctx)))
                defer(recordViolation(ctx, bot.id, action.reason));
            return { allow: false, message: `当前自主等级不能执行：${action.reason}` };
        }
        // 指路（P69 A5）：沙箱本来就会拦的写入，批了也白批。拒绝这次调用，告诉队友该用哪个中心工具；
        // 不建审批单、不消费批准票。P74r16a 起，这一类拒绝一律不计越界（C、D 都不计）：这些写入 DSH 的沙箱本来就会拦，
        // 中心再记越界并停用，是在 DSH 的规则之外另加惩罚。越界计数只留给凭据类文件、中心管理的文件、工作数据目录，
        // 以及没有确认沙箱时的 D 类（那几条都在上面或下面，不经过这里）。同一条命令里混了别的对外动作时 blocked 不成立，走下面的审批。
        if (!tool.startsWith('hub_') && isSandboxBlocked(action, gctx)) {
            return { allow: false, message: sandboxGuidance(action, gctx) };
        }
        if (decision === 'allow')
            return { allow: true };
        if (consumeTicket(ctx, bot.id, tool, args))
            return { allow: true };
        if (action.cls === 'D')
            defer(recordViolation(ctx, bot.id, action.reason));
        // P74r17：这位员工挂在一件已完成、不在发布环节的事上时，需要审批的动作不再建审批（不落总管私聊、不新增审批）。
        // 越界是否计入保持上面的做法不变；这次拒绝本身不计越界。
        const ended = launchEndedRefusal(ctx, bot.id);
        if (ended !== null)
            return { allow: false, message: LAUNCH_ENDED_TOOL_REFUSAL_TEXT };
        const prepared = prepareApproval(ctx, bot.id, tool, args, action.cls === 'D' ? 'D' : 'C', action.reason, approvalAsksOf(action));
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
            text: `宿主权限拦截了${toolActionLabel(tool)}，本次动作未执行。请检查 DSH 会话权限；确认权限允许后再发消息让员工继续。中心未创建审批单，避免无效批准和反复重试。\n宿主原文（供核对）：${JSON.stringify({ tool, summary })}` });
        defer(syncAlertItems(ctx));
    }
    catch (error) {
        ctx.logger.warn('宿主权限告警失败，仍拒绝宿主弹框', String(error));
    }
    return 'deny';
}

/** 兼容模块级异步调用：放行结论与票据先同步决定，再等待通知副作用。 */
export async function guardToolCall(ctx: HubContext, sessionId: string, tool: string, args: unknown, host?: ToolCallHostReport): Promise<GuardDecision> {
    const effects: Promise<unknown>[] = [];
    let verified: Classification | undefined;
    const bot = ctx.store.table('bots').list(b => b.sessionId === sessionId)[0];
    if (bot) {
        try { const context = nativeGateContext(ctx, bot, host); verified = await checkGitBoundaries(ctx.fs, classifyToolCall(tool, args, context), context); }
        catch (error) { return { allow: false, message: `动作检查失败，未执行：${error instanceof Error ? error.message : String(error)}` }; }
    }
    const decision = guardToolCallSync(ctx, sessionId, tool, args, effect => { effects.push(effect); }, verified, host);
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
