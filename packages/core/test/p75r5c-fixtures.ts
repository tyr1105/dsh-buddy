/**
 * P75r5c 测试的公共环境（不是测试文件）：在 p75i-fixtures 的基础上加几个小工具。
 *
 * 为什么需要 ageSkill：P75r5c 之后，每周整理判断「最近用到」取「最近一次被调用、当前版本建立的时间、最近一次放回的时间」三者里最晚的。
 * 测试里用 seedSkill 现建的技能，版本是刚刚建立的，会被当成「刚刚用到」；要造出「很久没有用到」的技能，
 * 必须把技能的建立时间和它全部版本的建立时间一起往前改。
 */
import { expect } from 'vitest';
import { runningOf } from './p74c-fixtures.js';
import { MINUTE, tick, type JobFix } from './p75g-fixtures.js';

export * from './p75i-fixtures.js';

/**
 * 把一条技能改成「很久以前建立」：技能的建立时间、它全部版本的建立时间都改成 at；lastUsedAt、restoredAt 按参数设置
 * （不传 lastUsedAt 为 null，不传 restoredAt 不设置）。用来造「最近没有用到」的技能。
 */
export function ageSkill(fix: JobFix, skillId: string, at: number, options: { lastUsedAt?: number | null; restoredAt?: number | null } = {}): void {
  fix.ctx.store.table('skills').patch(skillId, {
    createdAt: at, lastUsedAt: options.lastUsedAt ?? null,
    ...(options.restoredAt === undefined ? {} : { restoredAt: options.restoredAt }),
  });
  for (const version of fix.ctx.store.table('skillVersions').list(row => row.skillId === skillId)) {
    fix.ctx.store.table('skillVersions').patch(version.id, { createdAt: at });
  }
}

/**
 * 让这位员工拿到一个回合，并且这个回合的唤醒包是「随新会话一起送出」的（员工的会话过期、中心换了新会话）：
 * 返回交给宿主建会话的第一条消息（也就是唤醒包）。普通的 nextPacket 读的是投递给旧会话的那一条，这条路径上读不到。
 */
export async function nextPacketViaNewSession(fix: JobFix, botId: string): Promise<string> {
  for (let i = 0; i < 8 && !runningOf(fix, botId); i += 1) await tick(fix, 5 * MINUTE);
  expect(runningOf(fix, botId), '应该已经拿到一个回合').toBeDefined();
  const calls = fix.ctx.host.calls.filter(call => call.method === 'createSession' && (call.args[0] as { botId: string }).botId === botId);
  expect(calls.length, '应该为这位员工建了新会话').toBeGreaterThan(0);
  return (calls.at(-1)!.args[0] as { firstMessage: string }).firstMessage;
}

/** 一条技能的当前版本的全部句子文字。 */
export function currentSentenceTexts(fix: JobFix, skillId: string): string[] {
  const skill = fix.ctx.store.table('skills').get(skillId)!;
  const version = fix.ctx.store.table('skillVersions').list(row => row.skillId === skillId && row.no === skill.currentVersionNo)[0];
  expect(version, '技能应该有当前版本').toBeDefined();
  return version!.sentences.map(row => row.text);
}
