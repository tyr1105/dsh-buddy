/**
 * 回复下面挂的记忆行的视图（P75c 起）：「已记住　规矩　{文字}」「已删除　{旧文字}」「已更正　{新文字}」，各带「撤销」；撤销后改写成已撤销。
 *
 * 为什么由视图生成而不是存成一条消息：同一条记忆的状态会变（撤销、删除、更正），一行存成消息就要回头改历史；
 * 由 replyMessageId（记住）或 history 项上的 replyMessageId（更正、删除）反查，状态永远是最新的，
 * 两种撤销途径（按钮、文字）也自然得到同一个结果。
 * 本文件只读存储，不写任何东西。给主人看的文字里不出现工具名和内部编号（memoryId 只给界面当按钮参数用）。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Memory } from '../model/memory.js';
import { memoryScopeLine, quoteLineOf } from './memory-text.js';

/** 一行记忆变化的结构。action：noted 已记住（P75c）、deleted 已删除、corrected 已更正（P75d）。 */
export const MemoryNoteViewSchema = z.strictObject({
  memoryId: z.string(),
  kindLabel: z.enum(['规矩', '偏好', '先例']),
  action: z.enum(['noted', 'deleted', 'corrected']),
  /** noted：记住的文字；deleted：删掉的旧文字；corrected：更正后的新文字（撤销更正后为恢复的旧文字）。 */
  text: z.string(),
  state: z.enum(['active', 'undone', 'deleted']),
  /** 为真时界面显示「撤销」按钮：noted 为生效中且是主人原话记下的；deleted 为删除后 24 小时内；corrected 为更正后 24 小时内。 */
  canUndo: z.boolean(),
  /**
   * P75r1：主人当场核对用。noted 行、来源是主人原话时为「你说：「{原话前 40 个字}」」（压成一行，超出加「…」）；
   * corrected、deleted 行在这一次更正或删除记下了主人原话时同样给出；其余为 null。界面由 P75k 画。
   */
  quoteLine: z.string().nullable(),
  /** P75r1：noted 行为适用范围（写法与记忆页的范围一行完全相同，同一个函数生成）；corrected、deleted 行为 null。 */
  scopeLine: z.string().nullable(),
});
export type MemoryNoteView = z.infer<typeof MemoryNoteViewSchema>;

/** 生成适用范围一行要用的两张名字表（员工、项目）。 */
interface NameMaps { bots: ReadonlyMap<string, string>; projects: ReadonlyMap<string, string> }

/** 记忆类型的显示名。 */
const KIND_LABELS = { rule: '规矩', preference: '偏好', precedent: '先例' } as const;

/** 一条记忆对应的「已记住」行；已被取代、已被否掉的（先例才有）不显示，返回 null。 */
function noteViewOf(row: Memory, names: NameMaps): MemoryNoteView | null {
  if (row.status === 'replaced' || row.status === 'refuted') return null;
  return { memoryId: row.id, kindLabel: row.kind === 'rule' ? '规矩' : '偏好', action: 'noted', text: row.text, state: row.status,
    canUndo: row.status === 'active' && row.source.kind === 'owner_words',
    // P75r1：来源是主人原话时给出「你说：……」；适用范围与记忆页同一个函数。
    quoteLine: row.source.kind === 'owner_words' ? quoteLineOf(row.source.quote) : null,
    scopeLine: memoryScopeLine(row, names.bots, names.projects) };
}

/** 一条记忆的历史里，每一项已挂靠的更正或删除对应的一行（挂靠消息 id 与视图成对返回）。 */
function historyViews(ctx: HubContext, row: Memory): Array<{ messageId: string; at: number; view: MemoryNoteView }> {
  const now = ctx.clock.now();
  const out: Array<{ messageId: string; at: number; view: MemoryNoteView }> = [];
  const lastCorrected = row.history.map(item => item.action === 'corrected' && !item.undone).lastIndexOf(true);
  row.history.forEach((item, index) => {
    if (item.replyMessageId === null) return;
    // P76p：被主人否掉的先例也记一条 history（action 为 refuted），它不是更正或删除，这里不画。
    if (item.action !== 'corrected' && item.action !== 'deleted') return;
    // 更正、删除行：这一次记下了主人原话时给出「你说：……」；没有记下（记忆页上主人自己点的、旧形状的）为 null；范围一行只给「已记住」。
    const base = { memoryId: row.id, kindLabel: KIND_LABELS[row.kind], quoteLine: quoteLineOf(item.quote), scopeLine: null };
    if (item.action === 'deleted') {
      const canUndo = !item.undone && row.status === 'deleted' && row.endedAt !== null && now - row.endedAt <= D.DELETE_UNDO_MS;
      out.push({ messageId: item.replyMessageId, at: item.at,
        view: { ...base, action: 'deleted', text: item.text, state: item.undone ? 'undone' : 'deleted', canUndo } });
    } else {
      // 更正后的新文字：被撤销的取恢复的旧文字；否则取下一项历史里的旧文字，没有下一项就是现在的文字。
      const text = item.undone ? item.text : (row.history[index + 1]?.text ?? row.text);
      const canUndo = !item.undone && index === lastCorrected && row.status === 'active' && now - item.at <= D.DELETE_UNDO_MS;
      out.push({ messageId: item.replyMessageId, at: item.at, view: { ...base, action: 'corrected', text, state: item.undone ? 'undone' : 'active', canUndo } });
    }
  });
  return out;
}

/**
 * 一次建好「消息 id → 挂在它下面的几行」的索引。线程视图每条消息都要查，
 * 所以只扫一遍记忆表；没有任何挂靠的记忆时返回空表，视图里就不出现这个字段。同一条消息下的几行按时间排。
 */
export function memoryNotesIndex(ctx: HubContext): Map<string, MemoryNoteView[]> {
  const entries: Array<{ messageId: string; at: number; view: MemoryNoteView }> = [];
  // 范围一行要用的名字表，一次建好（每条记忆都要用）。
  const names: NameMaps = { bots: new Map(ctx.store.table('bots').list().map(row => [row.id, row.name])),
    projects: new Map(ctx.store.table('projects').list().map(row => [row.id, row.name])) };
  for (const row of ctx.store.table('memories').list()) {
    if (row.replyMessageId !== null && (row.kind === 'rule' || row.kind === 'preference')) {
      const view = noteViewOf(row, names);
      if (view !== null) entries.push({ messageId: row.replyMessageId, at: row.createdAt, view });
    }
    entries.push(...historyViews(ctx, row));
  }
  const index = new Map<string, MemoryNoteView[]>();
  for (const entry of entries.sort((a, b) => a.at - b.at)) {
    const list = index.get(entry.messageId) ?? [];
    list.push(entry.view);
    index.set(entry.messageId, list);
  }
  return index;
}
