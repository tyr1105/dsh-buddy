/**
 * 路径边界先展开宿主家目录和已知变量，再统一按不区分大小写的目录段检查；敏感数据无论读写都拒绝。
 *
 * P69（审批跟着 DSH 沙箱走）在这里加了三样东西：
 * - 分类上下文多了 sandboxed、tmpDirs、projectDirs 三个可选字段，不传时和原来完全一样；
 * - 宿主确认沙箱开着时，写入只认「家目录」和「临时目录」两处：别处 DSH 的沙箱本来就会拦，
 *   所以标上 blocked，让守卫直接指路，不再发一张批了也没用的审批卡；
 * - 合并多个判定时记下「一共有哪几件事要主人确认」（asks），审批卡的话和指路判断都从这里取。
 * 敏感路径、受保护路径、工作数据三道硬拦永远排在最前面，这张卡一条都没有放松。
 */
import { posix } from 'node:path';
import { PROJECT_CONTEXT_FILE } from '../project/context.js';
import type { AskHint } from '../model/outreach.js';
export interface GateContext {
    homeDir: string;
    ownerHome?: string;
    /** 安全解析深度由宿主配置，不能超过协议上限。 */
    maxCommandDepth?: number;
    sharedDir: string;
    rootDir: string;
    workDataAllowed: boolean;
    workDataPaths?: string[];
    cwd?: string;
    reflection?: boolean;
    autonomy?: string;
    /** P69：宿主确认这条会话此刻在 workspace-write 沙箱里。缺省等于没确认，一律按旧规则保守处理。 */
    sandboxed?: boolean;
    /** P69：沙箱里可写的临时目录（真实路径）。只在 sandboxed 为真时才生效，缺省为空。 */
    tmpDirs?: string[];
    /** P69：这位队友作为成员（含负责人）的、没有归档的项目的项目目录。缺省为空。 */
    projectDirs?: string[];
    /**
     * P74r16a：中心根目录的真实路径（启动时取一次，只在运行时上下文里，不写进设置、不落盘）。
     * 只在它与设置里的写法 rootDir 不同时才有值（主人把数据目录放在符号链接后面）：
     * DSH 报来的工作目录是真实路径，resolveGatePath 会把落在它下面的目标换回设置里的写法，之后所有判断都不用各自处理。
     */
    realRootDir?: string;
}
export type ToolActionClass = 'A' | 'B' | 'C' | 'D' | 'protected';
/** 一件要主人确认的事：合并判定时逐条保留，审批卡据此把每件事都说出来，不会只报其中一件。 */
export interface Ask {
    cls: 'C' | 'D';
    reason: string;
    subclass?: string;
    /** 给审批卡用的对象，已经清洗过（域名、远端和分支、程序名）。 */
    detail?: string;
    /** 网络命令只是把内容取回来存成文件，没有往外发数据。 */
    download?: boolean;
    /** 这件事要确认的唯一原因是「目标在沙箱之外」，DSH 自己会拦。 */
    blocked?: boolean;
    paths?: string[];
    /** A-4（S13）：说法标记，让审批卡对几类没有专门子类的命令也能说人话；不影响类别。 */
    hint?: AskHint;
    /** A-4（S4）：这一件之后还有几件因条数上限没存下来（只有最后一条会带）。 */
    moreAfter?: number;
}
export interface Classification {
    cls: ToolActionClass;
    reason: string;
    subclass?: string;
    readOnly?: boolean;
    paths?: string[];
    writePaths?: string[];
    /** 纯分类器不读磁盘；实际守卫须核验这些仓库的 gitdir。 */
    gitRepos?: string[];
    /** P69：给审批卡用的对象（已清洗）。 */
    detail?: string;
    /** P69：网络命令只是下载，没有往外发数据；只影响审批卡的话，不影响类别。 */
    download?: boolean;
    /**
     * P69：要确认的原因只是「写入或删除的目标在沙箱之外」。
     * 单项判定上表示这一项如此；合并结果上表示「所有要确认的事都如此」，守卫只在这种情况下指路。
     */
    blocked?: boolean;
    /** P69：命令里有内联代码、here-document 或无法解析的部分；只用来触发原文里的凭据字样检查。 */
    opaque?: boolean;
    /** A-4（S13）：说法标记，见 Ask.hint。 */
    hint?: AskHint;
    /** P69：合并后全部要主人确认的事（C 和 D）：D 排在最前，同类按出现顺序，去重。 */
    asks?: Ask[];
    /**
     * P69 A-3（R10）：命令里只是被 cat、tee 写进文件（或直接显示在屏幕上）的 here-document、here-string 正文。
     * 它不会被当成代码执行，所以做原文凭据字样检查时要先把这些文字拿掉，免得 .gitignore 里的一行 .env 被当成碰凭据。
     */
    safeText?: string[];
}
/**
 * 路径别名规范化（P69 A-3 的 tmpAlias，P74r16a 推广为所有路径比较共用）。
 * macOS 上 /tmp、/var、/etc 其实是指向 /private/tmp、/private/var、/private/etc 的链接，同一个位置有两种写法：
 * 中心记的家目录可能是 /var/… 写法，DSH 报来的工作目录是真实路径 /private/var/…。
 * 这里只做字符串变换（守卫是同步执行的，不能读磁盘）：把短写法换成真实写法。
 */
export function tmpAlias(path: string): string {
    return path.replace(/^\/(?:tmp|var|etc)(?=\/|$)/i, match => `/private${match.toLowerCase()}`);
}
/**
 * macOS 默认大小写不敏感；比较时折叠，实际执行仍保留原始文件名。
 * 折叠时同时做别名规范化：within、isSensitive、isProtected、isProtectedAncestor 等所有比较都经过这里，
 * 所以家目录、共享目录、项目目录、受保护位置、系统目录的判断一起认得两种写法，不会只改其中几处。
 */
const folded = (path: string): string => tmpAlias(posix.normalize(path)).normalize('NFC').toLowerCase();
/** 两个路径是不是同一个位置（别名与大小写折叠之后相同）。 */
export function samePlace(a: string, b: string): boolean {
    return folded(a) === folded(b);
}
/**
 * 中心根目录在符号链接后面时：目标落在真实路径下，就换成设置里的写法（rootDir）。
 * 不在真实路径下、或没有 realRootDir（真实路径与设置写法相同，或取不到）时原样返回。纯字符串处理。
 */
export function toCenterForm(path: string, ctx: Pick<GateContext, 'rootDir' | 'realRootDir'>): string {
    const real = ctx.realRootDir?.replace(/\/+$/, '');
    if (!real || !path.startsWith('/') || !within(path, real)) return path;
    // P74r17（低-2）：within 比较时做了 NFC 折叠，这里按长度截取尾部之前两边也要先做 NFC，
    // 否则真实路径与目标的 Unicode 规范形式不同（分解形式与合成形式）时，截取位置错位、结果里多出一级目录。
    const tail = tmpAlias(posix.normalize(path.normalize('NFC'))).slice(tmpAlias(posix.normalize(real.normalize('NFC'))).length);
    return posix.join(ctx.rootDir, tail);
}
/** 根目录也是合法祖先，不能因拼成双斜杠漏过递归读。 */
export function within(path: string, root: string): boolean {
    const p = folded(path), r = folded(root);
    return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}
/** 展开已知变量，未知变量和其他用户的 ~user 保留为不确定路径，后续至少审批。 */
export function resolveGatePath(input: string, ctx: GateContext): string {
    let path = input;
    if (/^file:\/\//i.test(path)) {
        try { const url = new URL(path); path = decodeURIComponent(url.pathname); if (url.hostname && url.hostname !== 'localhost') return input; }
        catch { return input; }
    }
    // P69 A-3（R7）：沙箱开着时，$PWD、${PWD} 按当前目录先展开，不然 "$PWD/memory/journal/x" 会被当成「位置不确定」放过去。
    if (ctx.sandboxed === true && /\$(?:\{PWD\}|PWD\b)/.test(path)) {
        const base = ctx.cwd && ctx.cwd !== input ? resolveGatePath(ctx.cwd, { ...ctx, cwd: undefined }) : ctx.homeDir;
        path = path.replace(/\$(?:\{PWD\}|PWD\b)/g, base);
    }
    path = path.replace(/\$(?:\{DSH_HOME\}|DSH_HOME\b)/g, ctx.ownerHome ? `${ctx.ownerHome}/.dsh` : '~/.dsh');
    path = path.replace(/\$(?:\{HOME\}|HOME\b)/g, ctx.ownerHome ?? '~');
    if (path === '~' || path.startsWith('~/')) {
        if (!ctx.ownerHome) return path;
        path = ctx.ownerHome + path.slice(1);
    }
    if (path.startsWith('~') || /\$|`|__dynamic__/.test(path)) return path;
    const cwd = ctx.cwd && ctx.cwd !== input ? resolveGatePath(ctx.cwd, { ...ctx, cwd: undefined }) : ctx.homeDir;
    if (cwd.startsWith('~') || /\$|`/.test(cwd)) return `${cwd}/${path}`;
    // P74r16a：解析出的绝对路径若落在中心根目录的真实路径下，换回设置里的写法，后面所有判断用同一种写法。
    return toCenterForm(posix.resolve(cwd, path), ctx);
}
/** 路径里还留着没法展开的变量、别人的 ~user 或命令替换：静态看不出它最后落在哪。 */
export function isUnresolvedPath(path: string): boolean {
    return path.startsWith('~') || /\$|`|__dynamic__|^file:/i.test(path);
}
/** 目录段与凭据文件名都检查，避免换家目录、工具或字母大小写后绕过。 */
export function isSensitive(path: string): boolean {
    const p = folded(path);
    return /(^|\/)\.(?:dsh|ssh|aws|claude)(?:\/|$)/.test(p)
        || /(^|\/)\.config\/gcloud(?:\/|$)/.test(p)
        || /(^|\/)\.codex\/auth\.json(?:\/|$)/.test(p)
        || /(^|\/)\.netrc(?:\/|$)/.test(p)
        || /(^|\/)library\/(?:keychains|application support\/google\/chrome)(?:\/|$)/.test(p)
        || p.split('/').some(name => /^\.env(?:\..*)?$/.test(name) || /\.(?:pem|key)$/.test(name)
            || /^id_rsa/.test(name) || /^credentials.*\.(?:json|yaml)$/.test(name));
}
/** 中心状态不能被直接改写；读取普通身份文件仍按正常只读规则。 */
export function isProtected(path: string, ctx: GateContext): boolean {
    if (folded(path) === folded(`${ctx.rootDir}/AGENTS.md`) || within(path, `${ctx.rootDir}/.hub`)) return true;
    const homes = [ctx.homeDir];
    if (within(path, `${ctx.rootDir}/bots`)) {
        const id = folded(path).slice(folded(`${ctx.rootDir}/bots`).length + 1).split('/')[0];
        if (id) homes.push(`${ctx.rootDir}/bots/${id}`);
    }
    return homes.some(home => folded(path) === folded(`${home}/AGENTS.md`) || within(path, `${home}/mind`) || within(path, `${home}/memory/journal`));
}
/**
 * P75e：中心维护的三处（技能目录、playbooks、长期记忆正文），包括别的员工家目录里的（判断方法同 isProtected）。
 * 写入被拒绝且不计越界（以前允许写，旧会话照旧写不是有意越界）；读取不受影响。
 */
export function isHubManaged(path: string, ctx: GateContext): boolean {
    const homes = [ctx.homeDir];
    if (within(path, `${ctx.rootDir}/bots`)) {
        const id = folded(path).slice(folded(`${ctx.rootDir}/bots`).length + 1).split('/')[0];
        if (id) homes.push(`${ctx.rootDir}/bots/${id}`);
    }
    // P75r3：除了三处的里面，还认三个精确路径本身：{家目录}/.agents、.agents/skills、playbooks。
    // 把 .agents 整个移走、换成符号链接、删掉再换一个，写入的对象正是它本身，不在「里面」；只认恰好等于，
    // 不认家目录本身和更上级，所以 cd 家目录 && git add .、ls .agents、读取都不受影响。
    // folded 已把相对写法、.. 、多余斜杠、末尾斜杠、大小写归一（调用方先经 resolveGatePath 展开）。
    return homes.some(home => within(path, `${home}/.agents/skills`) || within(path, `${home}/playbooks`)
        || folded(path) === folded(`${home}/.agents`)
        || folded(path) === folded(`${home}/memory/MEMORY.md`));
}
/** 路径里展不开的变量写法：$X、${X}、$1、命令替换留下的占位。 */
const VARIABLE_TOKEN = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|__dynamic__|`[^`]*`/g;
/**
 * P69 A-3（R7）：含展不开的变量的路径，去掉变量之后剩下的写死部分，会不会落在中心管理的位置。
 * 变量可能展开成家目录、中心根目录或当前目录，所以每一段写死的文字都分别接到这三处后面，用现有的 isProtected 判断，
 * 不另写一份名单。拿不准就算会（宁可多问一次）。
 */
export function unresolvedTouchesProtected(path: string, ctx: GateContext): boolean {
    const bases = [ctx.homeDir, ctx.rootDir, ctx.cwd && !isUnresolvedPath(ctx.cwd) ? ctx.cwd : ctx.homeDir];
    return path.split(VARIABLE_TOKEN).map(piece => piece.replace(/^~[^/]*/, '')).filter(piece => piece.replace(/\//g, '') !== '')
        // P74r17（低-1）：每个候选路径先经 toCenterForm 换成设置写法再判断（中心根目录在符号链接后面时，
        // 写死的片段可能是真实路径写法，直接交给 isProtected 会与设置写法的结果不一致）。
        .some(piece => [piece, ...bases.map(base => posix.join(base, piece))].some(candidate => candidate.startsWith('/') && isProtected(toCenterForm(candidate, ctx), ctx)));
}
/**
 * 中心管理的位置里，落在队友家目录里面的那几处：身份文件、心智视图、历史日志。
 * 中心根目录下的 AGENTS.md 和 .hub 不在这里，它们不在家目录里面。
 */
function protectedLocationsInHome(ctx: GateContext): string[] {
    return [`${ctx.homeDir}/AGENTS.md`, `${ctx.homeDir}/mind`, `${ctx.homeDir}/memory/journal`];
}
/**
 * P69 A-3b（总控 T1 裁定）：这个路径是不是「家目录里面、受保护位置的上级」。
 * 按现在的受保护位置，只有 memory 这一层算（memory/journal 的上级）。
 * 家目录本身、. 解析到家目录、家目录的上级、主人家目录、中心根目录一律不算：
 * 队友天天会写 cd 目录 && eslint . 、git add . 、tree . 这类命令，把它们都拦下来会让审批卡变成噪音。
 * 兜底理由：AGENTS.md 和 mind/ 在回合结束有核对恢复；memory/journal/ 的兜底是看板 I27（回合结束核对）；
 * 内联代码本来就能改这些文件，闸这一侧只拦直白写法，不为此误拦日常命令。
 */
export function isProtectedAncestor(path: string, ctx: GateContext): boolean {
    if (isUnresolvedPath(path) || !within(path, ctx.homeDir) || folded(path) === folded(ctx.homeDir)) return false;
    return protectedLocationsInHome(ctx).some(location => within(location, path));
}
/** 递归搜索工作目录的祖先同样会读取工作数据，不能只看目标是否在子树里。 */
export function workDataDenied(path: string, ctx: GateContext, recursive = false): boolean {
    return !ctx.workDataAllowed && (ctx.workDataPaths ?? []).some(raw => {
        const root = resolveGatePath(raw, { ...ctx, cwd: undefined });
        return within(path, root) || (recursive && within(root, path));
    });
}
/** 这个路径落在哪个项目目录里；不在任何一个里返回 undefined。 */
export function projectDirOf(path: string, ctx: GateContext): string | undefined {
    return (ctx.projectDirs ?? []).find(dir => within(path, dir));
}
/** 临时目录是不是「某个要保护的位置的上级」（中心根目录及其真实路径、队友家目录、主人家目录）：是的话它不能当临时目录用，否则会把整片范围放开。 */
function tmpDirCoversAnchor(dir: string, ctx: GateContext): boolean {
    return [ctx.rootDir, ctx.homeDir, ...(ctx.ownerHome ? [ctx.ownerHome] : []), ...(ctx.realRootDir ? [ctx.realRootDir] : [])].some(anchor => within(tmpAlias(anchor), tmpAlias(dir)));
}
/** 沙箱里可写的临时目录：只有宿主确认沙箱开着时才算数，否则临时目录照旧按旧规则判。 */
export function inSandboxTmp(path: string, ctx: GateContext): boolean {
    return ctx.sandboxed === true
        && (ctx.tmpDirs ?? []).some(dir => within(tmpAlias(path), tmpAlias(dir)) && !tmpDirCoversAnchor(dir, ctx));
}
/**
 * 项目目录里由中心维护的文件（项目共享上下文正文）。
 * 它的修改要经主人采纳，所以不跟着「项目文件夹成员直接放」一起放开，照旧要主人确认。
 */
export function isCenterProjectFile(path: string, projectDir: string): boolean {
    return folded(path) === folded(posix.join(projectDir, PROJECT_CONTEXT_FILE));
}
const SYSTEM_ROOTS = ['/etc', '/System', '/Library', '/usr', '/bin', '/sbin', '/var', '/private/etc', '/private/var'];
/** 文件读写共用边界；未知路径不降为只读 A，复盘仍可写自己的可撤销工作文件。 */
export function classifyPath(input: string, write: boolean, ctx: GateContext, _ordinaryHomeWrite = false, recursive = false): Classification {
    const path = resolveGatePath(input, ctx);
    // 三道硬拦永远最先：凭据、中心管理的文件、未授权的工作数据。沙箱开不开都一样。
    if (isSensitive(path)) return { cls: 'protected', reason: '敏感凭据路径禁止读取或改写', paths: [path] };
    if (write && isProtected(path, ctx)) return { cls: 'protected', reason: '中心管理的身份、心智视图和历史日志不能直接改写', paths: [path] };
    // P75e：中心维护的技能库三处写入一律拒绝，但不计越界（subclass 供守卫区分）；读取不受影响。
    if (write && isHubManaged(path, ctx)) {
        return { cls: 'protected', reason: '技能库由中心维护：经验在复盘时用 hub_skill 提交，核对通过后写入。', subclass: 'skill_dir_readonly', paths: [path] };
    }
    if (workDataDenied(path, ctx, recursive)) return { cls: 'D', reason: '尚未允许访问工作数据目录', subclass: 'work_data', paths: [path] };
    const sandbox = ctx.sandboxed === true;
    if (isUnresolvedPath(path)) {
        // 沙箱开着：位置不确定的路径交给沙箱去限制写入范围，不再问人。
        // 复盘回合是只读回合，不享受这条放宽，照旧按「要审批」处理（守卫会直接拒绝）。
        // 例外（R7）：去掉变量之后剩下的写死部分落在中心管理的位置（memory/journal、AGENTS.md、mind/ 等）时，
        // 不能交给沙箱，因为这些位置在家目录里、沙箱挡不住，保持旧规则的 C。
        if (sandbox && ctx.reflection !== true) {
            if (write && unresolvedTouchesProtected(path, ctx)) return { cls: 'C', reason: '路径含变量，可能指向中心管理的文件，需审批', subclass: 'write_file', paths: [path] };
            return { cls: 'A', reason: '路径含未知变量，由沙箱限制写入范围', subclass: 'sandboxed_exec', paths: [path] };
        }
        return { cls: 'C', reason: '路径含未知变量或无法确定的家目录，需审批', subclass: write ? 'write_file' : 'read_file', paths: [path] };
    }
    if (!write) return { cls: 'A', reason: '只读操作', readOnly: true, paths: [path] };
    const memory = folded(path) === folded(`${ctx.homeDir}/memory/MEMORY.md`) || folded(path) === folded(`${ctx.homeDir}/MEMORY.md`);
    const inHome = within(path, ctx.homeDir), inShared = within(path, ctx.sharedDir);
    const inSystem = SYSTEM_ROOTS.some(root => within(path, root));
    const projectDir = projectDirOf(path, ctx);
    // 普通文件在整个家目录内都可撤销写入；保护与敏感边界已优先检查，不再依赖调用工具的名单。
    // 保留旧的第四个参数位置，避免递归读取调用的第五个参数发生错位；L0 仍按子类限制写入。
    const homeWrite = (): Classification => ({ cls: 'A', reason: '在家目录或共享目录内进行可撤销写入',
        subclass: memory ? 'memory' : within(path, `${ctx.homeDir}/work`) ? 'work' : 'internal_write', paths: [path] });
    if (sandbox) {
        // 沙箱里队友自己的工具只写得进两处：家目录和临时目录。临时目录要排在系统目录之前判断，
        // 因为 macOS 的临时目录就在 /private/var/folders/…/T 下面。
        if (inHome) return homeWrite();
        if (inSandboxTmp(path, ctx)) return { cls: 'A', reason: '写入沙箱里可写的临时目录', subclass: 'tmp', paths: [path] };
        // 其余位置都在沙箱之外，DSH 会拦。标上 blocked，守卫据此指路；类别照旧，D 仍然记越界。
        if (projectDir !== undefined) return { cls: 'C', reason: '项目文件夹在你的工作区之外，不能用自己的工具直接写', subclass: 'write_file', blocked: true, paths: [path] };
        if (inShared) return { cls: 'C', reason: '共享目录在你的工作区之外，不能用自己的工具直接写', subclass: 'write_file', blocked: true, paths: [path] };
        if (inSystem) return { cls: 'D', reason: '写入系统目录属于高风险动作', subclass: 'system_write', blocked: true, paths: [path], hint: 'system_write' };
        return { cls: 'C', reason: '写入家目录或共享目录以外的文件', subclass: 'write_file', blocked: true, paths: [path] };
    }
    // 以下是没确认沙箱时的旧规则。项目目录只有上下文里带了才参与判断（经中心代写的出站动作会带）。
    if (inSystem && !inHome && !inShared && projectDir === undefined) return { cls: 'D', reason: '写入系统目录属于高风险动作', subclass: 'system_write', paths: [path], hint: 'system_write' };
    if (inHome || inShared) return homeWrite();
    // 成员往自己项目的项目文件夹里放东西不用审批；中心维护的上下文正文除外。
    if (projectDir !== undefined && !isCenterProjectFile(path, projectDir)) return { cls: 'A', reason: '写入自己所在项目的项目文件夹', subclass: 'project_file', paths: [path] };
    return { cls: 'C', reason: '写入家目录或共享目录以外的文件', subclass: 'write_file', paths: [path] };
}
/** 把一项判定展开成「要主人确认的事」：合并过的直接取清单，单项的 C、D 自己就是一件。 */
export function asksOf(item: Classification): Ask[] {
    if (item.asks?.length) return item.asks;
    if (item.cls !== 'C' && item.cls !== 'D') return [];
    return [{ cls: item.cls, reason: item.reason,
        ...(item.subclass === undefined ? {} : { subclass: item.subclass }), ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.download === true ? { download: true } : {}), ...(item.blocked === true ? { blocked: true } : {}),
        ...(item.paths?.length ? { paths: item.paths } : {}), ...(item.hint === undefined ? {} : { hint: item.hint }) }];
}
/** 同为 A 类时，P69 新增的三个子类压过其他子类：这样 L0 和复盘回合看到的永远是最需要小心的那个。 */
const A_PRIORITY: Record<string, number> = { tmp: 1, project_file: 1, sandboxed_exec: 2 };
const aPriority = (item: Classification): number => A_PRIORITY[item.subclass ?? ''] ?? 0;
/** 要确认的事最多保留这么多条，防止一条超长命令把判定结果撑大。 */
const ASK_LIMIT = 24;
/** 合并保留所有路径和待核验仓库，工作数据禁令不会被同等级高风险命令覆盖。 */
export function mostDangerous(items: Classification[]): Classification {
    const rank: Record<ToolActionClass, number> = { A: 0, B: 1, C: 2, D: 3, protected: 4 };
    // P75r3：同为 protected 时，不是「技能库只读」的优先（它要计越界）：一条命令里先写一处技能库、再写 AGENTS.md，
    // 不能借前者躲开越界计数；只写技能库的命令不受影响（没有别的 protected 项）。
    const countsViolation = (item: Classification): boolean => item.cls === 'protected' && item.subclass !== 'skill_dir_readonly';
    const selected = items.reduce((a, b) => rank[b.cls] > rank[a.cls] || (rank[b.cls] === rank[a.cls] && (b.subclass === 'work_data' || (a.readOnly === true && b.readOnly !== true)
        || (b.cls === 'protected' && countsViolation(b) && !countsViolation(a))
        || (b.cls === 'A' && b.readOnly !== true && aPriority(b) > aPriority(a)))) ? b : a, { cls: 'A', reason: '未产生对外动作', readOnly: true } as Classification);
    // 逐条收集要主人确认的事并去重：同一件事在不同工作目录下各判一次，只算一件。
    const all: Ask[] = [];
    const seen = new Set<string>();
    // 「是否全部只因为目标在沙箱外」要看每一条，不能受下面条数上限的影响。
    let anyAsk = false, allBlocked = true, carried = 0;
    for (const { moreAfter, ...ask } of items.flatMap(asksOf)) {
        carried += moreAfter ?? 0;
        anyAsk = true;
        if (ask.blocked !== true) allBlocked = false;
        const key = JSON.stringify([ask.cls, ask.subclass ?? '', ask.reason, ask.detail ?? '', ask.blocked === true, ask.download === true, ask.paths ?? [], ask.hint ?? '']);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(ask);
    }
    // A-4（S4）：超过条数上限时先留 D 再留 C，不能让前面堆的几件 C 把最要紧的 D 挤出去；
    // 被丢掉的件数记在最后一条上（moreAfter），让那句话说得出「等 N 件」。
    const ordered = [...all.filter(ask => ask.cls === 'D'), ...all.filter(ask => ask.cls !== 'D')];
    const asks = ordered.slice(0, ASK_LIMIT).map(ask => ({ ...ask }));
    const omitted = carried + Math.max(0, ordered.length - ASK_LIMIT);
    if (omitted > 0 && asks.length) asks[asks.length - 1]!.moreAfter = omitted;
    const { blocked: _blocked, opaque: _opaque, asks: _asks, safeText: _safeText, hint: _hint, ...rest } = selected;
    return { ...rest, readOnly: items.every(item => item.readOnly === true), paths: [...new Set(items.flatMap(item => item.paths ?? []))],
        writePaths: [...new Set(items.flatMap(item => item.writePaths ?? (item.readOnly ? [] : item.paths ?? [])))], gitRepos: [...new Set(items.flatMap(item => item.gitRepos ?? []))],
        asks,
        // 只有「每一件要确认的事都只是因为目标在沙箱外」才算 blocked；混进别的对外动作就走原来的审批。
        ...(anyAsk && allBlocked ? { blocked: true } : {}),
        ...(items.some(item => item.opaque === true) ? { opaque: true } : {}),
        ...(items.some(item => item.safeText?.length) ? { safeText: [...new Set(items.flatMap(item => item.safeText ?? []))] } : {}) };
}
