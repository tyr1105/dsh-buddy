/**
 * 记忆的写入服务（P75c）：所有对 memories 表的新增和修改只经过本文件的函数。
 *
 * 为什么只留一个入口：记忆会写进每位员工的身份文件（每次请求都读），一条记忆的变化必须同时做到三件事：
 * 写表、刷新受影响员工的身份文件和全体守则、通知界面刷新。分散在各处写表，迟早有一处漏掉其中一件。
 * 测试里用文本搜索断言：src 下除本文件（和以后的迁移文件）外，没有直接写 memories 表的代码。
 *
 * 刷新身份文件出错只记日志，不让记忆写入失败：记忆已经写进表，下一次刷新（任何一次记忆变化、设置修改、
 * 回合结束的文件核对）都会把文件补齐；反过来因为文件写不进去就回滚记忆，主人看到的「已记住」会对不上。
 *
 * P75d：先例（kind 为 precedent）不进身份文件，写入、改状态、更正时都不刷新文件（refresh 为假），只通知界面；
 * 对话里的更正和删除（hub_memory 的 correct、forget）在 history 里记下回合、对话和挂靠的回复，供线程视图生成「已更正」「已删除」一行。
 *
 * 本文件只读时间用注入时钟，随机数用注入随机源，文件只经注入的文件接口。
 */
import { posix } from 'node:path';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { LEGACY_MEMORY_SOURCE_KINDS, MemorySchema, MemoryTextSchema, type Memory } from '../model/memory.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { newId } from '../util/ids.js';
import { refreshBotFiles } from './files.js';
import { renderRootAgentsMd } from './render.js';

export { citationCount, legacyRulesInEffect, legacyRulesOf, memoriesForAll, memoriesForBot, memoryCitations } from './memory-read.js';

/** 写入一条新记忆需要的字段；id、状态、历史、时间由服务生成。 */
export interface WriteMemoryInput {
  kind: Memory['kind'];
  text: string;
  example: string | null;
  redLine: boolean;
  scope: Memory['scope'];
  source: Memory['source'];
  category?: string | null;
  noteWakeId?: string | null;
  replyMessageId?: string | null;
  /** 为假时不刷新身份文件（先例用：先例不进身份文件；迁移批量写入时也用）；缺省为真。 */
  refresh?: boolean;
  /** P75f 迁移用：沿用旧规矩的创建时间；缺省用当前时钟。 */
  createdAt?: number;
}

/** 更正和状态变化的操作者：主人、总管、中心。 */
export type MemoryActor = Memory['history'][number]['by'];

/** 对话里更正或删除时，记在 history 项上的回合与对话（线程视图据此生成「已更正」「已删除」一行）。 */
export interface ChatChange {
  wakeId: string | null;
  threadId: string;
  /** P75r1：主人那句话的消息编号和原文（对话里更正、删除时由中心从消息里抄）；缺省为空。 */
  messageIds?: string[];
  quote?: string;
}

/**
 * 记忆变化之后的统一收尾：刷新受影响员工的身份文件（适用于全部员工时还要重写全体守则），再通知界面。
 * refresh 为假时只通知界面（先例的变化）。刷新出错只记日志（见文件开头的说明）。
 */
async function afterMemoryChange(ctx: HubContext, scope: Memory['scope'], refresh = true): Promise<void> {
  const all = scope.staff === 'all';
  if (refresh) {
    try {
      if (all) await ctx.fs.writeTextAtomic(posix.join(ctx.settings.rootDir, 'AGENTS.md'), renderRootAgentsMd(ctx));
    } catch (error) {
      ctx.logger.error('记忆变化后重写全体守则失败，下次刷新会补齐', error);
    }
    for (const bot of ctx.store.table('bots').list(row => all || scope.staff.includes(row.id))) {
      try {
        await refreshBotFiles(ctx, bot.id);
      } catch (error) {
        ctx.logger.error(`记忆变化后刷新 ${bot.id} 的身份文件失败，下次刷新会补齐`, error);
      }
      ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    }
  }
  ctx.emit(HUB_EVENT_SCOPES.memory, null);
}

/** 按 id 取一条记忆；不存在时报错（中文）。 */
function requireMemory(ctx: HubContext, id: string): Memory {
  const row = ctx.store.table('memories').get(id);
  if (!row) throw new Error('这一条记忆不存在');
  return row;
}

/** 这一类记忆变化要不要刷新身份文件：先例不进身份文件，其余都要。 */
function needsRefresh(row: Pick<Memory, 'kind'>): boolean {
  return row.kind !== 'precedent';
}

/** 写入一条新记忆：校验、写表、记审计、刷新身份文件、通知界面。返回写好的记忆。 */
export async function writeMemory(ctx: HubContext, input: WriteMemoryInput): Promise<Memory> {
  const now = ctx.clock.now();
  // P75r2：迁移来的旧规矩、旧教训只做结构校验，正文一字不改（不去首尾空白）；writeMemory 对正文的检查只有
  // 「去首尾空白」和 MemorySchema（非空、普通来源不超过 120 字），没有称呼、内部编号、不可见字符之类的检查
  // （那些检查在 hub_memory 等调用方里），所以这两种来源只需跳过去空白与字数上限。
  const legacy = LEGACY_MEMORY_SOURCE_KINDS.includes(input.source.kind);
  const row = parseInput(MemorySchema, {
    id: newId('mem', ctx.rng), kind: input.kind, text: legacy ? input.text : input.text.trim(), example: input.example,
    redLine: input.redLine, scope: input.scope, source: input.source, category: input.category ?? null,
    status: 'active', history: [], noteWakeId: input.noteWakeId ?? null, replyMessageId: input.replyMessageId ?? null,
    createdAt: input.createdAt ?? now, updatedAt: input.createdAt ?? now, endedAt: null,
  }, '记忆');
  ctx.store.table('memories').put(row);
  writeOutreachAudit(ctx, 'memory_write', { id: row.id, kind: row.kind, source: row.source.kind }, row.source.kind === 'owner_words' ? 'chief' : 'owner');
  await afterMemoryChange(ctx, row.scope, input.refresh ?? needsRefresh(row));
  return row;
}

/**
 * 改状态：生效、已撤销、已删除、已取代、已被否掉。结束时间随状态变化（回到生效时清空）。
 * extra.chat 有值且新状态是已删除时，在 history 记一项 action 为 deleted 的行（对话里的 forget，挂「已删除」一行用）；
 * P76p：新状态是已被否掉时同样记一项 action 为 refuted 的行（旧文字、主人原话），供审计与追溯；
 * 这一项不带回合编号，不挂「已更正」一行（否掉不是更正）。
 * 从已删除回到生效时，把最近一次未撤销的删除行标为已撤销（所以「已删除」那一行随之变成「已撤销删除」）。
 */
export async function setMemoryStatus(ctx: HubContext, id: string, status: Memory['status'], by: MemoryActor,
  extra: { chat?: ChatChange; note?: string } = {}): Promise<Memory> {
  const old = requireMemory(ctx, id);
  const now = ctx.clock.now();
  let history = old.history;
  if (status === 'deleted' && extra.chat !== undefined) {
    history = [...history, { text: old.text, at: now, by, note: extra.note ?? '你对总管说删掉', action: 'deleted' as const,
      wakeId: extra.chat.wakeId, replyMessageId: null, threadId: extra.chat.threadId, undone: false,
      messageIds: extra.chat.messageIds ?? [], quote: extra.chat.quote ?? '' }].slice(-D.HISTORY_MAX);
  } else if (status === 'refuted' && extra.chat !== undefined) {
    history = [...history, { text: old.text, at: now, by, note: extra.note ?? '你在验收时否掉了这一条', action: 'refuted' as const,
      wakeId: null, replyMessageId: null, threadId: extra.chat.threadId, undone: false,
      messageIds: extra.chat.messageIds ?? [], quote: extra.chat.quote ?? '' }].slice(-D.HISTORY_MAX);
  } else if (status === 'active' && old.status === 'deleted') {
    const index = history.map(item => item.action === 'deleted' && !item.undone).lastIndexOf(true);
    if (index >= 0) history = history.map((item, i) => (i === index ? { ...item, undone: true } : item));
  }
  const row = ctx.store.table('memories').patch(id, { status, endedAt: status === 'active' ? null : now, updatedAt: now, history });
  writeOutreachAudit(ctx, 'memory_status', { id, from: old.status, to: status }, by);
  await afterMemoryChange(ctx, row.scope, needsRefresh(row));
  return row;
}

/**
 * 更正文字：旧文字进 history（超过上限丢最早的），写新文字。
 * extra.redLine 只给「规矩」编辑入口用（旧界面的规矩编辑可以改「是否红线」）；文字没变时不记历史。
 * extra.chat 有值时，历史项带上回合和对话（对话里的 correct 挂「已更正」一行用）。
 */
export async function correctMemoryText(ctx: HubContext, id: string, text: string, by: MemoryActor, note: string,
  extra: { redLine?: boolean; chat?: ChatChange } = {}): Promise<Memory> {
  const old = requireMemory(ctx, id);
  const now = ctx.clock.now();
  const next = parseInput(MemoryTextSchema, text.trim(), 'text');
  const history = next === old.text ? old.history : [...old.history, { text: old.text, at: now, by, note, action: 'corrected' as const,
    wakeId: extra.chat?.wakeId ?? null, replyMessageId: null, threadId: extra.chat?.threadId ?? null, undone: false,
    messageIds: extra.chat?.messageIds ?? [], quote: extra.chat?.quote ?? '' }].slice(-D.HISTORY_MAX);
  const row = ctx.store.table('memories').patch(id, { text: next, history, updatedAt: now,
    ...(extra.redLine === undefined ? {} : { redLine: extra.redLine }) });
  writeOutreachAudit(ctx, 'memory_correct', { id }, by);
  await afterMemoryChange(ctx, row.scope, needsRefresh(row));
  return row;
}

/**
 * 撤销最近一次更正：文字恢复为那次更正之前的说法，那一行历史标为已撤销。
 * 只能撤销生效中记忆的、24 小时内的、还没撤销的更正；其余情况报中文错误。
 */
export async function undoLastCorrection(ctx: HubContext, id: string, by: MemoryActor): Promise<Memory> {
  const old = requireMemory(ctx, id);
  if (old.status !== 'active') throw new Error('只能撤销生效中记忆的更正');
  const index = old.history.map(item => item.action === 'corrected' && !item.undone).lastIndexOf(true);
  const target = index < 0 ? null : old.history[index]!;
  if (target === null) throw new Error('这一条没有可以撤销的更正');
  const now = ctx.clock.now();
  if (now - target.at > D.DELETE_UNDO_MS) throw new Error('更正已超过 24 小时，不能撤销');
  const history = old.history.map((item, i) => (i === index ? { ...item, undone: true } : item));
  const row = ctx.store.table('memories').patch(id, { text: target.text, history, updatedAt: now });
  writeOutreachAudit(ctx, 'memory_correct_undo', { id }, by);
  await afterMemoryChange(ctx, row.scope, needsRefresh(row));
  return row;
}

/** 把一条记忆的「已记住」挂到指定的消息下面（回合结束时中心补落一句「已记住」时用，一条一条挂）。 */
export function attachMemoryRow(ctx: HubContext, memoryId: string, messageId: string): void {
  const row = ctx.store.table('memories').patch(memoryId, { replyMessageId: messageId });
  if (row.source.threadId !== null) ctx.emit(HUB_EVENT_SCOPES.thread, row.source.threadId);
}

/** 把一条记忆里某个回合的更正、删除行挂到指定的消息下面（回合结束时中心补落一句话时用）。 */
export function attachHistoryRow(ctx: HubContext, memoryId: string, wakeId: string, messageId: string): void {
  const row = requireMemory(ctx, memoryId);
  const history = row.history.map(item => (item.wakeId === wakeId && item.replyMessageId === null ? { ...item, replyMessageId: messageId } : item));
  ctx.store.table('memories').patch(memoryId, { history });
  const thread = row.history.find(item => item.wakeId === wakeId)?.threadId ?? null;
  if (thread !== null) ctx.emit(HUB_EVENT_SCOPES.thread, thread);
}

/**
 * 把「已记住」「已更正」「已删除」挂到一条回复下面：本回合记下的、还没挂靠的、出处就在这个对话里的记忆，
 * 以及本回合在这个对话里更正、删除的历史行，记下这条回复的消息 id。
 * 只改挂靠字段，不改文字和状态，不需要刷新身份文件，只通知这个对话的界面重取。
 */
export function attachMemoryReply(ctx: HubContext, wakeId: string, threadId: string, messageId: string): number {
  const rows = ctx.store.table('memories').list(row => row.noteWakeId === wakeId && row.replyMessageId === null
    && row.source.threadId === threadId);
  for (const row of rows) ctx.store.table('memories').patch(row.id, { replyMessageId: messageId });
  // 本回合更正、删除的历史行：同一个对话里、还没挂靠的。
  const changed = ctx.store.table('memories').list(row => row.history.some(item => item.wakeId === wakeId && item.replyMessageId === null && item.threadId === threadId));
  for (const row of changed) attachHistoryRow(ctx, row.id, wakeId, messageId);
  const total = rows.length + changed.length;
  if (total > 0) ctx.emit(HUB_EVENT_SCOPES.thread, threadId);
  return total;
}
