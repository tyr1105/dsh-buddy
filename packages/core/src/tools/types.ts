/** 工具公共契约：把模型传来的参数与可信宿主回合身份分开，所有结果都用中文返回。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { nonempty } from '../model/primitives.js';
export const ToolContextSchema = z.strictObject({ botId: nonempty, sessionId: nonempty, wakeId: nonempty.nullable() });
export type ToolContext = z.infer<typeof ToolContextSchema>;
export type ToolResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    error: string;
};
export interface HubTool {
    name: string;
    description: string;
    schema: z.ZodType;
    jsonSchema: Record<string, unknown>;
    /** 统一校验参数、身份、生命周期和回合边界，再执行工具并把异常转为中文失败结果。 */
    handler(ctx: HubContext, toolCtx: ToolContext, args: unknown): Promise<ToolResult>;
}
