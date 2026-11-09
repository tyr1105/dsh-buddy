/** M01 进程组与输出限制回归：真实本地进程证明后代不拖住等待，替身证明同一结果契约。 */
import { describe, expect, it, vi } from 'vitest';
import { SystemExec } from '../src/io/system-exec.js';
import { FakeExec } from '../src/io/testing/fake-exec.js';

const opts = { cwd: '/', timeoutMs: 300, maxOutputBytes: 1024 };

/** 信号零只检查存在性，不发送信号；ESRCH 证明该进程组已完全消失。 */
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** 失败断言也清理测试启动的组，避免真实系统回归污染后续测试。 */
function cleanup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe('SystemExec 孙进程生命周期', () => {
  it('孙进程占着管道：300ms 超时在 800ms 内返回，而不是等待 sleep 5', async () => {
    const start = performance.now();
    const result = await new SystemExec().run('/bin/sh', ['-c', 'echo $$; sleep 5; echo done'], opts);
    const elapsedMs = performance.now() - start;
    const pid = Number(result.stdout.trim());
    try {
      expect(result).toMatchObject({ code: null, timedOut: true, killedForOutput: false });
      expect(elapsedMs).toBeLessThan(opts.timeoutMs + 500);
      expect(elapsedMs).toBeLessThan(1000);
      expect(result.stdout).not.toContain('done');
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(groupExists(pid)).toBe(false), { timeout: 500, interval: 10 });
      console.info(`M01 grandchild-pipe timeoutMs=300 elapsedMs=${Math.round(elapsedMs)} timedOut=${result.timedOut}`);
    } finally {
      cleanup(pid);
    }
  });

  it('主进程正常退出仍杀掉不占管道的后台孙进程，并保留退出码', async () => {
    const start = performance.now();
    const result = await new SystemExec().run('/bin/sh', ['-c', 'echo $$; sleep 5 >/dev/null 2>&1 & exit 7'], { ...opts, timeoutMs: 5000 });
    const pid = Number(result.stdout.trim());
    try {
      expect(result).toMatchObject({ code: 7, timedOut: false, killedForOutput: false });
      expect(performance.now() - start).toBeLessThan(1000);
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(groupExists(pid)).toBe(false), { timeout: 500, interval: 10 });
    } finally {
      cleanup(pid);
    }
  });

  it('永不结束的 tail 孙进程也在超时后返回并消失', async () => {
    const start = performance.now();
    const result = await new SystemExec().run('/bin/sh', ['-c', 'echo $$; tail -f /dev/null; echo done'], opts);
    const pid = Number(result.stdout.trim());
    try {
      expect(result.timedOut).toBe(true);
      expect(performance.now() - start).toBeLessThan(opts.timeoutMs + 500);
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(groupExists(pid)).toBe(false), { timeout: 500, interval: 10 });
    } finally {
      cleanup(pid);
    }
  });
});

describe('SystemExec 输出软限与硬限', () => {
  it('stdout 与 stderr 各自保留上限，不共享保存空间', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.stdout.write("abcdX"); process.stderr.write("efghY"); process.exitCode = 6'], { ...opts, timeoutMs: 5000, maxOutputBytes: 4 });
    expect(result).toEqual({ code: 6, stdout: 'abcd', stderr: 'efgh', timedOut: false, outputTruncated: true, killedForOutput: false });
  });

  it('硬限以内即使多次写超软限也继续读空管道，保留真实退出码', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'let n = 0; const t = setInterval(() => { process.stdout.write("x".repeat(1024)); if (++n === 16) { clearInterval(t); process.exitCode = 5; } }, 1)'], { ...opts, timeoutMs: 5000 });
    expect(result).toMatchObject({ code: 5, timedOut: false, outputTruncated: true, killedForOutput: false });
    expect(result.stdout).toHaveLength(opts.maxOutputBytes);
  });

  it.each(['stdout', 'stderr'])('单独 %s 超过 32 倍硬限才杀组', async stream => {
    const result = await new SystemExec().run(process.execPath, ['-e', `process.${stream}.write("x".repeat(4 * 33)); setInterval(() => {}, 1000)`], { ...opts, timeoutMs: 5000, maxOutputBytes: 4 });
    expect(result).toMatchObject({ code: null, timedOut: false, outputTruncated: true, killedForOutput: true });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4);
  });

  it('输出硬终止同样清理不占管道的后台孙进程', async () => {
    const source = 'require("node:child_process").spawn("sleep", ["5"], { stdio: "ignore" }); process.stdout.write(process.pid + "\\n"); process.stdout.write("x".repeat(1024 * 33)); setInterval(() => {}, 1000)';
    const result = await new SystemExec().run(process.execPath, ['-e', source], { ...opts, timeoutMs: 5000 });
    const pid = Number(result.stdout.split('\n')[0]);
    try {
      expect(result).toMatchObject({ code: null, timedOut: false, outputTruncated: true, killedForOutput: true });
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(groupExists(pid)).toBe(false), { timeout: 500, interval: 10 });
    } finally {
      cleanup(pid);
    }
  });

  it('两条流合计超过硬限也被终止，恰好等于硬限可以正常退出', async () => {
    const exec = new SystemExec();
    const exact = await exec.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(64)); process.stderr.write("y".repeat(64)); process.exitCode = 8'], { ...opts, timeoutMs: 5000, maxOutputBytes: 4 });
    expect(exact).toMatchObject({ code: 8, outputTruncated: true, killedForOutput: false });
    const over = await exec.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(64)); process.stderr.write("y".repeat(65)); setInterval(() => {}, 1000)'], { ...opts, timeoutMs: 5000, maxOutputBytes: 4 });
    expect(over).toMatchObject({ code: null, timedOut: false, killedForOutput: true });
  });

  it('零上限允许安静命令完成，有任何输出则触发零字节硬限', async () => {
    const exec = new SystemExec();
    const quiet = await exec.run(process.execPath, ['-e', 'process.exitCode = 3'], { ...opts, timeoutMs: 5000, maxOutputBytes: 0 });
    expect(quiet).toEqual({ code: 3, stdout: '', stderr: '', timedOut: false, outputTruncated: false, killedForOutput: false });
    const noisy = await exec.run(process.execPath, ['-e', 'process.stdout.write("x")'], { ...opts, timeoutMs: 5000, maxOutputBytes: 0 });
    expect(noisy).toMatchObject({ code: null, stdout: '', outputTruncated: true, killedForOutput: true });
  });

  it('自身收到信号时 code 为 null，但不冒充超时或输出硬终止', async () => {
    const result = await new SystemExec().run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { ...opts, timeoutMs: 5000 });
    expect(result).toMatchObject({ code: null, timedOut: false, outputTruncated: false, killedForOutput: false });
  });
});

describe('FakeExec 新结果契约', () => {
  it('旧预设补齐字段，软限截断保持原退出码', async () => {
    const exec = new FakeExec().set('soft', [], { code: 7, stdout: '中文文本', stderr: '', timedOut: false });
    expect(await exec.run('soft', [], { ...opts, maxOutputBytes: 4 })).toEqual({ code: 7, stdout: '中', stderr: '', timedOut: false, outputTruncated: true, killedForOutput: false });
  });

  it('根据总字节量产生硬终止，也支持显式预设已经截断的结果', async () => {
    const exec = new FakeExec()
      .set('hard', [], { code: 0, stdout: 'x'.repeat(64), stderr: 'y'.repeat(65), timedOut: false })
      .set('preset', [], { code: null, stdout: 'x', stderr: '', timedOut: false, outputTruncated: true, killedForOutput: true });
    expect(await exec.run('hard', [], { ...opts, maxOutputBytes: 4 })).toMatchObject({ code: null, outputTruncated: true, killedForOutput: true });
    expect(await exec.run('preset', [], opts)).toMatchObject({ code: null, outputTruncated: true, killedForOutput: true });
  });
});
