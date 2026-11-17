/**
 * P76q 第 1 条的测试：总管不许自己产出交付物。
 *
 * 正例（会被拦）：
 * - 总管对已经交给林舟的那件事，自己用 write_file 往这件事的文件夹里写交付物（也覆盖 shell 写入）；
 * - 写着 jobs/<jobId>、但编号对不上任何已派出的事；约定里写了发布位置、但这件事还没派给队友。
 * 反例（不受影响）：已经收尾的事的文件夹、写给主人看的说明（自己的文件夹、项目文件夹根部）、
 * 约定卡（hub_agreement_submit）、不是这件事文件夹的同名前缀目录。
 *
 * P82（第二轮真实模型验证的缺陷 1）：约定还不存在时，总管也不能自己往中心的数据目录之外写文件
 * （真实模型曾申请往主人桌面写一个空的占位文件，理由写「让中心建好文件夹」）。
 * 兜底规则的正例、反例见第 3 节。
 */
import { describe, expect, it } from 'vitest';
import { guardToolCall } from '../src/gate/guard.js';
import { chiefDeliverableMap, chiefDeliverableRefusal, type ChiefDeliverableMap } from '../src/gate/chief-deliverable.js';
import { jobFolderPaths } from '../src/job/files.js';
import { assigned, callTool, jobFix } from './p74c-fixtures.js';

const ACTIVE_REFUSAL = '这类交付应当交给队友';
const DISPATCH_REFUSAL = '这类交付先派给队友，由队友来做';
/** P82 的兜底拒绝话（逐字开头）。 */
const SCOPE_REFUSAL = '交付文件由队友写，先把这件事约定好并派给队友';

/** 取出拒绝原因；被放行时返回空文字（守卫的返回值是可辨识联合，放行分支没有 message）。 */
function messageOf(decision: { allow: true } | { allow: false; message: string }): string {
  return decision.allow ? '' : decision.message;
}

/** 一次真实的派活之后，总管、这件事和它的两个位置。 */
async function dispatched() {
  const fix = await jobFix();
  const { job } = await assigned(fix);
  const { projectDir, jobDir } = jobFolderPaths(fix.ctx, job);
  return { fix, job, projectDir, jobDir };
}

describe('1 总管的判断：哪些位置是交付物', () => {
  it('已派出、还没收尾的事：这件事的文件夹算交付物范围（发布位置由下面的纯判断覆盖）', async () => {
    const { fix, job, projectDir } = await dispatched();
    const map = chiefDeliverableMap(fix.ctx);
    expect(map.active).toHaveLength(1);
    expect(map.active[0]).toMatchObject({ jobId: job.id, executorName: '林舟' });
    expect(map.active[0]!.roots).toHaveLength(1);
    expect(map.active[0]!.roots[0]).toContain(job.folder);
    expect(map.jobRoots).toContain(`${projectDir}/jobs`);
  });

  it('纯判断：已派出的事、没有对应事项的 jobs 文件夹、未收尾的发布位置都拦；已收尾的文件夹不拦', () => {
    const map: ChiefDeliverableMap = {
      active: [{ jobId: 'job_1', title: '冬季网页', executorName: '林舟', executorId: 'b_eng', roots: ['/hub/projects/p/jobs/job_1'] }],
      jobRoots: ['/hub/projects/p/jobs'],
      closedJobIds: ['job_2'],
      launchDirs: [{ root: '/owners/home/Desktop/site', closed: false }, { root: '/owners/home/Desktop/old', closed: true }],
      ownRoots: [],
      centralRoots: ['/hub'],
    };
    // 1 已派出、还没收尾的事：拒绝话里能说出交给谁。
    const active = chiefDeliverableRefusal(['/hub/projects/p/jobs/job_1/交付/index.html'], map);
    expect(active).toContain(ACTIVE_REFUSAL);
    expect(active).toContain('林舟');
    // 2 jobs 下面没有对应的事项：先派活。
    const unknown = chiefDeliverableRefusal(['/hub/projects/p/jobs/job_999/交付/index.html'], map);
    expect(unknown).toContain(DISPATCH_REFUSAL);
    expect(unknown).toContain('hub_job_manage');
    // 3 已经收尾的事的文件夹：写说明、整理不算交付物。
    expect(chiefDeliverableRefusal(['/hub/projects/p/jobs/job_2/说明.md'], map)).toBeNull();
    // 4 约定里的发布位置：这件事还没有派给队友 → 先派活；已收尾的那一处按 P82 的兜底拦（它在中心数据目录之外）。
    expect(chiefDeliverableRefusal(['/owners/home/Desktop/site/index.html'], map)).toContain(DISPATCH_REFUSAL);
    expect(chiefDeliverableRefusal(['/owners/home/Desktop/old/index.html'], map)).toContain(SCOPE_REFUSAL);
    // 5 不是按字符串开头比较：job_10 不借用 job_1 的「交给谁」，而是按「没有对应事项」拦下。
    const neighbor = chiefDeliverableRefusal(['/hub/projects/p/jobs/job_10/交付/index.html'], map);
    expect(neighbor).toContain(DISPATCH_REFUSAL);
    expect(neighbor).not.toContain('林舟');
    // 6 相对路径、含变量的路径不在这里判断。
    expect(chiefDeliverableRefusal(['交付/index.html', '$HOME/site/index.html'], map)).toBeNull();
  });
});

describe('2 总管写交付物：拦下并指向执行者', () => {
  it('正例：往这件事的文件夹里写文件（write_file）被拒，不计越界、不建审批', async () => {
    const { fix, job, jobDir } = await dispatched();
    const before = fix.ctx.store.table('bots').get(fix.chief.id)!.violations;
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${jobDir}/交付/index.html`, content: '<html></html>' });
    expect(decision.allow).toBe(false);
    const message = messageOf(decision);
    expect(message).toContain(ACTIVE_REFUSAL);
    expect(message).toContain('林舟');
    expect(message).toContain('hub_job_manage');
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.violations).toBe(before);
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('ready');
  });

  it('正例：用命令往这件事的文件夹里写，同样被拒', async () => {
    const { fix, jobDir } = await dispatched();
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'exec',
      { command: 'echo x > 交付/index.html', cwd: jobDir });
    expect(decision.allow).toBe(false);
    expect(messageOf(decision)).toContain(ACTIVE_REFUSAL);
  });

  it('正例：jobs 下面写着不存在的编号，同样在审批前拒绝并提示先派活', async () => {
    const { fix, projectDir } = await dispatched();
    const before = fix.ctx.store.table('bots').get(fix.chief.id)!.violations;
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${projectDir}/jobs/job_9999999999/交付/index.html`, content: '<html></html>' });
    expect(decision.allow).toBe(false);
    const message = messageOf(decision);
    expect(message).toContain(DISPATCH_REFUSAL);
    expect(message).toContain('hub_job_manage');
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.violations).toBe(before);
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
  });

  it('反例：已经收尾的事的文件夹不再当作交付物，写说明不触发这条规则', async () => {
    const { fix, job, jobDir } = await dispatched();
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done', acceptedAt: fix.ctx.clock.now() });
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${jobDir}/说明.md`, content: '这次交付的说明' });
    // 能不能写进去由原来的沙箱与权限规则决定；这里确认它不再被「交付物」或「先派活」两条理由拦下。
    const message = messageOf(decision);
    expect(message).not.toContain(ACTIVE_REFUSAL);
    expect(message).not.toContain(DISPATCH_REFUSAL);
  });

  it('反例：总管在自己文件夹里写状态说明，不受影响', async () => {
    const { fix } = await dispatched();
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${fix.chief.homeDir}/work/状态说明.md`, content: '本周进度' });
    expect(decision.allow).toBe(true);
  });

  it('反例：总管在项目文件夹根部写说明文档，不受这条规则影响', async () => {
    const { fix, projectDir } = await dispatched();
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${projectDir}/说明.md`, content: '给主人看的说明' });
    // 是否要审批由原来的沙箱与权限规则决定；这里只确认不是被「交付物」这条规则拦下的。
    expect(messageOf(decision)).not.toContain(ACTIVE_REFUSAL);
    expect(messageOf(decision)).not.toContain(DISPATCH_REFUSAL);
  });

  it('反例：约定卡（hub_agreement_submit）不受影响', async () => {
    const { fix } = await dispatched();
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'hub_agreement_submit', { mode: 'new', title: '另一件事' });
    expect(decision.allow).toBe(true);
  });
});

describe('3 约定之前：中心数据目录之外的写入一律拒绝（P82）', () => {
  it('正例：总管用 write_file 往主人桌面写占位文件，被拒并说明交付文件由队友写', async () => {
    const { fix } = await dispatched();
    const before = fix.ctx.store.table('bots').get(fix.chief.id)!.violations;
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: '/owners/home/Desktop/verify-site-2/index.html', content: '' });
    expect(decision.allow).toBe(false);
    const message = messageOf(decision);
    expect(message).toContain(SCOPE_REFUSAL);
    expect(message).toContain('hub_agreement_submit');
    expect(message).toContain('hub_job_manage');
    // 分工问题，不计越界、不建审批。
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.violations).toBe(before);
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
  });

  it('正例：用命令在中心数据目录之外建文件夹，同样被拒', async () => {
    const { fix } = await dispatched();
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'exec',
      { command: 'mkdir -p /owners/home/Desktop/verify-site-2', cwd: fix.chief.homeDir });
    expect(decision.allow).toBe(false);
    expect(messageOf(decision)).toContain(SCOPE_REFUSAL);
  });

  it('正例：总管的 hub_outbox_submit 也不能往主人桌面写（真实模型走的就是这条）', async () => {
    const { fix } = await dispatched();
    const result = await callTool(fix, fix.chief, 'hub_outbox_submit', {
      kind: 'write_file', why: '用写入方式让中心建好这个文件夹和占位文件',
      payload: { path: '/owners/home/Desktop/verify-site-2/index.html', content: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(SCOPE_REFUSAL);
    // 没有建审批、没有留下出站记录。
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
    expect(fix.ctx.store.table('outbox').count()).toBe(0);
  });

  it('反例：自己的文件夹、共享目录等中心数据目录内的写入照常放行', async () => {
    const { fix, projectDir } = await dispatched();
    for (const path of [`${fix.chief.homeDir}/work/记.txt`, `${fix.ctx.settings.rootDir}/shared/登记.md`, `${projectDir}/说明.md`]) {
      const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file', { path, content: '说明' });
      expect(messageOf(decision), path).not.toContain(SCOPE_REFUSAL);
    }
  });

  it('反例：这件事派给了总管自己（旧数据或手工改库）：这件事的文件夹照常放行', async () => {
    const { fix, job, jobDir } = await dispatched();
    fix.ctx.store.table('jobs').patch(job.id, { executorId: fix.chief.id });
    const decision = await guardToolCall(fix.ctx, fix.chief.sessionId!, 'write_file',
      { path: `${jobDir}/交付/index.html`, content: '<html></html>' });
    const message = messageOf(decision);
    expect(message).not.toContain(ACTIVE_REFUSAL);
    expect(message).not.toContain(SCOPE_REFUSAL);
  });
});
