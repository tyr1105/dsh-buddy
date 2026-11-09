/**
 * 任务与产物的关联（F08 尾巴）：主人把队友产出的一份产物挂到项目任务上，
 * 任务验收通过时再把这些产物的最新版本一并记为「通过」。
 *
 * 为什么单独成文件：产物表由 F09 维护、项目容器由 F08 维护，两边原本互不相识。
 * 关联只走主人显式挂接，不按目录自动认领——产物正文在队友工作目录里，硬拿项目的
 * sharedDir 去过滤会把所有产物拒之门外（保守默认记在 docs/questions.md）。
 *
 * 纪律：入参 zod 校验；时间与随机数只走注入；只读产物索引与验收表，不读正文、
 * 不改账本、不改交账。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId } from '../model/primitives.js';
import type { ArtifactReview, ArtifactVersion } from '../model/artifact.js';
import { ArtifactReviewSchema } from '../model/artifact.js';
import type { ProjectTask } from '../model/project.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

/** 关联入参：任务 id + 产物引用（产物头 id 或某个版本 id 都接受）。 */
export const AttachTaskArtifactSchema = z.strictObject({
  taskId: recordId('pt'),
  artifactId: nonempty,
});

/** 任务验收通过时自动写入的验收说明，让主人知道这条结论不是自己点的。 */
export const ACCEPTANCE_REVIEW_NOTE = '任务验收通过时按关联产物自动记录';

/**
 * 把一条产物引用解析成具体版本（纯函数）：
 * - 版本 id 直接命中；
 * - 产物头 id 取该产物版本号最大的一版（“跟随最新版”）；
 * - 查不到返回 null，界面如实显示为空，不编造。
 */
export function resolveArtifactRef(
  versions: readonly ArtifactVersion[], ref: string,
): ArtifactVersion | null {
  const direct = versions.find(version => version.id === ref);
  if (direct) return direct;
  let latest: ArtifactVersion | null = null;
  for (const version of versions) {
    if (version.artifactId !== ref) continue;
    if (latest === null || version.number > latest.number) latest = version;
  }
  return latest;
}

/** 某个版本最近的一条验收结论；没有记录返回 null。 */
function latestReviewOf(ctx: HubContext, versionId: string): ArtifactReview | null {
  return ctx.store.table('artifactReviews').list(row => row.versionId === versionId)
    .reverse().sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** 任务已关联的引用是否已经指向同一份产物（头 id 与版本 id 混用时不重复挂）。 */
function sameArtifact(versions: readonly ArtifactVersion[], refs: readonly string[], incoming: string): boolean {
  const target = resolveArtifactRef(versions, incoming);
  if (target === null) return false;
  return refs.some(ref => {
    if (ref === incoming) return true;
    return resolveArtifactRef(versions, ref)?.artifactId === target.artifactId;
  });
}

/**
 * 主人把一份产物关联到任务：校验任务/项目/产物都在，项目未归档、任务未通过验收，
 * 同一份产物不重复挂、条数不超上限；成功后追加 artifactIds、写审计并发 project 事件。
 * 重复关联按幂等处理（原样返回，不再写审计），避免双击或多端操作产生噪音。
 */
export function attachTaskArtifact(ctx: HubContext, raw: unknown): ProjectTask {
  const input = parseInput(AttachTaskArtifactSchema, raw, '任务关联产物');
  const task = ctx.store.table('projectTasks').get(input.taskId);
  if (!task) throw new Error(`任务不存在：${input.taskId}`);
  const project = ctx.store.table('projects').get(task.projectId);
  if (!project) throw new Error(`任务所属项目不存在：${task.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，不能再关联产物`);
  if (task.status === 'accepted') throw new Error(`任务「${task.title}」已通过验收，不能再关联产物`);

  // 产物引用必须存在：头表或版本表任一命中都算，和视图的解析口径一致。
  const head = ctx.store.table('artifactHeads').get(input.artifactId);
  const version = ctx.store.table('artifactVersions').get(input.artifactId);
  if (!head && !version) throw new Error(`产物不存在：${input.artifactId}`);

  const versions = ctx.store.table('artifactVersions').list();
  if (sameArtifact(versions, task.artifactIds, input.artifactId)) return task;
  if (task.artifactIds.length >= V2_DEFAULTS.PROJECT_TASK_ARTIFACT_MAX) {
    throw new Error(`单个任务最多关联 ${V2_DEFAULTS.PROJECT_TASK_ARTIFACT_MAX} 份产物，请先整理已有的关联`);
  }

  const now = ctx.clock.now();
  const record = ctx.store.table('projectTasks').patch(task.id, {
    artifactIds: [...task.artifactIds, input.artifactId],
    updatedAt: now,
  });
  const resolved = resolveArtifactRef(versions, input.artifactId);
  writeOutreachAudit(ctx, 'task_artifact_attach', {
    id: task.id, projectId: task.projectId, artifactId: resolved?.artifactId ?? input.artifactId,
    versionId: resolved?.id ?? null, count: record.artifactIds.length,
  }, 'owner', now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return record;
}

/**
 * 任务验收通过时的产物联动：把任务关联产物的最新版本记为「通过」。
 * 幂等——最新结论已经是通过就不再写；只写验收表，不读正文、不改账本。
 * 返回本次新写入的版本 id（供服务层落一条审计），没有变化给空数组。
 */
export function recordAcceptancePassed(ctx: HubContext, task: ProjectTask): string[] {
  const versions = ctx.store.table('artifactVersions').list();
  const now = ctx.clock.now();
  const written: string[] = [];
  const touchedBots = new Set<string>();
  for (const ref of [...new Set(task.artifactIds)]) {
    const version = resolveArtifactRef(versions, ref);
    if (!version) continue;
    const last = latestReviewOf(ctx, version.id);
    if (last?.verdict === 'passed') continue;
    ctx.store.table('artifactReviews').put(ArtifactReviewSchema.parse({
      id: newId('ar', ctx.rng),
      versionId: version.id,
      botId: version.botId,
      verdict: 'passed',
      note: ACCEPTANCE_REVIEW_NOTE,
      createdAt: now,
    }));
    written.push(version.id);
    touchedBots.add(version.botId);
  }
  // 产物验收结论属于机器人详情，逐个发 bot 事件；没有变化就不发。
  for (const botId of touchedBots) ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return written;
}
