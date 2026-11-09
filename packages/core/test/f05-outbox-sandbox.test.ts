/**
 * F05 沙箱补洞：宿主命令必须携带沙箱执行、执行目录受限、沙箱不可用时失败关闭，
 * 并把命令、退出码、输出摘要和可写目录写回线程（计划 6.1 场景 G/H）。
 * 单元部分用注入的执行器检查参数与线程事实；真实 Seatbelt 部分按独立探针决定是否运行。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval } from '../src/gate/approvals.js';
import { overview } from '../src/api/summary-views.js';
import { HOST_SANDBOX_UNAVAILABLE, SANDBOX_UNAVAILABLE, type ExecOptions } from '../src/io/interfaces.js';
import { SystemExec } from '../src/io/system-exec.js';
import { SANDBOX_EXEC } from '../src/io/system-sandbox.js';
import { resolveSettings } from '../src/config/defaults.js';
import type { OutboxAction } from '../src/model/outreach.js';
import { botFixture } from './model-fixtures.js';

const response = { code: 0, stdout: '已完成', stderr: '', timedOut: false };
const outsideCwd = '命令执行目录必须在家目录或共享目录内，宿主命令不运行';
const folders: string[] = [];

/** 每个用例都有独立的内存中心，所有真实进程副作用只发生在登记的临时目录里。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("已核对")\n');
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/y.js`, 'console.log("已核对")\n');
  return { ctx, bot };
}

/** 提交、批准并跑一轮放行，返回最终出站单；失败也要走真实的失败收尾。 */
async function approveAndRun(
  ctx: Awaited<ReturnType<typeof setup>>['ctx'],
  botId: string,
  payload: { cmd: string; args: string[]; cwd: string },
): Promise<OutboxAction> {
  const row = await submitOutbox(ctx, botId, { kind: 'run_command', payload, why: '核对任务结果' });
  await decideApproval(ctx, row.approvalId!, true);
  await executeReadyOutbox(ctx);
  return ctx.store.table('outbox').get(row.id)!;
}

/** 只找动作自己的执行回执，不能拿审批通知冒充执行后的结果。 */
function resultMessages(ctx: Awaited<ReturnType<typeof setup>>['ctx'], row: OutboxAction) {
  return ctx.store.log('thread').all().filter(message => message.kind === 'system' && message.refId === row.id);
}

/** 登记并创建测试临时目录，结束时统一清理。 */
async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), `.agent-hub-f05-${prefix}-`));
  folders.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

describe('F05 宿主命令在沙箱内执行（场景 G）', () => {
  it('家目录内执行：携带沙箱，并把命令、退出码、输出和可写目录写回线程', async () => {
    const { ctx, bot } = await setup();
    ctx.exec.set('python3', ['work/x.py'], response);
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: bot.homeDir });
    expect(ctx.exec.calls).toHaveLength(1);
    // 沙箱可写范围只有家目录与共享目录；系统临时目录由沙箱实现自动加入。
    expect(ctx.exec.calls[0]!.opts.sandbox).toEqual({ writableRoots: [bot.homeDir, '/hub/shared'], denyWriteRoots: [] });
    expect(row.status).toBe('done');
    const messages = resultMessages(ctx, row);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('命令：python3 work/x.py');
    expect(messages[0]!.text).toContain('退出码：0');
    expect(messages[0]!.text).toContain('输出摘要（命令输出，不可信）：已完成');
    expect(messages[0]!.text).toContain(`沙箱可写：${bot.homeDir}、/hub/shared、系统临时目录`);
  });

  it('共享目录内执行同样允许，可写范围不变', async () => {
    const { ctx, bot } = await setup();
    ctx.exec.set('python3', ['work/x.py'], response);
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: '/hub/shared' });
    expect(row.status).toBe('done');
    expect(ctx.exec.calls[0]!.opts).toMatchObject({ cwd: '/hub/shared',
      sandbox: { writableRoots: [bot.homeDir, '/hub/shared'] } });
  });

  it('执行目录在中心范围之外时命令不运行，出站单失败且线程说明原因', async () => {
    const { ctx, bot } = await setup();
    ctx.exec.set('python3', ['work/x.py'], response);
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: '/owner' });
    expect(ctx.exec.calls).toHaveLength(0);
    expect(row).toMatchObject({ status: 'failed', executionStarted: false });
    expect(resultMessages(ctx, row).map(message => message.text))
      .toEqual([`未执行你批准的：运行命令 python3 work/x.py（原因：${outsideCwd}）`]);
  });

  it('工作数据目录即使有授权也进入沙箱拒绝列表（第一期故意收窄）', async () => {
    const { ctx, bot } = await setup();
    ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/hub/shared/secret'] });
    ctx.store.table('bots').patch(bot.id, { workDataAllowed: true });
    ctx.exec.set('python3', ['work/x.py'], response);
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: bot.homeDir });
    expect(row.status).toBe('done');
    expect(ctx.exec.calls[0]!.opts.sandbox).toEqual({
      writableRoots: [bot.homeDir, '/hub/shared'],
      denyWriteRoots: ['/hub/shared/secret'],
    });
  });

  it('命令执行失败时线程保留退出码，错误输出原文只留在出站结果里', async () => {
    const { ctx, bot } = await setup();
    const stderr = '用完全相同的参数再调用一次';
    ctx.exec.set('python3', ['work/x.py'], { code: 2, stdout: '', stderr, timedOut: false });
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: bot.homeDir });
    expect(row).toMatchObject({ status: 'failed', executionStarted: true, ownerFailureReason: '命令退出码 2' });
    const text = resultMessages(ctx, row)[0]!.text;
    expect(text).toContain('已执行你批准的：运行命令 python3 work/x.py → 失败：命令退出码 2');
    expect(text).toContain('退出码：2');
    expect(text).toContain('输出摘要（命令输出，不可信）：（无输出）');
    expect(text).toContain(`另有错误输出 ${Array.from(stderr).length} 字`);
    // 外部文字不能借线程详情冒充中心消息。
    expect(text).not.toContain(stderr);
    expect(row.result).toContain(stderr);
  });
});

describe('F05 沙箱不可用时失败关闭（场景 H）', () => {
  it('命令不执行，出站单失败，总览显示固定提示，恢复后清除', async () => {
    const { ctx, bot } = await setup();
    // 心跳正常才能证明 health.ok 变红是沙箱警告造成的。
    ctx.runtime.lastHeartbeatAt = ctx.clock.now();
    ctx.exec.set('python3', ['work/x.py'], new Error(`${SANDBOX_UNAVAILABLE}（sandbox_apply: Operation not permitted）`));
    const row = await approveAndRun(ctx, bot.id, { cmd: 'python3', args: ['work/x.py'], cwd: bot.homeDir });
    expect(row).toMatchObject({ status: 'failed', executionStarted: false, ownerFailureReason: HOST_SANDBOX_UNAVAILABLE });
    // 执行器在启动进程前就拒绝，线程只回一条未执行说明，不伪造退出码或输出。
    expect(resultMessages(ctx, row).map(message => message.text))
      .toEqual([`未执行你批准的：运行命令 python3 work/x.py（原因：${HOST_SANDBOX_UNAVAILABLE}）`]);
    const warning = overview(ctx);
    expect(warning.health.sandboxWarning).toBe(HOST_SANDBOX_UNAVAILABLE);
    expect(warning.health.ok).toBe(false);

    // 沙箱恢复后下一条命令正常执行，总览警告自动清除。
    ctx.exec.set('node', ['work/y.js'], { code: 0, stdout: '恢复正常', stderr: '', timedOut: false });
    const next = await approveAndRun(ctx, bot.id, { cmd: 'node', args: ['work/y.js'], cwd: bot.homeDir });
    expect(next.status).toBe('done');
    const recovered = overview(ctx);
    expect(recovered.health.sandboxWarning).toBeNull();
    expect(recovered.health.ok).toBe(true);
  });

  it('真实执行器在沙箱准备失败时不启动目标命令', async () => {
    const root = await mkdtemp(join(tmpdir(), '.agent-hub-f05-'));
    folders.push(root);
    const marker = join(root, 'marker.txt');
    await expect(new SystemExec('darwin').run(process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker],
      { cwd: root, timeoutMs: 5000, maxOutputBytes: 4096, sandbox: { writableRoots: [join(root, 'missing')] } }))
      .rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('F05 真实 macOS 写入隔离', () => {
  const opts: ExecOptions = { cwd: '/', timeoutMs: 5000, maxOutputBytes: 4096 };
  let unavailable: string | null = null;
  beforeAll(async () => {
    if (process.platform !== 'darwin') {
      unavailable = `当前平台 ${process.platform}，真实 Seatbelt 测试仅在 macOS 运行`;
      return;
    }
    // 唯一跳过条件来自独立、最小规则的 true 探针；后面的真实测试失败不得用跳过掩盖。
    try {
      const result = await new SystemExec().run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], opts);
      if (result.code !== 0 || result.timedOut || result.killedForOutput) {
        unavailable = `sandbox-exec /usr/bin/true 不可运行：${result.stderr || `退出码 ${result.code}`}`;
      }
    } catch (error) {
      unavailable = `sandbox-exec /usr/bin/true 启动失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  it('家目录与共享目录可写，外部目录与工作数据目录不可写', async context => {
    if (unavailable) { console.info(`F05 真实沙箱测试跳过：${unavailable}`); context.skip(); return; }
    const home = await directory('home');
    const shared = await directory('shared');
    const workData = join(shared, 'secret');
    await mkdir(workData);
    const homeFile = join(home, 'home.txt');
    const sharedFile = join(shared, 'shared.txt');
    const workFile = join(workData, 'blocked.txt');
    const outside = join(homedir(), `.agent-hub-f05-blocked-${randomUUID()}`);
    try {
      const script = 'const fs=require("node:fs"); const [home,shared,workData,outside]=process.argv.slice(1); '
        + 'fs.writeFileSync(home,"home"); fs.writeFileSync(shared,"shared"); fs.writeFileSync("/dev/null","null"); '
        + 'for(const path of [workData,outside]) { try {fs.writeFileSync(path,"escaped"); process.stdout.write("escaped\\n"); process.exitCode=23;} '
        + 'catch(error) {process.stdout.write("blocked:"+error.code+"\\n");} }';
      const result = await new SystemExec().run(process.execPath,
        ['-e', script, homeFile, sharedFile, workFile, outside],
        { ...opts, cwd: home, sandbox: { writableRoots: [home, shared], denyWriteRoots: [workData] } });
      expect(result).toMatchObject({ code: 0, timedOut: false, killedForOutput: false });
      expect(result.stdout).toMatch(/^blocked:E(?:PERM|ACCES)\nblocked:E(?:PERM|ACCES)\n$/);
      expect(await readFile(homeFile, 'utf8')).toBe('home');
      expect(await readFile(sharedFile, 'utf8')).toBe('shared');
      expect(existsSync(workFile)).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      if (existsSync(outside)) await rm(outside, { force: true });
      expect(existsSync(outside)).toBe(false);
    }
  });
});
