/** HTTP 读取采用白名单解析；输出、上传、自动命名和未知协议必须升级，不因 curl 外壳获得只读权限。 */
import { classifyPath, mostDangerous } from './paths.js';
import type { Classification, GateContext } from './paths.js';
import { knownOptions } from './read-options.js';
/** 支付动作按 URL 路径片段子串识别，覆盖常见复数与 payment_intents 写法。 */
export function paymentUrl(value: string): boolean {
    try { return /pay|buy|checkout|charge|order|purchase|transfer|withdraw|refund|invoice|subscription/i.test(decodeURIComponent(new URL(value).pathname)); }
    catch { return false; }
}
/** 所有网络入口共用协议、支付、DELETE 与 file URL 边界。 */
export function classifyUrl(url: string, method: string, ctx: GateContext): Classification {
    if (/^file:\/\//i.test(url)) return mostDangerous([{ cls: 'C', reason: '本地文件 URL 不是 HTTP GET', subclass: 'http_post' }, classifyPath(url, false, ctx)]);
    if (paymentUrl(url)) return { cls: 'D', reason: '支付、下单或转账 API 永久需要审批', subclass: 'high_risk' };
    if (method.toUpperCase() === 'DELETE') return { cls: 'D', reason: '删除远端资源不可逆', subclass: 'high_risk' };
    if (!/^https?:\/\//i.test(url)) return { cls: 'C', reason: '仅 HTTP 或 HTTPS GET 属于只读白名单', subclass: 'http_post' };
    return method.toUpperCase() === 'GET' ? { cls: 'A', reason: '只读 HTTP GET', readOnly: true } : { cls: 'C', reason: '网络写请求需审批', subclass: 'http_post' };
}
/** 带输出参数全部取出路径，即使外层另有未知选项也不能掩盖 protected。 */
export function classifyNetwork(cmd: string, args: string[], ctx: GateContext): Classification {
    const checks: Classification[] = [];
    const destinations: string[] = [];
    const outputLong = /^(?:--output.*|--remote-name.*|--remote-header-name|--output-dir|--dump-header|--stderr|--libcurl|--etag-save|--hsts|--alt-svc|--cookie-jar|--trace|--trace-ascii|--log-file|--append-output)$/;
    const automatic = new Set(['--remote-name', '--remote-name-all', '--remote-header-name']);
    let method = 'GET', restricted = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) checks.push(classifyUrl(arg, method, ctx));
        if (arg.startsWith('--')) {
            const [name, ...rest] = arg.split('=');
            const value = rest.length ? rest.join('=') : args[i + 1];
            if (outputLong.test(name!)) {
                restricted = true;
                if (!automatic.has(name!) && value) destinations.push(value);
            }
            if (/^--(?:data|form|upload|json|post)/.test(name!) || name === '--head') restricted = true;
            if (name === '--request' || name === '--method') { method = value ?? ''; restricted ||= method.toUpperCase() !== 'GET'; }
        } else if (arg.startsWith('-') && arg !== '-') {
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j]!;
                if (flag === 'I') restricted = true;
                if ('oOcDJKTFdX'.includes(flag)) {
                    if (flag !== 'X') restricted = true;
                    if ('oDc'.includes(flag)) destinations.push(arg.slice(j + 1) || args[i + 1] || '');
                    if (flag === 'X') { method = arg.slice(j + 1) || args[i + 1] || ''; restricted ||= method.toUpperCase() !== 'GET'; }
                    if ('ocDKTFdX'.includes(flag)) break;
                }
            }
        }
    }
    const urls = args.flatMap((arg, index) => arg.startsWith('--url=') ? [arg.slice(6)]
        : arg === '--url' && args[index + 1] ? [args[index + 1]!]
        : /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? [arg] : []);
    checks.push(...urls.map(url => classifyUrl(url, method, ctx)));
    const policy = cmd === 'curl'
        ? { short: 'sSLfIvXHmAeb', values: 'XHmAeb', long: ['--silent', '--show-error', '--location', '--fail', '--verbose', '--compressed', '--head', '--globoff'], longValues: ['--request', '--header', '--max-time', '--connect-timeout', '--retry', '--user-agent', '--referer', '--cookie', '--url'] }
        : { short: 'qSv', long: ['--quiet', '--verbose', '--spider', '--no-check-certificate'], longValues: ['--timeout', '--tries', '--header', '--user-agent', '--method'] };
    // wget 默认写文件，spider 默认 HEAD；必须同时明确无文件输出与 GET 方法。
    if (cmd === 'wget' && (!args.includes('--spider') || !args.some((arg, i) => arg === '--method=GET' || (arg === '--method' && args[i + 1] === 'GET')))) restricted = true;
    if (!knownOptions(args, policy) || !urls.length || restricted) checks.push({ cls: 'C', reason: '网络命令含写入、未知选项或无法确认的 URL', subclass: 'http_post' });
    checks.push(...destinations.filter(Boolean).map(path => classifyPath(path, true, ctx)));
    return mostDangerous(checks);
}
