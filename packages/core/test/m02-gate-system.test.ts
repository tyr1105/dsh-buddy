/** M02 真实文件系统回归：在临时目录构造符号链接，核对宿主写入不会越过机器人家目录。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemFs } from '../src/io/system-fs.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { resolveSettings } from '../src/config/defaults.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { resolveRealTarget } from '../src/gate/real-path.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('M02 SystemFs realpath 执行边界', () => {
    it('真实目录符号链接及不存在的尾部都解析到实际家外位置', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'm02-gate-')); directories.push(directory);
        const home = join(directory, 'bot'), outside = join(directory, 'outside');
        await mkdir(home); await mkdir(outside);
        await symlink(outside, join(home, 'work'));
        const fs = new SystemFs();
        expect(await fs.realpath(join(home, 'work'))).toBe(await fs.realpath(outside));
        expect(await resolveRealTarget(fs, join(home, 'work', 'new', 'output.txt'))).toBe(join(await fs.realpath(outside), 'new', 'output.txt'));
        const ctx = createTestContext({ fs });
        const bot = { ...botFixture, homeDir: home, autonomy: 'L3' as const };
        ctx.store.table('bots').put(bot);
        ctx.settings = resolveSettings({ rootDir: directory, l3Grants: ['write_file'] });
        await expect(submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: join(home, 'work', 'new', 'output.txt'), content: '不应写入' }, why: '交付' })).rejects.toThrow('符号链接');
        expect(await fs.stat(join(outside, 'new', 'output.txt'))).toBeNull();
    });
    it('真实普通家内文件可执行，存在的家外目标符号链接不能被覆盖', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'm02-gate-')); directories.push(directory);
        const home = join(directory, 'bot'), work = join(home, 'work'), target = join(directory, 'outside.txt');
        await mkdir(work, { recursive: true }); await writeFile(target, '原内容');
        await symlink(target, join(work, 'link.txt'));
        const fs = new SystemFs(), ctx = createTestContext({ fs });
        const bot = { ...botFixture, homeDir: home, autonomy: 'L3' as const };
        ctx.store.table('bots').put(bot); ctx.settings = resolveSettings({ rootDir: directory, l3Grants: ['write_file'] });
        await expect(submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: join(work, 'link.txt'), content: '覆盖' }, why: '交付' })).rejects.toThrow('符号链接');
        expect(await readFile(target, 'utf8')).toBe('原内容');
        const row = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: join(work, 'normal.txt'), content: '成果' }, why: '交付' });
        await executeReadyOutbox(ctx);
        expect(ctx.store.table('outbox').get(row.id)?.status).toBe('done');
        expect(await readFile(join(work, 'normal.txt'), 'utf8')).toBe('成果');
        expect((await fs.stat(join(work, 'normal.txt')))?.inode).toBeTypeOf('number');
    });
});
