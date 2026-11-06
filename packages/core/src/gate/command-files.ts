/** 宿主命令审批保存家内文件的原始字节指纹；执行前重采集，避免脚本或符号链接在批准后被换掉。 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { sha256Hex } from '../util/hash.js';
import { classifyArgv } from './commands.js';
import { gateContextFor } from './guard.js';
import { classifyPath, resolveGatePath, within, type GateContext } from './paths.js';
import { resolveRealTarget } from './real-path.js';
import { lexShell } from './shell-lexer.js';

export interface CommandFile {
  /** 保存执行时使用的路径；只存 realPath 会漏掉后来被改指向的符号链接。 */
  path: string;
  sha256: string;
  realPath?: string;
}

/** 既保留完整参数，也识别常见选项、响应文件和文件 URL，宁可多绑定也不遗漏明确文件。 */
function argumentValues(value: string): string[] {
  const values = [value];
  if (value.includes('=')) values.push(value.slice(value.indexOf('=') + 1));
  const at = value.indexOf('@');
  if (at >= 0) values.push(value.slice(at + 1));
  // 短选项可以把值直接贴在后面，例如 node -rwork/setup.js。
  if (/^-[A-Za-z][^-]/.test(value)) values.push(value.slice(2));
  return values.filter(Boolean);
}

/** 这里只提取静态路径而不执行文本；所有参数都解析，覆盖 shell -c 等包装器内的明确文件。 */
function candidatePaths(payload: { cmd: string; args: string[]; cwd: string }, gate: GateContext): string[] {
  const values = new Set<string>();
  for (const value of [payload.cmd, ...payload.args]) {
    for (const candidate of argumentValues(value)) values.add(candidate);
    // 引号里的参数也可能是整段命令；词法器只拆词，不求值变量、替换或内联程序。
    for (const part of lexShell(value, 0, gate.maxCommandDepth).parts) {
      for (const word of [...part.words, ...part.redirects.map(redirect => redirect.path)]) {
        for (const candidate of argumentValues(word)) values.add(candidate);
      }
    }
  }
  // 复用分类器记录的执行目录变化，例如 bash -c 'cd work; node x.js'。
  for (const path of classifyArgv([payload.cmd, ...payload.args], gate).paths ?? []) values.add(path);
  const paths = new Set<string>();
  for (const value of values) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value)) continue;
    // argv 本身不经过 shell，带 $ 或 ~ 的字面文件名仍可能是真实参数，必须同时保留。
    if (!/^file:\/\//i.test(value)) paths.add(posix.resolve(payload.cwd, value));
    const expanded = resolveGatePath(value, gate);
    if (posix.isAbsolute(expanded)) paths.add(expanded);
  }
  return [...paths].sort();
}

/** 在任何磁盘正文读取前检查原路径和真实路径，禁止为算哈希读取敏感或未授权的工作数据。 */
function checkReadable(path: string, gate: GateContext): void {
  const action = classifyPath(path, false, gate);
  if (action.cls === 'protected' || action.subclass === 'work_data') throw new Error(action.reason);
}

/** 采集完整列表：新出现、被删除或变成其他类型的文件也会使执行前列表与批准内容不同。 */
export async function captureCommandFiles(ctx: HubContext, botId: string,
  payload: { cmd: string; args: string[]; cwd: string }): Promise<CommandFile[]> {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error('出站命令所属机器人不存在');
  const gate = { ...gateContextFor(ctx, bot), cwd: payload.cwd };
  const realHome = await resolveRealTarget(ctx.fs, bot.homeDir);
  const realGate: GateContext = { ...gate, homeDir: realHome,
    rootDir: await resolveRealTarget(ctx.fs, gate.rootDir),
    sharedDir: await resolveRealTarget(ctx.fs, gate.sharedDir),
    workDataPaths: await Promise.all((gate.workDataPaths ?? []).map(path => resolveRealTarget(ctx.fs, resolveGatePath(path, { ...gate, cwd: undefined })))) };
  const files: CommandFile[] = [];
  for (const path of candidatePaths(payload, gate)) {
    checkReadable(path, gate);
    const realPath = await resolveRealTarget(ctx.fs, path);
    checkReadable(realPath, realGate);
    // 家内名称不准指向家外；否则批准后改链接可能偷偷扩大读取或执行范围。
    if (within(path, bot.homeDir) && !within(realPath, realHome)) throw new Error('命令文件符号链接指向家目录边界外，拒绝执行');
    if (!within(realPath, realHome)) continue;
    const stat = await ctx.fs.stat(realPath);
    if (!stat || stat.isDir || stat.isFile === false) continue;
    // 老适配器不能证明是普通文件时失败关闭，避免读取管道或设备造成阻塞。
    if (stat.isFile !== true) throw new Error('命令文件类型无法确认为普通文件，拒绝执行');
    const bytes = await ctx.fs.readBytes(realPath);
    if (bytes === null) throw new Error('命令文件在读取指纹时消失，拒绝执行');
    files.push({ path, realPath, sha256: sha256Hex(bytes) });
  }
  return files;
}
