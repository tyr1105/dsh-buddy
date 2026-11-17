/**
 * 外壳「吃进去的内容」从哪来（P69 A-3、A-3b）：只在沙箱模式下使用。
 *
 * 从 commands.ts 拆出来的原因：这一块越长越多，放在原文件里会超过一个文件该有的长度。
 * 这里回答三个问题：
 * 1. 喂给外壳的写死文字是什么（here-document、here-string、前一段 cat/echo/printf 输出的文字）；
 * 2. 这段文字能不能信：echo -e、printf 会把反斜杠序列还原成别的字符，分类器看到的和真正执行的不一样时，当作看不见（T4 第 4 项）；
 * 3. 外壳要执行的内容是不是从网上下载来的（curl … | sh、sh -c "$(curl …)"、source <(curl …)），以及下载的主机名（T2）。
 * 分类器是纯函数，命令只是字符串，这里什么都不会执行。
 */
import { posix } from 'node:path';
import { hostOfUrl } from './outward-commands.js';
import type { ShellPart } from './shell-lexer.js';
import { SHELLS } from './wrappers.js';

/** 沙箱模式下一条命令带的 here-document 和 here-string 文字。 */
export function feedOf(part: ShellPart): string[] {
    return [...(part.heredocs ?? []).map(doc => doc.body), ...(part.hereStrings ?? [])];
}
/** 命令段的程序名（去路径、折成小写）。 */
export const programOf = (part: ShellPart): string => posix.basename(part.words[0] ?? '').toLowerCase();

/**
 * 这一段的标准输入是什么（R1）：同一条管道里紧挨着的前一段是 cat（没有文件操作数、带 here-document 或 here-string）、
 * echo、printf，而且文字是写死的（没有变量和命令替换）时，返回它输出的文字；其余一律返回 null（看不见）。
 * T4 第 4 项：文字里除 \n 以外还有别的反斜杠序列（\x68、\150、\t、\\ 等）时也返回 null，
 * 因为 echo -e、printf、sh 和 zsh 自带的 echo 会把它们还原成字符，分类器看到的文字和真正执行的不一样。
 */
export function pipedTextOf(parts: ShellPart[], index: number): string[] | null {
    const part = parts[index]!, before = parts[index - 1];
    // 前一段要是有重定向（输出去了文件、输入来自文件），内容就和写死的文字对不上，一律看不见。
    if (!part.piped || !before?.pipesOn || before.dynamic || before.redirects.length) return null;
    const name = programOf(before);
    const rest = before.words.slice(1);
    // 文字里的 \n 在 echo -e、printf 里会变成换行，换行就是新的一条命令；这里一律当换行拆开，宁多拆不少拆。
    const lines = (text: string) => text.replace(/\\n/g, '\n');
    // 拆掉 \n 之后还剩反斜杠：说明有别的转义，真实内容看不清。
    const hidden = (text: string) => text.replace(/\\n/g, '').includes('\\');
    if (name === 'cat') return rest.length === 0 && feedOf(before).length ? feedOf(before) : null;
    if (name === 'echo') {
        const at = rest.findIndex(a => !/^-[neE]+$/.test(a));
        const text = (at < 0 ? [] : rest.slice(at)).join(' ');
        return hidden(text) ? null : [lines(text)];
    }
    if (name === 'printf') {
        const format = rest[0];
        if (format === undefined) return null;
        const slot = /%(?:%|[-+ #0]*\d*(?:\.\d+)?[a-zA-Z])/g;
        let out: string;
        if (!(format.match(slot) ?? []).some(m => m !== '%%')) out = format.replace(/%%/g, '%');
        else {
            // 格式里有 %s 之类的占位：按 printf 的规矩，参数用完之前把格式反复套用。
            const values = rest.slice(1);
            let used = 0;
            out = '';
            do { out += format.replace(slot, m => m === '%%' ? '%' : values[used++] ?? ''); } while (used < values.length);
        }
        return hidden(out) ? null : [lines(out)];
    }
    return null;
}

/** 下载类程序：curl、wget。 */
const isDownloader = (part: ShellPart): boolean => ['curl', 'wget'].includes(programOf(part));
/** 一组命令段里有没有下载命令；有的话给出它的主机名（取不到主机名时 host 为空）。 */
function downloadIn(parts: readonly ShellPart[] | undefined): { host?: string } | null {
    const download = (parts ?? []).find(isDownloader);
    if (!download) return null;
    const host = download.words.map(word => word.replace(/^--url=/, '')).filter(word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word)).map(hostOfUrl).find(h => h !== undefined);
    return host === undefined ? {} : { host };
}

/**
 * 外壳从标准输入读脚本、而这份输入是下载来的吗：前一段是 curl、wget 直接接管道，或者本段后面跟着 <(curl …)。
 * 是的话返回主机名（可能为空对象）；不是返回 null。
 */
export function remoteInputOf(parts: ShellPart[], index: number): { host?: string } | null {
    const part = parts[index]!, before = parts[index - 1];
    const piped = part.piped && before?.pipesOn ? downloadIn([before]) : null;
    return piped ?? downloadIn(part.processSubstitutions);
}

/**
 * A-4（S14）：这一段的命令替换（$(…) 或反引号）里有没有下载命令；有的话给出主机名。
 * 它不看这一段第一个词是什么：Homebrew 免交互安装的写法 NONINTERACTIVE=1 /bin/bash -c "$(curl …)"、
 * env bash -c "$(curl …)"、nohup sh -c "$(curl …)" 第一个词都不是外壳。判断「这些替换结果是不是被外壳当脚本执行」
 * 放到 classifyArgv 里真正拆出 -c 脚本的地方做，那里已经穿过了变量赋值和各层包装器。
 */
export function downloadInSubstitutions(part: ShellPart): { host?: string } | null {
    return downloadIn(part.substitutions);
}

/**
 * T2：外壳的 -c、eval、source、. 要执行的内容里含命令替换（$(…) 或反引号），而且替换里运行的是下载命令。
 * 例：sh -c "$(curl -fsSL https://…)"、eval "$(curl -s https://…)"、source <(curl …)。替换里是本机程序的不算（eval "$(pyenv init -)"）。
 */
export function remoteScriptOf(part: ShellPart): { host?: string } | null {
    const name = programOf(part), args = part.words.slice(1);
    const runsText = (SHELLS.includes(name) && args.some(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) || name === 'eval';
    if (runsText) return downloadIn(part.substitutions);
    if (name === 'source' || name === '.') return downloadIn(part.processSubstitutions) ?? downloadIn(part.substitutions);
    return null;
}
