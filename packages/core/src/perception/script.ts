/** 脚本关注项只经注入执行器运行；解析参数后按程序与脚本路径校验，绝不把命令交给 shell。 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Percept, Watch } from '../model/perception.js';
import { sha1Hex } from '../util/hash.js';
import { recordPercept } from './percept.js';
import { readWatchState, saveWatchState } from './watch-state.js';
import { markWatchSatisfied } from './satisfaction.js';
import { matchesWatchFilter } from './filter.js';
import { classifyArgv } from '../gate/commands.js';
import { watchGateContext } from './access.js';

/** 支持空白分隔及双引号参数；不接受管道、替换、命令串联和未闭合引号。 */
export function splitCommand(target: string): string[] {
  if (/[|;&`]|\$\(/.test(target)) throw new Error('脚本 target 不能包含 shell 管道、串联或命令替换');
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < target.length; i += 1) {
    const character = target[i]!;
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (character === '\\' && quoted && (target[i + 1] === '"' || target[i + 1] === '\\')) {
      current += target[++i];
      started = true;
    } else if (/\s/.test(character) && !quoted) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quoted) throw new Error('脚本 target 的双引号没有闭合');
  if (started) args.push(current);
  if (!args[0]) throw new Error('脚本 target 必须包含程序名');
  return args;
}
/** 用目录段关系确认脚本属于家目录，防止相似前缀和上级路径越界。 */
function isInside(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(home, path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 对 node/python3 只接受直接的脚本参数，拒绝 -e、-c、-m 等绕过家目录的入口。 */
export async function validateCommand(ctx: HubContext, botOrHome: Bot | string, target: string): Promise<{ cmd: string; args: string[] }> {
  const [program, ...args] = splitCommand(target);
  const cmd = program!;
  const home = typeof botOrHome === 'string' ? botOrHome : botOrHome.homeDir;
  // 关注脚本由中心直接运行，不经过宿主工具钩子，因此须再次应用敏感与工作数据边界。
  // 新建预检使用传入的 Bot；旧家目录参数仍查询当前授权，找不到时保守拒绝工作数据。
  const bot = typeof botOrHome === 'string' ? ctx.store.table('bots').list(row => row.homeDir === home)[0] : botOrHome;
  const gate = bot ? watchGateContext(ctx, bot) : { homeDir: home, cwd: home, ownerHome: ctx.ownerHome,
    rootDir: ctx.settings.rootDir, sharedDir: `${ctx.settings.rootDir}/shared`,
    workDataAllowed: false, workDataPaths: ctx.settings.workDataPaths };
  const access = classifyArgv([cmd, ...args], gate);
  if (access.cls === 'protected' || access.subclass === 'work_data') throw new Error(`脚本关注访问被拒绝：${access.reason}`);
  if (['ls', 'cat', 'wc'].includes(cmd)) return { cmd, args };
  if (cmd === 'git') {
    if (!['status', 'log', 'diff', 'show'].includes(args[0] ?? '') || args.some(arg => /^(--exec|--ext-diff|--textconv|--output)(?:=|$)/.test(arg))) throw new Error('git 关注项只允许 status/log/diff/show 的只读调用');
    return { cmd, args };
  }
  const script = cmd === 'node' || cmd === 'python3' ? args[0] : cmd;
  if (!script || script.startsWith('-') || !isInside(home, script)) throw new Error('脚本程序或 node/python3 的脚本参数必须位于机器人家目录内');
  const scriptPath = resolve(home, script);
  const stat = await ctx.fs.stat(scriptPath);
  if (!stat || stat.isDir) throw new Error('脚本路径必须指向机器人家目录内已有的文件');
  return cmd === 'node' || cmd === 'python3' ? { cmd, args: [scriptPath, ...args.slice(1)] } : { cmd: scriptPath, args };
}
/** 执行受限脚本并比较输出与退出码；软截断仍可建基线，未正常完成不覆盖旧基线。 */
export async function pollScript(ctx: HubContext, watch: Watch, now: number): Promise<Percept | null> {
  const bot = ctx.store.table('bots').get(watch.botId);
  if (!bot) throw new Error('脚本关注项所属机器人不存在');
  const command = await validateCommand(ctx, bot, watch.target);
  // 脚本可在主人接受关注后被改写，因此每次执行都必须由系统沙箱限制写入范围。
  const result = await ctx.exec.run(command.cmd, command.args, { cwd: bot.homeDir,
    timeoutMs: ctx.settings.scriptTimeoutMs, maxOutputBytes: ctx.settings.scriptMaxOutputBytes,
    sandbox: { writableRoots: [bot.homeDir] } });
  if (result.timedOut) throw new Error('脚本执行超过时限');
  if (result.killedForOutput) throw new Error('脚本输出超过硬上限，已终止进程组');
  if (result.code === null) throw new Error('脚本被信号终止，未返回退出码');
  // 软截断不等于失败；按保留下来的稳定前缀与真实退出码继续比较。
  const hash = sha1Hex(result.stdout);
  const state = readWatchState(watch);
  const exitChanged = state.code !== undefined && state.code !== result.code;
  const failedExit = state.code === 0 && result.code !== 0;
  if (result.code === 0 && matchesWatchFilter(watch.filter, result.stdout, ctx.settings)) markWatchSatisfied(ctx, watch.id, now);
  let percept: Percept | null = null;
  if (watch.lastFingerprint !== null && (watch.lastFingerprint !== hash || exitChanged)) percept = recordPercept(ctx, {
    botId: watch.botId, watchId: watch.id, source: 'script', kind: failedExit ? 'exit_changed' : 'output_changed',
    summary: failedExit ? `脚本退出码从 0 变为 ${result.code}：${result.stderr || result.stdout}` : result.stdout || `脚本退出码变为 ${result.code}`,
    location: watch.target, fingerprintMaterial: [watch.id, hash, result.code], magnitude: ctx.settings.c02.scriptMagnitude,
    anomaly: failedExit, untrusted: true, occurredAt: now,
  });
  saveWatchState(ctx, watch, { code: result.code }, now, hash);
  return percept;
}
