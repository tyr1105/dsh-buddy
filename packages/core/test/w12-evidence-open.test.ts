/**
 * W12 的测试：卡片上的文件证据交给宿主打开之前的校验（job/evidence-open.ts 的 jobEvidenceOpenTarget，只读）。
 *
 * 路径来自员工写的交回记录，不可信：越出主题文件夹、符号链接、中心写的文件一律拒绝；
 * 「用默认应用打开」只放行文档、表格、图片格式，其余（.command、.app、.sh、.html……）只能「在访达中显示」。
 * 全程断言不写任何存储。用真实文件系统。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_FILE_GONE_TEXT, EVIDENCE_NOT_OPENABLE_TEXT, evidenceOpenable, jobEvidenceOpenTarget, readJobEvidenceText } from '../src/job/evidence-open.js';
import { evidenceFixture } from './p74a-job-fixtures.js';
import { PNG, registerCleanup, setup, storeSnapshot, type Env } from './p74g-fixtures.js';

registerCleanup();

async function target(s: Env, patch: Record<string, unknown> = {}) {
  return jobEvidenceOpenTarget(s.ctx, { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', action: 'open', ...patch });
}

function submitFile(s: Env, path: string, kind: 'file' | 'image' = 'file'): void {
  s.submit({ evidence: [evidenceFixture({ id: 'ev1', kind, path, summary: '文件' })] });
}

describe('1 正例', () => {
  it('交付里的 md：打开和在访达中显示都给出真实绝对路径；全程不写存储', async () => {
    const s = setup();
    s.write('交付/现状梳理与下一步建议.md', '# 报告\n');
    submitFile(s, '交付/现状梳理与下一步建议.md');
    const before = storeSnapshot(s.ctx);
    expect(await target(s)).toEqual({ ok: true, data: { path: join(s.jobDir, '交付/现状梳理与下一步建议.md'), action: 'open' } });
    expect(await target(s, { action: 'reveal' })).toEqual({ ok: true, data: { path: join(s.jobDir, '交付/现状梳理与下一步建议.md'), action: 'reveal' } });
    expect(storeSnapshot(s.ctx)).toBe(before);
  });

  it('截图证据也能打开', async () => {
    const s = setup();
    s.write('证据/手机.png', PNG);
    submitFile(s, '证据/手机.png', 'image');
    expect(await target(s)).toMatchObject({ ok: true, data: { action: 'open' } });
  });
});

describe('2 能运行的文件和网页不直接打开，只能在访达中显示', () => {
  it('.command、.app、.sh、.html、.svg、没有扩展名：打开被拒，显示位置可以', async () => {
    for (const name of ['run.command', 'x.sh', 'page.html', 'pic.svg', 'tool.terminal', 'Makefile', 'a.MD.command']) {
      const s = setup();
      s.write(`交付/${name}`, 'echo hi');
      submitFile(s, `交付/${name}`);
      expect(await target(s), name).toEqual({ ok: false, error: EVIDENCE_NOT_OPENABLE_TEXT });
      expect(await target(s, { action: 'reveal' }), name).toMatchObject({ ok: true, data: { action: 'reveal' } });
    }
  });

  it('扩展名大小写不影响放行名单', () => {
    expect(evidenceOpenable('/a/b/报告.MD')).toBe(true);
    expect(evidenceOpenable('/a/b/表.XLSX')).toBe(true);
    expect(evidenceOpenable('/a/b/x.html')).toBe(false);
    expect(evidenceOpenable('/a/b/md')).toBe(false);
  });
});

describe('3 路径不可信', () => {
  it('越出主题文件夹、绝对路径、上级目录写法：一律拒绝且不写存储', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.md'), 'x');
    for (const path of ['../../../../../outside/x.md', join(s.outside, 'x.md'), '/etc/hosts', '交付/../../job_0000000010/交付/x.md']) {
      submitFile(s, path);
      const before = storeSnapshot(s.ctx);
      expect(await target(s), path).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
      expect(await target(s, { action: 'reveal' }), path).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
      expect(storeSnapshot(s.ctx), path).toBe(before);
    }
  });

  it('符号链接（指向外面或里面）一律拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.md'), 'x');
    s.write('交付/真的.md', 'x');
    nodeFs.symlinkSync(join(s.outside, 'secret.md'), join(s.jobDir, '交付/外链.md'));
    nodeFs.symlinkSync(join(s.jobDir, '交付/真的.md'), join(s.jobDir, '交付/内链.md'));
    for (const path of ['交付/外链.md', '交付/内链.md']) {
      submitFile(s, path);
      expect(await target(s, { action: 'reveal' }), path).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
    }
  });

  it('中心写的文件、被删掉的文件、空文件', async () => {
    const s = setup();
    s.write('材料/参考.md', 'x');
    submitFile(s, '材料/参考.md');
    expect(await target(s)).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
    submitFile(s, '交付/没了.md');
    expect(await target(s)).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
    s.write('交付/空.md', '');
    submitFile(s, '交付/空.md');
    expect(await target(s)).toEqual({ ok: false, error: '这个文件是空的' });
  });
});

describe('4 证据本身不对、参数不对', () => {
  it('不是文件类证据、不存在、交回不属于这件事', async () => {
    const s = setup();
    s.write('交付/a.md', 'x');
    s.submit({ evidence: [evidenceFixture({ id: 'ev1', kind: 'test', path: null, summary: '测试', check: { status: 'unchecked', detail: '' } })] });
    expect(await target(s)).toEqual({ ok: false, error: '这项证据不是文件' });
    expect(await target(s, { evidenceId: 'ev9' })).toEqual({ ok: false, error: '找不到这个文件' });
    expect(await target(s, { submissionId: 'jsb_0000000099' })).toEqual({ ok: false, error: '找不到这个文件' });
    expect(await target(s, { jobId: 'job_0000000002' })).toEqual({ ok: false, error: '找不到这个文件' });
  });

  it('缺字段、多字段（比如直接传 path）、动作不对：中文错误，不抛出', async () => {
    const s = setup();
    for (const raw of [{}, { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1' },
      { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', action: 'run' },
      { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', action: 'open', path: '/etc/passwd' }, null]) {
      const result = await jobEvidenceOpenTarget(s.ctx, raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      expect((result as { error: string }).error).toMatch(/[一-鿿]/);
    }
  });
});


describe('6 在员工页里直接看（readJobEvidenceText）', () => {
  const read = (s: Env, patch: Record<string, unknown> = {}) =>
    readJobEvidenceText(s.ctx, { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', ...patch });

  it('md 按 Markdown、txt/csv 按纯文本读出全文；不写存储', async () => {
    const s = setup();
    s.write('交付/报告.md', '# 报告\n\n第一段');
    submitFile(s, '交付/报告.md');
    const before = storeSnapshot(s.ctx);
    expect(await read(s)).toEqual({ ok: true, data: { text: '# 报告\n\n第一段', format: 'markdown', name: '报告.md' } });
    expect(storeSnapshot(s.ctx)).toBe(before);
    s.write('交付/名单.csv', 'a,b\n1,2');
    submitFile(s, '交付/名单.csv');
    expect(await read(s)).toEqual({ ok: true, data: { text: 'a,b\n1,2', format: 'plain', name: '名单.csv' } });
  });

  it('不是文本格式、不是 UTF-8、超过 2 MB、空文件：各给一句话', async () => {
    const s = setup();
    s.write('交付/a.pdf', '%PDF');
    submitFile(s, '交付/a.pdf');
    expect(await read(s)).toEqual({ ok: false, error: '这种文件不能在这里直接看' });
    s.write('交付/b.md', Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    submitFile(s, '交付/b.md');
    expect(await read(s)).toMatchObject({ ok: false, error: expect.stringContaining('不是 UTF-8') });
    s.write('交付/c.md', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    submitFile(s, '交付/c.md');
    expect(await read(s)).toMatchObject({ ok: false, error: expect.stringContaining('超过 2 MB') });
    s.write('交付/d.md', '');
    submitFile(s, '交付/d.md');
    expect(await read(s)).toEqual({ ok: false, error: '这个文件是空的' });
  });

  it('越界、符号链接、中心写的文件、截图证据、参数里夹带路径：一律拒绝', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'secret.md'), 'secret');
    nodeFs.symlinkSync(join(s.outside, 'secret.md'), join(s.jobDir, '交付/外链.md'));
    s.write('材料/参考.md', 'x');
    for (const path of ['../../../../../outside/secret.md', join(s.outside, 'secret.md'), '交付/外链.md', '材料/参考.md']) {
      submitFile(s, path);
      expect(await read(s), path).toEqual({ ok: false, error: EVIDENCE_FILE_GONE_TEXT });
    }
    s.write('证据/a.png', PNG);
    submitFile(s, '证据/a.png', 'image');
    expect(await read(s)).toEqual({ ok: false, error: '这项证据不是文件' });
    expect((await read(s, { path: '/etc/passwd' })).ok).toBe(false);
  });
});
