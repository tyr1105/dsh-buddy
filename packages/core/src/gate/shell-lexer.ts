/** 小型 shell 词法器：只提取每段命令、重定向和嵌套替换，不执行 shell；拿不准的语法交给审批。 */
import { C03_DEFAULTS } from '../config/defaults.js';
export interface ShellPart {
    words: string[];
    redirects: Array<{
        path: string;
        write: boolean;
    }>;
    dynamic: boolean;
}
export interface ShellParse {
    parts: ShellPart[];
    valid: boolean;
}
/** 引号不丢失词边界，命令替换独立递归，防止把危险子命令藏在安全命令的参数里。 */
export function lexShell(source: string, depth = 0, maxDepth: number = C03_DEFAULTS.maxCommandDepth): ShellParse {
    if (depth > maxDepth) return { parts: [], valid: false };
    const parts: ShellPart[] = [];
    let part: ShellPart = { words: [], redirects: [], dynamic: false };
    let word = '';
    let wordStarted = false;
    let quote = '';
    let i = 0;
    let redirect: boolean | null = null;
    let descriptorRedirect = false;
    let valid = true;
    /** 将当前词语保存为参数或重定向目标，保留命令词法边界。 */
    const flushWord = () => {
        if (!wordStarted)
            return;
        if (redirect !== null) {
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
        if (part.words.length || part.redirects.length)
            parts.push(part);
        part = { words: [], redirects: [], dynamic: false };
        redirect = null;
        descriptorRedirect = false;
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
        const inner = lexShell(source.slice(start, at), depth + 1, maxDepth);
        parts.push(...inner.parts);
        valid &&= inner.valid;
        part.dynamic = true;
        word += '__dynamic__';
        wordStarted = true;
        i = at + 1;
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
            if (source[i + 1] === '(') valid = false;
            i++;
            continue;
        }
        if ('|;&\n'.includes(c)) {
            flushPart();
            if (source[i + 1] === c && c !== '\n')
                i++;
            i++;
            continue;
        }
        if (/\s/.test(c)) {
            flushWord();
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
    return { parts, valid: valid && parts.length > 0 };
}
