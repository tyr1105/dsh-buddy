/**
 * 启动整理（P73a，方案 6.4）：中心每次启动时把已有员工的数据整理成新口径，幂等、可重复运行。
 *
 * 为什么要整理：员工状态合并后，主人只看到在岗、停用、归档三种，新员工直接写「在岗」（active）；
 * 但旧存档里还有「试岗」「草稿」，已退役的员工没有归档时间，执行类员工的自主节奏也各不相同。
 * 这里只改档案字段，不删任何记录，不发线程消息，不清队列，不排任何唤醒，不改 activity
 * （正在跑回合的员工由回合事件收尾）；每改一位写一条审计，审计里有原值，必要时可手工恢复。
 *
 * 逐位处理，顺序固定：
 * 1. probation -> active，试岗截止清空；自主等级 L3 封顶为 L2（与原来的转正规则一致）；
 * 2. draft -> active，补建家目录（失败只记日志）；不排试跑；
 * 3. paused 且 pausedFrom 为 probation -> pausedFrom 改 active，试岗截止清空；
 * 4. retired 且没有归档时间 -> 归档时间取 updatedAt；
 * 5. 执行类（角色不是总管、值守）且未归档 -> 统一为听吩咐：onDemand true、autonomy L1、pace quiet。
 * 6.（P73r1）已归档的员工仍在未归档项目的成员名单里 -> 移出；是项目负责人的不自动处理，写一条告警。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/index.js';
import { createBotHome } from '../memory/files.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { archiveStaff, archivedOwnerText, isExecutionRole } from '../api/bots.js';
import { closeAlert, raiseAlert } from '../health/alerts.js';

/** 「已归档的负责人」告警的代码前缀；后接项目 id，保证每个项目各一条、互不合并。 */
export const ARCHIVED_OWNER_ALERT_PREFIX = 'project_owner_archived:';

/** 审计里记录的整理前后快照：只含本次可能被改动的字段。 */
function snapshot(bot: Bot): Record<string, unknown> {
  return { lifecycle: bot.lifecycle, autonomy: bot.autonomy, onDemand: bot.onDemand, pace: bot.pace,
    archivedAt: bot.archivedAt ?? null, pausedFrom: bot.pausedFrom ?? null, probationEndsAt: bot.probationEndsAt };
}

/** 计算一位员工需要改的字段；没有要改的返回 null（这是幂等的关键）。 */
function planPatch(bot: Bot): Partial<Bot> | null {
  const patch: Partial<Bot> = {};
  // 1. 试岗转在岗。
  if (bot.lifecycle === 'probation') {
    patch.lifecycle = 'active';
    patch.probationEndsAt = null;
    if (bot.autonomy === 'L3') patch.autonomy = 'L2';
  }
  // 2. 草稿转在岗（家目录由调用方补建）。
  if (bot.lifecycle === 'draft') patch.lifecycle = 'active';
  // 3. 暂停前的资格不再有试岗。
  if (bot.lifecycle === 'paused' && bot.pausedFrom === 'probation') {
    patch.pausedFrom = 'active';
    patch.probationEndsAt = null;
  }
  // 4. 已退役补归档时间。
  if (bot.lifecycle === 'retired' && bot.archivedAt == null) patch.archivedAt = bot.updatedAt;
  // 5. 执行类统一为听吩咐；总管、值守类、已归档的不动。
  const archived = bot.lifecycle === 'retired' || bot.archivedAt != null;
  if (!archived && isExecutionRole(bot.role) && (bot.onDemand !== true || (patch.autonomy ?? bot.autonomy) !== 'L1' || bot.pace !== 'quiet')) {
    patch.onDemand = true;
    patch.autonomy = 'L1';
    patch.pace = 'quiet';
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * P73r1（R1.3、R2.3）：已归档的员工不应留在未归档项目的成员名单里。
 * - 只是成员：移出，并在这次整理的审计里写明移出了哪些项目；
 * - 是项目负责人：不自动改负责人，为这个项目写一条给主人的告警（同一项目只告警一次）。
 * 已处于半改状态的数据（已归档、仍在成员名单里）由这一步在下次启动时修复。
 * 返回有改动的员工 id，供调用方合并计数。
 */
function cleanArchivedMembers(ctx: HubContext): Set<string> {
  const touched = new Set<string>();
  const now = ctx.clock.now();
  // 主人已经换了负责人（或项目已归档）的项目，把之前的告警关掉，免得一直挂着。
  for (const alert of ctx.store.table('alerts').list(row => row.status === 'open' && row.code.startsWith(ARCHIVED_OWNER_ALERT_PREFIX))) {
    const project = ctx.store.table('projects').get(alert.code.slice(ARCHIVED_OWNER_ALERT_PREFIX.length));
    const owner = project?.ownerBotId == null ? null : ctx.store.table('bots').get(project.ownerBotId);
    const stillArchived = project !== null && project.archivedAt === null && owner !== null && (owner.lifecycle === 'retired' || owner.archivedAt != null);
    if (!stillArchived) closeAlert(ctx, alert.code, null);
  }
  for (const bot of ctx.store.table('bots').list(row => row.lifecycle === 'retired' || row.archivedAt != null)) {
    const removed: { id: string; name: string }[] = [];
    for (const project of ctx.store.table('projects').list(row => row.archivedAt === null && row.memberBotIds.includes(bot.id))) {
      if (project.ownerBotId === bot.id) {
        // 同一项目不重复告警：每个项目一个固定的告警代码，已有开放告警就不再写。
        const code = `${ARCHIVED_OWNER_ALERT_PREFIX}${project.id}`;
        if (ctx.store.table('alerts').count(alert => alert.code === code && alert.status === 'open') === 0)
          raiseAlert(ctx, { code, botId: null, level: 'P1', immediate: true, at: now, text: archivedOwnerText(project.name, bot.name) });
        continue;
      }
      ctx.store.table('projects').put({ ...project, memberBotIds: project.memberBotIds.filter(id => id !== bot.id), updatedAt: now });
      removed.push({ id: project.id, name: project.name });
    }
    if (removed.length === 0) continue;
    writeOutreachAudit(ctx, 'staff_status_normalize', { botId: bot.id, name: bot.name, removedFromProjects: removed }, 'hub');
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    touched.add(bot.id);
  }
  return touched;
}

/** 整理全部员工；返回被改动的员工数。已整理过的数据再跑一次返回 0。 */
export async function normalizeStaffStatus(ctx: HubContext): Promise<{ changed: number }> {
  let changed = 0;
  const patched = new Set<string>();
  // 防御（P73r2 N2）：「归档时间有值但状态不是已退役」的脏数据（旧入口曾把在岗员工只标成归档）。
  // 按已归档处理，走完整归档流程把状态补成已退役；不满足归档条件的（总管、项目负责人、有在办事务）
  // 清掉错误的归档时间，保持原状态（在岗），并写审计。
  for (const bot of ctx.store.table('bots').list(row => row.archivedAt != null && row.lifecycle !== 'retired')) {
    ctx.store.table('bots').patch(bot.id, { archivedAt: null });
    let outcome: Record<string, unknown>;
    try {
      await archiveStaff(ctx, bot.id);
      outcome = { archived: true };
    } catch (error) {
      ctx.store.table('bots').patch(bot.id, { archivedAt: null });
      outcome = { archived: false, clearedArchivedAt: true, reason: error instanceof Error ? error.message : String(error) };
    }
    writeOutreachAudit(ctx, 'staff_status_normalize', { botId: bot.id, name: bot.name, repair: 'archivedAt_without_retired', ...outcome }, 'hub');
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    patched.add(bot.id);
    changed += 1;
  }
  for (const bot of ctx.store.table('bots').list()) {
    const patch = planPatch(bot);
    if (patch === null) continue;
    patched.add(bot.id);
    const now = ctx.clock.now();
    const row = ctx.store.table('bots').patch(bot.id, { ...patch, updatedAt: now });
    if (bot.lifecycle === 'draft') {
      try { await createBotHome(ctx, row); } catch (error) { ctx.logger.warn('草稿员工家目录补建失败', { botId: bot.id, error: String(error) }); }
    }
    writeOutreachAudit(ctx, 'staff_status_normalize', { botId: bot.id, name: bot.name, before: snapshot(bot), after: snapshot(row) }, 'hub');
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    changed += 1;
  }
  // 最后一步：已归档员工移出项目成员名单（负责人只告警）。已经因档案改动计过数的员工不重复计。
  for (const id of cleanArchivedMembers(ctx)) if (!patched.has(id)) changed += 1;
  return { changed };
}
