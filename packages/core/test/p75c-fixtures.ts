/**
 * P75c 测试的公共环境（不是测试文件）：在 P74 的真实 Hub 夹具上（总管听吩咐、安静节奏，执行员工听吩咐，与真实一致），
 * 提供「主人说一句话，总管拿到这一回合的唤醒包」「只从唤醒包文字里取员工名字」「记忆与身份文件的小工具」。
 * 为什么走真实链路：「已记住」挂在交账路由落下的回复下面、回合结束时还要补落，只有走真实回合才能测到接线。
 * 时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { posix } from 'node:path';
import type { HubContext } from '../src/engine/context.js';
import type { Bot } from '../src/model/index.js';
import type { Memory } from '../src/model/memory.js';
import { bot } from './p74c-fixtures.js';
import { lastPacket } from './p74d-fixtures.js';
import { callTool, jobFix, MINUTE, ownerSays, speak, type JobFix } from './p74b-fixtures.js';

export { bot, callTool, jobFix, lastPacket, MINUTE, ownerSays, speak };
export type { JobFix };

/** 主人在某个线程里说一句话，总管拿到这一回合；返回总管这一回合收到的完整唤醒包文本。 */
export async function chiefHears(fix: JobFix, text: string, threadId: string = fix.chief.id): Promise<string> {
  await ownerSays(fix, threadId, text);
  return lastPacket(fix, bot(fix, fix.chief.id));
}

/** 只从唤醒包「团队现在」一节里读出每位员工的名字（不读任何编号）。 */
export function staffNamesIn(packet: string): string[] {
  const start = packet.indexOf('## 团队现在');
  const rest = packet.slice(start + '## 团队现在'.length);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^([^：\n]+)：/gm)].map(match => match[1]!).filter(name => name !== '超时交接');
}

/** 一组合法的 note 参数，可覆盖。 */
export function noteArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'note', kind: 'rule', text: '页面上的提示文字都用「请」字开头', example: '写「请输入手机号」，不写「输入手机号」',
    staff: '全部', projects: '全部', ...extra };
}

/** 记忆表里的全部记忆，从旧到新。 */
export function memoriesOf(ctx: HubContext): Memory[] {
  return ctx.store.table('memories').list().sort((a, b) => a.createdAt - b.createdAt);
}

/** 这位员工身份文件的当前内容。 */
export async function agentsMdOf(ctx: HubContext, who: Bot): Promise<string> {
  return (await ctx.fs.readText(posix.join(who.homeDir, 'AGENTS.md'))) ?? '';
}

/** 一个线程里的全部消息，从旧到新。 */
export function messagesIn(ctx: HubContext, threadId: string) {
  return ctx.store.log('thread').all().filter(row => row.thread === threadId);
}

/**
 * 主人说一句话、总管记下一条规矩并交账（reply 写「已记住」），一回合走完；返回这条记忆和总管的回复消息。
 * 用来给撤销、更正等测试准备「已有一条已记住」。
 */
export async function noted(fix: JobFix, ownerText = '以后页面上的提示文字都用「请」字开头', extra: Record<string, unknown> = {}): Promise<{ memory: Memory; reply: ReturnType<typeof messagesIn>[number] }> {
  await chiefHears(fix, ownerText);
  const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs(extra));
  if (!result.ok) throw new Error(`记下规矩失败：${result.error}`);
  const memory = memoriesOf(fix.ctx).at(-1)!;
  await speak(fix, fix.chief, `已记住：${memory.text}，例如${memory.example ?? '无'}。适用于全部员工。`, { outcome: 'progress' });
  const after = fix.ctx.store.table('memories').get(memory.id)!;
  const reply = fix.ctx.store.log('thread').all().find(row => row.id === after.replyMessageId)!;
  return { memory: after, reply };
}
