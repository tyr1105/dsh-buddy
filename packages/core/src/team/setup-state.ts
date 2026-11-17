/**
 * 三问记录的读写小工具（P73c）：setup.ts、proposals.ts、cards.ts 共用，避免文件之间循环引用。
 *
 * 三问记录全局最多一条；总管的「状态行」文字由中心直接设置（不调用模型）：
 * 提问中显示「正在为你组建团队，需要你回答 3 个问题。」，组队卡等确认时显示「等你确认新员工」，
 * 结束后恢复为「继续关注变化」。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { TeamSetupSchema, type TeamSetup } from '../model/team-proposal.js';

export const CHIEF_ASKING_TEXT = '正在为你组建团队，需要你回答 3 个问题。';
export const CHIEF_WAITING_TEXT = '等你确认新员工';
export const CHIEF_IDLE_TEXT = '继续关注变化';

/** 当前唯一的三问记录；没有返回 null。 */
export function currentSetup(ctx: HubContext): TeamSetup | null {
  return ctx.store.table('teamSetups').list()[0] ?? null;
}

/** 改总管的状态行文字；总管不存在或文字没变时什么都不做。 */
export function setChiefActivityText(ctx: HubContext, chiefId: string, activityText: string): void {
  const chief = ctx.store.table('bots').get(chiefId);
  if (!chief || chief.activityText === activityText) return;
  ctx.store.table('bots').patch(chiefId, { activityText, updatedAt: ctx.clock.now() });
  ctx.emit(HUB_EVENT_SCOPES.bot, chiefId);
}

/**
 * 组队卡处理完（确认、拒绝、撤下）后，若总管的状态行还写着「等你确认新员工」且已没有别的待确认组队卡，就恢复为「继续关注变化」。
 * 状态行是别的文字（例如正在跑回合）时不动，避免覆盖更准确的状态。
 */
export function clearChiefWaitingText(ctx: HubContext, chiefId: string): void {
  const chief = ctx.store.table('bots').get(chiefId);
  if (!chief || chief.activityText !== CHIEF_WAITING_TEXT) return;
  if (ctx.store.table('teamProposals').count(row => row.state === 'pending' && row.chiefId === chiefId) > 0) return;
  setChiefActivityText(ctx, chiefId, CHIEF_IDLE_TEXT);
}

/** 合并字段后整条重新校验再写表；状态只前进由调用方保证。 */
export function saveSetup(ctx: HubContext, setup: TeamSetup, patch: Partial<TeamSetup>): TeamSetup {
  const next = TeamSetupSchema.parse({ ...setup, ...patch, updatedAt: ctx.clock.now() });
  ctx.store.table('teamSetups').put(next);
  return next;
}

/** 初始组队卡被确认或拒绝后：三问转 done，总管状态行恢复。 */
export function finishSetupFor(ctx: HubContext, proposalId: string): void {
  const setup = ctx.store.table('teamSetups').list(row => row.proposalId === proposalId)[0];
  if (!setup) return;
  saveSetup(ctx, setup, { state: 'done' });
  setChiefActivityText(ctx, setup.chiefId, CHIEF_IDLE_TEXT);
}
