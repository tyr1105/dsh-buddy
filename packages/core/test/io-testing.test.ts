/** 验证测试替身也遵守真实 IO 契约，防止仿真通过而运行时采用不同语义。 */
import { describe, expect, it } from 'vitest';
import { FakeClock, SeededRng, MemoryFs, MemoryLogger, FakeNet, FakeExec } from '../src/io/testing/index.js';
import type { FileChange } from '../src/io/interfaces.js';

describe('时钟、随机与日志替身', () => {
  it('时钟可设置与推进，不依赖机器时间', () => {
    const clock = new FakeClock(100); clock.advance(50); expect(clock.now()).toBe(150);
    clock.set(10); expect(clock.now()).toBe(10);
  });
  it('拒绝无效时钟与负数推进', () => {
    const clock = new FakeClock(); expect(() => clock.advance(-1)).toThrow('非负');
    expect(() => clock.set(NaN)).toThrow('有限');
  });
  it('同种子同序列，不同种子不同序列，数值在半开区间内', () => {
    const first = new SeededRng(42); const second = new SeededRng(42); const third = new SeededRng(43);
    const values = Array.from({ length: 100 }, () => first.next());
    expect(values).toEqual(Array.from({ length: 100 }, () => second.next()));
    expect(values[0]).not.toBe(third.next());
    expect(values.every(value => value >= 0 && value < 1)).toBe(true);
  });
  it('mulberry32 的首值符合固定算法', () => { expect(new SeededRng(1).next()).toBe(0.6270739405881613); });
  it('随机种子拒绝非整数', () => { expect(() => new SeededRng(1.2)).toThrow('整数'); });
  it('保留四种日志级别与附加上下文', () => {
    const logger = new MemoryLogger(); logger.debug('调试'); logger.info('消息', { ok: true }); logger.warn('提醒'); logger.error('失败');
    expect(logger.lines.map(line => line.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(logger.lines[1]).toEqual({ level: 'info', message: '消息', data: { ok: true } });
  });
});

describe('MemoryFs', () => {
  it('不存在时读 null、空目录列表与空 stat', async () => {
    const fs = new MemoryFs(); expect(await fs.readText('/missing')).toBeNull();
    expect(await fs.list('/missing')).toEqual([]); expect(await fs.stat('/missing')).toBeNull();
  });
  it('原子写先提交完整内容，随后同步触发监听', async () => {
    const fs = new MemoryFs(); await fs.mkdirp('/tree'); const seen: string[] = [];
    fs.watch('/tree', { recursive: true }, () => { seen.push(fs.snapshot()['/tree/a']!); });
    const write = fs.writeTextAtomic('/tree/a', '完整中文');
    expect(seen).toEqual(['完整中文']); await write;
    await fs.writeTextAtomic('/tree/a', '第二版'); expect(seen).toEqual(['完整中文', '第二版']);
  });
  it('追加自动建目录、复制保留内容，字节与时间由注入时钟决定', async () => {
    const clock = new FakeClock(1000); const fs = new MemoryFs(clock);
    await fs.appendText('/a/b/c', '中'); clock.advance(2); await fs.appendText('/a/b/c', '文');
    expect(await fs.stat('/a/b/c')).toEqual({ size: 6, mtimeMs: 1002, isDir: false, isFile: true });
    await fs.copy('/a/b/c', '/copy/d'); expect(await fs.readText('/copy/d')).toBe('中文');
  });
  it('list 只给直接子项名称且排序', async () => {
    const fs = new MemoryFs(); await fs.writeTextAtomic('/a/z', 'z'); await fs.writeTextAtomic('/a/b/x', 'x');
    expect(await fs.list('/a')).toEqual(['b', 'z']); expect(await fs.list('/')).toEqual(['a']);
  });
  it('递归复制目录、递归删除只影响目标子树', async () => {
    const fs = new MemoryFs(); await fs.writeTextAtomic('/a/n/file', 'data'); await fs.copy('/a', '/b');
    await fs.remove('/a'); expect(fs.snapshot()).toEqual({ '/b/n/file': 'data' });
    expect(await fs.stat('/a')).toBeNull();
  });
  it('watch 区分递归、直接子项、文件，并支持取消', async () => {
    const fs = new MemoryFs(); await fs.mkdirp('/a/n'); const direct: FileChange[] = []; const deep: FileChange[] = [];
    fs.watch('/a', { recursive: false }, event => direct.push(event));
    const cancel = fs.watch('/a', { recursive: true }, event => deep.push(event));
    const files: FileChange[] = []; fs.watch('/a/n/f', { recursive: false }, event => files.push(event));
    await fs.writeTextAtomic('/a/n/f', 'one'); expect(direct).toHaveLength(0); expect(deep).toHaveLength(1);
    expect(files[0]).toEqual({ path: '/a/n/f', kind: 'rename' });
    cancel(); await fs.writeTextAtomic('/a/n/f', 'two'); expect(deep).toHaveLength(1);
    expect(files[1]?.kind).toBe('change');
    await fs.remove('/a/n/f'); expect(files[2]?.kind).toBe('rename');
  });
  it('监听路径采用目录边界，/a 不误监听 /ab', async () => {
    const fs = new MemoryFs(); const events: FileChange[] = [];
    fs.watch('/a', { recursive: true }, event => events.push(event));
    await fs.writeTextAtomic('/ab/f', 'x'); expect(events).toEqual([]);
  });
  it('监听回调抛错只记警告，不阻断写入和其他监听者', async () => {
    const logger = new MemoryLogger(); const fs = new MemoryFs(new FakeClock(), logger); let calls = 0;
    fs.watch('/f', { recursive: false }, () => { throw new Error('监听故障'); });
    fs.watch('/f', { recursive: false }, () => { calls += 1; });
    await fs.writeTextAtomic('/f', 'ok'); expect(calls).toBe(1); expect(await fs.readText('/f')).toBe('ok');
    expect(logger.lines[0]?.level).toBe('warn');
  });
  it('拒绝相对路径、目录读写、文件用作父目录与不存在的复制源', async () => {
    const fs = new MemoryFs(); await fs.mkdirp('/dir'); await fs.writeTextAtomic('/f', 'x');
    await expect(fs.readText('relative')).rejects.toThrow('绝对路径');
    expect(() => fs.watch('relative', { recursive: false }, () => {})).toThrow('绝对路径');
    await expect(fs.readText('/dir')).rejects.toThrow('目录');
    await expect(fs.writeTextAtomic('/dir', 'x')).rejects.toThrow('目录');
    await expect(fs.appendText('/dir', 'x')).rejects.toThrow('目录');
    await expect(fs.mkdirp('/f/child')).rejects.toThrow('不是目录');
    await expect(fs.copy('/missing', '/target')).rejects.toThrow('不存在');
    await expect(fs.copy('/dir', '/dir/child')).rejects.toThrow('自身');
  });
  it('snapshot 是独立的全文件快照', async () => {
    const fs = new MemoryFs(); await fs.writeTextAtomic('/f', 'old'); const snapshot = fs.snapshot(); snapshot['/f'] = 'new';
    expect(fs.snapshot()).toEqual({ '/f': 'old' });
  });
});

describe('网络与进程替身', () => {
  it('FakeNet 返回预设响应，区分记录 get/post 并截断完整 UTF-8', async () => {
    const net = new FakeNet().set('https://example.test', { status: 404, text: '中文文本', contentType: 'text/plain' });
    expect(await net.get('https://example.test', { timeoutMs: 10, maxBytes: 4 })).toEqual({ status: 404, text: '中', contentType: 'text/plain' });
    await net.post('https://example.test', 'body', { timeoutMs: 10, maxBytes: 100 });
    expect(net.calls.map(call => call.method)).toEqual(['GET', 'POST']); expect(net.calls[1]?.body).toBe('body');
  });
  it('FakeNet 抛出预设错误，未预设也报错', async () => {
    const net = new FakeNet().set('error', new Error('离线')); const opts = { timeoutMs: 10, maxBytes: 100 };
    await expect(net.get('error', opts)).rejects.toThrow('离线'); await expect(net.get('missing', opts)).rejects.toThrow('未预设');
  });
  it('FakeExec 保留参数边界并返回有界结果', async () => {
    const exec = new FakeExec().set('tool', ['a b', 'c'], { code: 2, stdout: '中文', stderr: 'error', timedOut: false });
    const opts = { cwd: '/workspace', timeoutMs: 10, maxOutputBytes: 4 };
    expect(await exec.run('tool', ['a b', 'c'], opts)).toEqual({ code: 2, stdout: '中', stderr: 'erro', timedOut: false, outputTruncated: true, killedForOutput: false });
    await expect(exec.run('tool', ['a', 'b c'], opts)).rejects.toThrow('未预设');
    expect(exec.calls[0]?.args).toEqual(['a b', 'c']);
  });
  it('FakeExec 支持预设异常与超时结果', async () => {
    const exec = new FakeExec().set('bad', [], new Error('不能执行')).set('slow', [], { code: null, stdout: '', stderr: '', timedOut: true });
    const opts = { cwd: '/', timeoutMs: 10, maxOutputBytes: 100 };
    await expect(exec.run('bad', [], opts)).rejects.toThrow('不能执行'); expect((await exec.run('slow', [], opts)).timedOut).toBe(true);
  });
});
