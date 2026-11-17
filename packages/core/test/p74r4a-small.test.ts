/**
 * P74r4a 的测试（三）：给主人看的模型原文的过滤（第 4 条）、停下一件事的位置要求（第 7 条）、
 * 答复回合上限和「停住了」带条目编号（第 8 条）、两处文字（第 9 条）、选办法之后总管照唤醒包做（第 10 条）。
 * 全部走真实 Hub，总管只用唤醒包里的文字调用，假时钟每次不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { OutboxInputSchema } from '../src/gate/outbox.js';
import { STALL_OPTIONS, STALE_ITEM_TEXT } from '../src/job/blocked-answer.js';
import { budgetOptions } from '../src/job/block-options.js';
import { capSubjectKey } from '../src/job/cap.js';
import { announceJobApproval } from '../src/job/launch-approval.js';
import { hasInvisibleChars, internalNameIn, ownerTextProblem } from '../src/job/owner-text.js';
import { stallSubjectKey } from '../src/job/stall.js';
import { STOP_REFUSED_TEXT } from '../src/job/stop.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { wakeForOwnerMessage } from '../src/outreach/thread.js';
import { postThread } from '../src/outreach/thread.js';
import { commitAndEnd, runningOf } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { PASS_ITEMS, delivered, engineerSubmits, openItems } from './p74f-fixtures.js';
import { reviewerInfo } from './p74d-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, lastPacket, limitFix, nextPacket, ownerSays, sectionOf, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

const OTHER = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
const REWRITE = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };

describe('第 4 条：过滤要认得变形的写法', () => {
  it('审查报告 L1 列的七种变形写法各被认出；正常的中文、英文、数字、常见标点照常通过', () => {
    const variants = ['HUB_SEND 再试', 'Hub_Send', 'ｈｕｂ＿ｓｅｎｄ', 'hub​_send', 'JOB_ABCDEFGHIJ', 'stopsjob', 'Mode Reassign'];
    for (const text of variants) expect(internalNameIn(text), text).not.toBeNull();
    for (const text of ['让林舟再试一次，代价是多花一轮时间', '页面在手机上能看（390 宽）', 'Retry once, then ask for help: 3 items / 2 days.', '第 3 条：接口失败时有提示！']) {
      expect(internalNameIn(text), text).toBeNull();
      expect(ownerTextProblem('字段', text), text).toBeNull();
    }
  });

  it('零宽字符和文字方向控制字符被认出，提示写明字段', () => {
    for (const ch of ['​', '‍', '﻿', '‮', '⁦', '‏']) {
      expect(hasInvisibleChars(`再试${ch}一次`)).toBe(true);
      expect(ownerTextProblem('options[0].title', `再试${ch}一次`)).toBe('options[0].title：含有看不见的字符，请删掉后重写。');
    }
    expect(hasInvisibleChars('再试一次')).toBe(false);
  });

  it('向主人说明：变形写法、改后原文含内部名称、看不见的字符都被拒，零写入；正常文字成功', async () => {
    const { fix, job } = await limitFix();
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const jobId = /mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)![1]!;
    const base = { mode: 'escalate', jobId, stuckAt: '卡在失败提示', suggested: 0, reason: '改动最小' };
    const before = JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list()]);
    const call = (patch: Record<string, unknown>) => callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...base, options: [REWRITE, OTHER], ...patch });
    // 改后原文含内部名称：被拒（原来不查，会直接写进约定）。
    const named = await call({ options: [{ ...REWRITE, change: { no: 3, text: '调用 hub_send 发出 jobId 和 stopsJob 就算' } }, OTHER] });
    expect(named.ok).toBe(false);
    expect(String(named.error)).toContain('options[0].change.text');
    expect(String(named.error)).toContain('内部名称');
    // 变形写法。
    expect(String((await call({ options: [{ ...REWRITE, title: 'HUB_SEND 再试' }, OTHER] })).error)).toContain('内部名称');
    expect(String((await call({ stuckAt: 'ｈｕｂ＿ｓｅｎｄ 失败' })).error)).toContain('内部名称');
    // 看不见的字符：标题、做法、改后原文、卡在哪、理由各一条。
    expect(String((await call({ options: [{ ...REWRITE, title: '放宽​这一条' }, OTHER] })).error)).toContain('options[0].title：含有看不见的字符，请删掉后重写。');
    expect(String((await call({ options: [{ ...REWRITE, detail: '改成有提示‮都算做完' }, OTHER] })).error)).toContain('options[0].detail：含有看不见的字符，请删掉后重写。');
    expect(String((await call({ options: [{ ...REWRITE, change: { no: 3, text: '接口失败时有​提示' } }, OTHER] })).error)).toContain('options[0].change.text：含有看不见的字符，请删掉后重写。');
    expect(String((await call({ stuckAt: '卡在​失败提示' })).error)).toContain('stuckAt：含有看不见的字符，请删掉后重写。');
    expect(String((await call({ reason: '改动⁦最小' })).error)).toContain('reason：含有看不见的字符，请删掉后重写。');
    expect(JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list()])).toBe(before);
    expect(await call({})).toMatchObject({ ok: true });
    expect(job.id).toBe(jobId);
  });

  it('发布审批的三行：含看不见的字符被拒，写明是哪一行；变形的内部名称被拒；正常的通过', () => {
    const base = { kind: 'notify_owner', why: '发布', payload: { text: '你好' } } as const;
    const bad = OutboxInputSchema.safeParse({ ...base, cost: '不花钱​' });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('cost：含有看不见的字符，请删掉后重写。');
    const named = OutboxInputSchema.safeParse({ ...base, undo: 'Hub_Send 之后无法撤回' });
    expect(named.success).toBe(false);
    expect(JSON.stringify(named.error?.issues)).toContain('内部名称');
    expect(OutboxInputSchema.safeParse({ ...base, cost: '不花钱', undo: '可以撤回', after: '马上生效' }).success).toBe(true);
  });
});

describe('第 7 条：停下一件事，主人的话要说在对的地方', () => {
  it('叫醒这一回合的是主人对「待你处理」条目的答复（选办法）：stop 被拒，文字不变；这件事仍在受阻', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, { title: '先停下这件事', detail: '你选了就不再做；代价是这件事不会完成' }]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    await nextPacket(fix, fix.chief.id);
    expect(sectionOf(lastPacket(fix, bot(fix, fix.chief.id)))).toContain('主人为这件事选了办法「先停下这件事」');
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你选了先停下这件事' });
    expect(refused).toEqual({ ok: false, error: STOP_REFUSED_TEXT });
    expect(theJob(fix).state).toBe('blocked');
  });

  it('主人的话发在别的线程里（不是这件事的主题，也不是总管的私聊）：stop 被拒；发在总管的私聊里才行', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    // 主人在林舟的私聊里说「这件事不做了」，并叫醒总管：这句话不在这件事的主题、也不在总管的私聊里。
    const message = postThread(fix.ctx, { thread: fix.engineer.id, from: 'owner', kind: 'chat', text: '这件事不做了' });
    wakeForOwnerMessage(fix.ctx, bot(fix, fix.chief.id), message);
    await nextPacket(fix, fix.chief.id);
    const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(sectionOf(lastPacket(fix, bot(fix, fix.chief.id))))![1]!;
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId, reason: '你说不做了' })).toEqual({ ok: false, error: STOP_REFUSED_TEXT });
    expect(theJob(fix).state).toBe('doing');
    // 总管私聊里说，成功。
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '先不动', reply: '好的' }).catch(() => undefined);
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你说不做了' })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('stopped');
  });
});

describe('第 8 条：答复回合上限、「停住了」带上是哪一条', () => {
  /** 这件事开着的指定种类条目。 */
  function openOfKind(fix: JobFix, jobId: string, kind: 'cap' | 'stall') {
    return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:${kind}:`))[0];
  }

  it('回合上限：对着旧条目答复被拒，对着当前条目答复成功；不传时行为不变', async () => {
    const { fix, job } = await started();
    // 林舟这一回合先结束（回合还开着时，回合上限要等它结束后才处理）。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, MINUTE);
    const first = openOfKind(fix, job.id, 'cap')!;
    expect(first).toBeDefined();
    // P76f：条目的办法是「追加 n 个回合」（n 随条目而定），答复用条目自己的第一个选项。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: first.options[0]!, itemId: first.id })).toMatchObject({ ok: true });
    // 再用到上限：同一件事新开了一条同类条目。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: theJob(fix).turnCap });
    await tick(fix, MINUTE);
    const second = openOfKind(fix, job.id, 'cap')!;
    expect(second.id).not.toBe(first.id);
    const before = JSON.stringify(theJob(fix));
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: first.options[0]!, itemId: first.id })).toEqual({ ok: false, error: STALE_ITEM_TEXT });
    expect(STALE_ITEM_TEXT).toBe('这条提醒已经不是最新的，请在最新的一条上答复。');
    expect(JSON.stringify(theJob(fix))).toBe(before);
    // 不传 itemId 时行为不变（原有测试都不传，答复这件事现在开着的那一条）：这里对着当前条目带编号答复，成功。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: second.options[0]!, itemId: second.id })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(second.id)).toMatchObject({ status: 'answered' });
  });

  it('「停住了」：对着旧条目答复被拒，对着当前条目答复成功', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    const plant = (no: number) => {
      const item = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '会员定价页：没有进展', body: '中心已提醒两次，仍没有进展。',
        options: [...STALL_OPTIONS], defaultOption: null, expiresAt: null, priority: 'P1', refId: job.id, subjectKey: stallSubjectKey(job.id, no) });
      fix.ctx.store.table('jobs').patch(job.id, { inboxId: item.id });
      return item;
    };
    const first = plant(1);
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次', itemId: first.id })).toMatchObject({ ok: true });
    const second = plant(2);
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次', itemId: first.id })).toEqual({ ok: false, error: STALE_ITEM_TEXT });
    expect(fix.ctx.store.table('inbox').get(second.id)).toMatchObject({ status: 'open' });
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次', itemId: second.id })).toMatchObject({ ok: true });
    expect(budgetOptions(2)).toHaveLength(3);
    expect(capSubjectKey(job.id, 16)).toBe(`job:${job.id}:cap:16`);
  });
});

describe('第 9 条：两处文字', () => {
  it('验收条目的正文：有已过交付时间的条目时不写「全部符合」，与主题里那句一致；没有逾期时照旧', async () => {
    const onTime = await delivered();
    expect(openItems(onTime.fix, onTime.job.id)[0]!.body).toBe('3 条「怎样算做完」全部符合，已逐条核对。哪条不符合，在对话里写序号和问题。');
    // 派活时交付时间不能早于现在：派活之后把交付时间改到过去，再交回、核对通过。
    const s = await started();
    s.fix.ctx.store.table('jobs').patch(s.job.id, { dueAt: s.fix.ctx.clock.now() - 60 * MINUTE });
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
    expect(await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    const late = { fix: s.fix, job: theJob(s.fix) };
    const body = openItems(late.fix, late.job.id)[0]!.body;
    expect(body).toBe('2 条符合，第 1 条已过交付时间。哪条不符合，在对话里写序号和问题。');
    expect(body).not.toContain('全部符合');
    expect(threadOf(late.fix.ctx, late.job.topicId).some(row => row.text.includes('2 条全部符合，第 1 条已过交付时间'))).toBe(true);
  });

  it('执行者在发布环节提交发布审批之外的第二张审批：总管那句写「在准备发布」，不写「在做」；这件事没完成时仍写「在做」', async () => {
    const { fix, job } = await started();
    announceJobApproval(fix.ctx, job, false, 'ap_0000000001');
    announceJobApproval(fix.ctx, { ...job, state: 'done' }, false, 'ap_0000000002');
    const texts = threadOf(fix.ctx, job.chiefId).filter(row => row.from === job.chiefId).map(row => row.text);
    expect(texts).toContain('林舟在做「会员定价页」，这一步需要你批准。');
    expect(texts).toContain('林舟在准备发布「会员定价页」，这一步需要你批准。');
  });
});

describe('第 10 条：选办法之后总管照唤醒包里写的做', () => {
  it('主人选了不带改动的办法（换执行者）：总管被叫醒，按包里的文字（jobId、在岗员工）改派成功', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, OTHER]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(text).toContain('主人为这件事选了办法「换一位执行者再试」：换人重做这一条；代价是多花一轮时间。请照这个办法处理');
    // 只用包里的文字：换执行者的做法行取 jobId，「当前在岗的员工」一行取名字。
    const swap = /换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字。/.exec(text);
    expect(swap, '包里应该有换执行者的做法').not.toBeNull();
    const line = /当前在岗的员工：(.+?)。/.exec(text)?.[1];
    expect(line, '包里应该有在岗员工').toBeDefined();
    const names = [...line!.matchAll(/([^、（，]+)（/g)].map(match => match[1]!);
    const candidate = names.find(name => name !== '林舟' && name !== '评审甲');
    expect(candidate, '在岗员工里应该有可以接手的人').toBeDefined();
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: swap![1], executor: candidate });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ executorId: fix.extras[0]!.id, blocked: null });
    expect(job.id).toBe(swap![1]);
  });

  it('主人答复回合上限选继续、这件事仍在等总管写说明：总管被叫醒，按包里的文字调用说明成功', async () => {
    const { fix, job } = await limitFix();
    // 总管写说明的唤醒被回合上限丢弃：这件事仍受阻（三轮不过），回合上限条目建出。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, MINUTE);
    const cap = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:cap:`))[0];
    expect(cap, '回合上限条目应该已建出').toBeDefined();
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' } });
    if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '先放着' });
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: cap!.options[0]!, itemId: cap!.id })).toMatchObject({ ok: true });
    // 仍在受阻、在等总管：总管的唤醒包里写了「写说明」的做法，只用包里的文字调用说明成功。
    const done = await escalateFromPacket(fix, [REWRITE, OTHER]);
    expect(done.result, JSON.stringify(done.result)).toEqual({ ok: true, text: '已把卡在哪和办法交给主人。这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。' });
    expect(theJob(fix).escalation).toMatchObject({ chosen: null, kind: 'review_limit' });
  });
});
