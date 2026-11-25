/**
 * W11 总管按项目挑人：三问答完后叫醒总管跑一个挑人回合，总管用 hub_team_propose 的 initial 模式出初始组队卡。
 *
 * 覆盖三类情况（方案的验收标准）：
 * - 总管挑人成功：唤醒包里有主人原话和项目背景；卡上每位写着在这个项目里做什么；总管按项目调整的配置入职时生效；
 * - 超出限制被拦下：人数、重复、总管模板、已在岗、名字重复、技能不存在、挑人回合里做别的事、不在等挑人时调用；
 * - 退回默认推荐：超时、回合结束却没出卡，都按规则表出卡并写明总管没有参与；之后总管再调用被拒。
 * 用真实中心 + 假宿主；参数只从唤醒包文字里取，不从存储里偷看编号。
 */
import { describe, expect, it } from 'vitest';
import { teamCardViewFor } from '../src/api/team-views.js';
import { botMbti } from '../src/personality/profile.js';
import { BOT_TEMPLATES } from '../src/team/templates.js';
import { TEAM_DEFAULTS } from '../src/config/defaults.js';
import { PICK_SUBJECT_PREFIX } from '../src/team/pick-key.js';
import { PICK_WAIT_TEXT } from '../src/team/pick-request.js';
import { PICK_FALLBACK_PREFIX } from '../src/team/proposals.js';
import { settleTeamSetup, sweepTeamSetup } from '../src/team/setup.js';
import type { Bot } from '../src/model/index.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { okData, pick, teamHub, theProposal, theSetup, thread, type TeamFix } from './p73c-fixtures.js';

/** 总管最近一次收到的唤醒包（第一回合随建会话一起投递，之后走 deliver）。 */
function chiefPacket(fix: TeamFix): string {
  const calls = fix.ctx.host.calls.filter(call => call.method === 'deliver' || call.method === 'createSession');
  expect(calls.length).toBeGreaterThan(0);
  const last = calls.at(-1)!;
  if (last.method === 'deliver') return last.args[1] as string;
  return JSON.stringify(last.args[0]);
}

function chiefOf(fix: TeamFix): Bot {
  return fix.ctx.store.table('bots').get(fix.chief!.id)!;
}

async function callTool(fix: TeamFix, name: string, args: unknown) {
  const tool = fix.hub.tools().find(item => item.name === name)!;
  return tool.handler(chiefOf(fix).sessionId!, args) as Promise<{ ok: boolean; text?: string; error?: string }>;
}

/** 总管交账（带一句回复）并结束回合。 */
async function chiefCommits(fix: TeamFix, reply: string): Promise<void> {
  const commit = fix.hub.tools().find(tool => tool.name === 'hub_commit')!;
  expect(await commit.handler(chiefOf(fix).sessionId!, commitArgs({ reply }))).toMatchObject({ ok: true });
  await fix.hub.onTurnEvent({ type: 'ended', sessionId: chiefOf(fix).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 500 });
}

/** 三问答完：第一问打字描述项目，第二问没有，第三问只在拍板时。返回挑人回合的唤醒单。 */
async function answeredWithWords(fix: TeamFix, words: string) {
  okData(await fix.hub.api.sendMessage(fix.chief!.id, words));
  okData(await pick(fix, 2, 'no'));
  okData(await pick(fix, 3, 'decisions'));
  await settleTeamSetup(fix.ctx);
  const wake = fix.ctx.store.table('wakes').list(row => row.subjectKey?.startsWith(PICK_SUBJECT_PREFIX) === true)[0];
  expect(wake, '答完三问应该排了挑人回合并投递出去').toBeDefined();
  return wake!;
}

const CARD_SITE = '我想做一个卡牌收藏网站，能浏览卡牌、记录我收了哪些';

describe('总管挑人成功', () => {
  it('唤醒包里有原话和挑人要求；总管挑两位并按项目调整；卡片在回复之后；卡上写要做的工作；确认后配置生效', async () => {
    const fix = await teamHub();
    const wake = await answeredWithWords(fix, CARD_SITE);
    expect(wake).toMatchObject({ ownerInitiated: true, botId: fix.chief!.id });
    expect(thread(fix.ctx, fix.chief!.id).at(-1)!.text).toBe(PICK_WAIT_TEXT);
    const packet = chiefPacket(fix);
    expect(packet).toContain('等你挑人');
    expect(packet).toContain(CARD_SITE);
    expect(packet).toContain('可推荐的模板');
    expect(packet).toContain('可选技能');
    expect(fix.ctx.store.table('teamProposals').count()).toBe(0);

    const brief = '负责卡牌馆的页面：先做列表页和详情页，接入主人现有的卡牌数据，改完自己在浏览器里点一遍。';
    const result = await callTool(fix, 'hub_team_propose', {
      mode: 'initial',
      candidates: [
        { template: '工程师', work: '搭卡牌馆的列表页和详情页，接入现有卡牌数据', brief, skills: ['build-self-check'] },
        { template: '设计师', work: '出收藏页和卡牌详情的页面原型', mbti: 'INFP', modelTier: 'light' },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    // 交账前不发卡：卡片跟在总管的回复后面。
    expect(fix.ctx.store.table('teamProposals').list()[0]!.cardMessageId).toBeNull();
    await chiefCommits(fix, '我挑了两位：工程师做页面和数据，设计师先出原型。');
    const proposal = theProposal(fix.ctx);
    expect(proposal).toMatchObject({ kind: 'initial', state: 'pending', pickedBy: 'chief', wakeId: wake.id });
    expect(theSetup(fix.ctx)).toMatchObject({ state: 'proposed', proposalId: proposal.id });
    const rows = thread(fix.ctx, fix.chief!.id);
    const card = rows.findIndex(row => row.kind === 'team');
    expect(rows[card - 1]!.text).toContain('我挑了两位');
    // 轻档不可用：总管要的轻档被换成标准档。
    expect(proposal.candidates.map(row => [row.templateId, row.mbti, row.modelTier, row.work])).toEqual([
      ['engineer', 'ISTJ', 'standard', '搭卡牌馆的列表页和详情页，接入现有卡牌数据'],
      ['designer', 'INFP', 'standard', '出收藏页和卡牌详情的页面原型'],
    ]);

    const view = teamCardViewFor(fix.ctx, proposal.id)!;
    expect(view.sourceNote).toBeNull();
    expect(view.candidates.map(row => [row.work, row.adjusted, row.briefChanged])).toEqual([
      ['搭卡牌馆的列表页和详情页，接入现有卡牌数据', ['员工说明', '技能'], false],
      ['出收藏页和卡牌详情的页面原型', ['性格'], false],
    ]);

    okData(await fix.hub.api.confirmTeamProposal({ proposalId: proposal.id, rev: proposal.rev }));
    const engineer = fix.ctx.store.table('bots').list(bot => bot.name === '工程师')[0]!;
    const designer = fix.ctx.store.table('bots').list(bot => bot.name === '设计师')[0]!;
    expect(engineer.presetSkillIds).toEqual(['build-self-check']);
    expect(botMbti(fix.ctx, designer.id)).toBe('INFP');
    expect(engineer.brief).toBe(brief);
    // 没调整的项照模板：设计师的员工说明、技能都是模板原样。
    expect(designer.brief).toBe(BOT_TEMPLATES.find(template => template.id === 'designer')!.brief);
    expect(designer.presetSkillIds).toEqual([...BOT_TEMPLATES.find(template => template.id === 'designer')!.presetSkillIds]);
  });
});

describe('挑人段的项目背景', () => {
  it('第二问给了项目文件夹：唤醒包里有项目名和背景里的文件夹路径', async () => {
    const fix = await teamHub();
    okData(await pick(fix, 1, 'software'));
    okData(await pick(fix, 2, 'yes', { folderPath: '/Users/x/cards' }));
    okData(await pick(fix, 3, 'decisions'));
    const packet = chiefPacket(fix);
    expect(packet).toContain('在做的项目：cards');
    expect(packet).toContain('项目文件夹：/Users/x/cards');
  });
});

describe('超出限制被拦下', () => {
  it('人数、重复、总管、名字、技能、模板不存在都被拒，且不写任何东西', async () => {
    const fix = await teamHub();
    await answeredWithWords(fix, CARD_SITE);
    const bad = async (candidates: unknown, contains: string) => {
      const result = await callTool(fix, 'hub_team_propose', { mode: 'initial', candidates });
      expect(result.ok, JSON.stringify(candidates)).toBe(false);
      expect(result.error).toContain(contains);
    };
    const one = (template: string, extra: Record<string, unknown> = {}) => ({ template, work: '做事', ...extra });
    await bad([one('工程师'), one('设计师'), one('评审员'), one('研究员')], '最多');
    await bad([], '至少');
    await bad([one('工程师'), one('工程师')], '挑了两次');
    await bad([one('项目经理')], '总管');
    await bad([one('不存在的岗位')], '没有叫');
    await bad([one('工程师', { name: fix.chief!.name })], '已经有人用了');
    await bad([one('工程师', { skills: ['no-such-skill'] })], '没有叫「no-such-skill」的技能');
    await bad([one('工程师', { work: 'x'.repeat(TEAM_DEFAULTS.PICK_WORK_MAX_CHARS + 1) })], '不能超过');
    expect(fix.ctx.store.table('teamProposals').count()).toBe(0);
    expect(theSetup(fix.ctx)).toMatchObject({ state: 'asking', proposalId: null });
  });

  it('已在岗的模板不能再挑；挑人回合里不能做别的写操作；按需加人的 propose 也不行', async () => {
    const fix = await teamHub();
    okData(await fix.hub.api.createBot({ name: '工程师', role: 'executor', templateId: 'engineer', persona: '先核实再行动', aspirations: ['把页面做对'] }));
    await answeredWithWords(fix, CARD_SITE);
    const onDuty = await callTool(fix, 'hub_team_propose', { mode: 'initial', candidates: [{ template: '工程师', work: '做页面' }] });
    expect(onDuty.ok).toBe(false);
    expect(onDuty.error).toContain('已有');
    const other = await callTool(fix, 'hub_agenda_upsert', { kind: 'review', title: '记一件别的事', abandonWhen: '不需要时', priority: 2 });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('只挑初始团队');
    const propose = await callTool(fix, 'hub_team_propose', { template: '研究员', agreementId: 'agr_0000000001', needReason: 'a', residentReason: 'b' });
    expect(propose.ok).toBe(false);
    expect(propose.error).toContain('只挑初始团队');
  });
});

describe('退回默认推荐', () => {
  it('超过 90 秒没出卡：按规则表出卡，结论句和卡片都写明总管没有参与；之后总管再调用被拒', async () => {
    const fix = await teamHub();
    await answeredWithWords(fix, CARD_SITE);
    fix.ctx.clock.advance(TEAM_DEFAULTS.PICK_TIMEOUT_MS);
    sweepTeamSetup(fix.ctx);
    await settleTeamSetup(fix.ctx);
    const proposal = theProposal(fix.ctx);
    expect(proposal).toMatchObject({ pickedBy: 'default', wakeId: null });
    const texts = thread(fix.ctx, fix.chief!.id).map(row => row.text);
    expect(texts.some(text => text.startsWith(PICK_FALLBACK_PREFIX('timeout')))).toBe(true);
    const view = teamCardViewFor(fix.ctx, proposal.id)!;
    expect(view.sourceNote).toBe('这是默认推荐，总管没有参与挑人。');
    expect(view.candidates.every(row => row.work === null && row.adjusted.length === 0)).toBe(true);
    const late = await callTool(fix, 'hub_team_propose', { mode: 'initial', candidates: [{ template: '研究员', work: '查资料' }] });
    expect(late.ok).toBe(false);
    expect(late.error).toContain('没有等你挑人');
  });

  it('挑人回合结束了却没出卡：下一次兜底检查立刻出默认推荐，不等 90 秒', async () => {
    const fix = await teamHub();
    await answeredWithWords(fix, CARD_SITE);
    // 没超时、回合还开着：不兜底。
    sweepTeamSetup(fix.ctx);
    await settleTeamSetup(fix.ctx);
    expect(fix.ctx.store.table('teamProposals').count()).toBe(0);
    await chiefCommits(fix, '我想一想。');
    sweepTeamSetup(fix.ctx);
    await settleTeamSetup(fix.ctx);
    expect(theProposal(fix.ctx).pickedBy).toBe('default');
    expect(thread(fix.ctx, fix.chief!.id).some(row => row.text.startsWith(PICK_FALLBACK_PREFIX('no_card')))).toBe(true);
  });
});
