/**
 * 全局钩子：动作闸 + 宿主审批接管（verified-T3 Q2-c、Q3-b；verified-T4 2c/3d）。
 * - tools/pre-execute（D05 第 7 条：prepend 注册，排在最外层；next() 只调用一次且
 *   放在 try 之外）：守卫判断在 try 内；非机器人会话 return next()；机器人会话先做
 *   禁用清单双保险（BOT_DENY_TOOLS，D03 先修项 A2），再调 hub.guardToolCall，拒绝按
 *   verified-T3 Q2-c 的形状返回 {kind:'deny', reason}；守卫自身出错时对机器人会话
 *   保守拒绝（fail closed），对普通会话 return next()。下游抛错原样向上传（next 在
 *   try 外，不会被 catch 吞掉重调）。
 * - approval/request（必须 prepend：api-remotes 的桌面转发器先注册且不调 next）：
 *   机器人会话调 hub.onHostApprovalRequest，deny 一律返回 'rejected'（never 策略下
 *   DSH 本来也会自动拒，这里双保险并生成中心审批单）；中心出错时对机器人会话同样
 *   返回 'rejected'（D05 第 6 条：失败即关闭，不把无人值守会话挂到桌面面板），
 *   非机器人会话 return next()。
 * 子代理（header.origin==='subagent'）不走机器人闸门：子代理的审批策略被钉成 never，
 * 且子代理会话不是机器人名册里的会话，guardToolCall 对非机器人一律 allow。
 */
import type { Hub } from '@agent-hub/core'
import { botDenyMessage } from './bot-tools.js'

export interface HookDeps {
  hub: Hub
  isBotSession(sessionId: string): boolean
}

/** 判定一次工具调用的执行方是否机器人根会话。 */
function botSessionOf(exec: any, isBotSession: (sessionId: string) => boolean): string | null {
  const sessionId = exec?.agent?.id
  if (sessionId === undefined || sessionId === null) return null
  if (exec?.agent?.session?.header?.origin === 'subagent') return null
  const id = String(sessionId)
  return isBotSession(id) ? id : null
}

/** 拒绝结果（verified-T3 Q2-c 的形状，模型看到中文原因）。 */
function denyOf(reason: string, code: string): { kind: 'deny'; reason: string; info: { name: string; code: string; reason: string } } {
  return { kind: 'deny', reason, info: { name: 'HubPolicyError', code, reason } }
}

/** 注册全部钩子；返回撤销函数（ctx.on 返回的 disposer 随插件 fiber 自动撤销，这里显式收集便于测试）。 */
export function registerGuardHooks(ctx: any, deps: HookDeps): () => void {
  // prepend：排在所有非 prepend 监听器外层，任何外层监听器直接给决定也绕不过动作闸。
  const offPreExecute = ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
    // try 里只做判定（算出 deny 或放行）；next() 在 try 外、只调用一次。
    let deny: { kind: 'deny'; reason: string; info: { name: string; code: string; reason: string } } | null = null
    let botId: string | null = null
    try {
      botId = botSessionOf(exec, deps.isBotSession)
      if (botId !== null) {
        // 双保险（D03 先修项 A2）：禁用清单里的工具名，不论全局层还是 preset 层，一律拒绝。
        const denyMessage = botDenyMessage(String(exec?.name ?? ''))
        if (denyMessage !== null) {
          deny = denyOf(denyMessage, 'HUB_BOT_TOOL')
        } else {
          const decision = deps.hub.guardToolCall(botId, String(exec?.name ?? ''), exec?.arguments)
          if (!decision.allow) deny = denyOf(decision.message, 'HUB_GUARD')
        }
      }
    } catch (error) {
      // 守卫自身出错：机器人会话保守拒绝（fail closed）；普通会话 return next()。
      console.error('[agent-hub] 动作闸执行出错:', error)
      if (botId !== null) deny = denyOf('中心动作闸暂时不可用，本次调用已被保守拒绝；请稍后在 hub_commit 里说明。', 'HUB_GUARD_ERROR')
    }
    if (deny !== null) return deny
    return next() // 下游抛错从这里原样向上传，不吞、不重调
  }, { prepend: true })

  const offApproval = ctx.on('approval/request', (req: any, next: () => Promise<unknown>) => {
    // 机器人身份判定不依赖 hub：中心出错时也能对机器人会话失败即关闭。
    let botId: string | null = null
    try {
      const sessionId = req?.agent?.id
      if (sessionId !== undefined && sessionId !== null && req?.agent?.session?.header?.origin !== 'subagent') {
        const id = String(sessionId)
        if (deps.isBotSession(id)) botId = id
      }
    } catch { /* 身份判定失败按非机器人处理 */ }
    if (botId === null) return next()
    try {
      const decision = deps.hub.onHostApprovalRequest(botId, String(req?.toolName ?? ''), String(req?.reason ?? ''))
      if (decision === 'deny') return 'rejected' // 审批瀑布的四个合法返回值之一
      return next()
    } catch (error) {
      // D05 第 6 条：中心出错时机器人会话失败即关闭，绝不交给桌面面板挂着等人点。
      console.error('[agent-hub] 宿主审批接管出错（对机器人会话拒绝）:', error)
      return 'rejected'
    }
  }, { prepend: true })

  return () => {
    try { offPreExecute() } catch { /* 忽略 */ }
    try { offApproval() } catch { /* 忽略 */ }
  }
}
