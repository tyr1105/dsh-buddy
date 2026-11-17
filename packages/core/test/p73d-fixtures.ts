/**
 * P73d 测试的公共环境（不是测试文件）：真实 Hub + 假宿主，总管、工程师林舟（可选再加评审甲）。
 * 为什么用真实链路：工具、交账路由发卡、确认后叫醒总管、调度闸门都挂在真实链路上，只有走链路才能测到「接线」。
 * 「只用唤醒包里的文字」的测试一律用这里的正则取值，不从存储里偷看编号。
 */
import { expect } from 'vitest';
import type { Bot } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import type { TeamProposal } from '../src/model/team-proposal.js';
import { callTool, chiefDrafts, ownerSays, speak } from './p72b-fixtures.js';
import { lastPacket, topicHub, type TopicHub } from './p63-topic-fixtures.js';

export { callTool, chiefDrafts, ownerSays, speak, lastPacket };

export const MINUTE = 60_000;

/** 给员工写一条来历（说明它来自哪个模板），唤醒包和组队工具靠它识别「已有这个模板的员工」。 */
export function addOrigin(ctx: HubContext, bot: Bot, templateId: string): void {
  ctx.store.table('botOrigins').put({
    id: bot.id, botId: bot.id, templateId, source: 'team_initial', proposalId: null, joinedAt: ctx.clock.now(),
    renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null,
  });
}

export interface TeamFix extends TopicHub { chief: Bot; engineer: Bot; reviewer: Bot | null }

/** 总管「老大」、工程师「林舟」；withReviewer 时再加评审员「评审甲」。 */
export async function teamFix(options: { withReviewer?: boolean; settings?: Record<string, unknown> } = {}): Promise<TeamFix> {
  const names = ['老大', '林舟', ...(options.withReviewer ? ['评审甲'] : [])];
  const fix = await topicHub(names, options.settings ?? {});
  const [chief, engineer, reviewer] = fix.bots as [Bot, Bot, Bot | undefined];
  addOrigin(fix.ctx, engineer, 'engineer');
  if (reviewer) addOrigin(fix.ctx, reviewer, 'reviewer');
  return { ...fix, chief, engineer, reviewer: reviewer ?? null };
}

/**
 * 约定「会员定价页」刚由主人点「定了」固定，总管被叫醒（回合开着）。
 * 返回总管这一回合收到的完整唤醒包文本。
 */
export async function lockedAndAwake(fix: TeamFix, title = '会员定价页', agreementExtra: Record<string, unknown> = {}): Promise<string> {
  // P74r9：agreementExtra 并进提交约定的参数（例如 launch：验收之后对外发布一项），默认不带。
  await chiefDrafts(fix as never, { title, ...agreementExtra });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  return lastPacket(fix, fix.chief);
}

/** 只从唤醒包文本里取：约定编号（约定段「已固定」那一行）。 */
export function agreementIdIn(packet: string, title = '会员定价页'): string {
  const match = new RegExp(`已固定：约定「${title}」第 \\d+ 版（agreementId 为 (agr_[a-z0-9]{10})`).exec(packet);
  expect(match, '唤醒包约定段里应该有已固定的约定编号').not.toBeNull();
  return match![1]!;
}

/** 只从唤醒包文本里取：「可推荐的模板」里「代查资料」那一行的模板名（研究员）。 */
export function researcherNameIn(packet: string): string {
  const match = /^(.+?)（[^）]+）：代查资料/m.exec(packet);
  expect(match, '唤醒包组队段里应该有研究员那一行').not.toBeNull();
  return match![1]!;
}

/** 只从唤醒包文本里取：刚入职的新员工名字（组队段「刚由主人确认」那一句）。 */
export function newcomerNameIn(packet: string): string {
  // P74r13 第 14 节：名字与模板名相同时不写括号，所以括号这一段可有可无。
  const match = /刚由主人确认：新员工(.+?)(?:（[^）]+）)?已入职/.exec(packet);
  expect(match, '唤醒包组队段里应该有刚入职的新员工').not.toBeNull();
  return match![1]!;
}

/** 提交组队卡用的理由（两层各一句）。 */
export const REASONS = { needReason: '这件事要先查同类产品的定价', residentReason: '以后还会反复查竞品和资料' };

/** 在总管当前回合里推荐研究员（参数全部来自唤醒包文本）。 */
export async function proposeResearcher(fix: TeamFix, packet: string) {
  return callTool(fix, fix.chief, 'hub_team_propose', {
    template: researcherNameIn(packet), agreementId: agreementIdIn(packet), ...REASONS,
  });
}

/** 唯一的一张组队卡。 */
export function theProposal(ctx: HubContext): TeamProposal {
  const rows = ctx.store.table('teamProposals').list();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 总管私聊里的全部消息，从旧到新。 */
export function chiefThread(ctx: HubContext, chiefId: string) {
  return ctx.store.log('thread').all().filter(row => row.thread === chiefId);
}

/**
 * 推荐研究员、交账（reply 落楼、发卡），然后主人又说了一句话叫醒总管；返回这一回合的唤醒包。
 * 用来制造「有待确认的组队卡，且总管在一个新的主人发起的回合里」的场景。
 */
export async function proposedThenOwnerSpeaks(fix: TeamFix, ownerText: string): Promise<{ packet: string; proposalId: string }> {
  const packet = await lockedAndAwake(fix);
  const result = await proposeResearcher(fix, packet);
  expect(result).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '需要调研，建议新增一位研究员，请你在卡片上确认。', { outcome: 'needs_owner' });
  const proposalId = theProposal(fix.ctx).id;
  await ownerSays(fix, fix.chief.id, ownerText);
  return { packet: lastPacket(fix, fix.chief), proposalId };
}
