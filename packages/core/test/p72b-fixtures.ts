/**
 * P72b 测试的公共环境（不是测试文件）：真实 Hub + 假宿主，总管是第一位成员。
 * 为什么用真实链路：闸门、发卡都挂在工具、交账路由、主题推进上，只有走真实链路才能测到「接线」。
 */
import { expect } from 'vitest';
import type { Bot } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { applyLock } from '../src/project/agreements.js';
import { floors, openTopic, queued, runningWake, speak, topicHub, type TopicHub } from './p63-topic-fixtures.js';
import { submitFixture } from './p72a-agreement-fixtures.js';

export { floors, openTopic, queued, runningWake, speak };

/** 总管（第一位）、两位执行员工（小王、小李）。 */
export async function setup() {
  const fix = await topicHub();
  return { ...fix, chief: fix.bots[0]!, wang: fix.bots[1]!, li: fix.bots[2]! };
}
export type Fix = Awaited<ReturnType<typeof setup>>;

/** 主人在某个线程里说一句话，叫醒对应的人（私聊线程 id 就是机器人 id，主题线程 id 就是主题 id）。 */
export async function ownerSays(fix: TopicHub, threadId: string, text: string): Promise<void> {
  const result = await fix.hub.api.sendMessage(threadId, text);
  expect(result.ok).toBe(true);
}

/** 以某个员工的会话调用工具（和宿主真实调用同一入口）。 */
export async function callTool(fix: TopicHub, bot: Bot, name: string, args: unknown) {
  const tool = fix.hub.tools().find(item => item.name === name)!;
  return tool.handler(bot.sessionId!, args) as Promise<{ ok: boolean; text?: string; error?: string }>;
}

/** 总管提交新约定用的参数（可覆盖字段）。 */
export function newAgreementArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return submitFixture(extra);
}

/** 主人在私聊里说一句，总管提交约定并返回约定 id（回合还开着，没交账）。 */
export async function chiefDrafts(fix: Fix, extra: Record<string, unknown> = {}): Promise<string> {
  await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
  const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs(extra));
  expect(result).toMatchObject({ ok: true });
  return fix.ctx.store.table('agreements').list()[0]!.id;
}

/** 把约定改成已固定（手工写表，等价于 P72c 做完后的结果）。 */
export function lockAgreement(ctx: HubContext, agreementId: string): void {
  const agreement = ctx.store.table('agreements').get(agreementId)!;
  ctx.store.table('agreements').put(applyLock(agreement, {
    version: agreement.versions.at(-1)!.no, via: 'button', choices: null, at: ctx.clock.now(), confirmMessageId: null,
  }));
}

/** 总管私聊里除主人发言外的全部消息，按时间从旧到新。 */
export function chiefReplies(ctx: HubContext, chiefId: string) {
  return floors(ctx, chiefId).filter(row => row.from !== 'owner');
}
