/** 交账归档有界的完整 UTF-8 文件；前后核验路径和元信息，任何失败都保留真实交账。 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Commit, Goal } from '../model/index.js';
import { ArtifactBatchSchema, ArtifactHeadSchema, ArtifactVersionSchema, type ArtifactBatch } from '../model/artifact.js';
import { isSensitive, within } from '../gate/paths.js';
import { resolveRealTarget } from '../gate/real-path.js';
import { artifactHash } from './access.js';

/** 只有本模块生成的错误能进入公开报告，文件接口的原始异常不能靠前缀冒充安全文案。 */
class ArchiveError extends Error {}

/** 位置同时经过原始范围与真实范围核对；配置工作数据目录的别名同样受保护。 */
async function checkSource(ctx: HubContext, botId: string, source: string): Promise<string> {
  const bot = ctx.store.table('bots').get(botId)!;
  const roots = [`${bot.homeDir}/work`, `${ctx.settings.rootDir}/shared`];
  if (isSensitive(source) || !roots.some(root => within(source, root))) throw new ArchiveError('来源不在允许的工作或共享目录');
  if (!bot.workDataAllowed && ctx.settings.workDataPaths.some(root => within(source, root))) throw new ArchiveError('尚未授权工作数据');
  const real = await ctx.fs.realpath(source);
  if (isSensitive(real)) throw new ArchiveError('真实来源涉及敏感文件');
  const realRoots = await Promise.all(roots.map(root => resolveRealTarget(ctx.fs, root)));
  if (!realRoots.some(root => within(real, root))) throw new ArchiveError('真实来源超出工作或共享目录');
  if (!bot.workDataAllowed) {
    const workRoots = await Promise.all(ctx.settings.workDataPaths.map(root => resolveRealTarget(ctx.fs, root)));
    if (workRoots.some(root => within(real, root))) throw new ArchiveError('真实来源尚未授权工作数据');
  }
  return real;
}

/** 单个位置只保存完整普通文本；同逻辑产物的版本号在最后一次 await 后原子递增。 */
async function archiveOne(ctx: HubContext, commit: Commit, goals: Goal[], where: string): Promise<string> {
  const bot = ctx.store.table('bots').get(commit.botId);
  if (!bot) throw new ArchiveError('发起队友不存在');
  if (!where || /^[a-z][a-z0-9+.-]*:/i.test(where) || /[$`*?\u0000]/.test(where)) throw new ArchiveError('不支持远程或不确定位置');
  const source = posix.resolve(bot.homeDir, where);
  const real = await checkSource(ctx, bot.id, source);
  const before = await ctx.fs.stat(real);
  if (!before) throw new ArchiveError('来源文件不存在');
  if (before.isFile !== true) throw new ArchiveError('来源不是普通文件');
  if (!before.size) throw new ArchiveError('来源文件为空');
  if (before.size > ctx.settings.artifacts.maxBytes) throw new ArchiveError('来源超过完整文本版本的字节上限');
  const bytes = await ctx.fs.readBytes(real);
  if (!bytes || bytes.byteLength !== before.size) throw new ArchiveError('读取期间来源发生变化');
  if (bytes.byteLength > ctx.settings.artifacts.maxBytes) throw new ArchiveError('来源超过完整文本版本的字节上限');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ArchiveError('来源不是有效 UTF-8 文本'); }
  if (!content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) throw new ArchiveError('来源为空白或含非文本控制字节');
  if (await checkSource(ctx, bot.id, source) !== real) throw new ArchiveError('读取期间来源路径发生变化');
  const after = await ctx.fs.stat(real);
  if (!after || after.isFile !== true || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.inode !== before.inode) throw new ArchiveError('读取期间来源发生变化');
  const artifactId = `art_${artifactHash(`${bot.id}\n${source}`).slice(0, 24)}`;
  // 交账重入/并发时先检查固定关联，不重复占用版本号与资源名额。
  const old = ctx.store.table('artifactVersions').list(v => v.artifactId === artifactId && v.commitId === commit.id)[0];
  if (old) return old.id;
  if (ctx.store.table('artifactVersions').count(v => v.botId === bot.id) >= ctx.settings.artifacts.maxVersionsPerBot)
    throw new ArchiveError('本队友保留版本已达上限');
  const head = ctx.store.table('artifactHeads').get(artifactId);
  const number = Math.max(head?.lastVersion ?? 0,
    ...ctx.store.table('artifactVersions').list(v => v.artifactId === artifactId).map(v => v.number)) + 1;
  // 同路径重复声明取最严格可见性，不能借第二个 others 声明扩大 only_me 的权限。
  const rank = { only_me: 0, owner: 1, others: 2 };
  const changes = commit.worldChanges.filter(change => posix.resolve(bot.homeDir, change.where.trim()) === source);
  const visibility = changes.map(change => change.whoCanSee).sort((a, b) => rank[a] - rank[b])[0] ?? 'only_me';
  const version = ArtifactVersionSchema.parse({
    id: `${artifactId}:v${number}`, artifactId, botId: bot.id, number, sourcePath: source, realPath: real,
    title: posix.basename(source), visibility, content, bytes: bytes.byteLength, sha256: artifactHash(bytes),
    commitId: commit.id, wakeId: commit.wakeId, goalIds: goals.map(goal => goal.id), createdAt: commit.createdAt,
  });
  ctx.store.table('artifactVersions').put(version);
  ctx.store.table('artifactHeads').put(ArtifactHeadSchema.parse({ id: artifactId, botId: bot.id, sourcePath: source,
    lastVersion: number, createdAt: head?.createdAt ?? commit.createdAt, updatedAt: commit.createdAt }));
  return version.id;
}

/** 一次交账一条归档报告；失败逐项隔离，不让一个文件故障吞掉其余已交付成果。 */
export async function archiveCommitArtifacts(ctx: HubContext, commit: Commit, goals: Goal[]): Promise<ArtifactBatch> {
  const old = ctx.store.table('artifactBatches').get(commit.id);
  if (old) return old;
  const items: ArtifactBatch['items'] = [];
  const locations = [...new Set(commit.worldChanges.map(change => change.where.trim()))];
  for (const where of locations.slice(0, ctx.settings.artifacts.maxLocations)) {
    const rank = { only_me: 0, owner: 1, others: 2 };
    const visibility = commit.worldChanges.filter(change => change.where.trim() === where)
      .map(change => change.whoCanSee).sort((a, b) => rank[a] - rank[b])[0] ?? 'only_me';
    try { items.push({ where, visibility, versionId: await archiveOne(ctx, commit, goals, where), detail: '已归档完整文本版本' }); }
    catch (error) {
      // 底层错误可能包含敏感路径，只有领域生成的原因才能进入可见报告。
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      const safe = error instanceof ArchiveError ? error.message : missing ? '来源文件不存在' : '文件读取失败，未归档';
      items.push({ where, visibility, versionId: null, detail: safe });
    }
  }
  if (locations.length > ctx.settings.artifacts.maxLocations)
    items.push({ where: '', visibility: 'owner', versionId: null, detail: '交付位置超过本轮上限，剩余位置未归档' });
  const batch = ArtifactBatchSchema.parse({ id: commit.id, botId: commit.botId, createdAt: commit.createdAt, items });
  ctx.store.table('artifactBatches').put(batch);
  return batch;
}
