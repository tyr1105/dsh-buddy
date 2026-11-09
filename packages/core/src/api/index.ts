/** 界面唯一入口：所有主人命令统一校验、审计并通知引擎调度和刷盘，宿主不用操作内部模块。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { nonempty } from '../model/primitives.js';
import { resolveSettings } from '../config/defaults.js';
import { answerInbox as answerItem } from '../outreach/inbox.js';
import { decideApproval as decide } from '../gate/approvals.js';
import { markRead, sendOwnerMessage } from '../outreach/thread.js';
import { upsertRule as saveRule } from '../memory/rules.js';
import { refreshBotFiles } from '../memory/files.js';
import { syncFileWatches } from '../perception/files.js';
import { editRoutine as saveRoutine, RoutineInputSchema } from '../routines/save.js';
import { enqueueTeach } from '../routines/teach.js';
import { archiveBot, archiveBotCheck, createBot, deleteArchivedBot, lifecycleAction, restoreArchivedBot, setLifecycle, updateBot } from './bots.js';
import { closeGoal, decideWatchProposal, upsertAspiration, upsertGoal, upsertWatch } from './entities.js';
import { commandRunner, input, requireBot } from './common.js';
import { RuleInputSchema } from './schemas.js';
import { overview } from './summary-views.js';
import { botView } from './bot-view.js';
import { activityView, inboxView, recentSessions, settingsView, threadView } from './feed-views.js';
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
import { KnowledgeBaseConfigSchema, knowledgeHost } from '../model/knowledge-base.js';
import { checkKnowledgeConnection } from '../knowledge/index.js';
import type { UiApi } from './types.js';
export type * from './types.js';
export type { CostView, CostTotals, CostBotRow, DailyCostView } from './cost-views.js';
export { LIFECYCLE_TRANSITIONS, LifecycleActionSchema } from './bots.js';
export type { LifecycleAction } from './bots.js';
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
    overview: () => overview(ctx), bot: botId => botView(ctx, botId), thread: (threadId, page) => threadView(ctx, threadId, page),
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
    sendMessage: (threadId, text) => run('sendMessage', () => sendOwnerMessage(ctx, threadId, text)),
    answerInbox: (id, answer) => run('answerInbox', () => answerItem(ctx, id, answer)),
    decideApproval: (id, approve, note) => run('decideApproval', () => decide(ctx, id, approve, note)),
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
    upsertRule: raw => run('upsertRule', () => saveRule(ctx, { ...input(RuleInputSchema, raw, '规矩'), source: 'owner' })),
    editRoutine: (id, patch) => run('editRoutine', () => saveRoutine(ctx, input(nonempty, id, 'id'), input(RoutineInputSchema.partial(), patch, '套路修改'))),
    teach: (botId, sessionId, note) => run('teach', () => enqueueTeach(ctx, botId, sessionId, note)),
    pokeBot: (botId, text) => run('pokeBot', () => sendOwnerMessage(ctx, requireBot(ctx, botId).id,
      input(nonempty.trim().min(1, '消息不能为空'), text ?? '请看看当前情况，告诉我进展。', 'text'))),
    updateSettings: patch => run('updateSettings', async () => {
      const raw = input(z.record(z.string(), z.unknown()), patch, '设置修改');
      const next = resolveSettings(mergeSettings(ctx.settings, raw));
      if (next.rootDir !== ctx.settings.rootDir) throw new Error('rootDir：运行期间不能迁移中心目录，请停止后通过宿主配置迁移');
      if (next.maxBots < ctx.store.table('bots').count(row => row.lifecycle !== 'retired')) throw new Error('maxBots：不能小于现有机器人数量');
      if (next.maxChiefs < ctx.store.table('bots').count(row => row.role === 'chief' && row.lifecycle !== 'retired')) throw new Error('maxChiefs：不能小于现有总管数量');
      if (Object.hasOwn(raw, 'defaultModel')) await validateModelChoice(ctx, next.defaultModel);
      ctx.settings = next;
      ctx.store.table('settings').put(next);
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
  };
}
