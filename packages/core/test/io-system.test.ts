/** 系统适配边界验证：真实临时文件与子进程，网络用受控流验证限流和错误转换。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemFs, SystemNet, SystemExec, SystemClock, SystemRng, ConsoleLogger } from '../src/io/index.js';
import { MemoryLogger } from '../src/io/testing/index.js';

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(folders.splice(0).map(folder => rm(folder, { force: true, recursive: true })));
});
async function temporaryDirectory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'agent-hub-c01-')); folders.push(folder); return folder;
}

describe('系统基础能力', () => {
  it('系统时钟与随机源符合返回值契约', () => {
    const before = Date.now(); expect(new SystemClock().now()).toBeGreaterThanOrEqual(before);
    const random = new SystemRng().next(); expect(random).toBeGreaterThanOrEqual(0); expect(random).toBeLessThan(1);
  });
  it('控制台日志包含统一前缀，有无上下文都可读', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {}); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new ConsoleLogger(); logger.info('启动'); logger.warn('提醒', { code: 'x' });
    expect(info).toHaveBeenCalledWith('[agent-hub]', '启动'); expect(warn).toHaveBeenCalledWith('[agent-hub]', '提醒', { code: 'x' });
  });
});

describe('SystemFs', () => {
  it('原子写可覆盖、没有残留临时文件，追加自动建目录', async () => {
    const root = await temporaryDirectory(); const fs = new SystemFs(); const file = join(root, 'nested', 'f.txt');
    await fs.writeTextAtomic(file, '第一版'); await fs.writeTextAtomic(file, '第二版'); await fs.appendText(file, '追加');
    expect(await fs.readText(file)).toBe('第二版追加'); expect(await fs.list(join(root, 'nested'))).toEqual(['f.txt']);
    expect((await fs.stat(file))?.size).toBe(Buffer.byteLength('第二版追加'));
    const appendOnly = join(root, 'other', 'append.txt'); await fs.appendText(appendOnly, '新建'); expect(await fs.readText(appendOnly)).toBe('新建');
  });
  it('缺失文件正常返回空值，复制目录与递归删除可用', async () => {
    const root = await temporaryDirectory(); const fs = new SystemFs();
    expect(await fs.readText(join(root, 'missing'))).toBeNull(); expect(await fs.stat(join(root, 'missing'))).toBeNull();
    expect(await fs.list(join(root, 'missing'))).toEqual([]);
    await fs.writeTextAtomic(join(root, 'a', 'inner', 'file'), '值'); await fs.copy(join(root, 'a'), join(root, 'b'));
    await fs.remove(join(root, 'a')); expect(await fs.readText(join(root, 'b', 'inner', 'file'))).toBe('值');
    expect(await fs.stat(join(root, 'a'))).toBeNull();
  });
  it('每个路径入口拒绝相对路径', async () => {
    const fs = new SystemFs();
    const operations = [fs.readText('a'), fs.writeTextAtomic('a', ''), fs.appendText('a', ''), fs.mkdirp('a'), fs.list('a'), fs.stat('a'), fs.copy('/a', 'b'), fs.copy('a', '/b'), fs.remove('a')];
    for (const operation of operations) await expect(operation).rejects.toThrow('绝对路径');
    expect(() => fs.watch('a', { recursive: true }, () => {})).toThrow('绝对路径');
  });
  it('文件监听传递绝对路径并隔离回调异常', async () => {
    const root = await temporaryDirectory(); const logger = new MemoryLogger(); const fs = new SystemFs(logger);
    const file = join(root, 'watch.txt'); await fs.writeTextAtomic(file, 'a');
    let seen = '';
    const stop = fs.watch(file, { recursive: false }, event => { seen = event.path; throw new Error('订阅方故障'); });
    try {
      await fs.appendText(file, 'b');
      await vi.waitFor(() => { expect(seen).toBe(file); expect(logger.lines.some(line => line.level === 'warn')).toBe(true); });
    } finally { stop(); }
  });
});

describe('SystemNet', () => {
  it('实际 fetch 支持文本读取', async () => {
    expect(await new SystemNet().get('data:text/plain;charset=utf-8,%E4%B8%AD%E6%96%87', { timeoutMs: 1000, maxBytes: 100 }))
      .toEqual({ status: 200, text: '中文', contentType: 'text/plain;charset=utf-8' });
  });
  it('非 2xx 返回状态与正文，POST 传递参数与超时信号', async () => {
    const fetchMock = vi.fn(async () => new Response('拒绝', { status: 403, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new SystemNet().post('https://example.test', 'body', { timeoutMs: 1000, maxBytes: 100, headers: { 'x-test': 'yes' } }))
      .toEqual({ status: 403, text: '拒绝', contentType: 'text/plain' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ method: 'POST', body: 'body', headers: { 'x-test': 'yes' }, signal: expect.any(AbortSignal) }));
  });
  it('到字节上限停止读取并取消流，截断汉字不产生乱码', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('中文文本')); },
      cancel() { canceled = true; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    const response = await new SystemNet().get('https://example.test', { timeoutMs: 1000, maxBytes: 4 });
    expect(response.text).toBe('中'); expect(canceled).toBe(true); expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(4);
  });
  it('非法 UTF-8 替换字符也不能突破返回文本的字节上限', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(255, 255, 255, 255))));
    const response = await new SystemNet().get('https://example.test', { timeoutMs: 1000, maxBytes: 4 });
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(4);
  });
  it('网络失败转换为中文错误并保留原因', async () => {
    const original = new Error('offline'); vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));
    await expect(new SystemNet().get('https://example.test', { timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ message: '网络请求失败：offline', cause: original });
  });
  it('超时信号在响应正文阶段同样生效', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason)); },
    }))));
    await expect(new SystemNet().get('https://example.test', { timeoutMs: 10, maxBytes: 100 })).rejects.toThrow('网络请求失败');
  });
  it('零字节允许空输出，非法上限立即拒绝', async () => {
    const net = new SystemNet(); expect((await net.get('data:text/plain,hello', { timeoutMs: 1000, maxBytes: 0 })).text).toBe('');
    await expect(net.get('data:,', { timeoutMs: 0, maxBytes: 1 })).rejects.toThrow('timeoutMs');
    await expect(net.get('data:,', { timeoutMs: 100, maxBytes: -1 })).rejects.toThrow('maxBytes');
  });
});

describe('SystemExec', () => {
  it('命令参数按原样传递，shell 符号不会被执行', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal; $(echo unsafe)'], { cwd: '/', timeoutMs: 5000, maxOutputBytes: 1000 });
    expect(result).toEqual({ code: 0, stdout: 'literal; $(echo unsafe)', stderr: '', timedOut: false, outputTruncated: false, killedForOutput: false });
  });
  it('非零退出返回 code 与 stderr，不作为启动异常抛出', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stderr.write("失败"); process.exit(7)'], { cwd: '/', timeoutMs: 5000, maxOutputBytes: 1000 });
    expect(result.code).toBe(7); expect(result.stderr).toBe('失败'); expect(result.timedOut).toBe(false);
  });
  it('stdout 软截断保留完整字符和真实退出码', async () => {
    const exec = new SystemExec();
    const result = await exec.run(process.execPath, ['-e', 'process.stdout.write("中文文本".repeat(3)); process.exitCode = 7'], { cwd: '/', timeoutMs: 5000, maxOutputBytes: 4 });
    expect(result.stdout).toBe('中');
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(7);
    expect(result.outputTruncated).toBe(true);
    expect(result.killedForOutput).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
  });
  it('只有 stderr 超量仍读空管道，保留退出码且无半个汉字', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stderr.write("中文文本".repeat(3)); process.exitCode = 9'], { cwd: '/', timeoutMs: 5000, maxOutputBytes: 4 });
    expect(result).toMatchObject({ code: 9, stdout: '', stderr: '中', timedOut: false, outputTruncated: true, killedForOutput: false });
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4);
    expect(result.stderr).not.toContain('�');
  });
  it('超时杀进程并单独报告 timedOut', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: '/', timeoutMs: 50, maxOutputBytes: 100 });
    expect(result.timedOut).toBe(true); expect(result.code).toBeNull();
  });
  it('cwd 和显式环境变量生效', async () => {
    const cwd = await temporaryDirectory();
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stdout.write(process.cwd()+"|"+process.env.AGENT_HUB_TEST_VALUE)'], { cwd, timeoutMs: 5000, maxOutputBytes: 1000, env: { AGENT_HUB_TEST_VALUE: 'test' } });
    // macOS 的 /var 别名会解析到 /private/var，因此用原始工作目录后缀核对。
    expect(result.stdout.endsWith(`${cwd.replace(/^\/private/, '')}|test`) || result.stdout.endsWith(`${cwd}|test`)).toBe(true);
  });
  it('不存在命令给中文错误，参数上限非法立即拒绝', async () => {
    const exec = new SystemExec();
    await expect(exec.run('/no-such-command-agent-hub', [], { cwd: '/', timeoutMs: 100, maxOutputBytes: 100 })).rejects.toThrow('启动命令失败');
    await expect(exec.run('x', [], { cwd: '/', timeoutMs: 0, maxOutputBytes: 1 })).rejects.toThrow('timeoutMs');
    await expect(exec.run('x', [], { cwd: '/', timeoutMs: 100, maxOutputBytes: -1 })).rejects.toThrow('maxOutputBytes');
  });
});
