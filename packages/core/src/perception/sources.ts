/** 主人、同伴和系统事件的感知构造器；只负责记录事实，入队和投递留给后续的编排层。 */
import { z } from 'zod';
import { nonempty, text, timestamp } from '../model/primitives.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Percept } from '../model/perception.js';
import { recordPercept } from './percept.js';

const SourceEventInputSchema = z.strictObject({ botId: nonempty, id: nonempty, summary: text, at: timestamp });
export type SourceEventInput = z.infer<typeof SourceEventInputSchema>;

/** 事件 id 纳入指纹，内容相同的两条主人消息仍是两次独立要求。 */
function sourcePercept(ctx: HubContext, input: SourceEventInput, source: Percept['source'], kind: string, untrusted: boolean): Percept | null {
  input = parseInput(SourceEventInputSchema, input, '来源事件参数');
  return recordPercept(ctx, { botId: input.botId, watchId: null, source, kind, summary: input.summary, location: input.id,
    fingerprintMaterial: [source, kind, input.id], magnitude: 1, anomaly: false, untrusted, occurredAt: input.at });
}
/** 记录主人消息为可信高优先级感知，事件身份区分重复文本。 */
export function recordOwnerMessage(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'owner', 'owner_message', false); }
/** 记录同伴消息并保留不可信标记，避免同伴文本提升为主人指令。 */
export function recordPeerMessage(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'peer', 'peer_message', true); }
/** 记录交接事实供接收机器人评估，交接文本仍保持不可信。 */
export function recordHandoff(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'peer', 'handoff', true); }
/** 把界面回答记为可信感知，后续可唤醒等待中的机器人。 */
export function recordInboxReply(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'inbox', 'inbox_reply', false); }
/** 记录真实审批结果，不能由外部文本伪造批准来源。 */
export function recordApprovalDecision(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'inbox', 'approval_decided', false); }
/** 记录停机证据供补课回合引用，不直接启动会话。 */
export function recordDowntime(ctx: HubContext, input: SourceEventInput): Percept | null { return sourcePercept(ctx, input, 'system', 'downtime', false); }
