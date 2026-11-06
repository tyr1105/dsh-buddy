/** 只读程序逐一列出可解释选项；未知参数不猜测为安全，阻止外部预处理器与隐式写文件。 */
export interface OptionPolicy { short: string; values?: string; long?: readonly string[]; longValues?: readonly string[] }
/** 短选项逐字符解析，带值选项吃掉本词余部或下一个词。 */
export function knownOptions(args: string[], policy: OptionPolicy): boolean {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--') return true;
        if (!arg.startsWith('-') || arg === '-') continue;
        if (arg.startsWith('--')) {
            const name = arg.split('=')[0]!;
            if (policy.longValues?.includes(name)) {
                if (!arg.includes('=') && ++i >= args.length) return false;
            } else if (!policy.long?.includes(name) || arg.includes('=')) return false;
        } else {
            for (let n = 1; n < arg.length; n++) {
                const flag = arg[n]!;
                if (!policy.short.includes(flag)) return false;
                if (policy.values?.includes(flag)) {
                    if (n === arg.length - 1 && ++i >= args.length) return false;
                    break;
                }
            }
        }
    }
    return true;
}
export const READ_OPTIONS: Record<string, OptionPolicy> = {
    ls: { short: 'aAbBcCdDfFgGhHiIklLmMnNopqQrRsStTuUvwxX1@e', long: ['--all', '--almost-all', '--recursive', '--directory', '--human-readable'], longValues: ['--color', '--sort', '--time-style'] },
    cat: { short: 'benstuvAET', long: ['--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs', '--squeeze-blank'] },
    head: { short: 'ncvq', values: 'nc', longValues: ['--lines', '--bytes'], long: ['--quiet', '--verbose'] },
    tail: { short: 'ncfFqvr', values: 'nc', longValues: ['--lines', '--bytes'], long: ['--follow', '--quiet', '--verbose'] },
    wc: { short: 'clmwL', long: ['--bytes', '--chars', '--lines', '--words', '--max-line-length'] },
    grep: { short: 'EFGPivwxcnlLhHosrqRaAbBCefm', values: 'AbBCefm', long: ['--recursive', '--extended-regexp', '--fixed-strings', '--ignore-case', '--line-number', '--files-with-matches', '--quiet'], longValues: ['--regexp', '--file', '--include', '--exclude', '--exclude-dir', '--after-context', '--before-context', '--context', '--max-count'] },
    rg: { short: 'A B C E F H I L M N P S T U V a b c e f g h i j l m n o p q r s t u v w x z'.replaceAll(' ', ''), values: 'ABCEMTefgjmrt', long: ['--hidden', '--files', '--no-ignore', '--ignore-case', '--line-number', '--count', '--fixed-strings', '--files-with-matches', '--only-matching', '--quiet', '--no-heading', '--heading', '--json', '--multiline'], longValues: ['--glob', '--type', '--type-not', '--max-count', '--max-depth', '--encoding', '--after-context', '--before-context', '--context', '--regexp', '--file', '--replace', '--sort', '--color'] },
    stat: { short: 'fLtqxrs', values: 'f', long: ['--dereference', '--file-system', '--terse'], longValues: ['--format', '--printf'] },
    date: { short: 'uRIdjf', values: 'Idjf', long: ['--utc', '--rfc-email'], longValues: ['--date', '--iso-8601'] },
    echo: { short: 'neE' }, pwd: { short: 'LP', long: ['--logical', '--physical'] },
    less: { short: 'EFIKNQRSMXceimnqsuwx', values: 'x' }, base64: { short: 'dDiw', values: 'iw', long: ['--decode', '--ignore-garbage'], longValues: ['--wrap'] },
    xxd: { short: 'abcegilospru', values: 'cegils' },
};
/** find 单横线长选项独立列举；写入与执行选项由上层先提取目标，随后至少 C。 */
export function knownFindOptions(args: string[]): boolean {
    const values = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-type', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-ctime', '-cmin', '-atime', '-amin', '-newer', '-user', '-group', '-perm', '-inum', '-links']);
    const flags = new Set(['-H', '-L', '-P', '-print', '-print0', '-ls', '-prune', '-empty', '-depth', '-xdev', '-mount', '-a', '-o', '-and', '-or', '-not', '-true', '-false']);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (values.has(arg)) { if (++i >= args.length) return false; }
        else if (arg.startsWith('-') && !flags.has(arg)) return false;
    }
    return true;
}
