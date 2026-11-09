/** 中心唯一宿主入口：串行组装现有规则模块，统一落盘与界面通知，完全依赖注入的世界。 */
import { HUB_EVENT_SCOPES, type HubEventScope } from '../api/event-scopes.js';
import type { HubContext } from './context.js';
import { createRuntime } from './context.js';
import { parseInput } from './validation.js';
import { timestamp } from '../model/primitives.js';
import type { TurnEvent, ExternalSessionEvent, GuardDecision, Settings } from '../model/index.js';
import { resolveSettings, resolveStartupSettings } from '../config/defaults.js';
import { initRoot, refreshBotFiles } from '../memory/files.js';
import { refreshLightCheck } from '../agenda/next-think.js';
import { detectDowntimeOnStart, catchUpCandidates, raiseAlert, closeAlert } from '../health/index.js';
import { syncFileWatches, flushFileEvents, onExternalSessionEvent as recordSessionEvent } from '../perception/index.js';
import { onTurnEvent as processTurn, findOpenWake } from '../turn/index.js';
import { guardToolCallSync, onHostApprovalRequestSync } from '../gate/guard.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { buildTools, type HubTool, type ToolResult } from '../tools/index.js';
import { createUiApi, type UiApi } from '../api/index.js';
import { createCandidateCollector } from './candidates.js';
import { createDispatcher } from './dispatch.js';
import { runTick } from './tick.js';
import { createEntryWaits } from './entry-waits.js';
import { migrateBotMbti } from '../personality/profile.js';
import { recordToolAction, runLedgerBackfill } from '../ledger/service.js';
import { markOfficeRecordFailure, recordOfficeFrame } from '../office/replay.js';

export type HubDeps = Omit<HubContext, 'settings' | 'runtime' | 'emit'> & { settings?: Partial<Settings> };
export type HubChange = { type: 'changed'; scope: HubEventScope; botId: string | null };
export type RegisteredHubTool = Omit<HubTool, 'handler'> & {
  /** 只接受宿主会话身份；机器人身份和唤醒单由中心解析。 */
  handler(sessionId: string, rawArgs: unknown): Promise<ToolResult>;
};
export interface Hub {
  /** 先恢复存储与文件，再启用事件和调度。 */
  start(): Promise<void>;
  /** 停止监听并保存，不取消宿主正在运行的回合。 */
  stop(): Promise<void>;
  /** 重叠 tick 立即返回；每一步独立记录失败。 */
  tick(): Promise<void>;
  /** Promise 可供仿真等待，宿主也可按 void 事件回调调用。 */
  onTurnEvent(event: TurnEvent): Promise<void>;
  /** 外部会话变化即时评估与排队。 */
  onExternalSessionEvent(event: ExternalSessionEvent): Promise<void>;
  /** 记录主人最近活动，后续放行采用更低并发。 */
  onOwnerActivity(at: number): Promise<void>;
  /** 返回当前绑定机器人；普通会话返回 null。 */
  botIdForSession(sessionId: string): string | null;
  /** 返回可直接注册到宿主的工具定义。 */
  tools(): RegisteredHubTool[];
  /** 同步消费票据和保存审批，异步通知由中心跟踪。 */
  guardToolCall(sessionId: string, tool: string, args: unknown): GuardDecision;
  /** 机器人宿主审批同步拒绝弹框，只告警请主人检查宿主权限。 */
  onHostApprovalRequest(sessionId: string, tool: string, summary: string): 'deny' | 'pass';
  api: UiApi;
  /** 入口完成落盘后同步发送合并通知；一个订阅者失败不影响其他人。 */
  subscribe(fn: (event: HubChange) => void): () => void;
}

/** 构造不启动定时器；tick 的节奏由宿主或假时钟掌管。 */
export function createHub(deps: HubDeps): Hub {
  const subscribers = new Set<(event: HubChange) => void>();
  const changes = new Map<string, HubChange>();
  const effects = new Set<Promise<unknown>>();
  let started = false;
  let ticking: object | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const ctx: HubContext = { ...deps, settings: resolveSettings(deps.settings), runtime: createRuntime(deps.clock.now()),
    /** 同一入口的相同范围只通知一次，避免视图收到大量逐字段刷新。 */
    emit(scope, botId = null) { changes.set(`${scope}:${botId ?? ''}`, { type: 'changed', scope, botId }); } };
  const waits = createEntryWaits(ctx.clock, () => ctx.settings.c02.entryTimeoutMs);
  ctx.host = waits.boundHost(deps.host);
  const collector = createCandidateCollector(ctx);
  const dispatcher = createDispatcher(ctx);

  /** 共享串行通道防止投递期间的 started/工具/ended 事件抢在会话绑定之前执行。 */
  function serial<T>(work: (live: () => boolean) => Promise<T>): Promise<T> {
    const run = async () => {
      const lease = waits.open('串行入口');
      try { return await lease.wait(work(lease.live)); }
      finally { lease.close(); }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  }
  /** 日志器本身异常也不能击穿宿主事件边界。 */
  function report(label: string, error: unknown, botId?: string): void {
    try { ctx.logger.error(`${label}失败`, error); } catch { /* 日志故障不能再触发宿主异常。 */ }
    try { raiseAlert(ctx, { code: `hub:${label}`, botId: botId ?? null, level: 'P2',
      text: `${label}失败：${error instanceof Error ? error.message : String(error)}` }); } catch { /* 存储异常由下一入口继续尝试。 */ }
  }
  /** 每个阶段都提供系统告警和独立失败边界。 */
  async function safe(label: string, work: () => void | Promise<unknown>, botId?: string): Promise<void> {
    try { await work(); closeAlert(ctx, `hub:${label}`, botId ?? null); } catch (error) { report(label, error, botId); }
  }
  /** 跟踪同步钩子已经启动的通知，完成入口前一并等待并保存。 */
  function defer(effect: Promise<unknown>): void {
    const tracked = effect.catch(error => { report('钩子副作用', error); }).finally(() => { effects.delete(tracked); });
    effects.add(tracked);
  }
  /** 落盘失败保留脏状态；观察者即使抛错也不会中断后续观察者。 */
  async function flush(live: () => boolean = () => true, frameMode?: 'start'): Promise<boolean> {
    if (!live()) return false;
    const lease = waits.open('落盘');
    let saved = true;
    const recovering = ctx.store.table('alerts').list(a => a.code === 'hub:存储落盘' && a.botId === null && (a.count > 0 || a.status === 'open'));
    const ids = new Set(recovering.map(a => a.id));
    const cards = ctx.store.table('inbox').list(i => i.type === 'alert' && i.status === 'open' && i.refId !== null && ids.has(i.refId));
    try {
      while (effects.size) await lease.wait(Promise.all([...effects]));
      if (!live()) return false;
      // 恢复标记和业务一起落盘，失败则还原，既不假报恢复也不在成功后遗留新的脏表。
      closeAlert(ctx, 'hub:存储落盘', null);
      for (const card of cards) ctx.store.table('inbox').patch(card.id, { status: 'closed', answer: '已恢复', answeredAt: ctx.clock.now() });
      // 观察失败只影响倒带；当前业务仍然保存，故障时段不能继续沿用旧房间。
      try { recordOfficeFrame(ctx, frameMode ?? (started ? 'observe' : 'stop')); }
      catch (error) {
        markOfficeRecordFailure(ctx);
        try { ctx.logger.error('房间历史记录失败', error); } catch { /* 日志异常不影响业务落盘。 */ }
      }
      await lease.wait(ctx.store.flush());
      if (!live() || !lease.live()) return false;
    } catch (error) {
      saved = false;
      for (const alert of recovering) ctx.store.table('alerts').put(alert);
      for (const card of cards) ctx.store.table('inbox').put(card);
      report('存储落盘', error);
    }
    finally { lease.close(); }
    if (!live()) return false;
    const batch = [...changes.values()];
    changes.clear();
    for (const event of batch) for (const fn of [...subscribers]) {
      try { fn(event); } catch (error) { try { ctx.logger.error('界面订阅者失败', error); } catch { /* 继续通知其他订阅者。 */ } }
    }
    return saved;
  }
  /** 命令与事件成功或失败后都走此出口，保证派生候选、告警和持久化完整。 */
  async function afterEntry(live: () => boolean = () => true): Promise<void> {
    if (!live()) return;
    if (started) {
      await safe('文件关注同步', () => syncFileWatches(ctx));
      if (!live()) return;
      await safe('感知评估', () => { collector.collect(ctx.clock.now()); });
      await safe('调度放行', dispatcher.pump);
    }
    if (!live()) return;
    await safe('告警同步', () => syncAlertItems(ctx));
    if (!live()) return;
    if (!await flush(live)) throw new Error('保存失败，修改仍在内存中等待重试');
  }
  /** 宿主事件承诺永不向外抛错，处理后仍调度与落盘。 */
  function event(label: string, work: () => void | Promise<unknown>): Promise<void> {
    return serial(async live => { await safe(label, work); if (live()) await safe(`${label}后处理`, () => afterEntry(live)); })
      .catch(error => { report(label, error); });
  }
  const rawApi = createUiApi(ctx, afterEntry);
  const viewNames = new Set(['overview', 'bot', 'thread', 'inbox', 'activity', 'settings', 'recentSessions',
    'wakeLedgerList', 'wakeLedgerDetail', 'resourceView', 'projectView', 'officeView', 'officeReplay']);
  // 界面命令的参数校验由 API 承担，串行边界包住整条命令而非仅最后一次 pump。
  const api = Object.fromEntries(Object.entries(rawApi).map(([name, method]) => [name,
    viewNames.has(name) ? method : name === 'interruptBot'
      // 打断必须越过正在等待宿主的串行投递；其保存与后处理仍回到同一串行出口。
      ? (...args: unknown[]) => {
        const interruptApi = createUiApi(ctx, () => serial(live => afterEntry(live)));
        return interruptApi.interruptBot(args[0]);
      } : (...args: unknown[]) => serial(live => {
      // 每次命令绑定本入口的租期，超时后迟到的命令不能再发起调度。
      const scoped = createUiApi(ctx, () => afterEntry(live));
      return (scoped[name as keyof UiApi] as (...a: unknown[]) => Promise<unknown>)(...args);
    }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : '中心入口失败' })),
  ])) as unknown as UiApi;
  const registered: RegisteredHubTool[] = buildTools(ctx).map(tool => ({ ...tool,
    /** 每次调用现场解析 sessionId；过期旧会话不能冒用已轮换的机器人身份。 */
    handler: (sessionId, args) => serial<ToolResult>(async live => {
      let result: ToolResult;
      let wakeId: string | null = null;
      const startedAt = ctx.clock.now();
      try {
        const botId = hub.botIdForSession(sessionId);
        if (!botId) result = { ok: false, error: '只有 Agent 中心的机器人能用这个工具' };
        else {
          wakeId = findOpenWake(ctx, sessionId)?.id ?? null;
          result = await tool.handler(ctx, { botId, sessionId, wakeId }, args);
        }
      } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : '机器人工具执行失败' }; }
      // 工具动作是中心实际观察到的事实；记录失败不能阻断工具结果返回。
      try { recordToolAction(ctx, wakeId, tool.name, result, ctx.clock.now() - startedAt); }
      catch (error) { try { ctx.logger.error('记录唤醒账本动作失败', error); } catch { /* 账本故障不影响工具调用。 */ } }
      try { await afterEntry(live); } catch (error) { return { ok: false, error: `工具已处理，但保存失败：${String(error)}` }; }
      return result;
    }).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : '机器人工具入口失败' })),
  }));
  const hub: Hub = {
    api,
    /** 宿主明确传入的设置优先；重启只恢复业务记录，不复用旧监听器。 */
    start: () => serial(async live => {
      if (started) return;
      try {
        await ctx.store.load();
        // 早期版本把 MBTI 写进过 Bot 本体；启动时迁到独立档案表并剥掉，保证 bots.json 旧版本可读。
        migrateBotMbti(ctx);
        if (!live()) return;
        const persisted = ctx.store.table('settings').get('settings') ?? ctx.store.table('settings').list()[0];
        ctx.settings = resolveStartupSettings(persisted, deps.settings);
        // 旧版本的丢弃决定须先恢复，否则首次健康检查会把旧紧急感知误当漏醒。
        collector.restore(ctx.clock.now());
        if (persisted && persisted.rootDir !== ctx.settings.rootDir) {
          writeOutreachAudit(ctx, 'settings_root_override', { storedRootDir: persisted.rootDir, hostRootDir: ctx.settings.rootDir });
        }
        await initRoot(ctx);
        if (!live()) return;
        // v2 首次启动：备份旧表并回填账本，再调和上次进程留下的未封存行。
        // 失败只告警，不阻止中心启动；下次启动按 wakeId 幂等重试。
        await safe('账本回填与调和', () => runLedgerBackfill(ctx));
        if (!live()) return;
        const downtime = await detectDowntimeOnStart(ctx, ctx.clock.now());
        if (!live()) return;
        for (const bot of ctx.store.table('bots').list(b => ['active', 'probation'].includes(b.lifecycle))) {
          if (!live()) return;
          await safe('机器人文件刷新', async () => {
            if (bot.lightCheckAt === null) ctx.store.table('bots').patch(bot.id,
              refreshLightCheck(bot, ctx.clock.now(), ctx.settings, ctx.store.table('goals').count(g => g.botId === bot.id && g.status === 'active') > 0));
            await refreshBotFiles(ctx, bot.id);
          }, bot.id);
        }
        if (!live()) return;
        await syncFileWatches(ctx);
        if (!live()) return;
        // 离线变化已经在停机期间发生，不再额外等去抖；先形成感知再汇总进补课包。
        await flushFileEvents(ctx, ctx.clock.now(), true);
        if (!live()) return;
        if (downtime) for (const candidate of catchUpCandidates(ctx, downtime, ctx.clock.now())) collector.offer(candidate);
        ctx.runtime.startedAt = ctx.clock.now();
        ctx.runtime.lastTickAt = null;
        started = true;
        writeOutreachAudit(ctx, 'hub_started', { at: ctx.runtime.startedAt });
        ctx.emit(HUB_EVENT_SCOPES.overview);
        ctx.emit(HUB_EVENT_SCOPES.activity);
      } catch (error) { report('中心启动', error); throw error; }
      finally { await flush(live, 'start'); }
    }),
    /** 停止不会取消正在运行的回合；后续 ended 仍可交账和落盘。 */
    stop: () => serial(async live => {
      started = false;
      for (const [id, dispose] of ctx.runtime.watchDisposers) await safe('取消文件监听', () => { dispose(); }, id);
      if (!live()) return;
      ctx.runtime.watchDisposers.clear();
      ctx.runtime.pendingFileEvents.clear();
      writeOutreachAudit(ctx, 'hub_stopped', { at: ctx.clock.now() });
      ctx.emit(HUB_EVENT_SCOPES.overview);
      ctx.emit(HUB_EVENT_SCOPES.activity);
      await flush(live);
    }),
    /** tick 锁在进入串行队列前设置，重叠调用无需等待旧 tick。 */
    tick: async () => {
      // 必须在串行队列和重叠锁之外：旧入口可能正等宿主投递，只有新 tick 能解除它。
      const now = ctx.clock.now();
      dispatcher.expireDeliveries(now);
      const expired = waits.expire(now);
      if (expired.length) {
        raiseAlert(ctx, { code: 'hub:入口超时', botId: null, level: 'P1', immediate: true,
          text: `中心等待超过五分钟，已释放通道：${[...new Set(expired)].join('、')}` });
        ticking = null;
      }
      if (ticking || !started) return;
      const token = {};
      ticking = token;
      const tickLease = waits.open('tick');
      try { await serial(async live => {
        const safeCurrent: typeof safe = async (label, work, botId) => {
          if (live() && tickLease.live()) await safe(label, work, botId);
        };
        if (started && live()) await runTick(ctx, { safe: safeCurrent, ...collector, pump: dispatcher.pump });
        if (live() && !expired.length) closeAlert(ctx, 'hub:入口超时', null);
        if (live()) await flush(live);
      }); }
      catch (error) { report('中心 tick', error); }
      finally { tickLease.close(); if (ticking === token) ticking = null; }
    },
    onTurnEvent: e => {
      // 宿主上报的主动打断也需先结束投递占位，再等串行保存；其他事件维持原顺序。
      if (e?.type === 'interrupted' && hub.botIdForSession(e.sessionId) !== null) return processTurn(ctx, e)
        .then(() => event('主人打断后处理', () => { dispatcher.finishProbe(); }));
      return event('回合事件', async () => { await processTurn(ctx, e); dispatcher.finishProbe(); });
    },
    onExternalSessionEvent: e => event('外部会话事件', () => { recordSessionEvent(ctx, e); }),
    onOwnerActivity: at => event('主人活动', () => { ctx.runtime.ownerActiveAt = parseInput(timestamp, at, '主人活动时间'); }),
    botIdForSession: sessionId => ctx.store.table('bots').list(b => b.sessionId !== null && b.sessionId === sessionId)[0]?.id ?? null,
    tools: () => registered,
    guardToolCall: (sessionId, tool, args) => {
      const decision = guardToolCallSync(ctx, sessionId, tool, args, defer);
      void event('动作守卫后处理', () => undefined);
      return decision;
    },
    onHostApprovalRequest: (sessionId, tool, summary) => {
      const decision = onHostApprovalRequestSync(ctx, sessionId, tool, summary, defer);
      void event('宿主审批后处理', () => undefined);
      return decision;
    },
    subscribe: fn => { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
  };
  return hub;
}
