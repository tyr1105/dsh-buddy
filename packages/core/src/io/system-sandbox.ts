/** macOS 写入沙箱只开放明确目录与系统临时目录；先解析真实路径，避免符号链接别名导致规则失效。 */
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ExecOptions } from './interfaces.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_UNAVAILABLE = '当前系统没有可用的沙箱，脚本关注不运行';
const sandboxSchema = z.strictObject({
  writableRoots: z.array(z.string().min(1, '沙箱可写目录不能为空').refine(
    path => isAbsolute(path) && !path.includes('\0'), '沙箱可写目录必须是没有空字符的绝对路径')),
});

/** Seatbelt 字符串不使用 shell 转义；反斜杠与双引号分别转义，阻止目录名注入额外规则。 */
export function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 每次重建真实路径规则，不能沿用旧符号链接指向，也不能在不支持的平台放行。 */
export async function sandboxProfile(sandbox: NonNullable<ExecOptions['sandbox']>, platform: NodeJS.Platform): Promise<string> {
  if (platform !== 'darwin') throw new Error(`${SANDBOX_UNAVAILABLE}（仅支持 macOS）`);
  const parsed = sandboxSchema.safeParse(sandbox);
  if (!parsed.success) throw new Error(`${SANDBOX_UNAVAILABLE}（${parsed.error.issues.map(issue => issue.message).join('；')}）`);
  const roots = [...new Set(await Promise.all([...parsed.data.writableRoots, tmpdir()].map(root => realpath(root))))];
  return `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))`
    + `(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`;
}
