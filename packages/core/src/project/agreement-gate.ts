/**
 * 派活闸门（P72b 创建，P74b 改为按事情区分）：一份约定还在等主人确认时，这件事不能派活。
 *
 * 为什么要代码拦、不只靠守则：「约定没定之前没有员工开工」是 P72 的验收要求，
 * 模型一次误判就会绕过主人刚定的这道闸。
 *
 * P74b 之前的做法是「总管名下有任何待确认就全拦」，会让一份约定在等确认时，另一件早已固定的事也无法安排。
 * 现在按事情区分：只看这一件事自己的约定、以及为这件事加人的组队卡，别的约定、别的组队卡不影响它。
 * 总管让员工动手的路只剩两条受这里管：hub_job_manage 的 assign、reassign，以及主题里总管 reply 的 @（只看该主题挂的约定）。
 * hub_send 和事务指派的限制不在这里（见 job/guards.ts 与 project/owner-tasks.ts）。
 *
 * 范围：只管总管；非总管员工、主人自己的 @ 和界面派活都不经过这里。
 * 本文件只做查询，不写存储。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { activeJobOfStaff } from '../job/guards.js';
import { pendingNewConfirmOf } from '../team/owner-confirm.js';

/**
 * P74r1（R1）：总管名下有没有还在等主人确认的新约定或组队卡；有就返回给模型和主人看的一句话，没有返回 null。
 *
 * 为什么 hub_send 和主题里的 @ 要单独拦：它们是自由文字，中心分不清正文说的是哪件事，
 * 所以不能像 assign 那样「只看这一件事的约定」，而是取保守规则：总管名下只要有新约定或组队卡在等主人，
 * 就不能用这两种办法叫任何员工动手（「约定没定之前没有员工开工」）。
 * 判断看总管名下的全部待确认对象，不只看当前主题；已固定后重新确认的约定不算（见 pendingNewConfirmOf）。
 */
export function chiefPendingNewBlock(ctx: HubContext, chiefId: string): string | null {
  const pending = pendingNewConfirmOf(ctx, chiefId);
  if (pending === null) return null;
  return pending.kind === 'agreement'
    ? `约定「${pending.agreement.title}」还在等主人确认，确认前不能叫员工动手。`
    : '组队卡还在等主人确认，确认前不能叫员工动手。';
}

/** 总管在主题里 @ 员工时的处理结果：能叫醒的人，加上要落在主题里的旁白。 */
export interface MentionVerdict { reachable: Bot[]; notes: string[] }

/**
 * P74r1（R1）：总管在主题里 reply 的 @ 能叫醒谁。三层依次判断：
 * 1. 总管名下有等主人确认的新约定或组队卡：谁都不叫（旁白沿用「约定还没确认」「组队卡还没确认」）；
 * 2. 这个主题挂的约定还在等主人确认（含固定后重新确认），或为它加人的组队卡在等：谁都不叫；
 * 3. 被点名的员工正在做某件事（执行者、核对人）：不叫他，旁白提示这件事的往来走这件事自己的流程；
 *    对手上没有在办的事的员工，@ 照常可用。
 * 员工在主题里 @ 员工的公开讨论不经过这里（保留现状，不算派活）。
 * topicAgreementBlock 由调用方传入（取主题挂的约定的闸门文字，没有约定为 null），避免本文件依赖约定模块。
 */
export function chiefMentionVerdict(ctx: HubContext, chiefId: string, topicAgreementBlock: string | null, reachable: Bot[]): MentionVerdict {
  const names = (bots: readonly Bot[]): string => bots.map(bot => bot.name).join('、');
  const global = chiefPendingNewBlock(ctx, chiefId);
  if (global !== null) {
    return { reachable: [], notes: [`${global.startsWith('组队卡') ? '组队卡' : '约定'}还没确认，这次没有叫 ${names(reachable)}。`] };
  }
  if (topicAgreementBlock !== null) {
    return { reachable: [], notes: [`${topicAgreementBlock === TEAM_CARD_BLOCK_TEXT ? '组队卡' : '约定'}还没确认，这次没有叫 ${names(reachable)}。`] };
  }
  const busy = reachable.filter(bot => bot.role !== 'chief' && activeJobOfStaff(ctx, bot.id) !== null);
  if (busy.length === 0) return { reachable, notes: [] };
  const notes = busy.map(bot => {
    const title = ctx.store.table('agreements').get(activeJobOfStaff(ctx, bot.id)!.agreementId)?.title ?? '这件事';
    return `${bot.name}正在做「${title}」，这次没有直接叫他；这件事的往来请走这件事自己的流程。`;
  });
  return { reachable: reachable.filter(bot => !busy.includes(bot)), notes };
}

/** 有一张为这份约定加人的组队卡在等主人时的拦截文字（主题旁白据此识别「组队卡」）。 */
export const TEAM_CARD_BLOCK_TEXT = '组队卡还在等主人确认，确认前不能把这件事交给别人。';

/**
 * 这份约定能不能派活：
 * - 约定本身待确认（第一次待确认，或固定后重新确认）：拦；
 * - 有一张待确认的组队卡，且它是为这份约定加人的：拦；
 * - 其余放行。别的约定待确认、别的组队卡待确认，都不影响这一件。
 * 报错文字原样给模型和主题旁白用；放行返回 null。
 */
export function dispatchBlockFor(ctx: HubContext, chiefId: string, agreementId: string): string | null {
  const agreement = ctx.store.table('agreements').get(agreementId);
  if (agreement !== null && agreement.state === 'pending') return `约定「${agreement.title}」还在等主人确认，确认前不能派活。`;
  const pendingCard = ctx.store.table('teamProposals').list(row => row.chiefId === chiefId && row.state === 'pending' && row.agreementId === agreementId)[0];
  if (pendingCard !== undefined) return TEAM_CARD_BLOCK_TEXT;
  return null;
}
