/**
 * 交账时发约定卡（P72b）。
 *
 * 为什么不在工具调用时就发：工具只写表。卡片等本回合交账后才落楼，
 * 这样总管私聊里的顺序永远是「总管一句结论 → 建主题旁白（只第一次）→ 约定卡」，
 * 合成交账（回合结束却没交账）也走同一条路，所以一定会发。
 * tick 里另有兜底：唤醒单已结束但卡片仍没发出的版本，超过宽限时间后补发。
 *
 * 一份约定出错只记日志、继续下一份，绝不抛出去影响交账路由里后面的提问、提议和单推。
 * 每一步写完都立刻写回表，所以中途失败后下次补发不会重复已经做完的步骤。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { originLineOf } from '../api/agreement-views.js';
import { AGREEMENT_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { AgreementSchema, type Agreement, type AgreementVersion } from '../model/agreement.js';
import { AGREEMENT_CONFIRM_OPTION, createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { joinQuestion } from '../util/question-join.js';
import { isOpenWake } from '../turn/session.js';
import { agreementInboxPrefix, hasOpenInboxItemFor, withdrawAgreementInboxItems } from './agreement-inbox.js';

/** 这个版本是否是「待确认、还没发卡」的版本。 */
function needsCard(version: AgreementVersion): boolean {
  return version.state === 'pending' && version.cardMessageId === null;
}

/** 这个版本是否是「直接生效（amend）、还没落提示」的版本；后来被再次 amend 替换的也要补落。 */
function needsAmendNote(version: AgreementVersion): boolean {
  return version.lockedVia === 'amend' && ['locked', 'replaced'].includes(version.state) && version.cardMessageId === null;
}

/** 把改过的版本写回约定（整份重新校验后再写表）。 */
function saveVersion(ctx: HubContext, agreement: Agreement, no: number, patch: Partial<AgreementVersion>): Agreement {
  const next = AgreementSchema.parse({
    ...agreement, versions: agreement.versions.map(version => version.no === no ? { ...version, ...patch } : version),
  });
  ctx.store.table('agreements').put(next);
  return next;
}

/**
 * 为待确认版本换「待你处理」条目（P72g A5）：先按 subjectKey 前缀撤回这份约定所有还开着的旧条目
 * （不只撤 inboxId 指向的那一条，中途出错留下的孤儿也一并清掉），再新建一条不会到期、只有一个按钮的条目，
 * 并把 inboxId 写回约定。发卡和兜底补建都走这里。
 */
function replaceInboxItem(ctx: HubContext, agreement: Agreement, version: AgreementVersion): Agreement {
  withdrawAgreementInboxItems(ctx, agreement.id, '已出新版本');
  const lines = version.content.pending.map(item => joinQuestion(item.question, item.suggested));
  // P74r2b：起因是执行中提问的版本，正文先写起因一句（与约定卡视图里的一致，由中心生成）。
  const origin = originLineOf(version);
  const item = createInboxItem(ctx, {
    botId: agreement.botId, type: 'question', priority: 'P1',
    title: `约定第 ${version.no} 版待你确认：${agreement.title}`,
    // P74r3（L1）：这份约定有进行中的事时，工作照常在做，只有暂停的部分要等确认；没有进行中的事时才是「不会开工」。
    // P74r14：「不会自动按建议处理……」「你确认前不会开工」「你确认前，暂停的部分不会做」「你确认后这件事停止……」这类说明行
    // 只由界面按条目上的标记（agreementJobSplit、agreementStop）显示，正文里不再带，免得主人看到两遍。
    body: [...(origin === null ? [] : [origin]), ...lines].join('\n'),
    options: [AGREEMENT_CONFIRM_OPTION], defaultOption: null, expiresAt: null,
    refId: agreement.id, subjectKey: `${agreementInboxPrefix(agreement.id)}${version.no}`, topicId: agreement.topicId,
  });
  const current = AgreementSchema.parse({ ...agreement, inboxId: item.id });
  ctx.store.table('agreements').put(current);
  return current;
}

/** 发一张待确认版本的卡：建主题旁白（首次）、约定卡、换「待你处理」条目。 */
function postPendingVersion(ctx: HubContext, agreement: Agreement, version: AgreementVersion): Agreement {
  const { botId, originThread, title } = agreement;
  // 这份约定在私聊里的第一张卡之前补一句建主题旁白；之后的新版不再重复（第 1 版没发出去时由第一张发出的卡补）。
  const firstCard = agreement.versions.every(row => row.no === version.no || row.cardMessageId === null);
  if (firstCard) {
    postThread(ctx, { thread: originThread, from: 'hub', kind: 'system', text: `总管为这件事建立了主题「${title}」，后续进展都记在那里。`, refId: agreement.topicId });
  }
  const card = postThread(ctx, { thread: originThread, from: botId, kind: 'agreement', text: `约定「${title}」第 ${version.no} 版`, refId: agreement.id });
  // 卡片 id 先写回，后面处理收件箱出错也不会重复发卡。
  const current = saveVersion(ctx, agreement, version.no, { cardMessageId: card.id });
  // 「待你处理」：旧条目撤回，新建待确认条目。
  return replaceInboxItem(ctx, current, version);
}

/** 落「已按你的指示记入」的中心旁白（直接生效的版本不出卡）。 */
function postAmendNote(ctx: HubContext, agreement: Agreement, version: AgreementVersion): Agreement {
  const text = `已按你的指示记入约定「${agreement.title}」第 ${version.no} 版。`;
  const where = version.sourceThread ?? agreement.originThread;
  const note = postThread(ctx, { thread: where, from: 'hub', kind: 'system', text, refId: agreement.id });
  const current = saveVersion(ctx, agreement, version.no, { cardMessageId: note.id });
  // 主人是在别处（例如私聊）说的，约定主题里也留一句，主题里的人才知道约定变了。
  if (where !== agreement.topicId) postThread(ctx, { thread: agreement.topicId, from: 'hub', kind: 'system', text, refId: agreement.id });
  return current;
}

/** 落撤下旁白，并把还开着的待确认条目撤回。 */
function postWithdrawn(ctx: HubContext, agreement: Agreement): Agreement {
  const note = postThread(ctx, { thread: agreement.originThread, from: 'hub', kind: 'system', text: `约定「${agreement.title}」已撤下，不会开工。`, refId: agreement.id });
  const next = AgreementSchema.parse({ ...agreement, withdrawn: { ...agreement.withdrawn!, noticeMessageId: note.id } });
  ctx.store.table('agreements').put(next);
  withdrawAgreementInboxItems(ctx, next.id, '约定已撤下');
  return next;
}

/** 处理一份约定里属于某张唤醒单的所有待发项；每处理完一项都已写回表。 */
function postOne(ctx: HubContext, agreementId: string, wakeId: string): void {
  let agreement: Agreement | null = ctx.store.table('agreements').get(agreementId);
  if (!agreement) return;
  const nos: number[] = agreement.versions.filter(row => row.wakeId === wakeId && (needsCard(row) || needsAmendNote(row))).map(row => row.no);
  for (const no of nos) {
    const version: AgreementVersion = agreement.versions.find(row => row.no === no)!;
    agreement = needsCard(version) ? postPendingVersion(ctx, agreement, version) : postAmendNote(ctx, agreement, version);
  }
  if (agreement.withdrawn !== null && agreement.withdrawn.wakeId === wakeId && agreement.withdrawn.noticeMessageId === null) {
    agreement = postWithdrawn(ctx, agreement);
  }
  ctx.emit(HUB_EVENT_SCOPES.thread, agreement.originThread);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 某张唤醒单名下有没有还没发出的东西（版本卡片、amend 旁白、撤下通知）。 */
function hasUnposted(agreement: Agreement, wakeId: string): boolean {
  return agreement.versions.some(row => row.wakeId === wakeId && (needsCard(row) || needsAmendNote(row)))
    || (agreement.withdrawn?.wakeId === wakeId && agreement.withdrawn.noticeMessageId === null);
}

/**
 * 交账时把这张唤醒单提交的约定发出去：待确认版本发卡，直接生效的版本落旁白，撤下落通知。
 * 一份出错只记日志并继续下一份，不抛出。
 */
export function postAgreementCards(ctx: HubContext, wakeId: string): void {
  for (const agreement of ctx.store.table('agreements').list(row => hasUnposted(row, wakeId))) {
    try {
      postOne(ctx, agreement.id, wakeId);
    }
    catch (error) {
      ctx.logger.error(`约定 ${agreement.id} 发卡失败`, error);
    }
  }
}

/**
 * 兜底补发：版本（或撤下通知）还没发出，且它的唤醒单不存在，或已结束并超过宽限时间，就补发。
 * 在 tick 里经 hooks.safe 调用。
 */
export function sweepUnpostedAgreements(ctx: HubContext, now: number): void {
  const due = new Set<string>();
  for (const agreement of ctx.store.table('agreements').list()) {
    const items: Array<{ wakeId: string | null; at: number }> = [
      ...agreement.versions.filter(row => needsCard(row) || needsAmendNote(row)).map(row => ({ wakeId: row.wakeId, at: row.createdAt })),
      ...(agreement.withdrawn !== null && agreement.withdrawn.noticeMessageId === null
        ? [{ wakeId: agreement.withdrawn.wakeId, at: agreement.withdrawn.at }] : []),
    ];
    for (const item of items) {
      if (item.wakeId === null) continue;
      const wake = ctx.store.table('wakes').get(item.wakeId);
      if (wake === null || (!isOpenWake(wake) && now - item.at > D.UNPUBLISHED_GRACE_MS)) due.add(item.wakeId);
    }
  }
  for (const wakeId of due) postAgreementCards(ctx, wakeId);
  sweepMissingInboxItems(ctx);
}

/**
 * 兜底补建「待你处理」条目（P72g A5）：待确认约定的最新版已经发卡，却没有对应的、开着的条目
 * （发卡中途出错、条目被误撤等），就补建一条。主人在私聊里看到了卡，「待你处理」里也必须有。
 * 一份出错只记日志，继续下一份。
 */
export function sweepMissingInboxItems(ctx: HubContext): void {
  for (const agreement of ctx.store.table('agreements').list(row => row.state === 'pending')) {
    const latest = agreement.versions[agreement.versions.length - 1]!;
    if (latest.state !== 'pending' || latest.cardMessageId === null) continue;
    if (hasOpenInboxItemFor(ctx, agreement.id, latest.no)) continue;
    try {
      replaceInboxItem(ctx, agreement, latest);
    }
    catch (error) {
      ctx.logger.error(`约定 ${agreement.id} 补建待你处理条目失败`, error);
    }
  }
}
