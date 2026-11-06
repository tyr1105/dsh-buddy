/** M12 用真实临时文件补验字节指纹和链接边界，再用注入接口验证静态参数提取与读取故障。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemFs } from '../src/io/system-fs.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { captureCommandFiles } from '../src/gate/command-files.js';
import { sha256Hex } from '../src/util/hash.js';
import { botFixture } from './model-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** 所有真实文件只写系统临时目录，验证后完整清理。 */
async function temporary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-hub-m12-files-')));
  roots.push(root);
  return root;
}

describe('M12 原始字节接口与真实文件类型', () => {
  it('SystemFs 读原始字节、不以解码文本替代；缺失返回 null，目录与相对路径拒绝', async () => {
    const root = await temporary();
    const fs = new SystemFs();
    const path = join(root, 'binary');
    await writeFile(path, Buffer.from([0x80]));
    expect(await fs.stat(path)).toMatchObject({ isFile: true, isDir: false });
    expect(await fs.readBytes(path)).toEqual(Buffer.from([0x80]));
    await writeFile(path, Buffer.from([0x81]));
    expect(await fs.readBytes(path)).toEqual(Buffer.from([0x81]));
    expect(await fs.readBytes(join(root, 'missing'))).toBeNull();
    await expect(fs.readBytes(root)).rejects.toThrow('普通文件');
    await expect(fs.readBytes('relative')).rejects.toThrow('绝对路径');
  });

  it('真实家内链接绑定原引用和实际目标；改指向同内容家外文件仍拒绝且不读家外正文', async () => {
    const root = await temporary();
    const homeDir = join(root, 'bot');
    await mkdir(homeDir);
    const fs = new SystemFs();
    const ctx = createTestContext({ fs });
    const bot = { ...botFixture, homeDir };
    ctx.store.table('bots').put(bot);
    const target = join(homeDir, 'version.py');
    const link = join(homeDir, 'runner.py');
    const outside = join(root, 'outside.py');
    await writeFile(target, 'print(1)');
    await writeFile(outside, 'print(1)');
    await symlink(target, link);
    const payload = { cmd: 'python3', args: ['runner.py'], cwd: homeDir };
    expect(await captureCommandFiles(ctx, bot.id, payload)).toEqual([{ path: link, realPath: target, sha256: sha256Hex('print(1)') }]);
    await rm(link);
    await symlink(outside, link);
    const read = fs.readBytes.bind(fs);
    const reads: string[] = [];
    fs.readBytes = async path => { reads.push(path); return read(path); };
    await expect(captureCommandFiles(ctx, bot.id, payload)).rejects.toThrow('家目录边界外');
    expect(reads).toEqual([]);
    // 即使检查后的普通文件被替换成链接，底层字节接口也不会沿这个新链接读取。
    await expect(fs.readBytes(link)).rejects.toThrow();
  });
});

describe('M12 命令文件提取的保守边界', () => {
  it.each([
    ['选项等号', ['--config=work/data.json']],
    ['响应文件', ['@work/data.json']],
    ['短选项贴值', ['-rwork/data.json']],
    ['shell 静态词', ['-c', 'cat work/data.json']],
    ['shell 改目录', ['-c', 'cd work; cat data.json']],
  ])('%s 指向的已有家内文件也进入内容指纹', async (_name, args) => {
    const ctx = createTestContext();
    ctx.store.table('bots').put(botFixture);
    const path = `${botFixture.homeDir}/work/data.json`;
    await ctx.fs.writeTextAtomic(path, '{"ok":true}');
    const files = await captureCommandFiles(ctx, botFixture.id, { cmd: 'bash', args, cwd: botFixture.homeDir });
    expect(files).toContainEqual({ path, realPath: path, sha256: sha256Hex('{"ok":true}') });
  });

  it('普通文件读取故障和未知类型均失败关闭，不把故障降成空指纹', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put(botFixture);
    const path = `${botFixture.homeDir}/work/file.py`;
    await ctx.fs.writeTextAtomic(path, 'print(1)');
    const payload = { cmd: 'python3', args: ['work/file.py'], cwd: botFixture.homeDir };
    ctx.fs.readBytes = async () => { throw new Error('EACCES'); };
    await expect(captureCommandFiles(ctx, botFixture.id, payload)).rejects.toThrow('EACCES');
    const stat = ctx.fs.stat.bind(ctx.fs);
    ctx.fs.stat = async name => {
      const info = await stat(name);
      return info ? { size: info.size, mtimeMs: info.mtimeMs, isDir: info.isDir } : null;
    };
    await expect(captureCommandFiles(ctx, botFixture.id, payload)).rejects.toThrow('无法确认为普通文件');
  });
});
