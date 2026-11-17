/**
 * P73d 的工具测试：hub_team_propose 的校验、propose / revise / withdraw 的效果，以及与约定的互斥。
 * 为什么这样测：规则全在服务层（team/addition.ts），所以既走真实工具入口（与宿主同一入口），
 * 也在需要「卡上有两位候选」这类只有初始卡才有的场景里直接调服务。每条规则一个正例一个反例；
 * 失败的调用一律断言「什么都没写」（组队卡数量、审计、线程都不变）。时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { suggestArchiveFor } from '../src/team/archive-suggestion.js';
import { runTeamPropose } from '../src/team/addition.js';
import { TEAM_PENDING_AGREEMENT_ERROR, TEAM_PENDING_PROPOSE_ERROR } from '../src/team/owner-confirm.js';
import { alternatesFor } from '../src/team/rules.js';
import { REVISE_DONE_TEXT, WITHDRAW_DONE_TEXT } from '../src/team/addition-text.js';
import { ownerWake } from './p72a-agreement-fixtures.js';
import { agreementFixture } from './p72a-agreement-fixtures.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { answerAll, teamHub, theProposal as theInitialProposal } from './p73c-fixtures.js';
import {
  REASONS, agreementIdIn, callTool, chiefDrafts, chiefThread, lockedAndAwake, ownerSays, proposeResearcher,
  proposedThenOwnerSpeaks, researcherNameIn, speak, theProposal, teamFix, type TeamFix,
} from './p73d-fixtures.js';

/** 内部名称的正则：工具名前缀、机器人 id、组队卡编号、约定编号。 */
const INTERNAL = /hub_|b_|tpr_|agr_/;

/** 写入快照：用来断言「失败的调用什么都没写」。 */
function writes(fix: TeamFix) {
  return {
    proposals: fix.ctx.store.table('teamProposals').count(),
    audit: fix.ctx.store.log('audit').all().filter(row => row.action.startsWith('team_')).length,
    thread: chiefThread(fix.ctx, fix.chief.id).length,
    inbox: fix.ctx.store.table('inbox').count(),
  };
}

/** 完整的 propose 参数（从唤醒包文字里取）。 */
function proposeArgs(packet: string, extra: Record<string, unknown> = {}) {
  return { template: researcherNameIn(packet), agreementId: agreementIdIn(packet), ...REASONS, ...extra };
}

describe('通用校验：谁能用、什么回合能用', () => {
  it('4 非总管调用被拒且零写入：服务层说「只有总管」，工具入口同样失败', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    const before = writes(fix);
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    await expect(runTeamPropose(fix.ctx, fix.engineer.id, wake, proposeArgs(packet))).rejects.toThrow('只有总管能推荐新员工');
    const viaTool = await callTool(fix, fix.engineer, 'hub_team_propose', proposeArgs(packet));
    expect(viaTool.ok).toBe(false);
    expect(writes(fix)).toEqual(before);
  });

  it('4 不是主人发起的回合（例如自己定期醒来）被拒且零写入', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false, reason: { ...wake.reason, kind: 'next_think' } });
    const before = writes(fix);
    const result = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('组队卡只能在主人发话、确认或回答叫醒的回合里提出或修改');
    expect(writes(fix)).toEqual(before);
  });

  it('必填项缺几项一次列全；缺项不写任何东西', async () => {
    const fix = await teamFix();
    await lockedAndAwake(fix);
    const before = writes(fix);
    const result = await callTool(fix, fix.chief, 'hub_team_propose', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('缺少必填项：template、agreementId、needReason、residentReason');
    const partial = await callTool(fix, fix.chief, 'hub_team_propose', { template: '研究员', needReason: '要查资料' });
    expect(partial.error).toContain('缺少必填项：agreementId、residentReason');
    expect(writes(fix)).toEqual(before);
  });

  it('参数形状：多余字段、过长理由被参数层拒绝（中文报错），且根节点是对象', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect((await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { extra: 1 }))).ok).toBe(false);
    const long = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { needReason: '很'.repeat(81) }));
    expect(long.ok).toBe(false);
    expect(long.error).toContain('needReason');
    const tool = fix.hub.tools().find(item => item.name === 'hub_team_propose')!;
    expect(tool.description.startsWith('（仅总管）')).toBe(true);
    expect(tool.description).toContain('template 写模板名即可');
    expect(tool.jsonSchema).toMatchObject({ type: 'object' });
  });
});

describe('propose：约定、互斥、模板', () => {
  it('5 约定还没固定、不存在、不是自己的，都被拒绝（零写入）', async () => {
    const fix = await teamFix();
    await chiefDrafts(fix as never, { title: '会员定价页' }); // 约定待确认
    const pendingId = fix.ctx.store.table('agreements').list()[0]!.id;
    // 别人名下的、已固定的约定。
    fix.ctx.store.table('agreements').put(agreementFixture({ id: 'agr_0000000007', botId: fix.engineer.id, title: '别人的事' }));
    const before = writes(fix);
    for (const agreementId of [pendingId, 'agr_0000000007', 'agr_aaaaaaaaaa']) {
      const result = await callTool(fix, fix.chief, 'hub_team_propose', { template: '研究员', agreementId, ...REASONS });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('agreementId：只能为你名下已固定的约定加人');
    }
    expect(writes(fix)).toEqual(before);
  });

  it('6 总管有待确认的约定时被拒绝：说明哪份约定还在等', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    fix.ctx.store.table('agreements').put(agreementFixture({ id: 'agr_0000000008', botId: fix.chief.id, title: '另一件事' }));
    const before = writes(fix);
    const result = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('约定「另一件事」还在等主人确认，确认前不能推荐新员工');
    expect(writes(fix)).toEqual(before);
  });

  it('6 已有待确认的组队卡时再推荐被拒绝', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const before = writes(fix);
    const again = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '设计师' }));
    expect(again.ok).toBe(false);
    expect(again.error).toBe(TEAM_PENDING_PROPOSE_ERROR);
    expect(writes(fix)).toEqual(before);
  });

  it('7 有待确认的组队卡时：新建约定、修订、重新确认都被拒；amend 照常成功', async () => {
    const fix = await teamFix();
    const { packet } = await proposedThenOwnerSpeaks(fix, '把约定的一句话复述改得更短一点');
    const agreementId = agreementIdIn(packet);
    const before = writes(fix);
    const draft = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '另一件事' }));
    expect(draft).toEqual({ ok: false, error: TEAM_PENDING_AGREEMENT_ERROR });
    const revise = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId, mode: 'revise', changeNote: '改范围', scopeIn: ['只做网页'] });
    expect(revise).toEqual({ ok: false, error: TEAM_PENDING_AGREEMENT_ERROR });
    expect(writes(fix)).toEqual(before);
    // amend 不请主人确认，不受影响。
    const amend = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId, mode: 'amend', changeNote: '你要求改短', summary: '会员定价页：只做网页版，定价表由我们自己维护。' });
    expect(amend.ok).toBe(true);
    expect(amend.text).toContain('直接生效');
  });

  it('7 组队卡被处理（拒绝）之后，约定可以正常新建和修订', async () => {
    const fix = await teamFix();
    await proposedThenOwnerSpeaks(fix, '不新增');
    expect(theProposal(fix.ctx).state).toBe('declined');
    const draft = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '另一件事' }));
    expect(draft.ok).toBe(true);
  });

  it('8 模板名写错：报错列出可用模板；总管类模板被拒；模板编号也能用', async () => {
    const fix = await teamFix({ withReviewer: true });
    const packet = await lockedAndAwake(fix);
    const before = writes(fix);
    const wrong = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '卧底' }));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('template：没有叫「卧底」的模板。可推荐的模板：');
    expect(wrong.error).toContain('研究员');
    expect(wrong.error).toContain('评审员');
    expect(wrong.error).not.toContain('项目经理');
    const chief = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '项目经理' }));
    expect(chief.error).toBe('template：总管全队只能有一位');
    expect(writes(fix)).toEqual(before);
    const byId = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: 'researcher' }));
    expect(byId.ok).toBe(true);
  });

  it('8 已有评审员（全队一位）：被拒并点名；已有在岗工程师：被拒并点名', async () => {
    const fix = await teamFix({ withReviewer: true });
    const packet = await lockedAndAwake(fix);
    const before = writes(fix);
    const reviewer = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '评审员' }));
    expect(reviewer.ok).toBe(false);
    expect(reviewer.error).toBe('template：评审员全队一位，已有评审甲，直接安排他');
    const engineer = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '工程师' }));
    expect(engineer.ok).toBe(false);
    expect(engineer.error).toBe('template：在岗员工里已有工程师（林舟），直接安排他');
    expect(writes(fix)).toEqual(before);
  });

  it('8 反例：已有的工程师被停用后不算在岗，可以再推荐一位工程师', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const result = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '工程师' }));
    expect(result.ok).toBe(true);
    // 重名自动加序号。
    expect(theProposal(fix.ctx).candidates[0]!.name).toBe('工程师');
  });

  it('9 在册已满：被拒，报错里有归档建议的名字和理由，不含编号，零写入', async () => {
    const fix = await teamFix({ withReviewer: true, settings: { maxBots: 3 } });
    const packet = await lockedAndAwake(fix);
    const before = writes(fix);
    // 满员时唤醒包的组队段没有模板清单（只有一行说明），模板名直接写。
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { template: '研究员', agreementId: agreementIdIn(packet), ...REASONS });
    expect(result.ok).toBe(false);
    const pick = suggestArchiveFor(fix.ctx)!;
    expect(pick).toMatchObject({ name: '林舟', reasonText: '最近 30 天没有接活' });
    expect(result.error).toBe(`在册已满 3 位，不能推荐新员工。请用一句话建议主人先归档一位：建议归档${pick.name}，${pick.reasonText}；归档在这位员工的卡片里操作。`);
    expect(result.error).not.toMatch(INTERNAL);
    expect(writes(fix)).toEqual(before);
  });

  it('9 在册已满且没有可建议的人：请主人自己决定', async () => {
    const fix = await teamFix({ withReviewer: true, settings: { maxBots: 3 } });
    const packet = await lockedAndAwake(fix);
    // 林舟成了项目负责人（不能归档），评审员全队唯一，总管不入选：没有人可建议。
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    fix.ctx.store.table('projects').patch(agreement.projectId, { ownerBotId: fix.engineer.id, memberBotIds: [fix.chief.id, fix.engineer.id] });
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { template: '研究员', agreementId: agreementIdIn(packet), ...REASONS });
    expect(result.error).toBe('在册已满 3 位，不能推荐新员工。请用一句话请主人决定归档哪一位；归档在这位员工的卡片里操作。');
  });

  it('9 反例：在册未满时不拒绝', async () => {
    const fix = await teamFix({ settings: { maxBots: 3 } });
    const packet = await lockedAndAwake(fix);
    expect((await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet))).ok).toBe(true);
  });

  it('10 同一条主人消息 propose 两次：第二次被拒（先撤下第一张，避开「已有待确认卡」，才轮到去重规则）', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const proposal = theProposal(fix.ctx);
    expect((await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'withdraw', proposalId: proposal.id, reason: '换个思路' })).ok).toBe(true);
    const before = writes(fix);
    const second = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet, { template: '设计师' }));
    expect(second.ok).toBe(false);
    expect(second.error).toBe('主人的这句话已经出过一张组队卡了，同一句话只出一张');
    expect(writes(fix)).toEqual(before);
  });

  it('10 反例：主人的下一句话可以再出一张', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const proposal = theProposal(fix.ctx);
    expect((await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'withdraw', proposalId: proposal.id, reason: '换个思路' })).ok).toBe(true);
    await speak(fix, fix.chief, '好的，先不加人。', { outcome: 'progress' });
    await ownerSays(fix, fix.chief.id, '那还是加一位研究员吧');
    const again = await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet));
    expect(again.ok).toBe(true);
    expect(fix.ctx.store.table('teamProposals').count()).toBe(2);
  });

  it('建出的卡：一位候选取模板建议值，备选按规则表，重名自动加序号', async () => {
    const fix = await teamFix();
    const packet = await lockedAndAwake(fix);
    // 名字被占（含已归档的）时自动加序号：给一位叫「研究员」的老员工。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { name: '研究员' });
    expect((await callTool(fix, fix.chief, 'hub_team_propose', proposeArgs(packet))).ok).toBe(true);
    const candidate = theProposal(fix.ctx).candidates[0]!;
    expect(candidate.name).toBe('研究员2');
    expect(candidate.suggested).toEqual({ templateId: 'researcher', name: '研究员2', mbti: 'INTP', modelTier: 'standard' });
    expect(candidate.alternates.map(item => item.templateId)).toEqual(alternatesFor('researcher').map(item => item.templateId));
  });
});

describe('revise：按主人的话修改待确认的组队卡', () => {
  it('11 只改指定那一位的员工说明：其他字段逐项不变，rev 加 1，旁白正确，条目仍只有一条', async () => {
    const fix = await teamFix();
    const { packet, proposalId } = await proposedThenOwnerSpeaks(fix, '把研究员的员工说明改成只查公开资料');
    const before = theProposal(fix.ctx);
    const brief = '只查公开资料，每条结论都附出处；查不到就明说。';
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief });
    expect(result).toEqual({ ok: true, text: REVISE_DONE_TEXT });
    const after = theProposal(fix.ctx);
    expect(after.rev).toBe(before.rev + 1);
    expect(after.candidates).toEqual([{ ...before.candidates[0]!, brief }]);
    expect({ ...after, rev: 0, candidates: [], updatedAt: 0 }).toEqual({ ...before, rev: 0, candidates: [], updatedAt: 0 });
    const notes = chiefThread(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.text.startsWith('组队卡已按你的话更新'));
    expect(notes.map(row => row.text)).toEqual(['组队卡已按你的话更新：研究员的员工说明已修改。']);
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith('team:'));
    expect(open).toHaveLength(1);
    expect(packet).toContain(proposalId); // 编号来自唤醒包文字（上一回合的包里就有）
  });

  it('11 同一条主人消息对同一张卡 revise 两次：第二次被拒，卡不变', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '把研究员的员工说明改成只查公开资料');
    expect((await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief: '第一版说明。' })).ok).toBe(true);
    const snapshot = theProposal(fix.ctx);
    const second = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief: '第二版说明。' });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('主人的这句话已经改过这张组队卡了，同一句话只改一次');
    expect(theProposal(fix.ctx)).toEqual(snapshot);
  });

  it('11 换模板：建议值同步、记录原模板、旧说明清空；两项都改时旁白用「；」连接', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '换成设计师，说明写成只做原型');
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, name: '研究员', template: '设计师', brief: '只做能直接打开的原型。' });
    expect(result.ok).toBe(true);
    const candidate = theProposal(fix.ctx).candidates[0]!;
    expect(candidate).toMatchObject({
      templateId: 'designer', name: '设计师', mbti: 'ISFJ', modelTier: 'standard', swappedFrom: 'researcher', brief: '只做能直接打开的原型。',
      suggested: { templateId: 'designer', name: '设计师', mbti: 'ISFJ', modelTier: 'standard' },
    });
    expect(candidate.alternates.map(item => item.templateId)).toEqual(alternatesFor('designer').map(item => item.templateId));
    const note = chiefThread(fix.ctx, fix.chief.id).filter(row => row.text.startsWith('组队卡已按你的话更新')).at(-1)!;
    expect(note.text).toBe('组队卡已按你的话更新：研究员的员工说明已修改；换为设计师。');
    // 条目标题和正文跟着卡片更新，仍是一条。
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith('team:'));
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain('设计师');
  });

  it('11 只换模板（不给说明）：说明保持为空', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '换成设计师');
    expect((await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, template: '设计师' })).ok).toBe(true);
    expect(theProposal(fix.ctx).candidates[0]).toMatchObject({ templateId: 'designer', brief: null });
    expect(chiefThread(fix.ctx, fix.chief.id).at(-1)!.text).toBe('组队卡已按你的话更新：研究员换为设计师。');
  });

  it('11 换模板的校验同推荐：已有在岗员工的模板、全队一位已有、总管类、不存在，都被拒绝且卡不变', async () => {
    const fix = await teamFix({ withReviewer: true });
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '换个人');
    const snapshot = theProposal(fix.ctx);
    const cases: Array<[string, string]> = [
      ['工程师', 'template：在岗员工里已有工程师（林舟），直接安排他'],
      ['评审员', 'template：评审员全队一位，已有评审甲，直接安排他'],
      ['项目经理', 'template：总管全队只能有一位'],
      ['研究员', 'template：卡上这位已经是「研究员」'],
    ];
    for (const [template, error] of cases) {
      const result = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, template });
      expect(result.error).toBe(error);
    }
    const unknown = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, template: '卧底' });
    expect(unknown.error).toContain('没有叫「卧底」的模板');
    expect(theProposal(fix.ctx)).toEqual(snapshot);
  });

  it('11 template 与 brief 都没给被拒；不是主人消息叫醒的回合被拒；不是自己的卡被拒', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '改一下');
    const snapshot = theProposal(fix.ctx);
    const none = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId });
    expect(none.error).toContain('至少给一项');
    const blank = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief: '   ' });
    expect(blank.ok).toBe(false);
    const foreign = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId: 'tpr_aaaaaaaaaa', brief: '说明' });
    expect(foreign.error).toBe('proposalId：只能修改或撤下你名下待确认的组队卡');
    const noId = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', brief: '说明' });
    expect(noId.error).toContain('proposalId');
    // 回合不是主人的话叫醒的：把本回合的唤醒原因改成非主人消息（ownerInitiated 仍为真，例如主人点按钮叫醒）。
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerDirect: false, reason: { ...wake.reason, kind: 'agenda_due' } });
    const notMessage = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief: '说明' });
    expect(notMessage.error).toBe('组队卡只能根据主人的话修改：这一回合不是主人发消息叫醒的');
    expect(theProposal(fix.ctx)).toEqual(snapshot);
  });

  it('11 卡上有两位（初始卡）：省略 name 被拒；name 写错时列出卡上的名字；写对时只改那一位，其他逐项不变', async () => {
    const hub = await teamHub();
    const initial = await answerAll(hub);
    expect(initial.candidates.map(item => item.name)).toEqual(['工程师', '设计师', '评审员']);
    const chief = hub.chief!;
    const call = (args: Record<string, unknown>) => runTeamPropose(hub.ctx, chief.id, ownerWake(hub.ctx, chief.id, '改一下设计师'), args);
    await expect(call({ mode: 'revise', proposalId: initial.id, brief: '说明' })).rejects.toThrow('name：卡上有几位，请写明改哪一位');
    await expect(call({ mode: 'revise', proposalId: initial.id, name: '厨师', brief: '说明' })).rejects.toThrow('name：卡上没有叫「厨师」的人。卡上的名字：工程师、设计师、评审员');
    expect(theInitialProposal(hub.ctx)).toEqual(initial);
    await call({ mode: 'revise', proposalId: initial.id, name: '设计师', brief: '只出手机端原型。' });
    const after = theInitialProposal(hub.ctx);
    expect(after.rev).toBe(initial.rev + 1);
    expect(after.candidates[0]).toEqual(initial.candidates[0]);
    expect(after.candidates[2]).toEqual(initial.candidates[2]);
    expect(after.candidates[1]).toEqual({ ...initial.candidates[1]!, brief: '只出手机端原型。' });
    // 换成卡上已有的模板被拒。
    await expect(call({ mode: 'revise', proposalId: initial.id, name: '设计师', template: '评审员' })).rejects.toThrow('这张卡上已经有「评审员」');
    // 去掉的那位不能被改。
    hub.ctx.store.table('teamProposals').put({ ...after, candidates: after.candidates.map(item => item.key === 'c3' ? { ...item, removed: true } : item) });
    await expect(call({ mode: 'revise', proposalId: initial.id, name: '评审员', brief: '说明' })).rejects.toThrow('已被主人去掉');
  });
});

describe('withdraw：撤下组队卡', () => {
  it('12 卡转 withdrawn，条目撤回，中心旁白写原因，总管状态行恢复；不再有待确认', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '那就不加人了，你自己做');
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith('team:'))).toBe(1);
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'withdraw', proposalId, reason: '主人说由我自己完成' });
    expect(result).toEqual({ ok: true, text: WITHDRAW_DONE_TEXT });
    const proposal = theProposal(fix.ctx);
    expect(proposal).toMatchObject({ state: 'withdrawn', decidedVia: 'chief' });
    expect(proposal.decidedAt).not.toBeNull();
    expect(proposal.candidates[0]!.outcome).toEqual({ kind: 'not_hired' });
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('team:'));
    expect(items.map(item => item.status)).toEqual(['withdrawn']);
    expect(chiefThread(fix.ctx, fix.chief.id).at(-1)!.text).toBe('总管撤下了组队卡：主人说由我自己完成');
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.activityText).not.toBe('等你确认新员工');
    // 约定可以正常提交了（互斥解除）。
    expect((await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '另一件事' }))).ok).toBe(true);
  });

  it('12 对已确认的卡 withdraw 被拒；缺原因被拒；别人的卡被拒', async () => {
    const fix = await teamFix();
    const { proposalId } = await proposedThenOwnerSpeaks(fix, '随便说一句');
    const proposal = theProposal(fix.ctx);
    const noReason = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'withdraw', proposalId });
    expect(noReason.error).toContain('reason');
    expect(theProposal(fix.ctx).state).toBe('pending');
    fix.ctx.store.table('teamProposals').put({
      ...proposal, state: 'confirmed', decidedAt: fix.ctx.clock.now(), decidedVia: 'button',
      candidates: [{ ...proposal.candidates[0]!, outcome: { kind: 'hired', botId: fix.engineer.id } }],
    });
    const confirmed = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'withdraw', proposalId, reason: '想撤' });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toBe('proposalId：只能修改或撤下你名下待确认的组队卡');
    expect(theProposal(fix.ctx).state).toBe('confirmed');
  });

  it('12 撤下初始组队卡：三问转 done', async () => {
    const hub = await teamHub();
    const initial = await answerAll(hub);
    const chief = hub.chief!;
    await runTeamPropose(hub.ctx, chief.id, ownerWake(hub.ctx, chief.id, '先不用加人'), { mode: 'withdraw', proposalId: initial.id, reason: '主人暂时不需要' });
    expect(theInitialProposal(hub.ctx).state).toBe('withdrawn');
    expect(hub.ctx.store.table('teamSetups').list()[0]!.state).toBe('done');
    expect(hub.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('team:') && row.status === 'open')).toEqual([]);
  });
});
