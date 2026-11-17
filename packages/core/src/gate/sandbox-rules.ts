/**
 * 「审批跟着 DSH 沙箱走」的三条小规则（P69 A2、A5、A6），集中放在这里方便对照任务卡：
 *
 * 1. unsure：分类器看不懂一条命令时怎么办。沙箱开着就不再问主人（判 A，子类 sandboxed_exec），
 *    因为命令和文件工具在 DSH 的沙箱里只写得进家目录和临时目录；沙箱没确认就照旧要审批。
 * 2. 原文里的凭据字样（scanOpaque）：内联代码放行以后，python3 -c "open('~/.ssh/id_rsa')" 这类写法
 *    不再经过审批，所以在命令原文里找几种写死的凭据路径，命中直接拒绝。
 *    这是字符串匹配，拦不住拼接、编码、变量间接引用，属于尽力而为。
 * 3. 指路（sandboxGuidance）：写入目标在沙箱之外时，告诉队友该用哪个中心工具，不发审批卡。
 */
import { asksOf, mostDangerous, resolveGatePath, within } from './paths.js';
import type { Classification, GateContext } from './paths.js';

/** 沙箱开着、而且不是复盘回合：只有这时「看不懂」才不再问人。复盘是只读回合，照旧规则保守处理。 */
export function sandboxRelaxed(ctx: GateContext): boolean {
  return ctx.sandboxed === true && ctx.reflection !== true;
}

/**
 * 分类器拿不准的情况统一走这里。
 * 沙箱开着：判 A（不是只读），子类 sandboxed_exec，L0 和「本轮已交账」仍然会拦；
 * 沙箱没确认或复盘回合：保持原来的 C，要主人审批。
 */
export function unsure(ctx: GateContext, reason: string, subclass = 'run_command'): Classification {
  return sandboxRelaxed(ctx)
    ? { cls: 'A', reason: `在沙箱里运行，不再审批（${reason}）`, subclass: 'sandboxed_exec' }
    : { cls: 'C', reason, subclass };
}

/** 标准程序目录：绝对路径的程序只有在这几个目录里才按名字认，其余算「自定义路径程序」。 */
export const STANDARD_BIN_DIRS: readonly string[] = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

/**
 * R4 兜底检查不看的程序：它们要么是查找和说明类（which ssh 是在问 ssh 在哪，不是在运行它），
 * 要么只读文件、只换目录，永远不会把参数当命令来运行。名单只给兜底用，不加进只读白名单（那会改变不传 sandboxed 时的行为）。
 * 前半是总控裁定点名的；后半（pgrep 起）是实现时补的同类：它们的参数同样只是要查找或要读的名字，补上可以少误拦。
 */
export const WRAPPER_SCAN_SKIP: readonly string[] = [
  'which', 'type', 'whereis', 'whatis', 'man', 'tldr', 'help', 'hash', 'rg', 'ag', 'ack', 'fd',
  'pgrep', 'pidof', 'apropos', 'locate', 'mdfind', 'whence', 'file', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'shasum', 'md5', 'md5sum', 'sha256sum', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'printf',
  'cd', 'pushd', 'popd', 'export', 'unset', 'alias', 'unalias', 'test', '[', '[[', 'true', 'false', 'read', 'local', 'declare', 'typeset', 'shift', 'return', 'exit', 'source', '.',
];

/** 目录类强特征：命令原文里直接出现这些片段就算命中（按小写比较）。 */
const CREDENTIAL_SUBSTRINGS = ['.ssh/', '.dsh/', '.aws/', '.claude/', '.config/gcloud', 'library/keychains', '.netrc', '.codex/auth.json',
  // 卡片之外补充：浏览器资料目录里有登录状态和保存的密码，现有的路径规则本来就拦它。
  'application support/google/chrome'];
/** 凭据目录名没带斜杠、单独出现的写法，例如 Path.home() / ".ssh"。前后都要是分隔符，避免误伤普通单词。 */
const CREDENTIAL_DIR_NAME = /(?:^|[\s'"`/=(,:])\.(?:ssh|dsh|aws|claude)(?=$|[\s'"`),;\\])/m;
/** 私钥文件名。前面不能紧挨字母或数字，否则 valid_rsa 这样的变量名会被误伤。 */
const CREDENTIAL_KEY_NAME = /(?<![a-z0-9])id_(?:rsa|ed25519)/;
/** 作为独立文件名出现的 .env、.env.xxx：前面是引号、空白、斜杠或行首，后面是引号、空白或行尾。process.env 不算。 */
const CREDENTIAL_DOT_ENV = /(?:^|[\s'"`/])\.env(?:\.[a-z0-9_.-]+)?(?=$|[\s'"`])/m;

/**
 * 命令原文里有没有写死的凭据路径。只找强特征，不匹配 .key、.pem 这类后缀（代码里的 obj.key 会误伤）。
 * 写明了路径参数的情况不靠这里，照旧走路径规则。
 */
export function mentionsCredentialPath(raw: string): boolean {
  const text = raw.toLowerCase();
  return CREDENTIAL_SUBSTRINGS.some(marker => text.includes(marker))
    || CREDENTIAL_DIR_NAME.test(text) || CREDENTIAL_KEY_NAME.test(text) || CREDENTIAL_DOT_ENV.test(text);
}

/**
 * 命令原文里有没有写出尚未允许访问的工作数据目录（卡片之外补充）。
 * 工作数据和凭据一样是硬拦；内联代码放行以后，代码里写死的工作数据路径不会再被路径规则看到，
 * 所以在原文里找一下配置好的目录。命中不直接拒绝，只是把这条命令留在审批里，和现在的处理一致。
 */
export function mentionsWorkData(raw: string, ctx: GateContext): boolean {
  if (ctx.workDataAllowed) return false;
  const text = raw.toLowerCase();
  return (ctx.workDataPaths ?? []).some(configured => {
    const resolved = resolveGatePath(configured, { ...ctx, cwd: undefined });
    // 配置里写的原样和展开后的绝对路径都找；后面必须是路径边界，/company 不会命中 /company-archive。
    return [...new Set([configured, resolved])].some(root => {
      const needle = root.replace(/\/+$/, '').toLowerCase();
      if (needle.length < 2) return false;
      let at = text.indexOf(needle);
      while (at >= 0) {
        const next = text[at + needle.length];
        if (next === undefined || /[/\s'"`),;:]/.test(next)) return true;
        at = text.indexOf(needle, at + 1);
      }
      return false;
    });
  });
}

/**
 * 把原文里「只是被写进文件的文字」拿掉（R10）。只拿掉它在原文里作为 here-document 正文（各行单独成行）或
 * here-string（<<< 后面）出现的那一处，每段文字只拿第一处；不能用「把这段文字在全文里全部删掉」，
 * 否则 .gitignore 里写的一行 .env 会把后面 python3 -c "open('.env')" 里的 .env 也一起删掉，漏检。
 */
export function withoutSafeText(raw: string, texts: readonly string[]): string {
  let result = raw;
  for (const text of texts) {
    if (!text) continue;
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heredoc = new RegExp(`(^|\\n)${escaped}(?=\\n|$)`);
    result = heredoc.test(result) ? result.replace(heredoc, '$1') : result.replace(new RegExp(`<<<\\s*(['"]?)${escaped}\\1`), '<<<');
  }
  return result;
}

/**
 * 对一条已经分好类的命令做原文检查。只在宿主确认沙箱开着、而且命令里确实有
 * 内联代码、here-document 或无法解析的部分时才做；其余情况原样返回。
 */
export function scanOpaque(action: Classification, raw: string, ctx: GateContext): Classification {
  if (ctx.sandboxed !== true || action.opaque !== true || action.cls === 'protected') return action;
  // 只是被 cat、tee 写进文件的 here-document 正文（R10）不是代码，先从原文里拿掉再找：.gitignore 里的一行 .env 不算碰凭据。
  raw = withoutSafeText(raw, action.safeText ?? []);
  if (mentionsCredentialPath(raw)) return { cls: 'protected', reason: '命令里出现了凭据路径', paths: action.paths ?? [] };
  if (mentionsWorkData(raw, ctx)) return mostDangerous([action, { cls: 'C', reason: '命令里出现了尚未允许访问的工作数据目录，需要审批', subclass: 'run_command' }]);
  return action;
}

/** 指路的话里列出被拦的目标：最多 3 个，用顿号连接，超过的写「等 n 处」（n 为没列出的个数）。 */
export function listTargets(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return '这个位置';
  const shown = unique.slice(0, 3).join('、');
  return unique.length > 3 ? `${shown}等 ${unique.length - 3} 处` : shown;
}
/** 目标在队友自己所在项目的项目文件夹里（P74r16a 起指路的话带上被拦的路径）。 */
export const guideProject = (paths: readonly string[]): string =>
  `${listTargets(paths)}在项目文件夹里，不能用你自己的工具直接写。把文件先做在你的文件夹里，再用 hub_project_put 放进项目，不需要主人批准。`;
/** 目标在共享目录里。 */
export const guideShared = (paths: readonly string[]): string =>
  `${listTargets(paths)}在共享目录里，不能用你自己的工具直接写。用 hub_outbox_submit（kind 为 write_file）写入，不需要主人批准。`;
/** 目标在其他位置。 */
export const guideOther = (paths: readonly string[]): string =>
  `${listTargets(paths)}不在你的工作区里，写不进去。自己的文件用相对路径写在你的文件夹里，临时文件写到 /tmp 下；确实要写到别处，用 hub_outbox_submit（kind 为 write_file 或 run_command）并写清原因，主人确认后由中心执行。`;

/**
 * 这次调用是不是「沙箱本来就会拦的写入」：宿主确认沙箱开着，而且所有要确认的事都只是因为目标在沙箱外。
 * 同一条命令里只要还有别的对外动作（比如同时 git push），就不算，照旧走审批。
 */
export function isSandboxBlocked(action: Classification, ctx: GateContext): boolean {
  return ctx.sandboxed === true && (action.cls === 'C' || action.cls === 'D') && action.blocked === true;
}

/**
 * 按目标所在的位置挑指路的话。一条命令同时写了几种位置时，每种各说一句，顺序固定：项目、共享、其他。
 * 判断只看分类器记下的目标路径，不靠匹配中文理由。
 */
export function sandboxGuidance(action: Classification, ctx: GateContext): string {
  const targets = asksOf(action).filter(ask => ask.blocked === true).flatMap(ask => ask.paths ?? []);
  const of = (kind: 'project' | 'shared' | 'other'): string[] => targets.filter(path => (ctx.projectDirs ?? []).some(dir => within(path, dir)) ? kind === 'project'
    : within(path, ctx.sharedDir) ? kind === 'shared' : kind === 'other');
  const [project, shared, other] = [of('project'), of('shared'), of('other')];
  // 没有可列出的目标路径时（理论上不会发生）仍给出「其他位置」那一句，保证队友总能看到指路。
  const lines = [project.length ? guideProject(project) : null, shared.length ? guideShared(shared) : null,
    other.length || targets.length === 0 ? guideOther(other) : null].filter((line): line is string => line !== null);
  return lines.join('\n');
}
