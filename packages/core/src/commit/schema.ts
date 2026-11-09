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
export const CommitInputSchema = CommitSchema.omit({ id: true, wakeId: true, botId: true, createdAt: true })
    .extend({ nextThink: CommitNextThinkSchema }).superRefine((value, ctx) => {
    if (!value.summary.trim())
        ctx.addIssue({ code: 'custom', path: ['summary'], message: '交账摘要不能为空白' });
    if (value.outcome === 'blocked' && !value.blocker?.trim())
        ctx.addIssue({ code: 'custom', path: ['blocker'], message: 'blocked 必须说明阻碍' });
    if (value.outcome === 'needs_owner' && !value.ownerQuestion)
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
export type CommitInput = z.infer<typeof CommitInputSchema>;
