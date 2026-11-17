/**
 * P81 第 5 节第 6 条：真实沙箱试验（用 /usr/bin/sandbox-exec 和与运行时相同的规则）。
 *
 * 一切都在系统临时目录下自己建的「假的主人主目录」里做，不碰真实的主目录：
 * - 假主目录建在 /private/tmp 之下（系统临时目录）；为了让「同级目录、上级目录写不进去」的结论有意义，
 *   本测试把进程的 $TMPDIR 指到另一个单独建的目录（沙箱会自动放行 $TMPDIR，假主目录不能在它里面），
 *   并且生成规则时不放进 /private/tmp 这一项（hostSandboxRules 的第三个参数传 false）；
 * - 发布位置还不存在时，命令能自己建出它并写入文件；
 * - 写它旁边的同级目录失败、写它的上级目录失败；
 * - 发布位置换成指向别处的符号链接后，写入失败（规则按真实路径生成，传入的路径与真实路径不一致时整条命令不运行；
 *   命令自己在发布位置建一个指向别处的链接再写，也被系统拒绝）；
 * - 没有 sandbox-exec 的机器上跳过并写明原因；做完按完整路径删掉自己建的目录，复查没有残留。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostSandboxRules } from '../src/gate/host-writable.js';
import { SystemExec } from '../src/io/system-exec.js';
import { SANDBOX_EXEC } from '../src/io/system-sandbox.js';
import type { ExecOptions } from '../src/io/interfaces.js';

const opts: ExecOptions = { cwd: '/', timeoutMs: 10_000, maxOutputBytes: 4096 };
const created: string[] = [];
let unavailable: string | null = null;
let originalTmp: string | undefined;
/** 假的主人主目录（/private/tmp 之下）与单独的 $TMPDIR 目录。 */
let fakeHome = '';
let fakeTmp = '';

beforeAll(async () => {
  if (process.platform !== 'darwin') { unavailable = `当前平台 ${process.platform}，真实 Seatbelt 测试仅在 macOS 运行`; return; }
  try {
    const result = await new SystemExec().run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], opts);
    if (result.code !== 0 || result.timedOut || result.killedForOutput) { unavailable = `sandbox-exec /usr/bin/true 不可运行：${result.stderr || `退出码 ${result.code}`}`; return; }
  } catch (error) {
    unavailable = `sandbox-exec /usr/bin/true 启动失败：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  // 单独的 $TMPDIR（先在原来的临时目录里建，再把环境变量指过去；沙箱每次生成规则时读 tmpdir()）。
  originalTmp = process.env.TMPDIR;
  fakeTmp = await mkdtemp(join(tmpdir(), 'p81-tmpdir-'));
  created.push(fakeTmp);
  fakeHome = await mkdtemp('/private/tmp/p81-home-');
  created.push(fakeHome);
  process.env.TMPDIR = fakeTmp;
});

afterAll(async () => {
  if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
  // 只删自己建的目录，写完整路径，不用通配符；删完复查没有残留。
  for (const path of created.splice(0)) { await rm(path, { force: true, recursive: true }); expect(existsSync(path), path).toBe(false); }
});

/** 在假主目录里准备员工的文件夹和共享文件夹（沙箱要求可写根已存在），返回这一次的规则。 */
async function rulesFor(localDir: string | undefined) {
  const employee = join(fakeHome, 'bots', 'emp');
  const shared = join(fakeHome, 'shared');
  await mkdir(employee, { recursive: true });
  await mkdir(shared, { recursive: true });
  return { employee, rules: hostSandboxRules({ homeDir: employee, sharedDir: shared, projectDirs: [], localDir }, [], false) };
}
/** 在沙箱里跑一段 bash，返回退出码和错误输出（规则生成失败时返回 -1 和原因）。 */
async function run(rules: ReturnType<typeof hostSandboxRules>, cwd: string, script: string): Promise<{ code: number | null; stderr: string }> {
  try {
    const result = await new SystemExec().run('/bin/bash', ['-c', script], { ...opts, cwd, sandbox: rules });
    return { code: result.code, stderr: result.stderr };
  } catch (error) {
    return { code: -1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

describe('真实沙箱：发布位置只放开这一个文件夹', () => {
  it('发布位置还不存在：命令能自己建出它并写入文件；同级目录、上级目录写不进去', async context => {
    if (unavailable) { console.info(`P81 真实沙箱测试跳过：${unavailable}`); context.skip(); return; }
    await mkdir(join(fakeHome, 'Desktop'), { recursive: true });
    const localDir = join(fakeHome, 'Desktop', '上新页面');
    const { employee, rules } = await rulesFor(localDir);
    expect(rules.writableRoots).toContain(localDir);
    expect(rules.mayCreateRoots).toEqual([localDir]);
    expect(existsSync(localDir)).toBe(false);
    // 1 建出发布位置并写入文件（带中文名）。
    expect((await run(rules, employee, `mkdir -p "${localDir}/子目录" && echo probe > "${localDir}/子目录/index.html"`)).code).toBe(0);
    expect(existsSync(join(localDir, '子目录', 'index.html'))).toBe(true);
    // 2 同级目录（名字只是前缀相同的也算）、同级的普通文件、上级目录、假主目录本身：都写不进去。
    for (const target of [join(fakeHome, 'Desktop', '上新页面-2'), join(fakeHome, 'Desktop', '别的页面'), join(fakeHome, 'Desktop', 'probe.txt'), join(fakeHome, 'probe.txt')]) {
      const outcome = await run(rules, employee, `mkdir -p "${target}" 2>/dev/null; echo probe > "${target}.f" 2>/dev/null; test ! -e "${target}" && test ! -e "${target}.f"`);
      expect(outcome.code, target).toBe(0);
      expect(existsSync(target), target).toBe(false);
      expect(existsSync(`${target}.f`), `${target}.f`).toBe(false);
    }
    // 直接写（不吞掉错误）：退出码不是 0。
    expect((await run(rules, employee, `echo probe > "${join(fakeHome, 'Desktop', 'probe.txt')}"`)).code).not.toBe(0);
    expect((await run(rules, employee, `mkdir "${join(fakeHome, 'Desktop', '上新页面-2')}"`)).code).not.toBe(0);
  });

  it('没有发布位置（其他命令）：同一个文件夹写不进去', async context => {
    if (unavailable) { context.skip(); return; }
    const localDir = join(fakeHome, 'Desktop', '没放开的页面');
    const { employee, rules } = await rulesFor(undefined);
    expect(rules.mayCreateRoots).toBeUndefined();
    expect((await run(rules, employee, `mkdir -p "${localDir}"`)).code).not.toBe(0);
    expect(existsSync(localDir)).toBe(false);
  });

  it('发布位置换成指向别处的符号链接：规则生成时发现真实路径不一致，命令不运行，别处没有被写入', async context => {
    if (unavailable) { context.skip(); return; }
    const elsewhere = join(fakeHome, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const link = join(fakeHome, 'Desktop', '链接页面');
    await mkdir(join(fakeHome, 'Desktop'), { recursive: true });
    await symlink(elsewhere, link);
    const { employee, rules } = await rulesFor(link);
    const outcome = await run(rules, employee, `echo probe > "${link}/f.txt"`);
    expect(outcome.code).not.toBe(0);
    expect(existsSync(join(elsewhere, 'f.txt'))).toBe(false);
  });

  it('P81r1（S2）：发布位置之下以点开头的文件和文件夹写不进、也删不掉；其余照常可写', async context => {
    if (unavailable) { context.skip(); return; }
    // 名字故意带括号和点：沙箱规则里的正则要按字面转义。
    const localDir = join(fakeHome, 'Desktop', '上新 (v1.2)');
    await mkdir(join(localDir, 'a'), { recursive: true });
    await mkdir(join(localDir, '.git', 'hooks'), { recursive: true });
    const { employee, rules } = await rulesFor(localDir);
    // 1 点开头的文件与目录写不进去（含任意层级之下的）。
    for (const target of [join(localDir, '.git', 'hooks', 'pre-commit'), join(localDir, 'a', '.env'), join(localDir, '.vscode', 'tasks.json')]) {
      expect((await run(rules, employee, `echo probe > "${target}"`)).code, target).not.toBe(0);
      expect(existsSync(target), target).toBe(false);
    }
    // 2 不以点开头的照常可写。
    expect((await run(rules, employee, `echo probe > "${join(localDir, 'a', 'b.txt')}"`)).code).toBe(0);
    expect(existsSync(join(localDir, 'a', 'b.txt'))).toBe(true);
    // 3 已有的 .git 删不掉。
    expect((await run(rules, employee, `rm -rf "${join(localDir, '.git')}"`)).code).not.toBe(0);
    expect(existsSync(join(localDir, '.git', 'hooks'))).toBe(true);
    // 4 发布位置本身与它的上级照旧：同级目录写不进去。
    expect((await run(rules, employee, `mkdir -p "${join(fakeHome, 'Desktop', '平行目录')}"`)).code).not.toBe(0);
    expect(existsSync(join(fakeHome, 'Desktop', '平行目录'))).toBe(false);
  });

  it('P81r1（S1）两段式：第一次运行把发布位置建成指向别处的链接，第二次写不到别处', async context => {
    if (unavailable) { context.skip(); return; }
    const elsewhere = join(fakeHome, 'elsewhere3');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(fakeHome, 'Desktop'), { recursive: true });
    const link = join(fakeHome, 'Desktop', '被换成链接');
    const { employee: firstEmployee, rules: firstRules } = await rulesFor(link);
    // 第一次运行：发布位置还不存在，命令自己建出这个链接（只动发布位置这一项本身）。
    expect((await run(firstRules, firstEmployee, `ln -s "${elsewhere}" "${link}"`)).code).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // 第二次运行：运行前核对会看到这一级是链接（lstat）；即使规则生成通过，经链接写到别处也被系统拒绝。
    const { employee, rules } = await rulesFor(link);
    expect((await run(rules, employee, `echo probe > "${link}/f.txt"`)).code).not.toBe(0);
    expect(existsSync(join(elsewhere, 'f.txt'))).toBe(false);
  });

  it('P81r1（S1）两段式：发布位置已存在且有文件，命令删掉它再建链接，别处仍写不进去', async context => {
    if (unavailable) { context.skip(); return; }
    const elsewhere = join(fakeHome, 'elsewhere4');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(fakeHome, 'Desktop'), { recursive: true });
    const localDir = join(fakeHome, 'Desktop', '先有文件');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, 'old.txt'), 'old');
    const { employee, rules } = await rulesFor(localDir);
    // 第一次运行：删掉发布位置并在原位建链接（两个动作都只涉及这一项本身）。
    expect((await run(rules, employee, `rm -rf "${localDir}" && ln -s "${elsewhere}" "${localDir}"`)).code).toBe(0);
    expect((await lstat(localDir)).isSymbolicLink()).toBe(true);
    // 第二次运行：别处的文件没有被改写。
    expect((await run(rules, employee, `echo probe >> "${localDir}/ledger.txt"`)).code).not.toBe(0);
    expect(existsSync(join(elsewhere, 'ledger.txt'))).toBe(false);
  });
});
