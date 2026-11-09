/** 内存宿主把投递变成可编排的大脑回合；全部事件和工具沿 Hub 公共入口执行，绝不连接真实会话或网络。 */
import { z } from 'zod';
import type { Clock } from '../io/interfaces.js';
import type { HostPort, MessageSource, TurnEvent } from '../model/index.js';
import type { Hub } from '../engine/hub.js';
import type { ToolResult } from '../tools/types.js';
import { SIM_DEFAULTS } from '../config/defaults.js';
import type { Brain, BrainInput, BrainResult, SimCall, SimNotification, SimToolCall, SimTurn } from './types.js';
export type { Brain, BrainInput, BrainResult } from './types.js';

const resultSchema = z.strictObject({ finalText: z.string().optional(), error: z.string().min(1).optional(),
  hang: z.boolean().optional(), tokens: z.number().int().nonnegative().optional(),
  awaitingApproval: z.strictObject({ tool: z.string().min(1), summary: z.string() }).optional() });
type Session = { exists: boolean; running: boolean; contextRatio: number | null; title: string; updatedAt: number };

/** 只模拟宿主职责；业务规则仍由 Hub 检查，记录则供场景测试独立核对。 */
export class SimHost implements HostPort {
  readonly calls: SimCall[] = [];
  readonly notifications: SimNotification[] = [];
  readonly toolCalls: SimToolCall[] = [];
  readonly turns: SimTurn[] = [];
  readonly sessions = new Map<string, Session>();
  readonly digests = new Map<string, string>();
  maxRunning = 0;
  private hub: Hub | null = null;
  private sequence = 0;
  private readonly brains = new Map<string, Brain>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures = new Map<string, { remaining: number; text: string }>();
  private readonly asyncErrors: unknown[] = [];
  private defaultBrain: Brain | null = null;

  /** 注入时钟，使通知、步骤和运行记录使用同一条仿真时间线。 */
  constructor(private readonly clock: Clock) {}

  /** 创建 Hub 后接回事件入口，避免构造时产生循环依赖。 */
  attach(hub: Hub): void { this.hub = hub; }

  /** 为界面新建、尚无独立剧本的机器人提供可替换的默认大脑。 */
  setDefaultBrain(brain: Brain): void { this.defaultBrain = brain; }

  /** 注册或替换单个机器人的大脑，后续回合立即采用新剧本。 */
  registerBrain(botId: string, brain: Brain): void {
    if (!botId.trim() || typeof brain !== 'function') throw new Error('仿真大脑必须有机器人 id 和函数');
    this.brains.set(botId, brain);
  }

  /** 注入有限次投递故障，既覆盖创建会话也覆盖后续 deliver。 */
  failNextDeliveries(botId: string, count: number, text = '仿真投递失败'): void {
    if (!Number.isSafeInteger(count) || count < 0 || !text.trim()) throw new Error('投递失败次数必须是非负整数，原因不能为空');
    this.failures.set(botId, { remaining: count, text });
  }

  /** 保存参数副本，防止调用结束后改对象污染验证证据。 */
  private record(method: keyof HostPort, args: unknown[]): void {
    this.calls.push({ method, args: structuredClone(args), at: this.clock.now() });
  }

  /** 按预设消费一次故障；投递未成功时不创建运行记录。 */
  private checkDelivery(botId: string): void {
    const failure = this.failures.get(botId);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      throw new Error(failure.text);
    }
    if (!this.hub) throw new Error('仿真宿主尚未连接 Hub');
    if (!this.brains.has(botId) && !this.defaultBrain) throw new Error(`机器人 ${botId} 尚未注册仿真大脑`);
  }

  /** 新建会话并异步安排首回合，调用方先得到会话身份再接收回合事件。 */
  async createSession(input: Parameters<HostPort['createSession']>[0]): Promise<{ sessionId: string }> {
    this.record('createSession', [input]);
    this.checkDelivery(input.botId);
    const sessionId = `sim-session-${++this.sequence}`;
    this.sessions.set(sessionId, { exists: true, running: false, contextRatio: null, title: input.title, updatedAt: this.clock.now() });
    this.schedule(sessionId, input.firstMessage, input.source);
    return { sessionId };
  }

  /** 投递到仍存在的会话，不允许假宿主掩盖一会话同时运行多个回合的问题。 */
  async deliver(sessionId: string, text: string, source: MessageSource): Promise<void> {
    this.record('deliver', [sessionId, text, source]);
    this.checkDelivery(source.botId);
    const session = this.sessions.get(sessionId);
    if (!session?.exists) throw new Error('仿真会话不存在');
    if (session.running) throw new Error('仿真会话仍在运行，不能重复投递');
    this.schedule(sessionId, text, source);
  }

  /** 记录收口提醒；是否响应由剧本决定，不假装模型已经结束。 */
  async steer(sessionId: string, text: string): Promise<void> { this.record('steer', [sessionId, text]); }

  /** 取消当前回合并抑制迟到的结束事件；中心负责自己的唤醒单收尾。 */
  async cancel(sessionId: string): Promise<void> {
    this.record('cancel', [sessionId]);
    const session = this.sessions.get(sessionId);
    if (session) session.running = false;
    for (const turn of this.turns.filter(row => row.sessionId === sessionId && row.endedAt === null)) {
      turn.status = 'cancelled';
      turn.endedAt = this.clock.now();
    }
  }

  /** 返回实时状态副本，支持会话缺失与上下文轮换的测试。 */
  async sessionInfo(sessionId: string) {
    this.record('sessionInfo', [sessionId]);
    const session = this.sessions.get(sessionId);
    return { exists: session?.exists ?? false, running: session?.running ?? false, contextRatio: session?.contextRatio ?? null };
  }

  /** 按最近活动列出已登记会话，让教学走同一宿主查询入口。 */
  async listRecentSessions(limit: number) {
    this.record('listRecentSessions', [limit]);
    return [...this.sessions].filter(([, value]) => value.exists).map(([sessionId, value]) => ({ sessionId, title: value.title, updatedAt: value.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** 读取受控的教学摘要，不从任何真实会话或文件取内容。 */
  async readSessionDigest(sessionId: string, maxChars: number): Promise<string> {
    this.record('readSessionDigest', [sessionId, maxChars]);
    return (this.digests.get(sessionId) ?? '').slice(0, maxChars);
  }

  /** 通知同时记录发生时刻，便于独立检查免打扰时段。 */
  async notify(input: Parameters<HostPort['notify']>[0]): Promise<void> {
    this.record('notify', [input]);
    this.notifications.push({ ...structuredClone(input), at: this.clock.now() });
  }

  /** 用两个微任务交接让 createSession 的调用方先写回 sessionId，避免 started 抢跑。 */
  private schedule(sessionId: string, packet: string, source: MessageSource): void {
    const session = this.sessions.get(sessionId)!;
    session.running = true;
    session.updatedAt = this.clock.now();
    this.maxRunning = Math.max(this.maxRunning, [...this.sessions.values()].filter(s => s.running).length);
    const turn: SimTurn = { botId: source.botId, sessionId, packet, variant: source.variant, source: { ...source },
      startedAt: this.clock.now(), endedAt: null, steps: 0, tokens: 0, status: 'scheduled' };
    this.turns.push(turn);
    const operation = Promise.resolve().then(async () => {
      await Promise.resolve();
      await this.run(turn);
    }).catch(error => { this.asyncErrors.push(error); });
    this.pending.add(operation);
    void operation.then(() => { this.pending.delete(operation); });
  }

  /** 发送事件并等待 Hub 的后续投递和刷盘完成，保证沉降点有明确意义。 */
  private async event(event: TurnEvent): Promise<void> { await this.hub!.onTurnEvent(event); }

  /** 每个大脑工具调用都经过 guard 与注册 handler，并累计一次真实模拟步骤。 */
  private async call(turn: SimTurn, tool: string, args: unknown, tokens: number = SIM_DEFAULTS.stepTokens): Promise<ToolResult> {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('仿真每步 token 必须是非负整数');
    if (turn.status === 'cancelled') return { ok: false, error: '仿真回合已经取消' };
    const decision = await this.hub!.guardToolCall(turn.sessionId, tool, args);
    let result: ToolResult;
    if (!decision.allow) result = { ok: false, error: decision.message };
    else {
      const definition = this.hub!.tools().find(item => item.name === tool);
      // 对外工具仅模拟成功，不执行真实命令；动作是否有权限仍由真实守卫判断。
      result = definition ? await definition.handler(turn.sessionId, args)
        : tool.startsWith('hub_') ? { ok: false, error: `不存在中心工具 ${tool}` } : { ok: true, text: '仿真工具已执行' };
    }
    this.toolCalls.push({ botId: turn.botId, sessionId: turn.sessionId, tool, args: structuredClone(args), result: { ...result }, at: this.clock.now() });
    turn.steps += 1;
    turn.tokens += tokens;
    await this.event({ type: 'step', sessionId: turn.sessionId, at: this.clock.now(), steps: turn.steps, tokens: turn.tokens });
    return result;
  }

  /** 先 started 后运行剧本；无交账由 Hub 判断，卡住和审批则保留运行状态供假时钟检查。 */
  private async run(turn: SimTurn): Promise<void> {
    if (turn.status === 'cancelled') return;
    turn.status = 'running';
    await this.event({ type: 'started', sessionId: turn.sessionId, at: this.clock.now() });
    let result: BrainResult;
    try {
      const input: BrainInput = { packet: turn.packet, variant: turn.variant, botId: turn.botId, sessionId: turn.sessionId,
        call: (tool, args, tokens) => this.call(turn, tool, args, tokens) };
      result = resultSchema.parse(await (this.brains.get(turn.botId) ?? this.defaultBrain)!(input));
    } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    if (turn.status as SimTurn['status'] === 'cancelled') return;
    if (result.tokens !== undefined) turn.tokens = Math.max(turn.tokens, result.tokens);
    if (result.awaitingApproval) {
      turn.status = 'awaiting_approval';
      await this.event({ type: 'awaiting_approval', sessionId: turn.sessionId, at: this.clock.now(), ...result.awaitingApproval });
      return;
    }
    if (result.hang) { turn.status = 'hung'; return; }
    turn.endedAt = this.clock.now();
    const session = this.sessions.get(turn.sessionId)!;
    session.running = false;
    session.updatedAt = this.clock.now();
    if (result.error) {
      turn.status = 'error';
      await this.event({ type: 'error', sessionId: turn.sessionId, at: this.clock.now(), errorText: result.error });
    } else {
      turn.status = 'ended';
      await this.event({ type: 'ended', sessionId: turn.sessionId, at: this.clock.now(), finalText: result.finalText ?? '', tokens: turn.tokens });
    }
  }

  /** 等待所有已安排的大脑及其连锁事件结束；hang 是状态而非未完成任务，因此不会卡死仿真。 */
  async settle(): Promise<void> {
    let passes = 0;
    do {
      await Promise.all([...this.pending]);
      await Promise.resolve();
      passes += 1;
      if (passes > SIM_DEFAULTS.maxSettlePasses) throw new Error('仿真沉降超过上限，可能存在无限唤醒循环');
    } while (this.pending.size > 0);
    const failure = this.asyncErrors.shift();
    if (failure) throw failure;
  }
}
