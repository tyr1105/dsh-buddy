/** 界面唯一入口：所有主人命令统一校验、审计并通知引擎调度和刷盘，宿主不用操作内部模块。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { nonempty } from '../model/primitives.js';
import { resolveSettings } from '../config/defaults.js';
import { answerInbox as answerItem } from '../outreach/inbox.js';
import { decideApproval as decide } from '../gate/approvals.js';
import { startApprovedRunFor } from '../gate/outbox.js';
import { markRead, sendOwnerMessage } from '../outreach/thread.js';
import { confirmAgreementCommand } from '../project/agreement-confirm.js';
import { acceptJobCommand } from '../job/accept.js';
import { readJobEvidence } from '../job/evidence-read.js';
import { jobPreviewTarget } from '../job/preview.js';
import { jobEvidenceOpenTarget, readJobEvidenceText } from '../job/evidence-open.js';
import { answerJobCapCommand, answerJobStallCommand } from '../job/blocked-answer.js';
import { chooseJobOptionCommand } from '../job/choose-option.js';
import { flushJobHooks } from '../job/agreement-hooks.js';
import { answerTeamQuestion, settleTeamSetup } from '../team/setup.js';
import { setupAskingFor, TEAM_SETUP_POKE_TEXT } from '../team/setup-hold.js';
import { confirmTeamProposalCommand, editTeamCandidate } from '../team/proposals.js';
import { upsertRule as saveRule } from '../memory/rules.js';
import { refreshBotFiles } from '../memory/files.js';
import { legacyRulesInEffect } from '../memory/memory-read.js';
import { upsertRuleAsMemory } from '../memory/rule-edit.js';
import { correctMemoryCommand, deleteMemoryCommand, undoCorrectMemoryCommand, undoDeleteMemoryCommand, undoMemoryCommand } from '../memory/undo.js';
import { memoryPageView } from './memory-page-views.js';
import { ChooseLearnSessionInputSchema, RestoreSkillInputSchema, RollbackSkillInputSchema, skillDetailView, skillLibraryView } from './skill-views.js';
import { chooseLearnSession } from '../skill/learn.js';
import { rollbackSkill, setSkillState } from '../skill/store.js';
import { syncFileWatches } from '../perception/files.js';
import { recomputeLightAndSave } from '../quota/window.js';
import { archiveBot, archiveBotCheck, createBot, deleteArchivedBot, lifecycleAction, restoreArchivedBot, setLifecycle, updateBot } from './bots.js';
import { closeGoal, decideWatchProposal, upsertAspiration, upsertGoal, upsertWatch } from './entities.js';
import { commandRunner, input, requireBot } from './common.js';
import { RuleInputSchema } from './schemas.js';
import { overview } from './summary-views.js';
import { botView } from './bot-view.js';
import { activityView, inboxView, recentSessions, settingsView } from './feed-views.js';
import { threadViewWithAway } from './thread-away.js';
import { activeJobsView } from './active-jobs-views.js';
import { weeklyUsageView } from './usage-views.js';
import { dismissAwaySummary, ownerSeen } from '../outreach/presence.js';
import { wakeLedgerDetail, wakeLedgerList } from './ledger-views.js';
import { resourceView } from './resource-views.js';
import { projectView } from './project-views.js';
import { officeView } from '../office/service.js';
import { officeReplay } from '../office/replay.js';
import { archiveResource, revokeGrant, saveResource, setGrant } from '../org/resource-service.js';
import {
  acceptTask, archiveProject, completeProject, pauseProject, rejectTask, reportDone,
  restoreProject, resumeProject, saveProject, saveTask, taskBlock, taskResume,
} from '../project/service.js';
import { assignTask } from '../project/assign.js';
import { attachTaskArtifact } from '../project/artifacts.js';
import {
  approveProjectContextProposal, rejectProjectContextProposal, saveProjectContext,
} from '../project/context-service.js';
import { ensureProjectSharedDir } from '../project/shared-dir.js';
import { dispatchTask } from '../project/dispatch.js';
import { createProjectTopic } from '../project/topics.js';
import { openProjectConversation } from '../project/conversation.js';
import { KnowledgeBaseConfigSchema, knowledgeHost } from '../model/knowledge-base.js';
import { checkKnowledgeConnection } from '../knowledge/index.js';
import type { UiApi } from './types.js';
export type * from './types.js';
export type { CostView, CostTotals, CostBotRow, DailyCostView } from './cost-views.js';
// P76d：本窗口额度的视图结构与函数（插件在 P76j 使用）。
export { QuotaWindowViewSchema, buildQuotaWindowView, quotaWindowView, tokensPerTurnOf } from './quota-views.js';
export type { QuotaWindowView, QuotaViewInput } from './quota-views.js';
export { LIFECYCLE_TRANSITIONS, LifecycleActionSchema } from './bots.js';
export type { LifecycleAction } from './bots.js';
// P73c：三问与组队卡的视图函数和 schema（插件的示例数据、一致性测试使用）。
export { teamCardView, teamCardViewFor, teamQuestionView, teamQuestionViewFor, TeamCardViewSchema, TeamQuestionViewSchema } from './team-views.js';
export type { TeamCardViewInput } from './team-views.js';
// P74a：「一件事」的三个视图及其 zod 结构（插件的一致性测试用）。
export { JobProgressViewSchema, TopicFloorsViewSchema, ProjectJobRowSchema } from './job-view-schemas.js';
// P74e：约定卡上执行中改约定的两栏。
export { JobSplitViewSchema } from './job-view-schemas.js';
// P74d：交回卡、核对卡的视图结构与纯函数（插件的示例数据、一致性测试使用）。
export { EvidenceItemViewSchema, EvidenceViewSchema, JobCardViewSchema, ReviewCardViewSchema, SubmissionCardViewSchema, DeliveryCardViewSchema, ReceiptCardViewSchema } from './job-view-schemas.js';
export type { EvidenceImage } from '../job/evidence-read.js';
export type { PreviewTarget } from '../job/preview.js';
// P74g：审批卡的三行说明与「由谁执行」的结构与纯函数（插件的示例数据、一致性测试使用）。
export { ARGS_FULL_MAX_CHARS, ApprovalCardPartsSchema, ApprovalNotesViewSchema, approvalNotesView, isLaunchApproval, onBehalfOfText } from './approval-card-view.js';
// P74f：交付卡、回执的纯函数（插件的示例数据使用）。
export { buildDeliveryCard, buildReceiptCard, deliveryCardTitle } from './job-delivery-views.js';
export type { DeliveryCardInput } from './job-delivery-views.js';
// P74f-2：三轮不过卡的纯函数与结构（插件的示例数据使用）。
export { EscalationCardViewSchema } from './job-view-schemas.js';
export { buildEscalationCard } from './job-escalation-views.js';
export type { EscalationCardInput } from './job-escalation-views.js';
export { buildReviewCard, buildSubmissionCard, cardTitleFor, jobCardView, reviewCardTitle, submissionCardTitle, REVIEW_CARD_FOOTER } from './job-card-views.js';
export type { ReviewCardInput, SubmissionCardInput } from './job-card-views.js';
export { jobProgressView, topicFloorsView, chiefJobLine, projectJobRows } from './job-views.js';
// P76i：在办的事、用量表、离开期间摘要的视图结构与函数（插件在 P76j、P76k 使用）。
export { ActiveJobRowSchema, ActiveJobsViewSchema, activeJobsView } from './active-jobs-views.js';
export type { ActiveJobRow, ActiveJobsView } from './active-jobs-views.js';
export { WeeklyUsageViewSchema, weeklyUsageView } from './usage-views.js';
export type { WeeklyUsageView } from './usage-views.js';
export { buildAwaySummary } from './away-views.js';
export type { AwayInput, AwayJobInput, AwaySummary } from './away-views.js';
export { threadViewWithAway } from './thread-away.js';
export type { JobProgressInput, TopicFloorsInput } from './job-views.js';
// P75c：「已记住」一行的视图结构（插件的示例数据、一致性测试使用）。
export { MemoryNoteViewSchema } from './memory-views.js';
export type { MemoryNoteView } from './memory-views.js';
// P75d：记忆页视图的纯函数、读存储版和 schema（插件的示例数据、一致性测试使用）。
export { MemoryPageViewSchema, MemoryEntryViewSchema, buildMemoryPage, memoryPageView } from './memory-page-views.js';
export type { MemoryPageView, MemoryEntryView, MemoryPageInput } from './memory-page-views.js';
export { HUB_EVENT_SCOPES } from './event-scopes.js';
export type { HubEventScope } from './event-scopes.js';
export type { HubModelOption, ListModels } from './models.js';
import { HUB_EVENT_SCOPES } from './event-scopes.js';
import { validateModelChoice } from './models.js';
import { interruptBot } from './interrupt.js';
import { ReadArtifactInputSchema, reviewArtifact } from '../artifacts/views.js';
import { readArtifactVersion } from '../artifacts/access.js';

/** 设置递归覆盖保留现有的其他细项；最终仍经过完整 SettingsSchema 校验。 */
function mergeSettings(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null) throw new Error('设置修改必须是普通对象');
  const result: Record<string, unknown> = base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base as Record<string, unknown> } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`设置字段 ${key} 不允许使用`);
    result[key] = mergeSettings(result[key], value);
  }
  return result;
}
/** 组装全部视图与命令；afterCommand 由 Hub 注入，确保每条命令都进入同一调度和持久化出口。 */
export function createUiApi(ctx: HubContext, afterCommand: () => Promise<void>): UiApi {
  const run = commandRunner(ctx, afterCommand);
  return {
    // 查看只校验和返回正文，不触发 afterCommand 的调度或刷盘。
    readArtifactVersion: async raw => {
      try {
        const args = input(ReadArtifactInputSchema, raw, '产物查看');
        return { ok: true, data: await readArtifactVersion(ctx, args.versionId, { kind: 'owner' }) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '产物读取失败' };
      }
    },
    reviewArtifact: raw => run('reviewArtifact', () => reviewArtifact(ctx, raw)),
    // P74g：读证据截图、打开预览前的校验都是只读，不进入命令串行与调度后处理；两个函数自己不抛出，问题都变成中文错误。
    readJobEvidence: raw => readJobEvidence(ctx, raw),
    jobPreviewTarget: raw => jobPreviewTarget(ctx, raw),
    // W12：卡片上的文件证据交给宿主打开之前的校验（只读，core 不打开任何东西）。
    jobEvidenceOpenTarget: raw => jobEvidenceOpenTarget(ctx, raw),
    readJobEvidenceText: raw => readJobEvidenceText(ctx, raw),
    // P76i：总管私聊的线程视图顶部带离开期间摘要（threadViewWithAway 只在有未收起的摘要时多一个字段）。
    overview: () => overview(ctx), bot: botId => botView(ctx, botId), thread: (threadId, page) => threadViewWithAway(ctx, threadId, page),
    inbox: () => inboxView(ctx), activity: page => activityView(ctx, page), settings: () => settingsView(ctx), recentSessions: () => recentSessions(ctx),
    // 账本是只读视图，不进入命令串行与调度后处理。
    wakeLedgerList: (botId, limit, before) => wakeLedgerList(ctx, botId, limit, before),
    wakeLedgerDetail: wakeId => wakeLedgerDetail(ctx, wakeId),
    // 办公室是纯投影，同样只读；界面刷新只重算投影，不写存储。
    officeView: () => officeView(ctx),
    officeReplay: async raw => {
      try { return { ok: true, data: officeReplay(ctx, raw) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '倒带读取失败' }; }
    },
    // 资料视图只读；三条资料命令与其他命令共用统一审计、刷盘出口。
    resourceView: () => resourceView(ctx),
    // 项目视图只读；项目与任务命令与资料命令共用统一审计、刷盘出口。
    projectView: () => projectView(ctx),
    saveResource: raw => run('saveResource', () => saveResource(ctx, raw)),
    archiveResource: id => run('archiveResource', () => archiveResource(ctx, id)),
    setGrant: raw => run('setGrant', () => setGrant(ctx, raw)),
    revokeGrant: raw => run('revokeGrant', () => revokeGrant(ctx, raw)),
    // 保存项目后补建共享目录：服务层保持同步纯逻辑，碰盘放在命令出口；失败返回中文错误。
    saveProject: raw => run('saveProject', async () => {
      const project = saveProject(ctx, raw);
      await ensureProjectSharedDir(ctx, project);
      return project;
    }),
    pauseProject: id => run('pauseProject', () => pauseProject(ctx, id)),
    resumeProject: id => run('resumeProject', () => resumeProject(ctx, id)),
    completeProject: id => run('completeProject', () => completeProject(ctx, id)),
    archiveProject: id => run('archiveProject', () => archiveProject(ctx, id)),
    restoreProject: id => run('restoreProject', () => restoreProject(ctx, id)),
    // P39 共享上下文：保存会落 context.md、追加留痕并写审计，走统一的命令出口。
    saveProjectContext: raw => run('saveProjectContext', () => saveProjectContext(ctx, raw)),
    approveProjectContextProposal: id => run('approveProjectContextProposal', () => approveProjectContextProposal(ctx, id)),
    rejectProjectContextProposal: id => run('rejectProjectContextProposal', () => rejectProjectContextProposal(ctx, id)),
    saveTask: raw => run('saveTask', () => saveTask(ctx, raw)),
    attachTaskArtifact: raw => run('attachTaskArtifact', () => attachTaskArtifact(ctx, raw)),
    assignTask: raw => run('assignTask', () => assignTask(ctx, raw)),
    dispatchTask: raw => run('dispatchTask', () => dispatchTask(ctx, raw)),
    // P63：开主题走统一命令出口；之后的消息沿用 sendMessage，线程 id 就是主题 id。
    // P72c：约定卡上的「定了」按钮。
    // P74e：约定固定后这件事的收尾（重写主题文件、叫醒执行者）是异步的，命令等它做完再返回。
    confirmAgreement: raw => run('confirmAgreement', async () => {
      const result = confirmAgreementCommand(ctx, raw);
      await flushJobHooks(ctx);
      return result;
    }),
    // P74f：交付卡上的「验收通过」按钮，与「待你处理」、打字三条途径落到同一个函数。
    acceptJob: raw => run('acceptJob', async () => {
      const result = acceptJobCommand(ctx, raw);
      await flushJobHooks(ctx);
      return result;
    }),
    // P74f-2：三轮不过卡上选办法、回合上限条目和「停住了」条目的答复；与「待你处理」里的按钮落到同一个函数。
    chooseJobOption: raw => run('chooseJobOption', async () => {
      const result = chooseJobOptionCommand(ctx, raw);
      await flushJobHooks(ctx);
      return result;
    }),
    answerJobCap: raw => run('answerJobCap', async () => {
      const result = answerJobCapCommand(ctx, raw);
      await flushJobHooks(ctx);
      return result;
    }),
    answerJobStall: raw => run('answerJobStall', async () => {
      const result = answerJobStallCommand(ctx, raw);
      await flushJobHooks(ctx);
      return result;
    }),
    createProjectTopic: raw => run('createProjectTopic', () => createProjectTopic(ctx, raw)),
    openProjectConversation: raw => run('openProjectConversation', () => openProjectConversation(ctx, raw)),
    taskBlock: id => run('taskBlock', () => taskBlock(ctx, id)),
    taskResume: id => run('taskResume', () => taskResume(ctx, id)),
    reportDone: id => run('reportDone', () => reportDone(ctx, id)),
    acceptTask: id => run('acceptTask', () => acceptTask(ctx, id)),
    rejectTask: raw => run('rejectTask', () => rejectTask(ctx, raw)),
    createBot: raw => run('createBot', () => createBot(ctx, raw)),
    updateBot: (botId, patch) => run('updateBot', () => updateBot(ctx, botId, patch)),
    lifecycleAction: raw => run('lifecycleAction', () => lifecycleAction(ctx, raw)),
    // P48：归档走「先校验、再写标记」两步，恢复与删除只收 id；历史表一律不动。
    archiveBotCheck: botId => run('archiveBotCheck', () => archiveBotCheck(ctx, botId)),
    archiveBot: botId => run('archiveBot', () => archiveBot(ctx, botId)),
    restoreArchivedBot: botId => run('restoreArchivedBot', () => restoreArchivedBot(ctx, botId)),
    deleteArchivedBot: botId => run('deleteArchivedBot', () => deleteArchivedBot(ctx, botId)),
    interruptBot: raw => run('interruptBot', () => interruptBot(ctx, raw)),
    setLifecycle: (botId, lifecycle) => run('setLifecycle', () => setLifecycle(ctx, botId, lifecycle)),
    // P73c：三问进行中，打字回答里需要异步收尾的部分（建项目、生成组队卡）在这里等做完再返回。
    sendMessage: (threadId, text) => run('sendMessage', async () => {
      const message = sendOwnerMessage(ctx, threadId, text);
      await settleTeamSetup(ctx);
      await flushJobHooks(ctx);
      return message;
    }),
    // P73c：三问点选、组队卡内修改与确认。
    answerTeamQuestion: raw => run('answerTeamQuestion', () => answerTeamQuestion(ctx, raw)),
    editTeamCandidate: raw => run('editTeamCandidate', () => editTeamCandidate(ctx, raw)),
    confirmTeamProposal: raw => run('confirmTeamProposal', () => confirmTeamProposalCommand(ctx, raw)),
    // P79：提议可附一句话（note）；其他条目带了也不起作用。
    answerInbox: (id, answer, note) => run('answerInbox', async () => {
      const item = await answerItem(ctx, id, answer, note);
      await flushJobHooks(ctx);
      // P74r18b：「待你处理」里点「批准」走的是这条路：批准的出站动作立刻开始执行（只开始、不等做完）。
      if (item.type === 'approval') startApprovedRunFor(ctx, item.refId);
      return item;
    }),
    // P74r18b：批准一条由中心代为执行的出站动作之后，立刻开始一次执行（以前要等下一次巡检，最长 60 秒）；
    // 与巡检里的执行不会重入，员工正在复盘、已暂停时照现有规则跳过，留给巡检兜底。只开始、不等做完，主人点「批准」的命令不会卡住。
    decideApproval: (id, approve, note) => run('decideApproval', async () => {
      const approval = await decide(ctx, id, approve, note);
      startApprovedRunFor(ctx, approval.id);
      return approval;
    }),
    upsertAspiration: raw => run('upsertAspiration', () => upsertAspiration(ctx, raw)),
    upsertGoal: raw => run('upsertGoal', () => upsertGoal(ctx, raw)),
    closeGoal: (id, outcome) => run('closeGoal', () => {
      const value = input(z.strictObject({ id: nonempty, outcome: z.union([z.enum(['done', 'active', 'abandoned', 'not_done', 'incorrect', 'mismatch']), z.boolean()]) }), { id, outcome }, '关闭目标');
      return closeGoal(ctx, value.id, typeof value.outcome === 'boolean' ? value.outcome ? 'done' : 'active' : value.outcome);
    }),
    upsertWatch: raw => run('upsertWatch', () => upsertWatch(ctx, raw)),
    decideWatchProposal: (id, approve) => run('decideWatchProposal', () => {
      const value = input(z.strictObject({ id: nonempty, approve: z.boolean() }), { id, approve }, '关注提议决定');
      return decideWatchProposal(ctx, value.id, value.approve);
    }),
    // P75r1：输入带 id、这个 id 是旧规矩表里的一行、并且旧规矩表仍要读（迁移未完成）时，照旧写旧规矩表（改的是那条旧规矩本身）；
    // 其余情况（新建、改记忆、归档记忆）都写记忆（经 memory/service.ts）。
    upsertRule: raw => run('upsertRule', async () => {
      // 先只取出 id 来判断走哪一边（记忆编号 mem_ 不符合旧规矩的输入形状，不能先整体按旧形状校验）。
      const rawId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
      if (typeof rawId === 'string' && legacyRulesInEffect(ctx) && Boolean(ctx.store.table('rules').get(rawId))) {
        return saveRule(ctx, { ...input(RuleInputSchema, raw, '规矩'), source: 'owner' });
      }
      return upsertRuleAsMemory(ctx, raw);
    }),
    // P75c：记忆的四个命令（撤销「已记住」、记忆页更正、删除、撤销删除）。宿主路由由 P75k 接。
    undoMemory: raw => run('undoMemory', () => undoMemoryCommand(ctx, raw)),
    undoCorrectMemory: raw => run('undoCorrectMemory', () => undoCorrectMemoryCommand(ctx, raw)),
    // 记忆页视图是只读，不进入命令串行与调度后处理。
    memoryPage: () => memoryPageView(ctx),
    // P75e：技能库的两个视图只读；回退与放回两个命令走统一出口（宿主路由由 P75j 接，活动流由 P75i 接）。
    skillLibrary: botId => skillLibraryView(ctx, requireBot(ctx, botId).id),
    skillDetail: skillId => skillDetailView(ctx, input(nonempty, skillId, 'skillId')),
    rollbackSkill: raw => run('rollbackSkill', async () => {
      const args = input(RollbackSkillInputSchema, raw, '回退技能');
      await rollbackSkill(ctx, args.skillId, args.versionNo);
      return { skillId: args.skillId, versionNo: args.versionNo };
    }),
    restoreSkill: raw => run('restoreSkill', async () => {
      const args = input(RestoreSkillInputSchema, raw, '放回技能');
      await setSkillState(ctx, args.skillId, 'active');
      return { skillId: args.skillId };
    }),
    // P75i：学习选会话（教它技能）：总管私聊里提问卡上的按钮。与「待你处理」里回答同一条提问结果相同（见 skill/learn.ts）。
    // 不叫醒总管；宿主路由由 P75k 接。
    chooseLearnSession: raw => run('chooseLearnSession', async () => {
      const args = input(ChooseLearnSessionInputSchema, raw, '学习选会话');
      await chooseLearnSession(ctx, { runId: args.runId, option: args.option, via: 'button' });
      return { runId: args.runId };
    }),
    correctMemory: raw => run('correctMemory', () => correctMemoryCommand(ctx, raw)),
    deleteMemory: raw => run('deleteMemory', () => deleteMemoryCommand(ctx, raw)),
    undoDeleteMemory: raw => run('undoDeleteMemory', () => undoDeleteMemoryCommand(ctx, raw)),
    // P75f：editRoutine、teach 两个命令下线（套路并入技能库、教它技能改为对总管说），宿主路由返回停用说明。
    pokeBot: (botId, text) => run('pokeBot', async () => {
      // P73r3 S6：总管正在问三个问题时，「戳一下」不当作回答，直接拒绝。
      if (setupAskingFor(ctx, requireBot(ctx, botId).id) !== null) throw new Error(TEAM_SETUP_POKE_TEXT);
      const message = sendOwnerMessage(ctx, requireBot(ctx, botId).id,
        input(nonempty.trim().min(1, '消息不能为空'), text ?? '请看看当前情况，告诉我进展。', 'text'));
      await settleTeamSetup(ctx);
      return message;
    }),
    updateSettings: patch => run('updateSettings', async () => {
      const raw = input(z.record(z.string(), z.unknown()), patch, '设置修改');
      const next = resolveSettings(mergeSettings(ctx.settings, raw));
      if (next.rootDir !== ctx.settings.rootDir) throw new Error('rootDir：运行期间不能迁移中心目录，请停止后通过宿主配置迁移');
      if (next.maxBots < ctx.store.table('bots').count(row => row.lifecycle !== 'retired')) throw new Error('maxBots：不能小于现有机器人数量');
      if (next.maxChiefs < ctx.store.table('bots').count(row => row.role === 'chief' && row.lifecycle !== 'retired')) throw new Error('maxChiefs：不能小于现有总管数量');
      if (Object.hasOwn(raw, 'defaultModel')) await validateModelChoice(ctx, next.defaultModel);
      // 要在换上新设置之前比较，才知道灯相关的几项有没有变。
      const quotaLightChanged = (['botQuotaShare', 'quotaYellowRatio', 'quotaOrangeRatio', 'quotaRedRatio'] as const)
        .some(key => next[key] !== ctx.settings[key]);
      ctx.settings = next;
      ctx.store.table('settings').put(next);
      // P76r2 第 4 节：员工份额比例或灯的比例变了，存着的灯按新设置重算（红灯变成不红时恢复被额度挡住的员工）；
      // 否则员工份额用完的红灯会被闸门当成真实额度用完，主人自己的消息也被拦到窗口结束。
      if (quotaLightChanged) recomputeLightAndSave(ctx, ctx.clock.now());
      await syncFileWatches(ctx);
      for (const bot of ctx.store.table('bots').list()) await refreshBotFiles(ctx, bot.id);
      ctx.emit(HUB_EVENT_SCOPES.settings);
      ctx.emit(HUB_EVENT_SCOPES.overview);
      for (const bot of ctx.store.table('bots').list()) ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
      return structuredClone(next);
    }),
    // P38：连接草稿只读自检；不落设置、不产生审批，协议适配未接入时如实返回 unsupported。
    testKnowledgeConnection: raw => run('testKnowledgeConnection', async () => {
      const draft = input(z.record(z.string(), z.unknown()), raw, '公共知识库配置');
      const parsed = KnowledgeBaseConfigSchema.safeParse(draft);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(issue => {
          const path = issue.path.join('.') || 'knowledgeBase';
          return `${path}：${issue.message}`;
        });
        return { state: 'invalid' as const, host: null, protocol: null, reason: null, errors };
      }
      const config = parsed.data;
      const result = await checkKnowledgeConnection(ctx, config);
      const host = knowledgeHost(config);
      const protocol = config.protocol.trim() === '' ? null : config.protocol.trim();
      if (result.status === 'unconfigured') {
        return { state: 'unconfigured' as const, host, protocol, reason: null, errors: [] };
      }
      if (result.status === 'unsupported') {
        return { state: 'unsupported' as const, host, protocol,
          reason: `协议「${result.protocol}」暂无适配：等知识库的实际访问方式确认后再补连接能力`, errors: [] };
      }
      if (result.status === 'ok') return { state: 'ok' as const, host, protocol, reason: null, errors: [] };
      return { state: 'failed' as const, host, protocol, reason: result.reason, errors: [] };
    }),
    markThreadRead: threadId => run('markThreadRead', () => markRead(ctx, threadId)),
    // P76i：在办的事与用量表是只读视图；两个离开期间命令走统一出口（宿主路由由 P76k 接）。
    activeJobs: botId => activeJobsView(ctx, requireBot(ctx, botId).id),
    weeklyUsage: () => weeklyUsageView(ctx),
    ownerSeen: () => run('ownerSeen', () => ownerSeen(ctx)),
    dismissAwaySummary: () => run('dismissAwaySummary', () => ({ dismissed: dismissAwaySummary(ctx) })),
  };
}
