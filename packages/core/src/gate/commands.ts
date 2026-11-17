/**
 * 命令分类从白名单出发，包装递归拆开；所有分支先检查路径，再决定是否允许，未知语法永不当作只读。
 *
 * P69（审批跟着 DSH 沙箱走）之后分两种情况：
 * - 宿主没确认沙箱（ctx.sandboxed 不为真）：和原来完全一样，看不懂的命令一律要主人审批。
 * - 宿主确认沙箱开着：看不懂的命令不再问主人（判 A，子类 sandboxed_exec，见 sandbox-rules.ts 的 unsure），
 *   因为它在沙箱里只写得进家目录和临时目录。仍然要问的只剩名单里的对外和系统类命令（outward-commands.ts）、
 *   网络写请求、推送和发布；凭据路径、中心管理的文件、未授权的工作数据照旧直接拒绝。
 * 文件里凡是写 unsure(...) 的地方，就是「沙箱开着不问、没确认照旧问」的那些情况。
 */
import { posix } from 'node:path';
import { C03_DEFAULTS } from '../config/defaults.js';
import { lexShell } from './shell-lexer.js';
import type { ShellPart } from './shell-lexer.js';
import { classifyPath, inSandboxTmp, isProtected, isProtectedAncestor, isUnresolvedPath, mostDangerous, resolveGatePath, unresolvedTouchesProtected, within } from './paths.js';
import type { Classification, GateContext } from './paths.js';
import type { AskHint } from '../model/outreach.js';
import { knownFindOptions, knownOptions, READ_OPTIONS } from './read-options.js';
import { classifyNetwork, paymentUrl } from './network-options.js';
import { httpieLocalOnly } from './local-address.js';
import { CREDENTIAL_HELPER_REASON, gitPushDetail, isCredentialHelper, isPlainWordProgram, KEYCHAIN_PROGRAMS, KEYCHAIN_REASON, matchLocalProgram, matchOutward, normalizePackageProgram, REGISTRY_SUBCOMMANDS, safeObject, SANDBOX_ESCAPE_PROGRAMS, SANDBOX_ESCAPE_REASON } from './outward-commands.js';
import { sandboxRelaxed, STANDARD_BIN_DIRS, unsure, WRAPPER_SCAN_SKIP } from './sandbox-rules.js';
import { unwrap } from './wrappers.js';
import { downloadInSubstitutions, feedOf, pipedTextOf, programOf, remoteInputOf, remoteScriptOf } from './shell-input.js';
const safe = (reason: string): Classification => ({ cls: 'A', reason, readOnly: true });
const external = (reason: string, subclass = 'run_command'): Classification => ({ cls: 'C', reason, subclass });
/** D 类（不可逆）判定。A-5：hint 必填，这样新增一种 D 而忘了给它配主人话时，类型检查就会报错。 */
const dangerous = (reason: string, hint: AskHint): Classification => ({ cls: 'D', reason, subclass: 'high_risk', hint });
/** 参数可能是普通路径、--key=路径、@上传文件或 file URL；全部保留在边界检查中。 */
function argumentPaths(args: string[]): string[] {
    return args.flatMap(arg => {
        const values = [arg];
        // -f/path、-i$HOME/file 等附着参数仍引用文件，不能因选项前缀跳过敏感边界。
        if (arg.startsWith('-')) {
            const start = arg.search(/~\/|\$(?:\{?(?:HOME|DSH_HOME))|\//);
            if (start >= 0) values.push(arg.slice(start));
        }
        if (arg.includes('=')) values.push(arg.slice(arg.indexOf('=') + 1));
        const at = arg.indexOf('@');
        if (at >= 0 && arg.length > at + 1) values.push(arg.slice(at + 1));
        return values.filter(p => p && !p.startsWith('-') && !/^https?:\/\//i.test(p));
    });
}
/** git 里除 push 以外，同样是往远端送东西的子命令（卡片之外补充）：沙箱开着也照旧要主人确认。 */
function gitSendsOut(operation: string | undefined, tail: string[]): boolean {
    return (operation === 'subtree' && tail.includes('push')) || (operation === 'lfs' && tail.includes('push'))
        || (operation === 'svn' && tail.includes('dcommit')) || (operation === 'p4' && tail.includes('submit')) || MAIL_OPERATIONS.includes(operation ?? '');
}
/** git 里往外发邮件的子命令（R9）：归 send_message，审批卡说「发邮件」。 */
const MAIL_OPERATIONS: readonly string[] = ['send-email', 'imap-send'];
/** 都是把提交送到远端的写法：push 本身，加上少见的底层命令 send-pack、http-push（R9）。 */
const PUSH_WORDS: readonly string[] = ['push', 'send-pack', 'http-push'];
/** git 全局参数会改变仓库和运行行为；配置项不覆盖内层 push 的 D 级别。 */
function classifyGit(args: string[], ctx: GateContext): Classification {
    const relaxed = sandboxRelaxed(ctx), sandbox = ctx.sandboxed === true;
    let repo = resolveGatePath('.', ctx), index = 0;
    const checks: Classification[] = [];
    // 沙箱模式（R9）：碰到不认识的全局选项，就没法确定它后面带不带值，后面任何位置出现 push 都按推送算。
    let unknownGlobal = false;
    while (index < args.length && args[index]!.startsWith('-')) {
        const arg = args[index++]!;
        const name = arg.split('=')[0]!;
        if (['-C', '--git-dir', '--work-tree', '-c', '--config-env'].includes(name)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index++];
            if (!value) return unsure(ctx, 'git 全局选项缺少值', 'git_write');
            if (name === '-C') repo = resolveGatePath(value, { ...ctx, cwd: repo });
            else if (name === '--work-tree' || name === '--git-dir') {
                checks.push(classifyPath(value, true, ctx, true));
                if (name === '--work-tree') repo = resolveGatePath(value, ctx);
            }
            // 命令行上临时定义别名（-c alias.x=push）可以把任何子命令变成推送，沙箱开着也照旧要确认；其余配置项走 unsure。
            else checks.push(relaxed && !/^alias\./i.test(value) ? unsure(ctx, 'git 配置可能执行外部程序', 'git_write') : external('git 配置可能执行外部程序', 'git_write'));
        } else if (sandbox && name === '--namespace') {
            // --namespace 带一个值（--namespace foo 或 --namespace=foo）：值不能被当成子命令。
            if (!(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index++])) return unsure(ctx, 'git 全局选项缺少值', 'git_write');
        } else {
            checks.push(unsure(ctx, 'git 全局选项不在白名单', 'git_write'));
            unknownGlobal = true;
        }
    }
    const operation = args[index++], tail = args.slice(index);
    // 推送的位置：子命令本身是推送写法就是 0；沙箱模式下遇到过不认识的全局选项时，在子命令和后面的词里找。
    const words = operation === undefined ? [] : [operation, ...tail];
    const pushAt = operation === 'push' ? 0 : sandbox ? (PUSH_WORDS.includes(operation ?? '') ? 0 : unknownGlobal ? words.findIndex(w => PUSH_WORDS.includes(w)) : -1) : -1;
    const pushing = pushAt >= 0, pushTail = pushing ? words.slice(pushAt + 1) : [];
    if (pushing && pushTail.some(a => /^--(?:force|delete|mirror)(?:=|$|-)/.test(a) || /^-[^-]*[fd]/.test(a) || /^[+:]/.test(a))) checks.push(dangerous('git 强推或删除远端分支不可逆', 'git_force'));
    const outputs = tail.flatMap((a, i) => a.startsWith('--output=') ? [a.slice(9)] : a === '--output' && tail[i + 1] ? [tail[i + 1]!] : []);
    checks.push(...outputs.map(p => classifyPath(p, true, { ...ctx, cwd: repo })));
    if (['status', 'log', 'diff', 'show'].includes(operation ?? '')) {
        const policy = { short: 'sbpuUwn', values: 'Un', long: ['--oneline', '--stat', '--short', '--branch', '--porcelain', '--name-only', '--name-status', '--no-patch', '--patch', '--cached', '--staged', '--no-ext-diff', '--no-textconv', '--all', '--graph', '--decorate'], longValues: ['--max-count', '--format', '--pretty', '--since', '--until'] };
        checks.push(knownOptions(tail, policy) ? classifyPath(repo, false, ctx) : unsure(ctx, 'git 只读子命令含未知或执行写入选项', 'git_write'));
    }
    // 推送是对外动作：沙箱开不开都要主人确认，子类单独叫 git_push，审批卡据此说「把代码推送到远端仓库」。
    else if (pushing || gitSendsOut(operation, tail)) {
        const mail = MAIL_OPERATIONS.includes(operation ?? '');
        const detail = pushing ? gitPushDetail(pushTail) : mail ? 'git' : undefined;
        checks.push({ ...external('git 修改仓库或远端需要审批', mail ? 'send_message' : 'git_push'), ...(detail === undefined ? {} : { detail }),
            gitRepos: pushing && !sandbox ? [repo] : [] });
    }
    // 在仓库配置里登记别名（git config alias.p push），之后 git p 就等于推送：和命令行上的 -c alias 同样处理，沙箱开着也要确认。
    else if (relaxed && operation === 'config' && tail.some(a => /^alias\./i.test(a))) checks.push(external('git 别名可以把任何子命令变成推送，需要审批', 'git_write'));
    // git credential 系列会读取或改写钥匙串里保存的登录凭据（总控裁定第 4 条）：和 security 一样直接拒绝，沙箱开不开都一样。
    else if (/^credential(?:-|$)/.test(operation ?? '')) checks.push({ cls: 'protected', reason: CREDENTIAL_HELPER_REASON });
    // 沙箱开着：init、add、commit、checkout、clone、fetch、pull、config 这些只动沙箱里的仓库，不再问。
    else if (relaxed) checks.push(unsure(ctx, 'git 修改仓库', 'git_write'));
    else if (operation === 'commit' && within(repo, ctx.homeDir)) checks.push({ cls: 'A', reason: '家目录内提交须核验实际 gitdir', subclass: 'internal_write', paths: [repo], gitRepos: [repo] });
    else checks.push({ ...external('git 修改仓库或远端需要审批', 'git_write'), gitRepos: operation === 'commit' ? [repo] : [] });
    return mostDangerous(checks);
}
/** 包管理只给 work 中明确的本地子命令 A；执行类递归还原，发布永久审批。沙箱开着时本地子命令不再限定在 work 下。 */
function classifyPackage(cmd: string, args: string[], ctx: GateContext, depth: number): Classification {
    const checks: Classification[] = [];
    let executionContext = ctx;
    const options = ['--prefix', '--dir', '--cwd', '--cache', '--store-dir', '--global-dir', '-C', '-w', '--workspace'];
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!, name = arg.split('=')[0]!;
        if (options.includes(name)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
            if (!value) checks.push(unsure(ctx, '包管理目录参数缺失'));
            else {
                if (['--prefix', '--dir', '--cwd', '-C'].includes(name)) executionContext = { ...ctx, cwd: resolveGatePath(value, ctx) };
                if (!within(resolveGatePath(value, ctx), `${ctx.homeDir}/work`)) checks.push(unsure(ctx, '包管理目录超出 work'), classifyPath(value, true, ctx));
            }
        } else filtered.push(arg);
    }
    if (filtered.some(a => /^(?:-g|--global|--location=global)$/.test(a))) checks.push(unsure(ctx, '安装全局软件需要审批', 'global_install'));
    // npx 和它的同类（pnpx、bunx、uvx、pipx run）整条命令就是「执行一个包」，没有子命令。
    const runsPackage = cmd === 'npx' || (ctx.sandboxed === true && ['pnpx', 'bunx', 'uvx'].includes(cmd));
    let operation = runsPackage ? 'exec' : filtered.find(a => !a.startsWith('-'));
    let opIndex = runsPackage ? -1 : filtered.indexOf(operation ?? '');
    // 发布不一定紧跟在程序名后面：pnpm --filter x publish、yarn npm publish 的 publish 排在后面。
    // 沙箱开着时看不懂的子命令不再问人，所以这里把前三个非选项词里出现 publish 也算发布（run、exec 这类运行脚本的除外）。
    const bare = filtered.filter(a => !a.startsWith('-'));
    const notLate = !['run', 'run-script', 'exec', 'dlx', 'create', 'test', 'build', 'install', 'i', 'ci', 'add', 'remove', 'list', 'ls', 'outdated', 'why'].includes(bare[0] ?? '');
    const lateRelease = sandboxRelaxed(ctx) && notLate && bare.slice(0, 3).some(a => ['publish', 'unpublish'].includes(a));
    // 执行包也一样（A-3，R2）：pnpm --filter web exec vercel deploy、yarn workspace web exec … 的 exec 排在后面，
    // 不然 web 会被当成子命令、整条被当成看不懂而放行。
    if (!runsPackage && sandboxRelaxed(ctx) && notLate && !['exec', 'x', 'dlx', 'create'].includes(operation ?? '')) {
        const late = bare.slice(0, 3).find(a => a === 'exec' || a === 'dlx');
        if (late !== undefined) { operation = late; opIndex = filtered.indexOf(late); }
    }
    const tail = filtered.slice(opIndex + 1).filter(a => a !== '--');
    // A-3b（T3）：yarn、pnpm 会把不认识的子命令当成本地装的程序来运行（pnpm wrangler deploy），命中对外名单就按对外动作判。
    const local = ctx.sandboxed === true && ['yarn', 'pnpm'].includes(cmd) ? matchLocalProgram(cmd, args) : null;
    if (local) checks.push({ ...external(local.reason, local.subclass), ...(local.detail === undefined ? {} : { detail: local.detail }) });
    if (['publish', 'unpublish'].includes(operation ?? '') || lateRelease) checks.push(dangerous('发布或撤回软件包是不可逆对外动作', 'publish_package'));
    else if (['exec', 'x', 'dlx', 'create'].includes(operation ?? '')) {
        if (!within(resolveGatePath('.', executionContext), `${ctx.homeDir}/work`)) checks.push(unsure(ctx, '包执行包装只在家目录 work 内免审批'));
        const c = tail.findIndex(a => a === '-c' || a === '--call');
        let child = tail;
        // 沙箱模式（R2）多认几个带值的选项（uvx --from 包 程序、pipx run --spec 包 程序），免得把值当成程序名。
        const valued = ctx.sandboxed === true ? ['-p', '--package', '--from', '--spec', '--python', '--with'] : ['-p', '--package'];
        while (child[0]?.startsWith('-')) {
            const flag = child[0];
            checks.push(unsure(ctx, '包执行包装选项需审批'));
            child = child.slice(valued.includes(flag!) && !flag!.includes('=') ? 2 : 1);
        }
        // 沙箱模式（R2）：包名先规范化再查名单。vercel@latest 就是 vercel，netlify-cli 跑的是 netlify。
        if (ctx.sandboxed === true && child[0] !== undefined) child = [normalizePackageProgram(child[0]), ...child.slice(1)];
        checks.push(c >= 0 && tail[c + 1] ? classifyCommand(tail[c + 1]!, executionContext, depth + 1) : classifyArgv(child, executionContext, depth + 1));
    } else if (!['install', 'i', 'ci', 'add', 'remove', 'run', 'run-script', 'test', 'build', 'list', 'ls', 'outdated', 'why'].includes(operation ?? '')) {
        // 登录、改归属、打标签、作废版本这些会改动公共仓库上的东西，沙箱开着也照旧要主人确认（卡片之外补充）。
        checks.push(REGISTRY_SUBCOMMANDS.includes(operation ?? '') ? { ...external('包管理子命令不在本地操作白名单', 'publish_deploy'), detail: cmd } : unsure(ctx, '包管理子命令不在本地操作白名单'));
    } else {
        if (filtered.some(a => a.startsWith('-') && !['--offline', '--frozen-lockfile', '--ignore-scripts', '--save-dev', '-D', '--production', '--no-audit', '--no-fund', '-g', '--global', '--location=global'].includes(a))) checks.push(unsure(ctx, '包管理选项未知或可能改写全局配置'));
        checks.push(within(resolveGatePath('.', ctx), `${ctx.homeDir}/work`) ? { cls: 'A', reason: 'work 内明确的本地包管理操作', subclass: 'work', paths: [resolveGatePath('.', ctx)] } : unsure(ctx, '包管理只在家目录 work 内免审批'));
    }
    return mostDangerous(checks);
}
/**
 * 沙箱开着时删除目标怎么判：家目录里的照旧过路径规则（受保护的拦）；临时目录放行；
 * 写的是变量、看不出落在哪的交给沙箱；写明了在沙箱外的保持 D 并标成「沙箱会拦」，守卫指路并记越界。
 */
function removalTarget(target: string, ctx: GateContext): Classification {
    const path = resolveGatePath(target, ctx);
    if (isUnresolvedPath(path) || within(path, ctx.homeDir) || inSandboxTmp(path, ctx)) return classifyPath(target, true, ctx, true);
    return { ...dangerous('删除家目录以外的内容属于不可逆动作', 'delete'), blocked: true, paths: [path] };
}
/** 外壳要执行下载来的脚本：保持 C；detail 是下载的主机名（取不到就不带），hint 让审批卡说「运行从 … 下载的脚本」。 */
function remoteScriptAsk(download: { host?: string }): Classification {
    return { ...external('外壳要执行从网上下载的脚本，无法确认内容'), hint: 'remote_script', ...(download.host === undefined ? {} : { detail: download.host }) };
}
/** 一条命令的标准输入和递归选项（沙箱模式用）。 */
export interface ArgvIo {
    /** 喂给外壳的写死文字：同一条管道里紧挨着的前一段是 cat、echo、printf 时，它输出的文字。null 表示看不见内容。 */
    piped?: readonly string[] | null;
    /** 标准输入被重定向到了文件（bash < 文件），内容看不见。 */
    inputRedirect?: boolean;
    /** A-3b（T2）：外壳要读的脚本是下载来的（前一段是 curl、wget，或后面跟着 <(curl …)）；host 是下载的主机名。 */
    remote?: { host?: string } | null;
    /** A-4（S14）：这一段的命令替换里有下载（"$(curl …)"）。拆出外壳的 -c 脚本或 eval 时，据此判断执行的是下载来的内容。 */
    scriptDownload?: { host?: string } | null;
    /** 是否做 R4 的兜底检查。兜底里的内层分类会关掉它，免得一层套一层。 */
    scan?: boolean;
}
/** 解释器按名字的样子认，带不带版本号都算：python3.12、pypy3、nodejs、Rscript 都是（R6）。名字已折成小写。 */
const INTERPRETER_NAME = /^(?:python|pypy|node|nodejs|ruby|perl|php|lua)\d*(?:\.\d+)*$|^(?:deno|bun|rscript)$/;
/** python -m 模块名：取出模块名和它后面的参数（R3）。只看开头那串选项，遇到 -c 这类带代码的选项就停。 */
function moduleOf(args: string[]): { name: string; rest: string[] } | undefined {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!arg.startsWith('-') || arg.startsWith('--')) return undefined;
        for (let n = 1; n < arg.length; n++) {
            if (arg[n] === 'm') {
                const attached = arg.slice(n + 1);
                const name = attached || args[i + 1];
                return name ? { name, rest: args.slice(i + (attached ? 1 : 2)) } : undefined;
            }
            if ('cWX'.includes(arg[n]!)) return undefined;
        }
    }
    return undefined;
}
/** R4 兜底：未识别的程序，把「-- 之后」和「第一个非选项参数起」当成两条独立命令各分一次类，取更严的结果。 */
function scanAsWrapper(cmd: string, args: string[], ctx: GateContext, depth: number): Classification[] {
    if (WRAPPER_SCAN_SKIP.includes(cmd)) return [];
    const candidates: string[][] = [];
    const dash = args.indexOf('--');
    if (dash >= 0 && dash + 1 < args.length) candidates.push(args.slice(dash + 1));
    const first = args.findIndex(a => !a.startsWith('-'));
    if (first >= 0 && first !== (dash >= 0 ? dash + 1 : -1)) candidates.push(args.slice(first));
    const found: Classification[] = [];
    for (const candidate of candidates) {
        const head = candidate[0] ?? '';
        // 带路径的程序名多半是文件名（pytest tests/ssh），只认标准目录里的；日常英文单词（open、kill 等）也不当程序看。
        if (!head || (head.includes('/') && !STANDARD_BIN_DIRS.includes(posix.dirname(head))) || isPlainWordProgram(posix.basename(head).toLowerCase())) continue;
        const inner = classifyArgv(candidate, ctx, depth + 1, [], { scan: false });
        if (inner.cls !== 'A') found.push(inner);
    }
    return found;
}
/** argv 不经过 shell，仍使用完全相同的递归、敏感路径和危险动作规则。feed 是沙箱模式下这条命令带的 here-document 和 here-string 文字。 */
export function classifyArgv(words: string[], ctx: GateContext, depth = 0, feed: readonly string[] = [], io: ArgvIo = {}): Classification {
    if (depth > (ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth)) return unsure(ctx, '命令包装递归超过四层，需审批');
    if (!words.length) return unsure(ctx, '命令缺少程序名');
    const sandbox = ctx.sandboxed === true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
        // 沙箱模式下赋值本身不再问，所以要把等号后面写明的路径查一遍：KEY=~/.ssh/id_rsa、D=/公司目录 不能借赋值溜过去。
        const assigned = sandbox ? argumentPaths([words[0]!]).map(p => classifyPath(p, false, ctx)) : [];
        return mostDangerous([unsure(ctx, '命令前缀环境变量需审批'), ...assigned, classifyArgv(words.slice(1), ctx, depth + 1, feed, io)]);
    }
    // macOS 的文件系统不区分大小写，GIT push 和 git push 是同一个程序。沙箱模式下不认识的程序会被放行，所以先把名字折成小写再认。
    const program = words[0]!, cmd = sandbox ? posix.basename(program).toLowerCase() : posix.basename(program), args = words.slice(1);
    const recursive = cmd === 'rg' || cmd === 'find' || (cmd === 'grep' && args.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) || (cmd === 'ls' && args.some(a => /^-[^-]*R/.test(a) || a === '--recursive'));
    const checks = [classifyPath(program, false, ctx), classifyPath('.', false, ctx, false, recursive), ...argumentPaths(args).map(p => classifyPath(p, false, ctx, false, recursive))]
        .filter(check => cmd !== 'echo' || check.cls !== 'C');
    const pathRisk = mostDangerous(checks);
    if (pathRisk.cls === 'protected' || pathRisk.subclass === 'work_data') return pathRisk;
    // 钥匙串命令行直接拒绝；su 和 sudo、doas 一样永远是 D。这两条沙箱开不开都生效。
    if (KEYCHAIN_PROGRAMS.includes(cmd)) return { cls: 'protected', reason: KEYCHAIN_REASON };
    // A-3b（T4 第 3 项）：凭据助手被直接调用，等于把钥匙串里的登录凭据读出来，和 git credential 一样直接拒绝。
    if (sandbox && isCredentialHelper(cmd)) return { cls: 'protected', reason: CREDENTIAL_HELPER_REASON };
    if (cmd === 'su') {
        const c = args.indexOf('-c');
        return mostDangerous([...checks, dangerous('提权命令永久需要审批', 'elevate'), ...(c >= 0 && args[c + 1] ? [classifyCommand(args[c + 1]!, ctx, depth + 1)] : [])]);
    }
    if (program.includes('/') && !STANDARD_BIN_DIRS.includes(posix.dirname(program))) checks.push(unsure(ctx, '自定义路径程序不能仅凭名字获得白名单权限'));
    const wrapper = unwrap(cmd, args, ctx);
    if (wrapper) {
        if (wrapper.floor) checks.push(wrapper.floor);
        if (cmd === 'time') {
            for (const [index, arg] of args.entries()) {
                if (arg === '-o' || arg === '--output') checks.push(classifyPath(args[index + 1] ?? '$UNKNOWN', true, ctx));
                if (arg.startsWith('--output=')) checks.push(classifyPath(arg.slice(9), true, ctx));
            }
        }
        if (cmd === 'script') {
            const logFile = args.find(a => !a.startsWith('-'));
            if (logFile && !args.includes('-c') && !args.includes('--command')) checks.push(classifyPath(logFile, true, ctx));
        }
        if (wrapper.script !== undefined) checks.push(classifyCommand(wrapper.script, ctx, depth + 1));
        // A-4（S14）：真正拆出了外壳的 -c 脚本（或 eval 的文字），而这一段的命令替换里是下载：执行的是下载来的内容，看不见，保持 C。
        // io 会穿过变量赋值前缀和各层包装器（env、nohup、time 等），所以带前缀的写法也在这里被认出来。
        if (sandbox && wrapper.script !== undefined && io.scriptDownload) checks.push(remoteScriptAsk(io.scriptDownload));
        if (wrapper.words?.length) checks.push(classifyArgv(wrapper.words, wrapper.cwd ? { ...ctx, cwd: resolveGatePath(wrapper.cwd, ctx) } : ctx, depth + 1, feed, io));
        // 外壳从标准输入读命令时（R1）：脚本只可能来自它自己的 here-document、here-string，或前一段写死文字的 cat、echo、printf。
        // 这些文字就是要执行的脚本，照旧逐条分类；一条也找不到（bash < 文件、curl … | sh、进程替换），看不见内容，保持 C。
        if (sandbox && wrapper.readsStdin) {
            const scripts = [...feed, ...(io.piped ?? [])];
            if (io.inputRedirect || (!feed.length && !io.piped)) checks.push(io.remote
                ? remoteScriptAsk(io.remote)
                : { ...external('外壳要执行的脚本来自看不见的输入（文件、管道或进程替换），无法确认内容'), hint: 'blind_script' as const });
            else checks.push(...scripts.map(text => classifyCommand(text, ctx, depth + 1)));
        }
        return mostDangerous(checks);
    }
    let result: Classification;
    // find 带 -exec 且里面的命令全是只读的：R7 第 2 条的「上级目录」检查不针对它。
    let findOnlyReads = false;
    let bunLocal: ReturnType<typeof matchLocalProgram> = null;
    const outward = matchOutward(cmd, args);
    if (['env', 'printenv'].includes(cmd) || (cmd === 'set' && !args.length)) result = unsure(ctx, '输出宿主环境变量需要审批');
    else if (['curl', 'wget'].includes(cmd)) result = classifyNetwork(cmd, args, ctx);
    else if (['http', 'httpie'].includes(cmd) && args.some(paymentUrl)) result = dangerous('支付、下单或转账 API 永久需要审批', 'payment');
    // P74r9 第 4 节：httpie、xh 的请求地址是本机（解析后的主机名判断，选项都认得）时，不算向外部网址发送数据（outward-commands.ts 里已不命中）。
    else if (['http', 'https', 'httpie', 'xh', 'xhs'].includes(cmd) && httpieLocalOnly(args)) result = { cls: 'A', reason: '只是访问本机地址，数据没有离开这台电脑', subclass: 'local_http' };
    else if (cmd === 'git') result = classifyGit(args, ctx);
    else if (['npm', 'pnpm', 'yarn', 'npx'].includes(cmd) || (sandbox && ['pnpx', 'bunx', 'uvx'].includes(cmd))) result = classifyPackage(cmd, args, ctx, depth);
    // pipx run 包名 程序 和 bun x 包名 程序 都是包执行器；bun publish 发到 npm 仓库，和 npm publish 一样处理（R2、R3，沙箱模式）。
    else if (sandbox && cmd === 'pipx' && args[0] === 'run') result = classifyPackage('uvx', args.slice(1), ctx, depth);
    // uv tool run 包 … 和 uvx 包 … 是一回事（A-3b，T4 第 1 项）。
    else if (sandbox && cmd === 'uv' && args[0] === 'tool' && args[1] === 'run') result = classifyPackage('uvx', args.slice(2), ctx, depth);
    else if (sandbox && cmd === 'bun' && ['x', 'publish'].includes(args.find(a => !a.startsWith('-')) ?? '')) {
        const at = args.findIndex(a => !a.startsWith('-'));
        result = args[at] === 'x' ? classifyPackage('npx', args.slice(at + 1), ctx, depth) : classifyPackage('npm', args, ctx, depth);
    }
    // bun 把不认识的子命令当成本地装的程序来运行（bun vercel deploy，A-3b，T3）；命中对外名单就按对外动作判。
    else if (sandbox && cmd === 'bun' && (bunLocal = matchLocalProgram('bun', args)) !== null) result = { ...external(bunLocal.reason, bunLocal.subclass), ...(bunLocal.detail === undefined ? {} : { detail: bunLocal.detail }) };
    else if ((['aws', 'gcloud', 'az'].includes(cmd) && args.some(a => /^(delete|remove|terminate|destroy|rm)/i.test(a))) || (cmd === 'gh' && args[0] === 'repo' && args[1] === 'delete') || (cmd === 'kubectl' && args.includes('delete'))) result = dangerous('删除远端资源不可逆', 'remote_delete');
    else if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'rimraf'].includes(cmd)) {
        const targets = args.filter(a => !a.startsWith('-'));
        if (targets.some(p => within(ctx.homeDir, resolveGatePath(p, ctx)) || within(`${ctx.homeDir}/memory/journal`, resolveGatePath(p, ctx)))) result = { cls: 'protected', reason: '不能删除包含身份、心智视图或历史日志的目录' };
        else if (sandbox) result = targets.length ? mostDangerous(targets.map(p => removalTarget(p, ctx))) : unsure(ctx, '删除命令缺少明确目标');
        else if (targets.some(p => !within(resolveGatePath(p, ctx), ctx.homeDir))) result = { ...dangerous('删除家目录以外的内容属于不可逆动作', 'delete'), paths: targets.map(p => resolveGatePath(p, ctx)).filter(p => !within(p, ctx.homeDir)) };
        else result = targets.length ? mostDangerous(targets.map(p => classifyPath(p, true, ctx, true))) : external('删除命令缺少明确目标');
    } else if (cmd === 'find') {
        const special: Classification[] = [], inner: Classification[] = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if (/^-fprint|^-fls$/.test(arg)) special.push(unsure(ctx, 'find 包含写入选项'), classifyPath(args[i + 1] ?? '$UNKNOWN', true, ctx));
            if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
                const end = args.findIndex((a, n) => n > i && [';', '+'].includes(a));
                const child = classifyArgv(args.slice(i + 1, end < 0 ? undefined : end), ctx, depth + 1);
                inner.push(child);
                special.push(unsure(ctx, 'find 执行子命令需审批'), child);
            }
            if (arg === '-delete') {
                const child = classifyArgv(['rm', args.find(a => !a.startsWith('-')) ?? '.'], ctx, depth + 1);
                inner.push(child);
                special.push(unsure(ctx, 'find 删除需要审批'), child);
            }
        }
        // special 里每个 -exec 恰好对应两项（unsure 加子命令）；多出别的项（比如 -fprint 写文件）就不算「只读」。
        findOnlyReads = inner.length > 0 && inner.every(child => child.readOnly === true) && special.length === inner.length * 2;
        result = special.length ? mostDangerous(special) : knownFindOptions(args) ? safe('find 只读选项白名单') : unsure(ctx, 'find 含未知选项');
    } else if (READ_OPTIONS[cmd]) {
        // BSD date 的 -f 未配 -j 会设置时间，-d 还会改内核 DST；不能套用 GNU 的只读含义。
        const dateNoSet = args.some(a => /^-[^-]*j/.test(a));
        const dateSafe = !args.some(a => /^-[^-]*d/.test(a))
            && (!args.some(a => /^-[^-]*f/.test(a) || /^\d{4,}/.test(a)) || dateNoSet);
        const bounded = (cmd !== 'xxd' || args.filter(a => !a.startsWith('-')).length <= 1)
            && (cmd !== 'date' || dateSafe);
        result = bounded && knownOptions(args, READ_OPTIONS[cmd]!) ? safe('只读程序及参数白名单') : unsure(ctx, '只读程序含未知选项或写入操作数');
    } else if (sandbox ? INTERPRETER_NAME.test(cmd) && !outward : ['node', 'python', 'python3', 'ruby', 'perl'].includes(cmd)) {
        // 沙箱模式下 deno publish 这类「解释器名字、对外用法」要先让给对外名单（!outward），不能被当成内联代码放行。
        const script = args[0];
        // python -m 模块名（R3）：模块名当程序名再查一遍对外名单，python3 -m twine upload 等同 twine upload。
        const module = sandbox ? moduleOf(args) : undefined;
        const moduleHit = module === undefined ? null : matchOutward(posix.basename(module.name).toLowerCase(), module.rest);
        // bun、deno 的第一个词是子命令（run、test），不是脚本文件，所以不走「家目录内脚本」那条。
        if (moduleHit) result = { ...external(moduleHit.reason, moduleHit.subclass), ...(moduleHit.detail === undefined ? {} : { detail: moduleHit.detail }), opaque: true };
        else if (script && !script.startsWith('-') && !(sandbox && ['bun', 'deno'].includes(cmd)) && within(resolveGatePath(script, ctx), ctx.homeDir)) result = { cls: 'A', reason: '运行家目录内明确脚本', subclass: 'internal_script', paths: [resolveGatePath(script, ctx)] };
        // opaque：命令里带着一段分类器看不进去的代码，上层据此在原文里找凭据字样。
        else result = { ...unsure(ctx, '内联代码或不明确的脚本需要审批'), opaque: true };
    } else if (['mkdir', 'touch', 'cp', 'mv', 'tee', 'chmod', 'chown'].includes(cmd)) {
        const values = args.filter(a => !a.startsWith('-'));
        const targets = ['cp', 'mv'].includes(cmd) ? values.slice(-1) : ['chmod', 'chown'].includes(cmd) ? values.slice(1) : values;
        const options = { short: cmd === 'cp' || cmd === 'mv' ? 'Rrfpivn' : cmd === 'mkdir' ? 'pv' : cmd === 'touch' ? 'acm' : cmd === 'tee' ? 'ai' : 'Rf', long: ['--parents', '--recursive', '--force', '--verbose', '--append'] };
        const uncertain = !knownOptions(args, options) || !targets.length;
        if (uncertain && !sandbox) result = external('写入选项或目标不能安全确定');
        else if (cmd === 'mv' && values.slice(0, -1).some(p => within(ctx.homeDir, resolveGatePath(p, ctx)) || within(`${ctx.homeDir}/memory/journal`, resolveGatePath(p, ctx)))) result = { cls: 'protected', reason: '不能搬走包含受保护文件的目录' };
        else {
            const sources = ['cp', 'mv'].includes(cmd) ? values.slice(0, -1) : [];
            // 纯分类器无法确认目标是文件还是目录，两种解释都检查，避免 cp work/AGENTS.md . 隐式改写身份。
            // 只推导这一层的最终文件名，不读取磁盘或扫描目录；普通 hello.txt 仍保留家内 A 类。
            const directoryTargets = sources.flatMap(source => targets.map(target =>
                posix.join(resolveGatePath(target, ctx), posix.basename(resolveGatePath(source, ctx)))));
            result = mostDangerous([...sources.map(p => classifyPath(p, cmd === 'mv', ctx, true)),
                ...targets.map(p => classifyPath(p, true, ctx, true)), ...directoryTargets.map(p => classifyPath(p, true, ctx, true))]);
            // 沙箱模式下选项看不懂也不再问，但写明的目标照旧要查：受保护的文件拦下，沙箱外的位置指路。
            if (uncertain) result = mostDangerous([unsure(ctx, '写入选项或目标不能安全确定'), result]);
        }
    }
    // 名单里的对外和系统类命令：沙箱开不开都要主人确认。
    else if (outward) result = { ...external(outward.reason, outward.subclass), ...(outward.detail === undefined ? {} : { detail: outward.detail }) };
    // pip 在沙箱里只装得进家目录下的环境，不再问；没确认沙箱时照旧算安装软件。
    else if (['pip', 'pip3'].includes(cmd)) result = unsure(ctx, '安装软件需要审批', 'global_install');
    // 沙箱管不到的程序：照旧要主人确认，不享受「看不懂也放行」。
    else if (sandbox && SANDBOX_ESCAPE_PROGRAMS.includes(cmd)) result = { ...external(SANDBOX_ESCAPE_REASON), hint: 'sandbox_escape', ...(safeObject(cmd) === undefined ? {} : { detail: cmd }) };
    else {
        result = unsure(ctx, '未识别的命令需要审批');
        // R4 兜底：程序名没人认识，它可能是个没登记的包装器（foo -- ssh host、foo ssh host）。把后面的部分当成命令再分一次类，
        // 结果更严就用更严的。查找和说明类的程序（which、man、rg 等）和日常单词的程序名（open、kill 等）不触发。
        if (sandbox && io.scan !== false && result.cls === 'A') result = mostDangerous([result, ...scanAsWrapper(cmd, args, ctx, depth)]);
    }
    // 沙箱模式下「看不懂」不再问，但参数里写明了中心管理的文件（AGENTS.md、mind/、memory/journal/）时，
    // 分不清它是读还是改，照旧留在审批里：改中心管理的文件这条规则不能因为换了个不认识的程序就放松。
    // R7：还有三种不点名的写法也一样保持 C：路径里的变量去掉后剩下的写死部分落在中心管理的位置（$X/memory/journal/…）；
    // 参数是家目录里面、受保护位置的上级（目前只有 memory）。A-3b（T1）：家目录本身、. 、家目录的上级不再算，
    // 解包类程序没写落点也不再拦，免得 cd 目录 && eslint . 这类日常命令多出审批卡（理由见 paths.ts 的 isProtectedAncestor）。
    if (result.cls === 'A' && result.subclass === 'sandboxed_exec') {
        const given = argumentPaths(args).map(p => resolveGatePath(p, ctx));
        const named = given.some(p => isProtected(p, ctx) || (isUnresolvedPath(p) && unresolvedTouchesProtected(p, ctx)));
        // cd、pushd、popd 只是换目录，不改任何东西，所以 cd .. 、cd ~ 不算「把上级目录交给命令」。
        const parent = !findOnlyReads && !['cd', 'pushd', 'popd'].includes(cmd) && given.some(p => isProtectedAncestor(p, ctx));
        if (named || parent) result = { ...external('命令涉及中心管理的文件，无法确认是否只读，需要审批'), hint: 'managed_files', ...(result.opaque === true ? { opaque: true } : {}) };
    }
    // 复盘可以写 work 与记忆，但运行任意脚本不能证明只改这些允许区域。
    if (ctx.reflection && result.cls === 'A' && result.subclass === 'internal_script') result = { cls: 'protected', reason: '复盘回合禁止运行无法确定副作用的脚本' };
    return mostDangerous([...checks, result]);
}
/** 带内嵌文字的这一段，是不是只把文字写进文件或显示出来（R10）：是 cat 或 tee，并且是所在管道的最后一段。 */
const onlyWritesText = (part: ShellPart): boolean => ['cat', 'tee'].includes(programOf(part)) && part.pipesOn !== true;
/** 分段后追踪 cd，并检查所有重定向；不确定展开仍保守 C（沙箱开着时不再问），已知危险子段保留更高级别。 */
export function classifyCommand(command: string, ctx: GateContext, depth = 0): Classification {
    if (depth > (ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth)) return unsure(ctx, '命令包装递归超过四层，需审批');
    const sandbox = ctx.sandboxed === true;
    // 沙箱模式用更细的词法：here-document 的正文、括号里的子命令都要认准，见 shell-lexer.ts 文件头。
    const parsed = lexShell(command, depth, ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth, sandbox ? { sandbox: true } : undefined);
    const contexts: GateContext[] = [ctx], results: Classification[] = [];
    for (const [index, part] of parsed.parts.entries()) {
        const feed = sandbox ? feedOf(part) : [];
        const io: ArgvIo = sandbox ? { piped: pipedTextOf(parsed.parts, index), inputRedirect: part.redirects.some(r => !r.write), remote: remoteInputOf(parsed.parts, index), scriptDownload: downloadInSubstitutions(part) } : {};
        // A-3b（T2）：sh -c "$(curl …)"、eval "$(curl …)"、source <(curl …) 要执行的是下载来的内容，看不见，保持 C，并带上主机名。
        const remoteScript = sandbox ? remoteScriptOf(part) : null;
        if (remoteScript) results.push(remoteScriptAsk(remoteScript));
        for (const current of [...contexts]) {
            results.push(classifyArgv(part.words, current, depth, feed, io), ...part.redirects.map(r => {
                // 标准设备仅承接当前命令的输出，不是持久文件写入；精确匹配防止相似路径获得例外。
                // 仍按读取检查工作数据等边界，普通写工具与其他 /dev 路径不会借此放宽。
                const outputDevice = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(resolveGatePath(r.path, current));
                return classifyPath(r.path, r.write && !outputDevice, current);
            }));
            if (part.words[0] === 'cd' && part.words.length === 2) {
                const cwd = resolveGatePath(part.words[1]!, current);
                if (!contexts.some(c => (c.cwd ?? c.homeDir) === cwd)) contexts.push({ ...ctx, cwd });
            }
        }
        if (part.dynamic) results.push(unsure(ctx, '动态展开的最终参数无法静态确认'));
        // 带着一段内嵌文字的命令：这段文字不参与分类，但要让上层知道原文里可能藏着路径。
        // 例外（R10）：文字只是被 cat、tee 写进文件，不会被当成代码执行，原文里提到 .env、~/.ssh/ 只是在写文字，不查。
        if (feed.length) results.push(onlyWritesText(part) ? { cls: 'A', reason: '命令把内嵌文字写进文件', readOnly: true, safeText: feed }
            : { cls: 'A', reason: '命令带有内嵌文字', readOnly: true, opaque: true });
    }
    if (!parsed.valid) results.push({ ...unsure(ctx, '命令语法无法可靠解析'), opaque: true });
    return mostDangerous(results);
}
