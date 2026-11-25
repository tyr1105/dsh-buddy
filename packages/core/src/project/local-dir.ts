/**
 * 约定里「发布到主人电脑上的哪个文件夹」（launch.localDir）的校验与显示（P81，决策 DC66；P81r1 收紧）。
 *
 * 为什么单独一个文件：这一项决定「中心代为运行的发布命令能写到主人电脑上的哪里」，是安全相关的判断。
 * 所有规则都写成纯函数（不读磁盘、不碰时钟），由程序确定地判断，不靠模型自觉；
 * 提交约定时用一次，发布命令运行之前（解析符号链接之后）再用一次，两处共用同一个函数 checkLocalDir。
 *
 * 路径比较的写法（几条都是安全要求）：
 * - 一律按「路径的每一段」比较，不用字符串开头去比（~/Desktop/site 不算在 ~/Desktop/site-2 之内）；
 * - 每一段先做 NFC 归一（中文路径的两种 Unicode 写法视为同一处），再统一大小写（这台机器的文件系统不分大小写）；
 *   统一大小写时先转大写再转小写，把「ſ（长 s）」「K（开尔文符号）」这类会被不分大小写的文件系统当成普通字母的写法也折叠掉；
 * - 先拒绝 .. 这一段和以点开头的一段，所以比较时不需要再处理 . 与 ..。
 *
 * P81r1 收紧的两处（安全审查 S2、S4）：
 * - 第一级只允许 Desktop、Documents、Downloads、Sites、Public（白名单比黑名单可靠，挡住应用程序包、命令搜索路径、
 *   代码仓库这类「写入等于执行代码」的位置）；
 * - 每一段的字符只允许文字、数字、组合附加符、空格、连字符、下划线、点和括号，
 *   路径会进入审批卡文字、给模型看的命令与沙箱规则，字符越少越不容易看起来像别的位置。
 */
import type { HubContext } from '../engine/context.js';
import { hasInvisibleChars } from '../job/owner-text.js';

/** 路径最长多少个字符（按完整字符数）。 */
export const LOCAL_DIR_MAX_CHARS = 200;

/** 第一级只允许这几个文件夹（按折叠后的写法比较，不分大小写）。 */
export const LOCAL_DIR_FIRST_LEVELS = ['Desktop', 'Documents', 'Downloads', 'Sites', 'Public'] as const;
const FIRST_LEVELS: ReadonlySet<string> = new Set(LOCAL_DIR_FIRST_LEVELS.map(level => level.toUpperCase().toLowerCase()));

/** 应用程序包、资料库的结尾（不分大小写）：写进去等于改写主人在用的程序或资料库。 */
const APP_SUFFIXES = ['.app', '.bundle', '.framework', '.plugin', '.photoslibrary'] as const;

/** 校验时需要的两样环境：主人的主目录（可能不止一种写法）、必须避开的目录。 */
export interface LocalDirEnv {
  /** 主人的主目录。取不到时为空数组：带 ~ 的路径和绝对路径都无法核对，一律拒绝。 */
  homes: readonly string[];
  /** 中心的数据目录、员工的文件夹、共享文件夹、DSH 的数据目录等：路径不能在它们之内，也不能是它们的上级。 */
  protectedRoots: readonly string[];
}

export type LocalDirCheck = { ok: true; path: string } | { ok: false; reason: string };

/** 一段路径的比较写法：NFC 归一 + 不分大小写（见文件开头）。 */
export function foldSegment(segment: string): string {
  return segment.normalize('NFC').toUpperCase().toLowerCase();
}

/** 把绝对路径切成段（去掉空段，等于去掉多余的斜线和末尾的斜线）。W7a 的工作文件夹校验也用它。 */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter(part => part !== '');
}

/** prefix 的每一段（折叠后）是不是 whole 的开头若干段。 */
function segmentsStartWith(whole: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= whole.length && prefix.every((part, index) => foldSegment(part) === foldSegment(whole[index]!));
}

/** 这个绝对路径是不是在 root 之内（含它自己），按段比较。 */
export function segmentsWithin(path: string, root: string): boolean {
  return segmentsStartWith(segmentsOf(path), segmentsOf(root));
}

/**
 * 两个发布位置是不是同一处（按段、折叠后比较）。都为 null 也算同一处（都没有发布位置）。
 * P81r1（S6）：运行前核对比较审批旁表里记下的位置与约定里现在的位置，用它，不再比提示句的文字。
 */
export function sameLocalDirPath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  return left.length === right.length && left.every((part, index) => foldSegment(part) === foldSegment(right[index]!));
}

/**
 * 路径在主目录之下的那几段（用于「主目录真实路径 + 这几段」的换算）；不在主目录之下返回 null。
 * 与 checkLocalDir 一样按段、折叠后比较，主目录的写法可能带符号链接前后两种。
 */
export function localDirRelativeOf(path: string, home: string): string[] | null {
  const whole = segmentsOf(path);
  const base = segmentsOf(home);
  if (base.length === 0 || !segmentsStartWith(whole, base)) return null;
  return whole.slice(base.length);
}

/** 不允许的字符：控制字符、不可见字符、除空格之外的空白、双引号、反斜杠（后两种会让路径在命令和沙箱规则里引起歧义，一并拒绝）。 */
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}"\\]|[^\S ]/u;

/**
 * 一段名字里允许的字符（P81r1 第 3.2 节第 3 条）：各种文字的字母与数字、跟在它们后面的组合附加符、空格、-、_、.
 * 与半角、全角括号；点不能出现在开头，一段也不能以组合附加符开头（其余位置不限）。
 */
const SEGMENT_CHARS = /^(?![.\p{M}])[\p{L}\p{N}\p{M} _.\-()（）]+$/u;

/** W7a：工作文件夹与发布位置用同一套字符规则（整条路径不能有的字符、每一段允许的字符）。 */
export function hasBadPathChars(text: string): boolean {
  return BAD_CHARS.test(text) || hasInvisibleChars(text);
}
export function isPlainSegmentName(segment: string): boolean {
  return SEGMENT_CHARS.test(segment);
}

/** 拒绝原因（逐字，接进 localDirRefusal 的 {原因}）。 */
export const LOCAL_DIR_REASONS = {
  noHome: '取不到你电脑的主目录，无法核对这个位置',
  notAbsolute: '不是完整路径（要以 / 或 ~/ 开头）',
  dotDot: '路径里含有 .. 这一段',
  badChars: '路径里含有换行、引号、反斜杠或看不见的字符',
  tooLong: `路径超过 ${LOCAL_DIR_MAX_CHARS} 个字符`,
  outsideHome: '不在你电脑的主目录之下',
  tooShallow: '层级不够深，需要是主目录下面至少两级的具体文件夹',
  hidden: '路径里有以点开头的隐藏目录',
  firstLevel: `第一级只能是 ${LOCAL_DIR_FIRST_LEVELS.join('、')} 之一`,
  appBundle: '不能选应用程序包或资料库里面的位置',
  badName: '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号',
  parentMissing: '上一级文件夹不存在，请换一个已经在的位置，或和主人商量，不要自己去建',
  parentUnreadable: '读不到上一级文件夹，无法核对这个位置',
  center: '在中心的数据目录、员工的文件夹、共享文件夹或 DSH 的数据目录之内，或者是它们的上级目录',
} as const;

/** 拒绝时给模型看的话（逐字，任务卡 P81 第 1 节第 3 条）。 */
export function localDirRefusal(reason: string): string {
  return `launch.localDir 不能用：${reason}。能用的位置是主人主目录下的一个具体文件夹，至少两级，例如 ~/Desktop/活动页面；不能是主目录或桌面这类目录本身，不能是隐藏目录、系统目录、DSH 和员工的数据目录。位置不合适时和主人商量换一个。`;
}

/** 运行前核对不通过时，「没有发布成功」那一句里的原因（逐字，任务卡 P81 第 3 节第 2 条；放在这里是为了让 job/launch-result.ts 不必反过来依赖运行前核对的文件）。 */
export const LOCAL_DIR_CHANGED_REASON = '约定的发布位置现在指向别处，没有运行发布命令。';

/** 发布方式明显写的是本机位置、却没有填 localDir 时的拒绝话（逐字，任务卡 P81 第 1 节第 5 条）。 */
export const LOCAL_DIR_MISSING_REFUSAL = '发布方式写的是主人电脑上的位置，要把那个文件夹填进 launch.localDir（完整路径，可以用 ~ 表示主目录），主人确认约定时会看到它。位置说得不具体时先问主人。发布到本机临时文件夹（/tmp 之下）或项目文件夹的不用填。';

/**
 * 校验并整理一个发布位置。通过时返回整理后的绝对路径（去掉多余斜线和末尾斜线，开头的 ~ 换成主目录）；
 * 不通过返回原因。检查顺序固定，同时有几处不合格时只报第一处。
 * 规则见任务卡 P81 第 1 节第 2 条与 P81r1 第 3.2 节；这个函数也用于发布命令运行前对「解析符号链接之后的实际路径」的再次核对。
 */
export function checkLocalDir(input: string, env: LocalDirEnv): LocalDirCheck {
  const fail = (reason: string): LocalDirCheck => ({ ok: false, reason });
  const text = input.trim();
  // 1. 字符：换行、看不见的字符、引号、反斜杠（原有规则；下面第 8 条还会逐段收紧到常见的名字字符）。
  if (BAD_CHARS.test(text) || hasInvisibleChars(text)) return fail(LOCAL_DIR_REASONS.badChars);
  if ([...text].length > LOCAL_DIR_MAX_CHARS) return fail(LOCAL_DIR_REASONS.tooLong);
  // 2. 开头的 ~ 换成主人的主目录；~user 之类不认。
  let absolute = text;
  if (text === '~' || text.startsWith('~/')) {
    if (env.homes.length === 0) return fail(LOCAL_DIR_REASONS.noHome);
    absolute = env.homes[0]! + text.slice(1);
  } else if (!text.startsWith('/')) {
    return fail(LOCAL_DIR_REASONS.notAbsolute);
  }
  const segments = segmentsOf(absolute);
  if (segments.some(part => part === '..')) return fail(LOCAL_DIR_REASONS.dotDot);
  // 3. 在主目录之下：按段比较，主目录可能有几种写法（例如符号链接前后）。
  if (env.homes.length === 0) return fail(LOCAL_DIR_REASONS.noHome);
  const home = env.homes.find(candidate => segmentsStartWith(segments, segmentsOf(candidate)) && segmentsOf(candidate).length > 0);
  if (home === undefined) return fail(LOCAL_DIR_REASONS.outsideHome);
  const rel = segments.slice(segmentsOf(home).length);
  // 4. 至少深两级（主目录下面的文件夹里的文件夹）。
  if (rel.length < 2) return fail(LOCAL_DIR_REASONS.tooShallow);
  // 5. 隐藏目录（含 . 这一段本身）。
  if (rel.some(part => part.startsWith('.'))) return fail(LOCAL_DIR_REASONS.hidden);
  // 6. P81r1：第一级只能是白名单里的五个（原来「不是 Library」的黑名单被这一条覆盖）。
  if (!FIRST_LEVELS.has(foldSegment(rel[0]!))) return fail(LOCAL_DIR_REASONS.firstLevel);
  // 7. P81r1：任何一段以应用程序包、资料库的结尾命名都拒绝。
  if (rel.some(part => APP_SUFFIXES.some(suffix => foldSegment(part).endsWith(suffix)))) return fail(LOCAL_DIR_REASONS.appBundle);
  // 8. P81r1：每一段只允许常见的名字字符（挡住全角斜线、顿号、$、反引号这类会让卡片或命令看起来像别的位置的写法）。
  if (rel.some(part => !SEGMENT_CHARS.test(part))) return fail(LOCAL_DIR_REASONS.badName);
  // 9. 不在中心数据目录等之内，也不是它们的上级目录（上下两个方向都查）。
  const covered = env.protectedRoots.some(root => {
    const rootSegments = segmentsOf(root);
    return rootSegments.length > 0 && (segmentsStartWith(segments, rootSegments) || segmentsStartWith(rootSegments, segments));
  });
  if (covered) return fail(LOCAL_DIR_REASONS.center);
  const path = `/${segments.join('/')}`;
  if ([...path].length > LOCAL_DIR_MAX_CHARS) return fail(LOCAL_DIR_REASONS.tooLong);
  return { ok: true, path };
}

/** 开头是 ~ 的路径换成绝对路径（设置里的目录写法可能带 ~）；不是 ~ 开头或取不到主目录时原样返回。 */
function expandHome(path: string, home: string | undefined): string {
  return home !== undefined && (path === '~' || path.startsWith('~/')) ? home + path.slice(1) : path;
}

/**
 * 校验用的环境：主人主目录来自 ctx.ownerHome（宿主插件在装配时传入 homedir()，见 plugin/src/host/index.ts）；
 * 必须避开的目录：中心根目录（含真实路径）、员工的文件夹、共享文件夹、所有项目的文件夹、工作数据目录、DSH 数据目录。
 * realHome 是主目录解析符号链接之后的真实路径（运行前核对时传入，可没有）。
 * P81r1（S7）：主目录本身是符号链接时，避开名单里以主目录开头的各项，都另算一份「真实主目录 + 其余各段」，
 * 否则按段比较对不上，运行前核对里这几项不起作用。
 */
export function localDirEnvOf(ctx: HubContext, realHome?: string): LocalDirEnv {
  const home = ctx.ownerHome?.replace(/\/+$/, '');
  const root = expandHome(ctx.settings.rootDir, home).replace(/\/+$/, '');
  const roots: string[] = [];
  const add = (path: string | undefined | null): void => { if (typeof path === 'string' && path.startsWith('/')) roots.push(path); };
  add(root);
  add(ctx.runtime?.realRootDir ?? undefined);
  add(`${root}/bots`);
  add(`${root}/shared`);
  add(`${root}/projects`);
  for (const bot of ctx.store.table('bots').list()) add(bot.homeDir);
  for (const project of ctx.store.table('projects').list()) {
    add(project.sharedDir);
    // W7a：主人挂接的工作文件夹只读，发布位置不能落在它里面，也不能是它的上级。
    add(project.workFolder?.path);
    add(project.workFolder?.realPath);
  }
  for (const raw of ctx.settings.workDataPaths ?? []) add(expandHome(raw, home));
  if (home) add(`${home}/.dsh`);
  // P81r1（S7）：主目录经链接时补上真实路径的写法（只加原来就在主目录之下的那几项）。
  const normalizedRealHome = realHome?.replace(/\/+$/, '');
  if (home && normalizedRealHome && normalizedRealHome !== home) {
    for (const protectedRoot of [...roots]) {
      if (!segmentsWithin(protectedRoot, home)) continue;
      roots.push(`${normalizedRealHome}${protectedRoot.slice(home.length)}`);
    }
  }
  const homes = [home, normalizedRealHome].filter((item): item is string => typeof item === 'string' && item.startsWith('/') && item !== '');
  return { homes: [...new Set(homes)], protectedRoots: roots };
}

/** 给主人看的「显示路径」：在主目录之下的写成 ~ 开头；取不到主目录或不在其下时显示完整路径。 */
export function localDirShown(path: string, ownerHome: string | undefined): string {
  const home = ownerHome?.replace(/\/+$/, '');
  if (!home || !segmentsWithin(path, home)) return path;
  const rest = segmentsOf(path).slice(segmentsOf(home).length);
  return rest.length === 0 ? '~' : `~/${rest.join('/')}`;
}

/** 句子切分用的标点（同一句里才算「同一句」；P81r1 起逗号也算断句）。 */
const SENTENCE_BREAK = /[。；;！!？?\r\n，,]/;
/** 说的是主人电脑上某个位置的词。 */
const PLACE_WORDS = ['桌面', '我电脑', '我的电脑', '本机'];
/** 说的是文件夹的词。 */
const FOLDER_WORDS = ['文件夹', '目录'];
/** P81r1（S5）：这些词所在的分句说的是服务器、云端或远程，不算本机位置。 */
const REMOTE_WORDS = ['服务器', '云端', '远程'];

/**
 * 发布方式（launch.how）里是不是「明显」写的是主人电脑上的位置（任务卡 P81 第 1 节第 5 条）。只认三种：
 * 1. 有以 ~ 开头的路径（~/ 开头，或单独一个 ~；单独一个 ~ 要求前面是行首或空白、后面是 /、空白或行尾，
 *    并且后面不能紧跟数字——「约 ~ 5 分钟后上线」不是位置）；
 * 2. 有以主人主目录开头的路径；
 * 3. 有「桌面」「我电脑」「我的电脑」「本机」之一，并且同一句里有「文件夹」或「目录」；
 *    逗号（全角、半角）也算断句，含「服务器」「云端」「远程」的分句不算（P81r1，S5）。
 * 例外：同时写了 /tmp 之下、或中心根目录（项目文件夹在它之下）之下的明确路径时，第 3 种不算。
 * 网址、服务器上的路径（没有上面的词、也不在主目录之下）不触发。
 */
export function howNamesLocalPlace(how: string, ctx: Pick<HubContext, 'ownerHome' | 'settings'>): boolean {
  const home = ctx.ownerHome?.replace(/\/+$/, '');
  const root = expandHome(ctx.settings.rootDir, home).replace(/\/+$/, '');
  // 单独一个 ~：前面是行首或空白，后面是 /、空白或行尾；后面紧跟数字的是「大约」，不算位置。
  for (const match of how.matchAll(/(?:^|\s)~(?=\/|\s|$)/g)) {
    const rest = how.slice(match.index + match[0].length);
    if (!/^\s*\d/.test(rest)) return true;
  }
  // 文字里的路径：以 / 或 ~/ 开头（前面不能紧跟路径字符，不从网址、别的路径中间截取），到空白或中文标点、括号、引号为止。
  const tokens = [...how.matchAll(/(?<![A-Za-z0-9_~@+\-./:])(?:~\/|\/)[^\s，。；、（）()「」"'“”]*/g)].map(match => match[0]);
  const isExempt = (path: string): boolean => segmentsWithin(path, '/tmp') || segmentsWithin(path, '/private/tmp') || (root.startsWith('/') && segmentsWithin(path, root));
  let hasExempt = false;
  for (const token of tokens) {
    const absolute = expandHome(token, home);
    // /tmp 之下、中心根目录（项目文件夹在它之下）之下的路径：不算本机位置，且这句话里第 3 种也不再触发。
    if (absolute.startsWith('/') && isExempt(absolute)) { hasExempt = true; continue; }
    // 第 1 种：~/ 开头的路径；第 2 种：以主人主目录开头的路径。
    if (token.startsWith('~/') || (home !== undefined && segmentsWithin(absolute, home))) return true;
  }
  if (hasExempt) return false;
  // 第 3 种：位置词加文件夹词在同一句里；服务器、云端、远程所在的分句不算。
  return how.split(SENTENCE_BREAK).some(sentence => !REMOTE_WORDS.some(word => sentence.includes(word))
    && PLACE_WORDS.some(word => sentence.includes(word)) && FOLDER_WORDS.some(word => sentence.includes(word)));
}
