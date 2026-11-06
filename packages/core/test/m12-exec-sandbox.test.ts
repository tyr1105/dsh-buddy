/** M12 写入沙箱回归：失败关闭用注入平台和进程边界验证，真实 Seatbelt 测试只按系统能力探针决定跳过。 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SystemExec } from '../src/io/system-exec.js';
import { SANDBOX_EXEC, SANDBOX_UNAVAILABLE, sandboxProfile, sbplString } from '../src/io/system-sandbox.js';
import type { ExecOptions } from '../src/io/interfaces.js';
import { FakeExec } from '../src/io/testing/fake-exec.js';
import { pollScript } from '../src/perception/script.js';
import { pollDueWatches } from '../src/perception/poll.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { perceptionContext } from './perception-fixtures.js';

// 只替换进程启动边界；替身返回真实的无副作用进程，事件与管道收尾仍经过 SystemExec。
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
const opts: ExecOptions = { cwd: '/', timeoutMs: 5000, maxOutputBytes: 4096 };
const normal = { code: 0, stdout: '稳定结果', stderr: '', timedOut: false };
const folders: string[] = [];

/** 临时目录全部登记后清理；显式根放在测试目录，防止它被系统临时目录的权限间接放行。 */
async function directory(inWorkspace = false): Promise<string> {
  const parent = inWorkspace ? fileURLToPath(new URL('.', import.meta.url)) : tmpdir();
  const path = await mkdtemp(join(parent, '.agent-hub-m12-'));
  folders.push(path);
  return path;
}
beforeEach(() => { vi.mocked(spawn).mockReset().mockImplementation(realSpawn); });
afterEach(async () => {
  vi.mocked(spawn).mockReset().mockImplementation(realSpawn);
  await Promise.all(folders.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

describe('M12 脚本关注每次携带写入沙箱', () => {
  it.each(['git status', 'ls', 'node work/check.js'])('%s 的执行记录包含机器人家目录且不允许调用后篡改记录', async target => {
    const ctx = perceptionContext({ kind: 'script', target });
    const script = join(botFixture.homeDir, 'work/check.js');
    await ctx.fs.writeTextAtomic(script, 'console.log("稳定结果")');
    const [cmd, ...args] = target.split(' ');
    ctx.exec.set(cmd!, cmd === 'node' ? [script] : args, normal);
    await pollScript(ctx, ctx.store.table('watches').get(watchFixture.id)!, ctx.clock.now());
    expect(ctx.exec.calls).toHaveLength(1);
    expect(ctx.exec.calls[0]!.opts).toMatchObject({ cwd: botFixture.homeDir, sandbox: { writableRoots: [botFixture.homeDir] } });
    const exec = new FakeExec().set('ls', [], normal);
    const sandbox = { writableRoots: [botFixture.homeDir] };
    await exec.run('ls', [], { ...opts, sandbox });
    sandbox.writableRoots.push('/');
    expect(exec.calls[0]!.opts.sandbox).toEqual({ writableRoots: [botFixture.homeDir] });
  });

  it('沙箱不可用计入关注失败，连续三次告警且不更新成功基线', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status', intervalMs: 300_000 });
    ctx.exec.set('git', ['status'], new Error(SANDBOX_UNAVAILABLE));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pollDueWatches(ctx, ctx.clock.now());
      ctx.clock.advance(300_000);
    }
    const watch = ctx.store.table('watches').get(watchFixture.id)!;
    expect(readWatchState(watch)).toMatchObject({ consecutiveFailures: 3, lastError: SANDBOX_UNAVAILABLE });
    expect(watch.lastFingerprint).toBeNull();
    expect(ctx.store.table('alerts').list()).toEqual([expect.objectContaining({ code: `watch_failed:${watch.id}`, level: 'P2' })]);
    expect(ctx.exec.calls.every(call => call.opts.sandbox?.writableRoots.includes(botFixture.homeDir))).toBe(true);
  });
});

describe('M12 SystemExec 沙箱失败关闭', () => {
  it.each(['linux', 'win32', 'freebsd'] as const)('%s 不启动目标，也不回退为普通命令', async platform => {
    await expect(new SystemExec(platform).run('/usr/bin/true', [], { ...opts, sandbox: { writableRoots: [] } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('沙箱程序不存在时只尝试沙箱，不直接执行目标', async () => {
    vi.mocked(spawn).mockImplementationOnce((_cmd, _args, options) => realSpawn('/agent-hub-missing-sandbox', [], options));
    await expect(new SystemExec('darwin').run('unsafe-command', [], { ...opts, sandbox: { writableRoots: [] } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(SANDBOX_EXEC);
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(['-p', expect.any(String), '/usr/bin/true']);
  });

  it('能 spawn 但 Seatbelt 初始化失败时抛中文错误，不运行目标', async () => {
    vi.mocked(spawn).mockImplementationOnce((_cmd, _args, options) => realSpawn(process.execPath,
      ['-e', 'process.stderr.write("sandbox-exec: sandbox_apply: Operation not permitted"); process.exitCode = 71'], options));
    await expect(new SystemExec('darwin').run('unsafe-command', [], { ...opts, sandbox: { writableRoots: [] } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('探针无诊断但非零退出同样拒绝；不能把失败当成脚本的首次基线', async () => {
    vi.mocked(spawn).mockImplementationOnce((_cmd, _args, options) => realSpawn(process.execPath, ['-e', 'process.exitCode = 71'], options));
    await expect(new SystemExec('darwin').run('unsafe-command', [], { ...opts, sandbox: { writableRoots: [] } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('同一规则探针成功后才用沙箱执行目标，真实脚本的非零退出仍返回原结果', async () => {
    vi.mocked(spawn)
      .mockImplementationOnce((_cmd, _args, options) => realSpawn('/usr/bin/true', [], options))
      .mockImplementationOnce((_cmd, _args, options) => realSpawn(process.execPath,
        ['-e', 'process.stdout.write("结果"); process.stderr.write("脚本错误"); process.exitCode=7'], options));
    const result = await new SystemExec('darwin').run('target-command', ['space argument', 'literal;value'], { ...opts, sandbox: { writableRoots: [] } });
    expect(result).toEqual({ code: 7, stdout: '结果', stderr: '脚本错误', timedOut: false, outputTruncated: false, killedForOutput: false });
    expect(spawn).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.map(call => call[0])).toEqual([SANDBOX_EXEC, SANDBOX_EXEC]);
    expect(calls[0]![1]).toEqual(['-p', expect.any(String), '/usr/bin/true']);
    expect(calls[1]![1]).toEqual(['-p', calls[0]![1]![1], 'target-command', 'space argument', 'literal;value']);
  });

  it('探针成功后第二次沙箱启动失败仍抛错，即便输出上限小到看不全错误', async () => {
    vi.mocked(spawn)
      .mockImplementationOnce((_cmd, _args, options) => realSpawn('/usr/bin/true', [], options))
      .mockImplementationOnce((_cmd, _args, options) => realSpawn(process.execPath,
        ['-e', 'process.stderr.write("sandbox-exec: sandbox_apply: Operation not permitted"); process.exitCode = 71'], options));
    await expect(new SystemExec('darwin').run('unsafe-command', ['literal; value'], { ...opts, maxOutputBytes: 1, sandbox: { writableRoots: [] } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls.map(call => call[0])).toEqual([SANDBOX_EXEC, SANDBOX_EXEC]);
    expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(['-p', expect.any(String), 'unsafe-command', 'literal; value']);
    expect(vi.mocked(spawn).mock.calls[1]![2]).toMatchObject({ detached: true, shell: false, cwd: opts.cwd });
  });

  it('目录不存在或参数无效时不启动任何进程', async () => {
    for (const writableRoots of [['/agent-hub-m12-nonexistent-root'], ['relative'], [''], ['bad\0path']]) {
      await expect(new SystemExec('darwin').run('/usr/bin/true', [], { ...opts, sandbox: { writableRoots } })).rejects.toThrow(SANDBOX_UNAVAILABLE);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('规则使用真实目录与临时目录，转义空格、引号及反斜杠且不插入额外权限', async () => {
    const parent = await directory();
    const root = join(parent, '目录 space "quote" \\backslash');
    const alias = join(parent, 'alias');
    await mkdir(root); await symlink(root, alias);
    const actual = await realpath(root);
    const temp = await realpath(tmpdir());
    expect(await sandboxProfile({ writableRoots: [alias, root] }, 'darwin')).toBe(
      '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))'
      + `(allow file-write* (subpath ${sbplString(actual)}) (subpath ${sbplString(temp)}))`);
    expect(sbplString('/a" ) (allow file-write*) \\')).toBe('"/a\\" ) (allow file-write*) \\\\"');
  });

  it('不带 sandbox 保留普通执行，平台注入不改变参数、写入及非零退出结果', async () => {
    const root = await directory();
    const target = join(root, 'ordinary.txt');
    const result = await new SystemExec('linux').run(process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2]); process.stdout.write("普通执行"); process.exitCode=7', target, 'literal; $(no-shell)'], opts);
    expect(result).toMatchObject({ code: 7, stdout: '普通执行', timedOut: false, killedForOutput: false });
    expect(await readFile(target, 'utf8')).toBe('literal; $(no-shell)');
    expect(vi.mocked(spawn).mock.calls.map(call => call[0])).toEqual([process.execPath]);
  });
});

describe('M12 SystemExec 真实 macOS 写入隔离', () => {
  let unavailable: string | null = null;
  beforeAll(async () => {
    if (process.platform !== 'darwin') {
      unavailable = `当前平台 ${process.platform}，真实 Seatbelt 测试仅在 macOS 运行`;
      return;
    }
    // 唯一跳过条件来自独立、最小规则的 true 探针；后面的真实测试失败不得用跳过掩盖。
    try {
      const result = await new SystemExec().run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], opts);
      if (result.code !== 0 || result.timedOut || result.killedForOutput) unavailable = `sandbox-exec /usr/bin/true 不可运行：${result.stderr || `退出码 ${result.code}`}`;
    } catch (error) { unavailable = `sandbox-exec /usr/bin/true 启动失败：${error instanceof Error ? error.message : String(error)}`; }
  });

  for (const name of ['ordinary', 'space "quote" \\backslash']) it(`可写根 ${name} 与系统临时目录可写，主人家目录和指向它的链接都不可写`, async context => {
    if (unavailable) { console.info(`M12 真实沙箱测试跳过：${unavailable}`); context.skip(); return; }
    const root = join(await directory(true), name);
    await mkdir(root);
    const inside = join(root, 'inside.txt');
    const temporary = join(await directory(), 'temp.txt');
    const outside = join(homedir(), `.agent-hub-m12-blocked-${randomUUID()}`);
    const link = join(root, 'outside-link');
    await symlink(outside, link);
    expect(existsSync(outside)).toBe(false);
    try {
      const script = 'const fs=require("node:fs"); const [inside,temp,outside,link]=process.argv.slice(1); '
        + 'fs.writeFileSync(inside,"inside"); fs.writeFileSync(temp,"temp"); fs.writeFileSync("/dev/null","null"); '
        + 'for(const path of [outside,link]) { try {fs.writeFileSync(path,"escaped"); process.stdout.write("escaped\\n"); process.exitCode=23;} '
        + 'catch(error) {process.stdout.write("blocked:"+error.code+"\\n");} }';
      const result = await new SystemExec().run(process.execPath, ['-e', script, inside, temporary, outside, link],
        { ...opts, cwd: root, sandbox: { writableRoots: [root] } });
      expect(result).toMatchObject({ code: 0, timedOut: false, killedForOutput: false });
      expect(result.stdout).toMatch(/^blocked:E(?:PERM|ACCES)\nblocked:E(?:PERM|ACCES)\n$/);
      expect(await readFile(inside, 'utf8')).toBe('inside');
      expect(await readFile(temporary, 'utf8')).toBe('temp');
      expect(existsSync(outside)).toBe(false);
    } finally {
      // 断言失败也清理随机目标；如实现被改坏而越界写入，测试仍先失败，不把残留留在主人家目录。
      if (existsSync(outside)) await rm(outside, { force: true });
      expect(existsSync(outside)).toBe(false);
    }
  });

  it('真实沙箱内正常启动的脚本仍保留非零退出码和输出软上限', async context => {
    if (unavailable) { console.info(`M12 真实沙箱测试跳过：${unavailable}`); context.skip(); return; }
    const root = await directory(true);
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stdout.write("abcdefgh"); process.exitCode=7'],
      { ...opts, maxOutputBytes: 4, sandbox: { writableRoots: [root] } });
    expect(result).toEqual({ code: 7, stdout: 'abcd', stderr: '', timedOut: false, outputTruncated: true, killedForOutput: false });
  });
});
