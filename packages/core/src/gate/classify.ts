/** 工具适配表把宿主常见名称变成明确的读、写或执行动作；未知参数保持审批，避免误放行。 */
import { z } from 'zod';
import { parseInput, validationMessage } from '../engine/validation.js';
import { classifyCommand, classifyArgv } from './commands.js';
import { classifyPath, mostDangerous, resolveGatePath } from './paths.js';
import { classifyUrl } from './network-options.js';
import { pathArguments, editTargetPaths, selectedCommand, commandArguments } from './tool-targets.js';
import type { GateContext, Classification } from './paths.js';
export type { GateContext, Classification, ToolActionClass } from './paths.js';
export { classifyCommand, classifyArgv } from './commands.js';
export { within, resolveGatePath } from './paths.js';
export interface ToolShape {
    kind: 'read' | 'write' | 'edit' | 'exec' | 'web_search' | 'web_fetch';
    names: readonly string[];
    /** DSH 工作区工具只认宿主 cwd；会话内部工具由宿主限制在本会话内。 */
    scope?: 'workspace' | 'session';
    /** 递归搜索必须检查工作数据祖先，不能被调用参数关闭。 */
    recursive?: boolean;
    schema?: z.ZodType;
    /** 提取工具可能影响的全部文件路径，供统一目录边界检查。 */
    paths?(args: Record<string, unknown>, ctx: GateContext): string[];
    /** 读取工具请求的原始命令；无法确定时返回空值，后续保守审批。 */
    command?(args: Record<string, unknown>): string | null;
}
/** 适配宿主常见路径参数名，避免工具命名差异绕过路径分类。 */
const pathArgs = pathArguments;
/** 从编辑参数及补丁文件头提取所有受影响路径，避免多文件操作漏过动作闸。 */
const editPaths = editTargetPaths;
const SearchSchema = z.object({ pattern: z.string().min(1, '搜索 pattern 不能为空'), path: z.string().min(1, '搜索 path 不能为空').optional() });
const PresentSchema = z.object({ files: z.array(z.object({ path: z.string().min(1, '展示文件 path 不能为空'), description: z.string().optional() })).min(1, 'files 至少包含一个文件') });
/** 搜索根始终参与检查；glob 中的路径片段另行解析，防止 pattern 越出原搜索目录。 */
function searchPaths(args: Record<string, unknown>, ctx: GateContext, glob = false): string[] {
    const base = typeof args.path === 'string' ? args.path : '.';
    const paths = [base];
    if (glob && typeof args.pattern === 'string' && (args.pattern.includes('/') || args.pattern.includes('..'))) {
        const target = resolveGatePath(args.pattern, { ...ctx, cwd: resolveGatePath(base, ctx) });
        paths.push(target);
        // 通配目录不能当作字面目录比较；固定前缀覆盖潜在搜索范围，防止掩盖工作数据。
        const wildcard = target.search(/[*?\[\]{}()]/);
        if (wildcard >= 0) paths.push(target.slice(0, target.lastIndexOf('/', wildcard)) || '/');
    }
    return paths;
}
/** 保留每个可识别目标，完整结构另由 schema 校验；坏条目不能掩盖同批敏感文件。 */
function presentPaths(args: Record<string, unknown>): string[] {
    if (!Array.isArray(args.files)) return [];
    return args.files.flatMap(file => file && typeof file === 'object' && typeof file.path === 'string' ? [file.path] : []);
}
export const TOOL_SHAPES: readonly ToolShape[] = [
    { kind: 'read', names: ['read_file', 'read', 'list_directory', 'list_files', 'search_files'], paths: pathArgs },
    { kind: 'read', names: ['read_image'], scope: 'workspace', schema: z.object({ file_path: z.string().min(1, '图片 file_path 不能为空') }), paths: pathArgs },
    { kind: 'read', names: ['glob'], scope: 'workspace', recursive: true, schema: SearchSchema, paths: (args, ctx) => searchPaths(args, ctx, true) },
    { kind: 'read', names: ['grep'], scope: 'workspace', recursive: true, schema: SearchSchema, paths: searchPaths },
    { kind: 'read', names: ['present'], scope: 'workspace', schema: PresentSchema, paths: presentPaths },
    { kind: 'write', names: ['write_file', 'write'], paths: pathArgs },
    { kind: 'edit', names: ['edit_file', 'edit', 'apply_patch'], paths: editPaths },
    { kind: 'exec', names: ['exec', 'shell', 'bash', 'run_command', 'exec_command'], command: selectedCommand },
    // 会话作用域与动作形状分开：清单写入和任务终止不冒充文件读取或 shell 命令。
    { kind: 'write', names: ['todo_write'], scope: 'session', schema: z.object({ todos: z.array(z.unknown()) }) },
    { kind: 'read', names: ['skill'], scope: 'session', schema: z.object({ name: z.string().min(1, '技能 name 不能为空') }) },
    { kind: 'read', names: ['job_list'], scope: 'session' },
    { kind: 'read', names: ['job_output'], scope: 'session', schema: z.object({ job_id: z.string().min(1, '后台任务 job_id 不能为空'), wait: z.boolean().optional(), timeout_ms: z.number().optional() }) },
    { kind: 'exec', names: ['job_kill'], scope: 'session', schema: z.object({ job_id: z.string().min(1, '后台任务 job_id 不能为空'), reason: z.string().optional() }) },
    { kind: 'web_search', names: ['web_search'] }, { kind: 'web_fetch', names: ['web_fetch'] },
];
const ContextSchema = z.object({ homeDir: z.string().min(1), sharedDir: z.string().min(1), rootDir: z.string().min(1), workDataAllowed: z.boolean(),
    maxCommandDepth: z.number().int().min(1).max(4).optional(), ownerHome: z.string().optional(), workDataPaths: z.array(z.string()).optional(), cwd: z.string().optional(), reflection: z.boolean().optional(), autonomy: z.string().optional() });
/** 把宿主工具适配为读、写或命令分类；无法识别的工具和参数保守进入审批。 */
export function classifyToolCall(tool: string, args: unknown, gctx: GateContext): Classification {
    const ctx = parseInput(ContextSchema, gctx, '动作上下文');
    tool = parseInput(z.string().trim().min(1, '工具名不能为空'), tool, '工具名');
    if (tool.startsWith('hub_'))
        return { cls: 'A', reason: '中心工具自行检查权限', subclass: 'hub_tool' };
    const parsed = z.record(z.string(), z.unknown()).safeParse(args);
    if (!parsed.success)
        return { cls: 'C', reason: '工具参数无法识别' };
    const input = parsed.data;
    const shape = TOOL_SHAPES.find(s => s.names.includes(tool));
    // 新 DSH 工具没有 cwd/workdir 参数，前置敏感检查与最终分类都使用宿主实际的路径基准。
    const pathContext = shape?.scope ? ctx : { ...ctx, cwd: typeof (input.cwd ?? input.workdir) === 'string' ? String(input.cwd ?? input.workdir) : ctx.cwd };
    // 即便工具名未知，明确给出的敏感文件路径也不能降级成可批准的 C。
    const declared = mostDangerous(pathArgs(input).map(path => classifyPath(path, false, pathContext)));
    if (declared.cls === 'protected' || declared.subclass === 'work_data') return declared;
    if (!shape)
        return { cls: 'C', reason: '未知工具需要主人审批', subclass: tool };
    const validation = shape.schema?.safeParse(input);
    const invalid: Classification[] = validation && !validation.success ? [{ cls: 'C', reason: `工具参数无效：${validation.error.issues.map(issue => `${issue.path.join('.')}：${validationMessage(issue)}`).join('；')}` }] : [];
    // 宿主保证这五个工具只作用于本会话；保守保留非只读，交账后不能再修改清单或终止任务。
    if (shape.scope === 'session')
        return invalid[0] ?? { cls: 'A', reason: '仅操作本会话的清单、技能或后台任务', subclass: 'session_internal', readOnly: false };
    if (shape.kind === 'web_search')
        return { cls: 'A', reason: '只读网页搜索', readOnly: true };
    if (shape.kind === 'web_fetch') {
        const method = String(input.method ?? 'GET').toUpperCase();
        return classifyUrl(String(input.url ?? ''), method, ctx);
    }
    if (shape.kind === 'exec') {
        const command = shape.command?.(input);
        const commandCtx = { ...ctx, cwd: typeof (input.cwd ?? input.workdir) === 'string' ? String(input.cwd ?? input.workdir) : ctx.cwd };
        if (!command)
            return { cls: 'C', reason: '执行命令参数缺失' };
        const argv = commandArguments(input);
        if (argv)
            return classifyArgv([command, ...argv], commandCtx);
        return classifyCommand(command, commandCtx);
    }
    const paths = shape.paths?.(input, pathContext) ?? [];
    if (!paths.length)
        return invalid[0] ?? { cls: 'C', reason: '工具缺少可确定的目标路径' };
    return mostDangerous([...invalid, ...paths.map(path => classifyPath(path, shape.kind !== 'read', pathContext, false, shape.recursive === true || tool === 'search_files' || input.recursive === true))]);
}
