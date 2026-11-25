/**
 * 请总管挑人与超时兜底（W11）。从 pick.ts 分出来：这里要排队（引用调度、感知），
 * 而 pick.ts 被工具 hub_team_propose 引用，放在一起会让工具层引回调度，形成循环引用。
 * 只由 team/setup.ts 引用。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { buildCandidate } from '../appraisal/think.js';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { TeamSetup } from '../model/team-proposal.js';
import { postThread } from '../outreach/thread.js';
import { recordOwnerMessage } from '../perception/sources.js';
import { enqueue } from '../scheduler/queue.js';
import { isOpenWake } from '../turn/session.js';
import { isAwaitingPick, pickSubjectKey } from './pick-key.js';
import { saveSetup, setChiefActivityText } from './setup-state.js';

/** 唤醒原因摘要（给总管看）。 */
const PICK_SUMMARY = '主人答完了组队三问。这一回合只做一件事：按主人的项目挑人并调好配置，调用 hub_team_propose，mode 写 initial。';
/** 唤醒原因摘要（给主人看）。 */
const PICK_OWNER_SUMMARY = '按你的项目挑人';
/** 请总管挑人时总管落的一句话（固定）。 */
export const PICK_WAIT_TEXT = '我先看看你的项目，再挑合适的人，挑好就发给你。';
/** 总管状态行：正在挑人。 */
export const CHIEF_PICKING_TEXT = '正在根据项目挑人';

/**
 * 答完第三问时调用：记下请求时间，总管落一句话、状态行改为挑人中，然后给总管排一个主人发起的回合。
 * 排不上（被闸门拦下）时不报错，由 sweepTeamSetup 在下一个 tick 走兜底。
 */
export function requestChiefPick(ctx: HubContext, setup: TeamSetup): TeamSetup {
  const now = ctx.clock.now();
  const saved = saveSetup(ctx, setup, { pickRequestedAt: now });
  postThread(ctx, { thread: saved.chiefId, from: saved.chiefId, kind: 'chat', text: PICK_WAIT_TEXT });
  setChiefActivityText(ctx, saved.chiefId, CHIEF_PICKING_TEXT);
  // 证据：主人答第三问的那条消息（点选时是中心代落的那条，打字时是主人自己的话）。
  const answer = ctx.store.log('thread').recent(1, row => row.thread === saved.chiefId && row.from === 'owner')[0];
  const percept = answer === undefined ? null
    : recordOwnerMessage(ctx, { botId: saved.chiefId, id: answer.id, summary: answer.text, at: answer.createdAt });
  try {
    enqueue(ctx, buildCandidate(ctx, {
      botId: saved.chiefId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
      summary: PICK_SUMMARY, ownerSummary: PICK_OWNER_SUMMARY, evidence: percept === null ? [] : [percept.id],
      subjectKey: pickSubjectKey(saved.id), ownerInitiated: true,
      ...(answer !== undefined ? { messageId: answer.id } : {}),
    }));
  } catch (error) {
    // 排队出错不挡主人：兜底检查会按规则表出默认推荐。
    ctx.logger.error(`三问 ${saved.id} 请总管挑人时排队失败`, error);
  }
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  ctx.emit(HUB_EVENT_SCOPES.bot, saved.chiefId);
  return saved;
}

/**
 * 兜底检查（tick 里调用）：这个三问该不该改走默认推荐。返回走默认的原因，不该走时返回 null。
 * - 挑人回合还在排队或正在进行，且没超时：不走；
 * - 超时：走，并把还在排队的挑人候选撤掉（不再为它花额度）；
 * - 没有排队、也没有进行中的挑人回合（没排上，或回合结束了却没出卡）：走。
 */
export function pickFallbackReason(ctx: HubContext, setup: TeamSetup): 'timeout' | 'no_card' | null {
  if (!isAwaitingPick(setup)) return null;
  const key = pickSubjectKey(setup.id);
  const queued = ctx.store.table('queue').list(row => row.subjectKey === key);
  // 主人在等的时候又跟总管说了话，那条候选可能和挑人候选合并、事项键换成主人消息的；
  // 唤醒包里照样有「等你挑人」，所以总管名下任何在排队或在进行的回合都算还有机会出卡。
  const chiefBusy = ctx.store.table('queue').count(row => row.botId === setup.chiefId) > 0
    || ctx.store.table('wakes').count(row => row.botId === setup.chiefId && isOpenWake(row) && row.startedAt >= setup.pickRequestedAt!) > 0;
  if (ctx.clock.now() - setup.pickRequestedAt! >= D.PICK_TIMEOUT_MS) {
    for (const row of queued) ctx.store.table('queue').remove(row.id);
    return 'timeout';
  }
  if (chiefBusy) return null;
  return 'no_card';
}

