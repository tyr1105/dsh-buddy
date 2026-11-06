/** M01 执行结果的业务回归：脚本与出站都区分软截断、超时、硬终止和其他信号终止。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { ExecResult } from '../src/io/interfaces.js';
import { pollScript } from '../src/perception/script.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval } from '../src/gate/approvals.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { perceptionContext } from './perception-fixtures.js';

const normal: ExecResult = {
  code: 0, stdout: '结果', stderr: '', timedOut: false, outputTruncated: false, killedForOutput: false,
};
const failures: Array<[string, Partial<ExecResult>, string]> = [
  ['超时', { code: null, timedOut: true }, '时'],
  ['输出硬终止', { code: null, outputTruncated: true, killedForOutput: true }, '输出超过硬上限'],
  ['其他信号', { code: null }, '信号终止'],
];

describe('脚本关注项的执行结果', () => {
  it('软截断可建立基线，真实非零退出仍产生退出码变化感知', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status' });
    ctx.exec.set('git', ['status'], { ...normal, outputTruncated: true });
    let watch = ctx.store.table('watches').get(watchFixture.id)!;
    expect(await pollScript(ctx, watch, ctx.clock.now())).toBeNull();
    watch = ctx.store.table('watches').get(watch.id)!;
    expect(watch.lastFingerprint).not.toBeNull();
    expect(readWatchState(watch).code).toBe(0);
    ctx.exec.set('git', ['status'], { ...normal, code: 7, outputTruncated: true });
    expect(await pollScript(ctx, watch, ctx.clock.now())).toMatchObject({ kind: 'exit_changed', anomaly: true });
    expect(readWatchState(ctx.store.table('watches').get(watch.id)!).code).toBe(7);
  });

  it.each(failures)('%s 拒绝更新原基线并保留明确原因', async (_name, patch, reason) => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status' });
    ctx.exec.set('git', ['status'], normal);
    await pollScript(ctx, ctx.store.table('watches').get(watchFixture.id)!, ctx.clock.now());
    const before = ctx.store.table('watches').get(watchFixture.id)!;
    ctx.exec.set('git', ['status'], { ...normal, ...patch });
    await expect(pollScript(ctx, before, ctx.clock.now())).rejects.toThrow(reason);
    expect(ctx.store.table('watches').get(before.id)).toEqual(before);
  });
});

describe('出站命令的执行结果', () => {
  /** M12 宿主只读命令也须先批准，再验证原有执行结果处理。 */
  async function execute(result: ExecResult) {
    const ctx = createTestContext();
    ctx.store.table('bots').put(botFixture);
    ctx.exec.set('echo', ['result'], result);
    const row = await submitOutbox(ctx, botFixture.id, {
      kind: 'run_command', payload: { cmd: 'echo', args: ['result'], cwd: botFixture.homeDir }, why: '核对结果',
    });
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    return ctx.store.table('outbox').get(row.id)!;
  }

  it('软截断的零退出码记为完成，并说明结果只是前缀', async () => {
    const row = await execute({ ...normal, outputTruncated: true });
    expect(row.status).toBe('done');
    expect(row.result).toContain('输出已截断');
    expect(row.result).toContain('结果');
  });

  it('软截断的非零退出码仍记为失败，保留真实退出码', async () => {
    const row = await execute({ ...normal, code: 7, outputTruncated: true });
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.result).toContain('退出码 7');
  });

  it.each(failures)('%s 记为失败并给出对应原因', async (_name, patch, reason) => {
    const row = await execute({ ...normal, ...patch });
    expect(row.status).toBe('failed');
    expect(row.result).toContain(reason);
    expect(row.result).not.toContain('退出码 null');
  });
});
