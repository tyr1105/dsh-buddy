/**
 * P72a 约定服务测试：用真实 Hub（内存存储、假时钟、假宿主）验证提交、修订、固定后改动、撤下、依据解析。
 * 重点是两条纪律：一是只能根据主人的话提交；二是校验失败时没有任何写入（表、随机数都不变）。
 */
import { describe, expect, it } from 'vitest';
import type { HubContext } from '../src/engine/context.js';
import type { Rule } from '../src/model/index.js';
import { AGREEMENT_TOPIC_NOTE } from '../src/project/agreement-home.js';
import { resolveBasis, AgreementSubmitInputSchema } from '../src/project/agreement-content.js';
import {
  agreementForTopic, ownerMessageOfWake, pendingAgreementOf, submitAgreement,
} from '../src/project/agreements.js';
import { saveProject } from '../src/project/service.js';
import { postThread } from '../src/outreach/thread.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { floors, topicHub } from './p63-topic-fixtures.js';
import { ownerWake, submitFixture, wakeTicket } from './p72a-agreement-fixtures.js';

/** 开一个有总管（第一位）的测试 Hub。 */
async function setup() {
  const fix = await topicHub();
  // P75f：中心启动会自动迁移并记 done；这些用例引用旧规矩表的 ru_ 编号，模拟「升级前」把记录置为未完成。
  fix.ctx.store.table('migrations').put({ id: 'p75-storage', state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: fix.ctx.clock.now() });
  return { ...fix, chief: fix.bots[0]!, exec: fix.bots[1]! };
}
type Fix = Awaited<ReturnType<typeof setup>>;

/** 记录各张表的行数和随机数调用次数，用来证明「失败时什么都没写」。 */
function watchWrites(ctx: HubContext) {
  const original = ctx.rng;
  let calls = 0;
  (ctx as { rng: unknown }).rng = { next: () => { calls += 1; return original.next(); } };
  return () => ({
    projects: ctx.store.table('projects').count(), topics: ctx.store.table('projectTopics').count(),
    agreements: ctx.store.table('agreements').count(), thread: ctx.store.log('thread').all().length,
    audit: ctx.store.log('audit').all().length, queue: ctx.store.table('queue').count(), rng: calls,
  });
}

/** 总管在私聊里收到主人一句话后提交（新建）。 */
async function draft(fix: Fix, extra: Record<string, unknown> = {}) {
  return submitAgreement(fix.ctx, fix.chief.id, ownerWake(fix.ctx, fix.chief.id), submitFixture(extra));
}
/** 主人再说一句话后总管提交修订类（revise、amend、withdraw）。 */
async function followUp(fix: Fix, agreementId: string, args: Record<string, unknown>) {
  return submitAgreement(fix.ctx, fix.chief.id, ownerWake(fix.ctx, fix.chief.id, '再改一下'), { agreementId, ...args });
}
/** 把约定改成已固定（手工写表，等价于 P72c 做完后的结果）。 */
async function lockIt(fix: Fix, agreementId: string) {
  const { applyLock } = await import('../src/project/agreements.js');
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  fix.ctx.store.table('agreements').put(applyLock(agreement, { version: agreement.versions.at(-1)!.no, via: 'button', choices: null, at: fix.ctx.clock.now(), confirmMessageId: null }));
}
const rule = (id: string, patch: Partial<Rule> = {}): Rule => ({ id, scope: 'global', text: '所有对外文字先给主人看', redLine: false, source: 'owner', status: 'active', createdAt: 1, ...patch });

describe('依据解析', () => {
  it('存在的有效 global 规矩通过，refText 是规矩原文；总管专属规矩也通过', async () => {
    const { ctx, chief } = await setup();
    ctx.store.table('rules').put(rule('ru_0000000001'));
    ctx.store.table('rules').put(rule('ru_0000000002', { scope: chief.id, text: '总管自己的规矩' }));
    const out = resolveBasis(ctx, chief.id, [
      { text: '对外文字先审', basis: { kind: 'source', ref: 'ru_0000000001' } },
      { text: '按自己的规矩', basis: { kind: 'source', ref: 'ru_0000000002' } },
    ]);
    expect(out[0]!.basis).toEqual({ kind: 'source', ref: 'ru_0000000001', refText: '所有对外文字先给主人看' });
    expect(out[1]!.basis.refText).toBe('总管自己的规矩');
  });
  it('出处原文超过 80 字时截取前 80 字', async () => {
    const { ctx, chief } = await setup();
    ctx.store.table('rules').put(rule('ru_0000000001', { text: '长'.repeat(200) }));
    expect(resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])[0]!.basis.refText).toBe('长'.repeat(80));
  });
  it('归档的规矩、别人专属的规矩、不存在的 id 被拒，错误指出路径和改写建议', async () => {
    const { ctx, chief, exec } = await setup();
    ctx.store.table('rules').put(rule('ru_0000000001', { status: 'archived' }));
    ctx.store.table('rules').put(rule('ru_0000000002', { scope: exec.id }));
    for (const ref of ['ru_0000000001', 'ru_0000000002', 'ru_0000000003', 'xx_1']) {
      expect(() => resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source', ref } }]))
        .toThrow(new RegExp(`decided\\[0\\]\\.basis\\.ref：找不到出处 ${ref}；查不到出处就把 kind 写成 judgement`));
    }
  });
  it('source 不给 ref 被拒；其他 kind 带 ref 被拒', async () => {
    const { ctx, chief } = await setup();
    ctx.store.table('rules').put(rule('ru_0000000001'));
    expect(() => resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source' } }])).toThrow(/decided\[0\]\.basis\.ref/);
    expect(() => resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'judgement', ref: 'ru_0000000001' } }]))
      .toThrow('decided[0].basis.ref：只有 source 才填出处');
    expect(resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'trial' } }])[0]!.basis).toEqual({ kind: 'trial', ref: null, refText: null });
  });
  it('项目决策：总管是成员的未归档项目里的 dc_ 决策通过；归档项目或非成员项目里的被拒', async () => {
    const { ctx, chief, exec, project } = await setup();
    const decision = { id: 'dc_0000000001', text: '周报每周五发', by: 'owner', at: 1 };
    ctx.store.table('projects').patch(project.id, { context: { background: '', conventions: '', decisions: [decision], glossary: [] } });
    expect(resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'dc_0000000001' } }])[0]!.basis.refText).toBe('周报每周五发');
    // 非成员
    const other = saveProject(ctx, { name: '别人的项目', memberBotIds: [exec.id] });
    ctx.store.table('projects').patch(other.id, { context: { background: '', conventions: '', decisions: [{ ...decision, id: 'dc_0000000002' }], glossary: [] } });
    expect(() => resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'dc_0000000002' } }])).toThrow(/找不到出处 dc_0000000002/);
    // 归档
    ctx.store.table('projects').patch(project.id, { archivedAt: 5, status: 'archived' });
    expect(() => resolveBasis(ctx, chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'dc_0000000001' } }])).toThrow(/找不到出处/);
  });
});

describe('ownerMessageOfWake', () => {
  it('证据是主人线程消息 id：取到它；多条取最晚的', async () => {
    const { ctx, chief, clock } = await setupWithClock();
    const a = postThread(ctx, { thread: chief.id, from: 'owner', kind: 'chat', text: '第一句' });
    clock.advance(10);
    const b = postThread(ctx, { thread: chief.id, from: 'owner', kind: 'chat', text: '第二句' });
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, chief.id, { kind: 'owner_message', evidence: [a.id, b.id] }))!.id).toBe(b.id);
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, chief.id, { kind: 'owner_message', evidence: [a.id] }))!.id).toBe(a.id);
  });
  it('证据是 owner_message 感知：按感知的 location 找到线程消息', async () => {
    const { ctx, chief } = await setup();
    const message = sendOwnerMessage(ctx, chief.id, '帮我做个页面');
    const queued = ctx.store.table('queue').list(row => row.botId === chief.id)[0]!;
    // 证据是感知 id，不是消息 id：要靠感知的 location 才能找到消息。
    expect(queued.reason.evidence[0]).not.toBe(message.id);
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, chief.id, queued.reason))!.id).toBe(message.id);
  });
  it('主人直聊：取 refId 等于唤醒单 id 的主人消息；直聊却找不到时返回 null，不回退到证据', async () => {
    const { ctx, chief } = await setup();
    const wake = wakeTicket(ctx, chief.id, { kind: 'owner_message', evidence: [] }, { ownerDirect: true });
    expect(ownerMessageOfWake(ctx, wake)).toBeNull();
    const message = postThread(ctx, { thread: chief.id, from: 'owner', kind: 'chat', text: '直聊的话', refId: wake.id });
    expect(ownerMessageOfWake(ctx, wake)!.id).toBe(message.id);
  });
  it('不是主人叫醒的（next_think）、证据是别人的消息，都返回 null', async () => {
    const { ctx, chief, exec } = await setup();
    const fromBot = postThread(ctx, { thread: chief.id, from: exec.id, kind: 'chat', text: '同伴说的' });
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, chief.id, { kind: 'next_think', evidence: [fromBot.id] }))).toBeNull();
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, chief.id, { kind: 'owner_message', evidence: [fromBot.id] }))).toBeNull();
  });
});

/** 需要推进假时钟的场景：topicHub 的 ctx.clock 是 FakeClock，这里取出来方便调用。 */
async function setupWithClock() {
  const fix = await setup();
  return { ...fix, clock: fix.ctx.clock as unknown as { advance(ms: number): void } };
}

describe('新建约定', () => {
  it('成功：新建项目（成员只有总管、负责人是总管、审计 actor 是总管 id）和主题（只有一条中心旁白），不排任何唤醒', async () => {
    const fix = await setup();
    const snap = watchWrites(fix.ctx);
    const before = snap();
    const out = await draft(fix);
    expect(out.kind).toBe('created');
    expect(out.version).toMatchObject({ no: 1, state: 'pending', source: 'draft', changes: [], changeNote: '', cardMessageId: null });
    const { agreement } = out;
    expect(agreement).toMatchObject({ botId: fix.chief.id, originThread: fix.chief.id, title: '每日报价页', state: 'pending', inboxId: null, withdrawn: null });
    const project = fix.ctx.store.table('projects').get(agreement.projectId)!;
    expect(project).toMatchObject({ name: '每日报价页', ownerBotId: fix.chief.id, memberBotIds: [fix.chief.id] });
    const audits = fix.ctx.store.log('audit').all();
    expect(audits.find(a => a.action === 'project_create' && JSON.parse(a.detail).id === project.id)!.actor).toBe(fix.chief.id);
    const topic = fix.ctx.store.table('projectTopics').get(agreement.topicId)!;
    expect(topic).toMatchObject({ projectId: project.id, title: '每日报价页', agentTurnsSinceOwner: 0, pendingBotIds: [] });
    const notes = floors(fix.ctx, topic.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ from: 'hub', kind: 'system', text: AGREEMENT_TOPIC_NOTE });
    const topicAudit = audits.find(a => a.action === 'project_topic_create')!;
    expect(topicAudit.actor).toBe(fix.chief.id);
    expect(JSON.parse(topicAudit.detail).byAgreement).toBe(true);
    expect(audits.some(a => a.action === 'agreement_submit' && a.actor === fix.chief.id && JSON.parse(a.detail).kind === 'created')).toBe(true);
    expect(snap().queue).toBe(before.queue);
    // 查询
    expect(pendingAgreementOf(fix.ctx, fix.chief.id)!.id).toBe(agreement.id);
    expect(agreementForTopic(fix.ctx, topic.id)!.id).toBe(agreement.id);
    expect(fix.ctx.events.some(e => e.scope === 'thread' && e.botId === fix.chief.id)).toBe(true);
  });
  it('给了总管是成员的进行中项目 id：不新建项目；主题挂在这个项目下', async () => {
    const fix = await setup();
    const projects = fix.ctx.store.table('projects').count();
    const out = await draft(fix, { projectId: fix.project.id });
    expect(out.agreement.projectId).toBe(fix.project.id);
    expect(fix.ctx.store.table('projects').count()).toBe(projects);
    expect(fix.ctx.store.table('projectTopics').get(out.agreement.topicId)!.projectId).toBe(fix.project.id);
  });
  it('W1：给了总管不是成员的进行中项目 id：放进去，总管加入成员', async () => {
    const fix = await setup();
    const foreign = saveProject(fix.ctx, { name: '别人的项目', memberBotIds: [fix.exec.id] });
    const out = await draft(fix, { projectId: foreign.id });
    expect(out.agreement.projectId).toBe(foreign.id);
    expect(fix.ctx.store.table('projects').get(foreign.id)!.memberBotIds).toEqual([fix.exec.id, fix.chief.id]);
  });
  it('给了已暂停或不存在的项目 id 被拒，且没有建主题', async () => {
    const fix = await setup();
    const paused = saveProject(fix.ctx, { name: '暂停的项目', memberBotIds: [fix.chief.id] });
    fix.ctx.store.table('projects').patch(paused.id, { status: 'paused' });
    const snap = watchWrites(fix.ctx);
    const before = snap();
    for (const projectId of [paused.id, 'prj_0000000099']) {
      await expect(draft(fix, { projectId })).rejects.toThrow('projectId：项目不存在或不在进行中');
    }
    // 只有 ownerWake 落的主人消息和对应的 thread 行数变化；项目、主题、约定表不变。
    const after = snap();
    expect(after).toMatchObject({ projects: before.projects, topics: before.topics, agreements: before.agreements, queue: before.queue });
  });
  it('已有一份 pending 时再新建被拒，且项目数、主题数不变', async () => {
    const fix = await setup();
    await draft(fix);
    const snap = watchWrites(fix.ctx);
    const before = snap();
    await expect(draft(fix, { title: '另一件事' })).rejects.toThrow('约定「每日报价页」还在等主人确认，先请主人确认或撤下，再提新的');
    expect(snap()).toMatchObject({ projects: before.projects, topics: before.topics, agreements: before.agreements });
  });
  it('已有的是 locked 约定时可以再新建（上限只管待确认的）', async () => {
    const fix = await setup();
    const first = await draft(fix);
    await lockIt(fix, first.agreement.id);
    expect((await draft(fix, { title: '第二件事' })).kind).toBe('created');
  });
  it('缺 title、缺内容项、没有 agreementId 却给了 revise 都被拒', async () => {
    const fix = await setup();
    const { title: _t, ...noTitle } = submitFixture();
    await expect(submitAgreement(fix.ctx, fix.chief.id, ownerWake(fix.ctx, fix.chief.id), noTitle)).rejects.toThrow(/title：新建约定时必须填写/);
    const { doneWhen: _d, ...noDone } = submitFixture();
    await expect(submitAgreement(fix.ctx, fix.chief.id, ownerWake(fix.ctx, fix.chief.id), noDone)).rejects.toThrow(/缺少：doneWhen/);
    await expect(draft(fix, { mode: 'revise' })).rejects.toThrow(/没有 agreementId 时只能新建/);
  });
  it('校验失败的新建（依据出处不存在）：项目表、主题表、约定表、随机数调用次数都不变', async () => {
    const fix = await setup();
    const wake = ownerWake(fix.ctx, fix.chief.id);
    const snap = watchWrites(fix.ctx); // ownerWake 已经落了消息，之后才开始计数
    const before = snap();
    await expect(submitAgreement(fix.ctx, fix.chief.id, wake, submitFixture({ decided: [{ text: '按规矩办', basis: { kind: 'source', ref: 'ru_0000000042' } }] })))
      .rejects.toThrow(/找不到出处 ru_0000000042/);
    // 内容本身不合法（建议项不在选项里）同样什么都不写。
    const bad = submitFixture() as { pending: Record<string, unknown>[] };
    await expect(submitAgreement(fix.ctx, fix.chief.id, wake, { ...bad, pending: [{ ...bad.pending[0], suggested: '别的' }] }))
      .rejects.toThrow(/pending\[0\]\.suggested：建议项必须是选项之一/);
    expect(snap()).toEqual(before);
  });
});

describe('身份与回合', () => {
  it('非总管调用被拒且没有任何写入', async () => {
    const fix = await setup();
    const wake = ownerWake(fix.ctx, fix.exec.id);
    const snap = watchWrites(fix.ctx);
    const before = snap();
    await expect(submitAgreement(fix.ctx, fix.exec.id, wake, submitFixture())).rejects.toThrow('只有总管能提交约定');
    await expect(submitAgreement(fix.ctx, 'b_0000000099', wake, submitFixture())).rejects.toThrow('只有总管能提交约定');
    expect(snap()).toEqual(before);
  });
  it('不是主人消息叫醒的唤醒单（next_think）被拒；参数形状不对也被拒；都没有任何写入', async () => {
    const fix = await setup();
    const ownerOne = ownerWake(fix.ctx, fix.chief.id); // 先落好主人消息，之后才开始计数
    const thinkWake = wakeTicket(fix.ctx, fix.chief.id, { kind: 'next_think', evidence: [] });
    const snap = watchWrites(fix.ctx);
    const before = snap();
    await expect(submitAgreement(fix.ctx, fix.chief.id, thinkWake, submitFixture())).rejects.toThrow('约定只能根据主人的话提交或修改：这一回合不是主人发消息叫醒的');
    await expect(submitAgreement(fix.ctx, fix.chief.id, ownerOne, { ...submitFixture(), 乱写: 1 })).rejects.toThrow(/hub_agreement_submit无效/);
    expect(snap()).toEqual(before);
  });
  it('agreementId 不存在或属于别的总管被拒；给了 agreementId 又传 projectId 被拒', async () => {
    const fix = await setup();
    const created = await draft(fix);
    await expect(followUp(fix, 'agr_0000000099', { changeNote: '改', summary: 'x' })).rejects.toThrow('agreementId：约定不存在或不是你的');
    ctxPatchBot(fix, created.agreement.id);
    await expect(followUp(fix, created.agreement.id, { changeNote: '改', summary: 'x' })).rejects.toThrow('agreementId：约定不存在或不是你的');
    ctxPatchBot(fix, created.agreement.id, fix.chief.id);
    await expect(followUp(fix, created.agreement.id, { changeNote: '改', summary: 'x', projectId: fix.project.id })).rejects.toThrow(/projectId：已经给了 agreementId/);
  });
});
/** 把约定临时改给别的员工（模拟「不是你的约定」），再改回来。 */
function ctxPatchBot(fix: Fix, agreementId: string, botId = fix.exec.id) {
  fix.ctx.store.table('agreements').patch(agreementId, { botId });
}

describe('待确认时修订', () => {
  it('第 1 版变 superseded，第 2 版 pending，changes 正确，来源 owner_revision', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    const out = await followUp(fix, agreement.id, { changeNote: '刷新改成每小时', summary: '做一个每小时刷新的报价页' });
    expect(out.kind).toBe('revised');
    expect(out.agreement.state).toBe('pending');
    expect(out.agreement.versions.map(v => v.state)).toEqual(['superseded', 'pending']);
    expect(out.version).toMatchObject({ no: 2, source: 'owner_revision', changeNote: '刷新改成每小时', changes: [{ section: 'summary', kind: 'changed' }], cardMessageId: null });
    // 没给的项沿用上一版
    expect(out.version!.content.doneWhen).toEqual(agreement.versions[0]!.content.doneWhen);
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions).toHaveLength(2);
  });
  it('模型换了 key 但问题原文相同：按问题对齐，changes 里是 changed 而不是删加', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    const out = await followUp(fix, agreement.id, { changeNote: '换理由', pending: [
      { key: 'src', question: '报价从哪里取', options: ['公开接口', '手工表格'], suggested: '公开接口', reason: '换了一个理由' },
      { key: 'refresh', question: '多久刷新一次', options: ['每小时', '每天'], suggested: '每天', reason: '你说看日报即可' },
    ] });
    expect(out.version!.content.pending.map(p => p.key)).toEqual(['source', 'refresh']);
    expect(out.version!.changes).toEqual([{ section: 'pending', kind: 'changed', key: 'source' }]);
  });
  it('不给 changeNote 被拒；内容完全没变被拒', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await expect(followUp(fix, agreement.id, { summary: '改了' })).rejects.toThrow(/changeNote：revise 时必须填写/);
    await expect(followUp(fix, agreement.id, { changeNote: '没改', summary: agreement.versions[0]!.content.summary })).rejects.toThrow('这一版和上一版没有任何不同');
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions).toHaveLength(1);
  });
  it('同一条主人消息对同一约定提交两次修订，第二次被拒', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    const wake = ownerWake(fix.ctx, fix.chief.id, '改一下');
    await submitAgreement(fix.ctx, fix.chief.id, wake, { agreementId: agreement.id, changeNote: '第一次', summary: '第一次改的' });
    await expect(submitAgreement(fix.ctx, fix.chief.id, wake, { agreementId: agreement.id, changeNote: '第二次', summary: '第二次改的' }))
      .rejects.toThrow('主人的这句话已经记成第 2 版了，同一句话只出一版');
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions).toHaveLength(2);
  });
  it('新建那一版用过的主人消息，不能再用来修订；版本数到 20 后再改被拒', async () => {
    const fix = await setup();
    const wake = ownerWake(fix.ctx, fix.chief.id);
    const { agreement } = await submitAgreement(fix.ctx, fix.chief.id, wake, submitFixture());
    await expect(submitAgreement(fix.ctx, fix.chief.id, wake, { agreementId: agreement.id, changeNote: '改', summary: '改' })).rejects.toThrow(/已经记成第 1 版/);
    for (let i = 2; i <= 20; i += 1) await followUp(fix, agreement.id, { changeNote: `第${i}版`, summary: `第 ${i} 版的复述` });
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions).toHaveLength(20);
    await expect(followUp(fix, agreement.id, { changeNote: '第21版', summary: '超限' })).rejects.toThrow(/达到上限 20/);
  });
  it('pending 上用 amend 被拒，错误里说明可用 revise 或 withdraw', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await expect(followUp(fix, agreement.id, { mode: 'amend', changeNote: '改', summary: '改' })).rejects.toThrow(/revise（修订）或 withdraw（撤下）/);
  });
});

describe('固定之后', () => {
  async function locked() {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await lockIt(fix, agreement.id);
    return { fix, id: agreement.id };
  }
  it('amend：新版直接 locked、上一版 replaced、source owner_instruction，沿用没改过的项的选择', async () => {
    const { fix, id } = await locked();
    // P72g A1：amend 只能改复述、草图、我已定的，原先用「怎样算做完」做样例，改成改一句话复述。
    const out = await followUp(fix, id, { mode: 'amend', changeNote: '复述改个说法', summary: '做一个能看每日报价的小页面' });
    expect(out.kind).toBe('amended');
    expect(out.agreement.state).toBe('locked');
    expect(out.agreement.versions.map(v => v.state)).toEqual(['replaced', 'locked']);
    expect(out.version).toMatchObject({ no: 2, state: 'locked', source: 'owner_instruction', lockedVia: 'amend', adoption: null, choices: { source: '公开接口', refresh: '每天' }, changes: [{ section: 'summary', kind: 'changed' }] });
    expect(out.version!.lockedAt).toBe(fix.ctx.clock.now());
    expect(out.version!.content.pending.map(p => p.chosen)).toEqual(['公开接口', '每天']);
  });
  it('amend 改复述：主人当时的选择原样沿用（P72g A1 后 amend 不能改待定项，原「改建议」样例改为改复述）', async () => {
    const { fix, id } = await locked();
    // 先让主人当初选的和建议不同：直接改表里的 choices。
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const v = agreement.versions[0]!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: [{ ...v, choices: { source: '手工表格', refresh: '每天' },
      content: { ...v.content, pending: v.content.pending.map(p => ({ ...p, chosen: p.key === 'source' ? '手工表格' : p.chosen })) } }] });
    const out = await followUp(fix, id, { mode: 'amend', changeNote: '复述改个说法', summary: '做一个看每日报价的页面' });
    expect(out.version!.choices).toEqual({ source: '手工表格', refresh: '每天' });
  });
  it('locked 上不传 mode 被拒，错误里说明可用 amend 或 revise；withdraw 被拒', async () => {
    const { fix, id } = await locked();
    await expect(followUp(fix, id, { changeNote: '改', summary: '改' })).rejects.toThrow(/amend（小改动直接生效）或 revise（大改动重新请主人确认）/);
    await expect(followUp(fix, id, { mode: 'withdraw', reason: '不做了' })).rejects.toThrow(/只能用 amend/);
  });
  it('revise：约定回到 pending，新版 owner_reopen，上一 locked 版仍是 locked', async () => {
    const { fix, id } = await locked();
    const out = await followUp(fix, id, { mode: 'revise', changeNote: '重大调整', summary: '整个换个做法' });
    expect(out.kind).toBe('reopened');
    expect(out.agreement.state).toBe('pending');
    expect(out.agreement.versions.map(v => v.state)).toEqual(['locked', 'pending']);
    expect(out.version).toMatchObject({ no: 2, source: 'owner_reopen', lockedAt: null, choices: null });
    expect(out.version!.content.pending.every(p => p.chosen === null)).toBe(true);
    expect(pendingAgreementOf(fix.ctx, fix.chief.id)!.id).toBe(id);
  });
  it('amend 内容完全没变被拒', async () => {
    const { fix, id } = await locked();
    await expect(followUp(fix, id, { mode: 'amend', changeNote: '没改' })).rejects.toThrow('这一版和上一版没有任何不同');
  });
});

describe('撤下', () => {
  it('pending 约定变 withdrawn：最新版 superseded，不追加版本，写撤下信息', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    const out = await followUp(fix, agreement.id, { mode: 'withdraw', reason: '主人说先不做了' });
    expect(out).toMatchObject({ kind: 'withdrawn', version: null });
    expect(out.agreement.state).toBe('withdrawn');
    expect(out.agreement.versions).toHaveLength(1);
    expect(out.agreement.versions[0]!.state).toBe('superseded');
    expect(out.agreement.withdrawn).toMatchObject({ reason: '主人说先不做了', noticeMessageId: null, at: fix.ctx.clock.now() });
    expect(pendingAgreementOf(fix.ctx, fix.chief.id)).toBeNull();
    expect(agreementForTopic(fix.ctx, agreement.topicId)).toBeNull();
  });
  it('不给 reason 被拒', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await expect(followUp(fix, agreement.id, { mode: 'withdraw' })).rejects.toThrow(/reason：withdraw 时必须填写/);
  });
  it('已撤下的约定任何提交都被拒', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await followUp(fix, agreement.id, { mode: 'withdraw', reason: '不做了' });
    for (const args of [{ changeNote: '改', summary: '改' }, { mode: 'revise', changeNote: '改', summary: '改' }, { mode: 'amend', changeNote: '改' }, { mode: 'withdraw', reason: '再撤' }]) {
      await expect(followUp(fix, agreement.id, args)).rejects.toThrow('约定「每日报价页」已撤下');
    }
  });
  it('撤下后总管可以重新新建约定', async () => {
    const fix = await setup();
    const { agreement } = await draft(fix);
    await followUp(fix, agreement.id, { mode: 'withdraw', reason: '不做了' });
    expect((await draft(fix, { title: '换个思路' })).kind).toBe('created');
  });
});

describe('提交参数边界', () => {
  it('参数里没有 chosen、refText；mode 只接受四个值', () => {
    expect(AgreementSubmitInputSchema.safeParse({ mode: 'draft' }).success).toBe(true);
    expect(AgreementSubmitInputSchema.safeParse({ mode: 'delete' }).success).toBe(false);
  });
});
