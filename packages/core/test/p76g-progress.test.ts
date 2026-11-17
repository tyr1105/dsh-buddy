/**
 * P76g 的测试（一）：「记录」（job/progress-mark.ts）。
 *
 * 一件事「有没有动静」只看记录：这件事的任一事件、这件事主题里的任一条消息、派活时间，取最晚的；
 * 中心自己的重新唤醒事件不算记录。巡检时现算、写进 jobNotices.lastProgressAt；新记录比 rewakeAt 新就清空 rewakeAt 与 stallKind。
 */
import { describe, expect, it } from 'vitest';
import { lastProgressAtOf } from '../src/job/progress-mark.js';
import { appendJobEvent } from '../src/job/store.js';
import { postThread } from '../src/outreach/thread.js';
import type { JobEvent } from '../src/model/job.js';
import { theJob } from './p74c-fixtures.js';
import { advanceSweeping, brokenRelay, noticeRow, sweepNow, MINUTE } from './p76g-fixtures.js';

const event = (at: number, kind: JobEvent['kind'], data: Record<string, unknown> = {}): JobEvent =>
  ({ id: `jev_${String(at).padStart(10, '0').slice(-10)}`, jobId: 'job_aaaaaaaaaa', at, actor: 'hub', kind, to: [], refId: null, data });

describe('1 记录：纯函数', () => {
  const job = { assignedAt: 1_000 };

  it('没有事件、没有消息时取派活时间', () => {
    expect(lastProgressAtOf(job, [], [])).toBe(1_000);
  });

  it('事件、主题消息各算：取最晚的一个', () => {
    expect(lastProgressAtOf(job, [event(5_000, 'submitted')], [])).toBe(5_000);
    expect(lastProgressAtOf(job, [], [{ createdAt: 7_000 }])).toBe(7_000);
    expect(lastProgressAtOf(job, [event(5_000, 'submitted'), event(3_000, 'asked')], [{ createdAt: 4_000 }, { createdAt: 6_000 }])).toBe(6_000);
    expect(lastProgressAtOf(job, [event(9_000, 'reviewed')], [{ createdAt: 6_000 }])).toBe(9_000);
  });

  it('中心的重新唤醒事件（resumed 且 data.idle 为真）不算；别的 resumed 事件（续排、主人的「再提醒一次」）算', () => {
    expect(lastProgressAtOf(job, [event(5_000, 'submitted'), event(8_000, 'resumed', { idle: true })], [])).toBe(5_000);
    expect(lastProgressAtOf(job, [event(5_000, 'submitted'), event(8_000, 'resumed', { continue: true })], [])).toBe(8_000);
    expect(lastProgressAtOf(job, [event(5_000, 'submitted'), event(8_000, 'resumed', { retry: true })], [])).toBe(8_000);
  });
});

describe('2 记录：写进提醒记号，新记录让计时重新开始', () => {
  it('巡检时现算写进 jobNotices.lastProgressAt；事件、主题消息各让它变新；重新唤醒的事件不让它变新', async () => {
    const { fix, job } = await brokenRelay();
    sweepNow(fix);
    // 还没有比派活更新的记录时不写这一行（读的人按默认值取派活时间）。
    const first = noticeRow(fix, job.id)?.lastProgressAt ?? job.assignedAt;
    expect(first).toBeGreaterThanOrEqual(job.assignedAt);
    // 一条事件：变新。
    advanceSweeping(fix, 10 * MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    sweepNow(fix);
    const second = noticeRow(fix, job.id)!.lastProgressAt;
    expect(second).toBe(fix.ctx.clock.now());
    expect(second).toBeGreaterThan(first);
    // 一条主题消息（主人的话也算）：变新。
    advanceSweeping(fix, 10 * MINUTE);
    postThread(fix.ctx, { thread: theJob(fix).topicId, from: 'owner', kind: 'chat', text: '进展怎么样？' });
    sweepNow(fix);
    const third = noticeRow(fix, job.id)!.lastProgressAt;
    expect(third).toBe(fix.ctx.clock.now());
    // 重新唤醒的事件：不变（从最近一次真正的记录算起满 2 小时才会有）。
    advanceSweeping(fix, 120 * MINUTE);
    expect(noticeRow(fix, job.id)!.rewakeAt).not.toBeNull();
    expect(noticeRow(fix, job.id)!.lastProgressAt).toBe(third);
  });

  it('有了比 rewakeAt 新的记录：rewakeAt 与 stallKind 清空，计时重新开始；记录不比 rewakeAt 新时保持', async () => {
    const { fix, job } = await brokenRelay();
    advanceSweeping(fix, 130 * MINUTE);
    const rewakeAt = noticeRow(fix, job.id)!.rewakeAt!;
    expect(rewakeAt).toBeGreaterThan(0);
    fix.ctx.store.table('jobNotices').patch(job.id, { stallKind: 'idle' });
    // 与 rewakeAt 同一时刻的记录不算「比 rewakeAt 新」。
    for (const entry of fix.ctx.store.table('queue').list(row => row.jobId === job.id)) fix.ctx.store.table('queue').remove(entry.id);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    fix.ctx.store.table('jobNotices').patch(job.id, { rewakeAt: fix.ctx.clock.now() });
    sweepNow(fix);
    expect(noticeRow(fix, job.id)).toMatchObject({ rewakeAt: fix.ctx.clock.now(), stallKind: 'idle' });
    // 之后有了更新的记录：清空。
    advanceSweeping(fix, 10 * MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null, data: {} });
    sweepNow(fix);
    expect(noticeRow(fix, job.id)).toMatchObject({ rewakeAt: null, stallKind: null });
  });
});
