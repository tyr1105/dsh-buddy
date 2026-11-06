/** M12 竞态回归：读取批准文件期间权限或出站记录变化，异步旧快照绝不能继续启动宿主命令。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval, requestApproval } from '../src/gate/approvals.js';
import { resolveSettings } from '../src/config/defaults.js';
import { WakeTicketSchema } from '../src/model/wake.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

/** 手动控制微任务交接点，测试不依赖真实时间或循环轮询。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** 先完成真实提交流程与主人批准，再暂停执行前的指纹读取，避免把提交阶段误当执行阶段。 */
async function setup(workDataAllowed = false) {
  const ctx = createTestContext();
  const bot = { ...botFixture, autonomy: 'L2' as const, sessionId: 'm12-race-session', workDataAllowed };
  ctx.store.table('bots').put(bot);
  const path = `${bot.homeDir}/work/race.py`;
  await ctx.fs.writeTextAtomic(path, 'print("原批准内容")\n');
  const command = { kind: 'run_command' as const,
    payload: { cmd: 'python3', args: ['work/race.py'], cwd: bot.homeDir }, why: '核对执行前权限变化' };
  const row = await submitOutbox(ctx, bot.id, command);
  await decideApproval(ctx, row.approvalId!, true);
  ctx.exec.set('python3', ['work/race.py'], { code: 0, stdout: '完成', stderr: '', timedOut: false });
  return { ctx, bot, path, command, row };
}
type State = Awaited<ReturnType<typeof setup>>;

/** 只拦截一次目标文件，释放后保留正常读取能力供下一次巡检证明可以恢复。 */
function holdFileRead(state: State) {
  const entered = deferred(), release = deferred();
  const read = state.ctx.fs.readBytes.bind(state.ctx.fs);
  let holding = true;
  state.ctx.fs.readBytes = async path => {
    const bytes = await read(path);
    if (holding && path === state.path) {
      holding = false;
      entered.resolve();
      await release.promise;
    }
    return bytes;
  };
  return { entered: entered.promise, release: release.resolve };
}

/** 恢复合法上下文后，原动作仅执行一次且只消费自己的批准票。 */
async function expectOneExecution(state: State) {
  await executeReadyOutbox(state.ctx);
  await executeReadyOutbox(state.ctx);
  expect(state.ctx.exec.calls).toHaveLength(1);
  expect(state.ctx.store.table('outbox').get(state.row.id)?.status).toBe('done');
  expect(state.ctx.store.table('approvals').get(state.row.approvalId!)?.status).toBe('used');
}

describe('M12 执行前等待文件时重查当前机器人权限', () => {
  it.each(['主人暂停', '降为 L0', '进入复盘'])('%s 发生在指纹读取期间：本轮不执行不耗票，恢复后仅执行一次', async change => {
    const state = await setup();
    const { ctx, bot, row } = state;
    const gate = holdFileRead(state);
    const running = executeReadyOutbox(ctx);
    await gate.entered;
    if (change === '主人暂停') ctx.store.table('bots').patch(bot.id, { lifecycle: 'paused' });
    if (change === '降为 L0') ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    if (change === '进入复盘') {
      ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid),
        id: 'w_m12race001', botId: bot.id, sessionId: bot.sessionId, variant: 'reflection',
        status: 'running', startedAt: ctx.clock.now(), endedAt: null });
    }
    gate.release();
    await running;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({ status: 'approved', usedAt: null });
    expect(ctx.store.table('outbox').get(row.id)).toMatchObject({ status: 'pending_approval', doneAt: null });
    expect(ctx.store.log('thread').all().filter(message => message.refId === row.id)).toEqual([]);
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'active', autonomy: 'L2' });
    if (change === '进入复盘') ctx.store.table('wakes').patch('w_m12race001', { endedAt: ctx.clock.now(), status: 'canceled' });
    await expectOneExecution(state);
  });

  it.each(['撤回工作数据授权', '新增工作数据目录'])('%s 发生在指纹读取期间：旧权限不放行，保留新边界后终结拒绝', async change => {
    const state = await setup(change === '撤回工作数据授权');
    const { ctx, bot, row } = state;
    if (change === '撤回工作数据授权') ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: [`${bot.homeDir}/work`] });
    const gate = holdFileRead(state);
    const running = executeReadyOutbox(ctx);
    await gate.entered;
    if (change === '撤回工作数据授权') ctx.store.table('bots').patch(bot.id, { workDataAllowed: false });
    else ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: [`${bot.homeDir}/work`] });
    gate.release();
    await running;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('approvals').get(row.approvalId!)?.usedAt).toBeNull();
    // 新边界持续存在时，下次巡检也不能启动，不把暂缓误当成已通过检查。
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('approvals').get(row.approvalId!)?.usedAt).toBeNull();
    expect(['failed', 'rejected']).toContain(ctx.store.table('outbox').get(row.id)?.status);
    expect(ctx.store.table('outbox').get(row.id)?.executionStarted).toBe(false);
  });
});

describe('M12 异步期间出站记录变化不能使用旧快照', () => {
  it.each(['status', 'payload', 'commandFiles'])('%s 在指纹读取期间被更新，旧命令不启动且不覆盖新记录', async field => {
    const state = await setup();
    const { ctx, row } = state;
    const gate = holdFileRead(state);
    const running = executeReadyOutbox(ctx);
    await gate.entered;
    const update = field === 'status' ? { status: 'rejected' as const, result: '动作已撤回' }
      : field === 'payload' ? { payload: { ...state.command.payload, args: ['work/other.py'] } }
        : { commandFiles: [] };
    ctx.store.table('outbox').patch(row.id, update);
    const current = ctx.store.table('outbox').get(row.id);
    gate.release();
    await running;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({ status: 'approved', usedAt: null });
    expect(ctx.store.table('outbox').get(row.id)).toEqual(current);
  });

  it('关联批准票在指纹读取期间改成另一张待批票，旧票不执行；新票批准后只消费新票', async () => {
    const state = await setup();
    const { ctx, bot, row } = state;
    const next = await requestApproval(ctx, bot.id, 'hub_outbox_execute',
      { kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] }, 'C', '重新核对动作');
    const gate = holdFileRead(state);
    const running = executeReadyOutbox(ctx);
    await gate.entered;
    ctx.store.table('outbox').patch(row.id, { approvalId: next.id });
    gate.release();
    await running;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('outbox').get(row.id)?.approvalId).toBe(next.id);
    expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({ status: 'approved', usedAt: null });
    expect(ctx.store.table('approvals').get(next.id)).toMatchObject({ status: 'pending', usedAt: null });
    await decideApproval(ctx, next.id, true);
    await executeReadyOutbox(ctx);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(1);
    expect(ctx.store.table('approvals').get(next.id)?.status).toBe('used');
    expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({ status: 'approved', usedAt: null });
  });

  it.each(['rejected', 'expired'] as const)('指纹读取期间批准票变为 %s，本轮不能执行或消耗票', async status => {
    const state = await setup();
    const { ctx, row } = state;
    const gate = holdFileRead(state);
    const running = executeReadyOutbox(ctx);
    await gate.entered;
    ctx.store.table('approvals').patch(row.approvalId!, { status });
    gate.release();
    await running;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({ status, usedAt: null });
  });
});
