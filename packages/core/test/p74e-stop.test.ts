/**
 * P74e 的测试（三）：停止（stop）与恢复（resume）。
 *
 * 规则：停止只能来自主人——总管只有在主人发起的回合里才能调用，并且要有主人确认的依据（这件事是主人让先停下的，
 * 或本回合的唤醒证据里有这份约定某个刚固定版本的确认消息）。停止之后这件事的全部排队唤醒被清掉、不再续排、不再兜底；
 * 恢复（只对主人让先停下的事）回到停止前的状态并叫醒该叫的一位。工具返回成功必须与事实相符。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { removeEntry } from '../src/scheduler/queue.js';
import { wakeForOwnerMessage } from '../src/outreach/thread.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { STOP_REFUSED_TEXT } from '../src/job/stop.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, jobFix, lastPacket, nextPacket, sectionOf, started, theJob, threadOf, type JobFix,
} from './p74d-fixtures.js';
import { MINUTE, commitAndEnd, tick, wakesOf } from './p74c-fixtures.js';

/** 一个让这件事处于「你让先停下」的状态：林舟结束回合，队列清空，状态转受阻（owner_hold）。used 是已用回合数。 */
async function onHold(fix: JobFix, jobId: string, used?: number): Promise<void> {
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先到这里' });
  for (const entry of fix.ctx.store.table('queue').list(row => row.jobId === jobId)) removeEntry(fix.ctx, entry.id);
  const job = fix.ctx.store.table('jobs').get(jobId)!;
  fix.ctx.store.table('jobs').put({ ...job, state: 'blocked', turnsUsed: used ?? job.turnsUsed,
    blocked: { kind: 'owner_hold', no: null, text: '回合用到上限', since: fix.ctx.clock.now(), resumeTo: 'doing' } });
}

/** 总管这件事上全部的候选和回合（不含补看）：用来断言「停止后什么都不会再发生」。 */
function jobActivity(fix: JobFix, jobId: string): number {
  return fix.ctx.store.table('queue').count(row => row.jobId === jobId)
    + fix.ctx.store.table('wakes').count(row => row.jobId === jobId);
}

/** 主人说话，总管拿到主人发起的回合；返回唤醒包里只用正则取到的 jobId。 */
async function ownerTells(fix: JobFix, text: string): Promise<string> {
  await ownerSays(fix, fix.chief.id, text);
  const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(sectionOf(lastPacket(fix, bot(fix, fix.chief.id))))?.[1];
  expect(jobId, '总管的唤醒包里应该有这件事的编号').toBeDefined();
  return jobId!;
}

describe('stop', () => {
  it('派活的那一回合里 stop 被拒（G7）：叫醒总管的是主人的「定了」，不是主人说了不做；零写入', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    const before = JSON.stringify([fix.ctx.store.table('jobs').list(), eventsOf(fix.ctx, job.id), threadOf(fix.ctx, job.topicId)]);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '自己决定停' });
    expect(result).toEqual({ ok: false, error: STOP_REFUSED_TEXT });
    expect(JSON.stringify([fix.ctx.store.table('jobs').list(), eventsOf(fix.ctx, job.id), threadOf(fix.ctx, job.topicId)])).toBe(before);
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('ready');
  });

  it('主人在这一回合的原话里说「这件事先不做了」：stop 成功，状态已停止，两句话', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    const jobId = await ownerTells(fix, '这件事先不做了');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId, reason: '你说这件事先不做了' });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '「会员定价页」已停止，队列里这件事的叫醒已全部清掉。' });
    expect(theJob(fix).state).toBe('stopped');
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '这件事已停止：你说这件事先不做了' });
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '「会员定价页」已停止。' });
  });

  it('叫醒这一回合的主人消息早于派活时间（不是派活之后主人说的）：stop 被拒；晚于派活时间才行', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    const jobId = await ownerTells(fix, '这件事先不做了');
    const later = fix.ctx.clock.now() + 60_000;
    fix.ctx.store.table('jobs').patch(job.id, { assignedAt: later });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId, reason: '你说先不做了' })).toEqual({ ok: false, error: STOP_REFUSED_TEXT });
    expect(theJob(fix).state).toBe('doing');
    fix.ctx.store.table('jobs').patch(job.id, { assignedAt: job.assignedAt });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId, reason: '你说先不做了' })).toMatchObject({ ok: true });
  });

  it('16 带 stopsJob 的版本被主人确认之后由中心停下这件事：状态已停止，队列清空，开着的条目撤回，两句话，不叫醒总管；之后时间流逝不产生任何回合；之后派活可对同一份约定重新派（P74b 规则）', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    // 主人说不做了：总管出一版写明不再做的新约定（B2），主人在私聊点「定了」确认。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    // P74f-2：这一版写 stopsJob（不用写 continuing、paused）；主人确认之后由中心直接停下这件事，不叫醒总管。
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      mode: 'revise', agreementId, changeNote: '这件事不再做', scopeOut: ['历史曲线', '这件事不再做，之前的内容都不用继续'],
      stopsJob: true, fallback: '如果还想做，回复「继续」，我撤回这次修改。',
    });
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '这件事不再做，请你确认。', { outcome: 'needs_owner' });
    fix.ctx.clock.advance(1_000);
    // 开着的「待你处理」条目（一条验收条目的形状）：停止时要撤回。
    fix.ctx.store.table('inbox').put({ id: 'i_bbbbbbbbbb', botId: fix.chief.id, type: 'question', title: '会员定价页：待你验收', body: '', options: ['验收通过'],
      defaultOption: null, priority: 'P1', refId: job.id, subjectKey: `job:${job.id}:accept:1`, status: 'open', answer: null, pushed: false,
      createdAt: fix.ctx.clock.now(), expiresAt: null, answeredAt: null } as never);
    const chiefBefore = entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length;
    expect(entriesOf(fix, fix.reviewer.id, job.id).length + wakesOf(fix, fix.reviewer.id, job.id).length).toBeGreaterThan(0);
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'stopped', blocked: null, pause: null });
    expect(theJob(fix).stoppedAt).not.toBeNull();
    // 总管没有被叫醒；队列清空（含评审甲、林舟）；开着的条目撤回；事件、两句话。
    expect(entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length).toBe(chiefBefore);
    expect(fix.ctx.store.table('queue').count(row => row.jobId === job.id)).toBe(0);
    expect(fix.ctx.store.table('inbox').get('i_bbbbbbbbbb')).toMatchObject({ status: 'withdrawn', answer: '这件事已停止' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'stopped')).toMatchObject([{ actor: 'hub', data: { via: 'agreement' } }]);
    const topicText = threadOf(fix.ctx, job.topicId).filter(row => row.text.startsWith('这件事已按约定第')).at(-1)!;
    expect(topicText).toMatchObject({ from: 'hub', kind: 'system', text: '这件事已按约定第 2 版停止，已经做出来的东西保留在项目文件夹里。' });
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '「会员定价页」已停止。' });
    expect(topicText.text + threadOf(fix.ctx, fix.chief.id).at(-1)!.text).not.toMatch(INTERNAL);
    // 之后时间流逝：这件事不产生任何回合、候选，也不续排、不兜底、不弹回合上限条目。
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已停止', reply: '已停止。' }).catch(() => undefined);
    const activity = jobActivity(fix, job.id);
    for (let i = 0; i < 8; i += 1) await tick(fix, 30 * MINUTE);
    expect(jobActivity(fix, job.id)).toBe(activity);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`) && row.status === 'open')).toHaveLength(0);
    // 林舟的回合还开着时交回、提问也被拒（已停止）。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '还做吗' })).toEqual({ ok: false, error: '这件事已停止，不能再提问' });
    // 停止之后可对同一份约定重新派活（P74b 规则）：约定仍是已固定。
    expect(fix.ctx.store.table('agreements').get(agreementId)!.state).toBe('locked');
    await ownerSays(fix, fix.chief.id, '还是接着做吧');
    const again = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId));
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(2);
  });

  it('你让先停下的事：主人说不做了，总管只用唤醒包里的 jobId 调用 stop 成功（不需要确认版本）', async () => {
    const { fix, job } = await started();
    await onHold(fix, job.id);
    const jobId = await ownerTells(fix, '这件事不做了，别再花钱了');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId, reason: '你说不做了' });
    expect(result).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('stopped');
  });

  it('非主人发起的回合、非总管、已停止的事：stop 被拒', async () => {
    const { fix, job, info } = await started();
    await onHold(fix, job.id);
    // 非总管。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '我不想做了' })).toEqual({ ok: false, error: '只有总管能停止这件事' });
    // 非主人发起的回合：给总管排一次执行链唤醒（事由）。
    const { enqueueJobWake } = await import('../src/job/chain.js');
    expect(enqueueJobWake(fix.ctx, { job: theJob(fix), botId: fix.chief.id, why: 'escalate', eventId: null, summary: '请处理' })).not.toBeNull();
    await tick(fix, 10 * MINUTE);
    const chiefRunning = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0];
    expect(chiefRunning, '总管应该拿到了执行链回合').toBeDefined();
    expect(chiefRunning!.ownerInitiated).not.toBe(true);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '自己决定停' })).toEqual({ ok: false, error: '停止这件事只能在主人发话、确认或回答叫醒的回合里进行' });
    expect(theJob(fix).state).toBe('blocked');
    expect(info.jobId).toBe(job.id);
  });
});

describe('resume', () => {
  it('17 只在主人让先停下时成功：回合用完时追加 8 个，预期的人被叫醒，恰好一位', async () => {
    // P76e：派活的预算线按预计算（首次估计是 8）；这条证明「恢复时回合用完就追加 8 个」，与线的取值无关，显式设回 16。
    const { fix, job } = await started([], { turnCap: 16 });
    await onHold(fix, job.id, 16);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', turnsUsed: 16, turnCap: 16 });
    const jobId = await ownerTells(fix, '接着做吧');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'resume', jobId });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已恢复，林舟会接着做。' });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 24, turnsUsed: 16 });
    // 恰好叫醒一位：候选只有林舟一条。
    const entries = fix.ctx.store.table('queue').list(row => row.jobId === job.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ botId: fix.engineer.id });
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '总管按你的话恢复了这件事。' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.resume === true)).toHaveLength(1);
    // 林舟真的拿到回合；之后不会因为回合上限被丢弃。
    await speak(fix, bot(fix, fix.chief.id), '已让林舟接着做。', { outcome: 'progress' });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain(`jobId 为 ${job.id}`);
    expect(theJob(fix).turnsUsed).toBe(17);
  });

  it('回合没有用完：不追加；受阻前在核对中：叫醒的是评审甲，恰好一位', async () => {
    // P76e：显式把预算线设回 16（断言「不追加、仍是 16」）。
    const { fix, job, info } = await started([], { turnCap: 16 });
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    for (const entry of fix.ctx.store.table('queue').list(row => row.jobId === job.id)) removeEntry(fix.ctx, entry.id);
    const current = fix.ctx.store.table('jobs').get(job.id)!;
    fix.ctx.store.table('jobs').put({ ...current, state: 'blocked', blocked: { kind: 'owner_hold', no: null, text: '回合用到上限', since: fix.ctx.clock.now(), resumeTo: 'checking' } });
    const jobId = await ownerTells(fix, '可以继续了');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'resume', jobId });
    expect(result).toEqual({ ok: true, text: '已恢复，评审甲会接着做。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', turnCap: 16 });
    const entries = fix.ctx.store.table('queue').list(row => row.jobId === job.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ botId: fix.reviewer.id });
  });

  it('不是主人让先停下的事、非主人发起的回合、非总管：resume 被拒，零写入', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    const jobId = await ownerTells(fix, '接着做');
    const before = JSON.stringify([fix.ctx.store.table('jobs').list(), eventsOf(fix.ctx, job.id)]);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'resume', jobId })).toEqual({ ok: false, error: '只有主人已暂停的事、或主人已为这次受阻选了办法的事才能恢复；这件事现在不是这两种状态' });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_manage', { mode: 'resume', jobId })).toEqual({ ok: false, error: '只有总管能恢复这件事' });
    expect(JSON.stringify([fix.ctx.store.table('jobs').list(), eventsOf(fix.ctx, job.id)])).toBe(before);
  });

  it('恢复时预期的人已停用：恢复被拒并恢复原状（仍是主人让先停下）', async () => {
    // P76e：显式把预算线设回 16（断言 turnCap 仍是 16）。
    const { fix, job } = await started([], { turnCap: 16 });
    await onHold(fix, job.id, 16);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const jobId = await ownerTells(fix, '接着做吧');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'resume', jobId });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('恢复失败，已恢复到之前的状态');
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, turnCap: 16 });
    expect(fix.ctx.store.table('queue').count(row => row.jobId === job.id)).toBe(0);
  });
});

describe('字段与说明', () => {
  it('stop 里写了 text、resume 里写了 reason 被拒（字段放错 mode）', async () => {
    const { fix, job } = await started();
    await onHold(fix, job.id);
    const jobId = await ownerTells(fix, '停吧');
    const stop = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId, reason: '原因', text: '多写的' });
    expect(stop.error).toContain('mode 为 stop 时不用这些字段：text');
    const resume = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'resume', jobId, reason: '多写的' });
    expect(resume.error).toContain('mode 为 resume 时不用这些字段：reason');
    expect(theJob(fix).state).toBe('blocked');
  });
});
