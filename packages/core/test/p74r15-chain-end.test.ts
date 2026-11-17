/**
 * P74r15 第 2、8 节的测试：一件事里的回合被中心结束（总时长超过 60 分钟）之后，四种回合各走一遍：
 * 执行者、普通核对人、总管自己核对、发布准备。每一组：
 * - 被叫醒的人拿到回合，只用唤醒包里的文字，把包里写的每一种做法真的调用一次工具，必须成功；
 * - 给总管的唤醒摘要、唤醒包、工作往来里的话逐字断言：被结束的是谁的回合就写谁的名字，不写「无法继续」「叫了你两次」，
 *   没有「。。」。
 * 总管自己核对这一组另测：第一次被结束不转受阻、再叫总管核对并提交成功；同一轮第二次被结束：建「没有进展」条目、
 * 总管没有再被叫醒（之后推进时钟，没有新的唤醒）。
 * 全部走真实的 Hub，事件经 onTurnEvent 进来，时间用注入的假时钟，每次推进不超过 10 分钟，推进之间给回合一个事件，
 * 证明被结束的原因是「超过 60 分钟」，不是「10 分钟没有事件」。
 */
import { describe, expect, it } from 'vitest';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { MINUTE, bot, callTool, commitAndEnd, entriesOf, runningOf, wakesOf } from './p74c-fixtures.js';
import { engineerSubmits, reviewerInfo, sectionOf, started, theJob, threadOf, tick, nextPacket, type JobFix } from './p74d-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { acceptedWithLaunch } from './p74g-launch-fixtures.js';

const TITLE = '会员定价页';

/** 给这个回合一个真实的步骤事件，再跑一次调度。 */
async function stepAndTick(fix: JobFix, botId: string): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), steps: 5, tokens: 100_000 });
  await fix.hub.tick();
}

/** 推进 ms 毫秒，每次不超过 10 分钟，每次推进之后给回合一个事件。 */
async function advanceWithEvents(fix: JobFix, botId: string, ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(10 * MINUTE, left);
    fix.ctx.clock.advance(step);
    left -= step;
    await stepAndTick(fix, botId);
  }
}

/** 这件事的主题里全部「工作往来」文字。 */
const workTexts = (fix: JobFix, topicId: string) => threadOf(fix.ctx, topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);

/** 总管最近一个唤醒的摘要（给模型看）。 */
const chiefSummary = (fix: JobFix, jobId: string) => wakesOf(fix, fix.chief.id, jobId).at(-1)!.reason.summary;

/** 这些写法出现在文字里都是错的：把别人的回合写成「做不下去」、「叫了你两次」、重复句号。 */
function expectCleanWording(text: string): void {
  expect(text).not.toContain('。。');
  expect(text).not.toContain('做不下去');
  expect(text).not.toContain('无法继续');
  expect(text).not.toContain('叫了你两次');
  expect(text).not.toContain('两次被叫醒');
}

/** 总管唤醒包「你手上的事」段里「当前在岗的员工」那一行列出的名字（只靠文字）。 */
function staffNames(text: string): string[] {
  const line = /当前在岗的员工：(.+?)。/.exec(text)?.[1];
  expect(line, '唤醒包里应该列出在岗的员工').toBeDefined();
  return [...line!.matchAll(/([^、（]+)（[^）]*）/g)].map(match => match[1]!);
}

/** 约定各部分的序号（回答时 basis 用）：只靠文字取。 */
function numbered(text: string) {
  return [...text.matchAll(/^(summary|pending|decided|scopeIn|scopeOut|doneWhen) (\d+)\. (.+)$/gm)].map(match => ({ section: match[1]!, no: Number(match[2]) }));
}

/** 总管的 hub_job_manage 调用。 */
const manage = (fix: JobFix, args: Record<string, unknown>) => callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args);

const EXECUTOR_FACT = '林舟的一个回合超过 60 分钟，中心已结束它。';
const REVIEWER_FACT = '评审甲的一个回合超过 60 分钟，中心已结束它。';
const CHIEF_FACT = '老大的一个回合超过 60 分钟，中心已结束它。';

// ---------------------------------------------------------------------------
// 执行者的回合被结束
// ---------------------------------------------------------------------------

describe('执行者的回合被结束', () => {
  /** 执行者的回合持续有事件、超过 60 分钟被结束；总管拿到回合，返回唤醒包「你手上的事」段。 */
  async function endedExecutor() {
    const s = await started(['小周']);
    await advanceWithEvents(s.fix, s.fix.engineer.id, 62 * MINUTE);
    expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: EXECUTOR_FACT } });
    const text = sectionOf(await nextPacket(s.fix, s.fix.chief.id));
    return { ...s, text };
  }

  it('话逐字：受阻说明、总管唤醒摘要、工作往来、唤醒包里写的是林舟的回合，没有「做不下去」「叫了你两次」「。。」', async () => {
    const { fix, job, text } = await endedExecutor();
    expect(chiefSummary(fix, job.id)).toBe(`「${TITLE}」：${EXECUTOR_FACT}`);
    expect(workTexts(fix, job.topicId).at(-1)).toBe(`${EXECUTOR_FACT}已告诉总管。`);
    expect(text).toContain(`\n${EXECUTOR_FACT}\n`);
    expectCleanWording(text);
    expectCleanWording(chiefSummary(fix, job.id));
    for (const line of workTexts(fix, job.topicId)) expect(line).not.toContain('。。');
  });

  it('按唤醒包的「回答」做：成功，这件事回到执行中', async () => {
    const { fix, text } = await endedExecutor();
    const how = /回答：调用 hub_job_manage，mode 写 answer，jobId 写 (job_[0-9a-z]{10})，to 写(.+?)，text 写答案/.exec(text);
    expect(how, '包里应该有「回答」的做法').not.toBeNull();
    const basis = numbered(text).find(item => item.section === 'scopeIn')!;
    const result = await manage(fix, { mode: 'answer', jobId: how![1], to: how![2], text: '接着做，先交一版', basis: [{ section: basis.section, no: basis.no }] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null });
  });

  it('按唤醒包的「换执行者」做：只用包里的名字，成功，小周被叫醒', async () => {
    const { fix, text } = await endedExecutor();
    const how = /换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字/.exec(text);
    expect(how).not.toBeNull();
    const pick = staffNames(text).find(name => name !== '林舟' && name !== '评审甲')!;
    expect(pick).toBe('小周');
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], executor: pick });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'ready', blocked: null, executorId: fix.extras[0]!.id });
  });

  it('按唤醒包的「写说明」做（向主人说明）：成功，主人看到条目', async () => {
    const { fix, text } = await endedExecutor();
    const how = /写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text);
    expect(how, '包里应该有「写说明」的做法').not.toBeNull();
    const result = await manage(fix, { mode: 'escalate', jobId: how![1], stuckAt: '林舟的回合用了很久，中心已经结束它，这件事停在执行中',
      options: [{ title: '换一位执行者', detail: '换人重做；代价是多花一轮时间' }, { title: '让林舟接着做', detail: '不换人接着做；代价是可能再次用很久' }], suggested: 0, reason: '换人风险小' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${how![1]}:escalate:`))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 普通核对人的回合被结束
// ---------------------------------------------------------------------------

describe('普通核对人的回合被结束', () => {
  /** 执行者交回，评审甲的核对回合持续有事件、超过 60 分钟被结束；总管拿到回合。 */
  async function endedReviewer() {
    const s = await started(['小周']);
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await nextPacket(s.fix, s.fix.reviewer.id);
    await advanceWithEvents(s.fix, s.fix.reviewer.id, 62 * MINUTE);
    expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'checking', text: REVIEWER_FACT } });
    const text = sectionOf(await nextPacket(s.fix, s.fix.chief.id));
    return { ...s, text };
  }

  it('话逐字：写评审甲的回合和「第 1 轮的核对结论没有提交」，没有「两次被叫醒」「做不下去」「。。」', async () => {
    const { fix, job, text } = await endedReviewer();
    expect(chiefSummary(fix, job.id)).toBe(`「${TITLE}」：${REVIEWER_FACT}`);
    expect(workTexts(fix, job.topicId).at(-1)).toBe(`${REVIEWER_FACT}已告诉总管。`);
    expect(text).toContain(`${REVIEWER_FACT}第 1 轮的核对结论没有提交。`);
    expectCleanWording(text);
    expectCleanWording(chiefSummary(fix, job.id));
  });

  it('按唤醒包的「换核对人」做：换成小周成功', async () => {
    const { fix, text } = await endedReviewer();
    const how = /换核对人：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，reviewer 写新核对人的名字；写「总管」表示由你自己核对。/.exec(text);
    expect(how, '包里应该有「换核对人」的做法').not.toBeNull();
    const pick = staffNames(text).find(name => name !== '林舟' && name !== '评审甲')!;
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], reviewer: pick });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, reviewerId: fix.extras[0]!.id });
  });

  it('按唤醒包的「换核对人」做：写「总管」表示自己核对，成功，之后总管能提交核对结论', async () => {
    const { fix, text } = await endedReviewer();
    const how = /换核对人：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，reviewer 写新核对人的名字；写「总管」表示由你自己核对。/.exec(text);
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], reviewer: '总管' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已改派' });
    const seen = reviewerInfo(await nextPacket(fix, fix.chief.id));
    const reviewed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 总管自己核对时，总管的核对回合被结束
// ---------------------------------------------------------------------------

describe('总管自己核对：核对回合被结束', () => {
  /** 核对人写「总管」；执行者交回，总管拿到核对回合，之后一直有事件、超过 60 分钟被结束。 */
  async function chiefReviewing() {
    const s = await started([], { reviewer: '总管' });
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.chief.id));
    return { ...s, seen };
  }

  it('第一次被结束：这件事不转受阻，仍在核对中；再叫总管核对一次（摘要逐字），总管提交核对结论成功', async () => {
    const { fix, job, seen } = await chiefReviewing();
    const first = runningOf(fix, fix.chief.id)!;
    await advanceWithEvents(fix, fix.chief.id, 62 * MINUTE);
    // 第一个核对回合被结束；这件事没有转受阻（再叫总管的回合可能已经开始，所以不断言「没有在跑的回合」）。
    expect(fix.ctx.store.table('wakes').get(first.id)).toMatchObject({ status: 'timeout', error: '回合超过 60 分钟，中心已结束本回合' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, round: 1 });
    expect(chiefSummary(fix, job.id)).not.toContain('做不下去');
    // 总管再被叫醒一次来核对：摘要逐字。
    const again = reviewerInfo(await nextPacket(fix, fix.chief.id));
    expect(again.jobId).toBe(seen.jobId);
    expect(wakesOf(fix, fix.chief.id, job.id).at(-1)!.reason.summary).toBe(`「${TITLE}」第 1 轮的核对：${CHIEF_FACT}请重新核对，对照约定逐条提交核对结论。`);
    const reviewed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: again.jobId, items: PASS_ITEMS });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    for (const line of workTexts(fix, job.topicId)) expect(line).not.toContain('。。');
  });

  it('同一轮第二次被结束：建「没有进展」条目（正文逐字、写事实），不再叫醒总管', async () => {
    const { fix, job } = await chiefReviewing();
    await advanceWithEvents(fix, fix.chief.id, 62 * MINUTE);
    await nextPacket(fix, fix.chief.id);
    const turnsBefore = wakesOf(fix, fix.chief.id, job.id).length;
    await advanceWithEvents(fix, fix.chief.id, 62 * MINUTE);
    expect(runningOf(fix, fix.chief.id)).toBeUndefined();
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
    const items = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:stall:`));
    expect(items).toHaveLength(1);
    const text = '老大的核对回合在第 1 轮里已被中心结束两次（最近一次：超过 60 分钟），中心不再自动叫醒老大。';
    expect(items[0]).toMatchObject({ title: `${TITLE}：没有进展`, body: text });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === 'hub' && row.text === `「${TITLE}」停住了：${text}已在「待你处理」里放了一条，请你决定。`)).toBe(true);
    // P76r3（R4）：停摆的重新唤醒不受 24 小时通知间隔限制。之后推进 2 小时（每次 10 分钟）：中心再叫醒总管一次；
    // 已有开着的「没有进展」条目，不再建新的条目（乙成立时不发新的停滞通知）。
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(turnsBefore);
    for (let i = 0; i < 12; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(turnsBefore + 1);
    expect(wakesOf(fix, fix.chief.id, job.id).at(-1)!.reason.summary).toContain('已有一阵子没有动静');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:stall:`))).toHaveLength(1);
  });

  it('反例：第二次被结束之后主人选「再提醒一次」，总管被叫醒、能提交核对结论；条目随之答复', async () => {
    const { fix, job } = await chiefReviewing();
    await advanceWithEvents(fix, fix.chief.id, 62 * MINUTE);
    await nextPacket(fix, fix.chief.id);
    await advanceWithEvents(fix, fix.chief.id, 62 * MINUTE);
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    const seen = reviewerInfo(await nextPacket(fix, fix.chief.id));
    const reviewed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 发布准备的回合被结束
// ---------------------------------------------------------------------------

describe('发布准备的回合被结束', () => {
  it('这件事不转受阻，发布这一步由中心结束（进度行写没有发布），总管私聊一句逐字，没有人被叫醒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await advanceWithEvents(fix, fix.engineer.id, 62 * MINUTE);
    expect(runningOf(fix, fix.engineer.id)).toBeUndefined();
    expect(theJob(fix)).toMatchObject({ state: 'done', blocked: null, launch: { state: 'declined', endedBy: 'hub' } });
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').at(-1)!.text)
      .toBe(`林舟准备发布「${TITLE}」的回合超过 60 分钟，中心已结束它，这次没有发布。`);
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBe('没有发布');
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.jobId === job.id).at(-1)).toMatchObject({ status: 'timeout' });
    // 没有重试、总管没有被叫醒。
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    const chiefWakes = wakesOf(fix, fix.chief.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(chiefWakes);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
  });
});
