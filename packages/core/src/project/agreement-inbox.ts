/**
 * 约定在「待你处理」里的条目维护（P72g）。
 *
 * 为什么单独一个文件：撤回条目的动作有三处要用（出新版发卡、撤下、重开后取消重开），
 * 而且 P72g 要求「按 subjectKey 前缀撤回这份约定所有还开着的条目」，不能只撤约定表里 inboxId 指着的那一条
 * （中途出错时 inboxId 可能没写回，旧条目就成了永远不到期的孤儿）。
 *
 * 约定条目的 subjectKey 形如 agreement:约定id:版本号，所以前缀 agreement:约定id: 能圈住这份约定的全部条目。
 */
import type { HubContext } from '../engine/context.js';
import { emitInboxChange } from '../outreach/inbox.js';

/** 一份约定的条目 subjectKey 前缀。 */
export function agreementInboxPrefix(agreementId: string): string {
  return `agreement:${agreementId}:`;
}

/**
 * 把这份约定所有还开着的条目改成撤回（照 inbox.ts 的撤回口径发 inbox、thread、bot 三个事件）。
 * 已回答、已撤回的不动。返回撤回了几条。
 */
export function withdrawAgreementInboxItems(ctx: HubContext, agreementId: string, answer: string): number {
  const prefix = agreementInboxPrefix(agreementId);
  const open = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(prefix));
  for (const item of open) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer, answeredAt: ctx.clock.now() });
    emitInboxChange(ctx, item);
  }
  return open.length;
}

/** 这份约定的这一版有没有对应的、还开着的条目。 */
export function hasOpenInboxItemFor(ctx: HubContext, agreementId: string, versionNo: number): boolean {
  const key = `${agreementInboxPrefix(agreementId)}${versionNo}`;
  return ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey === key) > 0;
}
