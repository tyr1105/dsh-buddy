/**
 * P81 第 2、3、4 节的测试：发布到主人指定的本机文件夹（整条链、不放开的情形、运行前重新核对）。
 *
 * 走真实路径：总管提交带 localDir 的约定（提交时由中心校验）、主人确认、派活、交付、验收，
 * 执行者按唤醒包提交发布命令（写入 localDir 之下），预先核对通过，审批卡提示句含显示路径，
 * 主人批准，中心运行命令（用假的命令执行接口，检查交给沙箱的可写清单）。
 * 夹具与真实情况一致（总管是自动创建的、听吩咐；执行类员工听吩咐）；推进假时钟每次不超过 10 分钟。
 *
 * 覆盖：
 * 1 整条链：约定卡视图有那一行、唤醒包有发布位置那一行、预先核对（位置之内通过，同级、上级被拒）、
 *   审批卡提示句逐字含显示路径、可写清单里有实际路径、成功的那一句照 P74r18b；
 * 2 不放开的情形：同一件事的普通审批、没有 localDir 的事的发布命令、员工自己的工具；
 * 3 运行前重新核对：换成指向主目录之外、中心数据目录、~/Library 之下的符号链接，命令没有运行，原因逐字；
 *   上级目录是符号链接而解析之后仍合规：照常运行，可写清单里是解析之后的路径；约定在批准之后又改了位置：不运行；
 * 4 提交约定时的拒绝（逐字）：位置不合格、发布方式明显写本机位置却没有填；改位置记为改动；
 * 5 做不了时的那句固定的话（第 4 节）逐字。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { classifyPath } from '../src/gate/paths.js';
import { nativeGateContext } from '../src/gate/gate-context.js';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { LAUNCH_LOCATION_BLOCKER } from '../src/gate/host-writable.js';
import type { FakeExec } from '../src/io/testing/fake-exec.js';
import { lockedVersionOf } from '../src/job/files.js';
import { LocalDirChanged, localDirForRun } from '../src/job/launch-local-dir.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';
import { launchLocationBlockedText } from '../src/job/launch-blocked.js';
import { launchFailedText, launchSucceededText } from '../src/job/launch-result.js';
import { diffContent } from '../src/project/agreement-content.js';
import { launchPrepareBody } from '../src/wake/job-section-launch.js';
import { jobFix } from './p74b-fixtures.js';
import { commitAndEnd, runningJob } from './p74c-fixtures.js';
import { engineerSubmits, executorInfo, putStandardFiles, reviewerInfo, reviewerThoughtRecently } from './p74d-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { bot, callTool, lastPacket, nextPacket, theJob, threadOf, type JobFix } from './p74f-fixtures.js';
import { newAgreementArgs, ownerSays } from './p72b-fixtures.js';
import { contentFixture } from './p72a-agreement-fixtures.js';

const HOME = '/Users/owner';
const DIR = `${HOME}/Desktop/上新页面`;
const SHOWN = '~/Desktop/上新页面';
const HOW = '复制到桌面上的上新页面文件夹';
const OK = { code: 0, stdout: '已复制', stderr: '', timedOut: false };
/** 一条把成果放进发布位置的命令（一条命令做完建目录和复制）。 */
const publishScript = (dir = DIR): string => `mkdir -p ${dir} && cp work/index.html ${dir}/index.html`;
const publishArgs = (fix: JobFix, dir = DIR) => ({ kind: 'run_command', why: '会员定价页已验收，按约定复制到桌面上的文件夹', payload: { cmd: 'bash', args: ['-c', publishScript(dir)], cwd: bot(fix, fix.engineer.id).homeDir },
  cost: '不产生费用', undo: '删除那个文件夹即可', after: '复制完成后你在桌面上就能看到' });
/** 提示句里没有项目文件夹时去掉「项目文件夹、」；夹具里员工是项目成员，所以有。 */
const RISK_WITH_DIR = `批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹、${SHOWN}；可以联网。不确定这条命令的作用时，请拒绝。`;
const RISK_PLAIN = '批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。';
const CHANGED = '约定的发布位置现在指向别处，没有运行发布命令。';

/** 验收之后、执行者还没有拿到发布准备回合的起点：主目录是 /Users/owner；launch 可以带或不带 localDir。 */
async function accepted(launch: Record<string, unknown>): Promise<{ fix: JobFix; agreementId: string }> {
  const fix = await jobFix([], {}, { ownerHome: HOME });
  // P81r1（S3）：提交约定时会查磁盘，发布位置的上一级（桌面）必须已经存在。
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

/** 执行者拿到发布准备回合并提交发布命令（必须成功）；返回审批单。回合不结束，调用者按需要继续。 */
async function submitPublish(fix: JobFix, dir = DIR) {
  const packet = await nextPacket(fix, fix.engineer.id);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', publishArgs(fix, dir));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const approval = fix.ctx.store.table('approvals').list().at(-1)!;
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
  return { packet, approval };
}

/** 批准（界面入口）并等中心运行完。 */
async function approveAndRun(fix: JobFix, approvalId: string, args: string[]): Promise<void> {
  fix.ctx.exec.set('bash', args, OK);
  expect(await fix.hub.api.decideApproval(approvalId, true)).toMatchObject({ ok: true });
  await executeReadyOutbox(fix.ctx);
}
const execCalls = (fix: JobFix) => (fix.ctx.exec as FakeExec).calls;
const chiefSays = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
/** 让命令执行接口里「实际路径」的解析按映射表走（假文件接口默认原样返回）。 */
function mapRealpath(fix: JobFix, map: Record<string, string>): void {
  const fs = fix.ctx.fs;
  const original = fs.realpath.bind(fs);
  fs.realpath = async (path: string) => {
    for (const [from, to] of Object.entries(map)) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
    return original(path);
  };
}

describe('1 整条链', () => {
  it('提交带 localDir 的约定到验收：约定卡有那一行；唤醒包有发布位置那一行；预先核对；提示句；可写清单；成功的句子', async () => {
    const { fix, agreementId } = await accepted({ how: HOW, localDir: '~/Desktop/上新页面/' });
    // 保存的是整理之后的绝对路径；约定卡视图有「发布到本机文件夹：{显示路径}」，位置在发布那一行之后。
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const version = lockedVersionOf(agreement);
    expect(version.content.launch).toEqual({ how: HOW, localDir: DIR });
    const card = agreementCardView(fix.ctx, agreement, version);
    expect(card.localDirLine).toBe(`发布到本机文件夹：${SHOWN}`);
    expect(card.launchLine).toBe(`验收之后对外发布：${HOW}。发布前单独请你批准。`);
    // 唤醒包（发布准备）：可写范围那一行之后是发布位置那一行，逐字。
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(packet).toContain(`这件事约定的发布位置是 ${DIR}，主人已在约定里确认，发布命令可以写入这个文件夹（只有这一个）。`);
    expect(packet.indexOf('中心代为运行的发布命令只能写：')).toBeLessThan(packet.indexOf('这件事约定的发布位置是'));
    // 预先核对：写同级目录、写上级目录（桌面）被拒，不建审批；写 localDir 之内的通过。
    for (const bad of [`${HOME}/Desktop/别的页面`, `${HOME}/Desktop`, `${HOME}/Desktop/上新页面2`]) {
      const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', publishArgs(fix, bad));
      expect(refused.ok, bad).toBe(false);
      expect(refused.error, bad).toMatch(/^这条命令要写 .*，中心代为运行时写不进去。/);
    }
    expect(fix.ctx.store.table('approvals').list()).toHaveLength(0);
    // 执行者只用唤醒包里的文字：发布位置从那一行里取出来，写进命令（真实模型就是这样做的）。
    const dirInPacket = /约定的发布位置是 (.+?)，主人已在约定里确认/.exec(packet)?.[1];
    expect(dirInPacket).toBe(DIR);
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', publishArgs(fix, dirInPacket));
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
    // 审批卡提示句逐字，含显示路径；审批卡正文里也有这一句。
    expect(approval.riskNote).toBe(RISK_WITH_DIR);
    expect(fix.ctx.store.table('inbox').list().some(row => row.body.includes(RISK_WITH_DIR))).toBe(true);
    // 批准：中心运行；可写清单里有实际路径（还不存在的文件夹也可以由命令自己建），桌面本身不在清单里。
    await approveAndRun(fix, approval.id, ['-c', publishScript()]);
    expect(execCalls(fix)).toHaveLength(1);
    const sandbox = execCalls(fix)[0]!.opts.sandbox!;
    expect(sandbox.writableRoots).toContain(DIR);
    expect(sandbox.writableRoots).not.toContain(`${HOME}/Desktop`);
    expect(sandbox.mayCreateRoots).toEqual([DIR]);
    // 成功的那一句照 P74r18b。
    expect(theJob(fix).launch.state).toBe('done');
    expect(chiefSays(fix)).toContain(launchSucceededText('会员定价页', HOW));
  });

  it('发布准备正文：约定没有 localDir 时没有这两行（旧约定不变）；有位置时多出位置和点开头两行', () => {
    const job = { id: 'job_x' } as never;
    const without = launchPrepareBody(job, '会员定价页', '/hub/j', [], 0, HOW);
    const withDir = launchPrepareBody(job, '会员定价页', '/hub/j', [], 0, HOW, DIR);
    expect(without.tail.some(row => row.includes('约定的发布位置是'))).toBe(false);
    expect(without.tail.some(row => row.includes('名字以点开头'))).toBe(false);
    expect(withDir.tail.filter(row => row.includes('约定的发布位置是'))).toEqual([`这件事约定的发布位置是 ${DIR}，主人已在约定里确认，发布命令可以写入这个文件夹（只有这一个）。`]);
    expect(withDir.tail).toContain('这个文件夹里名字以点开头的文件和文件夹不能写入，也不能删除。');
    expect(withDir.tail.length).toBe(without.tail.length + 2);
  });
});

describe('2 不放开的情形', () => {
  it('同一件事的普通审批（不是发布审批）：运行时可写清单里没有这个文件夹', async () => {
    const fix = await jobFix([], {}, { ownerHome: HOME });
    await fix.ctx.fs.mkdirp(`${HOME}/Desktop`);
    await runningJob(fix, { deliveryItems: [1], launch: { how: HOW, localDir: DIR } });
    // 这件事还在做（没有交付、没有验收）：执行者提交一条普通命令。
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { kind: 'run_command', why: '在 /tmp 里试一下构建',
      payload: { cmd: 'bash', args: ['-c', 'mkdir -p /tmp/p81-try'], cwd: bot(fix, fix.engineer.id).homeDir } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    // 提示句里没有这个文件夹。
    expect(approval.riskNote).toBe(RISK_PLAIN);
    await approveAndRun(fix, approval.id, ['-c', 'mkdir -p /tmp/p81-try']);
    expect(execCalls(fix)).toHaveLength(1);
    const sandbox = execCalls(fix)[0]!.opts.sandbox!;
    expect(sandbox.writableRoots).not.toContain(DIR);
    expect(sandbox.mayCreateRoots).toBeUndefined();
    // 这一条普通命令要写那个文件夹：提交时照旧被拒绝（不放开）。
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { kind: 'run_command', why: '提前复制',
      payload: { cmd: 'bash', args: ['-c', publishScript()], cwd: bot(fix, fix.engineer.id).homeDir } });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^这条命令要写 .*上新页面.*，中心代为运行时写不进去。/);
  });

  it('另一件没有 localDir 的事的发布命令：可写清单里没有；要写桌面文件夹的提交被拒', async () => {
    const { fix } = await accepted({ how: '发布到 /tmp/p81-site（复制到本机目录）' });
    await nextPacket(fix, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', publishArgs(fix));
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^这条命令要写 .*上新页面.*，中心代为运行时写不进去。/);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...publishArgs(fix), payload: { cmd: 'bash', args: ['-c', 'mkdir -p /tmp/p81-site'], cwd: bot(fix, fix.engineer.id).homeDir } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(approval.riskNote).toBe(RISK_PLAIN);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批' });
    await approveAndRun(fix, approval.id, ['-c', 'mkdir -p /tmp/p81-site']);
    const sandbox = execCalls(fix)[0]!.opts.sandbox!;
    expect(sandbox.writableRoots.some(root => root.includes('Desktop'))).toBe(false);
    expect(sandbox.mayCreateRoots).toBeUndefined();
  });

  it('员工自己的工具写这个文件夹：照旧被守卫拒绝（不是 A 类、标上沙箱之外）', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const employee = bot(fix, fix.engineer.id);
    const verdict = classifyPath(`${DIR}/index.html`, true, nativeGateContext(fix.ctx, employee, { sandboxed: true, tmpDirs: ['/private/tmp'] }));
    expect(verdict.cls).not.toBe('A');
    expect(verdict.blocked).toBe(true);
  });
});

describe('3 运行前重新核对', () => {
  /** 把发布位置在假文件接口里标成符号链接（指向 target）；只影响核对，不真的跟随。 */
  async function markLinked(fix: JobFix, path: string, target: string): Promise<void> {
    await fix.ctx.fs.mkdirp(path);
    (fix.ctx.fs as unknown as { markSymlink(value: string): void }).markSymlink(path);
    mapRealpath(fix, { [path]: target });
  }
  /** 提交发布审批之后、批准之前，把约定的位置换成符号链接，批准：命令不运行，原因逐字。 */
  async function linkedTo(target: string) {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const { approval } = await submitPublish(fix);
    await markLinked(fix, DIR, target);
    await approveAndRun(fix, approval.id, ['-c', publishScript()]);
    return fix;
  }
  const expectNotRun = (fix: JobFix) => {
    expect(execCalls(fix)).toHaveLength(0);
    expect(theJob(fix).launch.state).toBe('failed');
    expect(launchFailedText('会员定价页', { ownerFailureReason: CHANGED, result: CHANGED })).toBe(`「会员定价页」没有发布成功：${CHANGED}`);
    expect(chiefSays(fix)).toContain(`「会员定价页」没有发布成功：${CHANGED}`);
    const row = fix.ctx.store.table('outbox').list()[0]!;
    expect(row).toMatchObject({ status: 'failed', executionStarted: false, ownerFailureReason: CHANGED });
  };

  it('P81r1（S1）：换成指向另一个合规位置（~/Documents/财务）的符号链接：命令没有运行', async () => {
    expectNotRun(await linkedTo(`${HOME}/Documents/财务`));
  });
  it('换成指向主目录之外的符号链接：命令没有运行', async () => {
    expectNotRun(await linkedTo('/Volumes/外置盘/页面'));
  });
  it('换成指向中心数据目录的符号链接：命令没有运行', async () => {
    expectNotRun(await linkedTo('/hub/bots/b_0000000002/work'));
  });
  it('换成指向 ~/Library 之下的符号链接：命令没有运行', async () => {
    expectNotRun(await linkedTo(`${HOME}/Library/LaunchAgents`));
  });
  it('换成指向主目录本身或桌面这类太浅的位置：命令没有运行', async () => {
    expectNotRun(await linkedTo(`${HOME}/Desktop`));
  });
  it('P81r1（S1）：发布位置已存在但是一个普通文件：命令没有运行', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const { approval } = await submitPublish(fix);
    await fix.ctx.fs.writeTextAtomic(DIR, '普通文件');
    await approveAndRun(fix, approval.id, ['-c', publishScript()]);
    expectNotRun(fix);
  });

  it('上级目录是符号链接、解析之后仍合规：照常运行，可写清单里是解析之后的路径', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const { approval } = await submitPublish(fix);
    mapRealpath(fix, { [`${HOME}/Desktop`]: `${HOME}/Documents/真实桌面` });
    await approveAndRun(fix, approval.id, ['-c', publishScript()]);
    expect(execCalls(fix)).toHaveLength(1);
    const sandbox = execCalls(fix)[0]!.opts.sandbox!;
    expect(sandbox.writableRoots).toContain(`${HOME}/Documents/真实桌面/上新页面`);
    expect(sandbox.writableRoots).not.toContain(DIR);
    expect(sandbox.mayCreateRoots).toEqual([`${HOME}/Documents/真实桌面/上新页面`]);
    expect(theJob(fix).launch.state).toBe('done');
  });

  it('约定在批准之后又改了位置：审批旁表记的位置与现在不一致，命令没有运行', async () => {
    const { fix, agreementId } = await accepted({ how: HOW, localDir: DIR });
    const { approval } = await submitPublish(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(version => version.state === 'locked'
      ? { ...version, content: { ...version.content, launch: { how: HOW, localDir: `${HOME}/Desktop/另一个位置` } } } : version) });
    await approveAndRun(fix, approval.id, ['-c', publishScript()]);
    expectNotRun(fix);
  });

  it('取不到真实路径（解析时报错，权限不足这类不是「不存在」的错误）：核对不通过，不放开', async () => {
    const { fix } = await accepted({ how: HOW, localDir: DIR });
    const { approval } = await submitPublish(fix);
    // 只记下批准的决定（不触发运行），再让发布位置的上一级解析失败，直接看运行前核对的结果。
    await approveWithoutRun(fix, approval.id);
    const row = fix.ctx.store.table('outbox').list()[0]!;
    expect(row.approvalId).toBe(approval.id);
    const original = fix.ctx.fs.realpath.bind(fix.ctx.fs);
    fix.ctx.fs.realpath = async (path: string) => {
      if (path === `${HOME}/Desktop`) throw Object.assign(new Error('权限不足'), { code: 'EACCES' });
      return original(path);
    };
    await expect(localDirForRun(fix.ctx, row)).rejects.toBeInstanceOf(LocalDirChanged);
    // 反例：解析恢复正常后同一条核对通过，返回实际路径。
    fix.ctx.fs.realpath = original;
    await expect(localDirForRun(fix.ctx, row)).resolves.toEqual({ actual: DIR });
    // 不是发布审批的出站记录：什么都不放开（返回 null）。
    await expect(localDirForRun(fix.ctx, { approvalId: null })).resolves.toBeNull();
  });
});

describe('4 提交约定时的校验（经真实工具）与改动对比', () => {
  async function submitLaunch(launch: Record<string, unknown>) {
    const fix = await jobFix([], {}, { ownerHome: HOME });
    // P81r1（S3）：上一级文件夹必须已经存在。
    await fix.ctx.fs.mkdirp(`${HOME}/Desktop`);
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    return callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ launch }));
  }
  const tail = '。能用的位置是主人主目录下的一个具体文件夹，至少两级，例如 ~/Desktop/活动页面；不能是主目录或桌面这类目录本身，不能是隐藏目录、系统目录、DSH 和员工的数据目录。位置不合适时和主人商量换一个。';
  it('位置不合格：整份提交被拒，文字逐字，没有建约定', async () => {
    const fix = await jobFix([], {}, { ownerHome: HOME });
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ launch: { how: HOW, localDir: '~/Desktop' } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`launch.localDir 不能用：层级不够深，需要是主目录下面至少两级的具体文件夹${tail}`);
    expect(fix.ctx.store.table('agreements').list()).toHaveLength(0);
  });
  it('发布方式明显写的是本机位置却没有填 localDir：拒绝，文字逐字', async () => {
    const result = await submitLaunch({ how: '复制到 ~/Desktop/活动页面' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('发布方式写的是主人电脑上的位置，要把那个文件夹填进 launch.localDir（完整路径，可以用 ~ 表示主目录），主人确认约定时会看到它。位置说得不具体时先问主人。发布到本机临时文件夹（/tmp 之下）或项目文件夹的不用填。');
  });
  it('取不到主人的主目录时：带 localDir 的提交被拒', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ launch: { how: HOW, localDir: '~/Desktop/活动页面' } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('launch.localDir 不能用：取不到你电脑的主目录，无法核对这个位置');
  });
  it('合格的位置：保存整理之后的绝对路径；/tmp 的发布方式不用填', async () => {
    const result = await submitLaunch({ how: HOW, localDir: '~/Desktop//上新页面/' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const ok2 = await submitLaunch({ how: '发布到 /tmp/p81-site（复制到本机临时目录）' });
    expect(ok2, JSON.stringify(ok2)).toMatchObject({ ok: true });
  });
  it('两版之间 localDir 变了记为改动；没变不记；旧约定（没有 localDir）不受影响', () => {
    const base = contentFixture();
    const a = { ...base, launch: { how: HOW, localDir: DIR } };
    const b = { ...base, launch: { how: HOW, localDir: `${HOME}/Desktop/别的` } };
    expect(diffContent(a, b)).toEqual([{ section: 'launch', kind: 'changed' }]);
    expect(diffContent(a, { ...a })).toEqual([]);
    expect(diffContent({ ...base, launch: { how: HOW } }, { ...base, launch: { how: HOW } })).toEqual([]);
    expect(diffContent({ ...base, launch: { how: HOW } }, a)).toEqual([{ section: 'launch', kind: 'changed' }]);
  });
});

describe('5 做不了时的那句固定的话（第 4 节）', () => {
  it('逐字', () => {
    expect(launchLocationBlockedText('会员定价页')).toBe('会员定价页没有发布：约定里没有写明发布到你电脑上的哪个文件夹，员工写不进去。做好的成果在项目文件夹里。告诉我具体的文件夹（例如桌面上的一个文件夹），我再安排。');
    expect(LAUNCH_LOCATION_BLOCKER).toBe('发布位置不在能写入的范围内');
  });
});
