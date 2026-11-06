/**
 * 宿主接口封装：fetch('api/agent-hub/…')，文档相对路径、同源 cookie，不加任何鉴权头
 * （鉴权由宿主 Connection 的 Cookie 完成；桌面版由主进程转发并补 cookie，verified-T5 Q3-1）。
 * 所有请求失败都抛带一句中文原因的 Error，界面只管显示与「重试」。
 */
import type {
  ActivityView, BotView, CommandResult, InboxView, OverviewView, RecentSessionView, SettingsView, ThreadView,
} from '../shared/views.js'

const BASE = 'api/agent-hub'

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}/${path}`, { credentials: 'same-origin' })
  } catch {
    throw new Error('连不上 Agent 中心（网络错误）')
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
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
    return { ok: false, error: '连不上 Agent 中心（网络错误）' }
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
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
  recentSessions: (): Promise<RecentSessionView[]> => getJson('recent-sessions'),
  command: postCommand,
}

/** SSE 变化事件的载荷（与宿主 hub-facade 的 ChangedEvent 一致）。 */
export interface ChangedEvent { scope: string; botId?: string }
