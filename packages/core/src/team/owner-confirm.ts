/**
 * 「需要主人确认的事只有一个」的集中判断（P73d，方案 5.1、5.6）。
 *
 * 为什么集中在一个函数里：约定卡和组队卡都是「等主人点确认」的卡。同一时刻让主人面对两张卡，
 * 他不知道先确认哪一张，也容易确认了一张就让另一张的前提失效。所以总管名下任何时候最多只有一个待确认对象。
 * 所有需要判断「现在有没有待主人确认的东西」的地方（交账里对提问的限制、提交约定、推荐新员工）都调用这里，
 * 第三块把派活闸门改成按事情区分时，只需要改这一个文件。
 *
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { TeamProposal } from '../model/team-proposal.js';
import { pendingAgreementsOf } from '../project/agreements.js';
import { pendingTeamProposalOf } from './proposals.js';

/** 总管名下正在等主人确认的对象：一份约定，或一张组队卡。 */
export type OwnerConfirm =
  | { kind: 'agreement'; agreement: Agreement }
  | { kind: 'team'; proposal: TeamProposal };

/**
 * 总管名下现在有什么在等主人确认；没有返回 null。
 * 先查约定（含「已固定后重新确认」的那一份，它的状态也是待确认），再查组队卡。
 * 两者按设计不会同时存在；真的同时存在时先报约定，因为约定卡出现得更早、牵涉的范围更大。
 */
export function pendingOwnerConfirmOf(ctx: HubContext, chiefId: string): OwnerConfirm | null {
  // P74e：任何一张待确认的约定都算（含执行中的事因 B2 重新确认的那些）；有多张时报最近改动的那张。
  const agreement = pendingAgreementsOf(ctx, chiefId)[0] ?? null;
  if (agreement !== null) return { kind: 'agreement', agreement };
  const proposal = pendingTeamProposalOf(ctx, chiefId);
  if (proposal !== null) return { kind: 'team', proposal };
  return null;
}

/**
 * P74r1（R1）：总管名下有没有「还没有固定过的新约定」或组队卡在等主人确认；没有返回 null。
 *
 * 为什么另写一个函数：上面的 pendingOwnerConfirmOf 把「已固定后重新确认」的约定也算在内。
 * 但执行中的事因为改约定而重新确认时，那件事的参与者本来就只能用这件事自己的工具往来，
 * 不该因此挡住总管给别的员工发小事消息；所以拦「自由文字叫人」（hub_send、主题里的 @）时，
 * 只看这两种：从未固定过的新约定，和任何一张待确认的组队卡。
 * 约定先于组队卡报（约定卡出现得更早、牵涉的范围更大）；同时有多份新约定时报最近改动的那份。
 * 只读存储，不依赖 project/agreements.ts（避免循环引用）。
 */
export function pendingNewConfirmOf(ctx: HubContext, chiefId: string): OwnerConfirm | null {
  const fresh = ctx.store.table('agreements')
    .list(row => row.botId === chiefId && row.state === 'pending' && !row.versions.some(version => version.lockedAt !== null))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (fresh !== undefined) return { kind: 'agreement', agreement: fresh };
  const proposal = pendingTeamProposalOf(ctx, chiefId);
  return proposal === null ? null : { kind: 'team', proposal };
}

/** 约定卡在等主人时，总管带 ownerQuestion 交账的报错（原文，P72j J1）。 */
export const AGREEMENT_PENDING_QUESTION_ERROR = '约定卡已经在等主人确认，不能再用 ownerQuestion 提问，它会生成第二张提问卡。需要主人定的事放进约定的待定项；outcome 可以写 needs_owner，不填 ownerQuestion';

/** 组队卡在等主人时，总管带 ownerQuestion 交账的报错。 */
export const TEAM_PENDING_QUESTION_ERROR = '组队卡已经在等主人确认，不能再用 ownerQuestion 提问，它会生成第二张提问卡。outcome 可以写 needs_owner，不填 ownerQuestion';

/** 有组队卡在等主人时，提交新约定、重新确认约定的报错。 */
export const TEAM_PENDING_AGREEMENT_ERROR = '已有一张组队卡在等主人确认，先请主人确认或回复「不新增」，再提交新的约定或重新确认';

/** 有组队卡在等主人时，再推荐新员工的报错。 */
export const TEAM_PENDING_PROPOSE_ERROR = '已有一张组队卡在等主人确认，先请主人确认或回复「不新增」';

/** 总管带 ownerQuestion 交账被拒时的报错文字，按在等的种类给出。 */
export function questionBlockedText(pending: OwnerConfirm): string {
  return pending.kind === 'agreement' ? AGREEMENT_PENDING_QUESTION_ERROR : TEAM_PENDING_QUESTION_ERROR;
}
