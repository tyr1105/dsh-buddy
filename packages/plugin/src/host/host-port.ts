/**
 * HostPort 的 DSH 实现：把 core 需要的「建会话 / 投递 / 收口 / 取消 / 状态 / 通知」
 * 全部落到 DSH 的宿主服务上。用法依据：
 * - 建会话配方：verified-T2 Q1【corrected】（mkdir → workspaceRegistry.create →
 *   sessionController.create → rename → resolveAgent → wireIfBot 补装（D05 第 9 条，
 *   DSH 另铸会话 id 时也能装上 hub_* 工具）→ 无人值守权限（只在建会话时设置一次，
 *   失败即中止，D05 第 5 条）→ selectModel 后立刻还原全局默认（模块级串行链，
 *   D05 第 16 条）→ sessions.flush）。
 * - 投递（D05 第 8 条，手册 3.3 verified-T2 Q2）：agent.followup + 手搓冻结消息，
 *   source.kind='agent-hub'（带 wakeId、botId、variant）；同一唤醒单已在队列里时
 *   不重复入队；不在 session/event 同步阶段调用。prompt 只属于主人亲手写的话，
 *   中心不再使用。
 * - steer：resolveAgent 后 agent.steer + 手搓冻结消息（verified-T2 Q2【corrected】）。
 * - 取消（D07 第 4 条，手册 3.10）：无状态识别。会话没在跑回合时没有可取消的
 *   回合，直接返回成功；在跑时用 agent.cancel({kind:'hook', reason:'agent-hub:cancel'},
 *   {keepInbox:true})——取消原因带 agent-hub: 前缀，翻译层据此认出「中心自己取消的」，
 *   不再依赖任何旁路标记（标记会残留、吞掉主人后来的停止）。
 * - 状态：projections 的 contextPressure 投影（verified-T2 Q5）算 used/contextWindow。
 * 所有对 DSH 的调用逐段 try/catch 或由上层兜底：一个机器人失败不影响其他机器人。
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { HostPort, MessageSource, ModelChoice } from '@agent-hub/core'
import { sendMacNotification } from './notify.js'

/** 中心投递用的固定超时：projections 等方法要求 AbortSignal（verified-T2 Q1）。 */
const CALL_TIMEOUT_MS = 30_000

export interface DshHostDeps {
  /** 宿主上下文：sessionController / workspaceRegistry（inject），其余服务用 ctx.get 探测。 */
  ctx: any
  /**
   * 预登记名册：sessionId → botId。createSession 先登记再建，agent/created 时能认出机器人。
   * 真引擎模式传持久化名册（D07 第 15 条，重启后仍认得被打断解绑的旧会话）。
   */
  prereg: { get(id: string): string | undefined; set(id: string, botId: string): void; delete(id: string): void; has(id: string): boolean; keys(): IterableIterator<string> }
  /**
   * 预登记 id → 实际 id（D07 第 23 条 H7 诊断）：createSession 返回后记录，
   * **不随名册迁移**——冒烟跑者据此比对「DSH 有没有另铸会话 id」。
   */
  mints?: { set(wanted: string, actual: string): void }
  /** 读取当前设置里的推送渠道（'dsh' | 'macos' | 'none'）。 */
  pushChannel(): string
  /** 推送（或跳过推送）后让界面出现应用内提示（经 SSE 广播 changed）。 */
  onNotified(): void
  /** 记录会话是否正在跑回合（session/event 翻译层维护，sessionInfo 读）。 */
  running(sessionId: string): boolean
  /** 会话属于哪个机器人（名册 + Hub 名册）；listRecentSessions 过滤机器人自己的会话用。 */
  botIdFor(sessionId: string): string | null
  /** 给一个 agent 幂等补装 hub_* 工具与 restrict（D05 第 9 条；create 另铸 id 时用）。 */
  wireIfBot?(agent: unknown): void
  /** 发送系统通知的可替换实现（测试注入；默认 osascript）。 */
  sendNotification?(title: string, body: string): Promise<void>
}

/** 把 summary 截到 120 字：llm 消息 source.summary 的上限就是 120（verified-T2 Q2）。 */
function summaryOf(text: string): string {
  const chars = [...text]
  return (chars.length <= 120 ? text : chars.slice(0, 120).join('')) || '中心唤醒'
}

/** 深冻结：消息交给 agent 以后不能再被改（与官方 createUserMessage 同口径）。 */
function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** 去掉值为 undefined 的键：Session.append 遇到 undefined 会拒绝整条事件。 */
function defined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

/** 手搓一条完整、冻结的 user 消息（等价官方 createUserMessage；verified-T2 Q2【corrected】）。 */
export function hubSteerMessage(text: string): object {
  const message = {
    id: `agent-hub-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-hub', form: 'notice', summary: summaryOf(text) },
  }
  return Object.freeze(structuredClone(message))
}

/**
 * 中心投递的唤醒消息（D05 第 8 条，手册 3.3 deliverWake）：source 带 wakeId、botId、
 * variant，kind 固定 'agent-hub'（不能是 plugin/user）；整条消息冻结、无 undefined。
 */
export function hubWakeMessage(text: string, source: MessageSource): object {
  const message = {
    id: `agent-hub-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: defined({
      kind: 'agent-hub',
      form: 'notice',
      summary: `中心唤醒：${source.variant}`.slice(0, 120),
      wakeId: String(source.wakeId),
      botId: String(source.botId),
      variant: String(source.variant),
    }),
  }
  return deepFreeze(structuredClone(message)) as object
}

/** 从 contextPressure 投影算占用比例（verified-T2 Q5：used = projectedTokens ?? pressureTokens）。 */
export function contextRatioOf(pressure: any): number | null {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const window = pressure?.contextWindow
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return null
  return Math.min(1, used / window)
}

/** 从会话事件列表拼一段有长度上限的摘要（readSessionDigest 用；只取对话文本）。 */
export function digestFromEvents(events: Array<{ type?: string; data?: any }>, maxChars: number): string {
  const lines: string[] = []
  for (const event of events ?? []) {
    if (event?.type === 'user/message' || event?.type === 'assistant/message') {
      const message = event.data?.message ?? event.data
      const role = message?.role === 'assistant' ? '机器人' : '用户'
      const text = Array.isArray(message?.content)
        ? message.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('')
        : ''
      if (text.trim()) lines.push(`${role}：${text}`)
    }
  }
  const all = lines.join('\n')
  const chars = [...all]
  return chars.length <= maxChars ? all : chars.slice(chars.length - maxChars).join('')
}

/** 外部会话的兜底标题：取不到标题时用一个固定中文名，绝不把会话 id 显示给主人。 */
export const UNTITLED_SESSION = '未命名会话'

/** 从 DSH 的 list 行取标题（手册 3.11：标题在 projections.values.title，不在顶层）。 */
export function titleOfListItem(item: any): string {
  const title = item?.projections?.values?.title ?? item?.projections?.title ?? item?.title
  return typeof title === 'string' && title.trim() !== '' ? title : UNTITLED_SESSION
}

/** 所有「改会话模型」共用的模块级串行链（D05 第 16 条，手册 3.5 modelChain）。 */
let modelChain: Promise<unknown> = Promise.resolve()

/** 创建 HostPort。所有方法都不向外抛错以外的问题由 core 侧分类处理；这里只做边界兜底日志。 */
export function createDshHostPort(deps: DshHostDeps): HostPort {
  const sc = () => deps.ctx.sessionController
  const log = (...args: unknown[]) => console.error('[agent-hub]', ...args)

  /**
   * 无人值守权限（D05 第 5 条，手册 6.2 ensureBotPolicy）：沙箱 workspace-write +
   * 审批 never。幂等：先核对 overrideOf，已是目标值就不写（不产生多余权限事件）；
   * 失败即关闭：服务缺失或 set/append 抛错直接抛出，core 会把这次建会话/投递记为
   * 失败并重排，绝不放行一个无沙箱的无人值守会话。只在建会话时调用一次。
   */
  function ensureBotPolicy(agent: any, sessionId: string): void {
    const presets = deps.ctx.get?.('permissionPresets')
    const approval = deps.ctx.get?.('approval')
    const sandbox = deps.ctx.get?.('sandboxPolicy')
    if (presets === undefined || approval === undefined || sandbox === undefined) {
      throw new Error(`权限服务不可用，不能唤醒机器人（会话 ${sessionId}）`)
    }
    if (sandbox.overrideOf(agent.session) !== 'workspace-write') presets.set(agent.session, 'workspace-write')
    if (approval.overrideOf(agent.session) !== 'never') agent.session.append('approval/policy', { policy: 'never' })
  }

  /** 按会话选模型并立刻还原全局默认；串行执行（D05 第 16 条），prev 为空时不还原。 */
  function selectModelKeepDefault(model: ModelChoice, sessionId: string): Promise<void> {
    if (model === null) return Promise.resolve()
    const run = async (): Promise<void> => {
      const defaults = deps.ctx.get?.('agentDefaultModel')
      if (defaults === undefined) {
        log('宿主没有 agentDefaultModel 服务，跳过按会话选模型')
        return
      }
      const prev = defaults.currentSelection()
      await sc().selectModel({ sessionId, provider: model.provider, model: model.model })
      if (prev !== null && prev !== undefined) await defaults.saveSelection(prev)
    }
    const result = modelChain.then(run, run)
    modelChain = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    async createSession(input) {
      // 1) 预登记：agent/created 在 create 返回之前就会触发，必须先有名册（verified-T3 Q2-a）。
      const wanted = `session-${randomUUID()}`
      deps.prereg.set(wanted, input.botId)
      try {
        // 2) 工作区：workspaceRegistry.create 要求目录已存在且是绝对路径。
        try { await mkdir(input.cwd, { recursive: true }) } catch (error) { log('建机器人工作目录失败:', error) }
        const workspace = await deps.ctx.workspaceRegistry.create(input.cwd, input.title)
        // 3) 建会话：一律 standard preset（D02 任务卡）；rolePresetId 只作记录，不注册自定义 preset。
        const created = await sc().create({ sessionId: wanted, workspaceId: workspace.id, agentPreset: 'standard' })
        const sessionId = String(created.sessionId)
        if (sessionId !== wanted) {
          deps.prereg.set(sessionId, input.botId)
          deps.prereg.delete(wanted)
        }
        // H7 诊断（D07 第 23 条）：预登记 id → 实际 id 的映射不随名册迁移，
        // 冒烟跑者据此才能发现「DSH 另铸了 id、插件走了退回分支」。
        try { deps.mints?.set(wanted, sessionId) } catch { /* 记录失败不影响建会话 */ }
        // 4) 标题：rename 写一条 source.kind 'user' 的 title 事件，从此钉住。
        await sc().rename({ sessionId, title: input.title })
        // 5) 取到会话对象；resolveAgent 不抛错，失败时返回 { error }。
        const found = await sc().resolveAgent(sessionId)
        if ('error' in found) throw found.error
        // 6) 补装 hub_* 工具与 restrict（幂等；DSH 另铸 id 时 agent/created 认不出，这里补上）。
        try { deps.wireIfBot?.(found.agent) } catch (error) { log('补装机器人工具失败:', error) }
        // 7) 权限：无人值守（workspace-write + never）；失败即中止，不投递唤醒包。
        ensureBotPolicy(found.agent, sessionId)
        // 8) 模型：机器人指定了才选，选完立刻还原全局默认（串行链）。
        await selectModelKeepDefault(input.model, sessionId)
        // 9) 落盘：让权限与标题事件进第一批持久化（verified-T2 Q1 会话持久化）。
        try { await deps.ctx.get?.('sessions')?.flush(found.agent.session) } catch { /* flush 失败不阻断 */ }
        // 10) 首条唤醒包：与后续投递同一条 followup 路径（手册 3.2/3.3）。
        await deliverImpl(sessionId, input.firstMessage, input.source)
        return { sessionId }
      } catch (error) {
        deps.prereg.delete(wanted)
        throw error instanceof Error ? error : new Error(String(error))
      }
    },

    async deliver(sessionId, text, source) { await deliverImpl(sessionId, text, source) },

    async steer(sessionId, text) {
      const found = await sc().resolveAgent(sessionId)
      if ('error' in found) throw found.error
      found.agent.steer(hubSteerMessage(text))
      try { await deps.ctx.get?.('sessions')?.flush(found.agent.session) } catch { /* 同上 */ }
    },

    async cancel(sessionId) {
      // D07 第 4 条（手册 3.10）：无状态识别。会话没在跑回合时没有可取消的回合，
      // 直接返回成功——绝不能留下任何「取消标记」（旧实现会残留，吞掉这个会话
      // 下一次主人亲手停止，把打断变成机器人故障）。在跑时用 hook 取消原因带
      // agent-hub: 前缀，翻译层据此认出中心取消。
      if (!deps.running(sessionId)) return
      try {
        const found = await sc().resolveAgent(sessionId)
        if ('error' in found) throw found.error
        found.agent.cancel({ kind: 'hook', reason: 'agent-hub:cancel' }, { keepInbox: true })
      } catch (error) {
        // 取消失败由 core 按错误处理（唤醒单卡住路径会自行收尾），这里只兜住不外抛。
        log(`取消会话失败（${sessionId}）:`, error)
      }
    },

    async sessionInfo(sessionId) {
      try {
        const result = await sc().projections({ sessionId }, AbortSignal.timeout(CALL_TIMEOUT_MS))
        if (result === null || result.kind !== 'sequenced') return { exists: false, running: false, contextRatio: null }
        return {
          exists: true,
          running: deps.running(sessionId),
          contextRatio: contextRatioOf(result.values?.contextPressure),
        }
      } catch {
        return { exists: false, running: false, contextRatio: null }
      }
    },

    async listRecentSessions(limit) {
      try {
        const { items } = await sc().list({}, AbortSignal.timeout(CALL_TIMEOUT_MS))
        return (items as any[])
          // 排除子代理、空白会话和机器人自己的会话（手册 3.11 / D05 第 14 条）。
          .filter(item => item?.sessionId && item?.origin !== 'subagent' && item?.blank !== true
            && deps.botIdFor(String(item.sessionId)) === null)
          .map(item => ({
            sessionId: String(item.sessionId),
            title: titleOfListItem(item),
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, Math.max(1, limit))
      } catch (error) {
        log('列出最近会话失败:', error)
        return []
      }
    },

    async readSessionDigest(sessionId, maxChars) {
      try {
        const inspect = await sc().inspect(sessionId, AbortSignal.timeout(CALL_TIMEOUT_MS))
        return digestFromEvents(inspect?.events ?? [], maxChars)
      } catch (error) {
        log(`读取会话摘要失败（${sessionId}）:`, error)
        return ''
      }
    },

    async notify(n) {
      // pushChannel 为 none 时不发系统通知，但仍让界面出现应用内提示。
      if (deps.pushChannel() !== 'none') {
        const send = deps.sendNotification ?? sendMacNotification
        try { await send(n.title, n.body) } catch (error) { log('发送通知失败:', error) }
      } else {
        console.log(`[agent-hub] 通知（pushChannel=none，未推送）：[${n.level}] ${n.title}`)
      }
      try { deps.onNotified() } catch { /* 界面提示失败不影响引擎 */ }
    },
  }

  /**
   * 投递实现（D05 第 8 条，手册 3.3 deliverWake）：resolveAgent → 按 wakeId 检查
   * 两条队列去重 → agent.followup(冻结消息，source.kind='agent-hub') → flush。
   * 不用 prompt：prompt 的 source 写死 kind 'user'，重启后会被误判成主人亲手发言，
   * 还会让机器人会话在侧栏不断上浮、重置唤醒预算。
   */
  async function deliverImpl(sessionId: string, text: string, source: MessageSource): Promise<void> {
    const found = await sc().resolveAgent(sessionId)
    if ('error' in found) throw found.error
    const agent = found.agent
    // 去重：同一唤醒单已在任一队列里，再入队会抛「already pending」，直接视为已投递。
    const same = (m: any): boolean => m?.source?.kind === 'agent-hub' && m?.source?.wakeId === String(source.wakeId)
    if (Array.isArray(agent.inbox?.nextTurn) && agent.inbox.nextTurn.some(same)) return
    if (Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.some(same)) return
    agent.followup(hubWakeMessage(text, source))
    try { await deps.ctx.get?.('sessions')?.flush(agent.session) } catch { /* flush 失败不阻断 */ }
  }
}
