/**
 * P74r4b 第 2、3 节的测试：文件预览打开中心复制的副本，不直接打开员工写的文件；交回时与打开时用同一个检查函数。
 *
 * 用真实文件系统（p74g-fixtures.ts 在系统临时目录里搭假中心；符号链接、硬链接、权限位在内存假实现里测不出来）。
 * 测试里不打开任何程序或地址；每条用例结束时删除自己建的临时目录。
 * 各组测试对应任务卡第 2 节「测试」的条目：正常、跳过、上限、预览文件本身是链接、清理、地址；第 3 节：两处检查结论一致。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { checkTopicFile, previewError } from '../src/job/evidence.js';
import { SystemFs } from '../src/io/system-fs.js';
import { MemoryLogger } from '../src/io/testing/memory-logger.js';
import { PREVIEW_COPY_FAILED_TEXT, PREVIEW_COPY_LIMITS, PREVIEW_NOT_IN_DELIVERY_TEXT, clearPreviewRoot, previewRootDir, previewTooBigText, removeJobPreviews } from '../src/job/preview-copy.js';
import { PREVIEW_FILE_GONE_TEXT, jobPreviewTarget, localPreviewUrl } from '../src/job/preview.js';
import { PNG, registerCleanup, setup, type Env } from './p74g-fixtures.js';
import { teamHub } from './p73c-fixtures.js';

registerCleanup();

const JOB = { jobId: 'job_0000000001' };
const HTML = '<html><script src="a.js"></script></html>';

/** 记一次交回（预览写成 preview），再打开。 */
async function open(s: Env, preview: string | null = '交付/index.html') {
  s.submit({ preview });
  return jobPreviewTarget(s.ctx, JOB);
}

/** 打开成功时的副本路径；失败时让测试失败并带上原因。 */
async function openOk(s: Env, preview: string | null = '交付/index.html'): Promise<string> {
  const result = await open(s, preview);
  if (!result.ok || result.data?.kind !== 'file') throw new Error(`没有打开成功：${JSON.stringify(result)}`);
  return result.data.path;
}

/** 一个目录下的全部文件（相对路径，递归，不跟随符号链接）。目录不存在返回空。 */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!nodeFs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel)); else out.push(rel);
  }
  return out.sort();
}

describe('2.1 正常情形：副本里有交付下的全部普通文件，逐字节相同', () => {
  it('含子目录、图片、样式、脚本；返回的目标在预览目录之内；权限位只读、没有可执行位', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.jobDir, '交付/assets/img'), { recursive: true });
    s.write('交付/index.html', HTML);
    s.write('交付/a.js', 'console.log(1)');
    s.write('交付/style.css', 'body{color:#000}');
    s.write('交付/assets/img/logo.png', PNG);
    // P74r6 改了预期：副本只收网页用得到的文件类型，原来的 data.bin 不在名单里，改用名单里的 data.wasm（其余断言不变）。
    s.write('交付/assets/data.wasm', Buffer.from([0, 255, 1, 254, 2]));
    // 原文件带可执行位：副本里不能带。
    nodeFs.chmodSync(join(s.jobDir, '交付/a.js'), 0o755);
    const target = await openOk(s);
    const root = previewRootDir(s.root);
    expect(target.startsWith(join(root, 'job_0000000001') + '/')).toBe(true);
    const copyDir = target.slice(0, target.length - '/index.html'.length);
    expect(filesUnder(copyDir)).toEqual(['a.js', 'assets/data.wasm', 'assets/img/logo.png', 'index.html', 'style.css']);
    for (const rel of filesUnder(copyDir)) {
      expect(nodeFs.readFileSync(join(copyDir, rel)).equals(nodeFs.readFileSync(join(s.jobDir, '交付', rel))), rel).toBe(true);
      const mode = nodeFs.statSync(join(copyDir, rel)).mode & 0o777;
      expect(mode & 0o111, `${rel} 不能有可执行位`).toBe(0);
      expect(mode & 0o222, `${rel} 应只读`).toBe(0);
    }
    // 原文件没有被动过。
    expect(nodeFs.statSync(join(s.jobDir, '交付/a.js')).mode & 0o777).toBe(0o755);
  });

  it('预览文件在子目录里：返回副本里对应的子目录文件', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.jobDir, '交付/站点'), { recursive: true });
    s.write('交付/站点/home.html', HTML);
    const target = await openOk(s, '交付/站点/home.html');
    expect(target.endsWith('/站点/home.html')).toBe(true);
    expect(nodeFs.readFileSync(target, 'utf8')).toBe(HTML);
  });

  it('预览文件不在 交付 文件夹里（在证据里）：不打开，返回固定说明', async () => {
    const s = setup();
    s.write('证据/页面.html', HTML);
    s.write('交付/index.html', HTML);
    expect(await open(s, '证据/页面.html')).toEqual({ ok: false, error: PREVIEW_NOT_IN_DELIVERY_TEXT });
    expect(filesUnder(previewRootDir(s.root))).toEqual([]);
  });
});

describe('2.1 跳过：符号链接、硬链接、控制字符文件名', () => {
  it('交付里的符号链接（指向里面的、指向外面的、指向外面目录的）、硬链接、带控制字符文件名的文件都不在副本里', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), '外面的秘密');
    nodeFs.mkdirSync(join(s.outside, 'dir'));
    nodeFs.writeFileSync(join(s.outside, 'dir/in.txt'), '外面目录里的');
    s.write('交付/index.html', HTML);
    s.write('交付/real.txt', '里面的');
    nodeFs.symlinkSync(join(s.jobDir, '交付/real.txt'), join(s.jobDir, '交付/内链.txt'));
    nodeFs.symlinkSync(join(s.outside, 'secret.txt'), join(s.jobDir, '交付/外链.txt'));
    nodeFs.symlinkSync(join(s.outside, 'dir'), join(s.jobDir, '交付/外目录'));
    nodeFs.linkSync(join(s.outside, 'secret.txt'), join(s.jobDir, '交付/硬链.txt'));
    s.write('交付/带\n换行.js', 'x');
    s.write('交付/带\t制表.js', 'x');
    const target = await openOk(s);
    const copyDir = target.slice(0, target.length - '/index.html'.length);
    // 只有 index.html 和 real.txt；外面的内容在副本里一份也没有。
    expect(filesUnder(copyDir)).toEqual(['index.html', 'real.txt']);
  });

  it('两个名字指向同一个文件（交付里互为硬链接）：两个都跳过', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    s.write('交付/a.txt', '同一份');
    nodeFs.linkSync(join(s.jobDir, '交付/a.txt'), join(s.jobDir, '交付/b.txt'));
    const target = await openOk(s);
    expect(filesUnder(target.slice(0, target.length - '/index.html'.length))).toEqual(['index.html']);
  });
});

describe('2.1 上限：各超一次，都不打开、返回固定说明、预览目录里没有半份副本', () => {
  /** 打开并断言：返回「太大」说明，预览目录里没有任何文件。 */
  async function expectTooBig(s: Env): Promise<void> {
    // 先清掉前面成功那一次留下的副本：要看的是「这一次失败」有没有留下东西。
    nodeFs.rmSync(previewRootDir(s.root), { recursive: true, force: true });
    const result = await open(s);
    expect(result).toEqual({ ok: false, error: previewTooBigText(join(s.jobDir, '交付')) });
    expect((result as { error: string }).error).toContain('预览内容太大，没有打开。可以到项目文件夹里查看：');
    expect(filesUnder(previewRootDir(s.root))).toEqual([]);
  }

  // P74r11：要证明的是「文件数超过上限就按固定办法处理、恰好等于上限照常」，与上限具体是多少无关：
  // 函数接受调用方传入的上限，测试传 20，不在磁盘上建 2000 个文件（原来这一条约 18 秒）。
  const SMALL_FILES = { ...PREVIEW_COPY_LIMITS, MAX_FILES: 20 };

  it('文件数：21 个超过，20 个恰好可以（上限传 20）', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    for (let index = 0; index < SMALL_FILES.MAX_FILES - 1; index += 1) s.write(`交付/f${index}.txt`, 'x');
    expect(filesUnder(join(s.jobDir, '交付')).length).toBe(20);
    s.submit({ preview: '交付/index.html' });
    const ok = await jobPreviewTarget(s.ctx, JOB, SMALL_FILES);
    expect(ok.ok && ok.data?.kind === 'file', JSON.stringify(ok)).toBe(true); // 恰好 20 个：可以。
    s.write('交付/多一个.txt', 'x');
    // 先清掉前面成功那一次留下的副本：要看的是「这一次失败」有没有留下东西。
    nodeFs.rmSync(previewRootDir(s.root), { recursive: true, force: true });
    const result = await jobPreviewTarget(s.ctx, JOB, SMALL_FILES);
    expect(result).toEqual({ ok: false, error: previewTooBigText(join(s.jobDir, '交付')) });
    expect(filesUnder(previewRootDir(s.root))).toEqual([]);
  });

  it('默认上限没有变：文件数 2000（不建文件）', () => {
    expect(PREVIEW_COPY_LIMITS.MAX_FILES).toBe(2000);
  });

  /** 建一个指定大小的稀疏文件（只设长度，不占磁盘，也不真的读写这么多字节）。 */
  function sparse(path: string, size: number): void {
    nodeFs.writeFileSync(path, '');
    nodeFs.truncateSync(path, size);
  }

  it('单个文件：超过 20 MB 不打开，恰好 20 MB 可以', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    sparse(join(s.jobDir, '交付/大.mp4'), 20 * 1024 * 1024); // P74r6 改了预期：文件类型改用名单里的 .mp4（原来是 .bin，不在名单里会被跳过）
    await openOk(s); // 恰好 20 MB：可以（总共也远小于 100 MB）。
    sparse(join(s.jobDir, '交付/大.mp4'), 20 * 1024 * 1024 + 1);
    await expectTooBig(s);
  });

  it('总大小：超过 100 MB 不打开（每个都在单个上限之内）', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    for (let index = 0; index < 5; index += 1) sparse(join(s.jobDir, `交付/块${index}.mp4`), 20 * 1024 * 1024); // 共 100 MB 整，加 index.html 略多于 100 MB
    await expectTooBig(s);
    nodeFs.rmSync(join(s.jobDir, '交付/块4.mp4'));
    await openOk(s); // 去掉一块之后可以。
  });

  it('层数：最深 8 层可以，9 层不打开', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    const eight = Array.from({ length: 8 }, (_, index) => `d${index}`).join('/');
    nodeFs.mkdirSync(join(s.jobDir, '交付', eight), { recursive: true });
    s.write(`交付/${eight}/deep.txt`, 'x');
    await openOk(s);
    nodeFs.mkdirSync(join(s.jobDir, '交付', eight, 'd8'));
    s.write(`交付/${eight}/d8/deeper.txt`, 'x');
    await expectTooBig(s);
  });

  it('复制到一半写不出来：不打开，已经写出的部分整个删掉，没有留下半份副本', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    s.write('交付/a.js', 'a');
    s.write('交付/b.js', 'b');
    class FailingFs extends SystemFs {
      writes = 0;
      override async writeBytesAtomic(path: string, bytes: Uint8Array, boundary?: { within: string }, mode?: number): Promise<void> {
        this.writes += 1;
        if (this.writes === 3) throw new Error('磁盘写满了');
        await super.writeBytesAtomic(path, bytes, boundary, mode);
      }
    }
    s.ctx.fs = new FailingFs(new MemoryLogger());
    expect(await open(s)).toEqual({ ok: false, error: PREVIEW_COPY_FAILED_TEXT });
    expect(filesUnder(previewRootDir(s.root))).toEqual([]);
  });
});

describe('2.1 预览文件本身是符号链接或硬链接：不打开', () => {
  it('交付里的 index.html 是指向里面、指向外面的符号链接，或是外面文件的硬链接', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    s.write('交付/真.html', HTML);
    nodeFs.symlinkSync(join(s.jobDir, '交付/真.html'), join(s.jobDir, '交付/内链.html'));
    nodeFs.symlinkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/外链.html'));
    nodeFs.linkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/硬链.html'));
    for (const preview of ['交付/内链.html', '交付/外链.html', '交付/硬链.html']) {
      expect(await open(s, preview), preview).toEqual({ ok: false, error: PREVIEW_FILE_GONE_TEXT });
    }
    expect(filesUnder(previewRootDir(s.root))).toEqual([]);
  });
});

describe('2.3 清理', () => {
  it('第二次打开同一件事的预览后，第一次的副本已删除；别的事的副本不受影响', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    const first = await openOk(s);
    // 别的事的副本（手工放一份）。
    const other = join(previewRootDir(s.root), 'job_0000000010', 'abc');
    nodeFs.mkdirSync(other, { recursive: true });
    nodeFs.writeFileSync(join(other, 'index.html'), 'other');
    // 让随机串换一个：推进随机源。
    s.ctx.rng.next();
    const second = await openOk(s);
    expect(nodeFs.existsSync(first)).toBe(false);
    expect(nodeFs.existsSync(second)).toBe(true);
    expect(nodeFs.existsSync(join(other, 'index.html'))).toBe(true);
    // 这件事的目录下只剩一份副本。
    expect(nodeFs.readdirSync(join(previewRootDir(s.root), 'job_0000000001')).length).toBe(1);
  });

  it('中心启动时清空整个预览目录（目录本身保留）', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    await openOk(s);
    nodeFs.mkdirSync(join(previewRootDir(s.root), 'job_0000000010/x'), { recursive: true });
    nodeFs.writeFileSync(join(previewRootDir(s.root), 'job_0000000010/x/a.html'), 'x');
    nodeFs.writeFileSync(join(previewRootDir(s.root), '散落的文件.txt'), 'x');
    await clearPreviewRoot(s.ctx);
    expect(nodeFs.readdirSync(previewRootDir(s.root))).toEqual([]);
  });

  it('预览目录不存在时清理不报错', async () => {
    const s = setup();
    await clearPreviewRoot(s.ctx);
    expect(nodeFs.existsSync(previewRootDir(s.root))).toBe(false);
  });

  it('中心启动（hub.start）之后预览目录为空：启动前留下的副本被清掉', async () => {
    // 内存文件系统的启动流程：启动前在预览目录里放两份旧副本，启动后目录是空的。
    const fix = await teamHub({
      before: async ctx => {
        const root = previewRootDir(ctx.settings.rootDir);
        await ctx.fs.writeTextAtomic(`${root}/job_0000000001/abc/index.html`, '旧副本');
        await ctx.fs.writeTextAtomic(`${root}/job_0000000002/def/a.js`, '旧副本');
      },
    });
    expect(await fix.ctx.fs.list(previewRootDir(fix.ctx.settings.rootDir))).toEqual([]);
  });

  it('删除不越出预览目录：副本里有指向外面的符号链接时，外面的文件和目录还在', async () => {
    const s = setup();
    s.write('交付/index.html', HTML);
    nodeFs.mkdirSync(join(s.outside, 'keep'));
    nodeFs.writeFileSync(join(s.outside, 'keep/a.txt'), '不能删');
    nodeFs.writeFileSync(join(s.outside, 'b.txt'), '不能删');
    const target = await openOk(s);
    const copyDir = target.slice(0, target.length - '/index.html'.length);
    // 副本里放指向外面的符号链接（模拟被人动过手脚的副本目录）。
    nodeFs.symlinkSync(s.outside, join(copyDir, '外目录'));
    nodeFs.symlinkSync(join(s.outside, 'b.txt'), join(copyDir, '外文件'));
    await removeJobPreviews(s.ctx, 'job_0000000001');
    expect(nodeFs.existsSync(copyDir)).toBe(false);
    expect(nodeFs.readFileSync(join(s.outside, 'keep/a.txt'), 'utf8')).toBe('不能删');
    expect(nodeFs.readFileSync(join(s.outside, 'b.txt'), 'utf8')).toBe('不能删');
  });

  it('预览目录里这件事的位置本身是指向外面的符号链接：只删链接，外面的内容还在；启动清理同样', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'b.txt'), '不能删');
    nodeFs.mkdirSync(previewRootDir(s.root), { recursive: true });
    nodeFs.symlinkSync(s.outside, join(previewRootDir(s.root), 'job_0000000001'));
    nodeFs.symlinkSync(s.outside, join(previewRootDir(s.root), 'job_0000000002'));
    await removeJobPreviews(s.ctx, 'job_0000000001');
    expect(nodeFs.existsSync(join(previewRootDir(s.root), 'job_0000000001'))).toBe(false);
    await clearPreviewRoot(s.ctx);
    expect(nodeFs.readdirSync(previewRootDir(s.root))).toEqual([]);
    expect(nodeFs.readFileSync(join(s.outside, 'b.txt'), 'utf8')).toBe('不能删');
  });

  it('预览目录本身是指向外面的符号链接：什么都不删（拒绝越出）', async () => {
    const s = setup();
    nodeFs.mkdirSync(join(s.outside, 'job_0000000001'));
    nodeFs.writeFileSync(join(s.outside, 'job_0000000001/b.txt'), '不能删');
    nodeFs.mkdirSync(join(s.root, '.hub'), { recursive: true });
    nodeFs.symlinkSync(s.outside, previewRootDir(s.root));
    await removeJobPreviews(s.ctx, 'job_0000000001');
    await clearPreviewRoot(s.ctx);
    expect(nodeFs.readFileSync(join(s.outside, 'job_0000000001/b.txt'), 'utf8')).toBe('不能删');
  });
});

describe('2.4 地址：不允许的字符各被拒，正例可以', () => {
  it('$ ` ; | & ( ) < > \' " \\ * ! 各一条被拒', () => {
    for (const char of ['$', '`', ';', '|', '&', '(', ')', '<', '>', "'", '"', '\\', '*', '!']) {
      expect(localPreviewUrl(`http://localhost:3000/a${char}b`), char).toBeNull();
      expect(localPreviewUrl(`http://localhost:3000/?q=${char}`), char).toBeNull();
    }
  });

  it('正例：https://localhost:3000/、http://[::1]:5173/a/b?x=1', () => {
    expect(localPreviewUrl('https://localhost:3000/')).toBe('https://localhost:3000/');
    expect(localPreviewUrl('http://[::1]:5173/a/b?x=1')).toBe('http://[::1]:5173/a/b?x=1');
  });

  it('交回时被拒的文字说清不能含哪些字符；打开时同样被拒', async () => {
    const s = setup();
    s.submit({ preview: null });
    const message = await previewError(s.ctx, s.job, 'http://localhost:3000/?a=1&b=2');
    expect(message).toContain('地址里也不能含这些字符');
    for (const char of ['$', '`', ';', '|', '&', '(', ')', '<', '>', "'", '"', '\\', '*', '!']) expect(message, char).toContain(char);
    expect(await open(s, 'http://localhost:3000/?a=1&b=2')).toEqual({ ok: false, error: '预览地址不是本机地址，不能打开' });
  });
});

describe('3 交回时的检查与打开时一致；系统错误不外泄', () => {
  /** 同一组输入分别喂给交回时的检查和打开时的检查，结论必须一致。 */
  async function bothAgree(s: Env, preview: string, expectOk: boolean): Promise<{ submitText: string | null; openText: string | null }> {
    const submitText = await previewError(s.ctx, s.job, preview);
    const opened = await open(s, preview);
    expect(submitText === null, `${preview} 交回时`).toBe(expectOk);
    expect(opened.ok, `${preview} 打开时`).toBe(expectOk);
    return { submitText, openText: opened.ok ? null : opened.error };
  }

  it('正常文件、硬链接、超大文件、超长路径、符号链接', async () => {
    // 每种输入各搭一个环境：超大文件放在交付里会让整份副本超限，不能与正常文件同处一个环境。
    const fresh = (): Env => { const env = setup(); env.write('交付/index.html', HTML); return env; };
    await bothAgree(fresh(), '交付/index.html', true);
    const hard = fresh();
    nodeFs.writeFileSync(join(hard.outside, 'x.html'), '<html>外面</html>');
    nodeFs.linkSync(join(hard.outside, 'x.html'), join(hard.jobDir, '交付/硬链.html'));
    await bothAgree(hard, '交付/硬链.html', false);
    const big = fresh();
    nodeFs.writeFileSync(join(big.jobDir, '交付/超大.html'), '');
    nodeFs.truncateSync(join(big.jobDir, '交付/超大.html'), 20 * 1024 * 1024 + 1);
    await bothAgree(big, '交付/超大.html', false);
    const link = fresh();
    nodeFs.symlinkSync(join(link.jobDir, '交付/index.html'), join(link.jobDir, '交付/链.html'));
    await bothAgree(link, '交付/链.html', false);
    const s = fresh();
    const long = await bothAgree(s, `交付/${'长'.repeat(300)}.html`, false);
    // 超长路径：返回的文字里没有绝对路径、没有系统错误原文。
    for (const text of [long.submitText ?? '', long.openText ?? '']) {
      expect(text).not.toContain(s.base);
      expect(text).not.toContain('ENAMETOOLONG');
      expect(text).not.toContain('/private');
    }
    expect(long.openText).toBe(PREVIEW_FILE_GONE_TEXT);
  });

  it('检查函数本身（证据、产出物、图片共用的 checkTopicFile）遇到超长路径：不抛出，返回「不在主题文件夹里」，没有绝对路径', async () => {
    const s = setup();
    const long = `交付/${'长'.repeat(300)}.html`;
    for (const result of [await checkTopicFile(s.ctx, s.job, long), await checkTopicFile(s.ctx, s.job, `证据/${'a'.repeat(400)}.png`)]) {
      expect(result.status).toBe('outside');
      expect(result.detail).toContain('不在主题文件夹里');
      expect(result.detail).not.toContain(s.base);
    }
  });

  it('交回时硬链接和超大文件的说明各自说清原因', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    nodeFs.linkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/硬链.html'));
    expect(await previewError(s.ctx, s.job, '交付/硬链.html')).toContain('不在主题文件夹里');
    nodeFs.writeFileSync(join(s.jobDir, '交付/超大.html'), '');
    nodeFs.truncateSync(join(s.jobDir, '交付/超大.html'), 20 * 1024 * 1024 + 1);
    expect(await previewError(s.ctx, s.job, '交付/超大.html')).toContain('超过 20 MB');
  });
});

