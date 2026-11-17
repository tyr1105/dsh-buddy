/**
 * 约定的标题跟着新版本走（P74r16b 第 3.3 节）。
 *
 * 为什么需要：总管修订约定时可以改标题（例如「活动报名页（限 80 人）」改成「活动报名页」），但原来修订时标题一律沿用，
 * 新版本固定之后主题的标题仍停在旧名字上，和约定对不上。
 *
 * 做法：
 * - 每一版自己的标题，只在和「当前已固定的标题」（约定记录上的 title）不同时才记下，记在提交约定的审计行里
 *   （action 为 agreement_submit，detail 里的 title），不改约定的存储结构；没记的版本就是沿用当前标题；
 * - 新版本固定时，这一版的标题与固定之前的标题不同：约定记录上的标题随之改成新标题；
 *   并且主题此刻的标题等于固定之前的标题（主人没有自己改过）时，把主题的标题也改成新标题，在主题里落一句工作往来。
 *   主人自己改过主题标题的不动。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import { readAuditDetail } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';

/** 主题里落的那一句（给主人看，逐字固定）。 */
export function topicTitleFollowText(versionNo: number, title: string): string {
  return `主题的标题已随约定第 ${versionNo} 版改为「${title}」。`;
}

/** 某一版的标题：最近一条记着这一版标题的提交审计；没有就是沿用约定记录上的当前标题。 */
export function versionTitleOf(ctx: HubContext, agreement: Pick<Agreement, 'id' | 'title'>, versionNo: number): string {
  const rows = ctx.store.log('audit').all().filter(row => row.action === 'agreement_submit');
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const detail = readAuditDetail<{ agreementId?: string; no?: number; title?: string }>(rows[index]!.detail);
    if (detail?.agreementId === agreement.id && detail.no === versionNo && typeof detail.title === 'string') return detail.title;
    // 同一版号被后来的提交重写过（上一次没有成功）：以最近一次为准，这一次没有记标题就是沿用。
    if (detail?.agreementId === agreement.id && detail.no === versionNo) return agreement.title;
  }
  return agreement.title;
}

/**
 * 新版本固定（或直接生效）时让主题的标题跟上：返回是否改了主题标题。
 * oldTitle 是固定之前约定记录上的标题；主题此刻的标题不等于它（主人自己改过）时不动。
 */
export function followTopicTitle(ctx: HubContext, agreement: Pick<Agreement, 'id' | 'topicId'>, oldTitle: string, newTitle: string, versionNo: number): boolean {
  if (newTitle === oldTitle) return false;
  const topic = ctx.store.table('projectTopics').get(agreement.topicId);
  if (topic === null || topic.title !== oldTitle) return false;
  ctx.store.table('projectTopics').patch(topic.id, { title: newTitle, updatedAt: ctx.clock.now() });
  postThread(ctx, { thread: topic.id, from: 'hub', kind: 'work', refId: agreement.id, text: topicTitleFollowText(versionNo, newTitle) });
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.thread, topic.id);
  return true;
}
