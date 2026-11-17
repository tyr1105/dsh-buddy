/**
 * P76g 的测试（三）：「没有进展」条目的选项与答复：「再提醒一次」「暂停」「换{名字}接手」。
 *
 * 夹具：总管自动创建；执行员工林舟、另一位同角色、在岗、空闲的执行员工小周（用于换人）、评审甲。
 * 「换{名字}接手」让总管真跑一个回合：只用唤醒包里的文字、调用工具，证明做法写得清楚、能做成。
 */
import { describe, expect, it } from 'vitest';
import { stallOptionsProblem, takeOverNameOf, takeOverOptionOf } from '../src/job/block-options.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { commitAndEnd, entriesOf, eventsOf, runningOf, theJob } from './p74c-fixtures.js';
import { INTERNAL, bot, callTool, sectionOf, started } from './p74d-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { MINUTE, chiefSays, holdSilent, noticeRow, stallItems, waitForPacket } from './p76g-fixtures.js';

/** 起点：有第二位可接手的执行员工小周；林舟接力断了，2 小时重新唤醒、1 小时仍没有记录，中心通知你。返回起点和那一条「没有进展」条目。 */
async function notified(extra: string[] = ['小周']) {
  const s = await started(extra);
  const { fix, job } = s;
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
  holdSilent(fix, 190 * MINUTE, job.id);
  const [item] = stallItems(fix, job.id);
  expect(item, '应该已经通知').toBeDefined();
  return { ...s, item: item! };
}

describe('1 选项的形状', () => {
  it('有可接手的人（小周：同角色、在岗、不是这件事的参与者、手上没有事）：「换小周接手」「再提醒一次」「暂停」；没有时只有后两项', async () => {
    const withCandidate = await notified(['小周']);
    expect(withCandidate.item.options).toEqual(['换小周接手', '再提醒一次', '暂停']);
    const without = await notified([]);
    expect(without.item.options).toEqual(['再提醒一次', '暂停']);
  });

  it('可接手的人要同时满足四条：停用的、手上有事的、角色不同的（评审甲是核对人）都不挑', async () => {
    const paused = await notified([]);
    expect(paused.item.options).toEqual(['再提醒一次', '暂停']);
    // 小周停用：不挑。
    const s = await started(['小周']);
    s.fix.ctx.store.table('bots').patch(s.fix.extras[0]!.id, { lifecycle: 'paused' });
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    holdSilent(s.fix, 190 * MINUTE, s.job.id);
    expect(stallItems(s.fix, s.job.id)[0]!.options).toEqual(['再提醒一次', '暂停']);
  });

  it('选项文字的读写：名字至少一个字；条目建立时的校验认两种形状，别的一律拒绝', () => {
    expect(takeOverOptionOf('小周')).toBe('换小周接手');
    expect(takeOverNameOf('换小周接手')).toBe('小周');
    expect(takeOverNameOf('再提醒一次')).toBeNull();
    expect(takeOverNameOf('换接手')).toBeNull();
    expect(stallOptionsProblem(['再提醒一次', '暂停'])).toBeNull();
    expect(stallOptionsProblem(['换小周接手', '再提醒一次', '暂停'])).toBeNull();
    for (const bad of [[], ['再提醒一次'], ['暂停', '再提醒一次'], ['换小周接手', '暂停'], ['再提醒一次', '暂停', '换小周接手'], ['A', 'B', 'C', 'D']]) {
      expect(stallOptionsProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('createInboxItem 对「没有进展」条目的选项做校验', async () => {
    const { fix, job } = await started();
    const make = (options: string[]) => createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: 't', body: 'b', options, defaultOption: null,
      expiresAt: null, priority: 'P1', refId: job.id, subjectKey: `job:${job.id}:stall:7` });
    expect(() => make(['甲', '乙'])).toThrow('options：没有进展条目的选项必须是');
    expect(() => make(['换小周接手', '暂停'])).toThrow('options：没有进展条目的选项必须是');
    expect(make(['换小周接手', '再提醒一次', '暂停']).options).toEqual(['换小周接手', '再提醒一次', '暂停']);
  });
});

describe('2 再提醒一次、暂停', () => {
  it('「再提醒一次」：叫醒该动的人（林舟）、清空 rewakeAt（重新计时）、条目已答复、编号清空；私聊一句', async () => {
    const { fix, job, item } = await notified();
    expect(noticeRow(fix, job.id)!.rewakeAt).not.toBeNull();
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '再提醒一次' });
    expect(theJob(fix)).toMatchObject({ inboxId: null, state: 'doing' });
    expect(noticeRow(fix, job.id)!.rewakeAt).toBeNull();
    expect(entriesOf(fix, fix.engineer.id, job.id).length + (runningOf(fix, fix.engineer.id) ? 1 : 0)).toBeGreaterThan(0);
    // 这句话以中心名义落在总管私聊（kind 为系统消息），不在「总管自己说的话」里。
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '已再提醒林舟一次。' });
    expect(eventsOf(fix.ctx, job.id).at(-1)).toMatchObject({ kind: 'resumed', data: { retry: true, via: 'command' } });
  });

  it('「暂停」：转为「你已暂停」，这件事的候选清掉，私聊一句；之后不再算停滞（在等你）', async () => {
    const { fix, job, item } = await notified();
    expect(await fix.hub.api.answerInbox(item.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, inboxId: null });
    expect(fix.ctx.store.table('queue').count(row => row.jobId === job.id)).toBe(0);
    expect(chiefSays(fix).at(-1)).toBe('已暂停「会员定价页」。要继续做时告诉我。');
  });

  it('不在选项里的回答被拒，条目仍开着', async () => {
    const { fix, job, item } = await notified();
    expect(await fix.hub.api.answerInbox(item.id, '随便')).toMatchObject({ ok: false });
    const refused = await fix.hub.api.answerJobStall({ jobId: job.id, answer: '换老大接手' });
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).toContain('answer：只能是「换小周接手」「再提醒一次」「暂停」');
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open' });
  });
});

describe('3 换{名字}接手', () => {
  it('以你的话叫醒总管（话逐字）；这件事状态不变、条目答复掉、编号清空；总管真跑一个回合，只用唤醒包里的文字改派成功', async () => {
    const { fix, job, item } = await notified();
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '换小周接手' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '换小周接手' });
    const after = theJob(fix);
    expect(after).toMatchObject({ state: 'doing', inboxId: null, executorId: fix.engineer.id });
    const said = fix.ctx.store.log('thread').all().filter(row => row.thread === fix.chief.id && row.from === 'owner');
    expect(said.at(-1)).toMatchObject({ kind: 'chat', text: '换小周接手「会员定价页」。', refId: job.id });
    expect(eventsOf(fix.ctx, job.id).at(-1)).toMatchObject({ kind: 'resumed', data: { takeOver: '小周', via: 'command' } });
    // 总管被叫醒，这是一个「你发起的」回合。
    const packet = await waitForPacket(fix, fix.chief.id, 30);
    expect(runningOf(fix, fix.chief.id)).toMatchObject({ ownerInitiated: true });
    expect(packet).toContain('换小周接手「会员定价页」。');
    const text = sectionOf(packet);
    const how = /换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字。/.exec(text);
    expect(how, '唤醒包里应该有改派的做法').not.toBeNull();
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: how![1], executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).executorId).toBe(fix.extras[0]!.id);
    expect(theJob(fix).inboxId).toBeNull();
  });

  it('答复时名字已不可接手：停用、归档、已经是这件事的参与者，都拒绝，文字逐字；条目仍开着、什么都没写', async () => {
    const refusal = '小周现在不能接手，请选别的办法。';
    // 停用。
    const a = await notified();
    a.fix.ctx.store.table('bots').patch(a.fix.extras[0]!.id, { lifecycle: 'paused' });
    const refusedA = await a.fix.hub.api.answerJobStall({ jobId: a.job.id, answer: '换小周接手' });
    expect(refusedA).toMatchObject({ ok: false });
    expect(JSON.stringify(refusedA)).toContain(refusal);
    expect(a.fix.ctx.store.table('inbox').get(a.item.id)).toMatchObject({ status: 'open' });
    expect(theJob(a.fix).inboxId).toBe(a.item.id);
    // 归档（退役）。
    const b = await notified();
    b.fix.ctx.store.table('bots').patch(b.fix.extras[0]!.id, { lifecycle: 'retired' });
    expect(JSON.stringify(await b.fix.hub.api.answerJobStall({ jobId: b.job.id, answer: '换小周接手' }))).toContain(refusal);
    // 已经在这件事里（先被改成了这件事的执行者，林舟不再是）。
    const c = await notified();
    c.fix.ctx.store.table('jobs').patch(c.job.id, { executorId: c.fix.extras[0]!.id });
    expect(JSON.stringify(await c.fix.hub.api.answerJobStall({ jobId: c.job.id, answer: '换小周接手' }))).toContain(refusal);
    expect(c.fix.ctx.store.table('inbox').get(c.item.id)).toMatchObject({ status: 'open' });
    // 写入为零：没有留下「换人」的事件，也没有以你的名义说话。
    expect(eventsOf(c.fix.ctx, c.job.id).filter(row => row.data.takeOver !== undefined)).toHaveLength(0);
    expect(c.fix.ctx.store.log('thread').all().filter(row => row.from === 'owner' && row.text.includes('接手'))).toHaveLength(0);
  });

  it('卡住的是总管时没有换人这一项', async () => {
    const s = await started(['小周']);
    const { fix, job } = s;
    // 林舟做不下去，说明落给总管，总管没有处理（候选拿掉）。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    holdSilent(fix, 190 * MINUTE, job.id, fix.chief.id);
    const [item] = stallItems(fix, job.id);
    expect(item!.options).toEqual(['再提醒一次', '暂停']);
    expect(item!.body.split('\n')[0]).toMatch(/^已 \d+ 小时没有进展，停在执行这一步，在等总管。$/);
    expect(item!.title + item!.body).not.toMatch(INTERNAL);
  });
});
