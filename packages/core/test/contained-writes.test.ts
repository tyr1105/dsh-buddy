/**
 * 受边界约束的写入：用真实文件系统验证「中心不会顺着机器人放的符号链接写到目录外」。
 *
 * 为什么必须用真实文件系统：内存实现里没有符号链接，用它测不出这类漏洞。
 * 每个用例都在系统临时目录里造一个「家目录」和一个「家目录外」，
 * 断言的重点不是报了错，而是目录外的文件真的没有变化、没有多出新文件。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemFs, PathContainmentError } from '../src/io/index.js';
import { MemoryFs } from '../src/io/testing/index.js';
import { appendJournal } from '../src/memory/index.js';
import { processCommit } from '../src/commit/process.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { PRESET_SKILLS } from '../src/config/preset-skills.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';
import { executeReadyOutbox, submitOutbox } from '../src/gate/outbox.js';
import { guardToolCallSync } from '../src/gate/guard.js';
import { SystemExec } from '../src/io/index.js';
import { sandboxProfile } from '../src/io/system-sandbox.js';

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map(folder => rm(folder, { force: true, recursive: true })));
});

/** 造一组互不相干的目录：home 相当于机器人家目录，outside 相当于它不该碰的地方。 */
async function scene() {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-contained-'));
  folders.push(base);
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  await mkdir(home);
  await mkdir(outside);
  const victim = join(outside, 'victim.txt');
  await writeFile(victim, 'ORIGINAL\n');
  return { base, home, outside, victim, fs: new SystemFs() };
}

/** macOS 的系统临时目录在 /var 下，/var 本身是链接；比较规则文本要用真实路径。 */
const realPathOf = (path: string): Promise<string> => realpath(path);

describe('追加写入', () => {
  it('普通情况：能新建目录和文件，也能继续追加', async () => {
    const { home, fs } = await scene();
    const path = join(home, 'memory/journal/d.md');
    await fs.appendText(path, 'a', { within: home });
    await fs.appendText(path, 'b', { within: home });
    expect(await readFile(path, 'utf8')).toBe('ab');
  });
  it('文件本身是符号链接：拒绝，目录外的文件不变', async () => {
    const { home, victim, fs } = await scene();
    await mkdir(join(home, 'memory'));
    await symlink(victim, join(home, 'memory/d.md'));
    await expect(fs.appendText(join(home, 'memory/d.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('悬空的符号链接：拒绝，不会在目录外新建文件', async () => {
    const { home, outside, fs } = await scene();
    await symlink(join(outside, 'new.txt'), join(home, 'd.md'));
    await expect(fs.appendText(join(home, 'd.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
  it('中间目录是符号链接：拒绝，目录外不多文件', async () => {
    const { home, outside, fs } = await scene();
    await symlink(outside, join(home, 'memory'));
    await expect(fs.appendText(join(home, 'memory/d.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
  it('家目录本身被换成符号链接：拒绝', async () => {
    const { base, home, outside, fs } = await scene();
    await rename(home, join(base, 'moved'));
    await symlink(outside, home);
    await expect(fs.appendText(join(home, 'd.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
  it('硬链接到目录外的文件：拒绝，内容不变', async () => {
    const { home, victim, fs } = await scene();
    await link(victim, join(home, 'd.md'));
    await expect(fs.appendText(join(home, 'd.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('放一个管道：拒绝，并且不会把宿主挂住', async () => {
    const { home, fs } = await scene();
    execFileSync('mkfifo', [join(home, 'd.md')]);
    await expect(fs.appendText(join(home, 'd.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
  });
  it('目标不在边界内：拒绝', async () => {
    const { home, victim, fs } = await scene();
    await expect(fs.appendText(victim, 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    await expect(fs.appendText(join(home, '../outside/victim.txt'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('边界的上级目录是符号链接时照常工作（macOS 的 /tmp 就是这样）', async () => {
    const { base, home, fs } = await scene();
    const alias = join(base, 'alias');
    await symlink(base, alias);
    const viaAlias = join(alias, 'home');
    await fs.appendText(join(viaAlias, 'd.md'), 'ok', { within: viaAlias });
    expect(await readFile(join(home, 'd.md'), 'utf8')).toBe('ok');
  });
  it('不带边界时行为不变：中心自己的目录仍按原样追加', async () => {
    const { base, fs } = await scene();
    await fs.appendText(join(base, 'hub/log.txt'), 'x');
    expect(await readFile(join(base, 'hub/log.txt'), 'utf8')).toBe('x');
  });
});

describe('整体替换写入', () => {
  it('普通情况：写入成功，不留临时文件', async () => {
    const { home, fs } = await scene();
    await fs.writeTextAtomic(join(home, 'mind/a.md'), 'v1', { within: home });
    await fs.writeTextAtomic(join(home, 'mind/a.md'), 'v2', { within: home });
    expect(await readFile(join(home, 'mind/a.md'), 'utf8')).toBe('v2');
    expect(await readdir(join(home, 'mind'))).toEqual(['a.md']);
  });
  it('文件本身是符号链接：只替换链接，目录外的文件不变', async () => {
    const { home, victim, fs } = await scene();
    await symlink(victim, join(home, 'a.md'));
    await fs.writeTextAtomic(join(home, 'a.md'), 'NEW', { within: home });
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
    expect((await lstat(join(home, 'a.md'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, 'a.md'), 'utf8')).toBe('NEW');
  });
  it('中间目录是符号链接：拒绝，目录外不多文件', async () => {
    const { home, outside, fs } = await scene();
    await symlink(outside, join(home, 'mind'));
    await expect(fs.writeTextAtomic(join(home, 'mind/a.md'), 'X', { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
});

describe('建目录与删除', () => {
  it('建目录时中途遇到符号链接：拒绝，不在目录外建目录', async () => {
    const { home, outside, fs } = await scene();
    await symlink(outside, join(home, 'a'));
    await expect(fs.mkdirp(join(home, 'a/b/c'), { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
  it('删除时上级是符号链接：拒绝，目录外的文件还在', async () => {
    const { home, outside, victim, fs } = await scene();
    await symlink(outside, join(home, 'a'));
    await expect(fs.remove(join(home, 'a/victim.txt'), { within: home })).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('删除目标本身是符号链接：只删链接，指向的内容还在', async () => {
    const { home, victim, fs } = await scene();
    await symlink(victim, join(home, 'a.md'));
    await fs.remove(join(home, 'a.md'), { within: home });
    expect(await readdir(home)).toEqual([]);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('删除不存在的路径算成功，保持幂等', async () => {
    const { home, fs } = await scene();
    await expect(fs.remove(join(home, 'none/a.md'), { within: home })).resolves.toBeUndefined();
  });
});

describe('内存实现也校验边界', () => {
  it('边界外的路径被拒绝，业务传错边界能在单元测试里暴露', async () => {
    const fs = new MemoryFs();
    await expect(fs.writeTextAtomic('/a/f', 'x', { within: '/b' })).rejects.toBeInstanceOf(PathContainmentError);
    await expect(fs.appendText('/ab/f', 'x', { within: '/a' })).rejects.toBeInstanceOf(PathContainmentError);
    await expect(fs.writeTextAtomic('/a/f', 'x', { within: '/a' })).resolves.toBeUndefined();
  });
});

/**
 * 对抗审查抓到的绕过：机器人把整个家目录搬走，在原位放一个指向别处的符号链接。
 * 用「解析后的真实位置」当边界时，边界会跟着链接一起跑到别处，所有检查都失效。
 */
describe('家目录整个被换成符号链接', () => {
  /** 真实文件系统 + 真实存储：家目录指向临时目录，攻击动作由各用例自己做。 */
  async function rootSwap() {
    const { ctx, bot } = await turnContext();
    const paths = await scene();
    ctx.store.table('bots').patch(bot.id, { homeDir: paths.home });
    const real = { ...ctx, fs: new SystemFs() };
    /** 攻击动作：搬走家目录，原位放链接。 */
    const swap = async () => { await rename(paths.home, join(paths.base, 'moved')); await symlink(paths.outside, paths.home); };
    const violations = () => ctx.store.table('bots').get(bot.id)!.violations;
    return { ...paths, ctx, real, botId: bot.id, swap, violations };
  }
  const writeFileAction = (path: string) => ({ kind: 'write_file' as const, payload: { path, content: 'PWN' }, why: '测试' });

  it('对照：家目录正常时，出站写文件落在家目录内', async () => {
    const { home, real, botId } = await rootSwap();
    await submitOutbox(real, botId, writeFileAction(join(home, 'work/a.txt')));
    await executeReadyOutbox(real);
    expect(await readFile(join(home, 'work/a.txt'), 'utf8')).toBe('PWN');
  });
  it('换完再提交：拒绝并记一次越界，目录外不变', async () => {
    const { home, outside, victim, real, botId, swap, violations } = await rootSwap();
    await swap();
    const before = violations();
    await expect(submitOutbox(real, botId, writeFileAction(join(home, 'victim.txt')))).rejects.toThrow('边界外');
    await expect(submitOutbox(real, botId, writeFileAction(join(home, 'new.txt')))).rejects.toThrow('边界外');
    expect(violations()).toBe(before + 2);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
  it('提交时正常、执行前才换：不写到目录外', async () => {
    const { ctx, home, outside, victim, real, botId, swap } = await rootSwap();
    await submitOutbox(real, botId, writeFileAction(join(home, 'victim.txt')));
    expect(ctx.store.table('outbox').list()[0]!.status).toBe('ready');
    await swap();
    await executeReadyOutbox(real);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
    expect(await readdir(outside)).toEqual(['victim.txt']);
    expect(ctx.store.table('outbox').list()[0]!.status).toBe('failed');
  });
  it('中心沙箱的规则不跟随被替换的根目录', async () => {
    const { base, home, outside, swap } = await rootSwap();
    await swap();
    const profile = await sandboxProfile({ writableRoots: [home] }, 'darwin');
    expect(profile).toContain(`(subpath "${join(await realPathOf(base), 'home')}")`);
    expect(profile).not.toContain(`(subpath "${await realPathOf(outside)}")`);
  });
  it.skipIf(process.platform !== 'darwin')('真实沙箱：根目录被替换后，脚本写不到链接指向的地方', async () => {
    const { base, home } = await rootSwap();
    // 系统临时目录本来就在沙箱可写范围内，所以「目录外」必须放到用户主目录下才验证得出来。
    const outside = await mkdtemp(join(homedir(), '.agent-hub-contained-'));
    folders.push(outside);
    const exec = new SystemExec();
    const options = { cwd: base, timeoutMs: 5000, maxOutputBytes: 1000, sandbox: { writableRoots: [home] } };
    await rename(home, join(base, 'moved'));
    await symlink(outside, home);
    await exec.run('/bin/sh', ['-c', `echo x > ${join(home, 'pwn.txt')}`], options);
    expect(await readdir(outside)).toEqual([]);
  });
  it('工具守卫：家目录是链接时拒绝普通工具并记越界，hub_ 工具不被这条拦', async () => {
    const { ctx, bot } = await turnContext();
    (ctx.fs as MemoryFs).markSymlink(bot.homeDir);
    const pending: Promise<unknown>[] = [];
    const denied = guardToolCallSync(ctx, bot.sessionId!, 'bash', { command: 'ls' }, effect => pending.push(effect));
    expect(denied.allow).toBe(false);
    await Promise.all(pending);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(bot.violations + 1);
    const hub = guardToolCallSync(ctx, bot.sessionId!, 'hub_state_get', {}, effect => pending.push(effect));
    expect(hub.allow === false && hub.message.includes('符号链接')).toBe(false);
  });
  it('真实文件系统能识别根目录是不是链接', async () => {
    const { home, outside, fs } = await scene();
    expect(fs.isSymlinkSync(home)).toBe(false);
    expect(fs.isSymlinkSync(join(home, 'none'))).toBe(false);
    await rm(home, { recursive: true });
    await symlink(outside, home);
    expect(fs.isSymlinkSync(home)).toBe(true);
  });
});

describe('业务接线', () => {
  it('真实场景复现：队友把当天日志换成链接，交账内容写不到目录外', async () => {
    const { ctx, bot, ticket, toolCtx } = await turnContext();
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(true);
    const commit = ctx.store.table('commits').list()[0]!;
    const { home, victim } = await scene();
    await mkdir(join(home, 'memory/journal'), { recursive: true });
    await symlink(victim, join(home, 'memory/journal/2026-11-05.md'));
    const real = { ...ctx, fs: new SystemFs() };
    await expect(appendJournal(real, { ...bot, homeDir: home }, commit, ticket)).rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL\n');
  });
  it('交账遇到越界：交账本身保留，记一次越界；连带多项失败也只记一次', async () => {
    const { ctx, bot, toolCtx } = await turnContext();
    const before = ctx.store.table('bots').get(bot.id)!.violations;
    const blocked = new PathContainmentError('测试');
    vi.spyOn(ctx.fs, 'appendText').mockRejectedValue(blocked);
    vi.spyOn(ctx.fs, 'writeTextAtomic').mockRejectedValue(blocked);
    const result = await processCommit(ctx, toolCtx, commitArgs());
    expect(result.ok).toBe(true);
    expect(ctx.store.table('commits').count()).toBe(1);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(before + 1);
  });
  it('普通磁盘故障不算越界', async () => {
    const { ctx, bot, toolCtx } = await turnContext();
    const before = ctx.store.table('bots').get(bot.id)!.violations;
    vi.spyOn(ctx.fs, 'appendText').mockRejectedValue(new Error('磁盘满了'));
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(before);
  });
  it('日志追加带上了家目录边界', async () => {
    const { ctx, bot, toolCtx } = await turnContext();
    const spy = vi.spyOn(ctx.fs, 'appendText');
    await processCommit(ctx, toolCtx, commitArgs());
    const call = spy.mock.calls.find(row => row[0].includes('/memory/journal/'));
    expect(call?.[2]).toEqual({ within: bot.homeDir });
  });
  it('取消预置 skill：目录里还有队友自己的文件时，不删这些文件', async () => {
    const ctx = await createTestContext();
    const id = PRESET_SKILLS[0]!.id;
    const bot = await createBot(ctx, { name: '小助手', role: 'executor', persona: '做完交账', aspirations: ['把手头的事做完'], presetSkillIds: [id] });
    const own = `${bot.homeDir}/.agents/skills/${id}/my-note.md`;
    await ctx.fs.writeTextAtomic(own, '队友自己的笔记');
    await updateBot(ctx, bot.id, { presetSkillIds: [] });
    expect(await ctx.fs.readText(`${bot.homeDir}/.agents/skills/${id}/SKILL.md`)).toBeNull();
    expect(await ctx.fs.readText(own)).toBe('队友自己的笔记');
  });
});
