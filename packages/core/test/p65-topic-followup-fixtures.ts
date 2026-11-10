/**
 * P65 测试共用的小工具：在主题里让队友提问、找到「回答后接着做」的那条候选或唤醒、看私聊里有什么。
 * 主题环境本身沿用 P63 的 topicHub（真实 Hub + 假宿主 + 假时钟），这里只补 P65 要用的几样。
 */
import { expect } from 'vitest';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, InboxItem, QueueEntry, ThreadMessage, WakeTicket } from '../src/model/index.js';
import { speak, type TopicHub } from './p63-topic-fixtures.js';

/** 一个固定的问题：两个选项，默认 A。 */
export const QUESTION = { text: '选 A 还是 B', options: ['A', 'B'], defaultOption: 'A', whyNeeded: '两种做法成本不同' };

/** 一条能进「待你处理」的建议（价值和把握都过门槛）。 */
export const PROPOSAL = { title: '每天早上看一眼日志', detail: '早上 9 点前看一眼昨晚的日志，有异常就告诉你。', value: 0.9, confidence: 0.9 };

/** 让这位队友在当前回合交账时提一个问题，返回「待你处理」里这张提问卡。 */
export async function ask(fix: TopicHub, bot: Bot, reply = '需要你定一下'): Promise<InboxItem> {
  await speak(fix, bot, reply, { outcome: 'needs_owner', ownerQuestion: QUESTION });
  const item = fix.ctx.store.table('inbox').list(row => row.type === 'question' && row.botId === bot.id && row.status === 'open').at(-1);
  expect(item).toBeDefined();
  return item!;
}

/** 这位队友私聊线程里的全部消息。 */
export function privateThread(ctx: HubContext, botId: string): ThreadMessage[] {
  return ctx.store.log('thread').all().filter(row => row.thread === botId);
}

/**
 * 「回答后接着做」的那条后续：还在排队就是队列里的候选，已经放行就是唤醒单。
 * 收件箱回复的证据里带收件箱项 id，审批结果的证据里带审批单 id，用这个认。
 */
export function followUpOf(ctx: HubContext, refId: string, kind: 'inbox_reply' | 'approval_decided'): QueueEntry | WakeTicket | undefined {
  const match = (row: QueueEntry | WakeTicket) => row.reason.evidence.includes(refId) && row.reason.kind === kind;
  return ctx.store.table('wakes').list(match).at(-1) ?? ctx.store.table('queue').list(match).at(-1);
}

/**
 * 这条后续回合（候选或唤醒单）存在，而且不属于任何主题。
 * 不属于主题的记录根本不写 topicId 这一项（和旧记录一样），所以按「缺省或 null」判断，不能用 toMatchObject 比 undefined。
 */
export function expectPrivate(row: { topicId?: string | null } | undefined): void {
  expect(row).toBeDefined();
  expect(row!.topicId ?? null).toBeNull();
}

/** 命令必须成功；失败时把中文原因带出来，方便看哪里不对。 */
export function expectOk(result: { ok: boolean; error?: string }): void {
  expect(result.ok ? null : result.error).toBeNull();
}
