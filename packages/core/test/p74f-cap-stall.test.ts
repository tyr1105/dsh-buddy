/**
 * P74f-2 的测试（三）：回合用到上限、「停住了」两类条目的答复，条目正文写真正在等什么，解除受阻时撤回条目。
 *
 * 规则：「再给 N 个回合」之后按这件事所处的环节叫对的人（等核对叫核对人，等返工叫执行者，三轮不过等说明叫总管）；
 * 「先停下」之后是「你让先停下」，总管 resume 才能恢复；「再叫一次」叫醒此刻该动的人，兜底的连续计数从头算，条目编号清空；
 * 正文按事实写（有未回答的提问、约定待确认、核对人没有动静），含内部名称的受阻说明换成固定句。全部走真实的 Hub，假时钟。
 */
import { describe, expect, it } from 'vitest';
import { reportStall } from '../src/job/stall.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { INTERNAL, engineerSubmits, firstSubmitArgs, reviewerInfo } from './p74d-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, limitFix, nextPacket, ownerSays, sectionOf, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';
import type { Job } from '../src/model/job.js';
import { setJobBudget } from '../src/job/budget-line.js';

/** 这件事开着的某类条目。 */
function openItem(fix: JobFix, jobId: string, kind: 'cap' | 'stall') {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:${kind}:`))[0];
}

/** 林舟交回时回合用到上限：这件事因回合上限受阻（受阻前核对中），回合上限条目已建。 */
async function cappedAtCheck() {
  // P76e：派活的预算线按预计算（首次估计是 8）；这些用例证明的是「用到预算线之后条目与答复」，与线的取值无关，显式设回 16（条目文案里的 16、再给 8 个照旧）。
  const s = await started([], { turnCap: 16 });
  s.fix.ctx.store.table('jobs').patch(s.job.id, { turnsUsed: s.job.turnCap });
  const result = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', firstSubmitArgs(s.info));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return s;
}

describe('回合上限条目的答复', () => {
  it('11 同一 tick 内建条目；「追加 2 个回合」：预算线加 2，解除受阻回到核对中，叫醒核对人（不是执行者），私聊一句，条目已回答、编号清空', async () => {
    // P76f：有预计的事，条目的办法是「追加 n 个回合」「缩小范围」「暂停」（原「再给 8 个回合」；旧条目的写法另有用例，见 p76f-paths）。
    const { fix, job } = await cappedAtCheck();
    const item = openItem(fix, job.id, 'cap')!;
    expect(item).toMatchObject({ options: ['追加 2 个回合', '缩小范围', '暂停'], defaultOption: null, expiresAt: null });
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '追加 2 个回合' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null, turnCap: 18, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '追加 2 个回合' });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '已追加 2 个回合，预计改为 11 回合，接着做。' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'cap_answered')).toMatchObject([{ data: { answer: '追加 2 个回合', via: 'command', cap: 18 } }]);
    // 核对人真的拿到回合，之后不会因为回合上限被丢弃。
    expect(sectionOf(await nextPacket(fix, fix.reviewer.id))).toContain(`jobId 为 ${job.id}`);
    expect(threadOf(fix.ctx, fix.chief.id).map(row => row.text).join('')).not.toMatch(INTERNAL);
  });

  it('等返工时受阻：「再给回合」叫执行者；经「待你处理」的按钮答复结果相同', async () => {
    const { fix, job, info } = await started([], { turnCap: 16 }); // P76e：显式把预算线设回 16（见 cappedAtCheck 的说明）
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    const reviewed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '没有提示', fixTo: '断开接口后页面显示「加载失败」' }] });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap', resumeTo: 'rework' } });
    const item = openItem(fix, job.id, 'cap')!;
    expect(await fix.hub.api.answerInbox(item.id, '追加 2 个回合')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, turnCap: 18, inboxId: null });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    // 已经答复过的条目再答复被拒；不在选项里的回答被拒。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '追加 2 个回合' })).toMatchObject({ ok: false });
  });

  it('「先停下」：转为「你让先停下」，总管一句；总管在主人发起的回合里 resume 可以恢复，预期的人被叫醒', async () => {
    const { fix, job } = await cappedAtCheck();
    const item = openItem(fix, job.id, 'cap')!;
    expect(await fix.hub.api.answerInbox(item.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold', resumeTo: 'checking' }, inboxId: null });
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: fix.chief.id, text: '已暂停「会员定价页」。要接着做时告诉我。' });
    // 随机的回答（不在选项里）被拒，状态不变。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '随便' })).toMatchObject({ ok: false });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' }).catch(() => undefined);
    await ownerSays(fix, fix.chief.id, '接着做吧');
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
  });

  it('核对三轮不过等总管说明时到回合上限：「再给回合」后仍受阻，叫的是总管（写说明），不是执行者', async () => {
    const limited = await limitFix();
    const fix = limited.fix;
    // P76e：显式把预算线设回 16（见 cappedAtCheck 的说明）。
    setJobBudget(fix.ctx, limited.job.id, 16, 'assign');
    const job = theJob(fix);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, 5 * MINUTE);
    const item = openItem(fix, job.id, 'cap')!;
    expect(item, '同一个 tick 内建回合上限条目').toBeDefined();
    expect(item.body.split('\n').at(-1)).toBe('目前停在：第3轮的问题');
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '追加 2 个回合' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' }, turnCap: 18, inboxId: null });
    expect(entriesOf(fix, fix.chief.id).some(entry => entry.jobId === job.id) || wakesOf(fix, fix.chief.id, job.id).length > 0).toBe(true);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });

  it('条目正文按事实写：有未回答的提问写「{提问人}问：{原文}」；含内部名称的受阻说明换成固定句', async () => {
    const { fix, job } = await started([], { turnCap: 16 }); // P76e：显式把预算线设回 16（见 cappedAtCheck 的说明）
    const asked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '报价要不要含税？价格表里没有写这一条' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, 5 * MINUTE);
    expect(openItem(fix, job.id, 'cap')!.body.split('\n').at(-1)).toBe('目前停在：林舟问：报价要不要含税？价格表里没有写这一条');
    // 含内部名称的受阻说明：换成固定句。
    const other = await started();
    const stuck: Job = { ...other.job, state: 'blocked', blocked: { kind: 'executor', no: null, text: '调用 hub_send 一直失败', since: other.fix.ctx.clock.now(), resumeTo: 'doing' } };
    other.fix.ctx.store.table('jobs').put(stuck);
    // P76g：原来用 announceStall 造条目，正文写「停在：{受阻说明}。已等总管处理 n 小时，中心已提醒两次，仍没有进展。」；
    // 现在经 reportStall（停摆）造，正文是三行（已等、起止时刻、消耗）。原意不变：条目建出来，正文不含内部名称。
    expect(reportStall(other.fix.ctx, stuck, 'idle', other.fix.ctx.clock.now() + 3 * 60 * MINUTE, { actorId: other.fix.chief.id })).toBe(true);
    const body = openItem(other.fix, other.job.id, 'stall')!.body;
    expect(body.split('\n')[0]).toMatch(/^已 \d+ 小时没有进展，停在执行这一步，在等总管。$/);
    expect(body).not.toMatch(INTERNAL);
  });
});

describe('「停住了」条目的答复', () => {
  /** 林舟做不下去（受阻），中心告诉主人这件事停住了。 */
  async function stalled() {
    const s = await started();
    const blocked: Job = { ...s.job, state: 'blocked', blocked: { kind: 'executor', no: null, text: '连续两次叫醒都没有进展', since: s.fix.ctx.clock.now(), resumeTo: 'doing' } };
    s.fix.ctx.store.table('jobs').put(blocked);
    // P76g：经 reportStall（停摆）造条目；这几个用例证明的是答复，与条目怎样产生无关。
    expect(reportStall(s.fix.ctx, blocked, 'idle', s.fix.ctx.clock.now() + 2 * 60 * MINUTE, { actorId: s.fix.chief.id })).toBe(true);
    return { ...s, item: openItem(s.fix, s.job.id, 'stall')! };
  }

  it('事项键用这件事记录上的序号（不数事件日志）；「再叫一次」：叫醒总管，条目已回答、编号清空，兜底的连续计数从头算，再次停住建新的一条', async () => {
    const { fix, job, item } = await stalled();
    expect(item.subjectKey).toBe(`job:${job.id}:stall:1`);
    expect(theJob(fix)).toMatchObject({ stallNo: 1, inboxId: item.id });
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ inboxId: null, state: 'blocked' });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '再提醒一次' });
    expect(entriesOf(fix, fix.chief.id).some(entry => entry.jobId === job.id)).toBe(true);
    // P76g：原来断言「兜底的连续计数从头算」（trailingIdleResumes 为 0）；兜底计数已删除，改为断言：这条答复留下的事件不是重新唤醒事件，算一条记录。
    expect(eventsOf(fix.ctx, job.id).at(-1)).toMatchObject({ data: { retry: true } });
    expect(eventsOf(fix.ctx, job.id).at(-1)!.data.idle).toBeUndefined();
    expect(eventsOf(fix.ctx, job.id).at(-1)).toMatchObject({ kind: 'resumed', data: { retry: true, via: 'command' } });
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '已再提醒总管一次。' });
    // 再次停住：新的一条，序号 2。
    const again = theJob(fix);
    expect(reportStall(fix.ctx, again, 'idle', fix.ctx.clock.now() + 2 * 60 * MINUTE, { actorId: fix.chief.id })).toBe(true);
    expect(openItem(fix, job.id, 'stall')!.subjectKey).toBe(`job:${job.id}:stall:2`);
  });

  it('「先停下」（经「待你处理」）：转为你让先停下，这件事的候选清掉，总管一句；不在选项里的回答被拒', async () => {
    const { fix, job, item } = await stalled();
    expect(await fix.hub.api.answerInbox(item.id, '随便')).toMatchObject({ ok: false });
    expect(await fix.hub.api.answerInbox(item.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, inboxId: null });
    expect(fix.ctx.store.table('queue').count(row => row.jobId === job.id)).toBe(0);
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: fix.chief.id, text: '已暂停「会员定价页」。要继续做时告诉我。' });
  });

  it('核对人没有动静的停住：正文写「等{核对人}核对第 n 轮交回」；总管自己核对没有动静仍可「再叫一次」叫总管', async () => {
    const { fix, job } = await started();
    const checking: Job = { ...job, state: 'blocked', round: 1, blocked: { kind: 'executor', no: null, text: '连续两次叫醒都没有进展', since: fix.ctx.clock.now(), resumeTo: 'checking' } };
    fix.ctx.store.table('jobs').put(checking);
    // P76g：原来的正文写「停在：等{核对人}核对第 n 轮交回。已等总管处理 …」；现在的正文是三行，等的人写预期的人（这里是总管）。
    expect(reportStall(fix.ctx, checking, 'idle', fix.ctx.clock.now() + 2 * 60 * MINUTE, { actorId: fix.chief.id })).toBe(true);
    expect(openItem(fix, job.id, 'stall')!.body.split('\n')[0]).toMatch(/^已 \d+ 小时没有进展，停在核对这一步，在等总管。$/);
  });

  it('解除受阻时撤回「停住了」条目并清空编号：总管用 answer 回答做不下去的执行者', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const jobNow = theJob(fix);
    // 这件事停住：中心告诉主人（条目编号记在这件事上）。
    expect(reportStall(fix.ctx, { ...jobNow, inboxId: null }, 'idle', fix.ctx.clock.now() + 2 * 60 * MINUTE, { actorId: fix.chief.id })).toBe(true);
    const item = openItem(fix, job.id, 'stall')!;
    const how = /回答：调用 hub_job_manage，mode 写 answer，jobId 写 (job_[0-9a-z]{10})，to 写(.+?)，text 写答案/.exec(text)!;
    const no = Number(/^scopeIn (\d+)\./m.exec(text)![1]);
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: how[1], to: how[2], text: '接口文档在共享文件夹里', basis: [{ section: 'scopeIn', no }] });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'withdrawn' });
    expect(theJob(fix)).toMatchObject({ state: 'doing', inboxId: null });
  });
});
