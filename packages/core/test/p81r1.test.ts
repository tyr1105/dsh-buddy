/**
 * P81r1 的测试：安全审查 S2、S3、S6、S7、S8 的修复。
 *
 * 覆盖：
 * 1 提交约定时查磁盘（S3）：上一级不存在、读不到都拒绝，原因逐字；有文件时记下 localDirHasFiles（S2 第 3.3 节）；
 * 2 约定卡：有文件那句、原来的位置那一行（改了位置时才出现）；
 * 3 审批与约定的对应关系改用审批旁表的 launchLocalDir（S6）：相等才放开、改了不放开、旧存档不报错、
 *   带 replace 时显示与绑定一致、同位置复用旧审批；
 * 4 主目录是符号链接时，避开名单补上真实路径的写法（S7）；
 * 5 规则生成时真实路径不一致抛可识别的错误（S8），出站流程用固定原因、不带完整路径。
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { agreementCardView } from '../src/api/agreement-views.js';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { SandboxRootChanged } from '../src/io/interfaces.js';
import { sandboxProfile } from '../src/io/system-sandbox.js';
import { theJob, threadOf, type JobFix } from './p74f-fixtures.js';
import { jobFix } from './p74b-fixtures.js';
import { commitAndEnd, runningJob } from './p74c-fixtures.js';
import { engineerSubmits, executorInfo, putStandardFiles, reviewerInfo, reviewerThoughtRecently } from './p74d-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { bot, callTool, lastPacket, nextPacket } from './p74f-fixtures.js';
import { newAgreementArgs, ownerSays } from './p72b-fixtures.js';
import { launchFailedText } from '../src/job/launch-result.js';
import { checkLocalDir, localDirEnvOf } from '../src/project/local-dir.js';

const HOME = '/Users/owner';
const DIR = `${HOME}/Desktop/上新页面`;
const HOW = '复制到桌面上的上新页面文件夹';
const OK = { code: 0, stdout: '已复刻', stderr: '', timedOut: false };
const CHANGED = '约定的发布位置现在指向别处，没有运行发布命令。';

/** 提交一份带发布位置的约定（新建）；调用方先按需要建好上一级文件夹。 */
async function draft(launch: Record<string, unknown>, prepare?: (fix: JobFix) => Promise<void>) {
  const fix = await jobFix([], {}, { ownerHome: HOME });
  if (prepare !== undefined) await prepare(fix);
  await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
  const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ launch }));
  return { fix, result };
}
const launchOfFirst = (fix: JobFix) => fix.ctx.store.table('agreements').list()[0]!.versions[0]!.content.launch;

/** 走完对齐、执行、核对、验收，停在发布准备（与 p81-launch-local.test.ts 的 accepted 同一做法）。 */
async function accepted(launch: Record<string, unknown>): Promise<{ fix: JobFix; agreementId: string }> {
  const fix = await jobFix([], {}, { ownerHome: HOME });
  await fix.ctx.fs.mkdirp(`${HOME}/Desktop`);
  const { agreementId } = await runningJob(fix, { deliveryItems: [1], launch });
  reviewerThoughtRecently(fix);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
  expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
  const job = theJob(fix);
  expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
  return { fix, agreementId };
}
const argsFor = (fix: JobFix, dir = DIR) => ({ kind: 'run_command', why: '按约定发布', payload: { cmd: 'bash',
  args: ['-c', `mkdir -p ${dir} && cp work/index.html ${dir}/index.html`], cwd: bot(fix, fix.engineer.id).homeDir } });
/** 提交一条发布命令（必须成功）；返回审批单，结束回合。 */
async function submitPublish(fix: JobFix, dir = DIR, extra: Record<string, unknown> = {}) {
  await nextPacket(fix, fix.engineer.id);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...argsFor(fix, dir), ...extra });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const approval = fix.ctx.store.table('approvals').list().at(-1)!;
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批' });
  return approval;
}
const runApproved = async (fix: JobFix, approvalId: string, args: string[], reply = OK): Promise<void> => {
  fix.ctx.exec.set('bash', args, reply);
  expect(await fix.hub.api.decideApproval(approvalId, true)).toMatchObject({ ok: true });
  await executeReadyOutbox(fix.ctx);
};
const execCalls = (fix: JobFix) => (fix.ctx.exec as unknown as { calls: unknown[] }).calls;

describe('1 提交时查磁盘（S3）与「已有文件」标记（S2 第 3.3 节）', () => {
  it('上一级文件夹不存在：整份拒绝，原因逐字，没有建约定', async () => {
    const { fix, result } = await draft({ how: HOW, localDir: '~/Desktop/新页面' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('launch.localDir 不能用：上一级文件夹不存在，请换一个已经在的位置，或和主人商量，不要自己去建');
    expect(fix.ctx.store.table('agreements').list()).toHaveLength(0);
  });
  it('读不到上一级文件夹（权限这类错误）：同样拒绝，原因逐字', async () => {
    const { result } = await draft({ how: HOW, localDir: '~/Desktop/新页面' }, async fix => {
      await fix.ctx.fs.mkdirp(`${HOME}/Desktop`);
      const original = fix.ctx.fs.stat.bind(fix.ctx.fs);
      fix.ctx.fs.stat = async path => {
        if (path === `${HOME}/Desktop`) throw Object.assign(new Error('权限不足'), { code: 'EACCES' });
        return original(path);
      };
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('launch.localDir 不能用：读不到上一级文件夹，无法核对这个位置');
  });
  it('发布位置已存在并有文件：记下 localDirHasFiles', async () => {
    const { result, fix } = await draft({ how: HOW, localDir: '~/Desktop/工作' }, async fix => {
      await fix.ctx.fs.writeTextAtomic(`${HOME}/Desktop/工作/旧文件.txt`, '旧内容');
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(launchOfFirst(fix)).toMatchObject({ localDir: `${HOME}/Desktop/工作`, localDirHasFiles: true });
  });
  it('发布位置已存在但是空文件夹、或还不存在：不记这个标记（行为与以前一样）', async () => {
    const empty = await draft({ how: HOW, localDir: '~/Desktop/空文件夹' }, fix => fix.ctx.fs.mkdirp(`${HOME}/Desktop/空文件夹`));
    expect(empty.result).toMatchObject({ ok: true });
    expect(launchOfFirst(empty.fix)).not.toHaveProperty('localDirHasFiles');
    const missing = await draft({ how: HOW, localDir: '~/Desktop/还没建' }, fix => fix.ctx.fs.mkdirp(`${HOME}/Desktop`));
    expect(missing.result).toMatchObject({ ok: true });
    expect(launchOfFirst(missing.fix)).not.toHaveProperty('localDirHasFiles');
  });
  it('读不到发布位置（列目录报错）：按「有文件」处理', async () => {
    const { result, fix } = await draft({ how: HOW, localDir: '~/Desktop/读不到' }, async fix => {
      await fix.ctx.fs.mkdirp(`${HOME}/Desktop/读不到`);
      const original = fix.ctx.fs.list.bind(fix.ctx.fs);
      fix.ctx.fs.list = async path => {
        if (path === `${HOME}/Desktop/读不到`) throw Object.assign(new Error('权限不足'), { code: 'EACCES' });
        return original(path);
      };
    });
    expect(result).toMatchObject({ ok: true });
    expect(launchOfFirst(fix)).toMatchObject({ localDirHasFiles: true });
  });
});

describe('2 约定卡上的两行（S2 第 3.3 节）', () => {
  it('有 localDirHasFiles 时多一句「已有文件夹，发布命令可以修改和删除其中的文件」；没有时为原来的句子', async () => {
    const marked = await draft({ how: HOW, localDir: '~/Desktop/工作' }, fix => fix.ctx.fs.writeTextAtomic(`${HOME}/Desktop/工作/a.txt`, 'x'));
    const agreement = marked.fix.ctx.store.table('agreements').list()[0]!;
    const view = agreementCardView(marked.fix.ctx, agreement, agreement.versions[0]!);
    expect(view.localDirLine).toBe('发布到本机文件夹：~/Desktop/工作（已有文件夹，发布命令可以修改和删除其中的文件）');
    const plain = await draft({ how: HOW, localDir: '~/Desktop/还没建' }, fix => fix.ctx.fs.mkdirp(`${HOME}/Desktop`));
    const plainAgreement = plain.fix.ctx.store.table('agreements').list()[0]!;
    expect(agreementCardView(plain.fix.ctx, plainAgreement, plainAgreement.versions[0]!).localDirLine).toBe('发布到本机文件夹：~/Desktop/还没建');
  });
  it('改了发布位置：视图带 localDirPrevLine；没改或上一版没有位置时不带', async () => {
    const { fix } = await draft({ how: HOW, localDir: '~/Desktop/工作' }, fix => fix.ctx.fs.writeTextAtomic(`${HOME}/Desktop/工作/a.txt`, 'x'));
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    const first = agreement.versions[0]!;
    const moved = { ...first, no: 2, state: 'pending' as const, content: { ...first.content, launch: { how: HOW, localDir: `${HOME}/Desktop/换个位置` } } };
    const movedView = agreementCardView(fix.ctx, { ...agreement, versions: [first, moved] }, moved);
    expect(movedView.localDirPrevLine).toBe('原来的位置：~/Desktop/工作');
    const sameView = agreementCardView(fix.ctx, agreement, first);
    expect(sameView).not.toHaveProperty('localDirPrevLine');
    const noPrev = { ...first, no: 2, state: 'pending' as const, content: { ...first.content, launch: { how: HOW, localDir: `${HOME}/Desktop/另一个` } } };
    expect(agreementCardView(fix.ctx, { ...agreement, versions: [{ ...first, content: { ...first.content, launch: { how: HOW } } }, noPrev] }, noPrev))
      .not.toHaveProperty('localDirPrevLine');
  });
});

describe('3 审批与约定改用结构化字段（S6）', () => {
  it('建发布审批时旁表记下绝对路径；运行前比较它，相等才放开', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const approval = await submitPublish(fix);
    expect(fix.ctx.store.table('approvalNotes').get(approval.id)?.launchLocalDir).toBe(DIR);
    await runApproved(fix, approval.id, ['-c', `mkdir -p ${DIR} && cp work/index.html ${DIR}/index.html`]);
    expect(execCalls(fix)).toHaveLength(1);
    expect(theJob(fix).launch.state).toBe('done');
  });
  it('旧存档（旁表没有这个字段）：不放开也不报错，命令照常运行，可写清单里没有发布位置', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const approval = await submitPublish(fix);
    const note = fix.ctx.store.table('approvalNotes').get(approval.id)!;
    fix.ctx.store.table('approvalNotes').put({ id: note.id, cost: note.cost, undo: note.undo, after: note.after, jobId: note.jobId, createdAt: note.createdAt });
    await runApproved(fix, approval.id, ['-c', `mkdir -p ${DIR} && cp work/index.html ${DIR}/index.html`]);
    expect(execCalls(fix)).toHaveLength(1);
    const sandbox = (execCalls(fix)[0] as { opts: { sandbox: { writableRoots: string[]; mayCreateRoots?: string[] } } }).opts.sandbox;
    expect(sandbox.writableRoots).not.toContain(DIR);
    expect(sandbox.mayCreateRoots).toBeUndefined();
  });
  it('带 replace、约定在批准之前改了位置：新卡与旁表记新位置，运行放开的是新位置（显示与绑定一致）', async () => {
    const { fix, agreementId } = await accepted({ how: HOW, localDir: DIR });
    // 先提交一条只写 /tmp 的发布命令（与发布位置无关，改位置之后仍能通过预先核对）。
    const tmpArgs = { kind: 'run_command', why: '按约定发布', payload: { cmd: 'bash', args: ['-c', 'mkdir -p /tmp/p81r1-site'], cwd: bot(fix, fix.engineer.id).homeDir } };
    await nextPacket(fix, fix.engineer.id);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', tmpArgs)).toMatchObject({ ok: true });
    const first = fix.ctx.store.table('approvals').list().at(-1)!;
    // 回合没有结束：约定在这期间换了位置（直接改存储，模拟主人确认过的新版本）。
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(version => version.state === 'locked'
      ? { ...version, content: { ...version.content, launch: { how: HOW, localDir: `${HOME}/Desktop/新位置` } } } : version) });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...tmpArgs, replace: true })).toMatchObject({ ok: true });
    const second = fix.ctx.store.table('approvals').list().at(-1)!;
    expect(second.id).not.toBe(first.id);
    expect(second.riskNote).toContain('、~/Desktop/新位置；可以联网');
    expect(fix.ctx.store.table('approvalNotes').get(second.id)?.launchLocalDir).toBe(`${HOME}/Desktop/新位置`);
    expect(fix.ctx.store.table('approvals').get(first.id)?.status).toBe('expired');
    expect(theJob(fix).launch.approvalId).toBe(second.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已重新提交' });
    await runApproved(fix, second.id, ['-c', 'mkdir -p /tmp/p81r1-site']);
    const sandbox = (execCalls(fix)[0] as { opts: { sandbox: { writableRoots: string[]; mayCreateRoots?: string[] } } }).opts.sandbox;
    expect(sandbox.writableRoots).toContain(`${HOME}/Desktop/新位置`);
    expect(sandbox.mayCreateRoots).toEqual([`${HOME}/Desktop/新位置`]);
  });
  it('位置没变：同一内容再次申请复用旧审批，不新建、不作废', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    await nextPacket(fix, fix.engineer.id);
    const args = { kind: 'run_command', why: '同一内容再申请一次', payload: { cmd: 'bash', args: ['-c', 'true'], cwd: bot(fix, fix.engineer.id).homeDir } };
    const { prepareApproval } = await import('../src/gate/approvals.js');
    const first = prepareApproval(fix.ctx, fix.engineer.id, 'hub_outbox_execute', args, 'C', '第一次');
    const again = prepareApproval(fix.ctx, fix.engineer.id, 'hub_outbox_execute', args, 'C', '第二次');
    expect(again.approval.id).toBe(first.approval.id);
    expect(fix.ctx.store.table('approvals').list()).toHaveLength(1);
    expect(fix.ctx.store.table('approvals').list()[0]!.voided).not.toBe(true);
  });
  it('运行前发现位置不一致时用固定原因，结果里不带完整路径', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const approval = await submitPublish(fix);
    fix.ctx.exec.set('bash', ['-c', `mkdir -p ${DIR} && cp work/index.html ${DIR}/index.html`], new SandboxRootChanged(DIR));
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    const row = fix.ctx.store.table('outbox').list()[0]!;
    expect(row).toMatchObject({ status: 'failed', ownerFailureReason: CHANGED, result: CHANGED });
    expect(row.result).not.toContain(DIR);
    expect(launchFailedText('会员定价页', { ownerFailureReason: CHANGED, result: CHANGED })).toContain(CHANGED);
    expect(threadOf(fix.ctx, fix.chief.id).some(message => message.text.includes(CHANGED))).toBe(true);
  });
});

describe('4 主目录是符号链接（S7）', () => {
  it('避开名单里以主目录开头的各项补上真实主目录的写法，按段比较撞得上', async () => {
    const fix = await jobFix([], {}, { ownerHome: HOME });
    const botRow = fix.ctx.store.table('bots').list()[0]!;
    fix.ctx.store.table('bots').patch(botRow.id, { homeDir: `${HOME}/Documents/中心/bots/b_x` });
    const realHome = '/Volumes/数据/owner';
    const env = localDirEnvOf(fix.ctx, realHome);
    expect(env.protectedRoots).toContain(`${realHome}/Documents/中心/bots/b_x`);
    expect(checkLocalDir(`${realHome}/Documents/中心/bots/b_x/work`, env)).toMatchObject({ ok: false, reason: '在中心的数据目录、员工的文件夹、共享文件夹或 DSH 的数据目录之内，或者是它们的上级目录' });
    // 反例：不在避开名单里的同级路径照常通过。
    expect(checkLocalDir(`${realHome}/Documents/别处/work`, env)).toMatchObject({ ok: true });
  });
});

describe('5 规则生成时真实路径不一致（S8）', () => {
  it('抛 SandboxRootChanged；message 里没有完整路径，完整路径只在 detail 里', async () => {
    const base = await mkdtemp('/private/tmp/p81r1-s8-');
    const created: string[] = [base];
    try {
      const real = `${base}/real`;
      const link = `${base}/link`;
      await mkdir(real, { recursive: true });
      await symlink(real, link);
      const root = `${link}/site`;
      const failure = await sandboxProfile({ writableRoots: [root], mayCreateRoots: [root] }, 'darwin').catch(error => error);
      expect(failure).toBeInstanceOf(SandboxRootChanged);
      expect((failure as Error).message).toBe('发布位置的真实路径与核对时不一致');
      expect((failure as Error).message).not.toContain(base);
      expect((failure as SandboxRootChanged).detail).toContain(root);
    } finally {
      for (const path of created) await rm(path, { force: true, recursive: true });
    }
  });
});
