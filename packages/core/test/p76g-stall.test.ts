/**
 * P76g 的测试（二）：停滞的三种判定、重新唤醒一次、通知一次、不算停滞的六种情形、一次停滞只通知一次、两段式。
 *
 * 全部走真实 Hub（总管自动创建、听吩咐、节奏最慢；执行类员工听吩咐；额度灯为绿、预算线未用完，额度和预算那两例除外）。
 * 时间用注入的假时钟，每步不超过 10 分钟，2 小时、24 小时写成循环并每步跑一次巡检（或整个 tick）。
 * 被叫醒的人真跑一个回合：只用唤醒包里的文字取值、调用工具，证明唤醒包写的做法能做成。
 */
import { describe, expect, it } from 'vitest';
import { checkStall, stallOf, type StallInput } from '../src/job/stall-check.js';
import { lastProgressAtOf } from '../src/job/progress-mark.js';
import { reportStall } from '../src/job/stall.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { appendJobEvent, eventsOf } from '../src/job/store.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { flushPushQueue } from '../src/outreach/notify.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';
import { localParts } from '../src/util/time.js';
import { addWake } from './p76c-fixtures.js';
import { recordJobTurn } from '../src/job/usage.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import { spinRunOf } from '../src/job/stall-spin.js';
import { commitAndEnd, entriesOf, countEvents, runningOf, theJob, topicMessages } from './p74c-fixtures.js';
import { INTERNAL, engineerSubmits, executorInfo, putStandardFiles, started, type JobFix } from './p74d-fixtures.js';
import { engineerTurns } from './p76f-fixtures.js';
import {
  MINUTE, advanceSweeping, advanceTicking, brokenRelay, chiefSays, dropQueue, holdSilent, noticeRow, stallItems, sweepNow, waitForPacket, pushedTitles,
} from './p76g-fixtures.js';
import { jobFix, ownerSays } from './p74b-fixtures.js';
import { assigned } from './p74c-fixtures.js';

const HOUR = 60 * MINUTE;

/** 巡检要用的、按事分组读好的数据（与 sweepJobs 读的一致）。 */
function sharedOf(fix: JobFix, jobId: string) {
  const job = theJob(fix);
  return { events: eventsOf(fix.ctx, jobId), topicMessages: topicMessages(fix, job) };
}

/** 直接判断一次：不改时钟，返回判断结果。 */
function checkNow(fix: JobFix, jobId: string) {
  return checkStall(fix.ctx, theJob(fix), fix.ctx.clock.now(), sharedOf(fix, jobId));
}

/** 这件事最近一次「记录」的时间（用被测的纯函数现算）。 */
function progressAt(fix: JobFix, jobId: string): number {
  const shared = sharedOf(fix, jobId);
  return lastProgressAtOf(theJob(fix), shared.events, shared.topicMessages);
}

/** 推进到「距最近一次记录 ms 毫秒」（每步不超过 10 分钟，每步整个 tick）；已经过了就不动。 */
async function tickToSinceProgress(fix: JobFix, jobId: string, ms: number): Promise<void> {
  const left = progressAt(fix, jobId) + ms - fix.ctx.clock.now();
  if (left > 0) await advanceTicking(fix, left);
}

/** 中心为停摆重新唤醒过几次（resumed 事件里 data.idle 为真的）。 */
function idleResumes(fix: JobFix, jobId: string): number {
  return eventsOf(fix.ctx, jobId).filter(row => row.kind === 'resumed' && row.data.idle === true).length;
}

/** 时刻写成「HH:mm」（按设置里的时区）。 */
function hhmm(fix: JobFix, at: number): string {
  const p = localParts(at, fix.ctx.settings.timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

describe('1 停摆：2 小时重新唤醒一次，再 1 小时仍没有记录才通知你', () => {
  it('1 小时 50 分不动作；满 2 小时重新唤醒一次（候选、事件、rewakeAt）；被唤醒的执行者真跑一个回合并交回：计时重来、没有通知', async () => {
    const { fix, job } = await brokenRelay();
    const lastAt = progressAt(fix, job.id);
    // 从最近一次记录算起 1 小时 50 分：不动作。
    await tickToSinceProgress(fix, job.id, 110 * MINUTE);
    expect(fix.ctx.clock.now() - lastAt).toBe(110 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(idleResumes(fix, job.id)).toBe(0);
    expect(noticeRow(fix, job.id)?.rewakeAt ?? null).toBeNull();
    expect(stallItems(fix, job.id)).toHaveLength(0);

    await advanceTicking(fix, 10 * MINUTE);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.idle === true)).toHaveLength(1);
    expect(noticeRow(fix, job.id)!.rewakeAt).toBe(fix.ctx.clock.now());
    expect(fix.ctx.clock.now() - noticeRow(fix, job.id)!.lastProgressAt).toBe(2 * HOUR);
    expect(noticeRow(fix, job.id)!.lastProgressAt).toBe(lastAt);
    // 队列里有执行者的候选（或他已经拿到回合）。
    expect(entriesOf(fix, fix.engineer.id, job.id).length + (runningOf(fix, fix.engineer.id) ? 1 : 0)).toBe(1);

    // 被唤醒的执行者真跑一个回合：只用唤醒包里的文字取值，交回成功。
    const packet = await waitForPacket(fix, fix.engineer.id, 30);
    const info = executorInfo(packet);
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await advanceTicking(fix, 60 * MINUTE);
    // 有了新记录：不通知，rewakeAt 清空，计时重来。
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(noticeRow(fix, job.id)!.rewakeAt).toBeNull();
    expect(noticeRow(fix, job.id)!.lastProgressAt).toBeGreaterThan(lastAt);
    expect(theJob(fix).state).not.toBe('ready');
  });

  it('被唤醒的回合没有留下记录就结束：再 1 小时通知你；正文三行、选项、私聊末行逐字，推送一次', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    dropQueue(fix, fix.engineer.id, job.id);
    await tickToSinceProgress(fix, job.id, 120 * MINUTE);
    const rewakeAt = noticeRow(fix, job.id)!.rewakeAt!;
    expect(rewakeAt).toBe(fix.ctx.clock.now());
    // 被唤醒的回合：拿到回合、交账 progress（没有任何记录），续排的候选拿掉。
    await waitForPacket(fix, fix.engineer.id, 30);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '还在想' });
    dropQueue(fix, fix.engineer.id, job.id);
    await advanceTicking(fix, rewakeAt + 50 * MINUTE - fix.ctx.clock.now());
    expect(stallItems(fix, job.id)).toHaveLength(0);
    // 满 1 小时（从 rewakeAt 算起）仍没有记录：通知。
    await advanceTicking(fix, rewakeAt + HOUR - fix.ctx.clock.now());
    const items = stallItems(fix, job.id);
    expect(items).toHaveLength(1);
    const now = fix.ctx.clock.now();
    const notice = noticeRow(fix, job.id)!;
    const waitedHours = Math.round((now - notice.lastProgressAt) / HOUR);
    const lines = items[0]!.body.split('\n');
    expect(lines).toEqual([
      `已 ${waitedHours} 小时没有进展，停在执行这一步，在等林舟。`,
      `${hhmm(fix, notice.lastProgressAt)} 起没有任何记录；${hhmm(fix, rewakeAt)} 已重新唤醒过林舟一次，仍没有记录。`,
      `已用 ${lines[2]!.match(/^已用 (\d+) \/ 9 回合/)![1]} / 9 回合，交付时间 11月17日 18:00 前。`,
    ]);
    expect(items[0]).toMatchObject({ title: '会员定价页：没有进展', type: 'question', priority: 'P1', defaultOption: null, expiresAt: null,
      options: ['换小周接手', '再提醒一次', '暂停'], subjectKey: `job:${job.id}:stall:1` });
    expect(theJob(fix)).toMatchObject({ state: 'doing', inboxId: items[0]!.id, stallNo: 1 });
    expect(notice).toMatchObject({ stallNotifiedAt: now, stallKind: 'idle' });
    const said = chiefSays(fix).filter(text => text.includes('没有进展'));
    expect(said).toHaveLength(1);
    expect(said[0]).toBe([...lines, '之后 24 小时内，不会再因为会员定价页没有进展通知你；有新进展之后重新计时。'].join('\n'));
    // 推送：条目建立时由通知队列自动发出一次（类别：没有进展）。
    expect(pushedTitles(fix).filter(title => title === items[0]!.title)).toHaveLength(1);
    // 给主人看的文字没有内部名称，也没有英文。
    for (const text of [items[0]!.title, items[0]!.body, ...items[0]!.options, said[0]!]) {
      expect(text).not.toMatch(INTERNAL);
      expect(text).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('2 空转：连续 3 个回合没有新文件或新证据', () => {
  it('执行者连续 3 个回合结束都没有事件、接力断了：通知你；正文逐字，选项、私聊、推送', async () => {
    const s = await started();
    const { fix, job } = s;
    // P76r3（R1）：这一例只看空转，所以把预算线放宽，避免第 3 个回合结束时同时建出「将超出预计」的条目；
    // 有那条条目开着时按乙不发新的停滞通知（那是另一条用例）。
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 16 });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await engineerTurns(fix, 2);
    // 第 3 个回合结束时续排的候选还排着（接力没断）：不判。
    sweepNow(fix);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    dropQueue(fix, fix.engineer.id, job.id);
    sweepNow(fix);
    const items = stallItems(fix, job.id);
    expect(items).toHaveLength(1);
    const lines = items[0]!.body.split('\n');
    expect(lines[0]).toBe('林舟在执行这一步连续 3 个回合没有新文件或新证据。');
    expect(lines[1]).toMatch(/^已用 4 \/ 9 回合，交付时间 11月17日 18:00 前。$/);
    expect(lines).toHaveLength(2);
    expect(items[0]!.options).toEqual(['再提醒一次', '暂停']);
    expect(noticeRow(fix, job.id)).toMatchObject({ stallKind: 'spin' });
    expect(chiefSays(fix).at(-1)).toBe([...lines, '之后 24 小时内，不会再因为会员定价页没有进展通知你；有新进展之后重新计时。'].join('\n'));
    // 推送：条目建立时写进通知队列；10 分钟内的通知合并成一条，所以过 10 分钟整理一次之后发出，且只发一次。
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    fix.ctx.clock.advance(10 * MINUTE);
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    await flushPushQueue(fix.ctx, fix.ctx.clock.now());
    expect(pushedTitles(fix).filter(title => title === '会员定价页：没有进展')).toHaveLength(1);
  });

  it('反例：第 3 个回合有交回（有事件）：不通知', async () => {
    const s = await started();
    const { fix, job, info } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await engineerTurns(fix, 1);
    await waitForPacket(fix, fix.engineer.id, 30);
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    dropQueue(fix, fix.engineer.id, job.id);
    dropQueue(fix, fix.reviewer.id, job.id);
    sweepNow(fix);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), null)).toBe(0);
  });

  it('员工在这件事的两个回合之间做了一次复盘（技能类回合）：不进 jobUsage.turns，不影响空转的计数', async () => {
    const s = await started();
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await engineerTurns(fix, 1);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), null)).toBe(2);
    // 复盘回合：带这件事的编号，但事项键是复盘的。它不计入这件事的回合。
    const wake = addWake(fix.ctx, { jobId: job.id, startedAt: fix.ctx.clock.now() }, fix.engineer.id);
    recordJobTurn(fix.ctx, { ...wake, reason: { ...wake.reason, kind: 'reflection' }, subjectKey: retroSubjectKey('skr_aaaaaaaaaa', fix.engineer.id) });
    expect(fix.ctx.store.table('jobUsage').get(job.id)!.turns.filter(turn => turn.botId === fix.engineer.id)).toHaveLength(2);
    await engineerTurns(fix, 1);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), null)).toBe(3);
  });

  it('已经为空转通知过的：只数通知之后结束的回合（同一批回合不会再算一次）', async () => {
    const s = await started();
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await engineerTurns(fix, 2);
    const ended = fix.ctx.store.table('jobUsage').get(job.id)!.turns.filter(turn => turn.botId === fix.engineer.id);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), null)).toBe(3);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), ended.at(-1)!.endedAt! - 1)).toBe(1);
    expect(spinRunOf(fix.ctx, job.id, fix.engineer.id, eventsOf(fix.ctx, job.id), ended.at(-1)!.endedAt!)).toBe(0);
  });
});

describe('3 逾期', () => {
  /** 林舟的候选排着，交付时间设成 30 分钟之后（逾期不受「有回合在排」的排除）。 */
  async function dueSoon() {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const dueAt = fix.ctx.clock.now() + 30 * MINUTE;
    fix.ctx.store.table('jobs').patch(job.id, { dueAt });
    return { fix, job, dueAt };
  }

  it('交付时间到、执行中：通知一次，标题与末行按逾期写；有新记录条目不撤回；同一交付时间不再通知；改了交付时间后旧条目撤回、到新的交付时间再通知', async () => {
    const { fix, job, dueAt } = await dueSoon();
    advanceSweeping(fix, 20 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    advanceSweeping(fix, 10 * MINUTE);
    const items = stallItems(fix, job.id);
    expect(items).toHaveLength(1);
    const dueText = `${localParts(dueAt, fix.ctx.settings.timezone).month}月${localParts(dueAt, fix.ctx.settings.timezone).day}日 ${hhmm(fix, dueAt)} 前`;
    expect(items[0]!.body.split('\n')).toEqual([`已过交付时间（${dueText}），现在待开工，在等林舟。`, `已用 1 / 9 回合。`]);
    // P76r3（R2、R10 第 3 点）：逾期写「已过交付时间」，私聊末行写「同一个交付时间只通知这一次」。
    expect(items[0]!.title).toBe('会员定价页：已过交付时间');
    expect(noticeRow(fix, job.id)).toMatchObject({ stallKind: 'overdue', overdueNotifiedFor: dueAt });
    expect(chiefSays(fix).at(-1)!.split('\n').at(-1)).toBe('同一个交付时间只通知这一次。');
    // P76r3（R2）：逾期之后这件事照常在做，有新记录（别的事件）时条目仍开着，同一交付时间不再通知。
    fix.ctx.clock.advance(MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: 'hub', kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    advanceSweeping(fix, 10 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    expect(stallItems(fix, job.id)[0]).toMatchObject({ status: 'open' });
    expect(noticeRow(fix, job.id)!.overdueNotifiedFor).toBe(dueAt);
    // 隔一天（候选一直排着，所以不判停摆、空转）：同一个交付时间仍然不通知。
    advanceSweeping(fix, 24 * HOUR);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    // 改了交付时间：旧条目撤回，答复栏逐字「交付时间已改」。
    const nextDue = fix.ctx.clock.now() + 20 * MINUTE;
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: nextDue });
    advanceSweeping(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('inbox').get(items[0]!.id)).toMatchObject({ status: 'withdrawn', answer: '交付时间已改' });
    expect(theJob(fix).inboxId).toBeNull();
    // 到新的交付时间：隔了 24 小时、之后有新记录，再通知一次。
    advanceSweeping(fix, 15 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(2);
    expect(stallItems(fix, job.id)[1]).toMatchObject({ status: 'open' });
    expect(noticeRow(fix, job.id)!.overdueNotifiedFor).toBe(nextDue);
  });

  it('逾期通知之后这件事照常往下做：「没有进展」条目开着，执行者仍能拿到回合；条目不因新记录撤回（P76r3，R2），待你验收时才被验收条目取代', async () => {
    const { fix, job } = await dueSoon();
    advanceSweeping(fix, 30 * MINUTE);
    const [item] = stallItems(fix, job.id);
    expect(item).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
    expect(theJob(fix).inboxId).toBe(item!.id);
    // 排着的候选没有被「在等你」拦住：执行者拿到回合，只用唤醒包里的文字交回成功。
    const packet = await waitForPacket(fix, fix.engineer.id, 30);
    expect(runningOf(fix, fix.engineer.id)).toBeDefined();
    const info = executorInfo(packet);
    await putStandardFiles(fix, info);
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 有了新记录（交回）：逾期的条目不撤回，编号仍指向它（R2：新进展不等于交付时间的问题解决了）。
    await advanceTicking(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'open' });
    expect(theJob(fix).inboxId).toBe(item!.id);
  });

  it('待你验收时不通知（在等你）', async () => {
    const { fix, job } = await dueSoon();
    fix.ctx.store.table('jobs').patch(job.id, { state: 'awaiting_owner', deliveredAt: fix.ctx.clock.now() });
    advanceSweeping(fix, 40 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(checkNow(fix, job.id)).toMatchObject({ kind: null, reason: 'waiting_owner' });
  });
});

describe('4 不算停滞的各种情形：返回原因码，什么都不做', () => {
  /** 从一开始就处在这种情形里，推进 2 小时 10 分钟、每步 10 分钟巡检：没有重新唤醒、没有条目；最后一次判断返回这个原因码。 */
  async function holds(fix: JobFix, jobId: string, reason: string): Promise<void> {
    advanceSweeping(fix, 130 * MINUTE);
    expect(checkNow(fix, jobId)).toMatchObject({ kind: null, reason, action: 'none' });
    expect(idleResumes(fix, jobId)).toBe(0);
    expect(stallItems(fix, jobId)).toHaveLength(0);
  }

  it('waiting_owner：job.inboxId 指向开着的条目', async () => {
    const { fix, job } = await brokenRelay();
    const item = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '验收', body: '请验收', options: ['验收通过'], defaultOption: null,
      expiresAt: null, priority: 'P1', refId: job.id, subjectKey: `job:${job.id}:accept:1` });
    fix.ctx.store.table('jobs').patch(job.id, { inboxId: item.id });
    await holds(fix, job.id, 'waiting_owner');
  });

  it('waiting_owner：你已暂停 / 约定新版本在等确认 / 待你验收（纯函数判断，每种各一例）', () => {
    const base = { now: 10 * HOUR, actor: 'b_aaaaaaaaaa', waitingOwner: false, quotaBlocked: false, actorOnDuty: true, actorQueued: false,
      actorRunning: false, lastProgressAt: 0, overdueNotifiedFor: null, spinRun: () => 0 };
    const job = { state: 'doing', blocked: null, escalation: null, dueAt: null, turnsUsed: 1, turnCap: 8, pause: null, openAsk: null, stage: 1,
      launch: { state: 'none', link: null } } as unknown as StallInput['job'];
    const run = (patch: Record<string, unknown>) => stallOf({ ...base, job: { ...job, ...patch } as StallInput['job'] });
    expect(run({})).toEqual({ kind: 'idle', reason: null });
    expect(run({ pause: { versionNo: 2, paused: [], executorWaiting: false } })).toEqual({ kind: null, reason: 'waiting_owner' });
    expect(run({ state: 'awaiting_owner' })).toEqual({ kind: null, reason: 'waiting_owner' });
    // 执行者的提问已转成约定新版本、在等你确认（openAsk 带版本号，同时 pause 记着是第几版）。
    expect(run({ pause: { versionNo: 2, paused: [], executorWaiting: false }, openAsk: { fromId: 'b_x', eventId: 'e', text: 'q', agreementNo: 2 } })).toEqual({ kind: null, reason: 'waiting_owner' });
    expect(run({ blocked: { kind: 'review_limit', no: 1, text: 'x', since: 1, resumeTo: 'rework' }, state: 'blocked' })).toEqual({ kind: 'idle', reason: null });
  });

  it('budget：预算线已用完（最后一个回合还在跑，巡检不动它；判断返回 budget）', async () => {
    const s = await started();
    const { fix, job } = s;
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    advanceSweeping(fix, 130 * MINUTE);
    expect(checkNow(fix, job.id)).toMatchObject({ kind: null, reason: 'budget', action: 'none' });
    expect(idleResumes(fix, job.id)).toBe(0);
    expect(stallItems(fix, job.id)).toHaveLength(0);
  });

  it('quota：员工份额用完的红灯，执行者的候选被额度拦住（候选还排着）', async () => {
    const { fix, job } = await brokenRelay();
    const now = fix.ctx.clock.now();
    const windowStartAt = now - HOUR;
    fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null, light: 'red',
      redUntil: now + 4 * HOUR, probeAllowed: false, lastError: null, lastErrorAt: null } as never);
    fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, windowStartAt), capacityTokens: 1_000_000, staffTokens: 700_000 });
    const entry = enqueueJobWake(fix.ctx, { job: theJob(fix), botId: fix.engineer.id, why: 'continue', eventId: null, summary: '接着做' });
    expect(entry, '候选已排上').not.toBeNull();
    await holds(fix, job.id, 'quota');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('off_duty：预期的人不在岗（含你一键停用）', async () => {
    const { fix, job } = await brokenRelay();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    await holds(fix, job.id, 'off_duty');
  });

  it('launch：这件事在发布环节', async () => {
    const { fix, job } = await brokenRelay();
    advanceSweeping(fix, 130 * MINUTE);
    const inLaunch = { ...theJob(fix), state: 'done' as const, launch: { ...theJob(fix).launch, state: 'preparing' as const } };
    expect(checkStall(fix.ctx, inLaunch, fix.ctx.clock.now(), sharedOf(fix, job.id))).toMatchObject({ kind: null, reason: 'launch', action: 'none' });
  });

  // P82（缺陷 5）：inLaunchPhase 的另外两个分支（等批准、发布没有成功）原来没有单测，各补一个正例一个反例。
  it('launch：等批准、发布没有成功也算发布环节（纯函数，各一正一反）', () => {
    const base = { now: 10 * HOUR, actor: 'b_aaaaaaaaaa', waitingOwner: false, quotaBlocked: false, actorOnDuty: true, actorQueued: false,
      actorRunning: false, lastProgressAt: 0, overdueNotifiedFor: null, spinRun: () => 0 };
    const done = { state: 'done', blocked: null, escalation: null, dueAt: null, turnsUsed: 3, turnCap: 8, pause: null, openAsk: null, stage: 1,
      launch: { state: 'approval', link: null } } as unknown as StallInput['job'];
    const run = (patch: Record<string, unknown>) => stallOf({ ...base, job: { ...done, ...patch } as StallInput['job'] });
    // 正例：发布审批在等主人批准（第二轮真实模型验证等 14 分 54 秒的正是这个状态，当时没有通知）。
    expect(run({})).toEqual({ kind: null, reason: 'launch' });
    // 反例：这件事还没验收（state 不是 done），同样的发布状态不算发布环节，按进行中的事照常判断（这里是停摆）。
    expect(run({ state: 'doing' })).toEqual({ kind: 'idle', reason: null });
    // 正例：发布没有成功（执行者还要改正重提，或交账写 blocked）。
    expect(run({ launch: { state: 'failed', link: null } })).toEqual({ kind: null, reason: 'launch' });
    // 反例：发布已经成功（不在发布环节），这件事本身也已结束：什么都不做。
    expect(run({ launch: { state: 'done', link: 'https://example.test/x' } })).toEqual({ kind: null, reason: 'not_applicable' });
  });

  it('running：预期的人有回合在跑或候选排着：停摆、空转都不判；逾期照判', async () => {
    const { fix, job } = await started();
    advanceSweeping(fix, 130 * MINUTE);
    expect(checkNow(fix, job.id)).toMatchObject({ kind: null, reason: 'running', action: 'none' });
    expect(idleResumes(fix, job.id)).toBe(0);
    // 逾期不受这一条排除：回合还在跑，也通知。
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    expect(checkNow(fix, job.id)).toMatchObject({ kind: 'overdue', action: 'notified' });
  });
});

describe('5 一次停滞只通知一次，同一件事 24 小时最多一次', () => {
  it('通知后条目被处理掉（不留记录），30 小时没有任何记录：不再重新唤醒、不再通知', async () => {
    const { fix, job } = await brokenRelay();
    await advanceTicking(fix, 120 * MINUTE);
    dropQueue(fix, fix.engineer.id, job.id);
    await advanceTicking(fix, 70 * MINUTE);
    const first = stallItems(fix, job.id);
    expect(first).toHaveLength(1);
    const resumedBefore = idleResumes(fix, job.id);
    // 把条目撤掉但不留下任何记录：只剩「前置」这一道在挡。
    fix.ctx.store.table('inbox').patch(first[0]!.id, { status: 'withdrawn' });
    fix.ctx.store.table('jobs').patch(job.id, { inboxId: null });
    holdSilent(fix, 30 * HOUR, job.id);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    expect(idleResumes(fix, job.id)).toBe(resumedBefore);
    expect(checkNow(fix, job.id)).toMatchObject({ action: 'held' });
  });

  it('有了新记录之后再停摆：重新唤醒不等 24 小时（P76r3，R4）；24 小时以内不通知，满 24 小时之后可以再通知', async () => {
    const { fix, job } = await brokenRelay();
    // 2 小时重新唤醒、被叫醒的回合没有留下任何记录（候选拿掉）、再 1 小时通知。
    holdSilent(fix, 190 * MINUTE, job.id);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    const notifiedAt = noticeRow(fix, job.id)!.stallNotifiedAt!;
    // 你答复「再提醒一次」：留下一条记录；执行者被叫醒，之后又没有动静（候选拿掉）。
    holdSilent(fix, 10 * MINUTE, job.id);
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    // 答复之后中心立刻放行了被叫醒的执行者：他的回合没有留下任何记录就结束，续排的候选拿掉。
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '还在想' });
    dropQueue(fix, fix.engineer.id, job.id);
    const resumedAfterAnswer = idleResumes(fix, job.id);
    // P76r3（R4）：24 小时以内也会重新唤醒（重新唤醒不是通知）；这时还不通知。
    holdSilent(fix, 130 * MINUTE, job.id);
    expect(idleResumes(fix, job.id), '2 小时 10 分之后重新唤醒一次，不等满 24 小时').toBe(resumedAfterAnswer + 1);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    // 满 24 小时之后：已经重新唤醒过，这一次直接再通知一处停滞（停摆）。
    holdSilent(fix, notifiedAt + 24 * HOUR + 10 * MINUTE - fix.ctx.clock.now(), job.id);
    expect(stallItems(fix, job.id)).toHaveLength(2);
    expect(stallItems(fix, job.id)[1]!.subjectKey).toBe(`job:${job.id}:stall:2`);
    expect(fix.ctx.clock.now() - notifiedAt).toBeGreaterThanOrEqual(24 * HOUR);
  });
});

describe('6 两段式：建条目失败时什么都不改', () => {
  it('建条目出错（总管记录不在了，建条目会拒绝）：不写记号、不落私聊、不推送、这件事不变', async () => {
    const { fix, job } = await brokenRelay();
    const before = theJob(fix);
    const chatBefore = chiefSays(fix).length;
    const noticeBefore = noticeRow(fix, job.id);
    const pushBefore = fix.ctx.store.table('pushQueue').list().length;
    fix.ctx.store.table('bots').remove(fix.chief.id);
    expect(() => reportStall(fix.ctx, before, 'idle', fix.ctx.clock.now() + 3 * HOUR, { actorId: fix.engineer.id })).toThrow();
    expect(noticeRow(fix, job.id)).toEqual(noticeBefore);
    expect(theJob(fix)).toEqual(before);
    expect(fix.ctx.store.table('pushQueue').list()).toHaveLength(pushBefore);
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(chiefSays(fix).length).toBe(chatBefore);
  });
});

describe('7 判断本身的小例子（纯函数）', () => {
  it('判定顺序：逾期优先于空转、空转优先于停摆；不满 2 小时不判停摆', () => {
    const base: StallInput = { now: 10 * HOUR, actor: 'b_aaaaaaaaaa', waitingOwner: false, quotaBlocked: false, actorOnDuty: true, actorQueued: false,
      actorRunning: false, lastProgressAt: 0, overdueNotifiedFor: null, spinRun: () => 3,
      job: { state: 'doing', blocked: null, escalation: null, dueAt: 9 * HOUR, turnsUsed: 1, turnCap: 8, pause: null, openAsk: null, stage: 1,
        launch: { state: 'none', link: null } } as unknown as StallInput['job'] };
    expect(stallOf(base)).toEqual({ kind: 'overdue', reason: null });
    expect(stallOf({ ...base, overdueNotifiedFor: 9 * HOUR })).toEqual({ kind: 'spin', reason: null });
    expect(stallOf({ ...base, overdueNotifiedFor: 9 * HOUR, spinRun: () => 2 })).toEqual({ kind: 'idle', reason: null });
    expect(stallOf({ ...base, overdueNotifiedFor: 9 * HOUR, spinRun: () => 2, lastProgressAt: 10 * HOUR - 119 * MINUTE })).toEqual({ kind: null, reason: null });
  });
});

describe('8 其余', () => {
  it('卡住的是总管、没有可接手的人时，选项只有两项；「没有进展」条目也能当场写一句话（P79）：话落在总管私聊并叫醒总管，条目仍开着', async () => {
    const { fix, job } = await brokenRelay();
    await advanceTicking(fix, 120 * MINUTE);
    dropQueue(fix, fix.engineer.id, job.id);
    await advanceTicking(fix, 70 * MINUTE);
    const [item] = stallItems(fix, job.id);
    expect(item).toBeDefined();
    // 夹具里没有第二位在岗、空闲的执行员工：只有两项。
    expect(item!.options).toEqual(['再提醒一次', '暂停']);
    await ownerSays(fix, fix.chief.id, '我不同意这样等，先让林舟说明一下');
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'open' });
    expect(threadMessagesOf(fix).at(-1)).toMatchObject({ from: 'owner', text: '我不同意这样等，先让林舟说明一下' });
    expect(entriesOf(fix, fix.chief.id).length + (runningOf(fix, fix.chief.id) ? 1 : 0)).toBeGreaterThan(0);
  });
});

/** 总管私聊里的全部消息（含主人说的）。 */
function threadMessagesOf(fix: JobFix) {
  return fix.ctx.store.log('thread').all().filter(row => row.thread === fix.chief.id);
}
