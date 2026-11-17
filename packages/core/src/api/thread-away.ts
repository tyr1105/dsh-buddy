/**
 * 总管私聊视图顶部的「离开期间摘要」（P76i）：在 threadView 的结果上补一个可选字段 awaySummary。
 *
 * 为什么另写一个包装而不直接改 threadView（feed-views.ts）：P76g 同时在改同一个文件里组装「待你处理」条目的函数，
 * 本卡按派活说明不碰那个文件，合并时才不会冲突。UiApi 的 thread 视图走这个包装，行为与「threadView 自己带这个字段」一致。
 *
 * 只在三个条件同时成立时才带这个字段（否则整个字段不出现，既有视图逐字不变）：
 * 这条线程是总管的私聊；ownerPresence 里有离开期间摘要；摘要还没有被你收起。
 * 摘要是视图字段，不是消息：不进线程、不占未读。
 */
import type { HubContext } from '../engine/context.js';
import { getPresence } from '../outreach/presence.js';
import { threadView } from './feed-views.js';
import type { PageInput, ThreadView } from './types.js';

/** 摘要的收起按钮文字（固定句，供界面登记）。 */
export const AWAY_DISMISS_TEXT = '收起' as const;

/** 总管私聊的视图；该带摘要时多一个 awaySummary 字段。 */
export function threadViewWithAway(ctx: HubContext, threadId: string, page?: PageInput): ThreadView {
  const view = threadView(ctx, threadId, page);
  if (ctx.store.table('bots').get(threadId)?.role !== 'chief') return view;
  const away = getPresence(ctx)?.away;
  if (away === null || away === undefined || away.dismissedAt !== null) return view;
  return { ...view, awaySummary: { lines: [...away.lines], dismissText: AWAY_DISMISS_TEXT } };
}
