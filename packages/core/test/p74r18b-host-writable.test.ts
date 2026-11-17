/**
 * P74r18b 第 4 节的测试：中心代为运行命令的可写范围。
 *
 * 覆盖：
 * 1 可写清单（gate/host-writable.ts）：沙箱规则、审批卡提示句、工具说明、预先核对用同一份清单；文字逐字；
 * 2 4.1 真实沙箱：用真实的命令执行接口（SystemExec，带与执行时相同的参数）写 $TMPDIR、/tmp、/private/tmp、项目文件夹里各一个
 *   以 zz-p74r18b- 开头的文件夹：都成功；写项目文件夹里中心维护的文件：失败；写可写范围之外的位置：失败。
 *   没有 sandbox-exec 的机器上跳过并写明原因；结束后按完整路径删掉自己建的文件夹；
 * 3 4.3 提交时预先核对：写可写范围之外的命令被拒，文字逐字，不建审批、没有消息、不计越界；范围之内、分析不出路径的照常建审批。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { submitOutbox } from '../src/gate/outbox.js';
import { hostCenterFiles, hostCommandRiskNote, hostSandboxRules, hostWritableModelText, hostWritableRoots, hostWriteRefusal, pathsOutsideHostWritable, HOST_TMP_ROOT } from '../src/gate/host-writable.js';
import { SystemExec } from '../src/io/system-exec.js';
import { SANDBOX_EXEC } from '../src/io/system-sandbox.js';
import type { ExecOptions } from '../src/io/interfaces.js';
import { botFixture } from './model-fixtures.js';

const dirs = { homeDir: '/hub/bots/b1', sharedDir: '/hub/shared', projectDirs: ['/hub/projects/prj1'] };

describe('1 可写清单与文字', () => {
  it('可写目录：家目录、共享目录、项目文件夹、/private/tmp；拒绝清单：项目里中心维护的文件', () => {
    expect(hostWritableRoots(dirs)).toEqual(['/hub/bots/b1', '/hub/shared', '/hub/projects/prj1', '/private/tmp']);
    expect(HOST_TMP_ROOT).toBe('/private/tmp');
    expect(hostCenterFiles(dirs.projectDirs)).toEqual(['/hub/projects/prj1/context.md']);
    expect(hostSandboxRules(dirs, ['/hub/shared/secret'])).toEqual({
      writableRoots: ['/hub/bots/b1', '/hub/shared', '/hub/projects/prj1', '/private/tmp'],
      denyWriteRoots: ['/hub/shared/secret', '/hub/projects/prj1/context.md'] });
    // 不在任何项目里：没有项目文件夹，也没有中心维护的文件要拒绝。
    expect(hostSandboxRules({ ...dirs, projectDirs: [] }, [])).toEqual({ writableRoots: ['/hub/bots/b1', '/hub/shared', '/private/tmp'], denyWriteRoots: [] });
  });

  it('审批卡上的提示句逐字；员工不在任何项目里时去掉「项目文件夹、」', () => {
    expect(hostCommandRiskNote('林舟', true)).toBe('批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。');
    expect(hostCommandRiskNote('林舟', false)).toBe('批准后这条命令只能写入：林舟的文件夹、共享文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。');
    expect(hostWritableModelText()).toBe('只能写你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 /tmp）；可以联网');
  });

  it('拒绝文字逐字；路径最多列 3 个，多的写「等 n 处」', () => {
    expect(hostWriteRefusal(['/Users/x/Desktop/site'])).toBe('这条命令要写 /Users/x/Desktop/site，中心代为运行时写不进去。中心代为运行的命令只能写：你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 /tmp）；可以联网。这是约定里写明的发布位置时，不要更换位置，交账写 blocked，blocker 逐字写：发布位置不在能写入的范围内。');
    expect(hostWriteRefusal(['/a', '/b', '/c', '/d', '/e'])).toContain('这条命令要写 /a、/b、/c等 2 处，中心代为运行时写不进去。');
  });

  it('预先核对：可写范围之内的不算；之外的列出；两种 /tmp 写法都认；项目里中心维护的文件不算；含变量的不判', () => {
    const outside = (paths: string[]) => pathsOutsideHostWritable(paths, dirs);
    expect(outside(['/hub/bots/b1/work/a.txt', '/hub/shared/x', '/hub/projects/prj1/页面/index.html', '/tmp/site', '/private/tmp/site', '/dev/null'])).toEqual([]);
    expect(outside(['/Users/x/Desktop/site', '/hub/projects/prj1/context.md', '/hub/projects/prj2/a'])).toEqual(['/Users/x/Desktop/site', '/hub/projects/prj1/context.md', '/hub/projects/prj2/a']);
    // 系统每用户临时目录（$TMPDIR）由沙箱自动加入，两种写法都认。
    expect(outside(['/var/folders/ab/cdef/T/zz', '/private/var/folders/ab/cdef/T/zz'])).toEqual([]);
    expect(outside(['/var/log/x'])).toEqual(['/var/log/x']);
    // 分析不出落在哪里的（变量、~）、相对路径不判。
    expect(outside(['$HOME/x', '~/Desktop/x', 'relative/x'])).toEqual([]);
    // 员工不在项目里时，项目文件夹路径不在范围内。
    expect(pathsOutsideHostWritable(['/hub/projects/prj1/a'], { ...dirs, projectDirs: [] })).toEqual(['/hub/projects/prj1/a']);
  });
});

describe('2 真实沙箱：用与执行时相同的参数写各处', () => {
  const folders: string[] = [];
  let unavailable: string | null = null;
  const opts: ExecOptions = { cwd: '/', timeoutMs: 10_000, maxOutputBytes: 4096 };
  beforeAll(async () => {
    if (process.platform !== 'darwin') { unavailable = `当前平台 ${process.platform}，真实 Seatbelt 测试仅在 macOS 运行`; return; }
    try {
      const result = await new SystemExec().run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], opts);
      if (result.code !== 0 || result.timedOut || result.killedForOutput) unavailable = `sandbox-exec /usr/bin/true 不可运行：${result.stderr || `退出码 ${result.code}`}`;
    } catch (error) {
      unavailable = `sandbox-exec /usr/bin/true 启动失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });
  afterEach(async () => {
    // 只删自己建的文件夹，写完整路径，不用通配符。
    for (const path of folders.splice(0)) { await rm(path, { force: true, recursive: true }); expect(existsSync(path)).toBe(false); }
  });
  /** 在本测试文件所在目录下建一个临时目录（它不在 $TMPDIR 里，所以不会被系统临时目录的规则放行）。 */
  async function makeDir(prefix: string): Promise<string> {
    const path = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), `.agent-hub-p74r18b-${prefix}-`));
    folders.push(path);
    return path;
  }
  /** 在沙箱里跑 mkdir 并写一个文件，返回退出码。 */
  async function writeIn(rules: { writableRoots: string[]; denyWriteRoots: string[] }, cwd: string, target: string, asFile = false): Promise<number | null> {
    const command = asFile ? `echo probe > "${target}"` : `mkdir -p "${target}" && echo probe > "${target}/f.txt"`;
    const result = await new SystemExec().run('/bin/bash', ['-c', command], { ...opts, cwd, sandbox: rules });
    return result.code;
  }

  it('$TMPDIR、/tmp、/private/tmp、项目文件夹里各建一个 zz-p74r18b- 文件夹都成功；项目里中心维护的文件、可写范围之外失败', async context => {
    if (unavailable) { console.info(`P74r18b 真实沙箱测试跳过：${unavailable}`); context.skip(); return; }
    const home = await makeDir('home');
    const shared = await makeDir('shared');
    const project = await makeDir('project');
    const outside = await makeDir('outside');
    // 与执行时相同的参数：由同一个函数按这位员工的几处目录生成。
    const rules = hostSandboxRules({ homeDir: home, sharedDir: shared, projectDirs: [project] }, []);
    const tmpTarget = join(tmpdir(), 'zz-p74r18b-tmpdir');
    const slashTmp = '/tmp/zz-p74r18b-slash-tmp';
    const privateTmp = '/private/tmp/zz-p74r18b-private-tmp';
    const projectTarget = join(project, 'zz-p74r18b-project');
    folders.push(tmpTarget, slashTmp, privateTmp);
    expect(await writeIn(rules, home, tmpTarget)).toBe(0);
    expect(await writeIn(rules, home, slashTmp)).toBe(0);
    expect(await writeIn(rules, home, privateTmp)).toBe(0);
    expect(await writeIn(rules, home, projectTarget)).toBe(0);
    for (const path of [tmpTarget, slashTmp, privateTmp, projectTarget]) expect(existsSync(join(path, 'f.txt')), path).toBe(true);
    // 项目文件夹里由中心维护的文件：失败，也没有被创建。
    const centerFile = join(project, 'context.md');
    expect(await writeIn(rules, home, centerFile, true)).not.toBe(0);
    expect(existsSync(centerFile)).toBe(false);
    // 可写范围之外（本测试自己建的目录，不在任何可写位置里）：失败。
    const outsideTarget = join(outside, 'zz-p74r18b-outside');
    expect(await writeIn(rules, home, outsideTarget)).not.toBe(0);
    expect(existsSync(outsideTarget)).toBe(false);
    // 反例：员工不在任何项目里时，同一个项目文件夹写不进去。
    const noProject = hostSandboxRules({ homeDir: home, sharedDir: shared, projectDirs: [] }, []);
    expect(await writeIn(noProject, home, join(project, 'zz-p74r18b-no-project'))).not.toBe(0);
    expect(existsSync(join(project, 'zz-p74r18b-no-project'))).toBe(false);
  });
});

describe('3 提交时预先核对（4.3）：写可写范围之外的命令不建审批', () => {
  async function setup() {
    const ctx = createTestContext();
    const bot = { ...botFixture };
    ctx.store.table('bots').put(bot);
    await createBotHome(ctx, bot);
    return { ctx, bot };
  }
  const snapshot = (ctx: Awaited<ReturnType<typeof setup>>['ctx'], botId: string) => ({
    approvals: ctx.store.table('approvals').list().length, outbox: ctx.store.table('outbox').list().length,
    thread: ctx.store.log('thread').all().length, violations: ctx.store.table('bots').get(botId)!.violations });
  const cmd = (bot: { homeDir: string }, command: string) => ({ kind: 'run_command' as const, why: '发布到约定的位置',
    payload: { cmd: 'bash', args: ['-c', command], cwd: bot.homeDir } });

  it('要写主人桌面上的文件夹：被拒、文字逐字，没有审批、出站记录、消息，越界次数不变', async () => {
    const { ctx, bot } = await setup();
    const before = snapshot(ctx, bot.id);
    await expect(submitOutbox(ctx, bot.id, cmd(bot, 'mkdir -p /Users/someone/Desktop/site && cp work/index.html /Users/someone/Desktop/site/index.html')))
      .rejects.toThrow(/^这条命令要写 .*Desktop\/site.*，中心代为运行时写不进去。中心代为运行的命令只能写：你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 \/tmp）；可以联网。这是约定里写明的发布位置时，不要更换位置，交账写 blocked，blocker 逐字写：发布位置不在能写入的范围内。$/);
    expect(snapshot(ctx, bot.id)).toEqual(before);
  });

  it('要写 /tmp 下、家目录下、共享目录下的命令：照常建审批', async () => {
    const { ctx, bot } = await setup();
    for (const target of ['/tmp/p74r18b-site', `${bot.homeDir}/work/out`, '/hub/shared/out']) {
      const row = await submitOutbox(ctx, bot.id, cmd(bot, `mkdir -p ${target}`));
      expect(row.status, target).toBe('pending_approval');
    }
    expect(ctx.store.table('approvals').list()).toHaveLength(3);
  });

  /** 通用：提交一条命令（程序名和参数数组）。 */
  const raw = (bot: { homeDir: string }, cmd: string, args: string[]) => ({ kind: 'run_command' as const, why: '核对', payload: { cmd, args, cwd: bot.homeDir } });

  it('只读范围之外的文件、往自己的文件夹里写（cp 外部文件 work/logo.png）：不被预先核对拒绝，照常建审批', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, raw(bot, 'cp', ['/Users/someone/Documents/logo.png', 'work/logo.png']));
    expect(row.status).toBe('pending_approval');
  });

  it('分类器不认识的程序带着范围之外的路径参数：分析不出是读还是写，不被预先核对拒绝，照常建审批', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, raw(bot, 'python3', ['work/build.py', '--input', '/Users/someone/Documents/data.csv']));
    expect(row.status).toBe('pending_approval');
  });

  it('确定写到范围之外（cp 目标、重定向）：被拒', async () => {
    const { ctx, bot } = await setup();
    await expect(submitOutbox(ctx, bot.id, raw(bot, 'cp', ['work/out.html', '/Users/someone/Desktop/site/out.html']))).rejects.toThrow(/^这条命令要写 .*Desktop\/site/);
    await expect(submitOutbox(ctx, bot.id, raw(bot, 'bash', ['-c', 'echo x > /Users/someone/Desktop/a.txt']))).rejects.toThrow(/^这条命令要写 \/Users\/someone\/Desktop\/a\.txt，/);
    expect(ctx.store.table('approvals').list()).toHaveLength(0);
  });

  it('分析不出要写哪里的命令（含变量）：照常建审批', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, cmd(bot, 'mkdir -p $SITE_DIR && echo ok'));
    expect(row.status).toBe('pending_approval');
    expect(ctx.store.table('approvals').list()).toHaveLength(1);
  });
});
