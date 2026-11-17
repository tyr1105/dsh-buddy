/**
 * 总管约定段里「可引用的出处」的三组（P75d，方案 7.5「对齐时引用」）：规矩与偏好、先例、项目页的决策。
 *
 * 为什么三组分开：总管对齐时要先找「同类的事主人定过什么」。规矩和偏好是主人的话，先例是主人定过的约定，
 * 决策是项目页上记下的；每条都带编号，总管填 basis.ref 只能写这些编号，中心再按编号核对真实存在（resolveBasis）。
 *
 * P75r1：任何时候都使用（记忆不设开关）；旧规矩表在迁移完成之前一并列在「主人的规矩与偏好」一组的记忆之后。
 * 本文件只读存储，不写任何东西。
 */
import { AGREEMENT_DEFAULTS as D, MEMORY_DEFAULTS as M } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Memory } from '../model/memory.js';
import { pendingAgreementsOf } from '../project/agreements.js';
import { agreementCategory } from '../project/agreement-category.js';
import { allPromptMemories, legacyRulesOf, memoryCitations } from '../memory/memory-read.js';

/** 三组出处各自的行（已带编号和截断）。 */
export interface SourceGroups { rules: string[]; precedents: string[]; decisions: string[] }

/** 把多行压成一行并按完整字符截取，不加省略号。 */
function clipChars(text: string, max: number): string {
  return [...text.replace(/\s*\r?\n\s*/g, ' ').trim()].slice(0, max).join('');
}

/** 一条先例的一行：「mem_…：{类别}｜{text}（{约定标题}约定第 {n} 版）」。 */
function precedentLine(ctx: HubContext, row: Memory): string {
  const title = ctx.store.table('agreements').get(row.source.agreementId ?? '')?.title ?? '已删除的约定';
  return `${row.id}：${clipChars(`${row.category ?? '其他'}｜${row.text}`, D.PACKET_SOURCE_CHARS)}（${title}约定第 ${row.source.versionNo ?? 1} 版）`;
}

/**
 * 先例按类别分组：本回合有待确认的约定时，那份约定（最近更新的一份）的类别排第一；其余按组内最新的 createdAt 倒序；
 * 组内按 createdAt 倒序；合计最多 PACKET_PRECEDENTS_MAX 条。
 */
function precedentRows(ctx: HubContext, bot: Bot): Memory[] {
  const rows = ctx.store.table('memories').list(row => row.status === 'active' && row.kind === 'precedent');
  const groups = new Map<string, Memory[]>();
  for (const row of rows) groups.set(row.category ?? '其他', [...(groups.get(row.category ?? '其他') ?? []), row]);
  for (const list of groups.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  const pending = pendingAgreementsOf(ctx, bot.id)[0];
  const first = pending === undefined ? null : agreementCategory(ctx, pending.id);
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === first ? -1 : 0) - (b[0] === first ? -1 : 0)
    || b[1][0]!.createdAt - a[1][0]!.createdAt);
  return ordered.flatMap(([, list]) => list).slice(0, M.PACKET_PRECEDENTS_MAX);
}

/**
 * 一条记忆行尾的适用范围后缀（P75r1，M3）：只适用于部分员工写「（仅适用于员工名、员工名）」，只用于部分项目写「（仅用于项目名、项目名）」，
 * 两样都有就两个后缀都加；全部员工、全部项目的不加。员工或项目已不存在时写「已离队的员工」「已删除的项目」（与记忆页一致）。
 * 为什么要写：总管对齐时要知道这一条能不能拿去别的项目、别的员工用；不写的话它只能看到编号和文字。
 */
export function scopeSuffix(ctx: HubContext, row: Memory): string {
  let suffix = '';
  if (row.scope.staff !== 'all') {
    suffix += `（仅适用于${row.scope.staff.map(id => ctx.store.table('bots').get(id)?.name ?? '已离队的员工').join('、')}）`;
  }
  if (row.scope.projects !== 'all') {
    suffix += `（仅用于${row.scope.projects.map(id => ctx.store.table('projects').get(id)?.name ?? '已删除的项目').join('、')}）`;
  }
  return suffix;
}

/**
 * 取三组出处：规矩与偏好（全部生效中的，被引用多的在前，行尾带适用范围后缀）、先例、项目页的决策（沿用原来的取法）；
 * 三组合计不超过 PACKET_SOURCES_MAX 条。
 * P75r1：旧规矩表在迁移完成之前一并生效，作用于全队或总管的旧规矩接在记忆之后（每行 ru_…：文字）；
 * 第一组的条数上限 PACKET_RULES_MAX 对合并后的列表生效（记忆在前）。
 */
export function memorySourceGroups(ctx: HubContext, bot: Bot): SourceGroups {
  const cited = memoryCitations(ctx);
  const memoryLines = allPromptMemories(ctx)
    .sort((a, b) => (cited.get(b.id) ?? 0) - (cited.get(a.id) ?? 0) || b.updatedAt - a.updatedAt)
    .map(row => `${row.id}：${clipChars(row.text, D.PACKET_SOURCE_CHARS)}${scopeSuffix(ctx, row)}`);
  // 旧规矩按创建时间从新到旧（与改动前「可引用的出处」里旧规矩的排法一致）。
  const legacyLines = legacyRulesOf(ctx, bot).sort((a, b) => b.createdAt - a.createdAt).map(row => `${row.id}：${clipChars(row.text, D.PACKET_SOURCE_CHARS)}`);
  const rules = [...memoryLines, ...legacyLines].slice(0, M.PACKET_RULES_MAX);
  const precedents = precedentRows(ctx, bot).map(row => precedentLine(ctx, row));
  const room = Math.max(0, M.PACKET_SOURCES_MAX - rules.length - precedents.length);
  const decisions = ctx.store.table('projects')
    .list(p => p.archivedAt === null && p.status !== 'archived' && p.memberBotIds.includes(bot.id))
    .flatMap(p => p.context.decisions).sort((a, b) => b.at - a.at)
    .map(row => `${row.id}：${clipChars(row.text, D.PACKET_SOURCE_CHARS)}`).slice(0, room);
  return { rules, precedents, decisions };
}

/** 把三组拼成约定段里的文字；三组都为空时返回 null（调用方沿用原来的「暂无可引用的出处」句）。precedentLimit 用于超出字节上限时先截先例。 */
export function renderSourceGroups(groups: SourceGroups, precedentLimit: number = groups.precedents.length): string | null {
  const precedents = groups.precedents.slice(0, precedentLimit);
  if (groups.rules.length + precedents.length + groups.decisions.length === 0) return null;
  const parts = ['可引用的出处（basis.ref 只能写这些编号）：'];
  if (groups.rules.length > 0) parts.push('主人的规矩与偏好：', ...groups.rules);
  if (precedents.length > 0) parts.push('先例（按类别，同类的事先看这里）：', ...precedents);
  if (groups.decisions.length > 0) parts.push('项目页的决策：', ...groups.decisions);
  return parts.join('\n');
}
