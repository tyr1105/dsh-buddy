/**
 * P75r4 第 3 节第 1、5 条：真实文件系统上的测试。
 * - 第 1 条：技能目录下直接出现的普通文件（例如访达留下的 .DS_Store）搬走、记审计、不出告警；符号链接照旧告警；
 * - 第 5 条：搬走位置的上级被换成指向员工 work 目录的符号链接：东西没有落进 work，核对失败的告警一条。
 * 每个用例都在系统临时目录里造一个「中心根目录」和员工家目录，用完由 afterEach 删除。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { SystemFs, PathContainmentError } from '../src/io/index.js';
import { resolveSettings, SKILL_DEFAULTS } from '../src/config/defaults.js';
import { botFixture } from './model-fixtures.js';
import { SKILL_VERIFY_FAILED_ALERT } from '../src/skill/files.js';
import { createBotHome, verifyManagedFiles } from '../src/memory/index.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { force: true, recursive: true })));
});

/** 真实目录里的一位员工：根目录 {base}/hub，家目录 {base}/hub/bots/{id}，家目录已建好。 */
async function scene() {
  // macOS 的系统临时目录在 /var 下，/var 本身是链接；用真实路径，免得路径比较时出现两种写法。
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-hub-p75r4-')));
  folders.push(base);
  const rootDir = join(base, 'hub');
  const home = join(rootDir, 'bots', botFixture.id);
  const ctx = createTestContext({ fs: new SystemFs(), settings: resolveSettings({ rootDir }) });
  const bot = { ...botFixture, homeDir: home, presetSkillIds: [] as string[], dshSkillNames: [] as string[] };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  return { ctx, bot, home, rootDir };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const alertTexts = (s: Scene) => s.ctx.store.table('alerts').list().map(row => row.text);
const audits = (s: Scene, action: string) => s.ctx.store.log('audit').all().filter(row => row.action === action).map(row => JSON.parse(row.detail) as Record<string, unknown>);

describe('P75r4 第 3 节第 1 条：技能目录下的普通文件不再告警', () => {
  it('.agents/skills 下放一个 .DS_Store：被搬走、审计一条，告警 0 条', async () => {
    const s = await scene();
    await writeFile(join(s.home, '.agents/skills/.DS_Store'), '访达留下的文件');
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect(await readdir(join(s.home, '.agents/skills'))).not.toContain('.DS_Store');
    const replaced = audits(s, 'skill_dir_replaced');
    expect(replaced).toMatchObject([{ botId: s.bot.id, path: '.agents/skills/.DS_Store', found: '文件' }]);
    // 文件在搬走的位置里，内容原样。
    expect(await readFile(replaced[0]!.to as string, 'utf8')).toBe('访达留下的文件');
    expect(replaced[0]!.to as string).toContain(join(s.rootDir, SKILL_DEFAULTS.STRAY_DIR, s.bot.id));
    expect(alertTexts(s)).toEqual([]);
    // 不计越界。
    expect(s.ctx.store.table('bots').get(s.bot.id)!.violations).toBe(0);
  });

  it('反例：放一个符号链接照旧告警（链接本身移走，链接另一头原样还在）', async () => {
    const s = await scene();
    const outside = join(s.home, 'work', 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'precious.txt'), '目录外的东西');
    await symlink(outside, join(s.home, '.agents/skills/zz-link'));
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect(await readdir(join(s.home, '.agents/skills'))).not.toContain('zz-link');
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('目录外的东西');
    expect(audits(s, 'skill_dir_replaced')).toMatchObject([{ path: '.agents/skills/zz-link', found: '符号链接' }]);
    expect(alertTexts(s)).toHaveLength(1);
  });

  it('反例：技能目录本身被换成一个文件，照旧告警', async () => {
    const s = await scene();
    await rm(join(s.home, '.agents/skills'), { recursive: true, force: true });
    await writeFile(join(s.home, '.agents/skills'), '员工写的一个文件');
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect((await lstat(join(s.home, '.agents/skills'))).isDirectory()).toBe(true);
    expect(audits(s, 'skill_dir_replaced')).toMatchObject([{ path: '.agents/skills', found: '文件' }]);
    expect(alertTexts(s)).toHaveLength(1);
  });
});

describe('P75r4 第 3 节第 5 条：搬走的目标位置不能被链接改道', () => {
  it('搬走位置的上级被换成指向员工 work 目录的链接：东西没有落进 work，这一项没有被搬走，核对失败的告警一条', async () => {
    const s = await scene();
    const trap = join(s.home, 'work', 'trap');
    await mkdir(trap, { recursive: true });
    // 员工放的符号链接（需要被搬走）。
    const outside = join(s.home, 'work', 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(s.home, '.agents/skills/zz-link'));
    // 搬走位置 {根}/.hub/stray-skills/{员工} 被预先换成指向 work/trap 的链接。
    await mkdir(join(s.rootDir, SKILL_DEFAULTS.STRAY_DIR), { recursive: true });
    await symlink(trap, join(s.rootDir, SKILL_DEFAULTS.STRAY_DIR, s.bot.id));

    await verifyManagedFiles(s.ctx, s.bot.id);

    // 没有任何东西落进员工的 work/trap。
    expect(await readdir(trap)).toEqual([]);
    // 这一项没有被搬走（仍在原处），核对记失败，出第二句告警一条。
    expect((await lstat(join(s.home, '.agents/skills/zz-link'))).isSymbolicLink()).toBe(true);
    expect(alertTexts(s)).toEqual([SKILL_VERIFY_FAILED_ALERT(s.bot.name)]);
    expect(audits(s, 'skill_verify_failed')).toHaveLength(1);
    expect(audits(s, 'skill_dir_replaced')).toHaveLength(0);
  });

  it('SystemFs.move 带目标边界：目标上级是链接就拒绝；目标在边界外拒绝；反例：没有链接时正常搬走并建出上级目录', async () => {
    const s = await scene();
    const trap = join(s.home, 'work', 'trap');
    await mkdir(trap, { recursive: true });
    await writeFile(join(s.home, 'a.txt'), 'A');
    await writeFile(join(s.home, 'b.txt'), 'B');
    await mkdir(join(s.rootDir, 'aside'), { recursive: true });
    await symlink(trap, join(s.rootDir, 'aside', 'door'));
    await expect(s.ctx.fs.move(join(s.home, 'a.txt'), join(s.rootDir, 'aside', 'door', 'deeper', 'a.txt'), { within: s.home }, { within: s.rootDir }))
      .rejects.toBeInstanceOf(PathContainmentError);
    expect(await readdir(trap)).toEqual([]);
    expect(await readFile(join(s.home, 'a.txt'), 'utf8')).toBe('A');
    await expect(s.ctx.fs.move(join(s.home, 'a.txt'), join(s.rootDir, '..', 'elsewhere', 'a.txt'), { within: s.home }, { within: s.rootDir }))
      .rejects.toBeInstanceOf(PathContainmentError);
    // 反例：没有链接时正常搬走，上级目录自动建出来。
    await s.ctx.fs.move(join(s.home, 'b.txt'), join(s.rootDir, 'aside', 'ok', 'deeper', 'b.txt'), { within: s.home }, { within: s.rootDir });
    expect(await readFile(join(s.rootDir, 'aside', 'ok', 'deeper', 'b.txt'), 'utf8')).toBe('B');
  });
});
