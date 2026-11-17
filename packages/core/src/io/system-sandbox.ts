/** macOS 写入沙箱只开放明确目录与系统临时目录；先解析真实路径，避免符号链接别名导致规则失效。 */
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { SANDBOX_UNAVAILABLE, SandboxRootChanged, type ExecOptions } from './interfaces.js';

// 常量定义在纯接口文件里，中心与界面弹出同一句失败说明；这里重新导出兼容原有引用。
export { SANDBOX_UNAVAILABLE } from './interfaces.js';
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const rootsSchema = z.array(z.string().min(1, '沙箱目录不能为空').refine(
  path => isAbsolute(path) && !path.includes('\0'), '沙箱目录必须是没有空字符的绝对路径'));
const sandboxSchema = z.strictObject({
  writableRoots: rootsSchema,
  // 工作数据等目录即使落在可写目录内也要拒绝；缺省表示不额外拒绝任何目录。
  denyWriteRoots: rootsSchema.optional(),
  // P81：writableRoots 里允许还不存在的那几个（发布位置）。
  mayCreateRoots: rootsSchema.optional(),
});

/** Seatbelt 字符串不使用 shell 转义；反斜杠与双引号分别转义，阻止目录名注入额外规则。 */
export function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Seatbelt 正则字符串（P81r1，S2）：用 #"..." 原样写法，正则自己的反斜杠不再二次转义；
 * 双引号仍按 SBPL 的写法转义，防止目录名注入额外规则。
 */
function sbplRegex(value: string): string {
  return `#"${value.replace(/"/g, '\\"')}"`;
}

/** 把字面路径变成正则里的一段：路径里的 . ( ) 等正则元字符按字面匹配。 */
function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析受保护目录的真实路径，不存在的尾部沿父目录补回。
 * 主人可能配置了尚未创建的受保护目录；它只用于追加拒绝规则，
 * 不存在也不该让全部宿主命令启动失败。权限错误和循环链接仍然抛出，由调用方失败关闭。
 */
async function resolveRoot(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await resolveRoot(dirname(path)), basename(path));
  }
}

/** 路径比较用的写法：NFC 归一、不分大小写（与 project/local-dir.ts 同一做法）。 */
const foldedPath = (path: string): string => path.normalize('NFC').toUpperCase().toLowerCase();

/**
 * P81：可以还不存在的可写根（发布位置）：只解析上一级目录的真实路径，再接回发布位置这一级的名字
 * （与 gate/real-path.ts 的 resolveFixedRoot 同一做法）。这一级被换成指向别处的符号链接时，
 * 规则仍然落在原来的字面位置，经链接写到别处会被系统拒绝（P81r1，S1）。
 * 传入的路径应当已经是真实路径（中心运行前核对时解析过）：这里重新解析上一级，结果与传入的不一致（只差大小写除外）
 * 就失败关闭，避免「核对之后、生成规则之前」上一级被换成指向别处的链接而把规则开在别处。
 */
async function resolveMayCreateRoot(root: string): Promise<string> {
  const resolved = join(await resolveRoot(dirname(root)), basename(root));
  if (foldedPath(resolved) !== foldedPath(root)) throw new SandboxRootChanged(root);
  return resolved;
}

/** 每次重建真实路径规则，不能沿用旧符号链接指向，也不能在不支持的平台放行。 */
export async function sandboxProfile(sandbox: NonNullable<ExecOptions['sandbox']>, platform: NodeJS.Platform): Promise<string> {
  if (platform !== 'darwin') throw new Error(`${SANDBOX_UNAVAILABLE}（仅支持 macOS）`);
  const parsed = sandboxSchema.safeParse(sandbox);
  if (!parsed.success) throw new Error(`${SANDBOX_UNAVAILABLE}（${parsed.error.issues.map(issue => issue.message).join('；')}）`);
  // 可写根必须是已存在的真实目录：解析失败就失败关闭，绝不放行一个无法核实的写入口。
  // 根目录只解析上一级再接回名字：根目录被换成链接时，规则仍指向原位置，写入链接指向的地方会被系统拒绝。
  // 系统临时目录归操作系统管，照常解析。先解析一次根目录本身，只为确认它存在。
  const mayCreate = new Set(parsed.data.mayCreateRoots ?? []);
  const fixedRoots = await Promise.all(parsed.data.writableRoots.map(async root => {
    // P81：允许还不存在的根（发布位置）：失败关闭，解析结果与传入的不一致就不运行。
    if (mayCreate.has(root)) return resolveMayCreateRoot(root);
    await realpath(root);
    return join(await realpath(dirname(root)), basename(root));
  }));
  const writable = [...new Set([...fixedRoots, await realpath(tmpdir())])];
  const denied = [...new Set(await Promise.all((parsed.data.denyWriteRoots ?? []).map(root => resolveRoot(root))))];
  // P81r1（S2）：发布位置之下、名字以点开头的文件和文件夹不能写入、不能删除（.git、.vscode、.envrc 这类
  // 会在主人下次提交或打开时执行代码）。规则按「发布位置/任意层/以点开头的名字」匹配；发布位置本身与
  // 其中不以点开头的内容照常可写。放在最后，覆盖前面的开放规则。
  const dotted = [...mayCreate].map(root => `(deny file-write* (regex ${sbplRegex(`^${regexEscape(root)}/(.*/)?\\.[^/]*(/|$)`)}))`).join('');
  // 规则按顺序求值，后写的规则覆盖先写的：先拒绝全部写入，再开放可写目录，再收回受保护目录，最后挡掉点开头的条目。
  return `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))`
    + `(allow file-write* ${writable.map(root => `(subpath ${sbplString(root)})`).join(' ')})`
    + (denied.length ? `(deny file-write* ${denied.map(root => `(subpath ${sbplString(root)})`).join(' ')})` : '')
    + dotted;
}
