/**
 * 小型 shell 词法器：只提取每段命令、重定向和嵌套替换，不执行 shell；拿不准的语法交给审批。
 *
 * P69 加了一个「沙箱模式」（options.sandbox），只在宿主确认沙箱开着时由分类器打开；不打开时逐字保持原来的行为。
 * 为什么需要它：原来看不懂的写法一律问主人，词法器粗一点没关系；沙箱开着以后看不懂的写法不再问，
 * 词法器就必须把「对外命令藏在哪」认准。沙箱模式多认四样东西：
 * - here-document（<<EOF … EOF）：正文是喂给命令的文字，不再被当成一行行命令；
 * - here-string（<<< "文字"）：同上；
 * - 圆括号和单独的花括号：子外壳、命令分组、函数体、case 分支，里面的命令照样逐条分类；
 * - ${变量}：当作普通的变量展开，不算「看不懂」。
 */
import { C03_DEFAULTS } from '../config/defaults.js';
export interface ShellPart {
    words: string[];
    redirects: Array<{
        path: string;
        write: boolean;
    }>;
    dynamic: boolean;
    /** 仅沙箱模式：这条命令带的 here-document 正文；quoted 为真表示定界符带引号，正文不会被外壳展开。 */
    heredocs?: Array<{ body: string; quoted: boolean }>;
    /** 仅沙箱模式：这条命令带的 here-string（<<< 后面那段文字）。 */
    hereStrings?: string[];
    /** 仅沙箱模式：这一段的输出接到了下一段（后面紧跟着 | 或 |&）。 */
    pipesOn?: boolean;
    /** 仅沙箱模式：这一段的输入来自前一段（前面紧挨着一个 |）。 */
    piped?: boolean;
    /** 仅沙箱模式（A-3b，T2）：这一段的词里 $(…) 和反引号命令替换里运行的命令段。用来认出 sh -c "$(curl …)" 这类写法。 */
    substitutions?: ShellPart[];
    /** 仅沙箱模式（A-3b，T2）：这一段后面跟的进程替换 <(…) 里运行的命令段。用来认出 source <(curl …) 这类写法。 */
    processSubstitutions?: ShellPart[];
    /**
     * P75r5a：这一段与前一段之间的连接符；第一段为 null。沙箱开、关两种模式都记。
     * 括号、命令替换等嵌套展开出来的段，前后关系说不清，记 ';'（使用方按「不确定」偏保守处理）。
     * 只是新增的信息，不改变分段方式和任何已有字段。
     */
    joinedBy: ShellJoin | null;
}
/** 段与段之间的连接符：&&、||、;、| （含 |&）、&、换行。 */
export type ShellJoin = '&&' | '||' | ';' | '|' | '&' | 'newline';
/** 从 from（括号的下一个位置）开始找配对的右括号，跳过引号和反斜杠；找不到返回 -1。 */
function closingParen(source: string, from: number): number {
    let level = 1, quote = '';
    for (let at = from; at < source.length; at++) {
        const c = source[at]!;
        if (c === '\\' && quote !== "'") { at++; continue; }
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(') level++;
        else if (c === ')' && --level === 0) return at;
    }
    return -1;
}
export interface ShellParse {
    parts: ShellPart[];
    valid: boolean;
}
export interface LexOptions {
    /** 宿主确认沙箱开着时由分类器打开；缺省关闭，行为与 P69 之前完全一致。 */
    sandbox?: boolean;
}
/** 引号不丢失词边界，命令替换独立递归，防止把危险子命令藏在安全命令的参数里。 */
export function lexShell(source: string, depth = 0, maxDepth: number = C03_DEFAULTS.maxCommandDepth, options?: LexOptions): ShellParse {
    if (depth > maxDepth) return { parts: [], valid: false };
    const sandbox = options?.sandbox === true;
    const parts: ShellPart[] = [];
    let part: ShellPart = { words: [], redirects: [], dynamic: false, joinedBy: null };
    // P75r5a：最近一次遇到的连接符，下一个真正产生的命令段用它做 joinedBy。
    let nextJoin: ShellJoin | null = null;
    /** 把嵌套展开出来的段并入结果：这些段与前后的关系说不清，除了整个结果的第一段，一律记 ';'。 */
    const pushNested = (inner: ShellPart[]): void => {
        for (const item of inner) parts.push({ ...item, joinedBy: parts.length === 0 ? null : ';' });
    };
    let word = '';
    let wordStarted = false;
    let quote = '';
    let i = 0;
    let redirect: boolean | null = null;
    let descriptorRedirect = false;
    let valid = true;
    // 以下三个状态只在沙箱模式下使用。
    let hereString = false;
    let braceDepth = 0;
    // 沙箱模式：刚遇到过管道符，下一个真正产生的命令段就是「被管道喂入」的。
    let pendingPipe = false;
    const pendingHeredocs: Array<{ entry: { body: string; quoted: boolean }; delimiter: string; stripTabs: boolean; owner: ShellPart }> = [];
    /** 将当前词语保存为参数或重定向目标，保留命令词法边界。 */
    const flushWord = () => {
        if (!wordStarted)
            return;
        if (hereString) {
            // <<< 后面的词是喂给命令的文字，不是文件，也不是参数。
            (part.hereStrings ??= []).push(word);
            hereString = false;
        }
        else if (redirect !== null) {
            // >& / <& 后的数字、关闭符或移动描述符没有文件目标；普通 >1 仍要检查文件 1。
            // 在完整目标词结束后判断，才能同样处理空格、引号和相邻的下一次重定向。
            if (!descriptorRedirect || !/^(?:[0-9]+-?|-)$/.test(word))
                part.redirects.push({ path: word, write: redirect });
            redirect = null;
            descriptorRedirect = false;
        }
        else
            part.words.push(word);
        word = '';
        wordStarted = false;
    };
    /** 结束当前命令段并检查未完成重定向，使复合命令可以逐段分类。 */
    const flushPart = () => {
        flushWord();
        if (redirect !== null)
            valid = false;
        if (part.words.length || part.redirects.length || part.heredocs?.length || part.hereStrings?.length) {
            if (sandbox && pendingPipe) part.piped = true;
            pendingPipe = false;
            // P75r5a：第一段没有前一段；其余取最近的连接符，括号等边界前面没有连接符的记 ';'。
            part.joinedBy = parts.length === 0 ? null : (nextJoin ?? ';');
            parts.push(part);
            nextJoin = null;
        }
        part = { words: [], redirects: [], dynamic: false, joinedBy: null };
        redirect = null;
        descriptorRedirect = false;
        hereString = false;
    };
    /** 读取反引号或括号命令替换的完整边界，把内部命令交给同一风险分类。 */
    const substitution = (backtick: boolean): void => {
        const start = i + (backtick ? 1 : 2);
        let at = start;
        let depth = 1;
        let subQuote = '';
        while (at < source.length) {
            const c = source[at]!;
            if (c === '\\') {
                at += 2;
                continue;
            }
            if (backtick && c === '`')
                break;
            if (!backtick) {
                if (subQuote) {
                    if (c === subQuote)
                        subQuote = '';
                }
                else if (c === '"' || c === "'")
                    subQuote = c;
                else if (c === '(')
                    depth++;
                else if (c === ')' && --depth === 0)
                    break;
            }
            at++;
        }
        if (at >= source.length) {
            valid = false;
            i = source.length;
            return;
        }
        const inner = lexShell(source.slice(start, at), depth + 1, maxDepth, options);
        pushNested(inner.parts);
        // 沙箱模式：记下这段替换里跑的命令，分类器要看它是不是下载（sh -c "$(curl …)"）。
        if (sandbox) (part.substitutions ??= []).push(...inner.parts);
        valid &&= inner.valid;
        part.dynamic = true;
        word += '__dynamic__';
        wordStarted = true;
        i = at + 1;
    };
    /**
     * 沙箱模式：读 << 后面的定界符，登记一段等着读正文的 here-document，返回定界符之后的位置。
     * 定界符只要带引号或反斜杠，正文就原样交给命令；不带的话外壳会展开其中的 $(…) 和反引号。
     */
    const startHeredoc = (from: number): number => {
        let at = from;
        const stripTabs = source[at] === '-';
        if (stripTabs) at++;
        while (source[at] === ' ' || source[at] === '\t') at++;
        let delimiter = '';
        let quoted = false;
        while (at < source.length) {
            const c = source[at]!;
            if (c === "'" || c === '"') {
                quoted = true;
                const close = source.indexOf(c, at + 1);
                if (close < 0) { valid = false; at = source.length; break; }
                delimiter += source.slice(at + 1, close);
                at = close + 1;
                continue;
            }
            if (c === '\\') {
                quoted = true;
                if (at + 1 < source.length) delimiter += source[at + 1];
                at += 2;
                continue;
            }
            if (/\s/.test(c) || '|;&<>()'.includes(c)) break;
            delimiter += c;
            at++;
        }
        if (!delimiter) { valid = false; return at; }
        const entry = { body: '', quoted };
        (part.heredocs ??= []).push(entry);
        pendingHeredocs.push({ entry, delimiter, stripTabs, owner: part });
        return at;
    };
    /** 沙箱模式：没带引号的 here-document 正文里，$(…) 和反引号会被外壳真的执行，要拿出来单独分类。 */
    const scanHeredocExpansions = (body: string, owner: ShellPart): void => {
        let at = 0;
        const nested = (text: string): void => {
            const inner = lexShell(text, depth + 1, maxDepth, options);
            pushNested(inner.parts);
            valid &&= inner.valid;
            owner.dynamic = true;
        };
        while (at < body.length) {
            const c = body[at]!;
            if (c === '\\') { at += 2; continue; }
            if (c === '$' && body[at + 1] === '(') {
                let level = 1, end = at + 2;
                while (end < body.length) {
                    if (body[end] === '\\') { end += 2; continue; }
                    if (body[end] === '(') level++;
                    else if (body[end] === ')' && --level === 0) break;
                    end++;
                }
                if (end >= body.length) { valid = false; return; }
                nested(body.slice(at + 2, end));
                at = end + 1;
                continue;
            }
            if (c === '`') {
                let end = at + 1;
                while (end < body.length && body[end] !== '`') end += body[end] === '\\' ? 2 : 1;
                if (end >= body.length) { valid = false; return; }
                nested(body.slice(at + 1, end));
                at = end + 1;
                continue;
            }
            if (c === '$') owner.dynamic = true;
            at++;
        }
    };
    /** 沙箱模式：一行命令结束后，按登记顺序把每段 here-document 的正文读完，返回正文之后的位置。 */
    const readHeredocBodies = (from: number): number => {
        let at = from;
        for (const item of pendingHeredocs) {
            const lines: string[] = [];
            let closed = false;
            while (at < source.length) {
                const end = source.indexOf('\n', at);
                const line = source.slice(at, end < 0 ? source.length : end);
                at = end < 0 ? source.length : end + 1;
                const candidate = (item.stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
                if (candidate === item.delimiter) { closed = true; break; }
                lines.push(line);
            }
            // 一直没等到结束标记：外壳会把剩下的全部当正文，这里照做，但整条命令记为「没法可靠解析」。
            if (!closed) valid = false;
            item.entry.body = lines.join('\n');
            if (!item.entry.quoted) scanHeredocExpansions(item.entry.body, item.owner);
        }
        pendingHeredocs.length = 0;
        return at;
    };
    while (i < source.length) {
        const c = source[i]!;
        if (quote === "'") {
            if (c === "'")
                quote = '';
            else
                word += c;
            i++;
            continue;
        }
        if (c === '\\') {
            if (i + 1 >= source.length) {
                valid = false;
                break;
            }
            if (source[i + 1] !== '\n') {
                word += source[i + 1];
                wordStarted = true;
            }
            i += 2;
            continue;
        }
        if (c === '$' && source[i + 1] === '(') {
            substitution(false);
            continue;
        }
        if (c === '`') {
            substitution(true);
            continue;
        }
        if (quote === '"') {
            if (c === '"')
                quote = '';
            else {
                if (c === '$')
                    part.dynamic = true;
                word += c;
            }
            i++;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            wordStarted = true;
            i++;
            continue;
        }
        if (sandbox && c === '$' && source[i + 1] === '{') {
            // ${变量} 是普通的变量展开：记成动态参数即可，不因为花括号就算「看不懂」。
            part.dynamic = true;
            word += '${';
            wordStarted = true;
            braceDepth++;
            i += 2;
            continue;
        }
        if (sandbox && c === '}' && braceDepth > 0) {
            braceDepth--;
            word += c;
            i++;
            continue;
        }
        if (c === '$' || c === '*' || c === '?')
            part.dynamic = true;
        if (c === '#' && !wordStarted) {
            while (i < source.length && source[i] !== '\n')
                i++;
            continue;
        }
        if (c === '>' || c === '<' || (c === '&' && source[i + 1] === '>')) {
            // 文件描述符数字属于重定向语法，不能混进 cp/mv 的目标操作数。
            if (redirect === null && wordStarted && /^\d+$/.test(word)) { word = ''; wordStarted = false; }
            flushWord();
            if (sandbox && c === '<' && source[i + 1] === '<') {
                // << 和 <<< 后面跟的是文字，不是要读的文件。
                if (redirect !== null) valid = false;
                redirect = null;
                descriptorRedirect = false;
                if (source[i + 2] === '<') { hereString = true; i += 3; }
                else i = startHeredoc(i + 2);
                continue;
            }
            if (redirect !== null) valid = false;
            redirect = c !== '<';
            if (c === '&') i++;
            const operator = source[i]!;
            if (source[i + 1] === operator) { if (operator === '<') valid = false; i++; }
            if (source[i + 1] === '|' && operator === '>') i++;
            if (source[i + 1] === '&') {
                i++;
                descriptorRedirect = true;
            }
            if (source[i + 1] === '(') {
                valid = false;
                // 沙箱模式：进程替换 <(…) 里的命令段也记下来（source <(curl …)）。
                const end = sandbox && c === '<' ? closingParen(source, i + 2) : -1;
                if (end > 0) (part.processSubstitutions ??= []).push(...lexShell(source.slice(i + 2, end), depth + 1, maxDepth, options).parts);
            }
            i++;
            continue;
        }
        if ('|;&\n'.includes(c)) {
            // 沙箱模式：记下管道关系。单个 | 和 |& 是管道，|| 不是。只有这个符号自己冲出了一个非空命令段才算数：
            // { a; b; } | c 里 b 在花括号收尾时就已经冲出去了，不能算它直连 c。
            const pipe = sandbox && c === '|' && source[i + 1] !== '|';
            const before = parts.length;
            flushPart();
            // P75r5a：记下这个符号对应的连接符，给下一个命令段用。换行不覆盖前面还没用掉的 && 或 ||（命令可以在 && 之后换行继续）。
            if (c === '\n') { if (nextJoin === null) nextJoin = 'newline'; }
            else if (c === ';') nextJoin = ';';
            else if (c === '|') nextJoin = source[i + 1] === '|' ? '||' : '|';
            else nextJoin = source[i + 1] === '&' ? '&&' : '&';
            if (sandbox) {
                const attached = pipe && parts.length > before;
                if (attached) parts[parts.length - 1]!.pipesOn = true;
                pendingPipe = attached;
                if (pipe && source[i + 1] === '&') i++;
            }
            if (source[i + 1] === c && c !== '\n')
                i++;
            i++;
            // 这一行命令结束了：前面登记过的 here-document 正文从下一行开始。
            if (sandbox && c === '\n' && pendingHeredocs.length) i = readHeredocBodies(i);
            continue;
        }
        if (/\s/.test(c)) {
            flushWord();
            i++;
            continue;
        }
        if (sandbox && (c === '(' || c === ')')) {
            // 子外壳、函数定义、case 分支：括号本身不是命令的一部分，里面的命令要各自成段分类。
            valid = false;
            flushPart();
            i++;
            continue;
        }
        if (sandbox && (c === '{' || c === '}') && !wordStarted && (i + 1 >= source.length || /[\s;|&]/.test(source[i + 1]!))) {
            // 单独的 { 和 } 是命令分组的边界；a{b,c} 这类花括号展开不走这里。
            valid = false;
            flushPart();
            i++;
            continue;
        }
        if ('(){}'.includes(c))
            valid = false;
        word += c;
        wordStarted = true;
        i++;
    }
    if (quote)
        valid = false;
    flushPart();
    // 命令到头了，here-document 的正文还没出现。
    if (pendingHeredocs.length)
        valid = false;
    return { parts, valid: valid && parts.length > 0 };
}
