/** 交账输入比持久化记录更严格：模式互斥、必填原因和提问默认值在产生副作用前一次校验。 */
import { z } from 'zod';
import { CommitSchema, NextThinkSchema } from '../model/wake.js';
import { parseFlexibleTime } from '../util/time.js';
export const FlexibleTimeSchema = z.string({ error: '时间必须是文字' }).refine(value => parseFlexibleTime(value, 'Asia/Shanghai') !== null, '时间必须是有效的 ISO 时间或 YYYY-MM-DD HH:mm（北京时间）');
export const CommitNextThinkSchema = NextThinkSchema.extend({ at: FlexibleTimeSchema.optional() }).superRefine((value, ctx) => {
    if (!value.reason.trim())
        ctx.addIssue({ code: 'custom', path: ['reason'], message: '下次思考理由不能为空白' });
    const field = { at: 'at', after: 'afterMinutes', on_event: 'onEvent', auto: null }[value.mode];
    for (const key of ['at', 'afterMinutes', 'onEvent'] as const) {
        if (key === field && (value[key] === undefined || (typeof value[key] === 'string' && !value[key].trim()))) {
            ctx.addIssue({ code: 'custom', path: [key], message: `${value.mode} 模式必须填写 ${key}` });
        }
        else if (key !== field && value[key] !== undefined) {
            ctx.addIssue({ code: 'custom', path: [key], message: `${value.mode} 模式不能填写 ${key}` });
        }
    }
});
/**
 * 交账输入的构造函数。
 * P72j J1：总管名下有待确认约定时，约定卡就是给主人的提问，needs_owner 不再要求 ownerQuestion；
 * 所以「needs_owner 必须带 ownerQuestion」这一条做成开关，其余校验两种完全一致。
 * P72j J3：reply、report、blocker、ownerQuestion 允许为 null 的字段，模型省略时等同于 null
 * （真模型常省略它们，旧写法会报「report：必须是文字」）；传了错误类型仍然报错。
 */
function buildCommitInputSchema(needsOwnerRequiresQuestion: boolean) {
    return CommitSchema.omit({ id: true, wakeId: true, botId: true, createdAt: true })
    .extend({ nextThink: CommitNextThinkSchema,
        blocker: CommitSchema.shape.blocker.default(null), ownerQuestion: CommitSchema.shape.ownerQuestion.default(null),
        reply: CommitSchema.shape.reply.default(null), report: CommitSchema.shape.report.default(null) }).superRefine((value, ctx) => {
    if (!value.summary.trim())
        ctx.addIssue({ code: 'custom', path: ['summary'], message: '交账摘要不能为空白' });
    if (value.outcome === 'blocked' && !value.blocker?.trim())
        ctx.addIssue({ code: 'custom', path: ['blocker'], message: 'blocked 必须说明阻碍' });
    if (needsOwnerRequiresQuestion && value.outcome === 'needs_owner' && !value.ownerQuestion)
        ctx.addIssue({ code: 'custom', path: ['ownerQuestion'], message: 'needs_owner 必须填写给主人提问' });
    const q = value.ownerQuestion;
    if (q) {
        if (q.options.length < 2 || q.options.length > 4)
            ctx.addIssue({ code: 'custom', path: ['ownerQuestion', 'options'], message: '选项必须有 2 至 4 个' });
        if (q.options.some(option => !option.trim()) || new Set(q.options).size !== q.options.length)
            ctx.addIssue({ code: 'custom', path: ['ownerQuestion', 'options'], message: '选项不能为空白或重复' });
        if (!q.options.includes(q.defaultOption))
            ctx.addIssue({ code: 'custom', path: ['ownerQuestion', 'defaultOption'], message: '默认选项必须在 options 中' });
        for (const key of ['text', 'whyNeeded'] as const)
            if (!q[key].trim())
                ctx.addIssue({ code: 'custom', path: ['ownerQuestion', key], message: '提问及理由不能为空白' });
    }
});
}
/** 默认交账输入：needs_owner 必须带 ownerQuestion。 */
export const CommitInputSchema = buildCommitInputSchema(true);
/** 宽松版（hub_commit 工具入口与「总管有待确认约定」的交账用）：needs_owner 可以不带 ownerQuestion，是否放行由 processCommit 按总管的约定状态裁定。 */
export const CommitToolSchema = buildCommitInputSchema(false);
export type CommitInput = z.infer<typeof CommitInputSchema>;
