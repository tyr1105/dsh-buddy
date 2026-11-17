/**
 * 访问本机地址的网络命令不算「向外部网址发送数据」（P74r9 第 4 节）。
 *
 * 为什么需要：执行者用 curl 访问自己在本机起的服务（例如 http://127.0.0.1:8000/…）做自测，原来被判为
 * 「向外部网址发送数据」，要主人批准；数据其实没有离开这台电脑。
 *
 * 判断必须保守，所以有几条硬规则：
 * 1. 只按「地址解析之后的主机名」判断（用 URL 解析），不按字符串开头判断：http://localhost.evil.example/ 的主机名是
 *    localhost.evil.example，不是本机；http://127.0.0.1@evil.example/ 里 127.0.0.1 只是用户名，真正的主机是 evil.example。
 * 2. 主机名只认 localhost、127.0.0.1、[::1]（协议只认 http、https）；带用户名密码（authority 里出现 @）的地址不算本机。
 * 3. 命令里出现的全部地址都是本机才算；有一个不是、解析不出来（例如 http://$HOST/、端口写成变量）、或者命令里有看不懂的选项
 *    （代理、改解析、跟随跳转、读配置文件这类能把请求送到别处的选项一律不认），就保持原来的判定。
 * 本文件只做判断，不分类；怎样接进分类见 gate/network-options.ts（curl、wget）和 gate/outward-commands.ts（http、httpie、xh）。
 */

/** 本机的三种写法（按解析后的主机名比较）。 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 这个文字是不是 http 或 https 开头的本机地址（含端口、路径、查询串）。 */
export function isLocalHttpUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  // authority（第二个斜杠之后、下一个 / ? # 之前）里出现 @ 说明带了用户名密码，不算本机；这一步看原文，不依赖解析结果。
  const authority = /^https?:\/\/([^/?#]*)/i.exec(text)?.[1] ?? '';
  if (authority.includes('@')) return false;
  // P74r13：主机名里有非 ASCII 字符（例如全角字母写的 localhost）不算本机：URL 解析会把它规范成 localhost，
  // 但不支持国际化域名的 curl 会把原文交给域名解析，可能解析到别处。同样看原文，不依赖解析结果。
  if (/[^\x00-\x7f]/.test(authority)) return false;
  try {
    const url = new URL(text);
    if (url.username !== '' || url.password !== '') return false;
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    // 解析不出来（端口写成变量、主机里有非法字符等）一律不算本机。
    return false;
  }
}

/** 一个命令能认的选项：不带值的、带值的（值是下一个词，或写在 = 后面 / 短选项后面）。 */
interface LocalOptionSet {
  shortFlags: string; // 不带值的短选项字符
  shortValues: string; // 带值的短选项字符
  longFlags: readonly string[]; // 不带值的长选项
  longValues: readonly string[]; // 带值的长选项
}

/**
 * curl 的可认选项。不在表里的选项（-L 跟随跳转、-x 代理、-K 读配置、--connect-to、--resolve 等）一律不认：
 * 它们能把请求送到别的主机，不能再说「只是访问本机」。
 */
const CURL_OPTIONS: LocalOptionSet = {
  shortFlags: 'sSfIivkgNG#O',
  shortValues: 'XHdFAemTuwoDb',
  longFlags: ['--silent', '--show-error', '--fail', '--include', '--head', '--verbose', '--compressed', '--globoff', '--no-buffer', '--get', '--insecure',
    '--fail-with-body', '--no-progress-meter', '--progress-bar'],
  longValues: ['--request', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--json', '--user-agent', '--referer',
    '--max-time', '--connect-timeout', '--cookie', '--user', '--output', '--upload-file', '--write-out', '--retry', '--dump-header'],
};
/** wget 的可认选项（同样不认代理、跟随等选项）。 */
const WGET_OPTIONS: LocalOptionSet = {
  shortFlags: 'qSv',
  shortValues: 'OPTtU',
  longFlags: ['--quiet', '--verbose', '--spider', '--no-check-certificate', '--server-response'],
  longValues: ['--post-data', '--post-file', '--header', '--method', '--body-data', '--body-file', '--timeout', '--tries', '--user-agent',
    '--output-document', '--directory-prefix'],
};

/**
 * curl、wget 的全部地址是不是都是本机，且命令里没有看不懂的选项。
 * 按选项表把命令拆开：选项和它的值都认得，剩下的每个词都当作地址（--url 的值也是地址）；有任何一个不是本机地址就返回 false。
 */
function optionedLocalOnly(args: readonly string[], options: LocalOptionSet): boolean {
  const addresses: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { addresses.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      if (name === '--url') {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) return false;
        addresses.push(value);
      } else if (options.longValues.includes(name)) {
        if (eq < 0 && ++i >= args.length) return false;
      } else if (!options.longFlags.includes(name) || eq >= 0) return false;
    } else if (arg.startsWith('-') && arg !== '-') {
      for (let n = 1; n < arg.length; n++) {
        const flag = arg[n]!;
        if (options.shortValues.includes(flag)) {
          // 带值的短选项：值是本词余下的部分，或者下一个词。
          if (n === arg.length - 1 && ++i >= args.length) return false;
          break;
        }
        if (!options.shortFlags.includes(flag)) return false;
      }
    } else addresses.push(arg);
  }
  return addresses.length > 0 && addresses.every(isLocalHttpUrl);
}

/** curl：命令里的全部地址都是本机（带协议的 http、https 写法），且选项都认得。没写协议的地址不认（保持原判定）。 */
export function curlLocalOnly(args: readonly string[]): boolean {
  return optionedLocalOnly(args, CURL_OPTIONS);
}

/**
 * wget：同上；另外 P74r13 起，命令里必须写 --max-redirect=0（或 --max-redirect 0）。
 * 为什么：wget 默认最多跟随 20 次跳转，本机服务回一个跳转，wget 会把同一请求体再发给跳转后的外部地址；
 * curl 只有加 -L 才跟随，-L 本来就不认。没有这个选项的 wget 不按「只访问本机」放行，保持原来的判定。
 */
export function wgetLocalOnly(args: readonly string[]): boolean {
  const rest: string[] = [];
  let noRedirect = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--max-redirect=0') { noRedirect = true; continue; }
    if (arg === '--max-redirect' && args[i + 1] === '0') { noRedirect = true; i++; continue; }
    rest.push(arg);
  }
  return noRedirect && optionedLocalOnly(rest, WGET_OPTIONS);
}

/** httpie、xh 的请求项（key=value、key:=json、key==value、key@file）：不是地址。 */
const REQUEST_ITEM = /^[^=:@/?&]+(?::=|==|=(?!=)|@)/;
/** httpie、xh 可认的选项：不带值的几个，和写成 --opt=值 的几个；不认代理、跟随跳转、会话等。 */
const HTTPIE_FLAGS: ReadonlySet<string> = new Set(['--json', '-j', '--form', '-f', '--verbose', '-v', '--headers', '-h', '--body', '-b', '--ignore-stdin', '-I',
  '--check-status', '--quiet', '-q', '--insecure']);
const HTTPIE_EQ_OPTIONS = /^--(?:print|pretty|timeout|style)=[A-Za-z0-9.-]*$/;

/**
 * httpie、xh：请求的地址（第一个操作数；前面可以有一个只由字母组成的方法词）是不是本机。
 * 地址可以不写协议：「localhost:8000/x」「:8000/x」按 http 补全（httpie 的约定）；选项不在可认表里就返回 false。
 * 地址之后的词都是请求项，不是地址（httpie 自己会拒绝不是请求项的词）。
 */
export function httpieLocalOnly(args: readonly string[]): boolean {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '-') {
      if (!HTTPIE_FLAGS.has(arg) && !HTTPIE_EQ_OPTIONS.test(arg)) return false;
    } else words.push(arg);
  }
  if (words.length === 0) return false;
  // 第一个词只由字母组成、后面还有不是请求项的词时，它是方法（GET、POST 等），地址是后一个词。
  const at = /^[A-Za-z]+$/.test(words[0]!) && words.length > 1 && !REQUEST_ITEM.test(words[1]!) ? 1 : 0;
  const operand = words[at]!;
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(operand) ? operand : operand.startsWith(':') ? `http://localhost${operand}` : `http://${operand}`;
  return isLocalHttpUrl(full);
}
