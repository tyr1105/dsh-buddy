/**
 * HTTP 读取采用白名单解析；输出、上传、自动命名和未知协议必须升级，不因 curl 外壳获得只读权限。
 *
 * P69 加了两样：
 * - 发送数据的判定带上域名（detail），审批卡才能说「向 example.com 发送数据」；
 * - 下载（总控裁定第 2 条）：沙箱开着时，curl、wget 只是把内容取回来存进家目录或临时目录，没有带数据、
 *   没有上传、没有改方法，判 A；存到沙箱外的位置按路径规则指路。没确认沙箱时保持原判定（C），
 *   只是标上 download，审批卡不会把下载说成「发送数据」。
 */
import { posix } from 'node:path';
import { classifyPath, mostDangerous } from './paths.js';
import { curlLocalOnly, isLocalHttpUrl, wgetLocalOnly } from './local-address.js';
import { hostOfUrl } from './outward-commands.js';
import type { Classification, GateContext } from './paths.js';
import { knownOptions } from './read-options.js';
/** 支付动作按 URL 路径片段子串识别，覆盖常见复数与 payment_intents 写法。 */
export function paymentUrl(value: string): boolean {
    try { return /pay|buy|checkout|charge|order|purchase|transfer|withdraw|refund|invoice|subscription/i.test(decodeURIComponent(new URL(value).pathname)); }
    catch { return false; }
}
/** 给「向外部网址发送数据」的判定带上清洗过的域名，审批卡据此说「向 某域名 发送数据」。 */
function withHost(item: Classification, url: string | undefined): Classification {
    const host = url === undefined ? undefined : hostOfUrl(url);
    return host === undefined ? item : { ...item, detail: host };
}
/** 所有网络入口共用协议、支付、DELETE 与 file URL 边界。 */
export function classifyUrl(url: string, method: string, ctx: GateContext): Classification {
    if (/^file:\/\//i.test(url)) return mostDangerous([{ cls: 'C', reason: '本地文件 URL 不是 HTTP GET', subclass: 'http_post' }, classifyPath(url, false, ctx)]);
    if (paymentUrl(url)) return { cls: 'D', reason: '支付、下单或转账 API 永久需要审批', subclass: 'high_risk', hint: 'payment' };
    if (method.toUpperCase() === 'DELETE') return { cls: 'D', reason: '删除远端资源不可逆', subclass: 'high_risk', hint: 'remote_delete' };
    if (!/^https?:\/\//i.test(url)) return { cls: 'C', reason: '仅 HTTP 或 HTTPS GET 属于只读白名单', subclass: 'http_post' };
    if (method.toUpperCase() === 'GET') return { cls: 'A', reason: '只读 HTTP GET', readOnly: true };
    return withHost({ cls: 'C', reason: '网络写请求需审批', subclass: 'http_post' }, url);
}
/** 下载时多认的选项（只在判断「是不是单纯下载」时用）：输出文件名、输出目录、自动命名。 */
const CURL_DOWNLOAD = { short: 'oO#', values: 'o', long: ['--remote-name', '--remote-name-all', '--remote-header-name', '--create-dirs', '--progress-bar', '--no-progress-meter', '--fail-with-body'], longValues: ['--output', '--output-dir'] };
const WGET_DOWNLOAD = { short: 'OP', values: 'OP', long: [] as string[], longValues: ['--output-document', '--directory-prefix'] };
/** 带输出参数全部取出路径，即使外层另有未知选项也不能掩盖 protected。 */
export function classifyNetwork(cmd: string, args: string[], ctx: GateContext): Classification {
    const checks: Classification[] = [];
    const destinations: string[] = [];
    // P74r9 第 4 节：命令里的全部地址都是本机（解析后的主机名判断）且选项都认得时，往本机发数据不算「向外部网址发送数据」。
    // 支付、DELETE 等按路径和方法的规则不变；写文件的目标路径仍然过路径规则。
    const localOnly = cmd === 'curl' ? curlLocalOnly(args) : wgetLocalOnly(args);
    const urlClass = (url: string, method: string): Classification => {
        const result = classifyUrl(url, method, ctx);
        return localOnly && result.cls === 'C' && result.subclass === 'http_post' && isLocalHttpUrl(url)
            ? { cls: 'A', reason: '只是访问本机地址，数据没有离开这台电脑', subclass: 'local_http' } : result;
    };
    const outputLong = /^(?:--output.*|--remote-name.*|--remote-header-name|--output-dir|--dump-header|--stderr|--libcurl|--etag-save|--hsts|--alt-svc|--cookie-jar|--trace|--trace-ascii|--log-file|--append-output)$/;
    const automatic = new Set(['--remote-name', '--remote-name-all', '--remote-header-name']);
    // sends：带了数据、上传、改了请求方法；outputs：只是把响应存成文件。两种以前都叫 restricted，现在分开，
    // 因为沙箱开着时「存成文件」可以放行，「发送数据」不行。
    let method = 'GET', sends = false, outputs = false;
    // R11：按远端文件名落地的下载（curl -O、--remote-name、wget 不带 -O）。文件名取自网址，所以要单独算出落点。
    let remoteName = false;
    let outputDir: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) checks.push(urlClass(arg, method));
        if (arg.startsWith('--')) {
            const [name, ...rest] = arg.split('=');
            const value = rest.length ? rest.join('=') : args[i + 1];
            if (name === '--remote-name' || name === '--remote-name-all') remoteName = true;
            if (name === '--output-dir' && value) outputDir = value;
            if (outputLong.test(name!)) {
                outputs = true;
                if (!automatic.has(name!) && value) destinations.push(value);
            }
            if (/^--(?:data|form|upload|json|post|body)/.test(name!) || name === '--head') sends = true;
            if (name === '--request' || name === '--method') { method = value ?? ''; sends ||= method.toUpperCase() !== 'GET'; }
        } else if (arg.startsWith('-') && arg !== '-') {
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j]!;
                if (flag === 'I') sends = true;
                if ('oOcDJKTFdX'.includes(flag)) {
                    // o、O、c、D、J 只是把东西存成文件；K（读配置文件）、T（上传）、F（表单）、d（数据）会往外送。
                    if (flag === 'O' && cmd === 'curl') remoteName = true;
                    if ('oOcDJ'.includes(flag)) outputs = true;
                    else if (flag !== 'X') sends = true;
                    if ('oDc'.includes(flag)) destinations.push(arg.slice(j + 1) || args[i + 1] || '');
                    if (flag === 'X') { method = arg.slice(j + 1) || args[i + 1] || ''; sends ||= method.toUpperCase() !== 'GET'; }
                    if ('ocDKTFdX'.includes(flag)) break;
                }
            }
        }
    }
    const urls = args.flatMap((arg, index) => arg.startsWith('--url=') ? [arg.slice(6)]
        : arg === '--url' && args[index + 1] ? [args[index + 1]!]
        : /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? [arg] : []);
    checks.push(...urls.map(url => urlClass(url, method)));
    const policy = cmd === 'curl'
        ? { short: 'sSLfIvXHmAeb', values: 'XHmAeb', long: ['--silent', '--show-error', '--location', '--fail', '--verbose', '--compressed', '--head', '--globoff'], longValues: ['--request', '--header', '--max-time', '--connect-timeout', '--retry', '--user-agent', '--referer', '--cookie', '--url'] }
        : { short: 'qSv', long: ['--quiet', '--verbose', '--spider', '--no-check-certificate'], longValues: ['--timeout', '--tries', '--header', '--user-agent', '--method'] };
    // 允许下载选项的版本：只用来判断「除了存文件，没有别的异常」。
    const extra = cmd === 'curl' ? CURL_DOWNLOAD : WGET_DOWNLOAD;
    const downloadPolicy = { short: policy.short + extra.short, values: (policy.values ?? '') + extra.values, long: [...policy.long, ...extra.long], longValues: [...policy.longValues, ...extra.longValues] };
    // wget 的输出文件和目录写在 -O、-P 后面，要取出来过路径规则。
    if (cmd === 'wget') {
        args.forEach((arg, index) => {
            const short = /^-[^-]*[OP]$/.test(arg) ? args[index + 1] : /^-[OP](.+)$/.exec(arg)?.[1];
            const long = /^--(?:output-document|directory-prefix)(?:=(.*))?$/.exec(arg);
            const value = short ?? (long ? long[1] ?? args[index + 1] : undefined);
            if (value) destinations.push(value);
            // -P、--directory-prefix 指定的是输出目录，没写 -O 时文件按网址里的名字落在这个目录下。
            const dirValue = /^-[^-]*P$/.test(arg) ? args[index + 1] : /^-P(.+)$/.exec(arg)?.[1] ?? (/^--directory-prefix/.test(arg) ? long?.[1] ?? args[index + 1] : undefined);
            if (dirValue) outputDir = dirValue;
        });
    }
    // wget 默认写文件，spider 默认 HEAD；必须同时明确无文件输出与 GET 方法。
    // 没带 --spider 就是在下载（输出）；带了 --spider 却没明说 GET，是改了方法（按发送算，保持保守）。
    if (cmd === 'wget') {
        const spider = args.includes('--spider');
        if (!spider) outputs = true;
        else if (!args.some((arg, i) => arg === '--method=GET' || (arg === '--method' && args[i + 1] === 'GET'))) sends = true;
    }
    // wget 只要没有 -O / --output-document，文件就按网址里的名字存（R11）。
    if (cmd === 'wget' && !args.some(arg => /^-[^-]*O/.test(arg) || /^--output-document/.test(arg))) remoteName = true;
    const restricted = sends || outputs;
    // 单纯下载：选项全在下载白名单内、有网址、没有发送数据。沙箱开着时放行，否则仍然要审批（只是说法不同）。
    const onlyDownload = outputs && !sends && urls.length > 0 && knownOptions(args, downloadPolicy);
    const host = urls.map(url => hostOfUrl(url)).find((name): name is string => name !== undefined);
    // 沙箱模式（R11）：用网址路径的最后一段当文件名（没有就叫 index.html），拼上输出目录，再过一遍路径规则。
    // curl -O https://…/AGENTS.md 在家目录里运行，会把自己的身份文件覆盖掉，只查「当前目录能不能写」看不出来。
    if (ctx.sandboxed === true && remoteName) {
        for (const url of urls) {
            let tail = '';
            try { tail = new URL(url).pathname.split('/').pop() ?? ''; } catch { /* 写不成网址的由上面的分类处理 */ }
            const names = new Set<string>([tail || 'index.html']);
            try { names.add(decodeURIComponent(tail) || 'index.html'); } catch { /* 解不开百分号编码就只用原样 */ }
            for (const name of names) destinations.push(posix.join(outputDir ?? '.', name));
        }
    }
    if (ctx.sandboxed === true && onlyDownload) {
        // 没写输出位置（curl -O、wget url）时文件落在当前目录，也要过一遍写入规则。
        if (!destinations.filter(Boolean).length) destinations.push('.');
        checks.push({ cls: 'A', reason: '只是下载内容存进沙箱里，没有发送数据', subclass: 'sandboxed_exec' });
    } else if (!localOnly && (!knownOptions(args, policy) || !urls.length || restricted)) {
        checks.push({ cls: 'C', reason: '网络命令含写入、未知选项或无法确认的 URL', subclass: 'http_post',
            ...(host === undefined ? {} : { detail: host }), ...(onlyDownload ? { download: true } : {}) });
    }
    // /dev/null 这类标准设备只是丢弃或承接输出，不是写文件（和命令重定向的处理一致）。
    const devices = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'];
    checks.push(...destinations.filter(Boolean).map(path => classifyPath(path, !devices.includes(path), ctx)));
    return mostDangerous(checks);
}
