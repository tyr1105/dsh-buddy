/**
 * P75r4 第 3 节的测试（内存文件系统；真实文件系统上的几条在 p75r4-real-fs.test.ts）：
 * - 第 2 条：告警第一句逐字；
 * - 第 3 条：迁移完成之前不查 memory 目录本身（完成之后才查）；
 * - 第 4 条：某一位员工的 memory/MEMORY.md 读不出，迁移收尾记审计、跳过这一位，这一步照常完成；
 * - 第 5 条：搬走的目标位置被换成符号链接时拒绝（内存实现用 markSymlink 标出链接）。
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryFs } from '../src/io/testing/index.js';
import { PathContainmentError } from '../src/io/index.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';
import { SKILL_DIR_REPLACED_ALERT, SKILL_VERIFY_FAILED_ALERT } from '../src/skill/files.js';
import { createBotHome, verifyManagedFiles, LEGACY_MEMORY_NOTICE } from '../src/memory/index.js';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { MEMORY_DEFAULTS, SKILL_DEFAULTS } from '../src/config/defaults.js';
import { INITIAL_MEMORY_MD, legacyWorld, record } from './p75r2-fixtures.js';

const HOME = botFixture.homeDir;
const at = (...parts: string[]): string => posix.join(HOME, ...parts);

/** 一位带家目录的员工（内存文件系统）。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, presetSkillIds: [] as string[], dshSkillNames: [] as string[] };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  return { ctx, bot, fs: ctx.fs as unknown as MemoryFs };
}
const alertTexts = (ctx: HubContext) => ctx.store.table('alerts').list().map(row => row.text);
const auditsOf = (ctx: HubContext, action: string) => ctx.store.log('audit').all().filter(row => row.action === action).map(row => JSON.parse(row.detail) as Record<string, unknown>);

describe('P75r4 第 3 节第 2 条：告警第一句逐字', () => {
  it('第一句改写，第二句不变；都不带员工编号', () => {
    expect(SKILL_DIR_REPLACED_ALERT('小明')).toBe('小明家目录里由中心维护的目录被替换过，中心已按技能库的内容恢复。');
    expect(SKILL_VERIFY_FAILED_ALERT('小明')).toBe('小明家目录里的技能目录核对没有完成，下一个回合读到的技能可能不是技能库里的内容。');
  });
});

describe('P75r4 第 3 节第 3 条：迁移完成之前不查 memory 目录本身', () => {
  it('迁移未完成时 memory 是符号链接：不搬走、不告警；迁移完成（备份步骤完成）之后：搬走并重建、告警一条', async () => {
    const { ctx, bot, fs } = await setup();
    await ctx.fs.writeTextAtomic(at('memory/MEMORY.md'), '员工自己的长期记忆');
    fs.markSymlink(at('memory'));
    // 没有迁移记录：旧数据还在生效，memory 里是员工自己的长期记忆。
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory')))!.isSymlink).toBe(true);
    expect(await ctx.fs.readText(at('memory/MEMORY.md'))).toBe('员工自己的长期记忆');
    expect(auditsOf(ctx, 'skill_dir_replaced')).toHaveLength(0);
    expect(alertTexts(ctx)).toEqual([]);
    // 迁移记录是 writing / failed 时同样不查。
    ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 1, written: {}, steps: {}, error: 'x', updatedAt: 1 });
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory')))!.isSymlink).toBe(true);
    // 迁移 done 但备份步骤还没完成：仍不查。
    ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: 1 });
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory')))!.isSymlink).toBe(true);
    expect(alertTexts(ctx)).toEqual([]);
    // 完成之后：搬走并重建，告警一条。
    ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: { backupMemory: true }, error: null, updatedAt: 1 });
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory')))!.isSymlink).toBe(false);
    expect((await ctx.fs.lstat(at('memory/journal')))!.isDir).toBe(true);
    expect(auditsOf(ctx, 'skill_dir_replaced')).toMatchObject([{ path: 'memory', found: '符号链接' }]);
    expect(alertTexts(ctx)).toEqual([SKILL_DIR_REPLACED_ALERT(bot.name)]);
  });
});

describe('P75r4 第 3 节第 4 条：某一位员工的 MEMORY.md 读不出', () => {
  it('第二位员工的 MEMORY.md 是目录：迁移 done、备份步骤完成、审计一条（写明员工和错误文字），第一位的文件已改写成停用说明', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    // 把第二位员工的 MEMORY.md 换成一个目录：读它会出错（不能把目录当文件读取）。
    await ctx.fs.remove(posix.join(other.homeDir, 'memory', 'MEMORY.md'));
    await ctx.fs.mkdirp(posix.join(other.homeDir, 'memory', 'MEMORY.md'));
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null });
    expect(record(ctx)!.steps.backupMemory).toBe(true);
    const unreadable = auditsOf(ctx, 'p75_memory_unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ botId: other.id, name: other.name });
    expect(String(unreadable[0]!.error)).toContain('不能把目录当文件读取');
    // 第一位员工照做：文件被改写成停用说明，备份在。
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', chiefBot.id, 'MEMORY.md'))).toBe(INITIAL_MEMORY_MD);
    // 后面的收尾步骤照常完成。
    expect(record(ctx)!.steps).toMatchObject({ lessonProposals: true, materializeSkills: true, refreshAll: true });
    // 再启动一次：这一步已完成，不重复记审计。
    await runP75Migration(ctx);
    expect(auditsOf(ctx, 'p75_memory_unreadable')).toHaveLength(1);
  });

  it('反例：两位员工的 MEMORY.md 都能读时，没有这条审计', async () => {
    const { ctx } = await legacyWorld();
    await runP75Migration(ctx);
    expect(record(ctx)!.steps.backupMemory).toBe(true);
    expect(auditsOf(ctx, 'p75_memory_unreadable')).toHaveLength(0);
  });
});

describe('P75r4 第 3 节第 5 条：搬走的目标位置不能被链接改道（内存文件系统）', () => {
  it('move 带目标边界：目标上级任何一级被标成链接就拒绝，东西留在原处；目标不在边界内也拒绝；反例：没有链接时正常搬', async () => {
    const { ctx, fs } = await setup();
    await ctx.fs.writeTextAtomic('/hub/bots/x/work/a.txt', 'A');
    await ctx.fs.writeTextAtomic('/hub/bots/x/work/b.txt', 'B');
    await ctx.fs.mkdirp('/hub/.hub/stray-skills/x');
    fs.markSymlink('/hub/.hub/stray-skills/x');
    await expect(ctx.fs.move('/hub/bots/x/work/a.txt', '/hub/.hub/stray-skills/x/1/a.txt', { within: '/hub/bots/x' }, { within: '/hub' }))
      .rejects.toBeInstanceOf(PathContainmentError);
    expect(await ctx.fs.readText('/hub/bots/x/work/a.txt')).toBe('A');
    expect(await ctx.fs.readText('/hub/.hub/stray-skills/x/1/a.txt')).toBeNull();
    // 目标不在边界内。
    await expect(ctx.fs.move('/hub/bots/x/work/a.txt', '/elsewhere/a.txt', { within: '/hub/bots/x' }, { within: '/hub' }))
      .rejects.toBeInstanceOf(PathContainmentError);
    // 反例：目标上级没有链接，正常搬走。
    await ctx.fs.move('/hub/bots/x/work/b.txt', '/hub/.hub/stray-skills/y/1/b.txt', { within: '/hub/bots/x' }, { within: '/hub' });
    expect(await ctx.fs.readText('/hub/.hub/stray-skills/y/1/b.txt')).toBe('B');
  });

  it('核对时搬走位置的上级是链接：这一项没有被搬走，核对记失败，出第二句告警一条，审计 skill_verify_failed', async () => {
    const { ctx, bot, fs } = await setup();
    await ctx.fs.mkdirp(at('.agents/skills/zz-dir'));
    fs.markSymlink(at('.agents/skills/zz-dir')); // 员工放的符号链接，需要被搬走
    const strayOfBot = posix.join(ctx.settings.rootDir, SKILL_DEFAULTS.STRAY_DIR, bot.id);
    await ctx.fs.mkdirp(strayOfBot);
    fs.markSymlink(strayOfBot); // 搬走位置的上级被预先换成链接
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('.agents/skills/zz-dir')))!.isSymlink).toBe(true); // 没搬走
    expect(alertTexts(ctx)).toEqual([SKILL_VERIFY_FAILED_ALERT(bot.name)]);
    expect(auditsOf(ctx, 'skill_verify_failed')).toHaveLength(1);
    expect(auditsOf(ctx, 'skill_dir_replaced')).toHaveLength(0);
  });
});
