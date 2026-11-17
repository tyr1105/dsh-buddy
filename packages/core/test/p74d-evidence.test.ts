/**
 * P74d 的测试：证据的机械检查（job/evidence.ts）。
 *
 * 为什么用真实文件系统（SystemFs，在系统临时目录里搭一个假中心）：越界、符号链接、硬链接、文件头这些规则，
 * 内存假实现里没有符号链接，测不出「指向主题文件夹之外的链接」这类真正危险的情形。每条用例自己建、自己删临时目录，
 * 不碰真实家目录和任何凭据。
 *
 * 覆盖：file、image、test、link 四种证据各有正例和反例；其中包括试图越出主题文件夹的反例
 * （上级目录写法、绝对路径、指向文件夹之外的符号链接、符号链接目录、主题文件夹本身被换成链接）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryLogger } from '../src/io/testing/memory-logger.js';
import { SystemFs } from '../src/io/system-fs.js';
import { checkEvidence, checkTopicFile, evidenceFormatError, previewError } from '../src/job/evidence.js';
import { ProjectSchema } from '../src/model/index.js';
import { jobFixture } from './p74a-job-fixtures.js';

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true }); });

/** 一个最小的真实 PNG（1 x 1 像素）。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 2)]);

/** 搭环境：root/projects/prj_0000000001/jobs/job_0000000001/{交付,证据,材料}；outside 是主题文件夹之外的目录。 */
function setup() {
  const base = nodeFs.realpathSync(nodeFs.mkdtempSync(join(os.tmpdir(), 'p74d-ev-')));
  cleanups.push(base);
  const root = join(base, 'hub');
  const project = join(root, 'projects', 'prj_0000000001');
  const jobDir = join(project, 'jobs', 'job_0000000001');
  const outside = join(base, 'outside');
  for (const dir of [join(jobDir, '交付'), join(jobDir, '证据'), join(jobDir, '材料'), outside]) nodeFs.mkdirSync(dir, { recursive: true });
  const ctx = createTestContext({ ownerHome: join(base, 'owner'), fs: new SystemFs(new MemoryLogger()) });
  ctx.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const now = ctx.clock.now();
  ctx.store.table('projects').put(ProjectSchema.parse({ id: 'prj_0000000001', name: '报名页', charter: '', status: 'active', ownerBotId: null,
    memberBotIds: [], sharedDir: `${project}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null }));
  const job = jobFixture();
  const write = (rel: string, data: Buffer | string) => nodeFs.writeFileSync(join(jobDir, rel), data);
  return { ctx, job, base, root, project, jobDir, outside, write };
}

describe('9 file 证据', () => {
  it('正例：主题文件夹里真实存在的非空文件，状态 ok，说明里有大小', async () => {
    const s = setup();
    s.write('交付/报价页.html', '<html>报价</html>');
    const evidence = await checkEvidence(s.ctx, s.job, { kind: 'file', path: '交付/报价页.html', summary: '报价页' });
    expect(evidence.check.status).toBe('ok');
    expect(evidence.check.detail).toMatch(/^文件存在，0\.\d KB$/);
    expect(evidence).toMatchObject({ id: 'ev1', kind: 'file', path: '交付/报价页.html', url: null, command: null });
  });

  it('反例：上级目录写法一律拒绝，包括先下去再回来的写法', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), '主题文件夹之外的内容');
    s.write('交付/a.txt', 'a');
    for (const path of ['../../../../../outside/secret.txt', '证据/../../secret.txt', '交付/../交付/a.txt', '..', '../']) {
      const result = await checkTopicFile(s.ctx, s.job, path);
      expect(result.status, path).toBe('outside');
      expect(result.detail, path).toContain('不在主题文件夹里');
    }
  });

  it('反例：绝对路径一律拒绝，即使它真的指向主题文件夹里的文件', async () => {
    const s = setup();
    s.write('交付/a.txt', 'a');
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), 'x');
    expect((await checkTopicFile(s.ctx, s.job, join(s.outside, 'secret.txt'))).status).toBe('outside');
    expect((await checkTopicFile(s.ctx, s.job, join(s.jobDir, '交付/a.txt'))).status).toBe('outside');
    expect((await checkTopicFile(s.ctx, s.job, '/etc/hosts')).status).toBe('outside');
  });

  it('反例：主题文件夹里的符号链接指向文件夹之外的文件，拒绝，文件夹之外的内容没有被当成证据', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), '主题文件夹之外的内容');
    nodeFs.symlinkSync(join(s.outside, 'secret.txt'), join(s.jobDir, '证据/日志.txt'));
    const result = await checkTopicFile(s.ctx, s.job, '证据/日志.txt');
    expect(result.status).toBe('outside');
    const evidence = await checkEvidence(s.ctx, s.job, { kind: 'file', path: '证据/日志.txt', summary: '日志' });
    expect(evidence.check.status).toBe('outside');
  });

  it('反例：符号链接目录指向文件夹之外，经过它的路径拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.txt'), 'x');
    nodeFs.symlinkSync(s.outside, join(s.jobDir, '交付/外面'));
    expect((await checkTopicFile(s.ctx, s.job, '交付/外面/secret.txt')).status).toBe('outside');
  });

  it('反例：符号链接指向文件夹之内的文件也拒绝（口径同 project-put：路径上不许有链接）', async () => {
    const s = setup();
    s.write('交付/a.txt', 'a');
    nodeFs.symlinkSync(join(s.jobDir, '交付/a.txt'), join(s.jobDir, '证据/b.txt'));
    expect((await checkTopicFile(s.ctx, s.job, '证据/b.txt')).status).toBe('outside');
  });

  it('反例：主题文件夹本身被换成指向别处的符号链接，里面的文件全部拒绝', async () => {
    const s = setup();
    const elsewhere = join(s.base, 'elsewhere');
    nodeFs.mkdirSync(join(elsewhere, '交付'), { recursive: true });
    nodeFs.writeFileSync(join(elsewhere, '交付/a.txt'), 'a');
    nodeFs.rmSync(s.jobDir, { recursive: true, force: true });
    nodeFs.symlinkSync(elsewhere, s.jobDir);
    expect((await checkTopicFile(s.ctx, s.job, '交付/a.txt')).status).toBe('outside');
  });

  it('反例：不存在、空文件、文件夹，各报对应状态', async () => {
    const s = setup();
    s.write('交付/空.txt', '');
    nodeFs.mkdirSync(join(s.jobDir, '交付/子目录'));
    expect(await checkTopicFile(s.ctx, s.job, '交付/没有.txt')).toMatchObject({ status: 'missing', detail: '找不到 交付/没有.txt' });
    expect(await checkTopicFile(s.ctx, s.job, '交付/空.txt')).toMatchObject({ status: 'empty', detail: '交付/空.txt 是空文件' });
    expect(await checkTopicFile(s.ctx, s.job, '交付/子目录')).toMatchObject({ status: 'missing', detail: '交付/子目录 不是普通文件' });
  });

  it('路径里的控制字符不会伪装成换行出现在说明里', async () => {
    const s = setup();
    const result = await checkTopicFile(s.ctx, s.job, '交付/没有\n核对通过.txt');
    expect(result.detail).not.toContain('\n');
  });
});

describe('10 image 证据', () => {
  it('正例：png、jpg、jpeg、gif、webp 的文件头与扩展名一致，状态 ok', async () => {
    const s = setup();
    s.write('证据/a.png', PNG);
    s.write('证据/b.jpg', JPG);
    s.write('证据/c.JPEG', JPG);
    s.write('证据/d.gif', GIF);
    s.write('证据/e.webp', WEBP);
    for (const name of ['a.png', 'b.jpg', 'c.JPEG', 'd.gif', 'e.webp']) {
      const evidence = await checkEvidence(s.ctx, s.job, { kind: 'image', path: `证据/${name}`, summary: '手机 390 宽' });
      expect(evidence.check.status, name).toBe('ok');
      expect(evidence.check.detail, name).toMatch(/^图片，\d+\.\d KB$/);
    }
  });

  it('反例：扩展名是 png 而内容是文本（伪装），以及扩展名与文件头对不上', async () => {
    const s = setup();
    s.write('证据/假的.png', '这其实是一段文字，不是图片');
    s.write('证据/错位.png', JPG);
    expect(await checkTopicFile(s.ctx, s.job, '证据/假的.png')).toMatchObject({ status: 'ok' }); // 作为文件它是存在的
    const fake = await checkEvidence(s.ctx, s.job, { kind: 'image', path: '证据/假的.png', summary: '截图' });
    expect(fake.check).toEqual({ status: 'not_image', detail: '证据/假的.png 不是图片' });
    expect((await checkEvidence(s.ctx, s.job, { kind: 'image', path: '证据/错位.png', summary: '截图' })).check.status).toBe('not_image');
  });

  it('反例：扩展名不在名单里（bmp、svg、没有扩展名）被拒，即使内容是真图片', async () => {
    const s = setup();
    s.write('证据/a.bmp', PNG);
    s.write('证据/b.svg', '<svg/>');
    s.write('证据/c', PNG);
    for (const name of ['a.bmp', 'b.svg', 'c']) {
      expect((await checkEvidence(s.ctx, s.job, { kind: 'image', path: `证据/${name}`, summary: '截图' })).check.status, name).toBe('not_image');
    }
  });

  it('反例：超过 5 MB 被拒；恰好 5 MB 通过', async () => {
    const s = setup();
    const header = PNG.subarray(0, 16);
    s.write('证据/大.png', Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024 + 1 - header.length)]));
    s.write('证据/刚好.png', Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024 - header.length)]));
    expect((await checkEvidence(s.ctx, s.job, { kind: 'image', path: '证据/大.png', summary: '截图' })).check)
      .toEqual({ status: 'too_large', detail: '证据/大.png 超过 5 MB' });
    expect((await checkEvidence(s.ctx, s.job, { kind: 'image', path: '证据/刚好.png', summary: '截图' })).check.status).toBe('ok');
  });

  it('反例：图片同样不能越界：上级目录写法、符号链接图片、符号链接目录，都是 outside；空图片是 empty；不存在是 missing', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.png'), PNG);
    nodeFs.symlinkSync(join(s.outside, 'x.png'), join(s.jobDir, '证据/链接.png'));
    nodeFs.symlinkSync(s.outside, join(s.jobDir, '证据/目录'));
    s.write('证据/空.png', '');
    const status = async (path: string) => (await checkEvidence(s.ctx, s.job, { kind: 'image', path, summary: '截图' })).check.status;
    expect(await status('../../../../../outside/x.png')).toBe('outside');
    expect(await status('证据/链接.png')).toBe('outside');
    expect(await status('证据/目录/x.png')).toBe('outside');
    expect(await status('证据/空.png')).toBe('empty');
    expect(await status('证据/没有.png')).toBe('missing');
  });

  it('反例：硬链接到文件夹之外的图片被拒（按句柄读取时发现）', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.png'), PNG);
    nodeFs.linkSync(join(s.outside, 'x.png'), join(s.jobDir, '证据/硬链接.png'));
    expect((await checkEvidence(s.ctx, s.job, { kind: 'image', path: '证据/硬链接.png', summary: '截图' })).check.status).toBe('outside');
  });
});

describe('11 test、link 证据与格式', () => {
  it('test：只查格式，状态 unchecked，说明里写明中心不执行命令；命令原样记下不执行', async () => {
    const s = setup();
    const evidence = await checkEvidence(s.ctx, s.job, { kind: 'test', summary: '依次提交 81 条，第 81 条显示名额已满', command: 'pnpm test signup' });
    expect(evidence.check).toEqual({ status: 'unchecked', detail: '中心不执行命令，由核对人复跑' });
    expect(evidence).toMatchObject({ path: null, url: null, command: 'pnpm test signup' });
  });

  it('test 带 path 或 url 被拒', async () => {
    const s = setup();
    expect(evidenceFormatError({ kind: 'test', path: '证据/x.log', summary: '测试' })).toContain('test 类型的证据不能写 path 或 url');
    expect(evidenceFormatError({ kind: 'test', url: 'https://example.com', summary: '测试' })).toContain('test 类型的证据不能写 path 或 url');
    await expect(checkEvidence(s.ctx, s.job, { kind: 'test', path: '证据/x.log', summary: '测试' })).rejects.toThrow('不能写 path 或 url');
  });

  it('link：http 和 https 通过，状态 unchecked，说明里写明中心不打开链接', async () => {
    const s = setup();
    for (const url of ['https://example.com/页面?a=1', 'http://localhost:5173/', 'HTTP://Example.com/x']) {
      const evidence = await checkEvidence(s.ctx, s.job, { kind: 'link', url, summary: '线上页面' });
      expect(evidence.check, url).toEqual({ status: 'unchecked', detail: '中心不打开链接，由核对人查看' });
    }
  });

  it('link：ftp、file、javascript、没有主机、带用户名密码、含空白的网址被拒', async () => {
    const s = setup();
    for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'http://', 'http:example.com', 'https://user:pw@example.com/', 'https://exa mple.com', 'example.com']) {
      expect(evidenceFormatError({ kind: 'link', url, summary: '页面' }), url).toContain('url：只接受 http:// 或 https://');
      await expect(checkEvidence(s.ctx, s.job, { kind: 'link', url, summary: '页面' }), url).rejects.toThrow('http');
    }
  });

  it('kind 与 path、url、command 的搭配：file、image 必须 path 不能 url；link 必须 url 不能 path；command 只给 test', () => {
    expect(evidenceFormatError({ kind: 'file', summary: 's' })).toContain('必须写 path');
    expect(evidenceFormatError({ kind: 'file', path: 'a.txt', url: 'https://a.com', summary: 's' })).toContain('不能写 url');
    expect(evidenceFormatError({ kind: 'image', summary: 's' })).toContain('必须写 path');
    expect(evidenceFormatError({ kind: 'file', path: 'a.txt', command: 'ls', summary: 's' })).toContain('command 只给 test');
    expect(evidenceFormatError({ kind: 'link', summary: 's' })).toContain('必须写 url');
    expect(evidenceFormatError({ kind: 'link', url: 'https://a.com', path: 'a.txt', summary: 's' })).toContain('不能写 path');
    expect(evidenceFormatError({ kind: 'file', path: '交付/a.txt', summary: 's' })).toBeNull();
    expect(evidenceFormatError({ kind: 'test', summary: 's', command: 'ls' })).toBeNull();
  });
});

describe('8 预览入口', () => {
  it('正例：主题文件夹里已存在的 html、htm，和 http://localhost、http://127.0.0.1 带端口路径的地址', async () => {
    const s = setup();
    s.write('交付/index.html', '<html></html>');
    s.write('交付/old.HTM', '<html></html>');
    for (const preview of ['交付/index.html', '交付/old.HTM', 'http://localhost:5173/', 'http://127.0.0.1:3000/a/b?x=1', 'http://localhost']) {
      expect(await previewError(s.ctx, s.job, preview), preview).toBeNull();
    }
  });

  it('反例：主题文件夹外的 html（上级目录、绝对路径、符号链接）、不存在的 html、不是 html、空 html', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html></html>');
    nodeFs.symlinkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/链接.html'));
    s.write('交付/空.html', '');
    s.write('交付/a.txt', 'a');
    for (const preview of ['../../../../../outside/x.html', join(s.outside, 'x.html'), '交付/链接.html', '交付/没有.html', '交付/空.html', '交付/a.txt']) {
      expect(await previewError(s.ctx, s.job, preview), preview).toContain('preview：');
    }
  });

  it('反例：外网地址、伪装的主机名、带用户名密码、前后空白、别的协议（P74g 起 https 的 localhost 是合法的，原来在这里被拒，预期已改）', async () => {
    const s = setup();
    for (const preview of ['http://example.com', 'https://example.com/a.html', 'http://localhost.evil.com/', 'http://localhost@evil.com/',
      'http://localhost.example.com', 'http://127.0.0.1@example.com', 'http://localhost:80@example.com', ' http://localhost:3000/', 'http://localhost:3000/\n',
      'http://127.0.0.1.evil.com/', 'http://0.0.0.0:3000/', 'ftp://localhost/', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const error = await previewError(s.ctx, s.job, preview);
      expect(error, preview).toContain('preview：');
      expect(error, preview).toContain('本机地址');
    }
    for (const preview of ['https://localhost:3000/', 'http://[::1]:5173/']) expect(await previewError(s.ctx, s.job, preview), preview).toBeNull();
  });
});
