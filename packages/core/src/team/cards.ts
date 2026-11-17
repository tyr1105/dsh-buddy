/**
 * 组队卡的发卡、「待你处理」条目维护和兜底补发（P73c）。照约定卡（project/agreement-cards.ts）的做法。
 *
 * 为什么「待你处理」里一张卡只有一条：主人需要确认的事在任何时刻只有一个对象（约定卡或组队卡）。
 * 条目只有一个按钮、没有默认答案、永不到期，所以不会出现「到期自动按建议入职」。
 * 卡内每次修改，条目的正文和按钮文字就地更新（patch），不新建；出新条目前先撤回这张卡所有还开着的旧条目
 * （中途出错留下的孤儿也一并清掉）。
 *
 * 本文件不调用模型、不排任何唤醒。每一步写完都立刻写回表，所以中途失败后补发不会重复已经做完的步骤。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { TeamProposalSchema, teamConfirmLabel, type TeamProposal } from '../model/team-proposal.js';
import { createInboxItem, emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { isOpenWake } from '../turn/session.js';
import { pendingOwnerConfirmOf } from './owner-confirm.js';

/** 一张组队卡的「待你处理」条目 subjectKey（整个字符串就是它，一张卡只有一个）。 */
export function teamInboxKey(proposalId: string): string {
  return `team:${proposalId}`;
}

/** 条目是不是组队卡确认条目（提问类型、subjectKey 以 team: 开头）。 */
export function isTeamInboxItem(item: { type: string; subjectKey: string }): boolean {
  return item.type === 'question' && item.subjectKey.startsWith('team:');
}

/** 从条目的 subjectKey 取组队卡 id；格式不对返回 null。 */
export function parseTeamSubjectKey(subjectKey: string): string | null {
  const match = /^team:(tpr_[a-z0-9]{10})$/.exec(subjectKey);
  return match ? match[1]! : null;
}

/** 合并字段后整条重新校验再写表。 */
export function saveProposal(ctx: HubContext, proposal: TeamProposal, patch: Partial<TeamProposal>): TeamProposal {
  const next = TeamProposalSchema.parse({ ...proposal, ...patch, updatedAt: ctx.clock.now() });
  ctx.store.table('teamProposals').put(next);
  return next;
}

/** 条目的标题和正文：只由组队卡当前内容生成，不含工具名和内部编号。 */
function inboxTexts(ctx: HubContext, proposal: TeamProposal): { title: string; body: string } {
  const kept = proposal.candidates.filter(candidate => !candidate.removed).map(candidate => candidate.name);
  if (proposal.kind === 'addition') {
    const agreement = proposal.agreementId === null ? null : ctx.store.table('agreements').get(proposal.agreementId);
    return { title: `确认新员工：${agreement?.title ?? '这件事'}`, body: `${kept.join('、')}，确认后入职并接手这件事。` };
  }
  return { title: '确认初始团队', body: kept.length === 0 ? '你已把推荐的员工全部去掉，确认后不新增员工。' : `${kept.join('、')}，确认后入职。` };
}

/** 撤回这张卡所有还开着的条目（按 subjectKey 圈住，不只撤 inboxId 指向的那一条）。返回撤回了几条。 */
export function withdrawTeamInboxItems(ctx: HubContext, proposalId: string, answer: string): number {
  const open = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === teamInboxKey(proposalId));
  for (const item of open) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer, answeredAt: ctx.clock.now() });
    emitInboxChange(ctx, item);
  }
  return open.length;
}

/** 把这张卡还开着的条目标为已回答（answer 为按钮文字）。 */
export function answerTeamInboxItems(ctx: HubContext, proposalId: string, answer: string): void {
  const now = ctx.clock.now();
  for (const item of ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === teamInboxKey(proposalId))) {
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer, answeredAt: now });
    emitInboxChange(ctx, item);
  }
}

/** 先撤回旧条目，再新建一条（只有一个按钮、没有默认答案、永不到期），并把 inboxId 写回组队卡。 */
export function replaceTeamInboxItem(ctx: HubContext, proposal: TeamProposal): TeamProposal {
  withdrawTeamInboxItems(ctx, proposal.id, '已重新生成');
  const texts = inboxTexts(ctx, proposal);
  const item = createInboxItem(ctx, {
    botId: proposal.chiefId, type: 'question', priority: 'P2', title: texts.title, body: texts.body,
    options: [teamConfirmLabel(proposal)], defaultOption: null, expiresAt: null,
    refId: proposal.id, subjectKey: teamInboxKey(proposal.id),
  });
  return saveProposal(ctx, proposal, { inboxId: item.id });
}

/**
 * 卡内修改后同步条目：开着的那一条就地更新正文和按钮文字（不新建）；没有开着的才补建。
 * 返回最新的组队卡。
 */
export function syncTeamInboxItem(ctx: HubContext, proposal: TeamProposal): TeamProposal {
  const open = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === teamInboxKey(proposal.id));
  if (open.length !== 1) return replaceTeamInboxItem(ctx, proposal);
  const item = open[0]!;
  const texts = inboxTexts(ctx, proposal);
  ctx.store.table('inbox').patch(item.id, { title: texts.title, body: texts.body, options: [teamConfirmLabel(proposal)] });
  emitInboxChange(ctx, item);
  return proposal.inboxId === item.id ? proposal : saveProposal(ctx, proposal, { inboxId: item.id });
}

/** 发卡：落卡片消息（正文只说这里有一张卡，内容每次按表投影），记 cardMessageId，再建「待你处理」条目。 */
export function postTeamCard(ctx: HubContext, proposal: TeamProposal): TeamProposal {
  const text = proposal.kind === 'initial' ? '组队卡：初始团队，待你确认' : '组队卡：新员工，待你确认';
  let current = proposal;
  if (proposal.cardMessageId === null) {
    const card = postThread(ctx, { thread: proposal.chiefId, from: proposal.chiefId, kind: 'team', text, refId: proposal.id });
    // 卡片 id 先写回，后面处理条目出错也不会重复发卡。
    current = saveProposal(ctx, proposal, { cardMessageId: card.id });
  }
  return replaceTeamInboxItem(ctx, current);
}

/**
 * 交账时把这张唤醒单提交的组队卡发出去（P73d）：按需加人的卡在工具调用时只写表，
 * 等本回合交账、reply 落楼之后再发，线程顺序是「总管一句话 → 组队卡」，与约定卡一致。
 * 一张出错只记日志并继续，不抛出（不能挡住交账路由里后面的提问、提议和单推）。
 */
export function postTeamCardsOfWake(ctx: HubContext, wakeId: string): void {
  for (const proposal of ctx.store.table('teamProposals').list(row => row.state === 'pending' && row.wakeId === wakeId && row.cardMessageId === null)) {
    try {
      postTeamCard(ctx, proposal);
      ctx.emit(HUB_EVENT_SCOPES.thread, proposal.chiefId);
    } catch (error) {
      ctx.logger.error(`组队卡 ${proposal.id} 发卡失败`, error);
    }
  }
}

/**
 * 兜底补发（tick 里调用）：待确认的组队卡没有落楼，或没有对应的、开着的条目，就补上。
 * 按需加人的卡（带唤醒单）在那张唤醒单还开着时不补：它要等本回合交账、reply 落楼之后才发。
 * 一张出错只记日志，继续下一张。
 */
export function sweepTeamCards(ctx: HubContext): void {
  for (const proposal of ctx.store.table('teamProposals').list(row => row.state === 'pending')) {
    try {
      // P73r3 S3：总管名下有待确认的约定卡时，不补发组队卡（两种卡不同时开着；两者并存时以约定卡为准，见 pendingOwnerConfirmOf）。
      if (pendingOwnerConfirmOf(ctx, proposal.chiefId)?.kind === 'agreement') continue;
      if (proposal.wakeId !== null) {
        const wake = ctx.store.table('wakes').get(proposal.wakeId);
        if (wake !== null && isOpenWake(wake)) continue;
      }
      if (proposal.cardMessageId === null) {
        postTeamCard(ctx, proposal);
      } else {
        const hasOpen = ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey === teamInboxKey(proposal.id)) === 1;
        if (!hasOpen || proposal.inboxId === null) replaceTeamInboxItem(ctx, proposal);
      }
      ctx.emit(HUB_EVENT_SCOPES.thread, proposal.chiefId);
    } catch (error) {
      ctx.logger.error(`组队卡 ${proposal.id} 补发失败`, error);
    }
  }
}
