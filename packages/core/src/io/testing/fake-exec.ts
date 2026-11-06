/** 按命令和完整参数数组预设结果，保留参数边界，并复现真实执行器的软截断与硬限制。 */
import { EXEC_OUTPUT_HARD_LIMIT_MULTIPLIER } from '../../config/defaults.js';
import type { ExecIO, ExecOptions, ExecResult } from '../interfaces.js';
import { utf8Prefix } from '../utf8-prefix.js';

/** 兼容旧测试的预设输入；执行结果始终包含完整的资源限制状态。 */
type PlannedResult = Omit<ExecResult, 'outputTruncated' | 'killedForOutput'>
  & Partial<Pick<ExecResult, 'outputTruncated' | 'killedForOutput'>>;

/** 无真实副作用的执行替身，供感知与出站测试复现各种退出情况。 */
export class FakeExec implements ExecIO {
  readonly calls: Array<{ cmd: string; args: string[]; opts: ExecOptions }> = [];
  private readonly responses = new Map<string, PlannedResult | Error>();

  /** 保存指定命令和参数对应的结果或故障，数组序列化避免参数串联歧义。 */
  set(cmd: string, args: string[], response: PlannedResult | Error): this {
    this.responses.set(JSON.stringify([cmd, args]), response instanceof Error ? response : { ...response });
    return this;
  }

  /** 深复制包含 sandbox.writableRoots 的选项，确保调用后改参数也不会改写安全断言证据。 */
  async run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args: [...args], opts: structuredClone(opts) });
    const response = this.responses.get(JSON.stringify([cmd, args]));
    if (!response) throw new Error(`未预设命令结果：${cmd}`);
    if (response instanceof Error) throw response;
    const stdoutBytes = Buffer.byteLength(response.stdout);
    const stderrBytes = Buffer.byteLength(response.stderr);
    const killedForOutput = response.killedForOutput === true
      || (!response.timedOut && stdoutBytes + stderrBytes > opts.maxOutputBytes * EXEC_OUTPUT_HARD_LIMIT_MULTIPLIER);
    return {
      ...response,
      code: killedForOutput ? null : response.code,
      stdout: utf8Prefix(response.stdout, opts.maxOutputBytes),
      stderr: utf8Prefix(response.stderr, opts.maxOutputBytes),
      outputTruncated: response.outputTruncated === true || stdoutBytes > opts.maxOutputBytes || stderrBytes > opts.maxOutputBytes,
      killedForOutput,
    };
  }
}
