/**
 * P74b 测试的公共环境（不是测试文件）：在 P73d 的真实 Hub 夹具上，多一位执行者、可选一位评审员，
 * 并提供「只从唤醒包文字里取值」的正则、派活参数、以及零写入的快照比较。
 * 为什么走真实链路：派活要经过工具、真实的启动整理、调度闸门，才能测到接线；不用人为调高分值的候选，
 * 也不用跳过启动整理的仿真世界。
 */
import { expect } from 'vitest';
import type { Bot } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { CHIEF_AUTO_SETTINGS, CHIEF_AUTO_SOURCE, CHIEF_AUTO_TEMPLATE_ID } from '../src/team/chief.js';
import { templateById } from '../src/team/templates.js';
import { newAgreementArgs, lockAgreement } from './p72b-fixtures.js';
import { addOrigin, callTool, chiefDrafts, lockedAndAwake, MINUTE, ownerSays, speak, type TeamFix } from './p73d-fixtures.js';
import { topicHub } from './p63-topic-fixtures.js';

export { callTool, chiefDrafts, lockedAndAwake, lockAgreement, MINUTE, ownerSays, speak };

/** 团队夹具：总管「老大」、工程师「林舟」、评审员「评审甲」，可再加若干位工程师（名字由调用者给）。 */
export interface JobFix extends Omit<TeamFix, 'reviewer'> { reviewer: Bot; extras: Bot[] }

export async function jobFix(extraEngineers: string[] = [], settings: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}): Promise<JobFix> {
  const fix = await topicHub(['老大', '林舟', '评审甲', ...extraEngineers], settings, ctxExtra);
  const [rawChief, engineer, rawReviewer, ...extras] = fix.bots as [Bot, Bot, Bot, ...Bot[]];
  addOrigin(fix.ctx, engineer, 'engineer');
  addOrigin(fix.ctx, rawReviewer, 'reviewer');
  for (const extra of extras) addOrigin(fix.ctx, extra, 'engineer');
  // P74r2a：总管与评审员改成与真实一致，测试才不会靠夹具里与真实不符的设置碰巧通过。
  // 总管：真实总管由中心自动建（听吩咐、安静节奏、来历为自动创建），取值引用 team/chief.ts 的常量。
  const chief = fix.ctx.store.table('bots').patch(rawChief.id, { ...CHIEF_AUTO_SETTINGS });
  fix.ctx.store.table('botOrigins').put({
    id: chief.id, botId: chief.id, templateId: CHIEF_AUTO_TEMPLATE_ID, source: CHIEF_AUTO_SOURCE, proposalId: null,
    joinedAt: fix.ctx.clock.now(), renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null,
  });
  // 评审员：真实模板的角色是「建议」（advisor），不是执行类。
  const reviewerRole = templateById('reviewer')!.role;
  const reviewer = fix.ctx.store.table('bots').patch(rawReviewer.id, { role: reviewerRole });
  return { ...fix, chief, engineer, reviewer, extras };
}

/** 从总管唤醒包的「当前在岗的员工」那一行里取每位员工的名字和角色标签（只靠文字，不看存储）。 */
export function staffIn(packet: string): Array<{ name: string; duty: string }> {
  const line = /当前在岗的员工：(.+?)。约定里的工作/.exec(packet);
  expect(line, '唤醒包里应该有「当前在岗的员工」一行').not.toBeNull();
  return [...line![1]!.matchAll(/([^、（]+)（(?:[^，）]+，)?([^，）]+)，在办 \d+ 件/g)].map(match => ({ name: match[1]!, duty: match[2]! }));
}

/** 从唤醒包「刚由主人确认」那一行取「怎样算做完」的条数（只靠文字）。 */
export function doneCountIn(packet: string): number {
  const match = /怎样算做完：(.+?)。这次不做：/.exec(packet);
  expect(match, '唤醒包里应该有「怎样算做完」').not.toBeNull();
  return [...match![1]!.matchAll(/(?:^| )(\d+)\. /g)].length;
}

/** 派活的一组合法参数（交付时间在假时钟之后）。 */
export function assignArgs(agreementId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'assign', agreementId, executor: '林舟', reviewer: '评审甲', dueAt: '2026-11-17 18:00', deliveryItems: [], launchStep: false, ...extra };
}

/** 总管在同一回合里再提交一份新约定，返回它的编号（待确认状态）。 */
export async function chiefDraftsAnother(fix: JobFix, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const before = new Set(fix.ctx.store.table('agreements').list().map(row => row.id));
  const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title, ...extra }));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return fix.ctx.store.table('agreements').list().find(row => !before.has(row.id))!.id;
}

/** 总管再提交一份约定并手工固定（等价于主人点了确认），返回编号。 */
export async function chiefHasLockedAnother(fix: JobFix, title: string): Promise<string> {
  const id = await chiefDraftsAnother(fix, title);
  lockAgreement(fix.ctx, id);
  return id;
}

/** 某个主题里的全部线程消息，从旧到新。 */
export function threadOf(ctx: HubContext, threadId: string) {
  return ctx.store.log('thread').all().filter(row => row.thread === threadId);
}

/** 一份「全部状态」快照：用来断言失败后没有任何残留。 */
export function stateSnapshot(ctx: HubContext, fix: JobFix, agreementId: string, botId: string) {
  const agreement = ctx.store.table('agreements').get(agreementId)!;
  return {
    jobs: ctx.store.table('jobs').list().map(row => row.id),
    members: [...ctx.store.table('projects').get(agreement.projectId)!.memberBotIds],
    topicThread: threadOf(ctx, agreement.topicId).map(row => row.id),
    chiefThread: threadOf(ctx, fix.chief.id).map(row => row.id),
    queue: ctx.store.table('queue').list(row => row.botId === botId).map(row => row.id),
    bot: ctx.store.table('bots').get(botId),
    events: ctx.store.log('jobEvents').all().map(row => row.id),
    percepts: ctx.store.table('percepts').list(row => row.botId === botId).map(row => row.id),
  };
}
