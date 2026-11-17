/**
 * P74r16b 第 2 节的测试：进度行写事实。
 *
 * 2.1 一件事的状态一变，就通知这件事所在的主题刷新（thread 范围，对象是主题编号）：员工被停用、恢复在岗、执行者的回合开始各一条；
 *     另有反例：只改计数、不影响进度行的写入不发事件；
 * 2.2「在等谁」：参与者被停用而受阻写「{名字}（已停用）」，这时总管也不在岗写「你」，其余情形不变；
 * 2.3「排队中」：只在队列里确实有这个人、这件事的候选时才写。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { waitingOnOf } from '../src/api/job-views.js';
import { quarantine } from '../src/health/quarantine.js';
import { jobDelayNote } from '../src/job/delay.js';
import { putJob } from '../src/job/store.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { assigned, entriesOf, MINUTE, runningJob, tick } from './p74c-fixtures.js';
import { jobFix, speak, type JobFix } from './p74b-fixtures.js';

/** 这个测试环境里收集到的界面刷新事件（直接调用核心函数时记在 ctx.events 里）。 */
type Seen = Array<{ scope: string; botId: string | null }>;
const eventsOf = (fix: JobFix): Seen => (fix.ctx as unknown as { events: Seen }).events;
const hasTopicEvent = (events: Seen, topicId: string): boolean => events.some(row => row.scope === 'thread' && row.botId === topicId);

describe('2.1 状态一变就通知主题刷新', () => {
  it('员工被停用：发出这件事所在主题的刷新事件', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    eventsOf(fix).length = 0;
    quarantine(fix.ctx, fix.engineer.id, '越界尝试达到 3 次');
    expect(hasTopicEvent(eventsOf(fix), job.topicId)).toBe(true);
  });

  it('恢复在岗：发出这件事所在主题的刷新事件', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    quarantine(fix.ctx, fix.engineer.id, '越界尝试达到 3 次');
    eventsOf(fix).length = 0;
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(hasTopicEvent(eventsOf(fix), job.topicId)).toBe(true);
  });

  it('执行者的回合开始：发出这件事所在主题的刷新事件（走真实的调度，订阅 Hub 的推送）', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    await speak(fix, fix.chief, '这件事由林舟执行。', { outcome: 'progress' });
    // 这件事已经是「执行中」（例如上一回合已经开工）：这一回合开始时状态没有变，只有回合开始这件事本身要通知界面。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'doing', startedAt: fix.ctx.clock.now() });
    const seen: Seen = [];
    fix.hub.subscribe(event => { seen.push({ scope: event.scope, botId: event.botId }); });
    await tick(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.jobId === job.id)).toHaveLength(1);
    expect(hasTopicEvent(seen, job.topicId)).toBe(true);
  });

  it('反例：只改计数（不影响进度行）的写入不发这个主题的事件；状态变了才发', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    eventsOf(fix).length = 0;
    putJob(fix.ctx, { ...job, turnsUsed: job.turnsUsed + 1, disturbCount: 3 });
    expect(hasTopicEvent(eventsOf(fix), job.topicId)).toBe(false);
    putJob(fix.ctx, { ...job, state: 'checking', round: 1 });
    expect(hasTopicEvent(eventsOf(fix), job.topicId)).toBe(true);
  });
});

describe('2.2 在等谁', () => {
  it('纯函数：参与者停用而受阻写「{名字}（已停用）」；总管也不在岗写「你」；没有人不在岗仍写「总管」', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const blocked = { ...job, state: 'blocked' as const, blocked: { kind: 'participant_off' as const, no: null, text: '林舟已停用', resumeTo: 'doing' as const, since: 1 } };
    const names = { [fix.engineer.id]: '林舟', [fix.reviewer.id]: '评审甲', [fix.chief.id]: '老大' };
    expect(waitingOnOf(blocked, names, new Set([fix.engineer.id]))).toBe('林舟（已停用）');
    expect(waitingOnOf(blocked, names, new Set([fix.reviewer.id]))).toBe('评审甲（已停用）');
    expect(waitingOnOf(blocked, names, new Set([fix.engineer.id, fix.chief.id]))).toBe('你');
    // 其余情形不变：没有人不在岗（旧数据、其他受阻原因）仍是总管；执行者做不下去仍是总管。
    expect(waitingOnOf(blocked, names, new Set())).toBe('总管');
    expect(waitingOnOf({ ...blocked, blocked: { ...blocked.blocked, kind: 'executor' as const } }, names, new Set([fix.engineer.id]))).toBe('总管');
    // 总管不在岗但参与者都在岗：不算这一种，不变。
    expect(waitingOnOf(blocked, names, new Set([fix.chief.id]))).toBe('总管');
  });

  it('真实路径：执行者被中心停用，主题进度行写「林舟（已停用）」；总管也停用后写「你」；恢复后回到执行者', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    quarantine(fix.ctx, fix.engineer.id, '越界尝试达到 3 次');
    const progress = jobProgressForTopic(fix.ctx, job.topicId)!;
    expect(progress.stateLabel).toBe('受阻');
    expect(progress.waitingOn).toBe('林舟（已停用）');
    // 总管也被主人停用：只能等主人。
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'paused' });
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('你');
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'active' });
    // 恢复在岗：这件事接着做，在等的又是执行者本人。
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟');
  });

  it('核对人被停用：写「评审甲（已停用）」', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'checking', round: 1 });
    quarantine(fix.ctx, fix.reviewer.id, '越界尝试达到 3 次');
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('评审甲（已停用）');
  });
});

describe('2.3 排队中', () => {
  /** 派活后、候选还排着、总管的回合结束：10 分钟已过。 */
  async function queued() {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    fix.ctx.clock.advance(10 * MINUTE);
    // 启动不久：候选被「启动静默」拦着，确实在排队。
    fix.ctx.runtime.startedAt = fix.ctx.clock.now() - MINUTE;
    return { fix, job: fix.ctx.store.table('jobs').get(job.id)! };
  }

  it('正例：队列里有执行者在这件事上的候选（被拦着），写「排队中」，进度行上也有', async () => {
    const { fix, job } = await queued();
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(jobDelayNote(fix.ctx, job, fix.ctx.clock.now())).toBe('排队中');
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBe('排队中');
  });

  it('反例：队列里没有这个人、这件事的候选，不写「排队中」；只有别人的候选也不写', async () => {
    const { fix, job } = await queued();
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expect(jobDelayNote(fix.ctx, job, fix.ctx.clock.now())).toBeNull();
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBeNull();
    // 总管在这件事上有候选，但这件事此刻在等执行者：仍不写。
    expect(enqueueJobWake(fix.ctx, { job, botId: fix.chief.id, why: 'continue', eventId: null, summary: '总管这件事上的另一条候选' })).not.toBeNull();
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    expect(jobDelayNote(fix.ctx, job, fix.ctx.clock.now())).toBeNull();
  });
});
