/**
 * P73d 总管唤醒包的测试：守则第 6、10 条、「组队」段的五种内容、事实行里的「在办几件」。
 * 为什么这样测：唤醒包是模型每个回合唯一能看见的规矩，所以一律断言最终字符串。
 * 组队段的各种内容直接在存储里造夹具再调 buildTeamBody；需要真实链路的（不新增之后的唤醒包）走真实 Hub。
 */
import { describe, expect, it } from 'vitest';
import { TEAM_DEFAULTS } from '../src/config/defaults.js';
import { renderBotAgentsMd } from '../src/memory/render.js';
import { ProjectSchema, emptyProjectContext } from '../src/model/project.js';
import { TeamProposalSchema, type TeamProposal } from '../src/model/team-proposal.js';
import { postThread } from '../src/outreach/thread.js';
import { CHIEF_RULES_TEXT, staffFactLine } from '../src/wake/chief-packet.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { TEAM_SECTION_TITLE, buildTeamBody } from '../src/wake/team-section.js';
import { byteLength } from '../src/util/text.js';
import { agreementFixture } from './p72a-agreement-fixtures.js';
import { botFixture } from './model-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import { setup } from './p72b-fixtures.js';
import { addOrigin, proposedThenOwnerSpeaks, teamFix } from './p73d-fixtures.js';

/** 守则第 6 条、第 10 条的逐字原文（照任务卡抄写，不引用被测常量，防止常量被误改后测试跟着变）。 */
const RULE_6 = `6. 你不能替主人确认约定，主人说「定了」由中心识别。约定刚固定时，reply 用一句话说明交付时间，以及什么情况才会再来问你；交付时间以约定为准，约定里没有写的，不要在回复里另报时间。约定固定后安排人，按顺序做：
   一、列出这件事需要哪几种角色，取最少的人：一件事一位执行者；需要交付前核对的，由评审员核对；改动小的，或团队里没有评审员时，由你自己核对。
   二、在岗员工够用：直接调用 hub_job_manage 派活（mode 写 assign，参数见下方「在岗员工」那一行），不等主人确认；中心会把主人的原话、草图和约定作为文件交给执行者，并在主题里告诉主人谁执行、谁核对。reply 在交付时间那句之后只加一句安排：「这件事由某某（岗位名称）执行，某某在交付前核对。理由：……」；某某没有岗位名称就不写括号。理由只写角色对应和手上空不空。同角色的两位都空闲时，选最近做过同一项目的那位，这条不写进 reply。
   三、在岗员工里缺少需要的角色：只用这一次的需要，由你自己完成，reply 写「这是一次性的需要，由我自己完成，不新增员工。」；以后还会反复用到的，调用 hub_team_propose 推荐一位（template 写模板名，agreementId 写这份约定，needReason 写这件事为什么需要，residentReason 写为什么值得常驻），reply 用一句话说明这两层理由，请主人在卡片上确认。说不出为什么值得常驻，就按一次性处理。组队卡确认前，不把这件事交给任何人。
   四、在册已满时不推荐；reply 用一句话建议主人先归档一位，写明建议归档谁、为什么，以及在这位员工的卡片里操作。
   五、只有不需要专业技能、几步就能完成的小事才自己做。约定的工作只能用 hub_job_manage 派活，不能用 hub_send 交代。`;
const RULE_10 = '10. 组队卡等主人确认期间：不提交新约定，不重新确认约定，也不能派活（这件事的派活和主题里的 @ 会被中心拦下），确认前不要把这件事交给别人。主人要改卡上某位的员工说明，或换成模板库里的其他人，用 hub_team_propose 的 mode revise（proposalId 写卡片编号，name 写卡上的名字，brief 写完整的员工说明，或 template 写新模板名），reply 用一句话说明改了什么。主人回复「不新增」时，中心会撤下卡片，这件事由你自己完成。';

/** 总管的一个常规回合环境（单个总管，没有任何约定和组队卡）。 */
const chiefTurn = () => turnContext('regular', { role: 'chief' });

/** 取出「组队」段正文（从标题到下一个二级标题之前）。 */
function teamSection(packet: string): string {
  const rest = packet.split(`${TEAM_SECTION_TITLE}\n`)[1] ?? '';
  return rest.split('\n\n## ')[0]!;
}

/** 一张组队卡夹具（按需加人，一位研究员），按需覆盖字段。 */
function proposalFixture(chiefId: string, patch: Partial<TeamProposal> = {}): TeamProposal {
  return TeamProposalSchema.parse({
    id: 'tpr_0000000001', chiefId, kind: 'addition', state: 'pending', rev: 1, agreementId: 'agr_0000000001',
    needReason: '要查资料', residentReason: '以后常用',
    candidates: [{
      key: 'c1', templateId: 'researcher', suggested: { templateId: 'researcher', name: '研究员', mbti: 'INTP', modelTier: 'standard' },
      name: '研究员', mbti: 'INTP', modelTier: 'standard', removed: false, brief: null, alternates: [], swappedFrom: null, outcome: null,
    }],
    cardMessageId: null, inboxId: null, sourceMessageId: null, wakeId: null, decidedAt: null, decidedVia: null, rosterAfter: null,
    createdAt: 1000, updatedAt: 1000, ...patch,
  });
}

describe('16 守则第 6、10 条', () => {
  it('总管完整唤醒包里逐字出现第 6 条和第 10 条；第 9 条之后紧跟第 10 条', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(RULE_6);
    expect(packet).toContain(RULE_10);
    expect(packet).toContain(CHIEF_RULES_TEXT);
    expect(CHIEF_RULES_TEXT).toContain(`用主人看得懂的说法。\n${RULE_10}`);
  });

  it('非总管员工的唤醒包不出现第 6、10 条和组队段；总管的 AGENTS.md 有 hub_team_propose，其他员工的没有', async () => {
    const other = await turnContext('regular', { role: 'executor' });
    const packet = await buildWakePacket(other.ctx, other.bot, other.entry, other.ticket);
    expect(packet).not.toContain('约定固定后安排人，按顺序做');
    expect(packet).not.toContain('组队卡等主人确认期间');
    expect(packet).not.toContain(TEAM_SECTION_TITLE);
    expect(packet).not.toContain('hub_team_propose');
    const chief = await chiefTurn();
    expect(renderBotAgentsMd(chief.ctx, chief.bot)).toContain('hub_team_propose 推荐新员工（仅总管）');
    expect(renderBotAgentsMd(other.ctx, other.bot)).not.toContain('hub_team_propose');
  });

  it('总管的轻复查包、复盘包不带组队段（与约定段同一条件）', async () => {
    for (const variant of ['light_check', 'reflection'] as const) {
      const { ctx, bot, entry, ticket } = await turnContext(variant, { role: 'chief' });
      expect(await buildWakePacket(ctx, bot, entry, ticket)).not.toContain(TEAM_SECTION_TITLE);
    }
  });
});

describe('17 「组队」段的五种内容', () => {
  it('1 刚由主人确认入职：证据里有「确认入职」那条主人消息时，写名字、模板、约定标题和交接做法', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    const hired = { ...botFixture, id: 'b_0000000009', name: '研究员', role: 'researcher' as const, lifecycle: 'active' as const };
    ctx.store.table('bots').put(hired);
    ctx.store.table('agreements').put(agreementFixture({ botId: bot.id, title: '会员定价页' }));
    const proposal = proposalFixture(bot.id, {
      state: 'confirmed', decidedAt: 2000, decidedVia: 'button', rosterAfter: 2,
      candidates: [{ ...proposalFixture(bot.id).candidates[0]!, outcome: { kind: 'hired', botId: hired.id } }],
    });
    ctx.store.table('teamProposals').put(proposal);
    const message = postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '确认入职', refId: proposal.id });
    const withEvidence = { ...entry, reason: { ...entry.reason, evidence: [message.id] } };
    // P74r13 第 14 节改了预期：原来写「新员工研究员（研究员）已入职」；名字与模板名相同时不写括号。
    expect(buildTeamBody(ctx, bot, withEvidence)).toContain('刚由主人确认：新员工研究员已入职，为约定「会员定价页」而来。现在调用 hub_job_manage，mode 写 assign，agreementId 写 agr_0000000001，executor 写研究员，dueAt 写约定里的交付时间。');
    // 反例：证据里没有这条消息时不写。
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('刚由主人确认');
  });

  it('2 刚被主人拒绝：证据里有「不新增」且这张卡已是 declined；反例：没有这条消息或卡还待确认时不写', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    const message = postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '不新增' });
    const withEvidence = { ...entry, reason: { ...entry.reason, evidence: [message.id] } };
    ctx.store.table('teamProposals').put(proposalFixture(bot.id));
    expect(buildTeamBody(ctx, bot, withEvidence)).not.toContain('主人刚选择不新增员工');
    ctx.store.table('teamProposals').put(proposalFixture(bot.id, {
      state: 'declined', decidedAt: message.createdAt, decidedVia: 'text',
      candidates: [{ ...proposalFixture(bot.id).candidates[0]!, outcome: { kind: 'not_hired' } }],
    }));
    expect(buildTeamBody(ctx, bot, withEvidence)).toContain('主人刚选择不新增员工：这件事由你自己完成。');
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('主人刚选择不新增员工');
  });

  it('3 待确认的组队卡：写卡编号、用途、每位的名字、模板、性格、档位；被主人去掉的标出来', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    ctx.store.table('agreements').put(agreementFixture({ botId: bot.id, title: '会员定价页' }));
    ctx.store.table('teamProposals').put(proposalFixture(bot.id));
    expect(buildTeamBody(ctx, bot, entry)).toContain('待主人确认：组队卡（proposalId 为 tpr_0000000001，为约定「会员定价页」加人）：研究员（研究员，INTP，标准档）。');
    const first = proposalFixture(bot.id).candidates[0]!;
    ctx.store.table('teamProposals').put(proposalFixture(bot.id, {
      kind: 'initial', agreementId: null, needReason: null, residentReason: null,
      candidates: [first, { ...first, key: 'c2', templateId: 'designer', name: '设计师', mbti: 'ISFJ', modelTier: 'light', removed: true,
        suggested: { templateId: 'designer', name: '设计师', mbti: 'ISFJ', modelTier: 'light' } }],
    }));
    expect(buildTeamBody(ctx, bot, entry)).toContain('待主人确认：组队卡（proposalId 为 tpr_0000000001，初始团队）：研究员（研究员，INTP，标准档）、设计师（设计师，ISFJ，轻档，主人选了不要）。');
  });

  it('4 三问的答案：三问已完成且答案齐全才写；项目名取自项目，没有项目写「暂无」', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    const answers = { work: 'research' as const, workText: null, hasProject: false, projectId: null, projectFolder: null, notify: 'each_done' as const };
    const setup = { id: 'tsu_0000000001', chiefId: bot.id, state: 'done' as const, step: 3 as const, answers, questionMessageIds: [], proposalId: null, createdAt: 1, updatedAt: 1 };
    ctx.store.table('teamSetups').put(setup);
    expect(buildTeamBody(ctx, bot, entry)).toContain('主人在组队时说：以调研与写作为主；在做的项目：暂无；希望被打扰的程度：每件事做完都告诉我。');
    // 反例：三问没有完成或答案不齐，不写。
    ctx.store.table('teamSetups').put({ ...setup, state: 'asking' });
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('主人在组队时说');
    ctx.store.table('teamSetups').put({ ...setup, answers: { ...answers, notify: null } });
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('主人在组队时说');
    // 三类都有的写法。
    ctx.store.table('teamSetups').put({ ...setup, answers: { ...answers, work: 'mixed' } });
    expect(buildTeamBody(ctx, bot, entry)).toContain('主人在组队时说：三类都有；');
  });

  it('5 可推荐的模板：每个模板一行，已有在岗员工的、全队一位已有的行末标注；总管模板不列；格式是「名（角色）：适合做」', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    const engineer = { ...botFixture, id: 'b_0000000007', name: '林舟', role: 'executor' as const, lifecycle: 'active' as const };
    const reviewer = { ...botFixture, id: 'b_0000000008', name: '评审甲', role: 'advisor' as const, lifecycle: 'active' as const };
    ctx.store.table('bots').put(engineer);
    ctx.store.table('bots').put(reviewer);
    addOrigin(ctx, engineer, 'engineer');
    addOrigin(ctx, reviewer, 'reviewer');
    const body = buildTeamBody(ctx, bot, entry);
    expect(body).toContain('可推荐的模板（template 写名字）：');
    expect(body).toContain('研究员（调研）：代查资料，结论在前，每条都附出处。\n');
    expect(body).toContain('工程师（执行）：写页面和功能，改完自己跑一遍，说明怎样验证。（已有林舟，直接安排）');
    expect(body).toContain('评审员（评审）：交付前对照约定逐条核对，写明哪里不符、改到什么程度算过。（已有评审甲，直接安排）');
    expect(body).not.toContain('项目经理（');
    // 反例：已有的工程师被停用后，不再标「直接安排」。
    ctx.store.table('bots').patch(engineer.id, { lifecycle: 'paused' });
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('已有林舟');
  });

  it('5 在册已满：只有一行，含归档建议；没有可建议的人时请主人决定；未满时不出现这一行', async () => {
    const { ctx, bot, entry } = await chiefTurn();
    Object.assign(ctx.settings, { maxBots: 2 });
    const idle = { ...botFixture, id: 'b_0000000007', name: '老员工', role: 'executor' as const, lifecycle: 'active' as const };
    ctx.store.table('bots').put(idle);
    expect(buildTeamBody(ctx, bot, entry)).toBe('在册已满 2 位，不能推荐；需要新角色时，建议主人先归档老员工（最近 30 天没有接活）。');
    // 员工是项目负责人，不能归档：请主人决定。
    ctx.store.table('projects').put(projectOwnedBy(idle.id));
    expect(buildTeamBody(ctx, bot, entry)).toBe('在册已满 2 位，不能推荐；需要新角色时，请主人决定先归档哪一位。');
    Object.assign(ctx.settings, { maxBots: 6 });
    expect(buildTeamBody(ctx, bot, entry)).not.toContain('在册已满');
  });

  it('段落超过上限时被截断，且不超过自身上限；总管守则整段保留，守则和约定段之外的预算不被占用', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    ctx.store.table('agreements').put(agreementFixture({ botId: bot.id, title: '会员定价页' }));
    const first = proposalFixture(bot.id).candidates[0]!;
    ctx.store.table('teamProposals').put(proposalFixture(bot.id, {
      kind: 'initial', agreementId: null, needReason: null, residentReason: null,
      candidates: [first, { ...first, key: 'c2', templateId: 'designer', name: '设计师', suggested: { ...first.suggested, templateId: 'designer', name: '设计师' } },
        { ...first, key: 'c3', templateId: 'reviewer', name: '评审员', suggested: { ...first.suggested, templateId: 'reviewer', name: '评审员' } }],
    }));
    // 三问答案里的项目名很长（上限 120 字），让整段内容明显超过 1.5 KB。
    ctx.store.table('projects').put({ ...projectOwnedBy(bot.id), id: 'prj_0000000008', name: '长'.repeat(100) });
    const answers = { work: 'mixed' as const, workText: null, hasProject: true, projectId: 'prj_0000000008', projectFolder: '/x', notify: 'decisions' as const };
    ctx.store.table('teamSetups').put({ id: 'tsu_0000000001', chiefId: bot.id, state: 'done', step: 3, answers, questionMessageIds: [], proposalId: null, createdAt: 1, updatedAt: 1 });
    const body = buildTeamBody(ctx, bot, entry);
    expect(byteLength(body)).toBeLessThanOrEqual(TEAM_DEFAULTS.PACKET_MAX_BYTES);
    // 整份内容比上限长：最后一个模板（市场专员）已被截掉，开头的待确认和三问答案还在。
    expect(body).toContain('待主人确认：组队卡');
    expect(body).toContain('主人在组队时说');
    expect(body).not.toContain('市场专员');
    // 完整唤醒包：守则整段在，组队段在，且组队段没有超过上限。
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(CHIEF_RULES_TEXT);
    expect(byteLength(teamSection(packet))).toBeLessThanOrEqual(TEAM_DEFAULTS.PACKET_MAX_BYTES);
  });
});

/** 一个由某位员工负责的项目夹具（用来让这位员工不能被建议归档）。 */
function projectOwnedBy(botId: string) {
  return ProjectSchema.parse({
    id: 'prj_0000000009', name: '某项目', charter: '', vision: '', conventions: '', status: 'active', ownerBotId: botId,
    memberBotIds: [botId], sharedDir: '/hub/projects/prj_0000000009/', acceptanceCriteria: [],
    context: emptyProjectContext(), contextRevisions: [], createdAt: 1, updatedAt: 1, archivedAt: null,
  });
}

describe('18 在岗员工事实行：在办几件、最近做过的项目、角色显示标签', () => {
  it('在办件数 = 进行中或待验收的事务 + 待接收或已接收的交接；最近做过的项目取最近一条事务所属的项目', async () => {
    const fix = await setup();
    const now = fix.ctx.clock.now();
    const task = (n: number, status: string, projectId: string, updatedAt: number) => ({
      id: `pt_${String(n).padStart(10, '0')}`, projectId, title: `事务${n}`, detail: '', assigneeBotId: fix.wang.id, status, wakeIds: [], artifactIds: [],
      createdAt: now, updatedAt, dueAt: null,
    }) as never;
    // 另一个更早的项目。
    fix.ctx.store.table('projects').put({ ...fix.ctx.store.table('projects').get(fix.project.id)!, id: 'prj_0000000099', name: '旧项目', ownerBotId: null, memberBotIds: [fix.wang.id] });
    for (const row of [
      task(1, 'doing', fix.project.id, now + 5), task(2, 'done_pending_check', fix.project.id, now + 4),
      task(3, 'todo', fix.project.id, now + 3), task(4, 'accepted', fix.project.id, now + 2), task(5, 'doing', 'prj_0000000099', now + 1),
    ]) fix.ctx.store.table('projectTasks').put(row);
    const handoff = (n: number, status: string) => ({
      id: `h_${String(n).padStart(10, '0')}`, from: fix.chief.id, to: fix.wang.id, task: '交接', files: [], status, agendaId: null, createdAt: now, updatedAt: now,
    }) as never;
    for (const row of [handoff(1, 'offered'), handoff(2, 'accepted'), handoff(3, 'done'), handoff(4, 'declined'), handoff(5, 'expired')]) {
      fix.ctx.store.table('handoffs').put(row);
    }
    // 小王：进行中 2 + 待验收 1 + 交接 2 = 5；小李什么都没有。
    expect(staffFactLine(fix.ctx)).toContain('当前在岗的员工：小王（执行，在办 5 件，最近做过「季度战役」）、小李（执行，在办 0 件）。约定里的工作');
  });

  it('员工有模板显示标签的用显示标签（评审员写「评审」），没有来历的用角色标签', async () => {
    const fix = await setup();
    addOrigin(fix.ctx, fix.li, 'reviewer');
    expect(staffFactLine(fix.ctx)).toContain('小王（执行，在办 0 件）、小李（评审员，评审，在办 0 件）');
  });
});

describe('19 「不新增」之后总管的唤醒包', () => {
  it('主人回复「不新增」：卡转 declined，总管这一回合的唤醒包有「主人刚选择不新增员工」，不再有待确认的卡', async () => {
    const fix = await teamFix();
    const { packet } = await proposedThenOwnerSpeaks(fix, '不新增');
    expect(fix.ctx.store.table('teamProposals').list()[0]!.state).toBe('declined');
    const section = teamSection(packet);
    expect(section).toContain('主人刚选择不新增员工：这件事由你自己完成。');
    expect(section).not.toContain('待主人确认：组队卡');
  });

  it('反例：待确认期间主人说别的话，唤醒包写待确认的卡，不写「不新增」', async () => {
    const fix = await teamFix();
    const { packet } = await proposedThenOwnerSpeaks(fix, '研究员的说明改一下');
    const section = teamSection(packet);
    expect(section).toMatch(/待主人确认：组队卡（proposalId 为 tpr_[a-z0-9]{10}，为约定「会员定价页」加人）：研究员（研究员，INTP，标准档）。/);
    expect(section).not.toContain('主人刚选择不新增员工');
  });
});
