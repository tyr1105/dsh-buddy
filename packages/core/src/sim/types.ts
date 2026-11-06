/** 仿真大脑与记录契约：声明工具、用量和结束方式，让测试无需真实模型仍走完整宿主链路。 */
import type { HostPort, MessageSource, Variant } from '../model/index.js';
import type { ToolResult } from '../tools/types.js';

export interface BrainInput {
  packet: string;
  variant: Variant;
  botId: string;
  sessionId: string;
  /** 工具调用会先经过中心守卫；tokens 是本步声明的增量用量。 */
  call(tool: string, args: unknown, tokens?: number): Promise<ToolResult>;
}
export interface BrainResult {
  finalText?: string;
  error?: string;
  /** 卡住只保留宿主运行状态，不制造永不完成的 Promise，假时钟仍可继续推进。 */
  hang?: boolean;
  awaitingApproval?: { tool: string; summary: string };
  /** 最终用量可补充纯思考消耗，但不得小于已经报告的工具用量。 */
  tokens?: number;
}
export type Brain = (input: BrainInput) => Promise<BrainResult>;
export type SimCall = { method: keyof HostPort; args: unknown[]; at: number };
export type SimNotification = Parameters<HostPort['notify']>[0] & { at: number };
export type SimTurn = {
  botId: string; sessionId: string; packet: string; variant: Variant; source: MessageSource;
  startedAt: number; endedAt: number | null; steps: number; tokens: number;
  status: 'scheduled' | 'running' | 'ended' | 'error' | 'hung' | 'cancelled' | 'awaiting_approval';
};
export type SimToolCall = {
  botId: string; sessionId: string; tool: string; args: unknown; result: ToolResult; at: number;
};
