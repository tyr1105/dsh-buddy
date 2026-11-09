/**
 * 项目共享目录的路径边界与物理创建（F08 尾巴批次七）。
 *
 * 为什么单独成文件：saveProject 是同步纯逻辑（只校验、写表），而建目录必须经过注入的
 * FsIO（异步）。把「校验路径」与「碰盘」收在一处，服务层与界面命令出口共用同一条边界
 * 规则，避免两套判断慢慢走偏。
 *
 * 安全口径：只允许 <rootDir>/projects 子树内的绝对路径；等于 projects 根目录、越界、
 * 相对路径一律拒绝。ensure 时再校验一次，防止旧存档或手工改库把目录指到系统位置。
 *
 * 保守默认：目录在项目记录写表之后创建；若创建失败，项目仍在，下次保存会重试。
 * 这样不把「碰盘」塞进同步服务，也不会因为一个目录故障丢掉主人的项目配置。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Project } from '../model/project.js';
import { within } from '../gate/paths.js';

/**
 * 规范化并校验项目目录，返回带尾斜杠的路径。
 * 先去掉尾斜杠再比较，避免 /hub/projects/ 被当成 projects 的子目录；比较折叠大小写，
 * 与 within 的口径一致。只做字符串判断，不创建、不读盘。
 */
export function normalizeProjectSharedDir(ctx: HubContext, value: string): string {
  if (!value.startsWith('/')) throw new Error(`项目目录必须是绝对路径（以 / 开头）：${value}`);
  const normalized = posix.normalize(value).replace(/\/+$/, '');
  const base = posix.join(ctx.settings.rootDir, 'projects');
  const same = (a: string, b: string): boolean => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
  if (same(normalized, base) || !within(normalized, base)) {
    throw new Error(`项目目录必须位于 ${base}/ 下：${value}`);
  }
  return `${normalized}/`;
}

/**
 * 物理创建项目共享目录：幂等（重复保存不报错），失败抛中文错误点名项目与目录。
 * 返回值是去掉尾斜杠后的实际创建路径，方便调用方记录或测试断言。
 */
export async function ensureProjectSharedDir(ctx: HubContext, project: Project): Promise<string> {
  const dir = normalizeProjectSharedDir(ctx, project.sharedDir).replace(/\/+$/, '');
  try {
    await ctx.fs.mkdirp(dir, { within: posix.join(ctx.settings.rootDir, 'projects') });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`项目「${project.name}」目录创建失败：${dir}（${message}）`);
  }
  return dir;
}
