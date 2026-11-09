/**
 * 宿主接口封装：fetch('api/agent-hub/…')，文档相对路径、同源 cookie，不加任何鉴权头
 * （鉴权由宿主 Connection 的 Cookie 完成；桌面版由主进程转发并补 cookie，verified-T5 Q3-1）。
 * 所有请求失败都抛带一句中文原因的 Error，界面只管显示与「重试」。
 */
import type {
  ActivityView, BotView, CommandResult, InboxView, OfficeView, OverviewView, ProjectView, RecentSessionView, ResourceView, SettingsView,
  ThreadView, WakeLedgerRow, WakeLedgerView,
} from '../shared/views.js'

const BASE = 'api/agent-hub'

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}/${path}`, { credentials: 'same-origin' })
  } catch {
    throw new Error('连接中断。点击重试；仍失败请确认 DSH 是否已关闭。')
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）。点击重试。`
    try {
      const body = await response.json() as { error?: string }
      if (body?.error) message = body.error
    } catch { /* 保持默认文案 */ }
    throw new Error(message)
  }
  return await response.json() as T
}

/** POST command：JSON { name, input } → CommandResult。 */
async function postCommand(name: string, input: Record<string, unknown>): Promise<CommandResult> {
  let response: Response
  try {
    response = await fetch(`${BASE}/command`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name, input }),
    })
  } catch {
    return { ok: false, error: '连接中断。点击重试；仍失败请确认 DSH 是否已关闭。' }
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）。点击重试。`
    try {
      const body = await response.json() as { error?: string }
      if (body?.error) message = body.error
    } catch { /* 保持默认文案 */ }
    return { ok: false, error: message }
  }
  return await response.json() as CommandResult
}

export const api = {
  overview: (): Promise<OverviewView> => getJson('overview'),
  bot: (id: string): Promise<BotView> => getJson(`bot?id=${encodeURIComponent(id)}`),
  thread: (id: string, opts?: { before?: string; limit?: number }): Promise<ThreadView> => {
    const params = new URLSearchParams({ id })
    if (opts?.before) params.set('before', opts.before)
    if (opts?.limit) params.set('limit', String(opts.limit))
    return getJson(`thread?${params.toString()}`)
  },
  inbox: (): Promise<InboxView> => getJson('inbox'),
  activity: (opts?: { before?: string; limit?: number }): Promise<ActivityView> => {
    const params = new URLSearchParams()
    if (opts?.before) params.set('before', opts.before)
    if (opts?.limit) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return getJson(qs ? `activity?${qs}` : 'activity')
  },
  settings: (): Promise<SettingsView> => getJson('settings'),
  /** 办公室纯投影（F03）：座位、灯、桌上产出、门口信箱与房间健康。 */
  office: (): Promise<OfficeView> => getJson('office'),
  /** 资料授权矩阵（V2-PH2-04）：资料列表、授权展开行与计数。 */
  resource: (): Promise<ResourceView> => getJson('resource'),
  /** 项目容器（V2-PH4-02）：项目分区、任务展开与问题计数；写操作统一走 command。 */
  project: (): Promise<ProjectView> => getJson('project'),
  recentSessions: (): Promise<RecentSessionView[]> => getJson('recent-sessions'),
  /** 某机器人的最近账本摘要（按需加载，不参与全局轮询）。 */
  wakeLedger: (botId: string, opts?: { limit?: number; before?: number }): Promise<WakeLedgerRow[]> => {
    const params = new URLSearchParams({ botId })
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.before !== undefined) params.set('before', String(opts.before))
    return getJson(`wake-ledger?${params.toString()}`)
  },
  /** 一次唤醒的完整账本；没有记录时返回 null。 */
  wakeLedgerDetail: (wakeId: string): Promise<WakeLedgerView | null> =>
    getJson(`wake-ledger-detail?wakeId=${encodeURIComponent(wakeId)}`),
  command: postCommand,
}

/** SSE 变化事件的载荷（与宿主 hub-facade 的 ChangedEvent 一致）。 */
export interface ChangedEvent { scope: string; botId?: string }
