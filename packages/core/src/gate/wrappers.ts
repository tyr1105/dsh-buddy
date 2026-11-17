/**
 * 包装器拆解：sudo、env、xargs、timeout、外壳（sh、bash）这类「自己不干活、把真正的命令放在参数里」的程序，
 * 在这里把被包住的命令取出来，交回 commands.ts 继续分类。
 *
 * 从 commands.ts 拆出来的原因：P69 A-3（复查修漏洞）要给它加很多东西，放在原文件里会超过一个文件该有的长度。
 * 不传 sandboxed 时，这里的行为和 P69 之前逐字一致；下面标了「沙箱模式」的部分都只在宿主确认沙箱开着时生效：
 * - 外壳（R1）：没有 -c 也没有真脚本文件时，脚本来自标准输入（-s、-、/dev/stdin 或什么都不写），要把喂给它的文字找出来再分类；
 * - 更多包装器（R4）：arch、stdbuf、setsid、unbuffer、flock、ionice、taskpolicy、chronic，以及 GNU 前缀版 gtimeout、gnice、gstdbuf、gnohup、genv；
 * - 运行器（R4）：uv run、poetry run、pipenv run、pdm run、hatch run、conda run、bundle exec、mise exec；
 * - xargs 多认几个带值选项（-a、--arg-file、-J、-R、-S），免得把选项的值当成程序名。
 */
import type { Classification, GateContext } from './paths.js';
import type { AskHint } from '../model/outreach.js';
import { unsure } from './sandbox-rules.js';

/** 包装器拆开后的结果：被包住的命令（words 或 script）、它自己带来的判定（floor），以及外壳是否从标准输入读脚本。 */
export interface Unwrapped { words?: string[]; script?: string; cwd?: string; floor?: Classification; readsStdin?: boolean }

const dangerous = (reason: string, hint: AskHint): Classification => ({ cls: 'D', reason, subclass: 'high_risk', hint });

/** 外壳程序。 */
export const SHELLS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

/** 原来就有的包装器（不传 sandboxed 时只认这些）。 */
const BASE_WRAPPERS = ['sudo', 'doas', 'env', 'xargs', 'timeout', 'nohup', 'nice', 'time', 'command', 'builtin', 'exec', 'caffeinate', 'script', 'watch', '!', 'if', 'then', 'elif', 'do', 'while', 'until'];
/** 沙箱模式多认的包装器：else 后面跟的也是命令，coproc 把命令放到后台跑（原来它们按「看不懂」处理）；后面是 R4 补的一批。 */
const SANDBOX_WRAPPERS = ['else', 'coproc', 'arch', 'stdbuf', 'setsid', 'unbuffer', 'flock', 'ionice', 'taskpolicy', 'chronic'];
/** GNU 前缀版（brew 装的 coreutils）和原版是同一个东西，按原版的选项规则拆。 */
const GNU_ALIASES: Readonly<Record<string, string>> = { gtimeout: 'timeout', gnice: 'nice', gstdbuf: 'stdbuf', gnohup: 'nohup', genv: 'env' };

/** 每个包装器带值的选项：值是下一个词，不能被当成要运行的程序。 */
const BASE_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host'], doas: ['-u', '-C'], env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '--max-args', '--max-procs', '--replace'], timeout: ['-k', '--kill-after', '-s', '--signal'],
  nice: ['-n', '--adjustment'], time: ['-f', '-o', '--format', '--output'], caffeinate: ['-t', '-w'], watch: ['-n', '--interval'], script: ['-c', '--command'], exec: ['-a'],
};
/** 沙箱模式多登记的带值选项（R4）。xargs 补的是 BSD 和 GNU 各自的写法。 */
const SANDBOX_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  xargs: [...BASE_VALUE_OPTIONS.xargs!, '-a', '--arg-file', '-J', '-R', '-S'],
  arch: ['-arch', '-e', '-d'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  ionice: ['-c', '-n', '-p', '-P', '-u'],
  taskpolicy: ['-c', '-d', '-g', '-p'],
  flock: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'],
};

/**
 * 运行器（R4）：uv run 这类「先挑好环境再运行后面的命令」的程序。键是程序名，sub 是紧跟在后面的子命令。
 * valueOptions 是它自己带值的选项。
 */
const RUNNERS: Readonly<Record<string, { sub: string; valueOptions: readonly string[] }>> = {
  uv: { sub: 'run', valueOptions: ['--with', '--with-editable', '--with-requirements', '--python', '-p', '--directory', '--project', '--package', '--extra', '--group', '--env-file', '--index', '--index-url', '-i', '--extra-index-url', '--no-install-package'] },
  poetry: { sub: 'run', valueOptions: ['--directory', '-C', '--project', '-P'] },
  pipenv: { sub: 'run', valueOptions: ['--python', '--pypi-mirror'] },
  pdm: { sub: 'run', valueOptions: ['-p', '--project', '-s', '--site-packages'] },
  hatch: { sub: 'run', valueOptions: ['-e', '--env', '-p', '--project'] },
  conda: { sub: 'run', valueOptions: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  bundle: { sub: 'exec', valueOptions: ['--gemfile'] },
  mise: { sub: 'exec', valueOptions: ['-C', '--cd', '-E', '--env', '-j', '--jobs'] },
};

/** 取外壳（sh、bash 等）要执行的命令。不传 sandboxed 时逐字保持原来的写法。 */
function unwrapShellLegacy(args: string[], ctx: GateContext): Unwrapped {
  let hasCommand = false, uncertain = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return { floor: unsure(ctx, 'shell 脚本文件不是只读命令') };
    if (!arg.startsWith('-') || arg === '-') return hasCommand ? { script: arg, floor: uncertain ? unsure(ctx, 'shell 含未知启动选项') : undefined } : { floor: unsure(ctx, 'shell 第一个操作数是脚本文件，后面的 -c 不改变它') };
    if (arg === '--norc' || arg === '--noprofile') continue;
    if (/^-[a-zA-Z]+$/.test(arg)) { hasCommand ||= arg.slice(1).includes('c'); uncertain ||= /[^clieufxvn]/.test(arg.slice(1)); continue; }
    return { floor: unsure(ctx, 'shell 启动选项无法安全解析') };
  }
  // 没有 -c 也没有脚本文件：外壳会从标准输入读命令。
  return { floor: unsure(ctx, 'shell 缺少命令正文'), readsStdin: !hasCommand };
}

/**
 * 沙箱模式下取外壳要执行的命令（R1）。三种来源：
 * - -c 后面的命令字符串（script）；
 * - 脚本文件（看不见内容，沿用 unsure）；
 * - 标准输入：什么操作数都没有、-s、-s -- 参数、单独一个 -、/dev/stdin。这时 readsStdin 为真，
 *   由 commands.ts 去找喂给它的文字（它自己的 here-document 或前一段 cat/echo/printf 写死的文字），找不到就保持 C。
 */
function unwrapShellSandbox(args: string[], ctx: GateContext): Unwrapped {
  let hasCommand = false, uncertain = false, stdinFlag = false;
  const fromStdin = (): Unwrapped => ({ floor: unsure(ctx, 'shell 从标准输入读脚本'), readsStdin: true });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--' || arg === '-') {
      // 选项到此结束，后面第一个词是命令字符串（有 -c）、位置参数（有 -s），或者脚本文件。
      const rest = args.slice(i + 1);
      if (hasCommand) return rest.length ? { script: rest[0]!, floor: uncertain ? unsure(ctx, 'shell 含未知启动选项') : undefined } : { floor: unsure(ctx, 'shell 缺少命令正文') };
      if (stdinFlag || arg === '-' && rest.length === 0 || rest[0] === undefined || rest[0] === '-' || rest[0] === '/dev/stdin') return fromStdin();
      return { floor: unsure(ctx, 'shell 脚本文件不是只读命令') };
    }
    if (!arg.startsWith('-')) {
      if (hasCommand) return { script: arg, floor: uncertain ? unsure(ctx, 'shell 含未知启动选项') : undefined };
      // -s 之后的操作数是传给脚本的位置参数，脚本本身仍来自标准输入；/dev/stdin 就是标准输入。
      if (stdinFlag || arg === '/dev/stdin') return fromStdin();
      return { floor: unsure(ctx, 'shell 第一个操作数是脚本文件，后面的 -c 不改变它') };
    }
    if (arg === '--norc' || arg === '--noprofile') continue;
    if (/^-[a-zA-Z]+$/.test(arg)) {
      hasCommand ||= arg.slice(1).includes('c');
      stdinFlag ||= arg.slice(1).includes('s');
      uncertain ||= /[^clieufxvns]/.test(arg.slice(1));
      continue;
    }
    return { floor: unsure(ctx, 'shell 启动选项无法安全解析') };
  }
  // 没有 -c 也没有脚本文件：外壳会从标准输入读命令。
  return hasCommand ? { floor: unsure(ctx, 'shell 缺少命令正文') } : fromStdin();
}

/** 外壳只负责取出被执行命令，不直接授予安全级别；陌生选项仍叠加 C（沙箱开着时不再问，见 unsure）。 */
export function unwrap(cmd: string, args: string[], ctx: GateContext): Unwrapped | null {
  const sandbox = ctx.sandboxed === true;
  if (SHELLS.includes(cmd)) return sandbox ? unwrapShellSandbox(args, ctx) : unwrapShellLegacy(args, ctx);
  // eval 把参数拼起来当一段命令执行：沙箱模式下拆开照旧分类，否则 eval "git push" 会被当成看不懂的程序放过去。
  if (sandbox && cmd === 'eval') return { script: args.join(' '), floor: unsure(ctx, 'eval 执行拼出来的命令') };
  // command -v、-V 只是查一个程序在哪，并不运行它；沙箱模式下不再顺着查到的名字去分类。
  if (sandbox && cmd === 'command' && args.some(arg => /^-[a-zA-Z]*[vV]/.test(arg))) return { floor: unsure(ctx, '查询程序位置') };
  // 运行器：uv run、poetry run 等。把子命令也吃掉，剩下的才是被包住的命令。
  const runner = sandbox ? RUNNERS[cmd] : undefined;
  if (runner && args[0] === runner.sub) return unwrapGeneric(`${cmd} ${runner.sub}`, args.slice(1), ctx, runner.valueOptions, true);
  const name = sandbox ? GNU_ALIASES[cmd] ?? cmd : cmd;
  const wrappers = [...BASE_WRAPPERS, ...(sandbox ? SANDBOX_WRAPPERS : [])];
  if (!wrappers.includes(name)) return null;
  const valueOptions = (sandbox ? SANDBOX_VALUE_OPTIONS[name] : undefined) ?? BASE_VALUE_OPTIONS[name] ?? [];
  return unwrapGeneric(name, args, ctx, valueOptions, false);
}

/**
 * 通用拆法：跳过包装器自己的选项（带值的连同值一起跳过），剩下的就是被包住的命令。
 * runner 为真表示这是运行器（uv run 这一类），它们自己不带来任何判定。
 */
function unwrapGeneric(name: string, args: string[], ctx: GateContext, valueOptions: readonly string[], runner: boolean): Unwrapped {
  const sandbox = ctx.sandboxed === true;
  let i = 0;
  let uncertain = false, cwd: string | undefined;
  // mise exec 的写法是 mise exec 工具@版本 -- 命令：-- 之前是要装的工具，不是命令。
  if (name === 'mise exec') {
    const dash = args.indexOf('--');
    return dash < 0 ? { floor: unsure(ctx, 'mise exec 缺少 -- 分隔的命令') } : { words: args.slice(dash + 1), floor: args.length > dash + 1 ? undefined : unsure(ctx, '包装命令缺少正文') };
  }
  while (i < args.length) {
    const arg = args[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && name === 'env') { i++; continue; }
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    const option = arg.split('=')[0]!;
    if (valueOptions.includes(option)) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!value) return { floor: unsure(ctx, '包装选项缺少参数') };
      if (name === 'env' && ['-C', '--chdir'].includes(option)) cwd = value;
      if ((name === 'env' && ['-S', '--split-string'].includes(option)) || (name === 'script' && ['-c', '--command'].includes(option))) return { script: value, floor: unsure(ctx, '包装器会修改环境或记录文件') };
    } else if (!/^-[A-Za-z0-9]+$/.test(arg)) uncertain = true;
    i++;
  }
  if (name === 'timeout') i++;
  // script 的首个操作数是日志文件，后续才是程序；它本身至少 C。
  if (name === 'script' && args[i]) i++;
  // flock 的首个操作数是锁文件；命令要么跟在后面，要么写在 -c 后面。
  if (sandbox && name === 'flock') {
    i++;
    if (args[i] === '-c' || args[i] === '--command') return args[i + 1] !== undefined ? { script: args[i + 1]!, floor: unsure(ctx, 'flock 执行命令字符串') } : { floor: unsure(ctx, '包装命令缺少正文') };
  }
  let words = args.slice(i);
  // hatch run 的命令可以写成 环境名:命令，去掉环境名前缀。
  if (sandbox && name === 'hatch run' && words[0] !== undefined) words = [words[0].replace(/^[A-Za-z0-9_.-]+:/, ''), ...words.slice(1)];
  // 提权永远是 D，沙箱开不开都一样；其余包装器自己带来的判定走 unsure。
  const floor = ['sudo', 'doas'].includes(name) ? dangerous('提权命令永久需要审批', 'elevate')
    : (uncertain || ['xargs', 'script', 'watch', 'env', 'time', 'caffeinate', 'nohup'].includes(name)) ? unsure(ctx, '包装器的环境、输入或写入副作用需审批') : undefined;
  if (runner) return { words, cwd, floor: floor ?? (words.length ? undefined : unsure(ctx, '包装命令缺少正文')) };
  return { words, cwd, floor: floor ?? (args.length ? undefined : unsure(ctx, '输出环境或包装命令缺少正文')) };
}
