/**
 * P73d 的整条链路测试：总管推荐新员工、发卡、主人确认、总管被叫醒、按名字交给新员工、新员工立即开工。
 * 其中前三条是第一块的教训：模型只看得见唤醒包，所以参数一律只从唤醒包文本里取（正则），不偷看存储。
 * 为什么走真实 Hub：工具、交账路由、确认后的叫醒、调度闸门都挂在真实链路上。时间全部用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { commitArgs } from './c03-turn-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import {
  MINUTE, callTool, chiefThread, lockedAndAwake, newcomerNameIn, ownerSays, proposeResearcher, speak, teamFix, theProposal,
  type TeamFix,
} from './p73d-fixtures.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { enqueue } from '../src/scheduler/queue.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { answerAll, expectNoModelWork, teamHub, thread } from './p73c-fixtures.js';
import { afterAdditionConfirmed } from '../src/team/proposals.js';
import { TEAM_PROJECT_NOTE } from '../src/team/setup.js';
import {
  PROPOSE_DONE_TEXT, REVISE_DONE_TEXT, WITHDRAW_DONE_TEXT, reviseNoteText, withdrawnNoteText,
} from '../src/team/addition-text.js';

/** 内部名称的正则：工具名前缀、机器人 id、组队卡编号、约定编号。 */
const INTERNAL = /hub_|b_|tpr_|agr_/;

/** 总管某一个回合的唤醒单数量。 */
const wakeCount = (fix: TeamFix, botId: string) => fix.ctx.store.table('wakes').count(row => row.botId === botId);

/**
 * 推荐研究员并交账（reply 落楼、发卡）；再把时间推进 10 分钟（越过启动静默和全局放行间隔），
 * 并把总管的上次思考设成 5 分钟前（比任何最短思考间隔都近）。返回组队卡。
 */
async function proposedAndQuiet(fix: TeamFix) {
  const packet = await lockedAndAwake(fix);
  expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '需要先查同类产品的定价，建议新增一位研究员：这件事要用，以后还会反复查资料。请你在卡片上确认。', { outcome: 'needs_owner' });
  fix.ctx.clock.advance(10 * MINUTE);
  fix.ctx.store.table('bots').patch(fix.chief.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
  return theProposal(fix.ctx);
}

describe('只用唤醒包里的文字：推荐、确认、交给新员工', () => {
  it('1 约定刚固定：从总管唤醒包的文字里取约定编号和「研究员」这一行的模板名，调用 hub_team_propose 一次成功', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('## 组队（中心维护）');
    expect(packet).toContain('可推荐的模板（template 写名字）：');
    // 已有的工程师在模板清单里被标出来，直接安排他。
    expect(packet).toMatch(/工程师（执行）：写页面和功能，改完自己跑一遍，说明怎样验证。（已有林舟，直接安排）/);
    const result = await proposeResearcher(fix, packet);
    expect(result).toEqual({ ok: true, text: PROPOSE_DONE_TEXT });
    const proposal = theProposal(fix.ctx);
    expect(proposal).toMatchObject({ kind: 'addition', state: 'pending', rev: 1, cardMessageId: null });
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({ templateId: 'researcher', name: '研究员', mbti: 'INTP', removed: false, brief: null, outcome: null });
    expect(proposal.needReason).toBe('这件事要先查同类产品的定价');
    expect(proposal.residentReason).toBe('以后还会反复查竞品和资料');
    // 总管的状态行写「等你确认新员工」。
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.activityText).toBe('等你确认新员工');
  });

  it('2、3 主人确认后：总管 5 分钟前刚思考过也立即被叫醒；只用唤醒包文字里的名字和约定编号调用 hub_job_manage 一次成功；新员工立即放行；新员工已加入约定所在项目', async () => {
    const fix = await teamFix();
    const proposal = await proposedAndQuiet(fix);
    expect(proposal.cardMessageId).not.toBeNull();
    const chiefWakesBefore = wakeCount(fix, fix.chief.id);

    okData(await fix.hub.api.confirmTeamProposal({ proposalId: proposal.id, rev: proposal.rev }));
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    // 总管立即被叫醒（按主人发起处理，不受最短思考间隔限制）。
    expect(wakeCount(fix, fix.chief.id)).toBe(chiefWakesBefore + 1);
    const packet = lastPacket(fix, fix.chief);
    const name = newcomerNameIn(packet);
    expect(name).toBe('研究员');
    // 约定编号和名字都只从唤醒包文字里取（组队段那一句）。
    const sentence = /现在调用 hub_job_manage，mode 写 assign，agreementId 写 (agr_[a-z0-9]{10})，executor 写(.+?)，dueAt 写约定里的交付时间。/.exec(packet);
    expect(sentence, '唤醒包里应该有派活那一句').not.toBeNull();
    expect(sentence![2]).toBe(name);
    expect(packet).not.toContain('hub_handoff');

    // 总管想了两分钟（越过「全局两次放行之间的最短间隔」；这道闸不在总管派活的豁免之内）。
    fix.ctx.clock.advance(2 * MINUTE);
    // 只用唤醒包里的名字和约定编号派活，一次成功。
    const handoff = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'assign', agreementId: sentence![1], executor: name, dueAt: '2026-11-17 18:00', launchStep: false, note: '查同类产品的会员定价',
    });
    expect(handoff.ok).toBe(true);
    const newcomer = fix.ctx.store.table('bots').list(row => row.name === name)[0]!;
    expect(newcomer.lastThinkAt).toBeNull();
    // 新员工的唤醒候选通过调度闸门（候选带「总管在主人发起的回合里派活」标记）。
    const entry = fix.ctx.store.table('queue').list(row => row.botId === newcomer.id)[0]!;
    // P74c：执行链候选带 jobId（靠它越过冷却与最短思考间隔），不再带 chiefDispatch。
    expect(entry.jobId).toBe(fix.ctx.store.table('jobs').list()[0]!.id);
    expect(entry.chiefDispatch).toBeUndefined();
    // 闸门层：主人离开超过 10 分钟后（此时允许两位同时思考），总管的回合还开着，新员工的候选也通过全部闸门。
    // 主人在线时全队只允许一位思考，新员工会等总管交账之后再开工，那是另一条规则，下面的真实调度覆盖它。
    fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
    const now = fix.ctx.clock.now();
    const verdict = evaluateGates(entry, buildSnapshot(fix.ctx, newcomer.id, now, entry.jobId), now, fix.ctx.settings);
    expect(verdict, JSON.stringify(verdict)).toEqual({ pass: true });
    // 真实调度：总管交账结束这一回合，新员工立刻有了唤醒单。
    await speak(fix, fix.chief, '这件事由研究员先查同类产品的定价，查完我再回来告诉你。', { outcome: 'progress' });
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(wakeCount(fix, newcomer.id)).toBe(1);
    // 新员工是第一次开会话：唤醒包随「创建会话」一起送出，里面有总管交来的事。
    const created = fix.ctx.host.calls.find(call => call.method === 'createSession' && (call.args[0] as { botId: string }).botId === newcomer.id);
    expect((created!.args[0] as { firstMessage: string }).firstMessage).toContain('查同类产品的会员定价');

    // 3 新员工已加入约定所在项目的成员名单，审计里 actor 是总管、detail 带组队卡编号。
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    const project = fix.ctx.store.table('projects').get(agreement.projectId)!;
    expect(project.memberBotIds).toContain(newcomer.id);
    expect(project.memberBotIds).toContain(fix.chief.id);
    const audit = fix.ctx.store.log('audit').all().find(row => row.action === 'project_update' && row.actor === fix.chief.id
      && row.detail.includes(newcomer.id));
    expect(audit?.detail).toContain('byTeamProposal');
    expect(audit?.detail).toContain(proposal.id);
    // 项目的其他字段原样保留（一句话目标没有被清空）。
    expect(project.charter).toBe(fix.ctx.store.table('projects').get(agreement.projectId)!.charter);
  });

  it('确认入职那条主人消息：以主人名义落在总管私聊，指向组队卡；总管状态行不再写「等你确认新员工」', async () => {
    const fix = await teamFix();
    const proposal = await proposedAndQuiet(fix);
    okData(await fix.hub.api.confirmTeamProposal({ proposalId: proposal.id, rev: proposal.rev }));
    const message = chiefThread(fix.ctx, fix.chief.id).filter(row => row.from === 'owner' && row.text === '确认入职');
    expect(message).toHaveLength(1);
    expect(message[0]).toMatchObject({ kind: 'chat', refId: proposal.id });
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.activityText).not.toBe('等你确认新员工');
  });

  it('反例：初始组队卡确认后不走按需加人的钩子：不落「确认入职」，不叫醒任何人', async () => {
    const hub = await teamHub();
    const initial = await answerAll(hub);
    okData(await hub.hub.api.confirmTeamProposal({ proposalId: initial.id, rev: initial.rev }));
    expect(thread(hub.ctx, hub.chief!.id).filter(row => row.text === '确认入职')).toHaveLength(0);
    expectNoModelWork(hub.ctx);
  });

  it('反例：没有人成功入职时（全部失败）不叫醒总管：afterAdditionConfirmed 什么都不做', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const proposal = theProposal(fix.ctx);
    await afterAdditionConfirmed(fix.ctx, proposal, []);
    expect(chiefThread(fix.ctx, fix.chief.id).filter(row => row.text === '确认入职')).toHaveLength(0);
  });
});

describe('总管派活的候选不看思考门槛（安静节奏的员工也能收到第一件事）', () => {
  it('安静节奏的员工：显著性低于门槛时，普通同伴消息排不上队；总管在主人发起的回合里派的活排得上（真实流程里研究员的门槛 0.75 高于交接的 0.70）', async () => {
    const fix = await teamFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { pace: 'quiet', onDemand: true });
    const candidate = (extra: Record<string, unknown>) => buildCandidate(fix.ctx, {
      botId: fix.engineer.id, kind: 'peer_message', score: 0.6, summary: '交接', subjectKey: 'peer:h_0000000001', ...extra,
    });
    expect(enqueue(fix.ctx, candidate({}))).toBeNull();
    // P73r3 S1：思考门槛的豁免并入 directed（hub_handoff、hub_send 指名发出的候选一律带它）；chiefDispatch 只管冷却和最短间隔。
    const queued = enqueue(fix.ctx, candidate({ chiefDispatch: true }), { directed: true });
    expect(queued).not.toBeNull();
    expect(queued!.chiefDispatch).toBe(true);
  });
});

describe('发卡顺序与兜底', () => {
  it('13 同一回合：reply 在前，组队卡在后；「待你处理」里恰好一条，不到期、没有默认答案', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员：这件事要先查资料，以后也会常用。请你在卡片上确认。', { outcome: 'needs_owner' });
    const messages = chiefThread(fix.ctx, fix.chief.id);
    const replyAt = messages.findIndex(row => row.kind === 'reply' && row.text.includes('建议新增一位研究员'));
    const cardAt = messages.findIndex(row => row.kind === 'team');
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(cardAt).toBeGreaterThan(replyAt);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('team:'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', type: 'question', expiresAt: null, defaultOption: null, options: ['确认入职，接手这件事'] });
    expect(theProposal(fix.ctx).cardMessageId).toBe(messages[cardAt]!.id);
  });

  it('13 交账没走到发卡（回合结束了但卡没发）：tick 兜底补发卡和条目，且只补一次', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const proposal = theProposal(fix.ctx);
    // 回合还开着时 tick 不补（要等交账、reply 落楼之后）。
    await fix.hub.tick();
    expect(theProposal(fix.ctx).cardMessageId).toBeNull();
    // 回合结束但没有交账路由：唤醒单标为已结束。
    const wake = fix.ctx.store.table('wakes').get(proposal.wakeId!)!;
    fix.ctx.store.table('wakes').patch(wake.id, { endedAt: fix.ctx.clock.now() });
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    const after = theProposal(fix.ctx);
    expect(after.cardMessageId).not.toBeNull();
    expect(fix.ctx.store.table('inbox').count(row => row.subjectKey.startsWith('team:') && row.status === 'open')).toBe(1);
    await fix.hub.tick();
    expect(chiefThread(fix.ctx, fix.chief.id).filter(row => row.kind === 'team')).toHaveLength(1);
  });
});

describe('有待确认组队卡时的交账与提问', () => {
  const QUESTION = { text: '要不要新增一位研究员？', options: ['要', '不要'], defaultOption: '要', whyNeeded: '需要主人定' };

  it('14 总管带 ownerQuestion 交账被拒：报错是组队卡的文字，「待你处理」里没有新增提问条目，没有生成交账', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const commitsBefore = fix.ctx.store.table('commits').count();
    const result = await callTool(fix, fix.chief, 'hub_commit', commitArgs({ outcome: 'needs_owner', reply: '建议新增研究员', ownerQuestion: QUESTION }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('组队卡已经在等主人确认，不能再用 ownerQuestion 提问，它会生成第二张提问卡。outcome 可以写 needs_owner，不填 ownerQuestion');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith('question:'))).toEqual([]);
    expect(fix.ctx.store.table('commits').count()).toBe(commitsBefore);
  });

  it('14 needs_owner 不带 ownerQuestion 成功；总管状态是在等主人，状态行写「等你确认新员工」；「待你处理」只有组队卡一条', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const result = await callTool(fix, fix.chief, 'hub_commit', commitArgs({ outcome: 'needs_owner', reply: '建议新增一位研究员，请你确认。', ownerQuestion: null }));
    expect(result.ok).toBe(true);
    expect(fix.ctx.store.table('bots').get(fix.chief.id)).toMatchObject({ activity: 'waiting_owner', activityText: '等你确认新员工' });
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.subjectKey.startsWith('team:')).toBe(true);
  });

  it('15 反例：普通员工 needs_owner 不带 ownerQuestion 仍被拒', async () => {
    const fix = await teamFix();
    const result = await callTool(fix, fix.engineer, 'hub_commit', commitArgs({ outcome: 'needs_owner', reply: '需要你定', ownerQuestion: null }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('needs_owner 必须填写给主人提问');
  });

  it('15 反例：总管没有任何待确认时带 ownerQuestion 正常生成提问卡', async () => {
    const fix = await teamFix();
    await ownerSays(fix, fix.chief.id, '帮我看看这周的事');
    const result = await callTool(fix, fix.chief, 'hub_commit', commitArgs({ outcome: 'needs_owner', reply: '有个问题要你定', ownerQuestion: QUESTION }));
    expect(result.ok).toBe(true);
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.type === 'question' && row.title === QUESTION.text)).toBe(1);
  });

  it('组队卡被处理后，提问限制随之解除（拒绝后总管可以正常提问）', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员，请你确认。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '不新增');
    expect(theProposal(fix.ctx).state).toBe('declined');
    const result = await callTool(fix, fix.chief, 'hub_commit', commitArgs({ outcome: 'needs_owner', reply: '好的，我自己来。有个问题要你定', ownerQuestion: QUESTION }));
    expect(result.ok).toBe(true);
  });
});

describe('给主人看的文字不含工具名和内部编号', () => {
  it('20 旁白、卡片、条目、固定句：不含 hub_、b_、tpr_、agr_', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员：这件事要先查资料，以后也会常用。请你确认。', { outcome: 'needs_owner' });
    // 再走一遍修改和确认，让旁白都出现。
    await ownerSays(fix, fix.chief.id, '把研究员的说明改成只查公开资料');
    const proposal = theProposal(fix.ctx);
    const revised = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId: proposal.id, name: '研究员', brief: '只查公开资料，每条结论附出处。' });
    expect(revised).toEqual({ ok: true, text: REVISE_DONE_TEXT });
    const fresh = theProposal(fix.ctx);
    okData(await fix.hub.api.confirmTeamProposal({ proposalId: fresh.id, rev: fresh.rev }));

    // 线程里中心旁白、主人名义的确认、组队卡正文。
    const texts = chiefThread(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' || row.kind === 'team' || row.text === '确认入职').map(row => row.text);
    expect(texts).toContain(reviseNoteText('研究员', ['的员工说明已修改']));
    expect(texts.some(text => text.includes('已入职'))).toBe(true);
    for (const text of texts) expect(text, `给主人看的文字：${text}`).not.toMatch(INTERNAL);
    // 「待你处理」条目的标题、正文、按钮。
    for (const item of fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('team:'))) {
      for (const text of [item.title, item.body, ...(item.options ?? [])]) expect(text).not.toMatch(INTERNAL);
    }
    // 第二问之后总管的固定句改为只写事实，不作承诺（主会话补充要求 2）。
    expect(`已记下：项目「X」。${TEAM_PROJECT_NOTE}`).toBe('已记下：项目「X」。它的位置已写进项目背景。');
    expect(TEAM_PROJECT_NOTE).not.toMatch(INTERNAL);
    // 本卡新增的固定句（含撤下旁白）和工具返回文字。
    for (const text of [withdrawnNoteText('这件事不需要常驻'), reviseNoteText('研究员', ['换为设计师']), PROPOSE_DONE_TEXT, REVISE_DONE_TEXT, WITHDRAW_DONE_TEXT]) {
      expect(text).not.toMatch(INTERNAL);
    }
  });
});
