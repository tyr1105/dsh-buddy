/**
 * P69 A-4：用真实文件系统（SystemFs，系统临时目录里搭的假中心）验证 hub_project_put 的来源边界，对应复查报告 S1、S2、S3 和第 4 节的 T4。
 * 不碰真实家目录和任何凭据；每条用例自己建、自己删临时目录。
 *
 * - S1 硬链接：家目录里的硬链接指向家目录外的文件，现在被拒绝。
 * - S2 检查之后、读取之前把中间目录换成符号链接：读取时按句柄再核，被拒绝。
 * - S3 检查之后把文件撑大：限量读取，超过额度立刻停，不把整个文件读进内存。
 * - T4 来源和落点的大小写变体、符号链接（真实 APFS 上不区分大小写，内存假实现测不到）。
 * 同时直接测 SystemFs.readBytesWithin 本身的约定。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryLogger } from '../src/io/testing/memory-logger.js';
import { SystemFs } from '../src/io/system-fs.js';
import { PathContainmentError, ReadLimitError } from '../src/io/interfaces.js';
import type { BoundedRead } from '../src/io/interfaces.js';
import { resolveSettings } from '../src/config/defaults.js';
import { runTool } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { ProjectSchema } from '../src/model/index.js';
import { botFixture } from './model-fixtures.js';

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true }); });

/** 在系统临时目录里搭一个假中心：root/bots/<id>（家目录）、root/projects/prj（项目文件夹）、tmp/outside（家目录外）。 */
function setup(fs: SystemFs = new SystemFs(new MemoryLogger())) {
  const base = nodeFs.realpathSync(nodeFs.mkdtempSync(join(os.tmpdir(), 'p69-a4-')));
  cleanups.push(base);
  const root = join(base, 'hub'), home = join(root, 'bots', botFixture.id), project = join(root, 'projects', 'prj_0000000001'), outside = join(base, 'outside');
  for (const dir of [join(home, 'work'), project, outside]) nodeFs.mkdirSync(dir, { recursive: true });
  const ctx = createTestContext({ ownerHome: join(base, 'owner'), fs });
  ctx.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const bot = { ...botFixture, name: '工程师', sessionId: 'session-a4r', homeDir: home, autonomy: 'L2' as const, lifecycle: 'active' as const };
  ctx.store.table('bots').put(bot);
  const now = ctx.clock.now();
  ctx.store.table('projects').put(ProjectSchema.parse({ id: 'prj_0000000001', name: '报名页', charter: '', status: 'active', ownerBotId: null, memberBotIds: [bot.id],
    sharedDir: `${project}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null }));
  const tc: ToolContext = { botId: bot.id, sessionId: bot.sessionId, wakeId: null };
  return { ctx, tc, home, project, outside, base, put: (args: unknown) => runTool(ctx, tc, 'hub_project_put', args) };
}
type Env = ReturnType<typeof setup>;
const errorOf = (result: Awaited<ReturnType<Env['put']>>): string => { expect(result.ok, JSON.stringify(result)).toBe(false); return result.ok ? '' : result.error; };

describe('S1 硬链接不能把家目录外的文件带进项目文件夹', () => {
  it('家目录里的硬链接指向家目录外的「凭据」：拒绝，说清是哪个文件和怎么办，项目文件夹里什么都没有', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE-HOME');
    nodeFs.linkSync(join(s.outside, 'secret.txt'), join(s.home, 'work', 'notes.txt'));
    const error = errorOf(await s.put({ from: 'work/notes.txt' }));
    expect(error).toContain('work/notes.txt');
    expect(error).toContain('硬链接');
    expect(error).toContain('复制成');
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });

  it('硬链接到 mind/ 下的文件，不能绕过「中心维护的文件不能放」', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.home, 'mind'), { recursive: true });
    nodeFs.writeFileSync(join(s.home, 'mind', 'goals.md'), 'MIND-CONTENT');
    nodeFs.linkSync(join(s.home, 'mind', 'goals.md'), join(s.home, 'work', 'g.md'));
    expect(errorOf(await s.put({ from: 'work/g.md' }))).toContain('硬链接');
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });

  it('文件夹里夹着一个硬链接：整次拒绝，同一个文件夹里的普通文件也不放', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.home, 'work', 'pack'));
    nodeFs.writeFileSync(join(s.home, 'work', 'pack', 'a.txt'), 'A');
    nodeFs.writeFileSync(join(s.outside, 'b'), 'B');
    nodeFs.linkSync(join(s.outside, 'b'), join(s.home, 'work', 'pack', 'b.txt'));
    expect(errorOf(await s.put({ from: 'work/pack' }))).toContain('pack/b.txt');
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });

  it('已知局限（照实记录）：队友先把内容另存一份再放，这道检查拦不住，它拦的是「原样带走」', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), 'COPIED');
    // 队友有权限读的话，自己 cp 一份到家目录里，得到的是一个全新的普通文件。
    nodeFs.copyFileSync(join(s.outside, 'secret.txt'), join(s.home, 'work', 'copy.txt'));
    expect((await s.put({ from: 'work/copy.txt' })).ok).toBe(true);
    expect(nodeFs.readFileSync(join(s.project, 'copy.txt'), 'utf8')).toBe('COPIED');
  });
});

describe('S2 检查之后、读取之前把中间目录换成符号链接', () => {
  it('读取时按句柄再核：中间一级被换成链接，拒绝，项目文件夹里没有家目录外的内容', async () => {
    let swapped = false;
    let paths: { home: string; outside: string } | null = null;
    /** 第一次读文件前，把 work/pkg 换成指向 outside 的符号链接：等价于队友后台跑一个循环不停地换。 */
    class RacingFs extends SystemFs {
      override async readBytesWithin(path: string, limit: BoundedRead): Promise<Uint8Array | null> {
        if (!swapped && paths) {
          swapped = true;
          nodeFs.renameSync(join(paths.home, 'work', 'pkg'), join(paths.home, 'work', 'pkg.real'));
          nodeFs.symlinkSync(paths.outside, join(paths.home, 'work', 'pkg'));
        }
        return super.readBytesWithin(path, limit);
      }
    }
    const s = setup(new RacingFs(new MemoryLogger()));
    paths = { home: s.home, outside: s.outside };
    nodeFs.mkdirSync(join(s.home, 'work', 'pkg'));
    nodeFs.writeFileSync(join(s.home, 'work', 'pkg', 'credentials'), 'decoy');
    nodeFs.writeFileSync(join(s.outside, 'credentials'), 'AWS-SECRET-FROM-OUTSIDE');
    const error = errorOf(await s.put({ from: 'work/pkg' }));
    expect(swapped).toBe(true);
    expect(error).toContain('pkg/credentials');
    expect(error).toContain('符号链接');
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });

  it('文件本身在检查之后被换成指向家目录外的符号链接：打开时就被拒绝（不跟随最后一级链接）', async () => {
    const fs = new SystemFs(new MemoryLogger());
    const s = setup(fs);
    nodeFs.writeFileSync(join(s.outside, 'secret'), 'S');
    nodeFs.symlinkSync(join(s.outside, 'secret'), join(s.home, 'work', 'l.txt'));
    await expect(fs.readBytesWithin(join(s.home, 'work', 'l.txt'), { within: s.home, maxBytes: 100 })).rejects.toBeInstanceOf(PathContainmentError);
  });
});

describe('S3 限量读取：超过额度立刻停，不把整个文件读进内存', () => {
  it('stat 时 1 字节，读之前被扩成 512 MB 的稀疏文件：报「文件太大」，并且没有分配出 512 MB', async () => {
    let target = '';
    class GrowingFs extends SystemFs {
      override async readBytesWithin(path: string, limit: BoundedRead): Promise<Uint8Array | null> {
        if (path === target) nodeFs.truncateSync(path, 512 * 1024 * 1024);
        return super.readBytesWithin(path, limit);
      }
    }
    const s = setup(new GrowingFs(new MemoryLogger()));
    target = join(s.home, 'work', 'small.bin');
    nodeFs.writeFileSync(target, 'x');
    const before = process.memoryUsage().arrayBuffers;
    const error = errorOf(await s.put({ from: 'work/small.bin' }));
    const grown = process.memoryUsage().arrayBuffers - before;
    expect(error).toContain('文件太大');
    // 整个读进内存会涨 512 MB；限量读取最多读上限加 1 字节（20 MB 加一点），留足余量只断言远低于它。
    expect(grown).toBeLessThan(100 * 1024 * 1024);
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });
});

describe('SystemFs.readBytesWithin 本身的约定', () => {
  it('正常读取：内容一致；刚好等于上限可以读；缺失返回 null', async () => {
    const fs = new SystemFs(new MemoryLogger());
    const s = setup(fs);
    nodeFs.writeFileSync(join(s.home, 'work', 'a.bin'), Buffer.from([0, 255, 1, 2, 3]));
    const limit = { within: s.home, maxBytes: 5 };
    expect(Array.from((await fs.readBytesWithin(join(s.home, 'work', 'a.bin'), limit))!)).toEqual([0, 255, 1, 2, 3]);
    expect(await fs.readBytesWithin(join(s.home, 'work', 'nope.bin'), limit)).toBeNull();
    expect(await fs.readBytesWithin(join(s.home, 'nodir', 'nope.bin'), limit)).toBeNull();
  });
  it('超过上限一个字节就抛 ReadLimitError', async () => {
    const fs = new SystemFs(new MemoryLogger());
    const s = setup(fs);
    nodeFs.writeFileSync(join(s.home, 'work', 'a.bin'), Buffer.alloc(6));
    await expect(fs.readBytesWithin(join(s.home, 'work', 'a.bin'), { within: s.home, maxBytes: 5 })).rejects.toBeInstanceOf(ReadLimitError);
  });
  it('目录、根目录之外的路径、硬链接都拒绝（硬链接带 hardlink 标记）', async () => {
    const fs = new SystemFs(new MemoryLogger());
    const s = setup(fs);
    const limit = { within: s.home, maxBytes: 100 };
    await expect(fs.readBytesWithin(join(s.home, 'work'), limit)).rejects.toBeInstanceOf(PathContainmentError);
    nodeFs.writeFileSync(join(s.outside, 'o'), 'o');
    await expect(fs.readBytesWithin(join(s.outside, 'o'), limit)).rejects.toBeInstanceOf(PathContainmentError);
    nodeFs.linkSync(join(s.outside, 'o'), join(s.home, 'work', 'o'));
    await expect(fs.readBytesWithin(join(s.home, 'work', 'o'), limit)).rejects.toMatchObject({ reason: 'hardlink' });
  });
  it('相对路径被拒绝（和其他接口一致）', async () => {
    const fs = new SystemFs(new MemoryLogger());
    await expect(fs.readBytesWithin('work/a', { within: '/tmp', maxBytes: 1 })).rejects.toThrow('绝对路径');
  });
});

describe('T4 大小写变体和符号链接（真实 APFS，不区分大小写）', () => {
  it('MIND/、Memory/Journal/、agents.md、CONTEXT.MD 这类大小写变体都被拒绝', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.home, 'mind'), { recursive: true });
    nodeFs.writeFileSync(join(s.home, 'mind', 'g.md'), 'x');
    nodeFs.mkdirSync(join(s.home, 'memory', 'journal'), { recursive: true });
    nodeFs.writeFileSync(join(s.home, 'memory', 'journal', 'd.md'), 'x');
    nodeFs.writeFileSync(join(s.home, 'AGENTS.md'), 'x');
    for (const from of ['MIND/g.md', 'Memory/Journal/d.md', 'agents.md', 'Mind']) expect((await s.put({ from })).ok, from).toBe(false);
    nodeFs.writeFileSync(join(s.home, 'work', 'a.txt'), 'x');
    for (const to of ['CONTEXT.MD', 'Context.md', './context.md', 'x/../context.md']) expect((await s.put({ from: 'work/a.txt', to })).ok, to).toBe(false);
    expect(nodeFs.existsSync(join(s.project, 'context.md'))).toBe(false);
  });

  it('真实符号链接：来源文件、来源中间目录、来源大小写变体路径里的链接都被拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret'), 'S');
    nodeFs.symlinkSync(join(s.outside, 'secret'), join(s.home, 'work', 'l.txt'));
    nodeFs.symlinkSync(s.outside, join(s.home, 'work', 'ldir'));
    expect((await s.put({ from: 'work/l.txt' })).ok).toBe(false);
    expect((await s.put({ from: 'work/ldir/secret' })).ok).toBe(false);
    expect((await s.put({ from: `${s.home.toUpperCase()}/WORK/LDIR/secret` })).ok).toBe(false);
    expect(nodeFs.readdirSync(s.project)).toEqual([]);
  });

  it('正常的二进制文件夹在真实文件系统上原样放进去', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.home, 'work', 'site', 'img'), { recursive: true });
    nodeFs.writeFileSync(join(s.home, 'work', 'site', 'index.html'), '<h1>x</h1>');
    nodeFs.writeFileSync(join(s.home, 'work', 'site', 'img', 'a.png'), Buffer.from([137, 80, 78, 71, 0, 255, 254]));
    const result = await s.put({ from: 'work/site' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(nodeFs.readFileSync(join(s.project, 'site', 'index.html'), 'utf8')).toBe('<h1>x</h1>');
    expect(Array.from(nodeFs.readFileSync(join(s.project, 'site', 'img', 'a.png')))).toEqual([137, 80, 78, 71, 0, 255, 254]);
  });
});

describe('落点：项目文件夹里的链接（真实文件系统）', () => {
  it('项目文件夹里某一级是指向外面的链接：拒绝；项目外没有文件', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.home, 'work', 'a.txt'), 'x');
    nodeFs.symlinkSync(s.outside, join(s.project, 'sub'));
    expect((await s.put({ from: 'work/a.txt', to: 'sub/a.txt' })).ok).toBe(false);
    expect((await s.put({ from: 'work/a.txt', to: 'SUB/a.txt' })).ok).toBe(false);
    expect(nodeFs.readdirSync(s.outside)).toEqual([]);
  });

  it('检查之后、写入之前把落点中间目录换成链接：写入层拒绝，项目外没有文件', async () => {
    let hit = false;
    let paths: { project: string; outside: string } | null = null;
    class RacingFs extends SystemFs {
      override async writeBytesAtomic(path: string, bytes: Uint8Array, boundary?: { within: string }): Promise<void> {
        if (!hit && paths) {
          hit = true;
          nodeFs.rmSync(join(paths.project, 'sub'), { recursive: true, force: true });
          nodeFs.symlinkSync(paths.outside, join(paths.project, 'sub'));
        }
        return super.writeBytesAtomic(path, bytes, boundary);
      }
    }
    const s = setup(new RacingFs(new MemoryLogger()));
    paths = { project: s.project, outside: s.outside };
    nodeFs.mkdirSync(join(s.project, 'sub'));
    nodeFs.writeFileSync(join(s.home, 'work', 'a.txt'), 'x');
    expect((await s.put({ from: 'work/a.txt', to: 'sub/a.txt' })).ok).toBe(false);
    expect(nodeFs.readdirSync(s.outside)).toEqual([]);
  });

  it('落点已有一个指向外面文件的链接：rename 只替换链接本身，外面的文件不变', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'victim'), 'ORIGINAL');
    nodeFs.symlinkSync(join(s.outside, 'victim'), join(s.project, 'a.txt'));
    nodeFs.writeFileSync(join(s.home, 'work', 'a.txt'), 'NEW');
    await s.put({ from: 'work/a.txt' });
    expect(nodeFs.readFileSync(join(s.outside, 'victim'), 'utf8')).toBe('ORIGINAL');
  });

  it('S11 真实文件系统：落点已经是文件夹，整次拒绝，没有半成品', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.home, 'work', 'pack'));
    nodeFs.writeFileSync(join(s.home, 'work', 'pack', 'a.txt'), 'A');
    nodeFs.writeFileSync(join(s.home, 'work', 'pack', 'b.txt'), 'B');
    nodeFs.mkdirSync(join(s.project, 'pack', 'b.txt'), { recursive: true });
    expect(errorOf(await s.put({ from: 'work/pack' }))).toContain('已经是一个文件夹');
    expect(nodeFs.existsSync(join(s.project, 'pack', 'a.txt'))).toBe(false);
  });
});
