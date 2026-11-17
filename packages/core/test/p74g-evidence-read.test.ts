/**
 * P74g 的测试：读取证据截图（job/evidence-read.ts 的 readJobEvidence，界面命令，只读）。
 *
 * 重点是安全：这个命令由界面直接触发，读的路径来自员工写的交回记录。每一种「越出主题文件夹」的写法各有一条反例，
 * 并且全程断言不写任何存储、不记审计。用真实文件系统（符号链接、硬链接内存假实现里没有）。
 * 「路径与地址的检查」对照表见 docs/progress/P74g.md。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_GONE_TEXT, readJobEvidence } from '../src/job/evidence-read.js';
import { isInsideByParts } from '../src/job/evidence.js';
import { evidenceFixture } from './p74a-job-fixtures.js';
import { GIF, JPG, PNG, WEBP, registerCleanup, setup, storeSnapshot, type Env } from './p74g-fixtures.js';

registerCleanup();

/** 读第 1 条里的 ev1。 */
async function read(s: Env, patch: Record<string, unknown> = {}) {
  return readJobEvidence(s.ctx, { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', ...patch });
}

/** 把一张证据路径写进交回记录，再读；断言返回的是 EVIDENCE_GONE_TEXT 类错误且没有写任何东西。 */
async function expectRefused(s: Env, path: string, error: string = EVIDENCE_GONE_TEXT): Promise<void> {
  s.submit({ evidence: [evidenceFixture({ id: 'ev1', kind: 'image', path, summary: '截图' })] });
  const before = storeSnapshot(s.ctx);
  expect(await read(s), path).toEqual({ ok: false, error });
  expect(storeSnapshot(s.ctx), path).toBe(before);
}

describe('1 正例', () => {
  it('png、jpg、gif、webp 各返回对应的类型和 data 地址，内容与文件一致；全程不写存储', async () => {
    for (const [name, data, mime] of [['a.png', PNG, 'image/png'], ['b.jpg', JPG, 'image/jpeg'], ['c.gif', GIF, 'image/gif'], ['d.webp', WEBP, 'image/webp'], ['e.jpeg', JPG, 'image/jpeg']] as const) {
      const s = setup();
      s.write(`证据/${name}`, data);
      s.submit({ evidence: [evidenceFixture({ id: 'ev1', kind: 'image', path: `证据/${name}`, summary: '截图' })] });
      const before = storeSnapshot(s.ctx);
      const result = await read(s);
      expect(result, name).toMatchObject({ ok: true, data: { mime } });
      const dataUrl = (result as { data: { dataUrl: string } }).data.dataUrl;
      expect(dataUrl.startsWith(`data:${mime};base64,`), name).toBe(true);
      expect(Buffer.from(dataUrl.split(',')[1]!, 'base64').equals(data), name).toBe(true);
      expect(storeSnapshot(s.ctx), name).toBe(before);
    }
  });
});

describe('2 证据本身不对', () => {
  it('证据不是截图（file、test、link）、没有这个证据、没有这次交回、这次交回不属于这件事：各返回错误', async () => {
    const s = setup();
    s.write('证据/a.png', PNG);
    s.submit({ evidence: [evidenceFixture({ id: 'ev1', kind: 'file', path: '证据/a.png', summary: '文件' }),
      evidenceFixture({ id: 'ev2', kind: 'test', path: null, summary: '测试', check: { status: 'unchecked', detail: '' } })] });
    expect(await read(s)).toEqual({ ok: false, error: '这项证据不是截图' });
    expect(await read(s, { evidenceId: 'ev2' })).toEqual({ ok: false, error: '这项证据不是截图' });
    expect(await read(s, { evidenceId: 'ev9' })).toEqual({ ok: false, error: '找不到这张截图' });
    expect(await read(s, { submissionId: 'jsb_0000000099' })).toEqual({ ok: false, error: '找不到这张截图' });
    // 这次交回属于另一件事：用本件事的 jobId 读它，读不到（跨这件事）。
    s.ctx.store.table('jobSubmissions').put({ ...s.ctx.store.table('jobSubmissions').get('jsb_0000000001')!, id: 'jsb_0000000002', jobId: 'job_0000000002',
      items: [{ ...s.ctx.store.table('jobSubmissions').get('jsb_0000000001')!.items[0]!, evidence: [evidenceFixture({ id: 'ev1', kind: 'image', path: '证据/a.png', summary: '截图' })] },
        s.ctx.store.table('jobSubmissions').get('jsb_0000000001')!.items[1]!] });
    expect(await read(s, { submissionId: 'jsb_0000000002' })).toEqual({ ok: false, error: '找不到这张截图' });
    // 这件事不存在。
    expect(await read(s, { jobId: 'job_0000000002' })).toEqual({ ok: false, error: '找不到这张截图' });
  });

  it('参数不对：缺字段、多字段、编号写法不对，都给中文错误，不抛出', async () => {
    const s = setup();
    for (const raw of [{}, { jobId: 'x', submissionId: 'jsb_0000000001', evidenceId: 'ev1' }, { jobId: 'job_0000000001', submissionId: 'jsb_0000000001' },
      { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', path: '/etc/passwd' }, null, 'abc']) {
      const result = await readJobEvidence(s.ctx, raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      expect((result as { error: string }).error).toMatch(/[一-鿿]/);
    }
  });
});

describe('3 交回之后文件被换掉', () => {
  it('换成文本文件（扩展名仍是 png）：返回「不是有效的图片」', async () => {
    const s = setup();
    s.write('证据/手机.png', PNG);
    s.submit();
    expect((await read(s)).ok).toBe(true);
    s.write('证据/手机.png', '这已经是一段文字了，不是图片');
    expect(await read(s)).toEqual({ ok: false, error: '这个文件不是有效的图片' });
  });

  it('换成超过 5 MB 的文件：返回「超过 5 MB」；刚好 5 MB 仍可读', async () => {
    const s = setup();
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.length)]);
    s.write('证据/手机.png', big);
    s.submit();
    expect(await read(s)).toEqual({ ok: false, error: '这张截图超过 5 MB，这里不显示' });
    s.write('证据/手机.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 - PNG.length)]));
    expect((await read(s)).ok).toBe(true);
  });

  it('文件被删掉、被换成空文件、被换成文件夹：都返回「已不在主题文件夹里」或「不是有效的图片」，不抛出', async () => {
    const s = setup();
    s.submit();
    expect(await read(s)).toEqual({ ok: false, error: EVIDENCE_GONE_TEXT });
    s.write('证据/手机.png', '');
    expect(await read(s)).toEqual({ ok: false, error: '这个文件不是有效的图片' });
    nodeFs.rmSync(join(s.jobDir, '证据/手机.png'));
    nodeFs.mkdirSync(join(s.jobDir, '证据/手机.png'));
    expect(await read(s)).toEqual({ ok: false, error: EVIDENCE_GONE_TEXT });
  });
});

describe('4 越出主题文件夹（每一种各一条）', () => {
  it('上级目录写法：开头的 ..、中间的 ..、先下去再回来、指向同级前缀相同的文件夹（job_10）', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.png'), PNG);
    nodeFs.writeFileSync(join(s.siblingDir, '证据/x.png'), PNG);
    s.write('证据/手机.png', PNG); // 「证据/../证据/手机.png」指向的文件真实存在，拒绝只能是因为「..」这条规则
    for (const path of ['../../../../../outside/x.png', '../job_0000000010/证据/x.png', '证据/../../job_0000000010/证据/x.png', '证据/../证据/手机.png', '..']) {
      await expectRefused(s, path);
    }
  });

  it('绝对路径（指向文件夹之外、指向文件夹之内、系统文件）一律拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.png'), PNG);
    s.write('证据/手机.png', PNG);
    for (const path of [join(s.outside, 'x.png'), join(s.jobDir, '证据/手机.png'), '/etc/hosts', '/']) await expectRefused(s, path);
  });

  it('路径里的空字符、换行、回车、制表符一律拒绝（文件真实存在，拒绝只能是因为这条规则）', async () => {
    const s = setup();
    s.write('证据/手机.png', PNG);
    for (const name of ['证据/手\n机.png', '证据/手\r机.png', '证据/手\t机.png']) s.write(name, PNG);
    for (const path of ['证据/手机.png\u0000.txt', '证据/手机.png\n', '证据/手\n机.png', '证据/手\r机.png', '证据/手\t机.png']) await expectRefused(s, path);
  });

  it('符号链接：指向文件夹之外的文件、指向文件夹之内的文件、符号链接目录，一律拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.png'), PNG);
    s.write('证据/真的.png', PNG);
    nodeFs.symlinkSync(join(s.outside, 'secret.png'), join(s.jobDir, '证据/外链.png'));
    nodeFs.symlinkSync(join(s.jobDir, '证据/真的.png'), join(s.jobDir, '证据/内链.png'));
    nodeFs.symlinkSync(s.outside, join(s.jobDir, '证据/外目录'));
    for (const path of ['证据/外链.png', '证据/内链.png', '证据/外目录/secret.png']) await expectRefused(s, path);
  });

  it('主题文件夹本身被换成指向别处的符号链接：里面的图片也拒绝', async () => {
    const s = setup();
    const elsewhere = join(s.base, 'elsewhere');
    nodeFs.mkdirSync(join(elsewhere, '证据'), { recursive: true });
    nodeFs.writeFileSync(join(elsewhere, '证据/手机.png'), PNG);
    nodeFs.rmSync(s.jobDir, { recursive: true, force: true });
    nodeFs.symlinkSync(elsewhere, s.jobDir);
    await expectRefused(s, '证据/手机.png');
  });

  it('硬链接：文件夹里的名字其实是文件夹之外那张图的另一个名字，拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.png'), PNG);
    nodeFs.linkSync(join(s.outside, 'secret.png'), join(s.jobDir, '证据/硬链.png'));
    await expectRefused(s, '证据/硬链.png');
  });

  it('中心写的文件（约定、材料）不能当证据，即使记录里写了这样的路径', async () => {
    const s = setup();
    s.write('材料/参考.png', PNG);
    await expectRefused(s, '材料/参考.png');
  });
});

describe('5 逐段比较，不用字符串前缀', () => {
  it('isInsideByParts：job_1 不能把 job_10 里的路径当成自己里面的；本身、上级、相对路径都不算', () => {
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs/job_1/x.png')).toBe(true);
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs/job_10/x.png')).toBe(false);
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs/job_1')).toBe(false);
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs')).toBe(false);
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs/job_1/../job_10/x.png')).toBe(false);
    expect(isInsideByParts('/a/jobs/job_1', '/a/jobs/job_1-copy/x.png')).toBe(false);
    expect(isInsideByParts('/a/jobs/job_1', 'jobs/job_1/x.png')).toBe(false);
    expect(isInsideByParts('/', '/etc/hosts')).toBe(true);
  });
});
