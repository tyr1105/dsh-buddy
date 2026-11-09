/**
 * F06 独立结果校验记录：执行者的交账保持原样，中心实查和主人结论另外保存。
 * 文件存在只说明交付了东西，不能证明内容正确；不把中心检查写成执行者的自述。
 */
import { z } from 'zod';
import { nonempty, text, timestamp, count } from './primitives.js';

export const ARTIFACT_CHECK_LABELS = {
  present: '文件存在且非空', missing: '文件不存在', empty: '文件为空',
  invalid: '不是普通文件', unchecked: '未能实查',
} as const;
export const RESULT_VERDICT_LABELS = {
  passed: '验收通过', not_done: '没做', incorrect: '做错', mismatch: '不是你要的',
  rejected: '未通过', expired: '未答复，按未通过处理',
} as const;
export type ResultVerdict = keyof typeof RESULT_VERDICT_LABELS;

/** 每项只存元信息，禁止将凭据、文件正文或网络内容夹进验收记录。 */
export const ArtifactCheckSchema = z.strictObject({
  where: text, status: z.enum(['present', 'missing', 'empty', 'invalid', 'unchecked']),
  detail: nonempty, size: count.nullable(),
});
export type ArtifactCheck = z.infer<typeof ArtifactCheckSchema>;
/** 同次交账可以关联多个目标，各目标的验收结果必须分别记账。 */
export const ResultCheckSchema = z.strictObject({
  id: nonempty, botId: nonempty, wakeId: nonempty, createdAt: timestamp,
  goals: z.array(z.strictObject({ id: nonempty, doneWhen: text })),
  artifacts: z.array(ArtifactCheckSchema),
  decisions: z.array(z.strictObject({
    goalId: nonempty, verdict: z.enum(['passed', 'not_done', 'incorrect', 'mismatch', 'rejected', 'expired']),
    answer: text, at: timestamp,
    artifacts: z.array(ArtifactCheckSchema),
  })),
});
export type ResultCheck = z.infer<typeof ResultCheckSchema>;
