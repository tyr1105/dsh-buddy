/** 产物索引不带正文；查看与验收按固定版本执行，验收绝不顺手完成目标或触发唤醒。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { ArtifactBatchSchema, ArtifactReviewSchema, ArtifactVersionSchema, ArtifactVerdictSchema, type ArtifactReview } from '../model/artifact.js';
import { artifactReference, canReadVersion, readArtifactVersion, type ArtifactActor } from './access.js';
import { newId } from '../util/ids.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

export const ReviewArtifactInputSchema = z.strictObject({
  versionId: nonempty, verdict: ArtifactVerdictSchema, note: z.string().trim().max(1000, '验收说明最多 1000 字').optional(),
});
export const ReadArtifactInputSchema = z.strictObject({ versionId: nonempty });
export interface ArtifactVersionRow {
  id: string; artifactId: string; title: string; number: number; reference: string;
  commitId: string; wakeId: string; goalIds: string[]; createdAt: number; bytes: number; sha256: string;
  visibility: 'only_me' | 'owner' | 'others'; review: ArtifactReview | null;
}
export interface ArtifactListView {
  versions: ArtifactVersionRow[];
  unarchived: Array<{ where: string; detail: string }>;
}

/** 每条可见性实时判断；旧档自然为空。失败记录只解释最新交账的未归档位置。 */
export async function artifactList(ctx: HubContext, botId: string, actor: ArtifactActor): Promise<ArtifactListView> {
  const versions: ArtifactVersionRow[] = [];
  for (const version of ctx.store.table('artifactVersions').list(v => v.botId === botId)
    .flatMap(raw => { const parsed = ArtifactVersionSchema.safeParse(raw); return parsed.success ? [parsed.data] : []; })
    .filter(v => v.createdAt >= ctx.clock.now() - ctx.settings.retentionMsByCollection.artifactVersions)
    .sort((a, b) => b.createdAt - a.createdAt || b.number - a.number)) {
    try {
      if (!await canReadVersion(ctx, version, actor)) continue;
      const review = ctx.store.table('artifactReviews').list(row => row.versionId === version.id)
        .flatMap(raw => { const parsed = ArtifactReviewSchema.safeParse(raw); return parsed.success ? [parsed.data] : []; })
        .reverse().sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      versions.push({ id: version.id, artifactId: version.artifactId, title: version.title, number: version.number,
        reference: artifactReference(version.id), commitId: version.commitId, wakeId: version.wakeId,
        goalIds: version.goalIds, createdAt: version.createdAt, bytes: version.bytes, sha256: version.sha256,
        visibility: version.visibility, review });
    } catch { /* 授权目录无法核对时失败关闭，不能泄漏该条摘要。 */ }
  }
  const latest = ctx.store.table('artifactBatches').list(row => row.botId === botId)
    .flatMap(raw => { const parsed = ArtifactBatchSchema.safeParse(raw); return parsed.success ? [parsed.data] : []; })
    .reverse().sort((a, b) => b.createdAt - a.createdAt)[0];
  return { versions, unarchived: latest?.items.filter(item => item.versionId === null
    && (actor.kind === 'bot' && actor.botId === botId || (actor.kind === 'owner' && item.visibility !== 'only_me')
      || item.visibility === 'others'))
    .map(item => ({ where: item.where, detail: item.detail })) ?? [] };
}

/** 只追加指定版本的主人判断；同一提交重复点击不会再记一条相同结论。 */
export async function reviewArtifact(ctx: HubContext, raw: unknown): Promise<ArtifactReview> {
  const args = parseInput(ReviewArtifactInputSchema, raw, '产物验收');
  const version = await readArtifactVersion(ctx, args.versionId, { kind: 'owner' });
  const note = args.note ?? '';
  const last = ctx.store.table('artifactReviews').list(row => row.versionId === version.id)
    .reverse().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last?.verdict === args.verdict && last.note === note) return last;
  const row = ArtifactReviewSchema.parse({ id: newId('ar', ctx.rng), versionId: version.id,
    botId: version.botId, verdict: args.verdict, note, createdAt: ctx.clock.now() });
  ctx.store.table('artifactReviews').put(row);
  ctx.emit(HUB_EVENT_SCOPES.bot, version.botId);
  return row;
}
