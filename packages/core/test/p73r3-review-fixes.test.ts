/**
 * P73r3：第二次独立审查（P73c、P73d）发现的问题的修复测试，S1 至 S6 各至少一正一反。
 *
 * 为什么走真实链路：这几个问题都出在「工具返回成功，但中间某道门把它悄悄丢掉」，
 * 只有真实的 Hub、真实的显著性数值（同伴消息封顶 0.70，I 型安静节奏员工的门槛 0.75）才能暴露，
 * 所以这里不构造人为调高分值的候选。时间全部用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { addWake } from './p76c-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import {
  MINUTE, agreementIdIn, callTool, chiefDrafts, lockedAndAwake, ownerSays, proposeResearcher, speak, teamFix, theProposal as theAdditionProposal, type TeamFix,
} from './p73d-fixtures.js';
import { floors, openTopic } from './p72b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { agreementFixture } from './p72a-agreement-fixtures.js';
import {
  answerAll, expectNoModelWork, modelCalls, pick, presetBot, teamHub, theProposal, theSetup, thread,
} from './p73c-fixtures.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { checkTeamSignals, closeHandoffForAgenda, createHandoff, expireHandoffs, sendMail } from '../src/peer/index.js';
import { saveBotMbti } from '../src/personality/profile.js';
import { postThread } from '../src/outreach/thread.js';
import { declineTeamProposal } from '../src/team/proposals.js';
import { pendingOwnerConfirmOf } from '../src/team/owner-confirm.js';
import { TEAM_SETUP_BUSY_TEXT, TEAM_SETUP_CONFIRM_TEXT, TEAM_SETUP_POKE_TEXT } from '../src/team/setup-hold.js';
import { DECLINE_PHRASES } from '../src/team/rules.js';

const HOUR = 60 * MINUTE;

/** 对这个中心发起一次调度，并把当前时间往前走一小步，让相邻调度之间不被「全局放行间隔」拦住。 */
async function tickOnce(ctx: { clock: { advance(ms: number): void } }, hub: { tick(): Promise<unknown> }): Promise<void> {
  await hub.tick();
  ctx.clock.advance(MINUTE);
}

/** 把团队夹具里的总管、员工都改成真实流程里的样子：听吩咐、安静节奏；员工 I 型，总管 ENTJ。 */
function quietWorld(fix: TeamFix): void {
  const { ctx, chief, engineer, reviewer } = fix;
  ctx.store.table('bots').patch(chief.id, { onDemand: true, pace: 'quiet' });
  saveBotMbti(ctx, chief.id, 'ENTJ');
  for (const bot of [engineer, reviewer!]) {
    ctx.store.table('bots').patch(bot.id, { onDemand: true, pace: 'quiet' });
    saveBotMbti(ctx, bot.id, 'ISTJ');
  }
  // 避开启动静默。
  ctx.runtime.startedAt -= HOUR;
  ctx.clock.advance(HOUR);
}

/** 这个员工收到的唤醒单数量。 */
const wakesOf = (fix: TeamFix, botId: string) => fix.ctx.store.table('wakes').count(row => row.botId === botId);
/** 这个员工当前排着的候选。 */
const queueOf = (fix: TeamFix, botId: string) => fix.ctx.store.table('queue').list(row => row.botId === botId);

// ---------------------------------------------------------------------------
// S1 指名发给某位员工的交接和消息，入队时不看思考门槛
// ---------------------------------------------------------------------------

describe('S1 交接和同伴消息不被入队门槛丢掉', () => {
  // P74b：员工之间不再直接发消息，所以这条的发件人改为总管（测的是「指名消息不看入队门槛」，断言不变）。
  it('安静节奏的员工收到总管的消息：候选真实显著性低于门槛，仍然入队并被叫醒', async () => {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    await sendMail(fix.ctx, fix.chief.id, { to: fix.reviewer!.id, text: '做完了，请你核对一下' });
    const entry = queueOf(fix, fix.reviewer!.id)[0];
    expect(entry).toBeDefined();
    // 证明确实是「分数低于门槛」的情形：不放行就会被丢掉。
    expect(entry!.reason.score).toBeLessThan(entry!.reason.threshold);
    expect(entry!.chiefDispatch).toBeUndefined();
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.reviewer!.id)).toBe(1);
  });

  // P74b：hub_handoff 已移出工具清单，这条改测派活（hub_job_manage）：同样是指名发给员工，候选真实显著性低于门槛，仍然入队并被叫醒。
  it('总管派活（hub_job_manage）给安静节奏的员工：同样入队并被叫醒，工具如实报告已派', async () => {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    const packet = await lockedAndAwake(fix);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'assign', agreementId: agreementIdIn(packet), executor: '林舟', reviewer: '评审甲', dueAt: '2026-11-17 18:00', launchStep: false,
    });
    expect(result).toEqual({ ok: true, text: '已派给林舟，评审甲核对。' });
    const entry = queueOf(fix, fix.engineer.id)[0];
    expect(entry).toBeDefined();
    expect(entry!.reason.score).toBeLessThan(entry!.reason.threshold);
    await speak(fix, fix.chief, '这件事由林舟执行。', { outcome: 'progress' });
    // 越过「全局两次放行之间的最短间隔」（这道闸不在总管派活的豁免之内）。
    fix.ctx.clock.advance(3 * MINUTE);
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.engineer.id)).toBe(1);
  });

  it('员工回报总管：总管当天已有一次不是主人发起的回合，门槛抬高后仍被叫醒', async () => {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    // 第一次：员工发消息，总管被叫醒，这一回合不是主人发起的；交账后总管当天有了一次自主回合（疲劳大于 0）。
    await sendMail(fix.ctx, fix.engineer.id, { to: fix.chief.id, text: '页面做完了，请你看一眼' });
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.chief.id)).toBe(1);
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id)[0]!.ownerInitiated).toBe(false);
    await speak(fix, fix.chief, '收到，我看一下', { outcome: 'progress' });
    // P76r1 同步（口径变化）：发给总管的同伴消息不再算总管自己发起的回合，上面这一回合不再让总管的疲劳大于 0；
    // 原意（疲劳抬高门槛之后，指名发给总管的同伴消息仍被叫醒）不变，所以补一个总管自己发起的回合来抬高门槛，最后的回合总数相应加 1（2 变 3）。
    addWake(fix.ctx, {}, fix.chief.id);
    // 越过最短思考间隔（安静节奏的总管 60 分钟）。
    fix.ctx.clock.advance(70 * MINUTE);
    // 第二次回报：此时总管的门槛已经高于同伴消息的显著性上限 0.70。
    await sendMail(fix.ctx, fix.engineer.id, { to: fix.chief.id, text: '补充：验证过了，没有问题' });
    const entry = queueOf(fix, fix.chief.id)[0];
    expect(entry).toBeDefined();
    expect(entry!.reason.threshold).toBeGreaterThan(entry!.reason.score);
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.chief.id)).toBe(3);
  });

  // P74b：hub_handoff 已移出工具清单，这条改用 hub_send 搭场景（断言不变）。
  it('总管在不是主人发起的回合里发消息给安静节奏的员工：候选入队；最短思考间隔仍然生效', async () => {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    await sendMail(fix.ctx, fix.engineer.id, { to: fix.chief.id, text: '页面做完了，请安排核对' });
    await tickOnce(fix.ctx, fix.hub);
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id)[0]!.ownerInitiated).toBe(false);
    // 评审员刚想过一次（5 分钟前），比最短思考间隔近。
    fix.ctx.store.table('bots').patch(fix.reviewer!.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
    const result = await callTool(fix, fix.chief, 'hub_send', { to: fix.reviewer!.id, text: '请核对页面，交付前核对' });
    expect(result.ok).toBe(true);
    const entry = queueOf(fix, fix.reviewer!.id)[0];
    expect(entry).toBeDefined();
    expect(entry!.reason.score).toBeLessThan(entry!.reason.threshold);
    // 不是主人发起的回合，所以没有 chiefDispatch 标记，「最短思考间隔」照常生效：这时叫不醒。
    expect(entry!.chiefDispatch).toBeUndefined();
    await speak(fix, fix.chief, '已交给评审甲', { outcome: 'progress' });
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.reviewer!.id)).toBe(0);
    // 过了最短思考间隔就被叫醒。
    fix.ctx.clock.advance(70 * MINUTE);
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.reviewer!.id)).toBe(1);
  });

  it('反例：外界变化类的候选对同一位员工仍按门槛判断（被丢掉）；收件人不在岗时工具照旧报错', async () => {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    const percept = buildCandidate(fix.ctx, { botId: fix.reviewer!.id, kind: 'percept', score: 0.65, summary: '外界有变化', subjectKey: 'watch:w_x' });
    expect(percept.reason.score).toBeLessThan(percept.reason.threshold);
    expect(enqueue(fix.ctx, percept)).toBeNull();
    // 同样的低分同伴消息，不带 directed（例如交接完成通知）也仍按门槛判断。
    const plainPeer = buildCandidate(fix.ctx, { botId: fix.reviewer!.id, kind: 'peer_message', score: 0.6, summary: '通知', subjectKey: 'peer:x' });
    expect(enqueue(fix.ctx, plainPeer)).toBeNull();
    fix.ctx.store.table('bots').patch(fix.reviewer!.id, { lifecycle: 'paused' });
    await ownerSays(fix, fix.chief.id, '交给评审甲');
    const result = await callTool(fix, fix.chief, 'hub_send', { to: fix.reviewer!.id, text: '请核对' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不在岗');
  });
});

// ---------------------------------------------------------------------------
// S2 团队异常信号对听吩咐的总管放行
// ---------------------------------------------------------------------------

describe('S2 听吩咐的总管收到团队异常信号', () => {
  async function chiefWorld() {
    const fix = await teamHub();
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    expect(fix.chief).toMatchObject({ onDemand: true });
    return fix;
  }
  const chiefWakes = (fix: Awaited<ReturnType<typeof chiefWorld>>) => fix.ctx.store.table('wakes').count(row => row.botId === fix.chief!.id);
  const signalAudits = (fix: Awaited<ReturnType<typeof chiefWorld>>) =>
    fix.ctx.store.log('audit').all().filter(row => row.action === 'chief_signal').length;

  it('员工被系统停用：总管被叫醒一次，同一信号不重复叫醒', async () => {
    const fix = await chiefWorld();
    const worker = await presetBot(fix.ctx, 1);
    fix.ctx.store.table('bots').patch(worker.id, { lifecycle: 'quarantined', quarantineReason: '安全保护' });
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(1);
    expect(signalAudits(fix)).toBe(1);
    // 再检查一次：同一事实不再入队，也不再叫醒。
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    await tickOnce(fix.ctx, fix.hub);
    expect(signalAudits(fix)).toBe(1);
    expect(chiefWakes(fix)).toBe(1);
  });

  it('员工卡住超过 24 小时：总管被叫醒一次，同一信号不重复叫醒', async () => {
    const fix = await chiefWorld();
    const worker = await presetBot(fix.ctx, 1, { activity: 'blocked', activityText: '等不到资料', updatedAt: fix.ctx.clock.now() - 25 * HOUR });
    expect(worker.activity).toBe('blocked');
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(1);
    expect(signalAudits(fix)).toBe(1);
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(1);
    expect(signalAudits(fix)).toBe(1);
  });

  it('交接超过接收时限：总管被叫醒一次，同一信号不重复叫醒', async () => {
    const fix = await chiefWorld();
    const a = await presetBot(fix.ctx, 1);
    const b = await presetBot(fix.ctx, 2);
    await createHandoff(fix.ctx, a.id, { to: b.id, task: '核对页面', why: '交付前核对' });
    // 对方一直没接（交接本身排的那条候选移走，免得它占着唯一的思考名额，盖过这里要测的总管信号）：越过 2 小时的接收时限。
    for (const entry of queueOf(fix as never, b.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.clock.advance(3 * HOUR);
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(1);
    expect(signalAudits(fix)).toBe(1);
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(1);
    expect(signalAudits(fix)).toBe(1);
  });

  it('反例：没有异常时不制造信号；员工自己的普通外界变化候选对听吩咐的员工仍被挡住', async () => {
    const fix = await chiefWorld();
    await presetBot(fix.ctx, 1);
    await tickOnce(fix.ctx, fix.hub);
    expect(chiefWakes(fix)).toBe(0);
    expect(signalAudits(fix)).toBe(0);
    const worker = (await presetBot(fix.ctx, 2));
    const percept = buildCandidate(fix.ctx, { botId: worker.id, kind: 'percept', score: 0.9, summary: '有变化', subjectKey: 'watch:w_x' });
    expect(enqueue(fix.ctx, percept)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S3 三问期间总管不被叫醒；约定卡与组队卡不同时待确认
// ---------------------------------------------------------------------------

describe('S3 三问期间总管不被叫醒，两种卡互斥', () => {
  it('三问期间在主题里对总管说话：总管没有新增唤醒，主题里有固定句且只有一句；话照常保存', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    const project = okData(await fix.hub.api.saveProject({ name: '季度战役', memberBotIds: [chief.id] }));
    const topicId = okData(await fix.hub.api.createProjectTopic({ projectId: project.id, text: '先聊聊这件事' })).topicId;
    okData(await fix.hub.api.sendMessage(topicId, '再补充一句'));
    okData(await fix.hub.api.sendMessage(topicId, '还有一句'));
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count()).toBe(0);
    expect(fix.ctx.store.table('queue').count()).toBe(0);
    expect(modelCalls(fix.ctx)).toEqual([]);
    const rows = floors(fix.ctx, topicId);
    expect(rows.filter(row => row.from === 'owner')).toHaveLength(3);
    expect(rows.filter(row => row.from === 'hub' && row.text === TEAM_SETUP_BUSY_TEXT)).toHaveLength(1);
  });

  it('三问期间在团队线程里对总管说话：不叫醒，团队线程里落一句固定句；三问答完后同样的话照常叫醒', async () => {
    const fix = await teamHub();
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    okData(await fix.hub.api.sendMessage('team', '帮我做个每日报价页'));
    okData(await fix.hub.api.sendMessage('team', '尽快'));
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count()).toBe(0);
    expect(thread(fix.ctx, 'team').filter(row => row.text === TEAM_SETUP_BUSY_TEXT)).toHaveLength(1);
    // 反例：第三问答完，三问不再占着总管，同样的话叫醒总管。
    await answerAll(fix);
    okData(await fix.hub.api.sendMessage('team', '现在可以开始了吗'));
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count(row => row.botId === fix.chief!.id)).toBe(1);
  });

  it('三问期间打「定了」：不当作回答，三问状态不变，中心落「请先回答上面的问题。」，不叫醒总管', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    const before = theSetup(fix.ctx);
    okData(await fix.hub.api.sendMessage(chief.id, '定了'));
    const after = theSetup(fix.ctx);
    expect(after.step).toBe(before.step);
    expect(after.answers).toEqual(before.answers);
    expect(after.state).toBe('asking');
    const rows = thread(fix.ctx, chief.id).filter(row => row.from === 'hub');
    expect(rows.map(row => row.text)).toEqual([TEAM_SETUP_CONFIRM_TEXT]);
    expect(fix.ctx.store.table('queue').count()).toBe(0);
  });

  it('反例：不是口令的话仍是第一问的回答，照常前进一问', async () => {
    const fix = await teamHub();
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '主要做网页'));
    expect(theSetup(fix.ctx).step).toBe(2);
    expect(theSetup(fix.ctx).answers.work).toBe('software');
  });

  it('人为造出待确认的约定卡：答完三问不生成组队卡，约定处理后由兜底补发；两种卡任何时刻不同时待确认', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    fix.ctx.store.table('agreements').put(agreementFixture({ botId: chief.id, originThread: chief.id }));
    const both = () => ({ agreement: fix.ctx.store.table('agreements').count(row => row.state === 'pending') > 0,
      team: fix.ctx.store.table('teamProposals').count(row => row.state === 'pending') > 0 });
    okData(await pick(fix, 1, 'software'));
    okData(await pick(fix, 2, 'no'));
    okData(await pick(fix, 3, 'decisions'));
    expect(fix.ctx.store.table('teamProposals').count()).toBe(0);
    expect(theSetup(fix.ctx).state).toBe('asking');
    expect(pendingOwnerConfirmOf(fix.ctx, chief.id)?.kind).toBe('agreement');
    // 兜底检查在约定仍待确认时也不补发。
    await tickOnce(fix.ctx, fix.hub);
    await fix.hub.api.overview();
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
    expect(fix.ctx.store.table('teamProposals').count()).toBe(0);
    expect(both()).toEqual({ agreement: true, team: false });
    // 约定被撤下之后：补发组队卡。
    fix.ctx.store.table('agreements').patch('agr_0000000001', { state: 'withdrawn' });
    await tickOnce(fix.ctx, fix.hub);
    await fix.hub.api.overview();
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
    expect(theProposal(fix.ctx).state).toBe('pending');
    expect(theSetup(fix.ctx).state).toBe('proposed');
    expect(both()).toEqual({ agreement: false, team: true });
  });
});

// ---------------------------------------------------------------------------
// S4 有待确认的组队卡时，总管不能派活
// ---------------------------------------------------------------------------

describe('S4 加人卡待确认时总管不能派活', () => {
  /** 总管推荐研究员并交账，卡片待确认；返回 fix。 */
  async function withPendingCard() {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    return fix;
  }

  // P74b 改为按事情区分：组队卡是为哪份约定加人的，就只拦那份约定的派活（assign）和它主题里的 @；
  // hub_handoff 已移出工具清单，hub_send 与事务指派改受另外的规则约束（见 p74b-gates.test.ts）。
  it('为这份约定加人的组队卡待确认时：assign 被拦下，文字说明是组队卡；总管指派事务给别人一律被拒；卡处理之后放行', async () => {
    const fix = await withPendingCard();
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    const assign = { mode: 'assign', agreementId, executor: '林舟', dueAt: '2026-11-17 18:00', launchStep: false };
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assign))
      .toMatchObject({ ok: false, error: '组队卡还在等主人确认，确认前不能把这件事交给别人。' });
    // P74r1（R1）恢复：组队卡待确认时 hub_send 也被拒（自由文字说的是哪件事中心分不清，取保守规则）。
    expect(await callTool(fix, fix.chief, 'hub_send', { to: fix.engineer.id, text: '开工吧' }))
      .toMatchObject({ ok: false, error: '组队卡还在等主人确认，确认前不能叫员工动手。' });
    const denied = await callTool(fix, fix.chief, 'hub_project_task_upsert', { projectId: fix.project.id, title: '做页面', assigneeBotId: fix.engineer.id });
    expect(denied).toMatchObject({ ok: false, error: '派活用 hub_job_manage 的 assign。' });
    expect(fix.ctx.store.table('jobs').count()).toBe(0);
    expect(fix.ctx.store.table('projectTasks').count()).toBe(0);
    // 反例：约定卡待确认时的报错文字见 p72b；组队卡处理之后放行。
    declineTeamProposal(fix.ctx, theAdditionProposal(fix.ctx).id, 'button');
    expect(await callTool(fix, fix.chief, 'hub_send', { to: fix.engineer.id, text: '有空看一下' })).toMatchObject({ ok: true });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assign)).toMatchObject({ ok: true });
  });

  // P74r1（R1）恢复原来的场景：组队卡待确认时，在另一个（临时）主题里 @ 员工也不叫醒（P74b 曾改成只在约定自己的主题里测，绕开了这条路径）。
  it('主题里 @ 员工：组队卡待确认时，在临时主题里 @ 也不叫醒人，落旁白', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员，请你在卡片上确认。', { outcome: 'needs_owner' });
    const topicId = await openTopic(fix as never, '先聊聊这件事');
    await speak(fix, fix.chief, '@林舟 你来做');
    expect(fix.ctx.store.table('queue').count(row => row.botId === fix.engineer.id)).toBe(0);
    expect(fix.ctx.store.table('wakes').count(row => row.botId === fix.engineer.id)).toBe(0);
    expect(floors(fix.ctx, topicId).some(row => row.kind === 'system' && row.text === '组队卡还没确认，这次没有叫 林舟。')).toBe(true);
  });

  it('主题里 @ 员工：为这份约定加人的组队卡待确认时不叫醒人，落旁白', async () => {
    const fix = await teamFix();
    // 约定建在「季度战役」项目里（林舟是成员），这样 @ 林舟才是叫得到的人。
    await chiefDrafts(fix as never, { title: '会员定价页', projectId: fix.project.id });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    const packet = lastPacket(fix, fix.chief);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员，请你在卡片上确认。', { outcome: 'needs_owner' });
    const topicId = fix.ctx.store.table('agreements').list()[0]!.topicId;
    await ownerSays(fix, topicId, '你怎么看');
    await speak(fix, fix.chief, '@林舟 你来做');
    expect(fix.ctx.store.table('queue').count(row => row.botId === fix.engineer.id)).toBe(0);
    expect(fix.ctx.store.table('wakes').count(row => row.botId === fix.engineer.id)).toBe(0);
    expect(floors(fix.ctx, topicId).some(row => row.kind === 'system' && row.text === '组队卡还没确认，这次没有叫 林舟。')).toBe(true);
  });

  it('反例：没有待确认的卡时总管正常发消息；员工回报总管不受这条闸门限制', async () => {
    const fix = await teamFix({ withReviewer: true });
    await ownerSays(fix, fix.chief.id, '交给林舟');
    expect(await callTool(fix, fix.chief, 'hub_send', { to: fix.engineer.id, text: '有空看一下' })).toMatchObject({ ok: true });
    await ownerSays(fix, fix.engineer.id, '问问总管');
    expect(await callTool(fix, fix.engineer, 'hub_send', { to: fix.chief.id, text: '在吗' })).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// S5 三问期间不触发复盘
// ---------------------------------------------------------------------------

describe('S5 三问期间不触发复盘', () => {
  it('第一问回答里含「记住」「不对」：三问结束前总管没有任何唤醒、排队和模型调用', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    okData(await fix.hub.api.sendMessage(chief.id, '记住，主要做网页，不对就改'));
    expect(theSetup(fix.ctx).step).toBe(2);
    for (let i = 0; i < 3; i += 1) await tickOnce(fix.ctx, fix.hub);
    expectNoModelWork(fix.ctx);
    // P75f：shouldReflect 已删除；三问期间与结束后都不再产生任何复盘候选。
    expect(fix.ctx.store.table('queue').count(entry => entry.variant === 'reflection')).toBe(0);
  });

  it('反例：三问结束后，私聊里同样的纠正也不触发复盘（P75f 起旧触发全部下线）', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    fix.ctx.store.table('teamSetups').patch(theSetup(fix.ctx).id, { state: 'done' });
    postThread(fix.ctx, { thread: chief.id, from: 'owner', kind: 'chat', text: '记住，不对就改' });
    expect(fix.ctx.store.table('queue').count(entry => entry.variant === 'reflection')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S6 拒绝口令收窄；三问期间戳一下不算回答
// ---------------------------------------------------------------------------

describe('S6 拒绝口令收窄，戳一下不算回答', () => {
  it('口令清单只有六句整句；「不加人」拒绝整张组队卡', async () => {
    expect([...DECLINE_PHRASES]).toEqual(['不新增', '不招', '不用招', '不加人', '不用加人', '先不加人']);
    const fix = await teamHub();
    await answerAll(fix);
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '不加人'));
    expect(theProposal(fix.ctx).state).toBe('declined');
  });

  it('反例：「不需要」「不要了」不拒绝组队卡', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '不需要'));
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '不要了'));
    expect(theProposal(fix.ctx).state).toBe('pending');
  });

  it('三问进行中戳一下总管：直接拒绝并说明，三问状态不变', async () => {
    const fix = await teamHub();
    const before = theSetup(fix.ctx);
    const result = await fix.hub.api.pokeBot(fix.chief!.id);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(TEAM_SETUP_POKE_TEXT);
    expect(theSetup(fix.ctx).answers).toEqual(before.answers);
    expect(theSetup(fix.ctx).step).toBe(1);
  });

  it('反例：不是三问中的总管（普通员工）戳一下照常成功', async () => {
    const fix = await teamHub();
    const worker = await presetBot(fix.ctx, 1);
    const result = await fix.hub.api.pokeBot(worker.id);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 复核补充：交接的完成、拒绝、过期通知同样不看思考门槛
// ---------------------------------------------------------------------------

describe('复核补充 交接结果通知叫醒听吩咐、安静节奏的发起人', () => {
  /** 总管（有过一次自主回合，疲劳大于 0）在主人发起的回合里把事交给工程师；返回交接单。 */
  async function chiefHandsOff() {
    const fix = await teamFix({ withReviewer: true });
    quietWorld(fix);
    await sendMail(fix.ctx, fix.engineer.id, { to: fix.chief.id, text: '页面做完了' });
    await tickOnce(fix.ctx, fix.hub);
    await speak(fix, fix.chief, '收到', { outcome: 'progress' });
    fix.ctx.clock.advance(70 * MINUTE);
    await ownerSays(fix, fix.chief.id, '交给林舟做');
    // P74b：hub_handoff 已移出工具清单；这组测的是交接结果通知，所以直接用交接函数造出一条旧式交接（与原工具同样的参数和豁免标记）。
    await createHandoff(fix.ctx, fix.chief.id, { to: fix.engineer.id, task: '做页面', why: '约定' }, { chiefDispatch: true, report: { queued: false } });
    await speak(fix, fix.chief, '已交给林舟', { outcome: 'progress' });
    // 移走工程师那条候选，免得它占着唯一的思考名额。
    for (const entry of queueOf(fix, fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    // P76r1 同步（口径变化）：总管收到的同伴消息、团队信号不再算自己发起的回合，所以补一个总管自己发起的回合，保持原来「疲劳抬高门槛」的前提。
    addWake(fix.ctx, {}, fix.chief.id);
    fix.ctx.clock.advance(70 * MINUTE);
    const handoff = fix.ctx.store.table('handoffs').list()[0]!;
    return { fix, handoff, before: wakesOf(fix, fix.chief.id) };
  }

  it('员工完成：总管被叫醒一次（候选真实显著性低于门槛）', async () => {
    const { fix, handoff, before } = await chiefHandsOff();
    closeHandoffForAgenda(fix.ctx, fix.engineer.id, handoff.agendaId!, 'done');
    const entry = queueOf(fix, fix.chief.id)[0];
    expect(entry).toBeDefined();
    expect(entry!.reason.score).toBeLessThan(entry!.reason.threshold);
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.chief.id)).toBe(before + 1);
  });

  it('员工拒绝：总管被叫醒一次', async () => {
    const { fix, handoff, before } = await chiefHandsOff();
    closeHandoffForAgenda(fix.ctx, fix.engineer.id, handoff.agendaId!, 'dropped');
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.chief.id)).toBe(before + 1);
  });

  it('交接过期：总管被叫醒一次', async () => {
    const { fix, handoff, before } = await chiefHandsOff();
    // 已被接下的交接，7 天没处理才过期（没接的交接 2 小时就由团队信号通知，那是另一条路径）。
    fix.ctx.store.table('handoffs').patch(handoff.id, { status: 'accepted' });
    fix.ctx.clock.advance(7 * 24 * HOUR);
    await expireHandoffs(fix.ctx, fix.ctx.clock.now());
    expect(queueOf(fix, fix.chief.id)).toHaveLength(1);
    await tickOnce(fix.ctx, fix.hub);
    expect(wakesOf(fix, fix.chief.id)).toBe(before + 1);
  });

  it('反例：与交接无关的外界变化候选对同一位总管仍按门槛判断', async () => {
    const { fix } = await chiefHandsOff();
    const percept = buildCandidate(fix.ctx, { botId: fix.chief.id, kind: 'percept', score: 0.65, summary: '外界有变化', subjectKey: 'watch:w_x' });
    expect(enqueue(fix.ctx, percept)).toBeNull();
  });
});
