/** 排队优先级只由理由与主动性来源决定；同分时由队列按入队时间保序。 */
import { resolveSettings } from '../config/defaults.js';
import type { Settings, WakeKind } from '../model/index.js';
export interface PriorityInput { kind: WakeKind; score: number; ownerInitiated?: boolean; toOwner?: boolean; anomaly?: boolean }
/** 按主人、审批、承诺及普通理由排序，让紧要事项先获得回合。 */
export function priorityFor(input: PriorityInput, settings: Settings = resolveSettings()): number {
  const p = settings.c02.priorities;
  if (input.ownerInitiated || input.kind === 'owner_message') return p.owner;
  if (input.kind === 'approval_decided' || input.kind === 'inbox_reply') return p.reply;
  if (input.kind === 'agenda_due' && input.toOwner && input.score >= settings.c02.agendaOwnerDueScore) return p.obligation;
  if (input.kind === 'drive') return p.drive;
  if (input.kind === 'next_think') return p.nextThink;
  if (input.kind === 'catch_up') return p.catchUp;
  if (input.kind === 'light_check') return p.lightCheck;
  if (input.anomaly) return p.anomaly;
  return input.score * p.scoreMultiplier;
}
