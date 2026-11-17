/**
 * P74r7 第 2 节（含追加的第 7 条）的测试：发布这一步做不成时的收尾，以及「暂不发布」按是谁结束的分别显示。
 * 走真实 Hub、真实工具、假时钟（每次推进不超过 10 分钟）：
 * - 发布准备回合以做不下去交账：发布状态变为暂不发布、总管私聊那句逐字相同（两种文字各一条）、之后没有人被叫醒、待你处理没有条目；
 * - 交账写还没做完：接着排下一回合，不会停在准备中；
 * - 兜底 30 分钟；唤醒包里有新增的那句；提问被拒的文字；
 * - 第 7 条：主人拒绝审批写「你暂不发布」，中心结束的各种情形写「没有发布」。
 */
import { describe, expect, it } from 'vitest';
import { jobProgressView } from '../src/api/job-views.js';
import { launchBlockedText, LAUNCH_ASK_REFUSAL_TEXT } from '../src/job/launch-blocked.js';
import { launchCapText } from '../src/job/launch-approval.js';
import { commitAndEnd, entriesOf, wakesOf } from './p74c-fixtures.js';
import { bot, callTool, delivered, nextPacket, sectionOf, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';
import { jobFixture } from './p74a-job-fixtures.js';
import { NOW } from './p74a-job-fixtures.js';

const TAIL = '没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。';

/** 总管私聊里，总管名义落下的、含「发布这一步没有做成」的话。 */
function blockedSays(fix: JobFix): string[] {
  return threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text.includes('发布这一步没有做成')).map(row => row.text);
}

/** 这件事「待你处理」里还开着的条目数。 */
function openItems(fix: JobFix, jobId: string): number {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:`)).length;
}

/** 林舟拿到发布准备的回合，以做不下去（blocked）交账。 */
async function blockedLaunch(blocker: string) {
  const { fix, job } = await acceptedWithLaunch();
  await nextPacket(fix, fix.engineer.id);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker, summary: '没有发布目标' });
  return { fix, job };
}

describe('发布准备的回合以做不下去交账', () => {
  it('原因通过内部名称检查：暂不发布，总管私聊那句逐字相同，之后没有人被叫醒，待你处理没有条目', async () => {
    const { fix, job } = await blockedLaunch('约定里没有写发布到哪里');
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    expect(blockedSays(fix)).toEqual([`会员定价页的发布这一步没有做成：林舟说缺少条件（约定里没有写发布到哪里）。${TAIL}`]);
    const wakes = wakesOf(fix, fix.engineer.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.chief.id)).toHaveLength(0);
    expect(openItems(fix, job.id)).toBe(0);
    expect(blockedSays(fix)).toHaveLength(1);
  });

  it('原因含内部名称：不写原因，另一种文字逐字相同', async () => {
    const { fix } = await blockedLaunch('hub_job_work 提问又因事项已完成被系统拒绝');
    expect(theJob(fix)).toMatchObject({ launch: { state: 'declined', endedBy: 'hub' } });
    expect(blockedSays(fix)).toEqual([`会员定价页的发布这一步没有做成：林舟说缺少条件。${TAIL}`]);
  });

  it('原因超过 80 字：截断加省略号', () => {
    const long = '缺'.repeat(100);
    expect(launchBlockedText({ title: '会员定价页', executor: '林舟', reason: long }))
      .toBe(`会员定价页的发布这一步没有做成：林舟说缺少条件（${'缺'.repeat(80)}…）。${TAIL}`);
    expect(launchBlockedText({ title: '会员定价页', executor: '林舟', reason: '' })).toBe(`会员定价页的发布这一步没有做成：林舟说缺少条件。${TAIL}`);
  });
});

describe('发布准备的回合以还没做完交账', () => {
  it('接着排下一回合，不会停在准备中；用满发布这一步的回合上限后仍是已有的那一句结束语', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '还在准备发布' });
    expect(theJob(fix).launch.state).toBe('preparing');
    // 下一回合已排上：林舟能拿到发布准备的唤醒包。
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain('主人已验收。下一步是对外发布');
    for (let turn = 2; turn <= 4; turn += 1) {
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: `第 ${turn} 次，没有进展` });
      if (turn < 4) await nextPacket(fix, fix.engineer.id);
    }
    await tick(fix, 10 * MINUTE);
    expect(theJob(fix)).toMatchObject({ launch: { state: 'declined', endedBy: 'hub' } });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text === launchCapText('no_approval', { title: '会员定价页', turns: 4, executor: '林舟' }))).toBe(true);
    expect(blockedSays(fix)).toHaveLength(0);
    expect(job.id).toBe(theJob(fix).id);
  });
});

describe('兜底：发布准备中没有人被排着', () => {
  it('29 分钟不结束；超过 30 分钟按不带原因的文字结束', async () => {
    const { fix } = await acceptedWithLaunch();
    // 验收时排上的唤醒撤掉，模拟「没有排着的唤醒、也不在回合中」。
    for (const entry of entriesOf(fix, fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    await tick(fix, 10 * MINUTE);
    await tick(fix, 10 * MINUTE);
    await tick(fix, 9 * MINUTE);
    expect(theJob(fix).launch.state).toBe('preparing');
    expect(blockedSays(fix)).toHaveLength(0);
    await tick(fix, 2 * MINUTE);
    expect(theJob(fix)).toMatchObject({ launch: { state: 'declined', endedBy: 'hub' } });
    expect(blockedSays(fix)).toEqual([`会员定价页的发布这一步没有做成：林舟说缺少条件。${TAIL}`]);
  });

  it('反例：执行者正在回合中（还没交账）时不兜底', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    for (let i = 0; i < 4; i += 1) await tick(fix, 9 * MINUTE);
    expect(theJob(fix).launch.state).toBe('preparing');
    expect(blockedSays(fix)).toHaveLength(0);
  });

  it('反例：执行者已提交发布审批（等批准）时不兜底', async () => {
    const { fix } = await acceptedWithLaunch();
    await submitLaunch(fix);
    for (let i = 0; i < 4; i += 1) await tick(fix, 9 * MINUTE);
    expect(theJob(fix).launch.state).toBe('approval');
    expect(blockedSays(fix)).toHaveLength(0);
  });
});

describe('唤醒包与提问被拒', () => {
  it('发布准备的唤醒包里有新增那句', async () => {
    const { fix } = await acceptedWithLaunch();
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(
      '约定和材料里没有写发布到哪里、用什么方式时：不要猜，也不要提问。交账的结果写 blocked，blocker 写清缺什么；中心会转告主人，这一步到此结束。');
  });

  it('发布准备中提问被拒：文字逐字相同；这件事已完成但不在发布准备时仍是原来的文字', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '发布到哪里？' });
    expect(refused).toEqual({ ok: false, error: '这件事已完成，不能再提问。发布缺条件时，交账的结果写 blocked，blocker 写清缺什么，中心会转告主人。' });
    expect(LAUNCH_ASK_REFUSAL_TEXT).toBe('这件事已完成，不能再提问。发布缺条件时，交账的结果写 blocked，blocker 写清缺什么，中心会转告主人。');
    fix.ctx.store.table('jobs').patch(job.id, { launch: { state: 'done', approvalId: null, link: null } });
    const other = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '还有事吗？' });
    expect(other).toEqual({ ok: false, error: '这件事已完成，不能再提问' });
  });
});

describe('第 7 条：暂不发布按是谁结束的显示', () => {
  const noteOf = (job: ReturnType<typeof jobFixture>) => jobProgressView({
    agreementState: 'locked', agreementVersionNo: 1, job, names: {}, delayNote: null, now: NOW, timezone: 'Asia/Shanghai',
  })!.delayNote;
  const declined = (endedBy?: 'owner' | 'hub') => jobFixture({ state: 'done', launchStep: true, launch: { state: 'declined', approvalId: null, link: null, ...(endedBy ? { endedBy } : {}) } });

  it('视图：主人结束、旧数据（没有这个字段）写「你暂不发布」；中心结束写「没有发布」', () => {
    expect(noteOf(declined('owner'))).toBe('你暂不发布');
    expect(noteOf(declined())).toBe('你暂不发布');
    expect(noteOf(declined('hub'))).toBe('没有发布');
  });

  it('主人拒绝发布审批：endedBy 为 owner，进度行写「你暂不发布」', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' });
    expect(noteOf(theJob(fix))).toBe('你暂不发布');
  });

  it('中心结束一：用满回合上限、没有提交审批：没有发布', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    for (let turn = 1; turn <= 4; turn += 1) {
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: `第 ${turn} 次` });
      if (turn < 4) await nextPacket(fix, fix.engineer.id);
    }
    await tick(fix, 10 * MINUTE);
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expect(noteOf(theJob(fix))).toBe('没有发布');
  });

  it('中心结束二：执行者以做不下去交账：没有发布', async () => {
    const { fix } = await blockedLaunch('约定里没有写发布到哪里');
    expect(noteOf(theJob(fix))).toBe('没有发布');
  });

  it('中心结束三：兜底 30 分钟：没有发布', async () => {
    const { fix } = await acceptedWithLaunch();
    for (const entry of entriesOf(fix, fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    for (let i = 0; i < 4; i += 1) await tick(fix, 9 * MINUTE);
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expect(noteOf(theJob(fix))).toBe('没有发布');
  });

  it('中心结束四：审批过期、执行者已归档：没有发布', async () => {
    const expired = await acceptedWithLaunch();
    const { approval } = await submitLaunch(expired.fix);
    expired.fix.ctx.store.table('approvals').patch(approval.id, { expiresAt: expired.fix.ctx.clock.now() + MINUTE });
    await tick(expired.fix, 2 * MINUTE);
    expect(theJob(expired.fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expect(noteOf(theJob(expired.fix))).toBe('没有发布');

    // 执行者在验收前已归档：验收时发布这一步直接结束。
    const { fix, job } = await delivered([], { launch: true });
    fix.ctx.store.table('bots').patch(fix.engineer.id, { archivedAt: fix.ctx.clock.now() });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expect(noteOf(theJob(fix))).toBe('没有发布');
  });
});
