/**
 * P74g 复核后的测试：验收一定成功（叫不醒执行者也不恢复原状）、发布这一步自己的回合上限、
 * 执行者停用或归档时的处理、发布审批在执行阶段被作废时记为暂不发布；以及闸门对发布叫醒的规则。
 * 走真实 Hub、真实工具、假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it } from 'vitest';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { LAUNCH_VOIDED_TEXT, launchCapText } from '../src/job/launch-approval.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { bot, callTool, delivered, nextPacket, sectionOf, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { jobIdIn, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

/** 交付完成、等主人验收的一件有发布步骤的事。 */
async function deliveredWithLaunch() {
  return delivered([], { launch: true });
}

describe('1 这件事的回合恰好用满时，主人验收仍成功，执行者仍被叫醒去准备发布', () => {
  it('turnsUsed 等于 turnCap：验收成功；林舟拿到发布准备的回合，唤醒包里有发布的写法', async () => {
    const { fix, job } = await deliveredWithLaunch();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'preparing' } });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('主人已验收。下一步是对外发布，必须先经主人批准。');
    // 这件事的回合上限没有因此建「回合用到上限」的条目。
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(0);
  });
});

describe('2 发布这一步自己的回合上限（4 个回合）', () => {
  it('用满之后再来的叫醒被丢弃：这一步记为暂不发布，总管私聊以总管名义落那句话，不建待你处理条目', async () => {
    expect(JOB_DEFAULTS.LAUNCH_TURN_CAP).toBe(4);
    const { fix, job } = await deliveredWithLaunch();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    // 第 1 个回合是验收时排的；P74r7 起每个回合以「还没做完」交账之后，由中心接着排下一回合（不再需要测试手工再叫），
    // 原来这里每轮手工叫醒一次、第 5 次手工叫醒，现在都由中心续排；第 5 个回合的叫醒被闸门丢弃，这一步停下。
    for (let turn = 1; turn <= 4; turn += 1) {
      await nextPacket(fix, fix.engineer.id);
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: `第 ${turn} 次，没有进展` });
    }
    expect(wakesOf(fix, fix.engineer.id).filter(row => row.startedAt >= theJob(fix).acceptedAt!)).toHaveLength(4);
    await tick(fix, 10 * MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined' } });
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    // 预期已改（P74r4b 第 1 节）：执行者还没有提交发布审批，那句话改为按事实说的第一种。
    const said = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text === launchCapText('no_approval', { title: '会员定价页', turns: 4, executor: '林舟' }));
    expect(said).toHaveLength(1);
    expect(launchCapText('no_approval', { title: '会员定价页', turns: 4, executor: '林舟' }))
      .toBe('会员定价页的发布这一步用了 4 个回合，林舟仍没有提交发布审批，发布这一步到此结束，没有发布。需要时告诉我。');
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ data: { reason: 'turn_cap', turns: 4 } }]);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.title.includes('回合用到上限'))).toHaveLength(0);
  });
});

describe('3 执行者此刻不在岗', () => {
  it('停用：验收成功，发布保持准备中，总管私聊以中心名义落一句；恢复在岗后他被叫醒去准备发布', async () => {
    const { fix, job } = await deliveredWithLaunch();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`)).length;
    expect(items).toBeGreaterThan(0);
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'preparing' } });
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.kind === 'system' && row.text === '会员定价页已验收。发布这一步要等林舟恢复在岗后才开始。')).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    // 恢复在岗：由中心叫醒他。
    expect(await fix.hub.api.setLifecycle(fix.engineer.id, 'active')).toMatchObject({ ok: true });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(jobIdIn(packet)).toBe(job.id);
    expect(sectionOf(packet)).toContain('下一步是对外发布，必须先经主人批准。');
  });

  it('已归档：验收成功，这一步记为暂不发布，总管私聊落一句，执行者不被叫醒', async () => {
    const { fix, job } = await deliveredWithLaunch();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { archivedAt: fix.ctx.clock.now() });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined' } });
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.text === '会员定价页已验收。林舟已归档，发布这一步没有进行。需要时告诉我。')).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ data: { reason: 'executor_archived' } }]);
  });
});

describe('4 闸门：发布的叫醒不被这件事的回合上限丢弃，但受发布自己的上限约束；红灯、鉴权失败照常拦', () => {
  it('这件事回合用满时放行；用满发布自己的 4 个回合时按 job_cap 丢弃；红灯、鉴权失败照常拦', async () => {
    const { fix, job } = await deliveredWithLaunch();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const entry = entriesOf(fix, fix.engineer.id, job.id)[0]!;
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    fix.ctx.clock.advance(10 * MINUTE);
    fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
    const now = fix.ctx.clock.now();
    const verdict = (patch: Record<string, unknown> = {}) => evaluateGates(entry, { ...buildSnapshot(fix.ctx, entry.botId, now, entry.jobId), ...patch } as never, now, fix.ctx.settings);
    expect(verdict()).toEqual({ pass: true });
    // 对照：同样回合用满、但这件事还没完成（执行中）时仍按 job_cap 丢弃。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'doing', launch: { state: 'none', approvalId: null, link: null } });
    expect(verdict()).toMatchObject({ pass: false, by: 'job_cap', drop: true });
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done', launch: { state: 'preparing', approvalId: null, link: null } });
    // 发布自己的上限：验收之后已经开始 4 个回合。
    const sample = fix.ctx.store.table('wakes').list()[0]!;
    for (let i = 0; i < 4; i += 1) {
      fix.ctx.store.table('wakes').put({ ...sample, id: `w_launchcap${i}${i}`, botId: fix.engineer.id, jobId: job.id, startedAt: theJob(fix).acceptedAt! + i, endedAt: now, status: 'committed' });
    }
    expect(verdict()).toMatchObject({ pass: false, by: 'job_cap', drop: true });
    // 红灯、鉴权失败：回到有剩余回合的状态后照常拦（保护的是全局）。
    for (let i = 0; i < 4; i += 1) fix.ctx.store.table('wakes').remove(`w_launchcap${i}${i}`);
    const base = buildSnapshot(fix.ctx, entry.botId, now, entry.jobId);
    expect(verdict({ quota: { ...base.quota, light: 'red', probeAllowed: false, redUntil: now + 60 * MINUTE } })).toMatchObject({ pass: false, by: 'quota' });
    expect(verdict({ authBlocked: true })).toMatchObject({ pass: false, by: 'quota' });
  });
});

describe('5 发布审批在执行阶段被作废', () => {
  /** 把脚本文件放好（这样命令的内容被绑定进批准票），返回文件路径。 */
  async function putScript(fix: JobFix): Promise<string> {
    const path = `${bot(fix, fix.engineer.id).homeDir}/work/go-live.js`;
    await fix.ctx.fs.mkdirp(`${bot(fix, fix.engineer.id).homeDir}/work`);
    await fix.ctx.fs.writeTextAtomic(path, 'console.log("v1")');
    return path;
  }

  it('正例：批准之后命令脚本被改动，中心作废这张审批：发布状态记为暂不发布，记事件，总管私聊落那句话', async () => {
    const { fix, job } = await deliveredWithLaunch();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const script = await putScript(fix);
    const { approval } = await submitLaunch(fix);
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定（界面入口会立刻开始执行）
    await fix.ctx.fs.writeTextAtomic(script, 'console.log("v2，批准之后被改了")');
    await tick(fix, 2 * MINUTE);
    // 预期已改（P74r4b-m1）：中心作废的审批统一记为已过期并带作废标记，不再是已拒绝。
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined' } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ actor: 'hub', data: { approvalId: approval.id, status: 'voided' } }]);
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text === LAUNCH_VOIDED_TEXT)).toHaveLength(1);
    expect(LAUNCH_VOIDED_TEXT).toBe('发布审批已作废（批准之后要运行的命令有改动），没有发布。需要时告诉我。');
    // 之后回报已发布被拒。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: job.id, link: 'https://example.com/x' })).toEqual({ ok: false, error: '这件事现在不在等发布结果' });
  });

  it('反例：不带事的编号的审批被作废：审批同样作废，但没有任何发布状态改动、总管私聊没有新话、没有 launch_declined 事件', async () => {
    const { fix, job } = await deliveredWithLaunch();
    const script = await putScript(fix);
    await fix.hub.api.sendMessage(fix.engineer.id, '请帮我跑一次整理脚本');
    await nextPacket(fix, fix.engineer.id);
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准', reply: '已提交，等你批准。' });
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定
    const chiefBefore = threadOf(fix.ctx, fix.chief.id).length;
    const jobBefore = JSON.stringify({ state: theJob(fix).state, launch: theJob(fix).launch });
    await fix.ctx.fs.writeTextAtomic(script, 'console.log("v2")');
    await tick(fix, 2 * MINUTE);
    // 预期已改（P74r4b-m1）：已过期加作废标记，不再是已拒绝。
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(JSON.stringify({ state: theJob(fix).state, launch: theJob(fix).launch })).toBe(jobBefore);
    expect(threadOf(fix.ctx, fix.chief.id)).toHaveLength(chiefBefore);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toHaveLength(0);
  });
});
