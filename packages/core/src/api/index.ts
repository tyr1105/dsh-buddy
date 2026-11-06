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
import { createBot, lifecycleAction, setLifecycle, updateBot } from './bots.js';
import { closeGoal, decideWatchProposal, upsertAspiration, upsertGoal, upsertWatch } from './entities.js';
import { commandRunner, input, requireBot } from './common.js';
import { RuleInputSchema } from './schemas.js';
import { overview } from './summary-views.js';
import { botView } from './bot-view.js';
import { activityView, inboxView, recentSessions, settingsView, threadView } from './feed-views.js';
import type { UiApi } from './types.js';
export type * from './types.js';
export { LIFECYCLE_TRANSITIONS, LifecycleActionSchema } from './bots.js';
export type { LifecycleAction } from './bots.js';
export { HUB_EVENT_SCOPES } from './event-scopes.js';
export type { HubEventScope } from './event-scopes.js';
export type { HubModelOption, ListModels } from './models.js';
import { HUB_EVENT_SCOPES } from './event-scopes.js';
import { validateModelChoice } from './models.js';
import { interruptBot } from './interrupt.js';

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
    overview: () => overview(ctx), bot: botId => botView(ctx, botId), thread: (threadId, page) => threadView(ctx, threadId, page),
    inbox: () => inboxView(ctx), activity: page => activityView(ctx, page), settings: () => settingsView(ctx), recentSessions: () => recentSessions(ctx),
    createBot: raw => run('createBot', () => createBot(ctx, raw)),
    updateBot: (botId, patch) => run('updateBot', () => updateBot(ctx, botId, patch)),
    lifecycleAction: raw => run('lifecycleAction', () => lifecycleAction(ctx, raw)),
    interruptBot: raw => run('interruptBot', () => interruptBot(ctx, raw)),
    setLifecycle: (botId, lifecycle) => run('setLifecycle', () => setLifecycle(ctx, botId, lifecycle)),
    sendMessage: (threadId, text) => run('sendMessage', () => sendOwnerMessage(ctx, threadId, text)),
    answerInbox: (id, answer) => run('answerInbox', () => answerItem(ctx, id, answer)),
    decideApproval: (id, approve, note) => run('decideApproval', () => decide(ctx, id, approve, note)),
    upsertAspiration: raw => run('upsertAspiration', () => upsertAspiration(ctx, raw)),
    upsertGoal: raw => run('upsertGoal', () => upsertGoal(ctx, raw)),
    closeGoal: (id, outcome) => run('closeGoal', () => {
      const value = input(z.strictObject({ id: nonempty, outcome: z.union([z.enum(['done', 'active', 'abandoned']), z.boolean()]) }), { id, outcome }, '关闭目标');
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
    markThreadRead: threadId => run('markThreadRead', () => markRead(ctx, threadId)),
  };
}
