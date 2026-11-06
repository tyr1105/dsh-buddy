/** 真实进程独立成组运行；软截断只限制保存量，超时或硬上限才终止整组，避免孙进程拖住宿主。 */
import { spawn } from 'node:child_process';
import { EXEC_OUTPUT_HARD_LIMIT_MULTIPLIER } from '../config/defaults.js';
import type { ExecIO, ExecOptions, ExecResult } from './interfaces.js';
import { utf8Prefix } from './utf8-prefix.js';
import { SANDBOX_EXEC, SANDBOX_UNAVAILABLE, sandboxProfile } from './system-sandbox.js';

/** 以完整 UTF-8 前缀解码已保存的字节，避免边界处半个汉字变成替换字符。 */
function completeUtf8(chunks: Buffer[], maxBytes: number): string {
  const bytes = Buffer.concat(chunks);
  return utf8Prefix(new TextDecoder().decode(bytes, { stream: true }), maxBytes);
}

/** 在系统边界管理进程组与管道，让核心层只需检查结构化结果。 */
export class SystemExec implements ExecIO {
  /** 平台可在测试中注入；真实运行默认读取当前系统，不能通过命令参数关闭沙箱。 */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** 不经过 shell 启动程序；正常退出保留真实退出码，强制终止明确报告原因。 */
  async run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
    if (!Number.isSafeInteger(opts.maxOutputBytes) || opts.maxOutputBytes < 0) {
      throw new Error('进程 maxOutputBytes 必须是非负整数');
    }
    if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new Error('进程 timeoutMs 必须是正整数');
    }
    if (opts.sandbox === undefined) return this.start(cmd, args, opts);
    try {
      const profile = await sandboxProfile(opts.sandbox, this.platform);
      // 成功 spawn 不代表 Seatbelt 已启用；同规则先跑 true，嵌套沙箱被系统拒绝时绝不启动目标。
      const probe = await this.start(SANDBOX_EXEC, ['-p', profile, '/usr/bin/true'], opts, true);
      if (probe.code !== 0 || probe.timedOut || probe.killedForOutput) {
        throw new Error(`sandbox-exec 可用性检查失败：${probe.stderr || `退出码 ${probe.code}`}`);
      }
      return await this.start(SANDBOX_EXEC, ['-p', profile, cmd, ...args], opts, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(reason.startsWith(SANDBOX_UNAVAILABLE) ? reason : `${SANDBOX_UNAVAILABLE}（${reason}）`, { cause: error });
    }
  }

  /** 沙箱包装与普通执行共用同一套进程组、超时和输出上限处理，避免出现未受控的备用执行路径。 */
  private start(cmd: string, args: string[], opts: ExecOptions, sandboxLaunch = false): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const retained = { stdout: 0, stderr: 0 };
      let totalBytes = 0;
      let settled = false;
      let outputTruncated = false;
      // 只保留诊断前缀；即便调用方输出上限很小，也能识别探测后再次启动时的沙箱故障。
      const sandboxDiagnostic = 'sandbox-exec:';
      let stderrPrefix = '';

      /** 负 pid 对应本次调用的独立进程组；组已消失是正常清理结果。 */
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };

      /** 管道出错或启动失败时统一收尾，避免后台计时器和读取继续存活。 */
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 流读取失败也要停止命令；清理本身失败时合并原因，不遗失原始故障。
        let cause = error;
        try {
          killGroup();
        } catch (cleanupError) {
          cause = new AggregateError([error, cleanupError], '进程执行与清理均失败');
        }
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`启动或清理命令失败：${error instanceof Error ? error.message : String(error)}`, { cause }));
      };

      /** 一次性返回有界结果；主动终止时不等待后代关闭继承的管道。 */
      const finish = (code: number | null, timedOut: boolean, killedForOutput: boolean): void => {
        if (settled) return;
        if (sandboxLaunch && stderrPrefix === sandboxDiagnostic) {
          fail(new Error(`sandbox-exec 启动沙箱命令失败：${completeUtf8(stderr, opts.maxOutputBytes)}`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          code,
          stdout: completeUtf8(stdout, opts.maxOutputBytes),
          stderr: completeUtf8(stderr, opts.maxOutputBytes),
          timedOut,
          outputTruncated,
          killedForOutput,
        });
      };

      /** 先终止整个进程组再结束等待，孙进程是否持有管道都不影响时限。 */
      const terminate = (timedOut: boolean): void => {
        try {
          killGroup();
          finish(null, timedOut, !timedOut);
        } catch (error) {
          fail(error);
        }
      };
      const timer = setTimeout(() => terminate(true), opts.timeoutMs);
      timer.unref();

      /** 每条流只保存上限内的前缀，剩余仍持续读空；合计超过硬上限才停止运行。 */
      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (settled) return;
        if (sandboxLaunch && stream === 'stderr' && stderrPrefix.length < sandboxDiagnostic.length) {
          stderrPrefix += chunk.subarray(0, sandboxDiagnostic.length - stderrPrefix.length).toString('ascii');
        }
        totalBytes += chunk.length;
        const keep = Math.min(chunk.length, opts.maxOutputBytes - retained[stream]);
        if (keep > 0) {
          (stream === 'stdout' ? stdout : stderr).push(Buffer.from(chunk.subarray(0, keep)));
          retained[stream] += keep;
        }
        if (keep < chunk.length) outputTruncated = true;
        if (totalBytes > opts.maxOutputBytes * EXEC_OUTPUT_HARD_LIMIT_MULTIPLIER) terminate(false);
      };
      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.once('error', error => {
        if (settled) return;
        // 无法启动没有进程组可清理；保留既有中文接口错误，便于上层记录原因。
        settled = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`启动命令失败：${error.message}`, { cause: error }));
      });
      child.once('exit', () => {
        // 主进程正常结束也清理后台后代，随后 close 会让已在管道内的输出读完。
        if (settled) return;
        try {
          killGroup();
        } catch (error) {
          fail(error);
        }
      });
      child.once('close', code => finish(code, false, false));
    });
  }
}
