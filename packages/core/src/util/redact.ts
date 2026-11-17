/**
 * 隐去像密钥的内容（P75r5c 第 6 节第 2 条，审查 M6；P75r6 第 6 节补漏网与误伤，复验 N6）。
 *
 * 做什么：把一段文字里「看起来像密钥、令牌、私钥」的部分替换成「（已隐去）」，其余原样保留。
 * 为什么需要：学习要读主人 DSH 会话的摘要；主人在会话里可能贴过密钥。摘要会被存进学习记录、抄成技能出处（永久保存），
 * 还会发给学习的员工、核对人、改写回合，甚至写进技能句子、再落成员工家目录里的技能文件。
 * 所以摘要（和会话标题）在存进任何地方之前先经过这个函数，之后所有读它的地方拿到的都是已隐去的版本。
 *
 * 只认「长得像」：宁可多隐去一点，也不放过。但普通的中文句子、短的版本号、网址、文件路径、一般的英文单词不能被误伤。
 * 纯函数：不读时钟、不读存储、不联网；同一输入总是同一输出（重复调用结果不变）。
 *
 * P75r6 新增（编号对应任务卡第 6 节）：
 * 漏网：1 网址里的用户名密码段；2 sk_/rk_/pk_ 加 live_/test_；3 名字里带一个空格（api key 等）；4 Authorization 后的值；
 * 5 带引号的值整段隐去；6 值写在下一行；7 中文「密码是……」；8 网址查询串里的 key、auth、sig 等。
 * 误伤：9 token 只在是完整的一段时算名字；10 短纯数字与 true、false、null、none 不隐去；
 * 11 提交号（40 位十六进制，前面 16 个字符内有「提交」「commit」等）不隐去；12 路径与驼峰标识符不隐去。
 * 方法的固有限制：断行或夹了空格的密钥（例如 sk-abcd 换行 efgh……）认不出来，不在隐去范围内。
 */

/** 替换成的文字。 */
export const REDACTED = '（已隐去）';

/** 左边界：前一个字符不能是字母或数字（避免把单词中间的 sk- 之类误判，例如 risk-assessment）。 */
const LEFT = '(?<![A-Za-z0-9])';

/** 成块的私钥：从 -----BEGIN 到 -----END ... -----；没有结尾（摘要被截断）时从 BEGIN 隐去到文末。 */
const PRIVATE_KEY_BLOCK = /-----BEGIN[^\n]*?-----[\s\S]*?(?:-----END[^\n]*?-----|$)/g;

/** Bearer 加空格后接 20 位以上的一段（令牌常用的字符）。整个「Bearer …」隐去。 */
const BEARER = /Bearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/g;

/**
 * 第 1 条：网址里的用户名密码段「协议://用户名:密码@主机」，只隐去密码段（任何协议，包括数据库连接串）。
 * 密码里不含空白、斜线、@（含这些字符的密码在网址里本来就要转义）。
 */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

/** 常见前缀的密钥，每条规则一个正则（都带左边界）。 */
const PREFIXED_KEYS: RegExp[] = [
  new RegExp(`${LEFT}(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}`, 'g'), // sk-、pk-、rk- 后接 16 位以上
  // 第 2 条：下划线写法，sk_、rk_、pk_ 后接 live_ 或 test_ 再接 16 位以上。
  new RegExp(`${LEFT}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{16,}`, 'g'),
  new RegExp(`${LEFT}(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}`, 'g'), // GitHub 令牌
  new RegExp(`${LEFT}github_pat_[A-Za-z0-9_]{20,}`, 'g'),
  new RegExp(`${LEFT}AKIA[A-Z0-9]{16}`, 'g'), // AWS 访问密钥编号
  new RegExp(`${LEFT}AIza[A-Za-z0-9_-]{30,}`, 'g'), // Google API 密钥
  new RegExp(`${LEFT}xox[bparso]-[A-Za-z0-9-]+`, 'g'), // Slack 令牌：xoxb-、xoxp-、xoxa-、xoxr-、xoxs- 开头的一段
];

/**
 * 第 4 条：「Authorization」加冒号，保留认证方式那个词（Basic、Bearer、Digest……），后面的一段值隐去。
 * 值至少 8 个字符（免得把「Authorization: Bearer token 的写法」这类说明里的词也隐去）。
 * 「Bearer 加 20 位以上」已由 BEARER 先处理，这里处理它没覆盖的（Basic、较短的 Bearer 等）。
 */
const AUTHORIZATION = /(\bAuthorization[ \t]*:[ \t]*[A-Za-z][A-Za-z0-9-]*[ \t]+)([^\s（][^\s]{7,})/gi;

/**
 * 「名字加分隔符再加值」的名字部分（不分大小写）：
 * - 英文名字含 api_key、apikey、api-key、secret、token、password、passwd（前后允许点、下划线、连字符、字母数字）；
 * - 第 3 条：名字里带一个空格的 api key、secret key、access key、private key；
 * - 中文名字取连续的汉字，含 密钥、密码、口令、令牌。
 * token 是否「完整的一段」留给回调判断（第 9 条）。
 */
const NAME = '(?:[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_.-]*'
  + `|${LEFT}(?:api|secret|access|private) key`
  + '|[一-鿿]*(?:密钥|密码|口令|令牌)[一-鿿]*)';

/**
 * 值：第 5 条，带引号的值隐去到配对的引号为止（值里有空格时整段隐去）；否则取到空白为止。
 * 没有配对的引号时退回「到空白为止」。
 */
const VALUE = `(?:"[^"\\n]*"|'[^'\\n]*'|\\S+)`;

/** 名字、分隔符（名字后可能有引号，分隔符前后只允许空格和制表符）、值在同一行。 */
const NAME_VALUE = new RegExp(`(${NAME})(["']?[ \\t]*[=:：＝][ \\t]*)(${VALUE})`, 'gi');

/** 第 6 条：名字加冒号结尾、这一行没有值，值写在下一行第一段不含空白的文字。 */
const NAME_NEXT_LINE = new RegExp(`(${NAME})(["']?[ \\t]*[=:：＝][ \\t]*\\r?\\n[ \\t]*)(\\S+)`, 'gi');

/**
 * 第 7 条：中文写法「密码是 abc123」「密码 abc123」：名字后面跟「是」「为」或空格，
 * 再跟一段不含空白、长度不少于 6、同时含字母和数字的文字（取可见的 ASCII 字符，遇到中文标点就停）。
 */
const CHINESE_SPOKEN = /((?:密钥|密码|口令|令牌)(?:[是为][ \t]*|[ \t]+))([\x21-\x7e]{6,})/g;

/** 第 8 条：网址查询串里「?」或「&」后面的 key、access_key、auth、signature、sig 等于 12 位以上的值。 */
const QUERY_SECRET = /([?&](?:access_key|signature|auth|key|sig)=)([^&\s#"'<>]{12,})/gi;

/** 连续 40 位以上的十六进制串（哈希、密钥常见）。左右不能紧挨字母数字。 */
const LONG_HEX = /(?<![A-Za-z0-9])[0-9a-fA-F]{40,}(?![A-Za-z0-9])/g;

/** 连续 48 位以上的 base64 字符串（字母数字加 + / = _ -）。 */
const LONG_BASE64 = /[A-Za-z0-9+/=_-]{48,}/g;

/** 第 11 条：40 位十六进制前面 16 个字符内（同一行）出现这些词时，它是提交号一类，不隐去。 */
const HASH_CONTEXT = /提交|commit|sha|hash|版本|revision/i;

/** 第 10 条：值是不到 8 位的纯数字，或 true、false、null、none 时不隐去。 */
function harmlessValue(value: string): boolean {
  return /^\d{1,7}$/.test(value) || /^(?:true|false|null|none)$/i.test(value);
}

/**
 * 第 9 条：名字里的 token 只在是完整的一段时才算：整个名字是 token，或以 _token、-token、.token 结尾
 * （另外把驼峰写法 accessToken 这样以大写 Token 结尾的也算，否则 JSON 里常见的 accessToken 会漏）；
 * max_tokens、tokens、tokenizer、token_count 这类不算。其余关键词（api_key、secret、password、passwd）照旧，名字里含就算。
 * 中文名字与带空格的名字没有这个问题，一律算。
 */
function qualifiesAsName(name: string): boolean {
  if (/[一-鿿]/.test(name) || / /.test(name)) return true;
  if (/api[_-]?key|secret|password|passwd/i.test(name)) return true;
  return /(?:^|[_.-])token$/i.test(name) || /[a-z0-9]Token$/.test(name);
}

/** 带引号的值取引号里面的文字判断，其余取原文。 */
function innerOf(value: string): string {
  return /^(["']).*\1$/.test(value) && value.length >= 2 ? value.slice(1, -1) : value;
}

/** 把「名字、分隔符、值」里的值换成隐去的文字；带引号的值保留引号（读起来仍是一个字符串）。 */
function replaceValue(value: string): string {
  const quote = /^(["']).*\1$/.test(value) && value.length >= 2 ? value[0]! : '';
  return `${quote}${REDACTED}${quote}`;
}

/**
 * base64 的字符集（字母数字加 + / = _ -）也能拼出文件路径、短横线连起来的长单词、驼峰标识符，这几种不是密钥，不能误伤：
 * - 带斜线的：有两个以上斜线、每一段都不超过 40 个字符时按路径处理（第 12 条）；否则要求同时含数字、大写字母、小写字母才隐去
 *   （真正的随机密钥几乎一定三样都有）；
 * - 带短横线或下划线、但全是小写字母（没有数字、没有大写）的（短横线命名的长单词、文件名）：不隐去；
 * - 只有字母和数字、数字不超过 3 个、小写字母连续出现的平均长度不少于 3.5 的（驼峰写法的长标识符，第 12 条后半）：不隐去；
 *   随机的字母数字串数字多、小写字母断断续续，几乎不会同时满足；
 * - 其余（例如整串字母、整串 base64）一律隐去。
 */
function looksRandom(token: string): boolean {
  if (token.includes('/')) {
    const parts = token.split('/');
    if (parts.length >= 3 && parts.every(part => part.length <= 40)) return false;
    return /[0-9]/.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token);
  }
  if (/[-_]/.test(token) && !/[0-9A-Z]/.test(token)) return false;
  if (/^[A-Za-z0-9]+$/.test(token)) {
    const digits = (token.match(/[0-9]/g) ?? []).length;
    const lowerRuns = token.match(/[a-z]+/g) ?? [];
    const averageRun = lowerRuns.length === 0 ? 0 : lowerRuns.join('').length / lowerRuns.length;
    if (digits <= 3 && averageRun >= 3.5) return false;
  }
  return true;
}

/** 隐去像密钥的内容；没有可隐去的内容时原样返回。 */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED).replace(BEARER, REDACTED);
  out = out.replace(URL_USERINFO, (_all, head: string, _password: string, at: string) => `${head}${REDACTED}${at}`);
  for (const pattern of PREFIXED_KEYS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTHORIZATION, (_all, head: string) => `${head}${REDACTED}`);
  // 同一行的「名字 分隔符 值」；不够格的名字（第 9 条）和无害的值（第 10 条）原样保留。
  out = out.replace(NAME_VALUE, (all, name: string, separator: string, value: string) => {
    if (!qualifiesAsName(name) || harmlessValue(innerOf(value)) || innerOf(value) === '') return all;
    return `${name}${separator}${replaceValue(value)}`;
  });
  // 值在下一行（第 6 条）：值至少 6 个字符，免得把下一行的列表符号、序号当成值。
  out = out.replace(NAME_NEXT_LINE, (all, name: string, separator: string, value: string) => {
    if (!qualifiesAsName(name) || harmlessValue(innerOf(value)) || [...value].length < 6) return all;
    return `${name}${separator}${replaceValue(value)}`;
  });
  // 中文写法（第 7 条）：值同时含字母和数字才隐去；值后面紧跟的英文标点留下。
  out = out.replace(CHINESE_SPOKEN, (all, head: string, run: string) => {
    const value = run.replace(/[.,;:!?)\]}"']+$/, '');
    const tail = run.slice(value.length);
    if ([...value].length < 6 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return all;
    return `${head}${REDACTED}${tail}`;
  });
  out = out.replace(QUERY_SECRET, (_all, head: string) => `${head}${REDACTED}`);
  // 40 位十六进制：前面 16 个字符内（同一行）有「提交」「commit」等词时是提交号，不隐去（第 11 条）；其余照旧。
  out = out.replace(LONG_HEX, (all, ...rest: unknown[]) => {
    const offset = rest[rest.length - 2] as number;
    const whole = rest[rest.length - 1] as string;
    if (all.length === 40) {
      const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
      const before = whole.slice(Math.max(lineStart, offset - 16), offset);
      if (HASH_CONTEXT.test(before)) return all;
    }
    return REDACTED;
  });
  out = out.replace(LONG_BASE64, token => (looksRandom(token) ? REDACTED : token));
  return out;
}
