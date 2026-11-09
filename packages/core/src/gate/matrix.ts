/** 自主等级矩阵只回答放行、审批或拒绝；持续自我变更的具体提议规则由对应中心工具落实。 */
import { z } from 'zod';
import { parseInput } from '../engine/validation.js';
import { AutonomySchema, LifecycleSchema } from '../model/enums.js';
import type { Autonomy, Lifecycle } from '../model/enums.js';
import type { ToolActionClass, Classification } from './paths.js';
export type GateDecision = 'allow' | 'approval' | 'deny';
/** 将动作风险与自主等级组合为允许、审批或拒绝，试岗按 L1 且 D 类始终审批。 */
export function decide(input: ToolActionClass | Classification, autonomy: Autonomy, lifecycle: Lifecycle, grants: string[] = []): GateDecision {
    const action: Partial<Classification> & {
        cls: ToolActionClass;
    } = typeof input === 'string' ? { cls: input } : input;
    const cls = parseInput(z.enum(['A', 'B', 'C', 'D', 'protected']), action.cls, '动作类别');
    autonomy = parseInput(AutonomySchema, autonomy, '自主等级');
    lifecycle = parseInput(LifecycleSchema, lifecycle, '生命周期');
    grants = parseInput(z.array(z.string().min(1)), grants, '授权子类');
    if (cls === 'protected')
        return 'deny';
    if (lifecycle === 'probation')
        autonomy = 'L1';
    if (cls === 'A') {
        // 只读与会话内部动作在 L0 均可用；普通文件写入继续限定为 work 和 MEMORY。
        if (autonomy !== 'L0' || typeof input === 'string' || action.readOnly || ['memory', 'work', 'hub_tool', 'session_internal'].includes(action.subclass ?? ''))
            return 'allow';
        return 'deny';
    }
    if (autonomy === 'L0')
        return 'deny';
    if (cls === 'B')
        return autonomy === 'L1' ? 'approval' : 'allow';
    if (cls === 'D')
        return 'approval';
    // L3 只支持精确子类名，不接受通配符或笼统的 C 类授权。
    return autonomy === 'L3' && !!action.subclass && grants.includes(action.subclass) ? 'allow' : 'approval';
}
