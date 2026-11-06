/** 命令分类从白名单出发，包装递归拆开；所有分支先检查路径，再决定是否允许，未知语法永不当作只读。 */
import { posix } from 'node:path';
import { C03_DEFAULTS } from '../config/defaults.js';
import { lexShell } from './shell-lexer.js';
import { classifyPath, mostDangerous, resolveGatePath, within } from './paths.js';
import type { Classification, GateContext } from './paths.js';
import { knownFindOptions, knownOptions, READ_OPTIONS } from './read-options.js';
import { classifyNetwork, paymentUrl } from './network-options.js';
const safe = (reason: string): Classification => ({ cls: 'A', reason, readOnly: true });
const external = (reason: string, subclass = 'run_command'): Classification => ({ cls: 'C', reason, subclass });
const dangerous = (reason: string): Classification => ({ cls: 'D', reason, subclass: 'high_risk' });
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
/** 外壳只负责取出被执行命令，不直接授予安全级别；陌生选项仍叠加 C。 */
function unwrap(cmd: string, args: string[]): { words?: string[]; script?: string; cwd?: string; floor?: Classification } | null {
    const shell = ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(cmd);
    if (shell) {
        let hasCommand = false, uncertain = false;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if (arg === '--') return { floor: external('shell 脚本文件不是只读命令') };
            if (!arg.startsWith('-') || arg === '-') return hasCommand ? { script: arg, floor: uncertain ? external('shell 含未知启动选项') : undefined } : { floor: external('shell 第一个操作数是脚本文件，后面的 -c 不改变它') };
            if (arg === '--norc' || arg === '--noprofile') continue;
            if (/^-[a-zA-Z]+$/.test(arg)) { hasCommand ||= arg.slice(1).includes('c'); uncertain ||= /[^clieufxvn]/.test(arg.slice(1)); continue; }
            return { floor: external('shell 启动选项无法安全解析') };
        }
        return { floor: external('shell 缺少命令正文') };
    }
    const wrappers = ['sudo', 'doas', 'env', 'xargs', 'timeout', 'nohup', 'nice', 'time', 'command', 'builtin', 'exec', 'caffeinate', 'script', 'watch', '!', 'if', 'then', 'elif', 'do', 'while', 'until'];
    if (!wrappers.includes(cmd)) return null;
    let i = 0;
    let uncertain = false, cwd: string | undefined;
    const valueOptions: Record<string, string[]> = {
        sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host'], doas: ['-u', '-C'], env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
        xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '--max-args', '--max-procs', '--replace'], timeout: ['-k', '--kill-after', '-s', '--signal'],
        nice: ['-n', '--adjustment'], time: ['-f', '-o', '--format', '--output'], caffeinate: ['-t', '-w'], watch: ['-n', '--interval'], script: ['-c', '--command'], exec: ['-a'],
    };
    while (i < args.length) {
        const arg = args[i]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && cmd === 'env') { i++; continue; }
        if (arg === '--') { i++; break; }
        if (!arg.startsWith('-') || arg === '-') break;
        const name = arg.split('=')[0]!;
        if (valueOptions[cmd]?.includes(name)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
            if (!value) return { floor: external('包装选项缺少参数') };
            if (cmd === 'env' && ['-C', '--chdir'].includes(name)) cwd = value;
            if ((cmd === 'env' && ['-S', '--split-string'].includes(name)) || (cmd === 'script' && ['-c', '--command'].includes(name))) return { script: value, floor: external('包装器会修改环境或记录文件') };
        } else if (!/^-[A-Za-z0-9]+$/.test(arg)) uncertain = true;
        i++;
    }
    if (cmd === 'timeout') i++;
    // script 的首个操作数是日志文件，后续才是程序；它本身至少 C。
    if (cmd === 'script' && args[i]) i++;
    const floor = ['sudo', 'doas'].includes(cmd) ? dangerous('提权命令永久需要审批')
        : (uncertain || ['xargs', 'script', 'watch', 'env', 'time', 'caffeinate', 'nohup'].includes(cmd)) ? external('包装器的环境、输入或写入副作用需审批') : undefined;
    return { words: args.slice(i), cwd, floor: floor ?? (args.length ? undefined : external('输出环境或包装命令缺少正文')) };
}
/** git 全局参数会改变仓库和运行行为；配置项不覆盖内层 push 的 D 级别。 */
function classifyGit(args: string[], ctx: GateContext): Classification {
    let repo = resolveGatePath('.', ctx), index = 0;
    const checks: Classification[] = [];
    while (index < args.length && args[index]!.startsWith('-')) {
        const arg = args[index++]!;
        const name = arg.split('=')[0]!;
        if (['-C', '--git-dir', '--work-tree', '-c', '--config-env'].includes(name)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index++];
            if (!value) return external('git 全局选项缺少值', 'git_write');
            if (name === '-C') repo = resolveGatePath(value, { ...ctx, cwd: repo });
            else if (name === '--work-tree' || name === '--git-dir') {
                checks.push(classifyPath(value, true, ctx, true));
                if (name === '--work-tree') repo = resolveGatePath(value, ctx);
            } else checks.push(external('git 配置可能执行外部程序', 'git_write'));
        } else checks.push(external('git 全局选项不在白名单', 'git_write'));
    }
    const operation = args[index++], tail = args.slice(index);
    if (operation === 'push' && tail.some(a => /^--(?:force|delete|mirror)(?:=|$|-)/.test(a) || /^-[^-]*[fd]/.test(a) || /^[+:]/.test(a))) checks.push(dangerous('git 强推或删除远端分支不可逆'));
    const outputs = tail.flatMap((a, i) => a.startsWith('--output=') ? [a.slice(9)] : a === '--output' && tail[i + 1] ? [tail[i + 1]!] : []);
    checks.push(...outputs.map(p => classifyPath(p, true, { ...ctx, cwd: repo })));
    if (['status', 'log', 'diff', 'show'].includes(operation ?? '')) {
        const policy = { short: 'sbpuUwn', values: 'Un', long: ['--oneline', '--stat', '--short', '--branch', '--porcelain', '--name-only', '--name-status', '--no-patch', '--patch', '--cached', '--staged', '--no-ext-diff', '--no-textconv', '--all', '--graph', '--decorate'], longValues: ['--max-count', '--format', '--pretty', '--since', '--until'] };
        checks.push(knownOptions(tail, policy) ? classifyPath(repo, false, ctx) : external('git 只读子命令含未知或执行写入选项', 'git_write'));
    } else if (operation === 'commit' && within(repo, ctx.homeDir)) checks.push({ cls: 'A', reason: '家目录内提交须核验实际 gitdir', subclass: 'internal_write', paths: [repo], gitRepos: [repo] });
    else checks.push({ ...external('git 修改仓库或远端需要审批', 'git_write'), gitRepos: ['commit', 'push'].includes(operation ?? '') ? [repo] : [] });
    return mostDangerous(checks);
}
/** 包管理只给 work 中明确的本地子命令 A；执行类递归还原，发布永久审批。 */
function classifyPackage(cmd: string, args: string[], ctx: GateContext, depth: number): Classification {
    const checks: Classification[] = [];
    let executionContext = ctx;
    const options = ['--prefix', '--dir', '--cwd', '--cache', '--store-dir', '--global-dir', '-C', '-w', '--workspace'];
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!, name = arg.split('=')[0]!;
        if (options.includes(name)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
            if (!value) checks.push(external('包管理目录参数缺失'));
            else {
                if (['--prefix', '--dir', '--cwd', '-C'].includes(name)) executionContext = { ...ctx, cwd: resolveGatePath(value, ctx) };
                if (!within(resolveGatePath(value, ctx), `${ctx.homeDir}/work`)) checks.push(external('包管理目录超出 work'), classifyPath(value, true, ctx));
            }
        } else filtered.push(arg);
    }
    if (filtered.some(a => /^(?:-g|--global|--location=global)$/.test(a))) checks.push(external('安装全局软件需要审批', 'global_install'));
    const operation = cmd === 'npx' ? 'exec' : filtered.find(a => !a.startsWith('-'));
    const opIndex = cmd === 'npx' ? -1 : filtered.indexOf(operation ?? '');
    const tail = filtered.slice(opIndex + 1).filter(a => a !== '--');
    if (['publish', 'unpublish'].includes(operation ?? '')) checks.push(dangerous('发布或撤回软件包是不可逆对外动作'));
    else if (['exec', 'x', 'dlx', 'create'].includes(operation ?? '')) {
        if (!within(resolveGatePath('.', executionContext), `${ctx.homeDir}/work`)) checks.push(external('包执行包装只在家目录 work 内免审批'));
        const c = tail.findIndex(a => a === '-c' || a === '--call');
        let child = tail;
        while (child[0]?.startsWith('-')) {
            const flag = child[0];
            checks.push(external('包执行包装选项需审批'));
            child = child.slice(['-p', '--package'].includes(flag!) && !flag!.includes('=') ? 2 : 1);
        }
        checks.push(c >= 0 && tail[c + 1] ? classifyCommand(tail[c + 1]!, executionContext, depth + 1) : classifyArgv(child, executionContext, depth + 1));
    } else if (!['install', 'i', 'ci', 'add', 'remove', 'run', 'run-script', 'test', 'build', 'list', 'ls', 'outdated', 'why'].includes(operation ?? '')) checks.push(external('包管理子命令不在本地操作白名单'));
    else {
        if (filtered.some(a => a.startsWith('-') && !['--offline', '--frozen-lockfile', '--ignore-scripts', '--save-dev', '-D', '--production', '--no-audit', '--no-fund', '-g', '--global', '--location=global'].includes(a))) checks.push(external('包管理选项未知或可能改写全局配置'));
        checks.push(within(resolveGatePath('.', ctx), `${ctx.homeDir}/work`) ? { cls: 'A', reason: 'work 内明确的本地包管理操作', subclass: 'work', paths: [resolveGatePath('.', ctx)] } : external('包管理只在家目录 work 内免审批'));
    }
    return mostDangerous(checks);
}
/** argv 不经过 shell，仍使用完全相同的递归、敏感路径和危险动作规则。 */
export function classifyArgv(words: string[], ctx: GateContext, depth = 0): Classification {
    if (depth > (ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth)) return external('命令包装递归超过四层，需审批');
    if (!words.length) return external('命令缺少程序名');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return mostDangerous([external('命令前缀环境变量需审批'), classifyArgv(words.slice(1), ctx, depth + 1)]);
    const program = words[0]!, cmd = posix.basename(program), args = words.slice(1);
    const recursive = cmd === 'rg' || cmd === 'find' || (cmd === 'grep' && args.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) || (cmd === 'ls' && args.some(a => /^-[^-]*R/.test(a) || a === '--recursive'));
    const checks = [classifyPath(program, false, ctx), classifyPath('.', false, ctx, false, recursive), ...argumentPaths(args).map(p => classifyPath(p, false, ctx, false, recursive))]
        .filter(check => cmd !== 'echo' || check.cls !== 'C');
    const pathRisk = mostDangerous(checks);
    if (pathRisk.cls === 'protected' || pathRisk.subclass === 'work_data') return pathRisk;
    if (program.includes('/') && !['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].includes(posix.dirname(program))) checks.push(external('自定义路径程序不能仅凭名字获得白名单权限'));
    const wrapper = unwrap(cmd, args);
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
        if (wrapper.words?.length) checks.push(classifyArgv(wrapper.words, wrapper.cwd ? { ...ctx, cwd: resolveGatePath(wrapper.cwd, ctx) } : ctx, depth + 1));
        return mostDangerous(checks);
    }
    let result: Classification;
    if (['env', 'printenv'].includes(cmd) || (cmd === 'set' && !args.length)) result = external('输出宿主环境变量需要审批');
    else if (['curl', 'wget'].includes(cmd)) result = classifyNetwork(cmd, args, ctx);
    else if (['http', 'httpie'].includes(cmd) && args.some(paymentUrl)) result = dangerous('支付、下单或转账 API 永久需要审批');
    else if (cmd === 'git') result = classifyGit(args, ctx);
    else if (['npm', 'pnpm', 'yarn', 'npx'].includes(cmd)) result = classifyPackage(cmd, args, ctx, depth);
    else if ((['aws', 'gcloud', 'az'].includes(cmd) && args.some(a => /^(delete|remove|terminate|destroy|rm)/i.test(a))) || (cmd === 'gh' && args[0] === 'repo' && args[1] === 'delete') || (cmd === 'kubectl' && args.includes('delete'))) result = dangerous('删除远端资源不可逆');
    else if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'rimraf'].includes(cmd)) {
        const targets = args.filter(a => !a.startsWith('-'));
        if (targets.some(p => within(ctx.homeDir, resolveGatePath(p, ctx)) || within(`${ctx.homeDir}/memory/journal`, resolveGatePath(p, ctx)))) result = { cls: 'protected', reason: '不能删除包含身份、心智视图或历史日志的目录' };
        else if (targets.some(p => !within(resolveGatePath(p, ctx), ctx.homeDir))) result = dangerous('删除家目录以外的内容属于不可逆动作');
        else result = targets.length ? mostDangerous(targets.map(p => classifyPath(p, true, ctx, true))) : external('删除命令缺少明确目标');
    } else if (cmd === 'find') {
        const special: Classification[] = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if (/^-fprint|^-fls$/.test(arg)) special.push(external('find 包含写入选项'), classifyPath(args[i + 1] ?? '$UNKNOWN', true, ctx));
            if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
                const end = args.findIndex((a, n) => n > i && [';', '+'].includes(a));
                special.push(external('find 执行子命令需审批'), classifyArgv(args.slice(i + 1, end < 0 ? undefined : end), ctx, depth + 1));
            }
            if (arg === '-delete') special.push(external('find 删除需要审批'), classifyArgv(['rm', args.find(a => !a.startsWith('-')) ?? '.'], ctx, depth + 1));
        }
        result = special.length ? mostDangerous(special) : knownFindOptions(args) ? safe('find 只读选项白名单') : external('find 含未知选项');
    } else if (READ_OPTIONS[cmd]) {
        // BSD date 的 -f 未配 -j 会设置时间，-d 还会改内核 DST；不能套用 GNU 的只读含义。
        const dateNoSet = args.some(a => /^-[^-]*j/.test(a));
        const dateSafe = !args.some(a => /^-[^-]*d/.test(a))
            && (!args.some(a => /^-[^-]*f/.test(a) || /^\d{4,}/.test(a)) || dateNoSet);
        const bounded = (cmd !== 'xxd' || args.filter(a => !a.startsWith('-')).length <= 1)
            && (cmd !== 'date' || dateSafe);
        result = bounded && knownOptions(args, READ_OPTIONS[cmd]!) ? safe('只读程序及参数白名单') : external('只读程序含未知选项或写入操作数');
    } else if (['node', 'python', 'python3', 'ruby', 'perl'].includes(cmd)) {
        const script = args[0];
        result = script && !script.startsWith('-') && within(resolveGatePath(script, ctx), ctx.homeDir)
            ? { cls: 'A', reason: '运行家目录内明确脚本', subclass: 'internal_script', paths: [resolveGatePath(script, ctx)] }
            : external('内联代码或不明确的脚本需要审批');
    } else if (['mkdir', 'touch', 'cp', 'mv', 'tee', 'chmod', 'chown'].includes(cmd)) {
        const values = args.filter(a => !a.startsWith('-'));
        const targets = ['cp', 'mv'].includes(cmd) ? values.slice(-1) : ['chmod', 'chown'].includes(cmd) ? values.slice(1) : values;
        const options = { short: cmd === 'cp' || cmd === 'mv' ? 'Rrfpivn' : cmd === 'mkdir' ? 'pv' : cmd === 'touch' ? 'acm' : cmd === 'tee' ? 'ai' : 'Rf', long: ['--parents', '--recursive', '--force', '--verbose', '--append'] };
        if (!knownOptions(args, options) || !targets.length) result = external('写入选项或目标不能安全确定');
        else if (cmd === 'mv' && values.slice(0, -1).some(p => within(ctx.homeDir, resolveGatePath(p, ctx)) || within(`${ctx.homeDir}/memory/journal`, resolveGatePath(p, ctx)))) result = { cls: 'protected', reason: '不能搬走包含受保护文件的目录' };
        else {
            const sources = ['cp', 'mv'].includes(cmd) ? values.slice(0, -1) : [];
            // 纯分类器无法确认目标是文件还是目录，两种解释都检查，避免 cp work/AGENTS.md . 隐式改写身份。
            // 只推导这一层的最终文件名，不读取磁盘或扫描目录；普通 hello.txt 仍保留家内 A 类。
            const directoryTargets = sources.flatMap(source => targets.map(target =>
                posix.join(resolveGatePath(target, ctx), posix.basename(resolveGatePath(source, ctx)))));
            result = mostDangerous([...sources.map(p => classifyPath(p, cmd === 'mv', ctx, true)),
                ...targets.map(p => classifyPath(p, true, ctx, true)), ...directoryTargets.map(p => classifyPath(p, true, ctx, true))]);
        }
    } else if (['brew', 'pip', 'pip3'].includes(cmd)) result = external('安装软件需要审批', 'global_install');
    else if (['defaults', 'launchctl', 'crontab'].includes(cmd)) result = external('修改系统设置需要审批', 'system_settings');
    else if (['lark-cli', 'osascript', 'open', 'say', 'mail'].includes(cmd)) result = external('调用外部应用或发送消息需要审批', 'send_message');
    else result = external('未识别的命令需要审批');
    // 复盘可以写 work 与记忆，但运行任意脚本不能证明只改这些允许区域。
    if (ctx.reflection && result.cls === 'A' && result.subclass === 'internal_script') result = { cls: 'protected', reason: '复盘回合禁止运行无法确定副作用的脚本' };
    return mostDangerous([...checks, result]);
}
/** 分段后追踪 cd，并检查所有重定向；不确定展开仍保守 C，已知危险子段保留更高级别。 */
export function classifyCommand(command: string, ctx: GateContext, depth = 0): Classification {
    if (depth > (ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth)) return external('命令包装递归超过四层，需审批');
    const parsed = lexShell(command, depth, ctx.maxCommandDepth ?? C03_DEFAULTS.maxCommandDepth);
    const contexts: GateContext[] = [ctx], results: Classification[] = [];
    for (const part of parsed.parts) {
        for (const current of [...contexts]) {
            results.push(classifyArgv(part.words, current, depth), ...part.redirects.map(r => {
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
        if (part.dynamic) results.push(external('动态展开的最终参数无法静态确认'));
    }
    if (!parsed.valid) results.push(external('命令语法无法可靠解析'));
    return mostDangerous(results);
}
