/**
 * 项目成员的最小改写（P74b）：派活、改派时把执行者和核对人加进项目成员名单。
 *
 * 为什么不走 saveProject：saveProject 会校验名单里的全部成员是否在岗，同一个项目里只要有一位已归档的旧成员，
 * 加一位新人也会整个失败（P73ab 复核 F1）。这里只改成员名单、写一条审计，别的字段一概不动。
 * 本文件只写项目表和审计日志；调用方负责在后续步骤失败时调用 removeProjectMembers 移回。
 */
import { V2_DEFAULTS } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { writeOutreachAudit } from '../outreach/audit.js';

/**
 * 把这些员工加进项目成员名单；已是成员的跳过。返回实际新加入的 id（调用方恢复时只移这几位）。
 * @param actorId 审计里的操作人（派活时是总管）
 * @param extra 审计 detail 的补充字段（例如 { byJob: jobId }）
 */
export function addProjectMembers(ctx: HubContext, projectId: string, botIds: readonly string[], actorId: string, extra: Record<string, unknown> = {}): string[] {
  const project = ctx.store.table('projects').get(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const added = [...new Set(botIds)].filter(id => !project.memberBotIds.includes(id));
  if (added.length === 0) return [];
  const members = [...project.memberBotIds, ...added];
  if (members.length > V2_DEFAULTS.PROJECT_MEMBER_MAX) {
    throw new Error(`项目成员不能超过 ${V2_DEFAULTS.PROJECT_MEMBER_MAX} 位员工，当前已有 ${project.memberBotIds.length} 位`);
  }
  const now = ctx.clock.now();
  ctx.store.table('projects').put({ ...project, memberBotIds: members, updatedAt: now });
  writeOutreachAudit(ctx, 'project_member_add', { id: project.id, name: project.name, memberBotIds: members, added, ...extra }, actorId, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return added;
}

/**
 * 把刚加入的成员移回（派活中途失败时恢复用）。只移指定的几位，不碰其他字段；
 * 审计日志只追加不撤回，所以另写一条移出记录，说明这是恢复。
 */
export function removeProjectMembers(ctx: HubContext, projectId: string, botIds: readonly string[], actorId: string, extra: Record<string, unknown> = {}): void {
  if (botIds.length === 0) return;
  const project = ctx.store.table('projects').get(projectId);
  if (!project) return;
  const members = project.memberBotIds.filter(id => !botIds.includes(id));
  const now = ctx.clock.now();
  ctx.store.table('projects').put({ ...project, memberBotIds: members, updatedAt: now });
  writeOutreachAudit(ctx, 'project_member_remove', { id: project.id, name: project.name, memberBotIds: members, removed: [...botIds], ...extra }, actorId, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}
