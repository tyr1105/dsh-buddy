/**
 * P74r13 第 1、2 节的测试：约定里「对外发布」一项只能经主人确认的修订来改；
 * 已经验收、发布这一步进行中时主人确认了去掉对外发布的新版本，这次发布随之结束。
 *
 * 覆盖：
 * 1 amend（直接生效、不请主人确认）加上、改写、去掉对外发布，各一条被拒，文字逐字；amend 不提对外发布照常通过；
 * 2 发布这一步没有做完的三种情形（执行者在准备、发布审批在等主人、已批准还没有执行）：主人确认去掉之后发布结束
 *   （endedBy 为主人）、审批作废、主人再批准不了、执行者排着的叫醒被丢弃且之后没有再被叫醒、主题里那句固定句逐字、
 *   进度行写「你暂不发布」；
 * 3 发布已经做完：不动，返回给总管的文字逐字加那一句；
 * 4 反方向（已验收、原来没有发布这一步，新版本加上对外发布）：不追加发布这一步，返回文字逐字加那一句。
 * 全部走真实的 Hub、真实工具，时间用注入的假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it } from 'vitest';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import { commitAndEnd, entriesOf, runningOf, wakesOf } from './p74c-fixtures.js';
import { bot, callTool, delivered, nextPacket, started, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, jobIdIn, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

/** amend 改对外发布被拒的文字（逐字，前半句照其他栏的写法，栏名写「对外发布」）。 */
const AMEND_REFUSAL = 'amend 不能改「对外发布」：amend 直接生效，只能改一句话复述、草图和我已定的；这类改动请改用 revise，重新请主人确认';
/** 主题里落的固定句。 */
const TOPIC_SENTENCE = (n: number) => `约定第 ${n} 版去掉了对外发布，这次不发布。`;
const DONE_SENTENCE = '对外发布已经完成，去掉这一项不影响已经发布的结果；对主人如实说明。';
const ADDED_SENTENCE = '这件事已经验收，这一版加上的对外发布不会自动进行；要发布请另起一件事，对主人如实说明。';

describe('1 amend 不能改对外发布', () => {
  /** 进行中的事、执行者先收尾，主人对总管说一句话，返回可以调用 amend 的环境。 */
  async function chiefHearsOwner(launch: boolean) {
    const { fix, job } = await started([], launch ? { launch: true } : {});
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '发布的事改一下');
    return { fix, job };
  }
  const amend = (fix: JobFix, agreementId: string, extra: Record<string, unknown>) =>
    callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'amend', agreementId, changeNote: '改对外发布', ...extra });

  it('加上对外发布：被拒，文字逐字，没有新版本，这件事的发布步骤不变', async () => {
    const { fix, job } = await chiefHearsOwner(false);
    const result = await amend(fix, job.agreementId, { launch: { how: '发布到测试站点' } });
    expect(result).toEqual({ ok: false, error: AMEND_REFUSAL });
    expect(fix.ctx.store.table('agreements').get(job.agreementId)!.versions).toHaveLength(1);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).launchStep).toBe(false);
  });

  it('改写对外发布：被拒，文字逐字', async () => {
    const { fix, job } = await chiefHearsOwner(true);
    const result = await amend(fix, job.agreementId, { launch: { how: '发布到另一个站点' } });
    expect(result).toEqual({ ok: false, error: AMEND_REFUSAL });
    expect(fix.ctx.store.table('agreements').get(job.agreementId)!.versions).toHaveLength(1);
  });

  it('去掉对外发布：被拒，文字逐字，这件事仍有发布步骤', async () => {
    const { fix, job } = await chiefHearsOwner(true);
    const result = await amend(fix, job.agreementId, { launch: null });
    expect(result).toEqual({ ok: false, error: AMEND_REFUSAL });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).launchStep).toBe(true);
  });

  it('同时改了对外发布和待定项：两项的栏名都写进拒绝文字', async () => {
    const { fix, job } = await chiefHearsOwner(false);
    const result = await amend(fix, job.agreementId, { launch: { how: '发布到测试站点' }, scopeOut: ['历史曲线', '导出功能'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('amend 不能改「这次不做」「对外发布」');
  });

  it('反例：amend 不提对外发布（只改一句话复述）照常通过，已有的对外发布不变', async () => {
    const { fix, job } = await chiefHearsOwner(true);
    const result = await amend(fix, job.agreementId, { summary: '做一个能查看会员定价的小页面' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).launchStep).toBe(true);
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    expect(agreement.versions.at(-1)!.changes.some(mark => mark.section === 'launch')).toBe(false);
  });
});

/** 总管说完话之后：主人说去掉发布，总管用 revise 提交，主人确认第 2 版；返回提交的结果。 */
async function ownerRemovesLaunch(fix: JobFix, agreementId: string) {
  // 总管如果还有一个没结束的回合（例如被发布结果叫醒的），先让它结束，主人的话才会叫醒一个新回合。
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, fix.chief.id, '先不发布了');
  // 主人的话叫醒总管可能要等调度推进几次（每次不超过 10 分钟）。
  for (let i = 0; i < 6 && !runningOf(fix, fix.chief.id); i += 1) await tick(fix, 5 * MINUTE);
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '去掉对外发布', launch: null });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '去掉发布的这一版等你确认。', { outcome: 'needs_owner' });
  expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
  return result;
}

/** 确认之后：推进假时钟（每次 10 分钟），检查执行者没有再被叫醒、发布命令没有运行。 */
async function expectNoMoreLaunch(fix: JobFix, jobId: string) {
  const wakes = wakesOf(fix, fix.engineer.id, jobId).length;
  for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
  expect(wakesOf(fix, fix.engineer.id, jobId)).toHaveLength(wakes);
  expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
  expect(fix.ctx.store.table('outbox').list().filter(row => row.status === 'done')).toHaveLength(0);
}

describe('2 去掉对外发布：发布这一步还没有做完时随之结束', () => {
  it('执行者在准备：发布结束（主人结束），排着的叫醒被丢弃，主题里一句固定句，进度行写「你暂不发布」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    expect(theJob(fix).launch.state).toBe('preparing');
    expect(entriesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
    await ownerRemovesLaunch(fix, job.agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'owner' } });
    // 排着的准备发布的叫醒当场被丢弃（不是靠后面闸门的兜底）。
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.text === TOPIC_SENTENCE(2))).toHaveLength(1);
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBe('你暂不发布');
    await expectNoMoreLaunch(fix, job.id);
  });

  it('发布审批在等主人：审批作废、主人再批准不了、命令没有运行、执行者没有再被叫醒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(theJob(fix).launch).toMatchObject({ state: 'approval', approvalId: approval.id });
    await ownerRemovesLaunch(fix, job.agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'owner' } });
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(fix.ctx.store.table('inbox').list(row => row.refId === approval.id && row.status === 'open')).toHaveLength(0);
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.text === TOPIC_SENTENCE(2))).toHaveLength(1);
    // 主人再点批准：审批已不是待审批，批准不了。
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: false });
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
    await expectNoMoreLaunch(fix, job.id);
  });

  it('已批准、还没有执行：审批作废，命令之后执行不了，执行者没有再被叫醒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定（界面入口会立刻开始执行）
    // 批准了但还没有调度运行：审批是已批准、没有使用。
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'approved', usedAt: null });
    await ownerRemovesLaunch(fix, job.agreementId);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'owner' } });
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true, usedAt: null });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.text === TOPIC_SENTENCE(2))).toHaveLength(1);
    await expectNoMoreLaunch(fix, job.id);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
  });
});

describe('3 去掉对外发布：发布已经做完时不动', () => {
  it('已经发布：发布状态和地址不动，主题里没有固定句，返回给总管的文字逐字带那一句', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    const again = await nextPacket(fix, fix.engineer.id);
    const done = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: jobIdIn(again), link: 'https://example.com/signup' });
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    expect(theJob(fix).launch.state).toBe('done');
    const result = await ownerRemovesLaunch(fix, job.agreementId);
    expect(result.text!.endsWith(DONE_SENTENCE)).toBe(true);
    expect(theJob(fix)).toMatchObject({ state: 'done', launchStep: true, launch: { state: 'done', link: 'https://example.com/signup' } });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === TOPIC_SENTENCE(2))).toBe(false);
  });

  it('反例：发布还没有做完时，返回给总管的文字没有那一句', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const result = await ownerRemovesLaunch(fix, job.agreementId);
    expect(result.text).not.toContain(DONE_SENTENCE);
    expect(result.text).not.toContain(ADDED_SENTENCE);
  });
});

describe('4 反方向：已验收、原来没有发布这一步，新版本加上对外发布', () => {
  it('不追加发布这一步（没有人被叫醒），返回给总管的文字逐字带那一句', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ launchStep: false, launch: { state: 'none' } });
    await ownerSays(fix, fix.chief.id, '做完发布到测试站点');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '加上对外发布', launch: { how: '发布到测试站点' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text!.endsWith(ADDED_SENTENCE)).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '加上发布的这一版等你确认。', { outcome: 'needs_owner' });
    expect(await fix.hub.api.confirmAgreement({ agreementId: job.agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    expect(theJob(fix)).toMatchObject({ launchStep: false, launch: { state: 'none' } });
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
  });
});
