/**
 * P74r15 第 1 节的测试：发布这一步结束时，执行者正在跑的发布准备回合也要停下；
 * 发布环节之外，执行者提交的发布命令被拒，不建审批、不在总管私聊落话。
 *
 * 覆盖：
 * 1 发布准备回合正在跑时，主人确认去掉对外发布：那个回合被取消（原因写中心结束、不算员工故障、没有重试的唤醒）；
 *   取消生效之前（宿主取消还没返回）回合又提交了发布命令：被拒，文字逐字，没有新的审批、没有出站记录，总管私聊没有新的话；
 * 2 主人拒绝发布审批（点「暂不发布」）之后，执行者被叫醒的回合里再提交同样的命令：被拒，同样的结果；
 * 3 这件事约定里本来就没有发布这一步，执行者的回合还开着时提交发布命令：被拒；
 * 4 正常的发布环节里提交照常成功（反例）。
 * 全部走真实的 Hub、真实工具；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import { LAUNCH_ENDED_REFUSAL_TEXT } from '../src/job/launch-cancel.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import { entriesOf, runningOf, wakesOf } from './p74c-fixtures.js';
import { bot, callTool, delivered, nextPacket, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';

/** 拒绝文字（逐字，与卡里一致）。 */
const REFUSAL = '这件事的对外发布已经结束（或约定里没有对外发布），不再提交发布。';

/** 给执行者的回合一个步骤事件（宿主回报步数和用量），防止被「10 分钟没有事件」抢先结束。 */
async function stepEvent(fix: JobFix, botId: string): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), steps: 3, tokens: 50_000 });
}

/** 总管私聊目前的全部文字。 */
const chiefTexts = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).map(row => row.text);

/** 让宿主的取消先不返回，直到调用返回的 release：模拟「取消还没有生效」的空档。 */
function holdCancel(fix: JobFix): () => void {
  const host = fix.ctx.host as unknown as FakeHost;
  const original = host.cancel.bind(host);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  host.cancel = async (sessionId: string) => { await gate; await original(sessionId); };
  return release;
}

/**
 * 发布准备回合开着（执行者拿到了回合、没有结束）时，主人对总管说去掉发布、总管出新版本、主人确认第 2 版。
 * 推进时钟时给执行者的回合不断发事件（每次 2 分钟）。确认之后不等异步收尾，由调用方决定怎样等。
 */
async function ownerConfirmsNoLaunch(fix: JobFix, agreementId: string, beforeConfirm: () => void = () => undefined): Promise<{ done: Promise<unknown> }> {
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, fix.chief.id, '先不发布了');
  for (let i = 0; i < 20 && !runningOf(fix, fix.chief.id); i += 1) {
    fix.ctx.clock.advance(2 * MINUTE);
    await stepEvent(fix, fix.engineer.id);
    await fix.hub.tick();
  }
  expect(runningOf(fix, fix.chief.id), '总管应该拿到回合').toBeDefined();
  const revised = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '去掉对外发布', launch: null });
  expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '去掉发布的这一版等你确认。', { outcome: 'needs_owner' });
  // 界面命令会等异步收尾做完（含取消回合）：取消被卡住时它也不返回，所以这里把承诺交给调用方，释放取消之后再等。
  // 包一层对象返回：直接返回承诺会被异步函数自动等待，取消被卡住时就永远等下去。
  beforeConfirm();
  return { done: fix.hub.api.confirmAgreement({ agreementId, version: 2 }) };
}

describe('1 主人确认去掉对外发布时，正在跑的发布准备回合被停下', () => {
  it('回合被取消（原因写中心结束、不算故障），没有重试的唤醒；取消生效之前再提交发布命令被拒，没有新审批、总管私聊没有新话', async () => {
    const { fix, job } = await acceptedWithLaunch();
    // 执行者的发布准备回合开始、不结束。
    await nextPacket(fix, fix.engineer.id);
    const launchWake = runningOf(fix, fix.engineer.id)!;
    expect(launchWake.jobId).toBe(job.id);
    let release: () => void = () => undefined;
    const confirming = await ownerConfirmsNoLaunch(fix, job.agreementId, () => { release = holdCancel(fix); });
    await vi.waitFor(() => expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' }));
    // 取消还没有生效：回合仍开着。这个回合又提交了一次发布命令：被拒，什么都没建。
    expect(fix.ctx.store.table('wakes').get(launchWake.id)!.endedAt).toBeNull();
    const before = { thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length };
    const late = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
    expect(late).toEqual({ ok: false, error: REFUSAL });
    expect(LAUNCH_ENDED_REFUSAL_TEXT).toBe(REFUSAL);
    expect({ thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length }).toEqual(before);
    // 取消生效：回合记为超时结束，原因写中心结束；员工没有出错退避，没有被再叫醒。
    release();
    expect(await confirming.done).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(fix.ctx.store.table('wakes').get(launchWake.id)).toMatchObject({ status: 'timeout', error: '发布这一步已结束，中心结束本回合' }));
    expect(fix.ctx.host.calls.filter(call => call.method === 'cancel' && call.args[0] === launchWake.sessionId)).toHaveLength(1);
    expect(bot(fix, fix.engineer.id).retryAt).toBeNull();
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('approvals').list()).toHaveLength(0);
  });
});

describe('1 主人点「暂不发布」之后，再提交发布命令被拒', () => {
  it('执行者提交发布审批后回合还开着，主人拒绝：回合被取消；取消生效之前提交同样的命令被拒，审批只有原来那一张，总管私聊没有新的审批说明', async () => {
    const { fix, job } = await acceptedWithLaunch();
    // 执行者在同一个回合里提交了发布审批，回合还没有结束。
    await nextPacket(fix, fix.engineer.id);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix))).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    const turn = runningOf(fix, fix.engineer.id)!;
    const release = holdCancel(fix);
    const deciding = fix.hub.api.decideApproval(approval.id, false);
    await vi.waitFor(() => expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' }));
    expect(fix.ctx.store.table('wakes').get(turn.id)!.endedAt).toBeNull();
    const before = { thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length };
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { why: '主人拒绝之后又想再提交一次' }));
    expect(result).toEqual({ ok: false, error: REFUSAL });
    expect({ thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length }).toEqual(before);
    expect(chiefTexts(fix).some(text => text.includes('在准备发布'))).toBe(false);
    release();
    expect(await deciding).toMatchObject({ ok: true });
    // 取消不登记成界面命令要等的异步收尾（宿主取消可能很慢），所以这里等回合真的结束。
    await vi.waitFor(() => expect(fix.ctx.store.table('wakes').get(turn.id)).toMatchObject({ status: 'timeout', error: '发布这一步已结束，中心结束本回合' }));
    expect(wakesOf(fix, fix.engineer.id, job.id).filter(row => row.endedAt === null)).toHaveLength(0);
  });
});

describe('1 约定里本来没有发布这一步', () => {
  it('这件事已完成、没有发布这一步，执行者开着的回合提交命令：被拒，没有审批', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ launchStep: false, launch: { state: 'none' } });
    // 执行者此刻有一个带这件事的开着的回合（验收时他的回合还没有收尾）：用已有的一条唤醒单复制成开着的回合。
    const old = wakesOf(fix, fix.engineer.id, job.id).at(-1)!;
    const sessionId = bot(fix, fix.engineer.id).sessionId ?? old.sessionId;
    fix.ctx.store.table('bots').patch(fix.engineer.id, { sessionId });
    fix.ctx.store.table('wakes').put({ ...old, id: `${old.id}-open`, status: 'running', endedAt: null, commitId: null, sessionId, startedAt: fix.ctx.clock.now(), lastEventAt: fix.ctx.clock.now() });
    const before = { thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length };
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
    expect(result).toEqual({ ok: false, error: REFUSAL });
    expect({ thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length }).toEqual(before);
  });
});

describe('1 反例：正常的发布环节里提交照常成功', () => {
  it('已验收、发布准备中：提交成功，审批建立，发布状态为等批准', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(approval.status).toBe('pending');
    expect(theJob(fix).launch.state).toBe('approval');
  });
});
