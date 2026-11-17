/**
 * 总管「记住」主人以后都适用的规矩或偏好（hub_memory 的 note，P75c，方案 7.5）。
 *
 * 为什么由中心校验而不是信模型：记忆会写进每位员工的身份文件，影响之后每一次工作。所以只有主人亲口说的话才能写进去：
 * - 调用者必须是总管，且这一回合是主人发话叫醒的；
 * - 原文由中心从这一回合的唤醒证据里取，模型只写「记住了什么」，写不出一句主人没说过的话来当出处；
 * - 主人的话里要有「以后」「每次」这类说法（NOTE_TRIGGER_WORDS），否则只按这一次处理；
 *   P76p：主人这一句是在确认上一轮的待确认问句（「要我以后都这样吗」「记下这条规矩」）时例外——
 *   上一问已经问过「以后都这样」，更早那句不必再含触发词（判断见 owner-turn.ts 的 pendingConfirmation）；
 * - 点选卡片、确认口令、验收口令这类由中心代主人落下的话（消息上带着所属记录的编号）不算主人的话，三问的回答同理；
 * - 总管上一条回复以固定句「要我以后都这样吗」结尾、主人回肯定的话（是、对、好、以后都这样……，名单见 ASK_YES_PHRASES）时，
 *   主人在那之前的一句话一并作为出处；主人回「不用，就这一次」这类话时不并入，只按本回合的话判断。
 *
 * 三段式（与前几块一致）：先校验并一次列全所有不满足的项，再写记忆，最后返回给模型的一句话。
 * 「已记住」这一行由线程视图按 replyMessageId 生成，挂靠由交账路由和回合结束时的检查完成（commit/effects.ts、turn/events.ts）。
 *
 * 本文件只读存储；写入全部经 service.ts。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { currentWake, requireChief } from '../job/manage-common.js';
import { ownerTextProblem } from '../job/owner-text.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import { ownerMessageOfWake } from '../project/agreements.js';
import type { ToolContext } from '../tools/types.js';
import { isOwnTypedWords, quoteOf, sourceMessages } from './owner-words.js';
import { pendingConfirmation } from './owner-turn.js';
import { writeMemory } from './service.js';

/** note 的参数（已过 zod 校验）。 */
export interface MemoryNoteArgs {
  kind: 'rule' | 'preference';
  text: string;
  example?: string | undefined;
  staff?: string | undefined;
  projects?: string | undefined;
}

/** 成功时返回给模型的一句话。 */
export const NOTE_DONE_TEXT = '已记下，回复里写明记住了什么、举一个例子、适用范围。';
/** 校验失败的固定说明（原文）。 */
export const NOTE_NO_TRIGGER_TEXT = '不能记：主人这句话里没有『以后』『每次』这类说法，只按这一次处理';
export const NOTE_NOT_OWNER_TURN_TEXT = '只能在主人发话叫醒的回合里记';
export const NOTE_NOT_OWN_WORDS_TEXT = '不能记：这句话是你在卡片或问题上点选、确认的回应（含组队三问的回答），不是你自己说的规矩';

/** 「全部」一类的写法：适用于全体。 */
const ALL_WORDS = ['全部', '全体', '所有', '所有人', '所有员工', '所有项目', 'all'];

/** 把「A、B，C」拆成名字列表（顿号、逗号、分号、空白都算分隔）。 */
function splitNames(raw: string | undefined): string[] {
  return (raw ?? '').split(/[、,，;；\s]+/).map(item => item.trim()).filter(item => item !== '');
}

/** 解析适用的员工名单：「全部」或名字；找不到的名字记入 missing。 */
function resolveStaff(ctx: HubContext, raw: string | undefined, missing: string[]): 'all' | string[] {
  const names = splitNames(raw);
  if (names.length === 0 || names.some(name => ALL_WORDS.includes(name))) return 'all';
  const team = ctx.store.table('bots').list(row => (ON_TEAM_LIFECYCLES as readonly string[]).includes(row.lifecycle));
  const ids: string[] = [];
  for (const name of names) {
    const bot = team.find(row => row.name === name || row.id === name);
    if (bot === undefined) missing.push(name);
    else if (!ids.includes(bot.id)) ids.push(bot.id);
  }
  return ids;
}

/** 解析适用的项目名单：「全部」或项目名（只认未归档的项目）。 */
function resolveProjects(ctx: HubContext, raw: string | undefined, missing: string[]): 'all' | string[] {
  const names = splitNames(raw);
  if (names.length === 0 || names.some(name => ALL_WORDS.includes(name))) return 'all';
  const open = ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived');
  const ids: string[] = [];
  for (const name of names) {
    const project = open.find(row => row.name === name || row.id === name);
    if (project === undefined) missing.push(name);
    else if (!ids.includes(project.id)) ids.push(project.id);
  }
  return ids;
}

/** note 的入口：校验、写记忆，返回给模型看的一句话；不满足条件抛出中文错误，没有写入。 */
export async function runMemoryNote(ctx: HubContext, tc: ToolContext, args: MemoryNoteArgs): Promise<string> {
  // ---- 第一段：校验（前两项不满足时后面没有意义，直接说；后面的一次列全）----
  const chief = requireChief(ctx, tc, '记主人的规矩');
  const wake = currentWake(ctx, tc);
  const main = wake !== null && wake.ownerInitiated === true ? ownerMessageOfWake(ctx, wake) : null;
  if (wake === null || main === null) throw new Error(NOTE_NOT_OWNER_TURN_TEXT);
  if (!isOwnTypedWords(main, wake)) throw new Error(NOTE_NOT_OWN_WORDS_TEXT);

  const problems: string[] = [];
  const sources = sourceMessages(ctx, wake, main, chief.id);
  // P76p：主人这一句是在确认上一轮的待确认问句（「要我以后都这样吗」「记下这条规矩」）时，
  // 上一问已经把「以后都这样」问过了，更早那句本身不必再含触发词；其余情形照旧要求触发词。
  const confirmed = pendingConfirmation(ctx, wake, main, chief.id);
  if (confirmed === null && !sources.some(row => D.NOTE_TRIGGER_WORDS.some(word => row.text.includes(word)))) problems.push(NOTE_NO_TRIGGER_TEXT);
  const missingStaff: string[] = [];
  const missingProjects: string[] = [];
  const staff = resolveStaff(ctx, args.staff, missingStaff);
  const projects = resolveProjects(ctx, args.projects, missingProjects);
  if (missingStaff.length > 0) problems.push(`staff：找不到这些员工：${missingStaff.join('、')}（写在岗员工的名字，或写「全部」）`);
  if (missingProjects.length > 0) problems.push(`projects：找不到这些项目：${missingProjects.join('、')}（写未归档项目的名字，或写「全部」）`);
  const example = args.example === undefined || args.example.trim() === '' ? null : args.example.trim();
  if (args.kind === 'rule' && example === null) problems.push('example：规矩必须写一个例子');
  // 记住的文字会显示给主人（「已记住：……」），不能带工具名、内部编号。
  const textProblem = ownerTextProblem('text', args.text);
  if (textProblem !== null) problems.push(textProblem);
  const exampleProblem = example === null ? null : ownerTextProblem('example', example);
  if (exampleProblem !== null) problems.push(exampleProblem);
  if (ctx.store.table('memories').count(row => row.noteWakeId === wake.id) >= D.NOTES_PER_TURN_MAX) {
    problems.push(`同一回合最多记 ${D.NOTES_PER_TURN_MAX} 条，已经记满`);
  }
  if (problems.length > 0) throw new Error(problems.join('；'));

  // ---- 第二段：写记忆（出处原文由中心从消息里抄，不经模型）----
  const quote = quoteOf(sources, D.QUOTE_MAX_CHARS);
  await writeMemory(ctx, {
    kind: args.kind, text: args.text, example, redLine: false, scope: { staff, projects },
    source: { kind: 'owner_words', messageIds: sources.map(row => row.id), quote, threadId: main.thread },
    noteWakeId: wake.id, replyMessageId: null,
  });
  // ---- 第三段：返回给模型的话 ----
  return NOTE_DONE_TEXT;
}
