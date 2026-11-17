/**
 * P76g 的测试（五）：旧路径、团队信号。
 *
 * 一、第三块兜底会触发的三种情形（执行者 30 分钟无事件；执行者做不下去后总管 30 分钟无事件；总管自己核对 30 分钟无事件）：
 *    2 小时以前都没有任何动作，之后各只产生一次重新唤醒、最多一个「没有进展」条目；
 * 二、旧的函数和常量已经不存在（读源码断言）；
 * 三、团队信号：一件事的参与者受阻 25 小时不再给总管发「卡住超过 24 小时」；与一件事无关的员工受阻 25 小时照旧发。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkTeamSignals } from '../src/peer/team.js';
import { commitAndEnd, entriesOf, eventsOf, theJob } from './p74c-fixtures.js';
import { INTERNAL, engineerSubmits, started, type JobFix } from './p74d-fixtures.js';
import { MINUTE, advanceSweeping, chiefSays, holdSilent, noticeRow, stallItems } from './p76g-fixtures.js';

const HOUR = 60 * MINUTE;

/** 中心为停摆重新唤醒过几次。 */
const idleResumes = (fix: JobFix, jobId: string) => eventsOf(fix.ctx, jobId).filter(row => row.kind === 'resumed' && row.data.idle === true).length;

/**
 * 三种情形共用的断言：从最近一次记录算起，31 分钟、1 小时 50 分都没有任何动作；满 2 小时重新唤醒一次；
 * 再满 1 小时通知你，恰好一个条目；之后再过 3 小时，仍是一次重新唤醒、一个条目。botId 是预期的人。
 */
function expectNothingBeforeTwoHours(fix: JobFix, jobId: string, botId: string, lastAt: number): void {
  holdSilent(fix, lastAt + 31 * MINUTE - fix.ctx.clock.now() > 0 ? lastAt + 31 * MINUTE - fix.ctx.clock.now() : 0, jobId, botId);
  expect(idleResumes(fix, jobId)).toBe(0);
  expect(stallItems(fix, jobId)).toHaveLength(0);
  holdSilent(fix, lastAt + 110 * MINUTE - fix.ctx.clock.now(), jobId, botId);
  expect(idleResumes(fix, jobId)).toBe(0);
  expect(stallItems(fix, jobId)).toHaveLength(0);
  expect(theJob(fix).blocked?.text ?? '').not.toBe('连续两次叫醒都没有进展');
  holdSilent(fix, 10 * MINUTE, jobId, botId);
  expect(idleResumes(fix, jobId)).toBe(1);
  expect(stallItems(fix, jobId)).toHaveLength(0);
  holdSilent(fix, 60 * MINUTE, jobId, botId);
  expect(stallItems(fix, jobId)).toHaveLength(1);
  holdSilent(fix, 3 * HOUR, jobId, botId);
  expect(idleResumes(fix, jobId)).toBe(1);
  expect(stallItems(fix, jobId)).toHaveLength(1);
  const item = stallItems(fix, jobId)[0]!;
  expect(item.title + item.body).not.toMatch(INTERNAL);
}

/** 这件事现在最近一次记录的时间（最近一个不是重新唤醒的事件、或主题里最近一条消息）。 */
function lastRecordAt(fix: JobFix, jobId: string): number {
  const job = theJob(fix);
  const events = eventsOf(fix.ctx, jobId).filter(row => !(row.kind === 'resumed' && row.data.idle === true)).map(row => row.at);
  const messages = fix.ctx.store.log('thread').all().filter(row => row.thread === job.topicId).map(row => row.createdAt);
  return Math.max(job.assignedAt, ...events, ...messages);
}

describe('1 旧路径：原来的兜底会触发的三种情形', () => {
  it('执行者 30 分钟没有事件（接力断了）：2 小时以前没有任何动作；之后一次重新唤醒、一个条目', async () => {
    const s = await started();
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expectNothingBeforeTwoHours(fix, job.id, fix.engineer.id, lastRecordAt(fix, job.id));
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null });
  });

  it('执行者做不下去之后，总管 30 分钟没有事件：2 小时以前没有任何动作；之后一次重新唤醒总管、一个条目；不再转受阻叫总管', async () => {
    const s = await started();
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
    const blockedEvents = eventsOf(fix.ctx, job.id).filter(row => row.kind === 'executor_blocked').length;
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expectNothingBeforeTwoHours(fix, job.id, fix.chief.id, lastRecordAt(fix, job.id));
    // 巡检没有再把这件事「转受阻」一次：执行者做不下去的事件仍然只有一条。
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'executor_blocked')).toHaveLength(blockedEvents);
    expect(stallItems(fix, job.id)[0]!.options).toEqual(['再提醒一次', '暂停']);
  });

  it('总管自己核对，30 分钟没有事件：2 小时以前没有任何动作；之后一次重新唤醒总管、一个条目；这件事仍是核对中', async () => {
    const s = await started([], { reviewer: '总管' });
    const { fix, job, info } = s;
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', reviewerId: null });
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expectNothingBeforeTwoHours(fix, job.id, fix.chief.id, lastRecordAt(fix, job.id));
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
  });
});

describe('2 旧的函数和常量不存在', () => {
  const SRC = join(__dirname, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });

  it('src 里没有 idleResume、announceStall、IDLE_RESUME_MS、IDLE_RESUME_MAX、trailingIdleResumes', () => {
    const text = files(SRC).map(file => readFileSync(file, 'utf8')).join('\n');
    for (const gone of ['idleResume', 'announceStall', 'IDLE_RESUME_MS', 'IDLE_RESUME_MAX', 'trailingIdleResumes']) {
      expect(text.includes(gone), `${gone} 应该已经删除`).toBe(false);
    }
  });

  it('巡检不再调用 blockExecutor（它只被执行者自己报做不下去、续排空手而归、回合被中心结束三处调用）', () => {
    const users = files(SRC).filter(file => readFileSync(file, 'utf8').includes('blockExecutor(')).map(file => file.slice(SRC.length + 1));
    expect(users.sort()).toEqual(['job/chain-turn-end.ts', 'job/continue.ts', 'job/stuck.ts'].sort());
  });
});

describe('3 团队信号：一件事的参与者受阻不再给总管发「卡住超过 24 小时」', () => {
  /** 把这位员工设成「已卡住 25 小时」（受阻状态、更新时间在 25 小时前）。 */
  function blockedFor25h(fix: JobFix, botId: string): void {
    const current = fix.ctx.store.table('bots').get(botId)!;
    fix.ctx.store.table('bots').put({ ...current, activity: 'blocked', activityText: '等一个文件', updatedAt: fix.ctx.clock.now() - 25 * HOUR });
  }
  const signalsAbout = (fix: JobFix, botId: string) =>
    fix.ctx.store.log('audit').all().filter(row => row.action === 'chief_signal' && row.detail.includes(`blocked:${botId}`));

  it('执行者因一件事受阻 25 小时：不给总管发信号；与一件事无关的员工（小周）受阻 25 小时：照旧发', async () => {
    const s = await started(['小周']);
    const { fix } = s;
    const zhou = fix.extras[0]!;
    blockedFor25h(fix, fix.engineer.id);
    blockedFor25h(fix, zhou.id);
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    expect(signalsAbout(fix, fix.engineer.id)).toHaveLength(0);
    expect(signalsAbout(fix, zhou.id)).toHaveLength(1);
  });

  it('反例：这件事收尾（已停止）之后，原来的执行者受阻 25 小时又会发', async () => {
    const s = await started();
    const { fix, job } = s;
    blockedFor25h(fix, fix.engineer.id);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    expect(signalsAbout(fix, fix.engineer.id)).toHaveLength(1);
  });
});

describe('4 给主人看的文字', () => {
  it('停滞条目、总管私聊、提醒不含内部名称与英文（逾期一种）', async () => {
    const s = await started();
    const { fix, job } = s;
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() + 20 * MINUTE });
    advanceSweeping(fix, 30 * MINUTE);
    const [item] = stallItems(fix, job.id);
    expect(item).toBeDefined();
    const texts = [item!.title, item!.body, ...item!.options, ...chiefSays(fix).filter(text => text.includes('没有进展'))];
    for (const text of texts) {
      expect(text).not.toMatch(INTERNAL);
      expect(text).not.toMatch(/[A-Za-z]/);
    }
    expect(noticeRow(fix, job.id)).toMatchObject({ stallKind: 'overdue' });
  });
});
