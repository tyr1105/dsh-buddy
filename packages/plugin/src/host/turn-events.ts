/**
 * session/event → core 回合事件的翻译层（verified-T3 Q3【corrected】的事件顺序与载荷）。
 * 职责：
 * - 机器人会话（名册命中，排除 header.origin==='subagent'）：
 *   turn/start → started；tool/call → step（steps+1，token 按回合累计全部请求的
 *   用量，同一 (turn, step) 后到样本替换、llm/retry-started 后开新槽相加、不同
 *   step 相加，provider 不报用量时为 null 而不是 0，D05 第 11 条 / D07 第 16 条）；
 *   turn/end → 中止类（kind='aborted'）按内层原因无状态分流（D07 第 4 条）：
 *   内层是本插件的 hook（reason 以 agent-hub: 开头）= 中心自己取消的，不发任何
 *   事件（core 已记录 canceled/timeout）；**其余一切中止**（主人停止、DSH 退出
 *   disposed、其他插件的 hook 等）都翻译成 interrupted(by=owner)——不是中心发起
 *   的取消，绝不能算成队友的错。其余 → ended（reason.kind==='error' 时改报
 *   error 事件）；
 *   approval/asked → 先按审批 id 记未决，收到配对的 approval/decided 就
 *   删除（手册 0.4 第 5 条），只有 asked 之后 30 秒仍没有 decided 才翻译成
 *   awaiting_approval（D04 第 1 条）；主人亲手发的 user 消息（source.kind==='user'
 *   且不是桥/中心转发，D05 第 8 条：中心投递现在带 source.kind='agent-hub'，
 *   不再依赖内存 requestId 集合）→ owner_direct，同时记主人活动。
 * - 非机器人会话：主人亲手发言 → hub.onOwnerActivity；turn/end → hub.onExternalSessionEvent
 *   （finished 或 error；标题优先读 sessionProjections 快照，重启后也能取到，
 *   D05 第 15 条；都取不到用「未命名会话」，绝不用会话 id）。
 * 回调绝不向外抛错（外层再用 safe() 包一层双保险）。
 */
import type { Hub, TurnEvent } from '@agent-hub/core'

export interface TranslatorDeps {
  hub: Hub
  now(): number
  /** 会话是否属于机器人（含预登记名册 / 持久名册）。 */
  botIdFor(sessionId: string): string | null
  /** 外部会话标题快照（sessionProjections.snapshot(session, ['title'])）；取不到返回 null。 */
  externalTitle?(session: unknown): string | null
  /** 定时器（默认 setTimeout；测试注入假的）。审批配对等待 30 秒用。 */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/** asked 之后等多久还没有配对的 decided，才认为真的卡在 DSH 审批（D04 第 1 条）。 */
export const APPROVAL_PAIR_WAIT_MS = 30_000

/** verified-T3 Q4-a：先取 assistant/message 的 usage 字段，缺省退回 stream 里最后一条 usage chunk。 */
export function lastUsageChunk(stream: unknown): Record<string, unknown> | null {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i] as any
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage ?? null
  }
  return null
}

/** 与手册 3.4 addTokens 同口径地算一次请求的用量；拿不到返回 null（不能报 0）。 */
export function usageOf(event: { type: string; data?: any }): number | null {
  const usage = event.type === 'assistant/message'
    ? event.data?.usage ?? lastUsageChunk(event.data?.stream)
    : event.type === 'assistant/attempt' ? lastUsageChunk(event.data?.stream) : null
  if (usage === null || usage === undefined) return null
  if (typeof usage.totalTokens === 'number') return usage.totalTokens
  // 无 totalTokens 时按手册 3.4 口径：input+output+cacheRead+cacheWrite。
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
  if (!parts.some(v => typeof v === 'number')) return null
  return parts.reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
}

/** 从 content 块里抽出全部纯文本（最终回复、主人原文都这么取）。 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('')
}

/** 工具结果摘要：只取文本块或错误消息，最多 2000 字；完整输出留给 DSH 会话，不写账本。 */
export function resultSummaryOf(data: any): string {
  const fromContent = textOfContent(data?.message?.content)
  const raw = fromContent !== '' ? fromContent : String(data?.error?.message ?? data?.error?.code ?? '')
  const chars = Array.from(raw.replace(/\s+/g, ' ').trim())
  return chars.slice(0, 2_000).join('')
}

/** 桥投递的 requestId 前缀（dsh-claude-bridge 的约定），不算主人亲手发言。 */
export const BRIDGE_RPC_PREFIX = 'claude-bridge-'
/** 中心替主人转发原话时的 requestId 前缀（手册 3.3 relayOwnerWords），不算主人亲手发言。 */
export const RELAY_RPC_PREFIX = 'agent-hub:'

/**
 * 判定一条 user/message 是否主人亲手输入（D05 第 8 条）：source.kind 必须是 'user'
 * （中心投递现在带 kind 'agent-hub'，天然排除），且不是桥/中心转发的 requestId。
 */
export function isOwnerTyped(source: any): boolean {
  if (source?.kind !== 'user') return false
  const rpcId = source.rpcId
  if (typeof rpcId === 'string' && rpcId.startsWith(BRIDGE_RPC_PREFIX)) return false
  if (typeof rpcId === 'string' && rpcId.startsWith(RELAY_RPC_PREFIX)) return false
  return true
}

/** 回合状态：steps 累计步数；usageByStep 按 (turn,step,attempt) 记最近样本（同一
 * 尝试内后到样本替换；llm/retry-started 之后开新尝试槽相加），总数跨 step 相加。 */
interface TurnState {
  steps: number
  finalText: string
  /** null 表示回合内还没有任何一次请求报过用量（step/ended 都应传 null）。 */
  usageByStep: Map<string, number>
  /** (turn:step) 已重试次数：每收到一次 llm/retry-started 加一，下一份用量记进新槽。 */
  retries: Map<string, number>
  /** 已发出、还没收到结果的工具调用；过程下钻要把名字和参数带到结果事件里。 */
  calls: Map<string, { name: string; args: unknown }>
}

/** 未决审批：审批 id → 等待配对 decided 的记录（含 30 秒定时器句柄）。 */
interface PendingApproval { sessionId: string; tool: string; summary: string; timer: unknown }

/** 外部会话的兜底标题：绝不把会话 id 当标题报给 core。 */
export const UNTITLED_SESSION = '未命名会话'

/**
 * 判定 turn/end 的中止来源（D07 第 4 条，无状态识别）：
 * - 'hub'：内层 reason 是本插件的 hook（kind='hook' 且 reason 以 agent-hub: 开头）
 *   ——中心自己取消的（host.cancel），core 已记录，插件不发任何事件；
 * - 'external'：其余一切中止（主人在 DSH 界面停止的内层 user、DSH 退出的 disposed、
 *   其他插件的 hook、未知形态）——一律视为主人打断（不能算成队友的错）；
 * - null：不是中止类（正常结束 / 出错等）。
 * DSH 的 turn/end 只有 kind='aborted' 一种取消形态（cancelled/canceled 不存在）。
 */
export function abortSourceOf(reason: any): 'hub' | 'external' | null {
  if (reason?.kind !== 'aborted') return null
  const inner = reason.reason
  if (inner?.kind === 'hook' && typeof inner.reason === 'string' && inner.reason.startsWith('agent-hub:')) return 'hub'
  return 'external'
}

/** 翻译器：一个实例处理全部 session/event；内部维护每会话回合状态与会话标题。 */
export class SessionEventTranslator {
  private readonly turns = new Map<string, TurnState>()
  private readonly titles = new Map<string, string>()
  /** 未决审批（按审批 id）。asked 先记着，配对的 decided 一到就删。 */
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  constructor(private readonly deps: TranslatorDeps) {}

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((cb: () => void, t: number) => setTimeout(cb, t)))(fn, ms)
  }

  private clearTimer(handle: unknown): void {
    try { (this.deps.clearTimer ?? clearTimeout as (h: unknown) => void)(handle) } catch { /* 忽略清定时器失败 */ }
  }

  /** 插件卸载时清掉全部未决审批定时器（D05 第 4 条：不能再对已停止的 Hub 报事件）。 */
  dispose(): void {
    for (const id of [...this.pendingApprovals.keys()]) this.dropApproval(id)
    this.turns.clear()
  }

  /** 删除一条未决审批（连同定时器）。 */
  private dropApproval(id: string): void {
    const pending = this.pendingApprovals.get(id)
    if (pending === undefined) return
    this.pendingApprovals.delete(id)
    this.clearTimer(pending.timer)
  }

  /** 回合结束：清掉该会话全部未决审批（它们属于已结束的回合，不能再报卡住）。 */
  private clearSessionApprovals(sessionId: string): void {
    for (const [id, pending] of [...this.pendingApprovals]) {
      if (pending.sessionId === sessionId) this.dropApproval(id)
    }
  }

  /** 当前回合的累计 token：usageByStep 各 step 最近样本求和；没有任何样本返回 null。 */
  private tokensOf(turn: TurnState | undefined): number | null {
    if (turn === undefined || turn.usageByStep.size === 0) return null
    let sum = 0
    for (const value of turn.usageByStep.values()) sum += value
    return sum
  }

  /** ctx.on('session/event', (session, event) => handle(session, event))；异常全部兜住。 */
  handle(session: any, event: any): void {
    try { this.dispatch(session, event) }
    catch (error) { console.error('[agent-hub] session/event 翻译失败:', error) }
  }

  private dispatch(session: any, event: any): void {
    if (event?.type === 'session/title') {
      if (typeof event.data?.title === 'string') this.titles.set(String(session?.id), event.data.title)
      return
    }
    if (!['turn/start', 'turn/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt', 'llm/retry-started', 'approval/asked', 'approval/decided', 'user/message'].includes(event?.type)) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '' || session?.header?.origin === 'subagent') return
    const at = typeof event.time === 'number' ? event.time : this.deps.now()
    const botId = this.deps.botIdFor(sessionId)
    if (botId !== null) this.botEvent(sessionId, botId, at, event)
    else this.externalEvent(session, sessionId, at, event)
  }

  /** 机器人会话：翻译成 core 的 TurnEvent。 */
  private botEvent(sessionId: string, _botId: string, at: number, event: any): void {
    const hub = this.deps.hub
    switch (event.type) {
      case 'turn/start':
        this.clearSessionApprovals(sessionId) // 兜底清掉上一回合漏网的未决审批
        this.turns.set(sessionId, { steps: 0, finalText: '', usageByStep: new Map(), retries: new Map(), calls: new Map() })
        void hub.onTurnEvent({ type: 'started', sessionId, at })
        return
      case 'tool/call': {
        const turn = this.turns.get(sessionId)
        if (!turn) return
        turn.steps += 1
        // 先记住名字与参数；等 tool/result 到了再报给 core，避免把「发起」当成「成功」。
        const callId = String(event.data?.callId ?? '')
        if (callId !== '') turn.calls.set(callId, { name: String(event.data?.name ?? '未知工具'), args: event.data?.arguments })
        void hub.onTurnEvent({ type: 'step', sessionId, at, steps: turn.steps, tokens: this.tokensOf(turn) })
        return
      }
      case 'tool/result': {
        // 一次工具调用有了真实结果：把工具名、参数与失败标记写进账本（F02 过程下钻）。
        const turn = this.turns.get(sessionId)
        if (!turn) return
        const callId = String(event.data?.message?.toolCallId ?? '')
        const call = callId === '' ? undefined : turn.calls.get(callId)
        if (callId !== '') turn.calls.delete(callId)
        // 找不到配对的 call 时只报名字占位：宁可显示「未知工具」，也不能丢掉一次真实动作。
        const resultText = resultSummaryOf(event.data)
        void hub.onTurnEvent({
          type: 'tool_call', sessionId, at,
          name: call?.name ?? '未知工具',
          callId,
          args: call?.args,
          isError: event.data?.message?.isError === true || event.data?.error !== undefined,
          resultText,
        })
        return
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const turn = this.turns.get(sessionId)
        if (!turn) return
        const usage = usageOf(event)
        if (usage !== null) {
          // 同一 (turn, step) 的同一尝试内后到样本替换；重试后（llm/retry-started）
          // 记进新槽，失败尝试与重试的用量相加（官方 token-meter 口径，D07 第 16 条）。
          const base = `${String(event.data?.turn ?? 0)}:${String(event.data?.step ?? turn.steps)}`
          turn.usageByStep.set(`${base}:${turn.retries.get(base) ?? 0}`, usage)
        }
        const text = textOfContent(event.data?.message?.content)
        if (text !== '') turn.finalText = text
        return
      }
      case 'llm/retry-started': {
        // 同一步开始重试：关掉当前替换槽，下一份用量相加而不是覆盖（D07 第 16 条）。
        const turn = this.turns.get(sessionId)
        if (!turn) return
        const base = `${String(event.data?.turn ?? 0)}:${String(event.data?.step ?? turn.steps)}`
        turn.retries.set(base, (turn.retries.get(base) ?? 0) + 1)
        return
      }
      case 'approval/asked': {
        // 手册 0.4 第 5 条：never 策略下 asked 后会紧跟 rejected 的 decided。先记未决，
        // 30 秒内收到配对 decided 就删；只有一直没配上的才报 awaiting_approval。
        const id = String(event.data?.id ?? '')
        if (id === '') return
        this.dropApproval(id) // 同 id 重复 asked：只保留最新一条
        const tool = String(event.data?.toolName ?? 'unknown')
        const summary = String(event.data?.reason ?? '')
        const timer = this.setTimer(() => {
          try {
            const pending = this.pendingApprovals.get(id)
            if (pending === undefined || pending.sessionId !== sessionId) return
            this.pendingApprovals.delete(id)
            void this.deps.hub.onTurnEvent({ type: 'awaiting_approval', sessionId, at: this.deps.now(), tool: pending.tool, summary: pending.summary })
          } catch (error) { console.error('[agent-hub] 审批配对定时器出错:', error) }
        }, APPROVAL_PAIR_WAIT_MS)
        this.pendingApprovals.set(id, { sessionId, tool, summary, timer })
        return
      }
      case 'approval/decided': {
        // 配对成功：这条审批已有了结果（无论 allowed 还是 rejected），不算卡住。
        const id = String(event.data?.id ?? '')
        if (id !== '') this.dropApproval(id)
        return
      }
      case 'user/message': {
        if (!isOwnerTyped(event.data?.source)) return
        const text = textOfContent(event.data?.content)
        void hub.onOwnerActivity(at)
        void hub.onTurnEvent({ type: 'owner_direct', sessionId, at, text })
        return
      }
      case 'turn/end': {
        const turn = this.turns.get(sessionId)
        this.turns.delete(sessionId)
        this.clearSessionApprovals(sessionId) // 回合结束：未决审批随之作废（D04 第 1 条）
        const reason = event.data?.reason
        // D07 第 4 条：无状态识别中止来源。中心自己取消的（本插件的 agent-hub: hook）
        // 由 core 自己记录 canceled/timeout，插件不发任何事件；其余一切中止都视为主人
        // 打断，翻译成 interrupted（core 保存终态、恢复感知并写线程消息）。
        const abortSource = abortSourceOf(reason)
        if (abortSource === 'hub') return
        if (abortSource === 'external') {
          void hub.onTurnEvent({ type: 'interrupted', sessionId, at, by: 'owner' })
          return
        }
        if (reason?.kind === 'error') {
          const errorText = String(reason.error?.message ?? reason.error?.code ?? '回合出错')
          void hub.onTurnEvent({ type: 'error', sessionId, at, errorText } as TurnEvent)
          return
        }
        void hub.onTurnEvent({
          type: 'ended', sessionId, at,
          finalText: turn?.finalText ?? '',
          tokens: this.tokensOf(turn),
        })
        return
      }
      default: return
    }
  }

  /** 非机器人会话：主人活动 + 外部会话结束/出错。 */
  private externalEvent(session: unknown, sessionId: string, at: number, event: any): void {
    const hub = this.deps.hub
    if (event.type === 'user/message') {
      if (isOwnerTyped(event.data?.source)) void hub.onOwnerActivity(at)
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      // 标题优先级：sessionProjections 快照（重启后仍在）> 本次运行记下的 title 事件 > 固定名。
      const snapshotTitle = (() => { try { return this.deps.externalTitle?.(session) ?? null } catch { return null } })()
      void hub.onExternalSessionEvent({
        type: reason?.kind === 'error' ? 'error' : 'finished',
        sessionId,
        title: snapshotTitle ?? this.titles.get(sessionId) ?? UNTITLED_SESSION,
        at,
        summary: reason?.kind === 'error' ? String(reason.error?.message ?? '会话出错') : '会话已完成一轮',
      })
    }
  }
}
