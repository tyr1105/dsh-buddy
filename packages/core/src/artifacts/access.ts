/** 版本读取仍检查当前授权与来源边界；归档不能成为绕过工作数据权限的通道。 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { ArtifactVersionSchema, type ArtifactVersion } from '../model/artifact.js';
import { isSensitive, within } from '../gate/paths.js';
import { resolveRealTarget } from '../gate/real-path.js';

export type ArtifactActor = { kind: 'owner' } | { kind: 'bot'; botId: string };
export const artifactHash = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');
export const artifactReference = (id: string): string => `artifact:${id}`;

/** 先过滤身份，再检查边界；拒绝时不向无权读的人泄漏产物名称或路径。 */
export async function canReadVersion(ctx: HubContext, version: ArtifactVersion, actor: ArtifactActor): Promise<boolean> {
  const author = ctx.store.table('bots').get(version.botId);
  const reader = actor.kind === 'bot' ? ctx.store.table('bots').get(actor.botId) : null;
  if (!author || (actor.kind === 'bot' && !reader)) return false;
  const own = reader?.id === author.id;
  if (version.visibility === 'only_me' && !own) return false;
  if (actor.kind === 'bot' && !own && version.visibility !== 'others') return false;
  if ([version.sourcePath, version.realPath].some(isSensitive)) return false;
  if (![`${author.homeDir}/work`, `${ctx.settings.rootDir}/shared`].some(base => within(version.sourcePath, base))) return false;
  const roots = await Promise.all([`${author.homeDir}/work`, `${ctx.settings.rootDir}/shared`]
    .map(base => resolveRealTarget(ctx.fs, base)));
  if (!roots.some(base => within(version.realPath, base))) return false;
  // 来源文件可已删除；只解析配置目录，不重读或要求原文件继续存在。
  if (!(actor.kind === 'owner' ? author.workDataAllowed : reader!.workDataAllowed)) {
    for (const base of ctx.settings.workDataPaths) {
      if ([version.sourcePath, version.realPath].some(file => within(file, posix.resolve(base)))) return false;
      const real = await resolveRealTarget(ctx.fs, base);
      if ([version.sourcePath, version.realPath].some(file => within(file, real))) return false;
    }
  }
  return true;
}

/** 返回完整不可执行文本；历史坏记录及指纹不符一律拒绝，不用部分正文冒充完整版本。 */
export async function readArtifactVersion(ctx: HubContext, id: string, actor: ArtifactActor): Promise<ArtifactVersion> {
  // 界面复制的固定引用可直接交给工具；存储中只使用原始版本 id。
  const row = ArtifactVersionSchema.safeParse(ctx.store.table('artifactVersions').get(id.replace(/^artifact:/, '')));
  if (!row.success || !await canReadVersion(ctx, row.data, actor)) throw new Error('versionId：版本不存在、已过期或无权读取');
  const version = row.data;
  if (version.createdAt < ctx.clock.now() - ctx.settings.retentionMsByCollection.artifactVersions)
    throw new Error('versionId：版本已过期');
  if (version.bytes > ctx.settings.artifacts.maxBytes || Buffer.byteLength(version.content) !== version.bytes
    || artifactHash(version.content) !== version.sha256) throw new Error('versionId：版本内容校验失败，不能读取或交接');
  return version;
}
