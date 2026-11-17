/**
 * P72g A 部分测试：把独立审查（docs/progress/P72-review.md）里 6 条发现的复现步骤固定下来。
 *
 * 全部走真实 Hub（假宿主、假时钟），这样测到的是真实的接线：
 * 工具 -> 约定服务 -> 交账发卡 -> 「定了」途径 -> 唤醒。
 * 每条裁定至少一个正例、一个反例：
 * - A1 amend 不得替主人做决定；确认消息不能用来改约定
 * - A2 重开后的撤回只取消这次重开
 * - A3 同一回合先派活、后提交约定
 * - A4 约定只能建在总管自己负责的项目里
 * - A5「待你处理」条目与约定状态保持一致
 * - A6 DSH 原生会话里直接对总管打「定了」
 */
import { describe, expect, it } from 'vitest';
import { agreementPanelForTopic } from '../src/api/agreement-views.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { sweepMissingInboxItems } from '../src/project/agreement-cards.js';
import {
  callTool, chiefDrafts, chiefReplies, floors, lockAgreement, ownerSays, setup, speak, type Fix,
} from './p72b-fixtures.js';
import { contentFixture, submitFixture } from './p72a-agreement-fixtures.js';

const agreementOf = (fix: Fix, id: string) => fix.ctx.store.table('agreements').get(id)!;
/** 工具失败时把整个结果转成文字，方便断言错误里的中文。 */
const failText = (result: unknown) => JSON.stringify(result);

/** 总管提交新约定并交账（卡片落楼），返回约定 id。 */
async function draftAndCommit(fix: Fix, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await chiefDrafts(fix, extra);
  await speak(fix, fix.chief, '已记下，请看卡片');
  return id;
}

/** 总管提交约定的原样工具调用。 */
const submit = (fix: Fix, args: Record<string, unknown>) => callTool(fix, fix.chief, 'hub_agreement_submit', args);

/** 原两项待定项（不带 chosen），用来「原样重填再加一项」。 */
const ORIGINAL_PENDING = contentFixture().pending.map(({ key, question, options, suggested, reason }) => ({ key, question, options, suggested, reason }));

// ---------------------------------------------------------------------------
// A1
// ---------------------------------------------------------------------------
describe('A1：amend 不得替主人做决定', () => {
  it('反例：主人打「定了」叫醒的回合里，amend 被拒，约定不变', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await ownerSays(fix, fix.chief.id, '定了'); // 打字确认，约定固定，这句话照常叫醒总管
    expect(agreementOf(fix, id).state).toBe('locked');
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '补一项', summary: '换个说法' });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('主人的确认不能用来修改约定');
    expect(agreementOf(fix, id).versions).toHaveLength(1);
  });

  it('反例：同一个回合里 revise 也被拒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await ownerSays(fix, fix.chief.id, '定了');
    const result = await submit(fix, { agreementId: id, mode: 'revise', changeNote: '改范围', scopeIn: ['只做一屏'] });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('主人的确认不能用来修改约定');
    expect(agreementOf(fix, id)).toMatchObject({ state: 'locked' });
  });

  it('反例：点卡片上的「定了」按钮（confirmMessageId）叫醒的回合里，amend 同样被拒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const confirmed = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1 });
    expect(confirmed.ok).toBe(true);
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '补一项', summary: '换个说法' });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('主人的确认不能用来修改约定');
  });

  it('反例：amend 新增待定项被拒，提示改用 revise', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '再补一点');
    const pending = [...ORIGINAL_PENDING, { key: 'fee', question: '是否收费', options: ['免费', '收费'], suggested: '收费', reason: '看着像要收' }];
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '补一项', pending });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('待定项');
    expect(failText(result)).toContain('revise');
    expect(agreementOf(fix, id).versions).toHaveLength(1);
  });

  it('反例：amend 改「这次不做」被拒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '再补一点');
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '清空不做', scopeOut: [] });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('这次不做');
    expect(agreementOf(fix, id).versions).toHaveLength(1);
  });

  it('反例：amend 改「这次做」「怎样算做完」被拒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '再补一点');
    const scope = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '加范围', scopeIn: ['报价列表页', '手动刷新', '导出'] });
    expect(failText(scope)).toContain('这次做');
    const done = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '加验收', doneWhen: ['能打开', '能刷新', '失败有提示', '手机能看'] });
    expect(failText(done)).toContain('怎样算做完');
  });

  it('正例：amend 只改草图里的一处文字，成功并直接生效，选择不变', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '按钮上写「立即刷新」');
    const sketch = contentFixture().sketch;
    if (sketch.layout !== 'page') throw new Error('样例草图应为页面线框');
    sketch.screens![0]!.blocks[2]!.text = '立即刷新';
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '按钮改名', sketch });
    expect(result.ok).toBe(true);
    const agreement = agreementOf(fix, id);
    expect(agreement.state).toBe('locked');
    expect(agreement.versions).toHaveLength(2);
    expect(agreement.versions[1]).toMatchObject({ state: 'locked', lockedVia: 'amend', changes: [{ section: 'sketch', kind: 'changed' }] });
  });

  it('正例：amend 改「我已定的」成功', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '再补一点');
    const result = await submit(fix, { agreementId: id, mode: 'amend', changeNote: '补一条已定',
      decided: [{ text: '只做网页，不做手机端', basis: { kind: 'judgement' } }, { text: '用中文界面', basis: { kind: 'convention' } }] });
    expect(result.ok).toBe(true);
    expect(agreementOf(fix, id).versions[1]!.changes).toEqual([{ section: 'decided', kind: 'added', index: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// A2
// ---------------------------------------------------------------------------
describe('A2：重开后的撤回只取消这次重开', () => {
  it('复现：同一回合里先 revise 重开、再 withdraw，约定仍是已固定，主题面板仍在', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '交付时间是哪天？');
    expect(await submit(fix, { agreementId: id, mode: 'revise', changeNote: '改交付', summary: '重新来过' })).toMatchObject({ ok: true });
    expect(await submit(fix, { agreementId: id, mode: 'withdraw', reason: '其实只是问时间' })).toMatchObject({ ok: true });
    const agreement = agreementOf(fix, id);
    expect(agreement.state).toBe('locked');
    expect(agreement.withdrawn).toBeNull();
    expect(agreement.versions.map(row => row.state)).toEqual(['locked', 'superseded']);
    expect(agreementPanelForTopic(fix.ctx, agreement.topicId)).not.toBeNull();
  });

  it('正例：重开后主人换一句话说不改了，withdraw 取消重开，待你处理条目撤回，私聊留说明', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '范围改一下');
    // P72h H1：这次做从 2 条缩成 1 条，属于有意删除，要在 removals 里写明（原断言的输入补了这一项，断言本身不变）。
    expect(await submit(fix, { agreementId: id, mode: 'revise', changeNote: '改范围', scopeIn: ['只做一屏'], removals: ['报价列表页', '手动刷新'] })).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '请再确认');
    const reopenItem = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${id}:`));
    expect(reopenItem).toHaveLength(1);
    await ownerSays(fix, fix.chief.id, '算了，还是原来的');
    expect(await submit(fix, { agreementId: id, mode: 'withdraw', reason: '主人说还是原来的' })).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '好的');
    const agreement = agreementOf(fix, id);
    expect(agreement.state).toBe('locked');
    expect(agreement.versions[0]).toMatchObject({ state: 'locked' });
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${id}:`))).toBe(0);
    expect(chiefReplies(fix.ctx, fix.chief.id).some(row => row.text.includes('重新确认已取消'))).toBe(true);
  });

  it('反例：已固定且没有重开的约定，withdraw 被拒，提示用 revise', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    const result = await submit(fix, { agreementId: id, mode: 'withdraw', reason: '不做了' });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('revise');
    expect(agreementOf(fix, id).state).toBe('locked');
  });

  it('反例：withdraw 同样受「同一句话只用一次」约束（新建那句话不能再拿来撤下）', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    const result = await submit(fix, { agreementId: id, mode: 'withdraw', reason: '又不想做了' });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('同一句话只出一版');
    expect(agreementOf(fix, id).state).toBe('pending');
  });

  it('正例：从没固定过的待确认约定，换一句话 withdraw 照旧撤下', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await ownerSays(fix, fix.chief.id, '不做了');
    expect(await submit(fix, { agreementId: id, mode: 'withdraw', reason: '主人说不做了' })).toMatchObject({ ok: true });
    expect(agreementOf(fix, id).state).toBe('withdrawn');
  });
});

// ---------------------------------------------------------------------------
// A3
// ---------------------------------------------------------------------------
// P74b 收窄：派活（assign）只能针对已固定的约定，所以 revise（含重新确认）前的检查只看本回合是否对「同一份约定」调用过 assign 或 reassign。
// P74r1 恢复：新建约定前仍检查本回合有没有用 hub_send 叫过员工（hub_send 的正文可以说任何一件事，中心分不清）；
// 旧版本统计的交接、事务指派两条来源已随旧入口删除。
describe('A3：同一回合先对同一份约定派活、后 revise（P74b 收窄）', () => {
  it('复现：已固定的约定先 assign 给小王，同一回合再 revise 重开被拒，私聊落旁白，约定仍是已固定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '范围改一下');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId: id, executor: '小王', dueAt: '2026-11-17 18:00', launchStep: false })).toMatchObject({ ok: true });
    const result = await submit(fix, { agreementId: id, mode: 'revise', changeNote: '改范围', scopeIn: ['只做一屏'] });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('约定「每日报价页」没有记下：这一回合你已经把它交给员工了。先让员工停下的部分写进新版本的暂停里，或下一回合再提交。');
    expect(agreementOf(fix, id)).toMatchObject({ state: 'locked' });
    expect(agreementOf(fix, id).versions).toHaveLength(1);
    const notes = chiefReplies(fix.ctx, fix.chief.id).filter(row => row.kind === 'system');
    expect(notes.some(row => row.text === '总管在这一回合已经把约定「每日报价页」交给员工了，新的版本这次没有记下，请你留意。')).toBe(true);
  });

  it('反例：没有派过活，同一回合提交新约定、revise 照常成功，没有旁白', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    expect(fix.ctx.store.table('agreements').count()).toBe(1);
    expect(chiefReplies(fix.ctx, fix.chief.id).filter(row => row.text.includes('交给员工了'))).toHaveLength(0);
  });

  // P74r1（R1.3）恢复：P74b 曾把这条改成「先 hub_send 再提交新约定照常成功」，那是审查发现的缺口（F1）。
  it('复现：先 hub_send 叫了小王，再提交新约定被拒，私聊落旁白点名小王', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    expect(await callTool(fix, fix.chief, 'hub_send', { to: fix.wang.id, text: '先开始做报价页' })).toMatchObject({ ok: true });
    const result = await submit(fix, { ...submitFixture() });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('已经叫员工动手');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    const notes = chiefReplies(fix.ctx, fix.chief.id).filter(row => row.kind === 'system');
    expect(notes.some(row => row.text.includes('小王') && row.text.includes('先开始做报价页'))).toBe(true);
  });

  it('总管把事务指派给别人本身就被拒（派活只有 assign 一条路）；指派给自己不影响提交', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { projectId: fix.project.id, title: '自己先记一笔', assigneeBotId: fix.chief.id })).toMatchObject({ ok: true });
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { projectId: fix.project.id, title: '做页面', assigneeBotId: fix.wang.id }))
      .toMatchObject({ ok: false, error: '派活用 hub_job_manage 的 assign。' });
    expect(await submit(fix, submitFixture())).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// A4
// ---------------------------------------------------------------------------
describe('A4：约定只能建在总管自己负责的项目里', () => {
  it('复现：放进负责人是小王的项目，提交被拒，不留半条记录', async () => {
    const fix = await setup();
    const saved = await fix.hub.api.saveProject({ name: '老项目', memberBotIds: [fix.chief.id, fix.wang.id], ownerBotId: fix.wang.id });
    expect(saved.ok).toBe(true);
    const oldProject = fix.ctx.store.table('projects').list(row => row.name === '老项目')[0]!;
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    const topics = fix.ctx.store.table('projectTopics').count();
    const result = await submit(fix, { ...submitFixture(), projectId: oldProject.id });
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain('自己负责的项目');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    expect(fix.ctx.store.table('projectTopics').count()).toBe(topics);
  });

  it('正例：放进总管负责的项目成功；主人在约定主题里打「定了」，固定并叫醒的是总管，不是别人', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix, { projectId: fix.project.id });
    const agreement = agreementOf(fix, id);
    expect(agreement.projectId).toBe(fix.project.id);
    const wakesBefore = fix.ctx.store.table('wakes').list().map(row => row.id);
    await ownerSays(fix, agreement.topicId, '定了');
    expect(agreementOf(fix, id).state).toBe('locked');
    const created = fix.ctx.store.table('wakes').list(row => !wakesBefore.includes(row.id));
    const queued = fix.ctx.store.table('queue').list(row => row.topicId === agreement.topicId);
    const woken = [...created.map(row => row.botId), ...queued.map(row => row.botId)];
    expect(woken.length).toBeGreaterThan(0);
    expect(new Set(woken)).toEqual(new Set([fix.chief.id]));
  });

  it('正例：不带 projectId 照旧新建项目，总管是负责人', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    const project = fix.ctx.store.table('projects').get(agreementOf(fix, id).projectId)!;
    expect(project.ownerBotId).toBe(fix.chief.id);
  });
});

// ---------------------------------------------------------------------------
// A5
// ---------------------------------------------------------------------------
describe('A5：待你处理条目与约定状态保持一致', () => {
  const openItems = (fix: Fix, id: string) =>
    fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${id}:`));

  it('条目缺失时兜底补建，并把 inboxId 写回', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const first = agreementOf(fix, id).inboxId!;
    // 模拟中途出错：条目不见了（被撤回）。
    fix.ctx.store.table('inbox').patch(first, { status: 'withdrawn', answer: '误撤', answeredAt: fix.ctx.clock.now() });
    expect(openItems(fix, id)).toHaveLength(0);
    sweepMissingInboxItems(fix.ctx);
    const items = openItems(fix, id);
    expect(items).toHaveLength(1);
    expect(items[0]!.subjectKey).toBe(`agreement:${id}:1`);
    expect(agreementOf(fix, id).inboxId).toBe(items[0]!.id);
  });

  it('反例：条目齐全时兜底不重复建', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const before = fix.ctx.store.table('inbox').count();
    sweepMissingInboxItems(fix.ctx);
    expect(fix.ctx.store.table('inbox').count()).toBe(before);
    expect(openItems(fix, id)).toHaveLength(1);
  });

  it('反例：卡片还没发出（主人没看到）时不补建', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix); // 回合还开着，没交账，没发卡
    sweepMissingInboxItems(fix.ctx);
    expect(openItems(fix, id)).toHaveLength(0);
  });

  it('有两条残留的旧条目时，发新版后只剩一条（新版的）', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    // 造一条 inboxId 没指向的孤儿条目（同一份约定、同一版）。
    createInboxItem(fix.ctx, {
      botId: fix.chief.id, type: 'question', priority: 'P1', title: '孤儿', body: '孤儿',
      options: ['按建议，定了'], defaultOption: null, expiresAt: null, refId: id, subjectKey: `agreement:${id}:1`, topicId: agreementOf(fix, id).topicId,
    });
    expect(openItems(fix, id)).toHaveLength(2);
    await ownerSays(fix, fix.chief.id, '再改一下');
    // P72h H1：同上，缩减 scopeIn 要写明删除（输入补 removals，断言不变）。
    expect(await submit(fix, { agreementId: id, changeNote: '改范围', scopeIn: ['只做一屏'], removals: ['报价列表页', '手动刷新'] })).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '改好了');
    const items = openItems(fix, id);
    expect(items).toHaveLength(1);
    expect(items[0]!.subjectKey).toBe(`agreement:${id}:2`);
  });
});

// ---------------------------------------------------------------------------
// A6
// ---------------------------------------------------------------------------
describe('A6：DSH 原生会话里直接对总管打「定了」', () => {
  it('正例：owner_direct 事件里整句「定了」固定约定，via 为 text', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), text: '定了' });
    const agreement = agreementOf(fix, id);
    expect(agreement.state).toBe('locked');
    expect(agreement.versions[0]).toMatchObject({ state: 'locked', lockedVia: 'text' });
    expect(floors(fix.ctx, fix.chief.id).some(row => row.from === 'owner' && row.text === '定了')).toBe(true);
  });

  it('反例：「定了吗」不固定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), text: '定了吗' });
    expect(agreementOf(fix, id).state).toBe('pending');
  });

  it('反例：没有待确认约定时打「定了」不报错、不多出东西', async () => {
    const fix = await setup();
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), text: '定了' });
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });
});
