/**
 * P76r3 的测试（一）：停滞判断的两个口径、逾期的条目与文字（审查 R1、R2、R4、R11、R12）。
 *
 * 全部走真实 Hub（总管自动创建、听吩咐；执行者林舟听吩咐；额度灯为绿）。时间用注入的假时钟，每次推进不超过 10 分钟；
 * 2 小时、24 小时写成循环。每条用例写明额度灯和预算线：这些用例都在绿灯、预算线内，只有说明预算线的地方例外。
 */
import { describe, expect, it } from 'vitest';
import { reportStall } from '../src/job/stall.js';
import { appendJobEvent, eventsOf } from '../src/job/store.js';
import { flushPushQueue } from '../src/outreach/notify.js';
import {
  MINUTE, advanceSweeping, brokenRelay, chiefSays, dropQueue, noticeRow, pushedTitles, stallItems, sweepNow, waitForPacket,
} from './p76g-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { askedNotReached, engineerTurns, openCap } from './p76f-fixtures.js';
import { bot, callTool, engineerSubmits, executorInfo, putStandardFiles, reviewerInfo, runningOf, started, theJob, tick, type JobFix } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';

const HOUR = 60 * MINUTE;

/** 这件事的中心重新唤醒过几次。 */
function idleResumes(fix: JobFix, jobId: string): number {
  return eventsOf(fix.ctx, jobId).filter(row => row.kind === 'resumed' && row.data.idle === true).length;
}

/** 通知队列里某一事项键的行（任何状态）。 */
function pushRows(fix: JobFix, subjectKey: string) {
  return fix.ctx.store.table('pushQueue').list(row => row.subjectKey === subjectKey);
}

describe('1 R1：有开着的「将超出预计」条目时，停滞不另建条目', () => {
  it('逾期：「将超出预计」条目仍开着、这件事不停、没有第二条条目；推送只有一条；你答复之后的下一次巡检才通知逾期', async () => {
    const { fix, job } = await askedNotReached();
    const cap = openCap(fix, job.id)!;
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    // 没有建「没有进展」条目；主人正在决定的那一条仍开着；编号没有被记（这件事没有停下）。
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').get(cap.id)).toMatchObject({ status: 'open' });
    expect(theJob(fix).inboxId).toBeNull();
    expect(noticeRow(fix, job.id)!.stallNotifiedAt).toBeNull();
    // 推送只有「将超出预计」那一条：合并窗口过去之后真正发出去。
    fix.ctx.clock.advance(10 * MINUTE);
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    expect(pushedTitles(fix).filter(title => title.includes('没有进展') || title.includes('已过交付时间'))).toHaveLength(0);
    // 你答复（选「暂停」：不会再建出新的预计消耗条目）之后，下一次巡检才通知逾期。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
    sweepNow(fix);
    const items = stallItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
    expect(noticeRow(fix, job.id)!.overdueNotifiedFor).not.toBeNull();
  });

  it('空转：有开着的条目时不通知；你答复之后的下一次巡检才通知空转', async () => {
    const { fix, job } = await askedNotReached();
    const cap = openCap(fix, job.id)!;
    dropQueue(fix, fix.engineer.id, job.id);
    sweepNow(fix);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').get(cap.id)).toMatchObject({ status: 'open' });
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
    sweepNow(fix);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    expect(stallItems(fix, job.id)[0]!.body).toContain('连续 3 个回合没有新文件或新证据');
  });

  it('停摆：重新唤醒照做（不受条目影响），通知不做；条目答复之后满 1 小时才通知', async () => {
    const { fix, job } = await askedNotReached();
    const cap = openCap(fix, job.id)!;
    // 让最近一次「记录」是刚刚（否则连续 3 个没有证据的回合会先判成空转）：记一条转交材料的事件，拿掉候选。
    fix.ctx.clock.advance(MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: 'hub', kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    dropQueue(fix, fix.engineer.id, job.id);
    // 2 小时没有记录：重新唤醒一次（R4：不受 24 小时通知间隔限制），但条目开着，不通知。
    advanceSweeping(fix, 130 * MINUTE);
    expect(idleResumes(fix, job.id)).toBe(1);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').get(cap.id)).toMatchObject({ status: 'open' });
    // 被唤醒的候选也拿掉（接力又断了）；你答复条目；再过 2 小时重新唤醒一次，再 1 小时仍没有记录：通知停摆。
    dropQueue(fix, fix.engineer.id, job.id);
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
    advanceSweeping(fix, 2 * HOUR);
    dropQueue(fix, fix.engineer.id, job.id);
    advanceSweeping(fix, HOUR);
    const items = stallItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.body.split('\n')[0]).toContain('没有进展，停在执行这一步，在等林舟。');
  });
});

describe('2 R2：逾期的条目不因新记录撤回，还没发出的推送不被丢弃', () => {
  it('逾期条目建出后这件事有新记录：条目仍开着；合并窗口里的推送照常发出一次', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    expect(item).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
    // 推送已写进队列，但还在 10 分钟的合并窗口里（没有真正发出）。
    expect(pushRows(fix, item!.subjectKey).map(row => row.state)).toEqual(['waiting']);
    // 有了新记录：条目仍开着（R2），队列里那一条没有被丢弃。
    fix.ctx.clock.advance(MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: 'hub', kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    sweepNow(fix);
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'open' });
    expect(theJob(fix).inboxId).toBe(item!.id);
    expect(pushRows(fix, item!.subjectKey).map(row => row.state)).toEqual(['waiting']);
    // 合并窗口过去：真正发出一次。
    fix.ctx.clock.advance(10 * MINUTE);
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    expect(pushedTitles(fix).filter(title => title === '会员定价页：已过交付时间')).toHaveLength(1);
  });

  it('进入待你验收：建验收条目时这条逾期条目被撤回（现有逻辑仍然成立）', async () => {
    const s = await started();
    const { fix, job, info } = s;
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    expect(item).toMatchObject({ status: 'open' });
    // 执行者交回、核对通过：交付时建验收条目，撤回这件事其余开着的条目。
    const packet = await waitForPacket(fix, fix.engineer.id, 30);
    const executor = executorInfo(packet);
    await putStandardFiles(fix, executor);
    await engineerSubmits(fix, executor);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await waitForPacket(fix, fix.reviewer.id, 30));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    await tick(fix, MINUTE);
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'withdrawn' });
    expect(theJob(fix).inboxId).not.toBe(item!.id);
  });

  it('改了交付时间：旧条目撤回，答复栏逐字「交付时间已改」', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() + 30 * MINUTE });
    sweepNow(fix);
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'withdrawn', answer: '交付时间已改' });
    expect(theJob(fix).inboxId).toBeNull();
  });
});

describe('3 R4：停摆的重新唤醒不等 24 小时', () => {
  it('逾期通知过之后接力断了，2 小时后重新唤醒一次（不受 24 小时限制），这时不建新的条目', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    const notifiedAt = noticeRow(fix, job.id)!.stallNotifiedAt!;
    // 先结束执行者正在跑的那个回合（它会留下一条记录），再拿掉候选：模拟逾期之后接力断了。
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    dropQueue(fix, fix.engineer.id, job.id);
    advanceSweeping(fix, 130 * MINUTE);
    expect(fix.ctx.clock.now() - notifiedAt).toBeLessThan(24 * HOUR);
    expect(idleResumes(fix, job.id)).toBe(1);
    expect(stallItems(fix, job.id)).toHaveLength(1);
  });
});

describe('4 R11：撤回之后清空编号前先重读，只在编号仍等于被撤回的那一条时才清', () => {
  it('编号指向另一条开着的条目时，撤回「没有进展」条目不清空这个编号', async () => {
    const { fix, job } = await brokenRelay();
    // 造一条「没有进展」条目，让编号指向它。
    expect(reportStall(fix.ctx, theJob(fix), 'idle', fix.ctx.clock.now(), { actorId: fix.engineer.id })).toBe(true);
    const [stall] = stallItems(fix, job.id);
    expect(theJob(fix).inboxId).toBe(stall!.id);
    // 构造：编号指向另一条开着的条目（例如验收），同时「没有进展」条目还开着。直接写表，避免建条目时把这一条撤回。
    const other = { id: 'i_otherask01', botId: fix.chief.id, type: 'question' as const, title: '验收', body: '请验收', options: ['验收通过'],
      defaultOption: null, priority: 'P1' as const, status: 'open' as const, answer: null, refId: job.id, subjectKey: `job:${job.id}:accept:1`,
      pushed: false, createdAt: fix.ctx.clock.now(), expiresAt: null, answeredAt: null };
    fix.ctx.store.table('inbox').put(other);
    fix.ctx.store.table('jobs').patch(job.id, { inboxId: other.id });
    // 新记录之后巡检：撤回「没有进展」条目，但不把编号（指向验收条目）清掉。
    fix.ctx.clock.advance(MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: 'hub', kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    sweepNow(fix);
    expect(fix.ctx.store.table('inbox').get(stall!.id)).toMatchObject({ status: 'withdrawn', answer: '这件事有了新进展' });
    expect(theJob(fix).inboxId).toBe(other.id);
  });
});

describe('5 R12：你选过「暂停」的事到预算线时，撤回其余开着的通知类条目', () => {
  it('逾期条目开着、你之前选了「暂停」：到预算线转「你已暂停」，逾期条目撤回', async () => {
    const { fix, job } = await askedNotReached();
    await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' });
    expect(noticeRow(fix, job.id)!.holdAtCap).toBe(true);
    // 造一条逾期条目（这时没有别的开着的条目）。
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [overdue] = stallItems(fix, job.id);
    expect(overdue).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
    // 执行到预算线：转「你已暂停」，逾期条目撤回并写明原因。
    await engineerTurns(fix, 5);
    await tick(fix, MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, turnCap: 8, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(overdue!.id)).toMatchObject({ status: 'withdrawn', answer: '这件事已按你的选择暂停' });
    expect(chiefSays(fix).at(-1)).toBe('会员定价页已用到预计的 9 回合，按你的选择已暂停。要接着做时告诉我。');
  });
});
