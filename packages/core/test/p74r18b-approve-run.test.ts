/**
 * P74r18b 第 1、3 节的测试：批准之后立刻执行、执行完再叫醒；普通出站动作的结果文字不带命令全文和绝对路径。
 *
 * 覆盖（普通出站动作，不属于任何一件事；属于一件事的发布审批见 p74r18b-launch-result.test.ts）：
 * 1 批准之后不推进时钟命令就已执行；
 * 2 批准的那一刻员工没有被叫醒（命令还没跑完时队列里没有他的唤醒、没有审批感知）；执行完之后被叫醒一次，唤醒原因里是结果（成功、失败各逐字）；
 * 3 连续批准两条：各执行一次，不重复；
 * 4 拒绝照旧叫醒并告诉他不要执行；过期照旧；
 * 5 私聊里那行结果：成功、失败各一条，不含命令原文和以 / 开头的绝对路径，没有可写范围清单；
 * 6 与巡检里的执行不重入：批准时命令还在跑，巡检再跑一遍也只执行一次。
 * 用假的命令执行接口控制成功、失败和「命令还在跑」；时间用注入的假时钟。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import type { FakeExec } from '../src/io/testing/fake-exec.js';
import { createBotHome } from '../src/memory/files.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval, expireApprovals } from '../src/gate/approvals.js';
import { botFixture } from './model-fixtures.js';

const ok = { code: 0, stdout: '已完成', stderr: '', timedOut: false };

async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("x")\n');
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/y.js`, 'console.log("y")\n');
  // 界面命令入口（主人点「批准」走的路）：批准之后立刻开始执行的触发点在这里（api/index.ts）。
  const hub = createHub(ctx);
  await hub.start();
  return { ctx, bot, hub };
}
type Fix = Awaited<ReturnType<typeof setup>>;
/** 像主人在界面上点「批准」：走界面命令入口，批准之后立刻开始执行。 */
async function approveInUi(fix: Fix, approvalId: string) {
  expect(await fix.hub.api.decideApproval(approvalId, true)).toMatchObject({ ok: true });
}

/** 提交一条命令，返回出站单。 */
async function submit(fix: Fix, cmd: string, args: string[]) {
  return submitOutbox(fix.ctx, fix.bot.id, { kind: 'run_command', payload: { cmd, args, cwd: fix.bot.homeDir }, why: '核对任务结果' });
}
/** 让假的命令执行接口先卡住，直到调用返回的 release：模拟「命令还在跑」。返回已开始运行的次数。 */
function holdExec(fix: Fix): { release: () => void; started: () => number } {
  const exec = fix.ctx.exec as FakeExec;
  const original = exec.run.bind(exec);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  exec.run = async (cmd, args, opts) => { started += 1; await gate; return original(cmd, args, opts); };
  return { release, started: () => started };
}
/**
 * 这位员工排着的、或已经开始的唤醒（队列里的候选，加上已经被调度成回合的唤醒单）：
 * 界面命令之后 Hub 会马上调度，排队的候选可能已经变成了回合，两处合起来才是「他被叫醒了几次」。
 */
const queueOf = (fix: Fix) => [...fix.ctx.store.table('queue').list(row => row.botId === fix.bot.id),
  ...fix.ctx.store.table('wakes').list(row => row.botId === fix.bot.id)];
const resultLines = (fix: Fix, outboxId: string) => fix.ctx.store.log('thread').all().filter(message => message.kind === 'system' && message.refId === outboxId);

describe('1 批准之后立刻执行', () => {
  it('批准之后不推进时钟，命令就已经执行；出站单已完成', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const row = await submit(fix, 'python3', ['work/x.py']);
    expect(fix.ctx.exec.calls).toHaveLength(0);
    const before = fix.ctx.clock.now();
    await approveInUi(fix, row.approvalId!);
    await vi.waitFor(() => expect(fix.ctx.exec.calls).toHaveLength(1));
    await vi.waitFor(() => expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('done'));
    expect(fix.ctx.clock.now()).toBe(before);
    expect(fix.ctx.store.table('approvals').get(row.approvalId!)!.status).toBe('used');
  });

  it('反例：还没批准（待批）时不执行；在界面上点拒绝时不执行', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const row = await submit(fix, 'python3', ['work/x.py']);
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls).toHaveLength(0);
    expect(await fix.hub.api.decideApproval(row.approvalId!, false)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls).toHaveLength(0);
    expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('rejected');
  });

  it('巡检兜底：只记下批准决定（没有走界面入口）时，下一次巡检里的执行照旧执行一次', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    expect(fix.ctx.exec.calls).toHaveLength(0);
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls).toHaveLength(1);
    expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('done');
  });

  it('与巡检里的执行不重入：批准时命令还在跑，巡检再跑一遍也只执行一次', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const hold = holdExec(fix);
    const row = await submit(fix, 'python3', ['work/x.py']);
    await approveInUi(fix, row.approvalId!);
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    // 巡检里的执行：命令还在跑，这条记录被防重入集合挡住，不会再执行一次。它要等批准触发的那次做完，所以先放行再等。
    const tick = executeReadyOutbox(fix.ctx);
    hold.release();
    await tick;
    expect(fix.ctx.exec.calls).toHaveLength(1);
    expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('done');
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls).toHaveLength(1);
  });
});

describe('4.1 /private/tmp 先看存在才放进可写清单', () => {
  it('目录不存在：清单里没有它，命令照常起来；目录存在：清单里有它', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    expect(await fix.ctx.fs.lstat('/private/tmp')).toBeNull();
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('done');
    expect(fix.ctx.exec.calls[0]!.opts.sandbox!.writableRoots).toEqual([fix.bot.homeDir, '/hub/shared']);
    await fix.ctx.fs.mkdirp('/private/tmp');
    const again = await submit(fix, 'python3', ['work/x.py', '--again']);
    fix.ctx.exec.set('python3', ['work/x.py', '--again'], ok);
    await decideApproval(fix.ctx, again.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls[1]!.opts.sandbox!.writableRoots).toEqual([fix.bot.homeDir, '/hub/shared', '/private/tmp']);
  });
});

describe('2 批准时不叫醒，执行完再叫醒一次，唤醒原因是结果', () => {
  it('成功：批准的那一刻队列里没有他的唤醒；执行完之后有一条，原因逐字', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const hold = holdExec(fix);
    const row = await submit(fix, 'python3', ['work/x.py']);
    await approveInUi(fix, row.approvalId!);
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    // 命令还在跑：没有唤醒、没有审批结果感知。
    expect(queueOf(fix)).toHaveLength(0);
    expect(fix.ctx.store.table('percepts').list(p => p.kind === 'approval_decided')).toHaveLength(0);
    hold.release();
    await executeReadyOutbox(fix.ctx);
    const entries = queueOf(fix);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason.summary).toBe('你提交的动作已由中心运行成功：请中心代为运行一条命令。');
    // 结果感知已标成已评估，不会再被感知收集器另建一条候选。
    expect(fix.ctx.store.table('percepts').list(p => p.kind === 'outbox_done').every(p => p.evaluatedAt !== undefined)).toBe(true);
  });

  it('失败：唤醒原因逐字，错误取错误输出（去掉换行）', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], { code: 1, stdout: '', stderr: 'mkdir: /tmp/x: Operation not permitted\n第二行', timedOut: false });
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    const entries = queueOf(fix);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason.summary).toBe('你提交的动作由中心运行失败：请中心代为运行一条命令。错误：mkdir: /tmp/x: Operation not permitted 第二行。');
  });

  it('失败：错误只取前 200 字', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], { code: 1, stdout: '', stderr: '错'.repeat(300), timedOut: false });
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    expect(queueOf(fix)[0]!.reason.summary).toBe(`你提交的动作由中心运行失败：请中心代为运行一条命令。错误：${'错'.repeat(200)}。`);
  });

  it('拒绝时照旧叫醒，并告诉他不要执行；命令没有运行', async () => {
    const fix = await setup();
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, false);
    const entries = queueOf(fix);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason.summary).toContain('拒绝，不要执行');
    expect(fix.ctx.exec.calls).toHaveLength(0);
  });

  it('过期照旧叫醒，并告诉他不要执行', async () => {
    const fix = await setup();
    const row = await submit(fix, 'python3', ['work/x.py']);
    fix.ctx.clock.advance(fix.ctx.settings.approvalExpiryMs + 1_000);
    await expireApprovals(fix.ctx, fix.ctx.clock.now());
    const entries = queueOf(fix);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason.summary).toContain('过期，视为拒绝，不要执行');
    expect(fix.ctx.exec.calls).toHaveLength(0);
  });
});

describe('3 连续批准两条', () => {
  it('各执行一次，不重复执行；再跑巡检也不会重复', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok).set('node', ['work/y.js'], ok);
    const a = await submit(fix, 'python3', ['work/x.py']);
    const b = await submit(fix, 'node', ['work/y.js']);
    await approveInUi(fix, a.approvalId!);
    await approveInUi(fix, b.approvalId!);
    await executeReadyOutbox(fix.ctx);
    await executeReadyOutbox(fix.ctx);
    expect(fix.ctx.exec.calls.map(call => call.cmd).sort()).toEqual(['node', 'python3']);
    expect([a.id, b.id].map(id => fix.ctx.store.table('outbox').get(id)!.status)).toEqual(['done', 'done']);
    // 两条结果合并成他的一条排队的唤醒（同一位员工、不属于任何一件事），证据里有两张审批。
    // 两条结果都叫醒了他（合并成一条排队的唤醒，或已经被调度成回合）：证据里有两张审批，也只有结果这一种原因。
    const entries = queueOf(fix);
    expect(entries.flatMap(entry => entry.reason.evidence)).toEqual(expect.arrayContaining([a.approvalId!, b.approvalId!]));
    expect(entries.every(entry => entry.reason.summary.startsWith('你提交的动作已由中心运行成功：'))).toBe(true);
  });
});

describe('5 私聊里的结果行不带命令全文和绝对路径（第 3 节）', () => {
  /** 以 / 开头的绝对路径：出现在行首、空白、冒号、顿号、括号之后的 /字母。 */
  const absolutePath = /(^|[\s：、（(])\/[A-Za-z]/;

  it('成功：保留说明和结果，不含命令原文、绝对路径、可写范围清单', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], ok);
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    const lines = resultLines(fix, row.id);
    expect(lines).toHaveLength(1);
    const text = lines[0]!.text;
    expect(text).toContain('已执行你批准的：请中心代为运行一条命令 → 已完成（命令执行完成）');
    expect(text).not.toContain('python3');
    expect(text).not.toContain('work/x.py');
    expect(text).not.toContain('沙箱可写');
    expect(text).not.toMatch(absolutePath);
    // 命令全文仍在出站记录里。
    expect(fix.ctx.store.table('outbox').get(row.id)!.payload).toMatchObject({ cmd: 'python3', args: ['work/x.py'] });
  });

  it('失败：保留说明、失败和白话原因，不含命令原文、绝对路径；错误输出原文只在出站记录里', async () => {
    const fix = await setup();
    fix.ctx.exec.set('python3', ['work/x.py'], { code: 2, stdout: '', stderr: 'mkdir: /tmp/x: Operation not permitted', timedOut: false });
    const row = await submit(fix, 'python3', ['work/x.py']);
    await decideApproval(fix.ctx, row.approvalId!, true);
    await executeReadyOutbox(fix.ctx);
    const text = resultLines(fix, row.id)[0]!.text;
    expect(text).toContain('已执行你批准的：请中心代为运行一条命令 → 失败：命令退出码 2');
    expect(text).not.toContain('python3');
    expect(text).not.toContain('work/x.py');
    expect(text).not.toContain('沙箱可写');
    expect(text).not.toMatch(absolutePath);
    expect(text).not.toContain('Operation not permitted');
    expect(fix.ctx.store.table('outbox').get(row.id)!.result).toContain('Operation not permitted');
  });
});
