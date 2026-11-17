/**
 * P74r2d 第 2 至 5 条的测试：转交材料按状态处理、回答的出处、停止时约定正在重新确认、中心写的文件不能当证据或产出物。
 *
 * 目录：
 *   2 转交材料（forward）按这件事的状态处理（审查发现 G8、G12）
 *   3 回答的出处：主人转来的材料；「一句话」不能作为唯一出处（审查报告第 7 节第 6 条）
 *   4 停止时约定正在重新确认（审查报告疑点 3）
 *   5 中心写的文件不能当作证据或产出物（审查报告疑点 6）
 * 全部走真实 Hub（真实的启动整理与显著性），时间用注入的假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it, vi } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { applyJobAction } from '../src/job/state.js';
import { ownerSays } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, chiefWakes, commitAndEnd, entriesOf, nextPacket, pendingReopen, runningOf, sectionOf, speak, started, tick,
  touches, type JobFix,
} from './p74r2b-fixtures.js';
import { eventsOf, firstSubmitArgs, putFile, threadOf, writeSnapshot, type PacketInfo } from './p74d-fixtures.js';
import { theJob } from './p74c-fixtures.js';
import { waitForPacket } from './p76g-fixtures.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import type { QueueEntry, WakeTicket } from '../src/model/wake.js';

/** 总管若有没收尾的回合先收尾，再让主人说一句话：总管拿到一个主人发起的回合（回合开着）。 */
async function ownerTurn(fix: JobFix, text: string): Promise<void> {
  // 别人的回合没收尾时，总管排不上（并发限制）：先把执行者、核对人开着的回合收尾；总管自己的回合若是主人发起的，交账要回复主人。
  for (const who of [fix.engineer, fix.reviewer]) if (runningOf(fix, who.id)) await commitAndEnd(fix, who.id, { outcome: 'progress', summary: '先收尾' });
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, fix.chief.id, text);
  expect(runningOf(fix, fix.chief.id), '主人说话之后总管应该拿到一个回合').toBeDefined();
}

/** 总管转交材料。 */
function forward(fix: JobFix, jobId: string, title: string, text = `${title}的原文`) {
  return callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId, title, text });
}

/** 材料文件夹里现有的文件名。 */
async function materialsOf(fix: JobFix, info: { jobDir: string }): Promise<string[]> {
  return fix.ctx.fs.list(`${info.jobDir}/材料`);
}

/** 执行者的唤醒包正文（直接按当前状态生成）。 */
async function executorBody(fix: JobFix): Promise<string> {
  const job = theJob(fix);
  const entry = { jobId: job.id, reason: { evidence: [] } } as unknown as QueueEntry;
  return (await buildJobBodyDetailed(fix.ctx, bot(fix, fix.engineer.id), entry, { jobId: job.id } as unknown as WakeTicket)).text;
}

describe('2 转交材料按这件事的状态处理', () => {
  it('执行者做不下去（G8 的场景）：转交成功，解除受阻，执行者被叫醒，返回文字和工作往来都对', async () => {
    const { fix, job, info } = await started();
    const blocked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: info.jobId, stuckAt: '缺报价接口的文档', tried: ['翻了仓库'] });
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做不下去，已说明' });
    expect(theJob(fix).state).toBe('blocked');
    await ownerTurn(fix, '这是报价接口的说明文档。');
    const touchesBefore = touches(fix, job.id);
    const result = await forward(fix, job.id, '接口说明', '接口：GET /prices，返回今日报价。');
    expect(result).toEqual({ ok: true, text: '已存为主题文件「接口说明」，交给林舟，他接着做。' });
    // 状态回到执行中，文件在，林舟被叫醒（多了一次候选），往来里有中心名义的一句。
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null });
    expect(await materialsOf(fix, info)).toEqual(['接口说明.md']);
    expect(touches(fix, job.id)).toBeGreaterThan(touchesBefore);
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '总管把主人的材料「接口说明」交给了林舟，林舟继续做。' });
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'forwarded')).toMatchObject({ data: { file: '材料/接口说明.md', title: '接口说明', unblocked: true } });
    // 林舟真的拿到回合，唤醒包里有这份材料。
    await speak(fix, bot(fix, fix.chief.id), '已转交。', { outcome: 'progress' });
    const packet = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(packet).toContain('总管刚转来材料：');
    expect(packet).toContain('接口说明.md');
  });

  it('核对中：只存文件、记事件，不叫执行者（他没有新的候选和回合）；返工时唤醒包的材料清单里有这份材料', async () => {
    const { fix, job, info } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    expect(theJob(fix).state).toBe('checking');
    await ownerTurn(fix, '补一份价格表。');
    const touchesBefore = touches(fix, job.id);
    const result = await forward(fix, job.id, '价格表');
    expect(result).toEqual({ ok: true, text: '已存为主题文件「价格表」。这件事在核对中，林舟返工时会看到。' });
    expect(await materialsOf(fix, info)).toEqual(['价格表.md']);
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'forwarded')).toMatchObject({ data: { file: '材料/价格表.md', woken: false } });
    expect(theJob(fix).state).toBe('checking');
    // 林舟没有新的候选，推进 40 分钟（4 次 10 分钟）也没有新回合。
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(touches(fix, job.id)).toBe(touchesBefore);
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: 'hub', text: '总管把你的「价格表」存为主题文件，林舟返工时会看到。' });
    // 返工时（唤醒包的材料清单）有这份材料。
    expect(await executorBody(fix)).toContain('价格表.md');
  });

  it('待你验收：拒绝，不存文件，没有新的事件和候选', async () => {
    const { fix, job, info } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'review_pass' }, fix.ctx.clock.now()));
    await ownerTurn(fix, '再补一份材料。');
    const before = writeSnapshot(fix, job.id);
    const result = await forward(fix, job.id, '价格表');
    expect(result).toEqual({ ok: false, error: '这件事已交付、在等主人验收，现在转交材料没有人接。主人指出哪条不符，用 hub_job_manage 的 mode reopen 对到条目返工；主人要改约定，用 hub_agreement_submit 的 mode revise 出新版本请主人确认。' });
    expect(await materialsOf(fix, info)).toEqual([]);
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('已完成、已停止：拒绝（沿用原有文字）', async () => {
    const { fix, job, info } = await started();
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'stopped', stoppedAt: fix.ctx.clock.now(), blocked: null });
    await ownerTurn(fix, '补一份材料。');
    const result = await forward(fix, job.id, '价格表');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('这件事已停止，不能再转交材料');
    expect(await materialsOf(fix, info)).toEqual([]);
  });

  it('受阻在别处（回合用到上限、有人停用、先停下、核对环节没有动静）：只存文件不叫人，返回文字写明停在哪', async () => {
    const cases: Array<[string, (fix: JobFix) => void, string]> = [
      ['回合用到上限', fix => fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'block', kind: 'turn_cap', no: null, text: '回合用完' }, fix.ctx.clock.now())), '已用到预计消耗'], // P84（K6）：有预计的事统一写「已用到预计消耗」
      ['有人停用', fix => fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'block', kind: 'participant_off', no: null, text: '林舟已停用' }, fix.ctx.clock.now())), '林舟已停用'],
      ['主人已暂停', fix => {
        const held = applyJobAction(theJob(fix), { type: 'block', kind: 'turn_cap', no: null, text: '回合用完' }, fix.ctx.clock.now());
        fix.ctx.store.table('jobs').put(applyJobAction(held, { type: 'hold' }, fix.ctx.clock.now()));
      }, '主人已暂停'],
      ['核对环节没有动静', fix => fix.ctx.store.table('jobs').put({ ...applyJobAction(theJob(fix), { type: 'block', kind: 'executor', no: null, text: '连续两次叫醒都没有进展' }, fix.ctx.clock.now()), blocked: { kind: 'executor', no: null, text: '连续两次叫醒都没有进展', since: fix.ctx.clock.now(), resumeTo: 'checking' } }), '核对环节没有动静'],
    ];
    for (const [name, setup, why] of cases) {
      const { fix, job, info } = await started();
      if (name === '有人停用') fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
      setup(fix);
      await ownerTurn(fix, `补一份材料（${name}）。`);
      const touchesBefore = touches(fix, job.id);
      const result = await forward(fix, job.id, '价格表');
      expect(result, name).toEqual({ ok: true, text: `已存为主题文件「价格表」。这件事现在停在：${why}，材料等它恢复后林舟会看到。` });
      expect(await materialsOf(fix, info), name).toEqual(['价格表.md']);
      expect(theJob(fix).state, name).toBe('blocked');
      expect(touches(fix, job.id), name).toBe(touchesBefore);
    }
  });

  it('有未回答的提问：返回文字末尾补一句提示（材料能回答时再用 answer，出处写材料）', async () => {
    const { fix, job, info } = await started();
    const asked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '接口地址是什么？' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    await ownerTurn(fix, '这是接口说明。');
    const result = await forward(fix, job.id, '接口说明');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.text).toContain('已存为主题文件「接口说明」，交给林舟。');
    expect(result.text!.endsWith('林舟的提问还没有回答：材料能回答它的话，再用 mode answer 回答，出处写这份材料。')).toBe(true);
  });
});

describe('3 回答的出处', () => {
  /** 林舟提问，主人发来材料，总管 forward；总管的回合仍开着。 */
  async function askedThenForwarded() {
    const s = await started();
    const asked = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: s.info.jobId, text: '接口地址是什么？' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    await ownerTurn(s.fix, '这是接口说明。');
    expect(await forward(s.fix, s.job.id, '接口说明', '接口地址：https://example.test/prices')).toMatchObject({ ok: true });
    return s;
  }

  it('转交材料之后用 answer（出处写材料）成功：工作往来里的回答带「依据：主人提供的材料「…」。」，林舟的唤醒包里也有', async () => {
    const { fix, job } = await askedThenForwarded();
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: job.id, text: '接口地址在材料里。', basis: [{ section: 'material', title: '接口说明' }] });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已回答林舟。' });
    const full = '接口地址在材料里。\n依据：主人提供的材料「接口说明」。\n这一点不改约定，不需要问主人。';
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'answered')).toMatchObject({ data: { text: full, basis: [{ section: 'material', title: '接口说明' }] } });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === full)).toBe(true);
    expect(theJob(fix).openAsk).toBeNull();
    await speak(fix, bot(fix, fix.chief.id), '已回答。', { outcome: 'progress' });
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(`总管刚回答你：${full}`);
  });

  it('材料可以和约定条目并列当出处，连接办法沿用现有规则（和）', async () => {
    const { fix, job } = await askedThenForwarded();
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: job.id, text: '按材料里的地址。', basis: [{ section: 'decided', no: 1 }, { section: 'material', title: '接口说明' }] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const text = eventsOf(fix.ctx, job.id).find(row => row.kind === 'answered')!.data.text as string;
    expect(text).toMatch(/依据：约定「我已定的」第 1 条（.+）和主人提供的材料「接口说明」。/);
  });

  it('只引用「一句话」被拒，零写入；加上一处具体条目或材料就通过', async () => {
    const { fix, job } = await askedThenForwarded();
    const before = writeSnapshot(fix, job.id);
    const refused = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '随便答', basis: [{ section: 'summary', no: 1 }] });
    expect(refused).toEqual({ ok: false, error: 'basis：不能只引用「一句话」。要有具体的条目或主人提供的材料能推出答案；推不出时用 hub_agreement_submit 的 mode revise 出新版本请主人确认。' });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix).openAsk).not.toBeNull();
    const ok = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '按材料。', basis: [{ section: 'summary', no: 1 }, { section: 'material', title: '接口说明' }] });
    expect(ok).toMatchObject({ ok: true });
  });

  it('引用不存在的材料标题被拒，并列出现有的材料标题；没有材料时说明没有', async () => {
    const { fix, job } = await askedThenForwarded();
    const refused = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis: [{ section: 'material', title: '价格表' }] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('basis[0]：这件事没有名为「价格表」的材料。现有的材料：「接口说明」');
    expect(refused.error).toContain('material（主人转来的材料，title 写材料标题）：「接口说明」');
    const none = await started();
    await callTool(none.fix, bot(none.fix, none.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: none.info.jobId, text: '问' });
    await commitAndEnd(none.fix, none.fix.engineer.id, { outcome: 'progress', summary: '已问' });
    await nextPacket(none.fix, none.fix.chief.id);
    const noFile = await callTool(none.fix, none.fix.chief, 'hub_job_manage', { mode: 'answer', jobId: none.job.id, text: '答', basis: [{ section: 'material', title: '接口说明' }] });
    expect(noFile.error).toContain('现在没有主人转来的材料');
  });

  it('参数校验：material 必须写 title 不写 no；约定条目必须写 no 不写 title', async () => {
    const { fix, job } = await askedThenForwarded();
    const call = (basis: unknown) => callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis });
    expect((await call([{ section: 'material' }])).error).toContain('title：section 为 material 时必须写材料的标题');
    expect((await call([{ section: 'material', title: '接口说明', no: 1 }])).error).toContain('no：section 为 material 时不写序号');
    expect((await call([{ section: 'decided' }])).error).toContain('no：约定条目的出处必须写序号');
    expect((await call([{ section: 'decided', no: 1, title: '接口说明' }])).error).toContain('title：只有 section 为 material 时才写标题');
  });

  it('总管的唤醒包里列出现有材料的标题（有材料时），没有材料时不出现这句', async () => {
    const { fix, job, info } = await started();
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '问' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问' });
    const first = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(first).not.toContain('主人转来的材料也能当出处');
    await ownerTurn(fix, '材料来了。');
    expect(await forward(fix, job.id, '接口说明')).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已转交。', { outcome: 'progress' });
    // 总管下一次拿到执行链回合时（再提一次问题）唤醒包里有材料标题。
    // P76g：原来这里靠第三块的兜底（30 分钟没有事件）叫醒执行者；兜底已删除，改为 2 小时没有记录重新唤醒，所以最多等 3 小时（每步 10 分钟）。
    await waitForPacket(fix, fix.engineer.id, 180);
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '再问一个' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '再问' });
    const second = sectionOf(await waitForPacket(fix, fix.chief.id, 180));
    expect(second).toContain('主人转来的材料也能当出处：section 写 material，title 写材料标题，现有：「接口说明」。');
  });
});

describe('4 停止时约定正在重新确认', () => {
  /** 约定有新版本等主人确认；这件事被主人让先停下（owner_hold），主人说「不做了」，总管拿到主人发起的回合。 */
  async function reopenThenOwnerTurn() {
    const s = await pendingReopen();
    const { fix } = s;
    const held = applyJobAction(theJob(fix), { type: 'block', kind: 'turn_cap', no: null, text: '回合用完' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(applyJobAction(held, { type: 'hold' }, fix.ctx.clock.now()));
    await ownerTurn(fix, '这件事不做了。');
    return s;
  }
  const agreementInbox = (fix: JobFix, agreementId: string) => fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${agreementId}:`));

  it('有新版本待确认时停止：约定回到已固定、没有开着的约定条目、暂停信息清空；对旧版本点确认被拒；两小时总管没有新回合', async () => {
    const { fix, job, agreementId } = await reopenThenOwnerTurn();
    expect(fix.ctx.store.table('agreements').get(agreementId)).toMatchObject({ state: 'pending' });
    expect(agreementInbox(fix, agreementId)).toHaveLength(1);
    expect(theJob(fix).pause).not.toBeNull();
    const stopped = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你确认不做了' });
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true });
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    expect(agreement.state).toBe('locked');
    expect(agreement.inboxId).toBeNull();
    expect(agreement.versions.map(row => row.state)).toEqual(['locked', 'superseded']);
    expect(agreementInbox(fix, agreementId)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(0);
    expect(theJob(fix)).toMatchObject({ state: 'stopped', pause: null });
    // 私聊里留一句说明（主人看过新版的卡）。
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text.includes('第 2 版的重新确认已撤下，因为这件事已停止。约定仍是已固定的第 1 版。'))).toBe(true);
    // 主人之后对旧卡点确认：被拒，没有任何变化；总管 2 小时没有新回合。
    await speak(fix, bot(fix, fix.chief.id), '已停止。', { outcome: 'progress' });
    const wakesBefore = chiefWakes(fix);
    const confirm = await fix.hub.api.confirmAgreement({ agreementId, version: 2 });
    expect(confirm.ok).toBe(false);
    await flushJobHooks(fix.ctx);
    for (let i = 0; i < 12; i += 1) await tick(fix, 10 * MINUTE);
    expect(chiefWakes(fix)).toBe(wakesBefore);
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions.map(row => row.state)).toEqual(['locked', 'superseded']);
    expect(theJob(fix).state).toBe('stopped');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });

  it('不叫醒执行者：停止之后执行者没有新的候选', async () => {
    const { fix, job } = await reopenThenOwnerTurn();
    const before = touches(fix, job.id);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你确认不做了' })).toMatchObject({ ok: true });
    expect(touches(fix, job.id)).toBe(before);
  });

  it('提问记号一并清掉：提问已转成约定新版本时停止，openAsk 上不再有「已转成第 n 版」', async () => {
    const { fix, job } = await reopenThenOwnerTurn();
    const ask = { eventId: 'jev_0000000001', fromId: fix.engineer.id, at: fix.ctx.clock.now(), text: '要不要暗色模式？', agreementNo: 2 };
    fix.ctx.store.table('jobs').put({ ...theJob(fix), openAsk: ask });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你确认不做了' })).toMatchObject({ ok: true });
    expect(theJob(fix).openAsk).toMatchObject({ agreementNo: null });
  });

  it('失败时整体恢复：写事件失败，停止被拒，约定仍在待确认、条目仍开着、暂停信息仍在、这件事没有停止', async () => {
    const { fix, job, agreementId } = await reopenThenOwnerTurn();
    const before = { agreement: fix.ctx.store.table('agreements').get(agreementId), pause: theJob(fix).pause, inbox: agreementInbox(fix, agreementId).map(row => row.id) };
    // 让写「已停止」事件失败（读事件照常）：停止的第二段在最后一步出错，前面已写的状态都要恢复。
    const real = fix.ctx.store.log.bind(fix.ctx.store);
    const spy = vi.spyOn(fix.ctx.store, 'log').mockImplementation(((name: string) => {
      const log = (real as (n: string) => { append: (row: unknown) => void })(name);
      return name === 'jobEvents' ? { ...log, append: () => { throw new Error('写事件失败（测试）'); } } : log;
    }) as never);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你确认不做了' });
    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('停止失败，已恢复到停止前的状态');
    expect(fix.ctx.store.table('agreements').get(agreementId)).toEqual(before.agreement);
    expect(theJob(fix).pause).toEqual(before.pause);
    expect(theJob(fix).state).toBe('blocked');
    expect(agreementInbox(fix, agreementId).map(row => row.id)).toEqual(before.inbox);
  });

  it('反例：约定没有在重新确认时，停止不动约定', async () => {
    const { fix, job } = await started();
    const agreementId = job.agreementId;
    fix.ctx.store.table('jobs').put(applyJobAction(applyJobAction(theJob(fix), { type: 'block', kind: 'turn_cap', no: null, text: '回合用完' }, fix.ctx.clock.now()), { type: 'hold' }, fix.ctx.clock.now()));
    await ownerTurn(fix, '不做了。');
    const before = fix.ctx.store.table('agreements').get(agreementId);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你确认不做了' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('agreements').get(agreementId)).toEqual(before);
  });
});

describe('5 中心写的文件不能当作证据或产出物', () => {
  /** 林舟交回的参数：第 3 条的第一项证据、产出物、预览可以替换。 */
  function args(info: PacketInfo, patch: { evidence?: Record<string, unknown>; deliverables?: string[]; preview?: string }): Record<string, unknown> {
    const base = firstSubmitArgs(info, patch.deliverables === undefined ? {} : { deliverables: patch.deliverables });
    const items = (base.items as Array<Record<string, unknown>>).map(item => item.no === 3 && patch.evidence !== undefined
      ? { ...item, evidence: [patch.evidence, (item.evidence as unknown[])[1]] } : item);
    return { ...base, items, ...(patch.preview === undefined ? {} : { preview: patch.preview }) };
  }
  const submit = async (fix: JobFix, info: PacketInfo, patch: Parameters<typeof args>[1]) => callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args(info, patch));

  it('文件类证据指向约定、原话、草图、材料文件夹里的文件：被拒，写明是中心写的文件', async () => {
    const { fix, info } = await started();
    await putFile(fix, info, '材料/竞品.md', '内容');
    for (const path of ['约定.md', '原话.md', '草图.md', '材料/竞品.md', './约定.md', '交付/../约定.md'.replace('交付/../', '')]) {
      const result = await submit(fix, info, { evidence: { kind: 'file', path, summary: '想拿它当证据' } });
      expect(result.ok, path).toBe(false);
      expect(result.error, path).toContain(`${path}是中心写的文件，不能当作证据或产出物。`);
    }
  });

  it('图片类证据指向材料文件夹里的图片：被拒', async () => {
    const { fix, info } = await started();
    await putFile(fix, info, '材料/截图.png', Buffer.from('x'));
    const result = await submit(fix, info, { evidence: { kind: 'image', path: '材料/截图.png', summary: '图' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('材料/截图.png是中心写的文件，不能当作证据或产出物。');
  });

  it('产出物指向中心写的文件：被拒', async () => {
    const { fix, info } = await started();
    const result = await submit(fix, info, { deliverables: ['交付/报价页.html', '约定.md'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('deliverables 第 2 项：约定.md是中心写的文件，不能当作证据或产出物。');
  });

  it('预览指向中心写的文件（含材料文件夹里的 html）：被拒', async () => {
    const { fix, info } = await started();
    await putFile(fix, info, '材料/页面.html', '<html></html>');
    for (const preview of ['材料/页面.html', '草图.md']) {
      const result = await submit(fix, info, { preview });
      expect(result.ok, preview).toBe(false);
      expect(result.error, preview).toContain(`${preview}是中心写的文件，不能当作证据或产出物。`);
    }
  });

  it('大小写和写法变化也算（约定.MD）', async () => {
    const { fix, info } = await started();
    const result = await submit(fix, info, { deliverables: ['约定.MD'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('是中心写的文件，不能当作证据或产出物。');
  });

  it('正例：指向 交付/、证据/ 下的文件照常通过', async () => {
    const { fix, info } = await started();
    await putFile(fix, info, '证据/日志.txt', '日志');
    const ok = await submit(fix, info, { evidence: { kind: 'file', path: '证据/日志.txt', summary: '日志' }, preview: '交付/报价页.html' });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
  });

  it('被拒时没有写入任何东西（不占轮次）', async () => {
    const { fix, job, info } = await started();
    const before = writeSnapshot(fix, job.id);
    const result = await submit(fix, info, { evidence: { kind: 'file', path: '约定.md', summary: '想拿它当证据' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('交回被拒，没有写入任何东西');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });
});
