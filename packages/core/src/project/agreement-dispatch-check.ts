/**
 * 「同一回合先派活、后重新确认约定」的检查（P72g A3 创建，P74b 收窄）。
 *
 * 为什么要这个检查：派活只能针对已固定的约定，所以新建约定不可能有「先派活」，P74b 起不再检查新建。
 * 剩下的情形是：总管这一回合刚对一份约定调用了 assign 或 reassign，接着又对同一份约定 revise（含固定后重新确认），
 * 执行者已经按旧版本开工了，新版本却要等主人重新确认。这种顺序要拒绝，让总管把「先让员工停下的部分」
 * 写进新版本的暂停里，或下一回合再提交。
 *
 * 取舍：不去「撤回」已经发出的派活（撤回要动执行者的唤醒、成员、文件，代价大还可能撤到一半），
 * 而是「拒绝这次提交，并在总管私聊落一条中心旁白让主人看到」。
 * 旧版本统计的三条来源（邮件、交接、事务指派）已随旧入口收拢而删除。
 *
 * 本文件只读存储，唯一的写入是被拒时落的那条旁白。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { postThread } from '../outreach/thread.js';

/** 这位总管在这次唤醒开始之后，对这份约定调用过 assign 或 reassign 的次数。 */
export function dispatchesSinceWake(ctx: HubContext, botId: string, wake: WakeTicket, agreementId: string): number {
  return ctx.store.log('jobEvents').all().filter(event => event.actor === botId && event.at >= wake.startedAt
    && (event.kind === 'assigned' || event.kind === 'reassigned')
    && ctx.store.table('jobs').get(event.jobId)?.agreementId === agreementId).length;
}

/** 把文字压成一行并截短，旁白里只放个大意。 */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length > 30 ? `${[...flat].slice(0, 30).join('')}…` : flat;
}

/**
 * P74r1（R1.3）：这位总管在这次唤醒开始之后，已经用 hub_send 叫过哪些员工（给谁、说了什么大意）。
 * 为什么只数 hub_send：派活（assign）只能针对已固定的约定；主题里的 @ 是总管交账时的回复文字带出来的，
 * 发生在提交约定之后，那时总管名下已有待确认的新约定，会被 chiefMentionVerdict 拦住，所以不在这里统计。
 */
export function messagesSinceWake(ctx: HubContext, botId: string, wake: WakeTicket): Array<{ to: string; what: string }> {
  const nameOf = (id: string) => ctx.store.table('bots').get(id)?.name ?? '已删除的员工';
  return ctx.store.table('mail').list(row => row.from === botId && row.createdAt >= wake.startedAt)
    .map(mail => ({ to: nameOf(mail.to), what: `发了消息「${brief(mail.text)}」` }));
}

/**
 * 提交一份新约定前调用（P72g A3 恢复，P74r1）：本回合已经用 hub_send 叫过员工，就拒绝这次提交，
 * 并在总管私聊落一条中心旁白让主人看到。取舍同上：不去撤回已经发出的消息，而是不记下约定、告诉主人。
 */
export function assertNoMessageBeforeNewAgreement(ctx: HubContext, botId: string, wake: WakeTicket, title: string): void {
  const done = messagesSinceWake(ctx, botId, wake);
  if (done.length === 0) return;
  const list = done.map(item => `给 ${item.to}${item.what}`).join('；');
  postThread(ctx, {
    thread: botId, from: 'hub', kind: 'system', refId: null,
    text: `总管在提交约定「${title}」之前，已经叫员工动手了（${list}）。这些没有撤回，约定这次也没有记下，请你留意。`,
  });
  throw new Error(`约定「${title}」没有记下：这一回合你已经叫员工动手了（${list}）。约定确认前不能开工，先提交约定再派活；已经发出的无法撤回，中心已在私聊里告诉主人。`);
}

/**
 * 修订约定（revise，含固定后重新确认）前调用：本回合已经对同一份约定派过活就拒绝，并在总管私聊落一条中心旁白。
 * 对别的约定派过活不受影响。
 */
export function assertNoDispatchBeforeAgreement(ctx: HubContext, botId: string, wake: WakeTicket, agreement: { id: string; title: string }): void {
  if (dispatchesSinceWake(ctx, botId, wake, agreement.id) === 0) return;
  // 旁白给主人看：说清楚发生了什么、新版本没记下。
  postThread(ctx, {
    thread: botId, from: 'hub', kind: 'system', refId: null,
    text: `总管在这一回合已经把约定「${agreement.title}」交给员工了，新的版本这次没有记下，请你留意。`,
  });
  throw new Error(`约定「${agreement.title}」没有记下：这一回合你已经把它交给员工了。先让员工停下的部分写进新版本的暂停里，或下一回合再提交。`);
}
