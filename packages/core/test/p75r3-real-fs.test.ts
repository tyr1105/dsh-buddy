/**
 * P75r3 第 1.6 节：真实文件系统上的测试（审查 H2 的复现改写成测试）。
 *
 * 为什么必须用真实文件系统：内存实现里的「符号链接」只是一个标记，测不出「中心的恢复写入因路径里有符号链接被文件层拒绝」
 * 这类问题。每个用例都在系统临时目录里造一个「中心根目录」和员工家目录，用完由 afterEach 删除，仓库里不留文件。
 * 断言的重点：链接被整个移走（不跟随）、链接另一头的文件原样还在、技能文件是技能库的内容、告警和审计各一条。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { SystemFs, PathContainmentError } from '../src/io/index.js';
import { resolveSettings } from '../src/config/defaults.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { writeSkillVersion } from '../src/skill/store.js';
import { selfSkillPath, SKILL_DIR_REPLACED_ALERT } from '../src/skill/files.js';
import { createBotHome, verifyManagedFiles } from '../src/memory/index.js';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { force: true, recursive: true })));
});

/** 真实目录里的一位员工：根目录 {base}/hub，家目录 {base}/hub/bots/{id}，家目录里已建好并物化了一条自己积累的技能。 */
async function scene() {
  // macOS 的系统临时目录在 /var 下，/var 本身是链接；用真实路径，免得路径比较时出现两种写法。
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-hub-p75r3-')));
  folders.push(base);
  const rootDir = join(base, 'hub');
  const home = join(rootDir, 'bots', botFixture.id);
  const ctx = createTestContext({ fs: new SystemFs(), settings: resolveSettings({ rootDir }) });
  const bot = { ...botFixture, homeDir: home, presetSkillIds: ['owner-brief'], dshSkillNames: [] as string[] };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const source = SkillSourceSchema.parse({
    id: newId('ss', ctx.rng), botId: bot.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
    quote: '提示文字与约定不一致', relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: ctx.clock.now(),
  });
  ctx.store.table('skillSources').put(source);
  await writeSkillVersion(ctx, {
    botId: bot.id, change: 'create', newSkill: { title: '表单页做法', whenToUse: '做表单页时用', supplements: null },
    sentences: [{ text: '提交后显示明确的成功提示', sourceIds: [source.id] }, { text: '先校验必填项', sourceIds: [source.id] }],
    updateId: null, checkedBy: null, categories: ['表单页'],
  });
  const skill = ctx.store.table('skills').list()[0]!;
  const file = selfSkillPath(bot, skill);
  return { ctx, bot, home, rootDir, skill, file, expected: await readFile(file, 'utf8') };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** 员工在 work/fake 里放了一份自己写的技能（目录名与技能库里的相同）。 */
async function plantFake(s: Scene): Promise<string> {
  const fake = join(s.home, 'work', 'fake');
  await mkdir(join(fake, 'skills', s.skill.dirName), { recursive: true });
  await writeFile(join(fake, 'skills', s.skill.dirName, 'SKILL.md'), '---\nname: x\n---\n员工改写的技能');
  return fake;
}
const alertTexts = (s: Scene) => s.ctx.store.table('alerts').list().map(row => row.text);
const audits = (s: Scene, action: string) => s.ctx.store.log('audit').all().filter(row => row.action === action).map(row => JSON.parse(row.detail) as Record<string, unknown>);

describe('P75r3 真实文件系统：审查 H2 的复现', () => {
  it('.agents 被换成指向 work/fake 的符号链接（链接里放了员工自己写的技能）：核对之后链接被移走，work/fake 原样还在，技能文件是技能库的内容，告警一条逐字，审计一条', async () => {
    const s = await scene();
    const fake = await plantFake(s);
    // 复现审查 H2：把 .agents 整个挪开，再换成指向 work/fake 的链接。
    const { rename } = await import('node:fs/promises');
    await rename(join(s.home, '.agents'), join(s.home, 'work-orig'));
    await symlink(fake, join(s.home, '.agents'));
    expect((await lstat(join(s.home, '.agents'))).isSymbolicLink()).toBe(true);
    // 核对前：经链接读到的是员工写的内容（这就是漏洞）。
    expect(await readFile(s.file, 'utf8')).toContain('员工改写的技能');

    await verifyManagedFiles(s.ctx, s.bot.id);

    // 链接被移到搬走的位置，而且移的是链接本身：搬走位置那一项仍是符号链接，指向 work/fake。
    const replaced = audits(s, 'skill_dir_replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ botId: s.bot.id, path: '.agents', found: '符号链接' });
    const to = replaced[0]!.to as string;
    expect(to).toContain(join(s.rootDir, SKILL_DEFAULTS.STRAY_DIR, s.bot.id));
    expect((await lstat(to)).isSymbolicLink()).toBe(true);
    expect(await readlink(to)).toBe(fake);
    // 没有跟随链接删除：work/fake 里员工的文件原样还在。
    expect(await readFile(join(fake, 'skills', s.skill.dirName, 'SKILL.md'), 'utf8')).toContain('员工改写的技能');
    // .agents 是真实目录，技能文件是技能库的内容。
    expect((await lstat(join(s.home, '.agents'))).isDirectory()).toBe(true);
    expect(await readFile(s.file, 'utf8')).toBe(s.expected);
    expect(await readFile(join(s.home, '.agents/skills/owner-brief/SKILL.md'), 'utf8')).toContain('dsh-buddy:preset-skill:owner-brief');
    // 告警一条、逐字；不计越界。
    expect(alertTexts(s)).toEqual([SKILL_DIR_REPLACED_ALERT(botFixture.name)]);
    // P75r4 第 3 节第 2 条改了预期：告警第一句改写（原句「技能目录被换成了别的东西」）。
    expect(alertTexts(s)).toEqual([`${botFixture.name}家目录里由中心维护的目录被替换过，中心已按技能库的内容恢复。`]);
    expect(s.ctx.store.table('bots').get(s.bot.id)!.violations).toBe(0);
    // 再核对一次：没有新的审计、没有新告警。
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect(audits(s, 'skill_dir_replaced')).toHaveLength(1);
    expect(alertTexts(s)).toHaveLength(1);
  });

  it('.agents/skills 是符号链接的情形：同样移走链接本身并恢复，链接另一头原样还在', async () => {
    const s = await scene();
    const outside = join(s.home, 'work', 'fake-skills');
    await mkdir(join(outside, s.skill.dirName), { recursive: true });
    await writeFile(join(outside, s.skill.dirName, 'SKILL.md'), '员工改写的技能');
    const { rename } = await import('node:fs/promises');
    await rename(join(s.home, '.agents/skills'), join(s.home, 'work-orig-skills'));
    await symlink(outside, join(s.home, '.agents/skills'));

    await verifyManagedFiles(s.ctx, s.bot.id);

    const replaced = audits(s, 'skill_dir_replaced');
    expect(replaced).toMatchObject([{ path: '.agents/skills', found: '符号链接' }]);
    expect((await lstat(replaced[0]!.to as string)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, s.skill.dirName, 'SKILL.md'), 'utf8')).toBe('员工改写的技能');
    expect((await lstat(join(s.home, '.agents/skills'))).isDirectory()).toBe(true);
    expect(await readFile(s.file, 'utf8')).toBe(s.expected);
    expect(alertTexts(s)).toEqual([SKILL_DIR_REPLACED_ALERT(botFixture.name)]);
  });

  it('技能目录下的一项是指向目录外的符号链接：链接本身移走，目录外的文件原样还在', async () => {
    const s = await scene();
    const outside = join(s.home, 'work', 'outside-dir');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'precious.txt'), '目录外的东西');
    await symlink(outside, join(s.home, '.agents/skills/zz-link'));
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect(await readdir(join(s.home, '.agents/skills'))).not.toContain('zz-link');
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('目录外的东西');
    expect(audits(s, 'skill_dir_replaced')).toMatchObject([{ path: '.agents/skills/zz-link', found: '符号链接' }]);
    expect(alertTexts(s)).toHaveLength(1);
  });

  it('在三处之外建一个指进来的链接（ln -s .agents/skills s），经链接改写了技能文件：核对之后内容恢复', async () => {
    const s = await scene();
    await symlink(join(s.home, '.agents/skills'), join(s.home, 's'));
    // 经链接改写（闸门不拦这种写法，靠核对恢复）。
    await writeFile(join(s.home, 's', s.skill.dirName, 'SKILL.md'), '经链接改写的内容');
    expect(await readFile(s.file, 'utf8')).toBe('经链接改写的内容');
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect(await readFile(s.file, 'utf8')).toBe(s.expected);
    // 链接本身在三处之外，不是核对的对象，不动它、不出告警。
    expect((await lstat(join(s.home, 's'))).isSymbolicLink()).toBe(true);
    expect(alertTexts(s)).toEqual([]);
  });

  it('反例：一切正常时核对不产生审计和告警，技能文件的修改时间不变（没有无谓的写入）', async () => {
    const s = await scene();
    await verifyManagedFiles(s.ctx, s.bot.id);
    const before = (await lstat(s.file)).mtimeMs;
    await verifyManagedFiles(s.ctx, s.bot.id);
    expect((await lstat(s.file)).mtimeMs).toBe(before);
    expect(audits(s, 'skill_dir_replaced')).toEqual([]);
    expect(audits(s, 'skill_verify_failed')).toEqual([]);
    expect(alertTexts(s)).toEqual([]);
  });
});

describe('P75r3 SystemFs.move（接口新增的方法）', () => {
  it('移动符号链接本身：链接另一头的内容原样还在，搬走位置的那一项仍是链接', async () => {
    const s = await scene();
    const target = join(s.home, 'work', 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'f.txt'), 'F');
    await symlink(target, join(s.home, 'lnk'));
    const to = join(s.rootDir, 'aside', 'deeper', 'lnk');
    await s.ctx.fs.move(join(s.home, 'lnk'), to, { within: s.home });
    expect((await lstat(to)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, 'f.txt'), 'utf8')).toBe('F');
    expect(await s.ctx.fs.lstat(join(s.home, 'lnk'))).toBeNull();
  });
  it('移动目录整棵、移动文件；源不存在、目标已存在都抛错', async () => {
    const s = await scene();
    await mkdir(join(s.home, 'd/sub'), { recursive: true });
    await writeFile(join(s.home, 'd/sub/x.txt'), 'X');
    await s.ctx.fs.move(join(s.home, 'd'), join(s.rootDir, 'aside', 'd'));
    expect(await readFile(join(s.rootDir, 'aside/d/sub/x.txt'), 'utf8')).toBe('X');
    await expect(s.ctx.fs.move(join(s.home, 'd'), join(s.rootDir, 'aside', 'd2'))).rejects.toThrow('移动源不存在');
    await writeFile(join(s.home, 'f.txt'), 'F');
    await expect(s.ctx.fs.move(join(s.home, 'f.txt'), join(s.rootDir, 'aside', 'd'))).rejects.toThrow('移动目标已存在');
    expect(await readFile(join(s.home, 'f.txt'), 'utf8')).toBe('F');
  });
  it('带边界时，源的上级是符号链接就拒绝，链接另一头的文件不动', async () => {
    const s = await scene();
    const outside = join(s.rootDir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'victim.txt'), 'V');
    await symlink(outside, join(s.home, 'door'));
    await expect(s.ctx.fs.move(join(s.home, 'door', 'victim.txt'), join(s.rootDir, 'aside', 'victim.txt'), { within: s.home }))
      .rejects.toBeInstanceOf(PathContainmentError);
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('V');
  });
});
