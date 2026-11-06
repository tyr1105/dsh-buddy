/** 路径边界先展开宿主家目录和已知变量，再统一按不区分大小写的目录段检查；敏感数据无论读写都拒绝。 */
import { posix } from 'node:path';
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
}
export type ToolActionClass = 'A' | 'B' | 'C' | 'D' | 'protected';
export interface Classification {
    cls: ToolActionClass;
    reason: string;
    subclass?: string;
    readOnly?: boolean;
    paths?: string[];
    writePaths?: string[];
    /** 纯分类器不读磁盘；实际守卫须核验这些仓库的 gitdir。 */
    gitRepos?: string[];
}
/** macOS 默认大小写不敏感；比较时折叠，实际执行仍保留原始文件名。 */
const folded = (path: string): string => posix.normalize(path).normalize('NFC').toLowerCase();
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
    path = path.replace(/\$(?:\{DSH_HOME\}|DSH_HOME\b)/g, ctx.ownerHome ? `${ctx.ownerHome}/.dsh` : '~/.dsh');
    path = path.replace(/\$(?:\{HOME\}|HOME\b)/g, ctx.ownerHome ?? '~');
    if (path === '~' || path.startsWith('~/')) {
        if (!ctx.ownerHome) return path;
        path = ctx.ownerHome + path.slice(1);
    }
    if (path.startsWith('~') || /\$|`|__dynamic__/.test(path)) return path;
    const cwd = ctx.cwd && ctx.cwd !== input ? resolveGatePath(ctx.cwd, { ...ctx, cwd: undefined }) : ctx.homeDir;
    if (cwd.startsWith('~') || /\$|`/.test(cwd)) return `${cwd}/${path}`;
    return posix.resolve(cwd, path);
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
/** 递归搜索工作目录的祖先同样会读取工作数据，不能只看目标是否在子树里。 */
export function workDataDenied(path: string, ctx: GateContext, recursive = false): boolean {
    return !ctx.workDataAllowed && (ctx.workDataPaths ?? []).some(raw => {
        const root = resolveGatePath(raw, { ...ctx, cwd: undefined });
        return within(path, root) || (recursive && within(root, path));
    });
}
/** 文件读写共用边界；未知路径不降为只读 A，复盘仍可写自己的可撤销工作文件。 */
export function classifyPath(input: string, write: boolean, ctx: GateContext, _ordinaryHomeWrite = false, recursive = false): Classification {
    const path = resolveGatePath(input, ctx);
    if (isSensitive(path)) return { cls: 'protected', reason: '敏感凭据路径禁止读取或改写', paths: [path] };
    if (write && isProtected(path, ctx)) return { cls: 'protected', reason: '中心管理的身份、心智视图和历史日志不能直接改写', paths: [path] };
    if (workDataDenied(path, ctx, recursive)) return { cls: 'D', reason: '尚未允许访问工作数据目录', subclass: 'work_data', paths: [path] };
    if (path.startsWith('~') || /\$|`|__dynamic__|^file:/i.test(path)) return { cls: 'C', reason: '路径含未知变量或无法确定的家目录，需审批', subclass: write ? 'write_file' : 'read_file', paths: [path] };
    if (!write) return { cls: 'A', reason: '只读操作', readOnly: true, paths: [path] };
    const memory = folded(path) === folded(`${ctx.homeDir}/memory/MEMORY.md`) || folded(path) === folded(`${ctx.homeDir}/MEMORY.md`);
    const system = ['/etc', '/System', '/Library', '/usr', '/bin', '/sbin', '/var', '/private/etc', '/private/var'];
    if (system.some(root => within(path, root)) && !within(path, ctx.homeDir) && !within(path, ctx.sharedDir)) return { cls: 'D', reason: '写入系统目录属于高风险动作', subclass: 'system_write', paths: [path] };
    // 普通文件在整个家目录内都可撤销写入；保护与敏感边界已优先检查，不再依赖调用工具的名单。
    // 保留旧的第四个参数位置，避免递归读取调用的第五个参数发生错位；L0 仍按子类限制写入。
    if (within(path, ctx.homeDir) || within(path, ctx.sharedDir)) {
        return { cls: 'A', reason: '在家目录或共享目录内进行可撤销写入', subclass: memory ? 'memory' : within(path, `${ctx.homeDir}/work`) ? 'work' : 'internal_write', paths: [path] };
    }
    return { cls: 'C', reason: '写入家目录或共享目录以外的文件', subclass: 'write_file', paths: [path] };
}
/** 合并保留所有路径和待核验仓库，工作数据禁令不会被同等级高风险命令覆盖。 */
export function mostDangerous(items: Classification[]): Classification {
    const rank: Record<ToolActionClass, number> = { A: 0, B: 1, C: 2, D: 3, protected: 4 };
    const selected = items.reduce((a, b) => rank[b.cls] > rank[a.cls] || (rank[b.cls] === rank[a.cls] && (b.subclass === 'work_data' || (a.readOnly === true && b.readOnly !== true))) ? b : a, { cls: 'A', reason: '未产生对外动作', readOnly: true } as Classification);
    return { ...selected, readOnly: items.every(item => item.readOnly === true), paths: [...new Set(items.flatMap(item => item.paths ?? []))],
        writePaths: [...new Set(items.flatMap(item => item.writePaths ?? (item.readOnly ? [] : item.paths ?? [])))], gitRepos: [...new Set(items.flatMap(item => item.gitRepos ?? []))] };
}
