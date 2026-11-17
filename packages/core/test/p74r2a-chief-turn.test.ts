/**
 * P74r2a 的测试（三）：「在等总管」的每一种情形，让总管真跑一个执行链回合。
 *
 * 为什么要有这一组：原来的测试用删掉总管的候选来模拟「总管没有处理」，只证明了主人一定会收到一条提示，
 * 没有覆盖「总管被叫来之后能不能处理」（审查第二次，第 6 节第 3 点）。这里每种情形都让总管真的拿到这一回合，
 * 取唤醒包，只用包里的文字（正则取编号、名字、序号）把包里写到的每一种做法逐个调用一遍，必须成功；
 * 包里和各个拒绝文字里写到的每个 mode 都必须真实存在（原来 escalate、reopen 还没有，不许写；P74f 起它们都有了，
 * 改为逐个检查「文字里写到的做法都存在」）。核对三轮不过的出路是 escalate，最后一条按包里的文字调用它。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { blockExecutor } from '../src/job/stuck.js';
import {
  bot, callTool, engineerSubmits, nextPacket, reviewerInfo, sectionOf, started, theJob, tick, type JobFix,
} from './p74d-fixtures.js';
import { MINUTE, ownerSays } from './p74b-fixtures.js';
import { commitAndEnd, commitAs, runningOf } from './p74c-fixtures.js';

/**
 * 给模型看的文字里写到的 mode 名，必须是真实存在的做法（P74f-2 起 escalate、reopen 都存在了，不再整体禁止；
 * 要防的是文字指向一个不存在的做法）。取文字里「mode 写 X」「mode X」两种写法里的 X 逐个检查。
 */
const EXISTING_MODES = new Set(['assign', 'reassign', 'answer', 'forward', 'stop', 'resume', 'reopen', 'escalate',
  'draft', 'revise', 'amend', 'withdraw', 'ask', 'block', 'submit', 'review']);
function expectModesExist(text: string): void {
  for (const match of text.matchAll(/mode(?: 写)? ?([a-z_]+)/g)) expect(EXISTING_MODES.has(match[1]!), `文字里写到了不存在的 mode：${match[1]}`).toBe(true);
}

/** 一次工具调用的结果；失败时把错误文字也检查一遍有没有指向不存在的做法。 */
async function manage(fix: JobFix, args: Record<string, unknown>) {
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args);
  if (!result.ok) expectModesExist(String(result.error));
  return result;
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

describe('夹具与真实一致（第 6 条）', () => {
  it('总管：听吩咐、安静节奏、来历是自动创建；评审员：角色与评审员模板一致（建议）', async () => {
    const { fix } = await started();
    const chief = fix.ctx.store.table('bots').get(fix.chief.id)!;
    expect(chief).toMatchObject({ onDemand: true, pace: 'quiet', autonomy: 'L1', role: 'chief' });
    expect(fix.ctx.store.table('botOrigins').get(chief.id)).toMatchObject({ source: 'auto_chief', templateId: 'project-manager' });
    expect(fix.ctx.store.table('bots').get(fix.reviewer.id)).toMatchObject({ role: 'advisor', onDemand: true, pace: 'quiet' });
  });
});

describe('执行者提问，约定能回答', () => {
  it('总管执行链回合：包里写的「回答」做法照做成功，林舟被叫醒；包里没有 escalate、reopen；执行链回合里带 ownerQuestion 的交账被拒，拒绝文字没有 escalate', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '报价要不要含税？' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expectModesExist(text);
    const how = /回答：调用 hub_job_manage，mode 写 answer，jobId 写 (job_[0-9a-z]{10})，to 写(.+?)，text 写答案，basis 写出处/.exec(text);
    expect(how, '包里应该有「回答」的做法').not.toBeNull();
    // 只用包里的序号取一处出处。
    const basis = numbered(text).find(item => item.section === 'decided')!;
    // 总管在执行链回合里问主人：被拒，文字不指向 escalate。
    const question = { text: '价格定多少？', options: ['九块', '十块'], defaultOption: '九块', whyNeeded: '需要主人定' };
    const refused = await commitAs(fix, fix.chief.id, { outcome: 'progress', summary: '问主人', ownerQuestion: question });
    expect(refused.ok).toBe(false);
    // P74f-2：拒绝文字写明两条路各自的适用情形，指向真实存在的 escalate。
    expectModesExist(String(refused.error));
    expect(String(refused.error)).toContain('核对三轮仍不过、或执行者做不下去而你解决不了时，用 hub_job_manage 的 mode escalate');
    const answered = await manage(fix, { mode: 'answer', jobId: how![1], to: how![2], text: '不含税', basis: [{ section: basis.section, no: basis.no }] });
    expect(answered, JSON.stringify(answered)).toEqual({ ok: true, text: '已回答林舟。' });
    expect(theJob(fix).openAsk).toBeNull();
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已回答' });
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain('总管刚回答你：不含税');
  });
});

describe('执行者说明做不下去', () => {
  /** 林舟说明做不下去，总管拿到这一回合；返回包里「你手上的事」段。 */
  async function stuckPacket(extra: string[] = ['小周']) {
    const s = await started(extra);
    const blocked = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: s.job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] });
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    const text = sectionOf(await nextPacket(s.fix, s.fix.chief.id));
    return { ...s, text };
  }

  it('包里写了「回答」和「换执行者」两种做法，都不含 escalate、reopen；按「回答」做：成功并解除受阻', async () => {
    const { fix, job, text } = await stuckPacket();
    expectModesExist(text);
    expect(text).toContain('林舟做不下去：缺报价接口的文档');
    expect(text).toContain(`换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，executor 写新执行者的名字。`);
    const how = /回答：调用 hub_job_manage，mode 写 answer，jobId 写 (job_[0-9a-z]{10})，to 写(.+?)，text 写答案/.exec(text);
    expect(how).not.toBeNull();
    const basis = numbered(text).find(item => item.section === 'scopeIn')!;
    const answered = await manage(fix, { mode: 'answer', jobId: how![1], to: how![2], text: '接口文档在共享文件夹里', basis: [{ section: basis.section, no: basis.no }] });
    expect(answered, JSON.stringify(answered)).toEqual({ ok: true, text: '已回答林舟。' });
    // 回答让这件事回到受阻前的状态（执行中），林舟仍是执行者。
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, executorId: fix.engineer.id });
  });

  it('按「换执行者」做：只用包里的文字（jobId 和在岗员工名字）调用 reassign 成功，小周被叫醒', async () => {
    const { fix, text } = await stuckPacket();
    const how = /换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字。/.exec(text);
    expect(how).not.toBeNull();
    const names = staffNames(text);
    const pick = names.find(name => name !== '林舟' && name !== '评审甲')!;
    expect(pick).toBe('小周');
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], executor: pick });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已改派给小周。' });
    expect(theJob(fix)).toMatchObject({ state: 'ready', blocked: null, executorId: fix.extras[0]!.id });
  });
});

describe('核对人没有动静', () => {
  it('总管执行链回合：包里写的「换核对人」做法照做成功；包和拒绝文字都没有 escalate、reopen', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // P76g：原来由巡检的兜底（叫满两次）把这件事转受阻；兜底已删除。评审甲拿到回合不核对之后，直接用 blockExecutor 造出同样的受阻状态。
    await tick(fix, 10 * MINUTE);
    if (runningOf(fix, fix.reviewer.id)) await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '还在看' });
    blockExecutor(fix.ctx, theJob(fix), '连续两次叫醒都没有进展', fix.ctx.clock.now(), 'hub', { idle: true }, fix.reviewer.id);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'checking' } });
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expectModesExist(text);
    const how = /换核对人：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，reviewer 写新核对人的名字；写「总管」表示由你自己核对。/.exec(text);
    expect(how, '包里应该有「换核对人」的做法').not.toBeNull();
    // 两种用法都能做成：先写「总管」自己核对的拒绝路径不涉及；这里按名字换。
    const pick = staffNames(text).find(name => name !== '林舟' && name !== '评审甲')!;
    // 包里没写的做法（回答）被拒，拒绝文字也不指向 P74f。
    expect((await manage(fix, { mode: 'answer', jobId: job.id, text: '随便', basis: [{ section: 'summary', no: 1 }] })).ok).toBe(false);
    expect((await manage(fix, { mode: 'reassign', jobId: job.id, executor: pick })).ok).toBe(false);
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], reviewer: pick });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已换核对人' });
    const seen = reviewerInfo(await nextPacket(fix, fix.extras[0]!.id));
    const done = await callTool(fix, bot(fix, fix.extras[0]!.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }] });
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
  });
});

describe('有人停用后主人让总管处理（主人发起的回合）', () => {
  it('执行者停用：一览里写明「换人」做法和在岗员工，只用这些文字调用 reassign（executor）成功', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    await ownerSays(fix, fix.chief.id, '林舟停用了，你看着办');
    const text = sectionOf(fix.ctx.host.calls.filter(call => call.method === 'deliver' && call.args[0] === bot(fix, fix.chief.id).sessionId).at(-1)!.args[1] as string);
    expectModesExist(text);
    const how = /林舟已停用，这件事暂时没法往下做。换人：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字。/.exec(text);
    expect(how, '一览里应该有「换人」的做法').not.toBeNull();
    const names = staffNames(text);
    expect(names).not.toContain('林舟');
    const result = await manage(fix, { mode: 'reassign', jobId: how![1], executor: names.find(name => name !== '评审甲')! });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已改派给小周。' });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, executorId: fix.extras[0]!.id });
    expect(job.id).toBe(how![1]);
  });
});

describe('核对三轮不过（P74f-2 起有 escalate 这条出路）', () => {
  it('唤醒包里写了「写说明」的做法（escalate），只用包里的文字（jobId、卡住的条目序号）调用成功；没有回答、换人的做法行', async () => {
    const s = await started();
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    const unmet = (round: number) => [{ no: 3, verdict: 'unmet', note: `第${round}轮的问题`, fixTo: `第${round}轮的改法` }];
    const first = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, ...unmet(1)];
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: first })).toMatchObject({ ok: true });
    for (const round of [2, 3]) {
      const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
        mode: 'submit', jobId: job.id, changeNote: `第${round}轮的做法`, deliverables: ['交付/报价页.html'],
        items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/报价页.html', summary: '页面文件' }] }] });
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
      expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: job.id, items: unmet(round) })).toMatchObject({ ok: true });
    }
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' } });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '交回了' }).catch(() => undefined);
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(text).toContain('第 3 条核对三轮仍未通过。各轮：');
    expectModesExist(text);
    // P74f-2：包里现在写了「写说明」做法（escalate）；三轮不过没有可以回答、换人的做法行。
    expect(text).not.toContain('回答：调用');
    expect(text).not.toContain('换执行者：');
    const hint = /写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 (job_[0-9a-z]{10})，stuckAt/.exec(text);
    expect(hint, '包里应该有「写说明」的做法').not.toBeNull();
    // 只用包里的文字取 jobId 和卡住的条目序号，按做法调用 escalate：成功。
    const no = Number(/第 (\d+) 条核对三轮仍未通过/.exec(text)![1]);
    expect(numbered(text).some(item => item.section === 'doneWhen' && item.no === no)).toBe(true);
    const done = await manage(fix, { mode: 'escalate', jobId: hint![1], stuckAt: '接口失败时的提示，页面一直做不到让人看得懂',
      options: [
        { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no, text: '接口失败时页面有提示或有备用文案' } },
        { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' },
      ], suggested: 0, reason: '最小的改动，其余条目不受影响' });
    expect(done, JSON.stringify(done)).toEqual({ ok: true, text: '已把卡在哪和办法交给主人。这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。' });
    expect(theJob(fix).escalation).toMatchObject({ stage: job.stage, kind: 'review_limit', no, chosen: null });
  });
});
