/**
 * P74g 测试的公共环境（不是测试文件）之一：读取证据截图、打开预览两个只读命令用的「真实文件系统」环境。
 *
 * 为什么用真实文件系统（SystemFs，在系统临时目录里搭一个假中心）：符号链接、硬链接、文件被换掉这些越界情形，
 * 内存假实现里没有，测不出来。每条用例自己建、自己删临时目录，不碰真实家目录和任何凭据。
 * 目录结构：root/projects/prj_0000000001/jobs/job_0000000001/{交付,证据,材料}；同级还有 job_0000000010（用来测前缀相同的兄弟文件夹）；
 * outside 是主题文件夹之外的目录。
 */
import { afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryLogger } from '../src/io/testing/memory-logger.js';
import { SystemFs } from '../src/io/system-fs.js';
import type { Evidence, JobSubmission } from '../src/model/job.js';
import { ProjectSchema } from '../src/model/index.js';
import { evidenceFixture, jobFixture, submissionFixture } from './p74a-job-fixtures.js';

const cleanups: string[] = [];
/** 在测试文件里调用一次，注册「每条用例之后删除临时目录」。 */
export function registerCleanup(): void {
  afterEach(() => { for (const dir of cleanups.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true }); });
}

/** 一个最小的真实 PNG（1 x 1 像素）。 */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(16)]);
export const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 1)]);
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 2)]);

/** 搭环境。write 往主题文件夹里写文件（rel 相对主题文件夹，父目录已存在）。 */
export function setup() {
  const base = nodeFs.realpathSync(nodeFs.mkdtempSync(join(os.tmpdir(), 'p74g-')));
  cleanups.push(base);
  const root = join(base, 'hub');
  const project = join(root, 'projects', 'prj_0000000001');
  const jobDir = join(project, 'jobs', 'job_0000000001');
  const siblingDir = join(project, 'jobs', 'job_0000000010');
  const outside = join(base, 'outside');
  for (const dir of [join(jobDir, '交付'), join(jobDir, '证据'), join(jobDir, '材料'), join(siblingDir, '交付'), join(siblingDir, '证据'), outside]) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }
  const ctx = createTestContext({ ownerHome: join(base, 'owner'), fs: new SystemFs(new MemoryLogger()) });
  ctx.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const now = ctx.clock.now();
  ctx.store.table('projects').put(ProjectSchema.parse({ id: 'prj_0000000001', name: '报名页', charter: '', status: 'active', ownerBotId: null,
    memberBotIds: [], sharedDir: `${project}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null }));
  const job = jobFixture();
  ctx.store.table('jobs').put(job);
  const write = (rel: string, data: Buffer | string) => nodeFs.writeFileSync(join(jobDir, rel), data);
  /** 记一次交回：evidence 放在第 1 条里；preview 是交回里写的预览入口。返回这次交回。 */
  const submit = (patch: { evidence?: Evidence[]; preview?: string | null; id?: string; jobId?: string; createdAt?: number } = {}): JobSubmission => {
    const sample = submissionFixture();
    const row = submissionFixture({
      ...(patch.id === undefined ? {} : { id: patch.id }), ...(patch.jobId === undefined ? {} : { jobId: patch.jobId }),
      ...(patch.createdAt === undefined ? {} : { createdAt: patch.createdAt }),
      items: [{ ...sample.items[0]!, evidence: patch.evidence ?? [evidenceFixture({ id: 'ev1', kind: 'image', path: '证据/手机.png', summary: '手机' })] }, sample.items[1]!],
      preview: patch.preview === undefined ? null : patch.preview,
    });
    ctx.store.table('jobSubmissions').put(row);
    return row;
  };
  return { ctx, job, base, root, project, jobDir, siblingDir, outside, write, submit };
}

export type Env = ReturnType<typeof setup>;

/** 整个存储与审计日志的快照（只读命令前后必须相同）。 */
export function storeSnapshot(ctx: Env['ctx']): string {
  return JSON.stringify({
    jobs: ctx.store.table('jobs').list(), submissions: ctx.store.table('jobSubmissions').list(), approvals: ctx.store.table('approvals').list(),
    inbox: ctx.store.table('inbox').list(), notes: ctx.store.table('approvalNotes').list(),
    audit: ctx.store.log('audit').all().length, thread: ctx.store.log('thread').all().length, events: ctx.store.log('jobEvents').all().length,
  });
}
