/**
 * 项目容器视图（主人视角，v2 计划 3.4/3.5 投影纪律；主人取消编制后改为按队友）：
 * 把项目、任务、队友名字与产物计数拼成界面可直接渲染的结构。
 *
 * 为什么视图层只做组装：规则口径全部在 project/ 纯函数与服务层，这里只负责
 * 「项目列表 + 负责人/成员展开 + 验收项 + 任务展开 + 关联唤醒链接 + 问题 + 计数」，不写审计、不改状态。
 * 旧存档没有 projects/projectTasks 两表（文件缺失）时，存储层自然给空表，视图返回空列表不报错。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { ArtifactReview, ArtifactVersion } from '../model/artifact.js';
import { ARTIFACT_VERDICT_LABELS } from '../model/artifact.js';
import { VARIANT_LABELS, WAKE_KIND_LABELS, WAKE_STATUS_LABELS } from '../model/enums.js';
import type { ProjectTask } from '../model/project.js';
import {
  CRITERION_STATUS_LABELS, PROJECT_CONTEXT_SOURCE_LABELS, PROJECT_STATUS_LABELS, TASK_STATUS_LABELS,
  emptyProjectContext,
} from '../model/project.js';
import type { WakeLedgerEntry } from '../model/wake-ledger.js';
import { evaluateAcceptance } from '../project/acceptance.js';
import { resolveArtifactRef } from '../project/artifacts.js';
import { describeContextChange, isProjectContextEmpty, projectContextPath } from '../project/context.js';
import {
  collectProjectIssues, sortProjectsForView, sortTasksForView, summarizeProject,
} from '../project/project-summary.js';
import { shortTime } from './common.js';
import type {
  ProjectContextProposalView, ProjectContextRevisionView, ProjectCriterionView, ProjectMemberView,
  ProjectTaskArtifactView, ProjectTaskView, ProjectTaskWakeView, ProjectView, ProjectViewRow,
} from './types.js';

/** 展开一个成员队友；队友档案查不到时 name 为 null、invalid 为 true，问题里另有具体说明。 */
function memberView(botId: string, bots: Map<string, Bot>): ProjectMemberView {
  const bot = bots.get(botId) ?? null;
  return {
    botId,
    name: bot?.name ?? null,
    invalid: bot === null || bot.lifecycle === 'retired',
  };
}

/**
 * 展开一条任务关联唤醒：账本在时给出可下钻的链接（机器人 + 时间 + 标签），
 * 账本查不到时只保留唤醒 id 并全部给 null，界面照实显示「查不到」，不编造时间与结果。
 */
function wakeView(
  ctx: HubContext, wakeId: string, ledger: WakeLedgerEntry | undefined, bots: Map<string, Bot>,
): ProjectTaskWakeView {
  if (!ledger) {
    return {
      wakeId, botId: null, botName: null, ledgerId: null,
      variantLabel: null, statusLabel: null, triggerLabel: null, summary: null,
      openedAt: null, openedText: null,
    };
  }
  return {
    wakeId,
    botId: ledger.botId,
    botName: bots.get(ledger.botId)?.name ?? null,
    ledgerId: ledger.id,
    variantLabel: VARIANT_LABELS[ledger.variant],
    statusLabel: WAKE_STATUS_LABELS[ledger.status],
    triggerLabel: WAKE_KIND_LABELS[ledger.trigger.kind],
    // 优先给主人看的理由；没有时退回给机器人看的摘要，和账本列表同一口径。
    summary: ledger.trigger.ownerSummary ?? ledger.trigger.summary,
    openedAt: ledger.openedAt,
    openedText: shortTime(ctx, ledger.openedAt),
  };
}

/**
 * 展开一条任务：状态中文标签、指派队友名字与失效标记、
 * 关联产物展开（头 id 自动跟随最新版；多头/多版本按解析后的版本去重）、验收提醒、关联唤醒链接。
 */
function taskView(
  ctx: HubContext, task: ProjectTask,
  artifactVersions: readonly ArtifactVersion[], latestReviews: Map<string, ArtifactReview>,
  ledgersByWake: Map<string, WakeLedgerEntry>, bots: Map<string, Bot>,
): ProjectTaskView {
  const assigneeBotId = task.assigneeBotId;
  const assignee = assigneeBotId ? bots.get(assigneeBotId) ?? null : null;
  // 每份产物当前的最大版本号：视图据此标出「这一版是不是最新」。
  const latestNumber = new Map<string, number>();
  for (const version of artifactVersions) {
    latestNumber.set(version.artifactId, Math.max(latestNumber.get(version.artifactId) ?? 0, version.number));
  }
  const seen = new Set<string>();
  const artifacts: ProjectTaskArtifactView[] = [];
  for (const ref of [...new Set(task.artifactIds)]) {
    const version = resolveArtifactRef(artifactVersions, ref);
    if (version === null || seen.has(version.id)) continue;
    seen.add(version.id);
    const review = latestReviews.get(version.id) ?? null;
    artifacts.push({
      versionId: version.id,
      artifactId: version.artifactId,
      number: version.number,
      title: version.title,
      bytes: version.bytes,
      createdAt: version.createdAt,
      createdText: shortTime(ctx, version.createdAt),
      sha256: version.sha256,
      reviewVerdict: review?.verdict ?? null,
      reviewLabel: review ? ARTIFACT_VERDICT_LABELS[review.verdict] : null,
      isLatest: version.number === latestNumber.get(version.artifactId),
    });
  }
  return {
    task,
    statusLabel: TASK_STATUS_LABELS[task.status],
    assigneeBotId,
    assigneeBotName: assignee?.name ?? null,
    assigneeInvalid: assigneeBotId !== null && (assignee === null || assignee.lifecycle === 'retired'),
    // 只数现存且去重后的展开产物：引用查不到时不假装还在，界面也就不会给出点不开的链接。
    artifactCount: artifacts.length,
    artifacts,
    // 验收提醒只对「待验收」给内容，其余状态为空数组。
    acceptance: evaluateAcceptance({ status: task.status, updatedAt: task.updatedAt, artifacts }),
    // wakeIds 由派活卡（F12）追加；去重后按记录顺序给链接，查不到账本也保留位置。
    wakes: [...new Set(task.wakeIds)].map(wakeId => wakeView(ctx, wakeId, ledgersByWake.get(wakeId), bots)),
  };
}

/**
 * 展开共享上下文的修改留痕：最新在前，编辑者翻译成人话（队友查不到时只说「已删除的队友」）。
 * 内部 id 仍留在 revision 里供悬停排障，但不出现在编辑者名字里。
 */
function contextRevisionViews(
  ctx: HubContext, project: ProjectViewRow['project'], bots: Map<string, Bot>,
): ProjectContextRevisionView[] {
  return [...(project.contextRevisions ?? [])]
    .sort((a, b) => b.at - a.at)
    .map(revision => ({
      revision,
      editorName: revision.editorKind === 'owner' ? '主人' : (bots.get(revision.editorId)?.name ?? '已删除的队友'),
      editorKindLabel: revision.editorKind === 'owner' ? '主人' : '队友',
      sourceLabel: PROJECT_CONTEXT_SOURCE_LABELS[revision.source],
      timeText: shortTime(ctx, revision.at),
      hashShort: revision.hash.slice(0, 8),
    }));
}

/** 展开待审建议：只返回 pending，最新在前；摘要按「当前上下文 → 建议内容」算。 */
function contextProposalViews(
  ctx: HubContext, project: ProjectViewRow['project'], bots: Map<string, Bot>,
): ProjectContextProposalView[] {
  return ctx.store.table('projectContextProposals')
    .list(proposal => proposal.projectId === project.id && proposal.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(proposal => {
      const bot = bots.get(proposal.botId) ?? null;
      return {
        proposal,
        botName: bot?.name ?? null,
        botInvalid: bot === null || bot.lifecycle === 'retired',
        createdText: shortTime(ctx, proposal.createdAt),
        summary: describeContextChange(project.context ?? emptyProjectContext(), proposal.context),
      };
    });
}

/** 读取当前中心项目全貌：非归档在前、归档沉底；任务按状态分组再按创建时间排。 */
export function projectView(ctx: HubContext): ProjectView {
  const projects = ctx.store.table('projects').list();
  const tasks = ctx.store.table('projectTasks').list();
  const bots = new Map(ctx.store.table('bots').list().map(b => [b.id, b]));
  const botList = [...bots.values()];
  // 产物版本与最近验收结论各读一次：任务行按引用解析，不逐条回表。
  const artifactVersions = ctx.store.table('artifactVersions').list();
  const latestReviews = new Map<string, ArtifactReview>();
  for (const review of ctx.store.table('artifactReviews').list()) {
    const prev = latestReviews.get(review.versionId);
    // 同一版本可能有多条结论：按时间取最新，时间相同则后写入的胜出（list 是追加顺序）。
    if (!prev || review.createdAt >= prev.createdAt) latestReviews.set(review.versionId, review);
  }
  // 只把任务真正引用到的账本读进来（按 wakeId 反查）；没被任务引用的账本不参与这次组装。
  const wantedWakeIds = new Set(tasks.flatMap(task => task.wakeIds));
  const ledgersByWake = new Map<string, WakeLedgerEntry>();
  if (wantedWakeIds.size > 0) {
    for (const entry of ctx.store.table('wakeLedger').list(row => wantedWakeIds.has(row.wakeId))) {
      ledgersByWake.set(entry.wakeId, entry);
    }
  }

  const rows: ProjectViewRow[] = sortProjectsForView(projects).map(project => {
    const summary = summarizeProject(project, tasks, botList);
    const projectTasks = sortTasksForView(tasks.filter(task => task.projectId === project.id));
    const owner = project.ownerBotId ? bots.get(project.ownerBotId) ?? null : null;
    const context = project.context ?? emptyProjectContext();
    const criteria: ProjectCriterionView[] = project.acceptanceCriteria.map(criterion => ({
      id: criterion.id, text: criterion.text, verify: criterion.verify,
      status: criterion.status, statusLabel: CRITERION_STATUS_LABELS[criterion.status],
    }));
    return {
      project,
      statusLabel: PROJECT_STATUS_LABELS[project.status],
      ownerBotId: project.ownerBotId,
      // 失效队友名字给 null 并用 ownerInvalid 标记，界面不猜名字。
      ownerName: owner?.name ?? null,
      ownerInvalid: summary.ownerInvalid,
      members: project.memberBotIds.map(botId => memberView(botId, bots)),
      criteria,
      tasks: projectTasks.map(task => taskView(
        ctx, task, artifactVersions, latestReviews, ledgersByWake, bots,
      )),
      taskCounts: summary.taskCounts,
      progress: summary.progress,
      issues: collectProjectIssues(project, tasks, botList),
      // P34 两层只读投影：原始版本是宿主原生工作区那一半（只读、不改原生会话/设置），
      // 队友项目版本是插件管的这一半（愿景、约定、成员、共享目录、验收）。
      layers: {
        original: { readOnly: true, workspaceDir: project.sharedDir },
        team: {
          readOnly: false,
          // 旧项目没有这两个字段时按空值兼容，界面显示「还没写」而不是编造内容。
          vision: project.vision ?? '',
          conventions: project.conventions ?? '',
          memberCount: project.memberBotIds.length,
          sharedDir: project.sharedDir,
          criterionCount: project.acceptanceCriteria.length,
        },
      },
      // P39 共享上下文：正文按原样给出，空态由界面整块隐藏；留痕与待审建议都翻译成人话。
      context,
      contextEmpty: isProjectContextEmpty(context),
      contextFilePath: projectContextPath(project),
      contextRevisions: contextRevisionViews(ctx, project, bots),
      contextProposals: contextProposalViews(ctx, project, bots),
    };
  });

  const counts = {
    active: projects.filter(p => p.status === 'active').length,
    paused: projects.filter(p => p.status === 'paused').length,
    done: projects.filter(p => p.status === 'done').length,
    archived: projects.filter(p => p.status === 'archived').length,
    total: projects.length,
    tasksTotal: tasks.length,
    tasksPendingCheck: tasks.filter(t => t.status === 'done_pending_check').length,
  };
  return { asOf: ctx.clock.now(), projects: rows, counts };
}
