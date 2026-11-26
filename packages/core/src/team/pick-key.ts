/**
 * 挑人回合的事项键和「是否在等挑人」（W11）。单独一个文件、只引类型：工具闸门（tools/common.ts）也要认它，
 * 放在 pick.ts 里会把组队服务整串拉进工具层。
 */
import type { HubContext } from '../engine/context.js';
import type { TeamSetup } from '../model/team-proposal.js';
import type { WakeTicket } from '../model/wake.js';

/** 挑人回合的事项键前缀：工具闸门和兜底检查靠它认出这一回合。 */
export const PICK_SUBJECT_PREFIX = 'team-pick:';

export function pickSubjectKey(setupId: string): string {
  return `${PICK_SUBJECT_PREFIX}${setupId}`;
}

/** 这张唤醒单是不是挑人回合。 */
export function isPickTurn(wake: Pick<WakeTicket, 'subjectKey'> | null | undefined): boolean {
  return wake?.subjectKey?.startsWith(PICK_SUBJECT_PREFIX) === true;
}

/** 三问正在等总管挑人：asking、三问答完、请过总管、还没有组队卡。 */
export function isAwaitingPick(setup: TeamSetup): boolean {
  return setup.state === 'asking' && setup.proposalId === null && setup.answers.notify !== null
    && (setup.pickRequestedAt ?? null) !== null;
}

/** 总管名下正在等挑人的三问；没有返回 null。 */
export function awaitingPickOf(ctx: HubContext, chiefId: string): TeamSetup | null {
  return ctx.store.table('teamSetups').list(row => row.chiefId === chiefId && isAwaitingPick(row))[0] ?? null;
}

