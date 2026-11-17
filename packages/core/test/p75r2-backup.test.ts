/**
 * P75r2 第 3 节（审查 M2）：长期记忆文件的备份排在迁移最前；改写成停用说明之前先核对备份。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）；每条规则一个正例一个反例。
 */
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { LEGACY_MEMORY_NOTICE, verifyManagedFiles } from '../src/memory/files.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { INITIAL_MEMORY_MD, legacyWorld, putMemoryMd, putRule, record, ruleId, seedBots } from './p75r2-fixtures.js';

const ORIGINAL = `# 长期记忆\n\n${Array.from({ length: 20 }, (_, index) => `第${index}条事实：报名表在共享盘第${index}个目录。`).join('\n')}\n`;
const backupPath = (botId: string) => posix.join('/hub/.hub/legacy', botId, 'MEMORY.md');

/** 让对备份目录的写入失败（磁盘满）；返回恢复函数。 */
function breakBackupWrites(ctx: HubContext): () => void {
  const original = ctx.fs.writeTextAtomic.bind(ctx.fs);
  let broken = true;
  ctx.fs.writeTextAtomic = async (path: string, content: string, options?: unknown) => {
    if (broken && path.includes('/.hub/legacy/')) throw new Error('磁盘满');
    return original(path, content, options as never);
  };
  return () => { broken = false; };
}

describe('P75r2 第 3 节：备份排到最前', () => {
  it('（M2 复现一）备份目录写不进：迁移不是 done，MEMORY.md 原文还在，新表没有行；恢复之后再启动，迁移完成，备份是原文', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看' });
    putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '先看原文再下结论' });
    await putMemoryMd(ctx, other.homeDir, ORIGINAL);
    const restore = breakBackupWrites(ctx);
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(record(ctx)!.error).toContain('备份');
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(ORIGINAL);
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(INITIAL_MEMORY_MD);
    for (const table of ['memories', 'skills', 'skillVersions', 'skillSources'] as const) expect(ctx.store.table(table).count()).toBe(0);
    // 回合结束核对此时不会把原文改写掉（迁移不是 done）。
    await verifyManagedFiles(ctx, other.id);
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(ORIGINAL);
    // 恢复之后再启动：迁移完成，备份是原文，「原长期记忆」迁入。
    restore();
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null });
    expect(await ctx.fs.readText(backupPath(other.id))).toBe(ORIGINAL);
    expect(await ctx.fs.readText(backupPath(chiefBot.id))).toBe(INITIAL_MEMORY_MD);
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(ctx.store.table('skills').list().some(row => row.title === '原长期记忆' && row.botId === other.id)).toBe(true);
    expect(ctx.store.table('memories').count()).toBe(1);
  });

  it('（M2 复现二）改写成停用说明之后、存储落盘之前进程退出：再跑一次，「原长期记忆」照样迁入，内容来自备份，备份仍是原文', async () => {
    const first = await legacyWorld();
    putRule(first.ctx, ruleId(1), { text: '先给主人看' });
    await putMemoryMd(first.ctx, first.other.homeDir, ORIGINAL);
    await runP75Migration(first.ctx);
    expect(await first.ctx.fs.readText(posix.join(first.other.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    // 存储没来得及落盘：新进程拿到的是迁移之前的存储内容（旧规矩、员工），文件系统保留。
    const second = createTestContext({ fs: first.ctx.fs }) as unknown as HubContext;
    seedBots(second);
    putRule(second, ruleId(1), { text: '先给主人看' });
    expect(record(second)).toBeNull();
    await runP75Migration(second);
    expect(record(second)).toMatchObject({ state: 'done', error: null });
    const skill = second.store.table('skills').list().find(row => row.botId === first.other.id && row.title === '原长期记忆');
    expect(skill).toBeTruthy();
    const version = second.store.table('skillVersions').list(row => row.skillId === skill!.id)[0]!;
    expect(version.sentences.map(row => row.text)).toEqual(Array.from({ length: 12 }, (_, index) => `第${index}条事实：报名表在共享盘第${index}个目录。`));
    expect(await second.fs.readText(backupPath(first.other.id))).toBe(ORIGINAL);
    expect(await second.fs.readText(posix.join(first.other.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
  });

  it('反例：备份已存在且原文还在时不覆盖备份（以备份为准迁入）', async () => {
    const { ctx, other } = await legacyWorld();
    await putMemoryMd(ctx, other.homeDir, '# 长期记忆\n\n原文里的另一句。\n');
    await ctx.fs.mkdirp(posix.dirname(backupPath(other.id)));
    await ctx.fs.writeTextAtomic(backupPath(other.id), '# 长期记忆\n\n备份里的那一句。\n');
    await runP75Migration(ctx);
    expect(await ctx.fs.readText(backupPath(other.id))).toBe('# 长期记忆\n\n备份里的那一句。\n');
    const skill = ctx.store.table('skills').list().find(row => row.botId === other.id)!;
    expect(ctx.store.table('skillVersions').list(row => row.skillId === skill.id)[0]!.sentences.map(row => row.text)).toEqual(['备份里的那一句。']);
  });

  it('收尾改写前核对备份：备份缺失时不改写这一位、这一步不记完成；补上备份后下次启动改写并记完成；原文本来就是停用说明的不需要备份', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    // 直接把迁移记录置为 done（steps 为空），模拟「迁移做完、收尾还没做」；员工二有内容但没有备份；员工一的文件已是停用说明。
    ctx.store.table('migrations').put({ id: 'p75-storage', state: 'done', attempts: 0, written: {}, steps: {}, error: null, updatedAt: ctx.clock.now() });
    await putMemoryMd(ctx, other.homeDir, ORIGINAL);
    await putMemoryMd(ctx, chiefBot.homeDir, `${LEGACY_MEMORY_NOTICE}\n`);
    await runP75Migration(ctx);
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(ORIGINAL);
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(record(ctx)!.steps.backupMemory).toBeUndefined();
    // 补上备份，下次启动改写。
    await ctx.fs.mkdirp(posix.dirname(backupPath(other.id)));
    await ctx.fs.writeTextAtomic(backupPath(other.id), ORIGINAL);
    await runP75Migration(ctx);
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(record(ctx)!.steps.backupMemory).toBe(true);
    expect(await ctx.fs.readText(backupPath(other.id))).toBe(ORIGINAL);
    // 员工一没有备份文件（原文本来就是停用说明，不需要）。
    expect(await ctx.fs.readText(backupPath(chiefBot.id))).toBeNull();
  });

  it('反例：备份的内容是停用说明（上一版留下的坏备份）而原文有内容：用原文重做备份', async () => {
    const { ctx, other } = await legacyWorld();
    await putMemoryMd(ctx, other.homeDir, ORIGINAL);
    await ctx.fs.mkdirp(posix.dirname(backupPath(other.id)));
    await ctx.fs.writeTextAtomic(backupPath(other.id), `${LEGACY_MEMORY_NOTICE}\n`);
    await runP75Migration(ctx);
    expect(await ctx.fs.readText(backupPath(other.id))).toBe(ORIGINAL);
    expect(record(ctx)).toMatchObject({ state: 'done' });
  });
});
