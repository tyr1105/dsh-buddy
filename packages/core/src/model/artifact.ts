/** 产物独立保存完整版本与指定版本的验收；不改写交账、目标或已封存账本。 */
import { z } from 'zod';
import { nonempty, count } from './primitives.js';

export const ArtifactVisibilitySchema = z.enum(['only_me', 'owner', 'others']);
export const ArtifactVerdictSchema = z.enum(['passed', 'not_done', 'incorrect', 'mismatch']);
/** 验收结论中文标签：项目页与右栏共用同一份口径，界面不再自己翻译。 */
export const ARTIFACT_VERDICT_LABELS: Record<z.infer<typeof ArtifactVerdictSchema>, string> = {
  passed: '通过', not_done: '没做', incorrect: '做错', mismatch: '不是你要的',
};
export const ArtifactHeadSchema = z.strictObject({
  id: nonempty, botId: nonempty, sourcePath: nonempty, lastVersion: count,
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
export const ArtifactVersionSchema = z.strictObject({
  id: nonempty, artifactId: nonempty, botId: nonempty, number: count,
  title: nonempty, sourcePath: nonempty, realPath: nonempty,
  visibility: ArtifactVisibilitySchema, content: nonempty, bytes: count,
  sha256: z.string().regex(/^[a-f0-9]{64}$/, '内容指纹必须是 SHA-256'),
  commitId: nonempty, wakeId: nonempty, goalIds: z.array(nonempty), createdAt: z.number().int(),
});
export const ArtifactReviewSchema = z.strictObject({
  id: nonempty, versionId: nonempty, botId: nonempty, verdict: ArtifactVerdictSchema,
  note: z.string(), createdAt: z.number().int(),
});
/** 未归档也保留原因，不能让失败的位置从产物列表悄悄消失。 */
export const ArtifactBatchSchema = z.strictObject({
  id: nonempty, botId: nonempty, createdAt: z.number().int(),
  items: z.array(z.strictObject({
    where: z.string(), versionId: nonempty.nullable(), detail: nonempty, visibility: ArtifactVisibilitySchema,
  })),
});
export type ArtifactHead = z.infer<typeof ArtifactHeadSchema>;
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type ArtifactReview = z.infer<typeof ArtifactReviewSchema>;
export type ArtifactBatch = z.infer<typeof ArtifactBatchSchema>;
export type ArtifactVerdict = z.infer<typeof ArtifactVerdictSchema>;
