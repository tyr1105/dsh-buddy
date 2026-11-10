/**
 * 测试用的假后端（看板 P58）：替换全局 fetch，行为和真实宿主对齐。
 *
 * 为什么要对齐这几点：P58 的问题正是这些细节凑出来的。
 * - /bot 查不到队友时报错（真实 core 的 requireBot）；
 * - /thread 查不到队友时仍返回 200，标题是「已删除的队友」（P48 的决定）；
 * - 总览里的名册随时可以改，用来模拟队友被删、被新建、数据被清空。
 *
 * 另外记下每一次请求，测试才能断言「没有再用这个 id 发请求」。
 */
import { vi } from 'vitest'

/** 名册里的一行：测试只关心 id 和是否退役、归档。 */
export interface RosterRow { id: string; lifecycle: string; archived?: boolean }

export interface FakeRosterBackend {
  /** 当前名册：直接改它，就相当于队友被删或被新建。 */
  roster: RosterRow[]
  /** 断网：所有请求直接失败，和浏览器 fetch 抛错一样。 */
  offline: boolean
  /** 总览接口报的错；null 表示正常。引擎没起来等情况用它模拟。 */
  overviewFailure: string | null
  /** 用这个对象替换总览的返回；停用时的占位总览用它模拟。 */
  overviewOverride: unknown
  /** 用这个对象替换项目视图的返回；要让线程头显示工作会话时用它放几条任务。 */
  projectOverride: unknown
  /** 查不到队友时 /bot 报的错。可以换文案，用来证明判断不靠文案。 */
  missingBotError: string
  /** 非空时 /bot 对任何 id 都报这个错，模拟「队友还在，但详情接口坏了」。 */
  botFailure: string | null
  /** 为真时，总览的响应算好后先卡住，等 releaseOverviews 才放行，用来排请求先后。 */
  pauseOverview: boolean
  /** 放行所有卡住的总览响应（先发出的先放行）。 */
  releaseOverviews(): void
  /** 全部请求的路径（去掉 api/agent-hub/ 前缀），按发出顺序。 */
  calls: string[]
  /** 取出按 id 请求某种接口的记录，kind 是 bot 或 thread。 */
  byId(kind: 'bot' | 'thread', id: string): string[]
}

/** 把一串 id 变成名册：默认都是在岗的队友。 */
export function rosterOf(ids: readonly string[]): RosterRow[] {
  return ids.map(id => ({ id, lifecycle: 'active' }))
}

/** 建假后端并装到全局 fetch；用 vi.unstubAllGlobals 卸载。 */
export function fakeRosterBackend(ids: readonly string[] = []): FakeRosterBackend {
  const paused: Array<() => void> = []

  /** 按路径算出接口的回答；和真实接口一样，收到请求时就决定了结果。 */
  const respond = (path: string): { status: number; body: unknown } => {
    const id = new URLSearchParams(path.split('?')[1] ?? '').get('id') ?? ''
    if (path.startsWith('overview')) {
      if (backend.overviewFailure !== null) return { status: 500, body: { ok: false, error: backend.overviewFailure } }
      return { status: 200, body: backend.overviewOverride ?? { bots: backend.roster } }
    }
    if (path.startsWith('bot?')) {
      if (backend.botFailure !== null) return { status: 500, body: { ok: false, error: backend.botFailure } }
      if (!backend.roster.some(row => row.id === id)) return { status: 500, body: { ok: false, error: backend.missingBotError } }
      return { status: 200, body: { card: { id } } }
    }
    if (path.startsWith('thread?')) {
      return { status: 200, body: { threadId: id, title: id, messages: [], hasMore: false, oldestId: null } }
    }
    if (path.startsWith('inbox')) return { status: 200, body: { items: [] } }
    if (path.startsWith('activity')) return { status: 200, body: { rows: [], hasMore: false } }
    // 中心页渲染时会遍历项目列表，这里给一个合法的空视图。
    if (path.startsWith('project')) return { status: 200, body: backend.projectOverride ?? { asOf: 0, projects: [], counts: {} } }
    if (path.startsWith('command')) return { status: 200, body: { ok: true } }
    return { status: 200, body: {} }
  }

  const backend: FakeRosterBackend = {
    roster: rosterOf(ids),
    offline: false,
    overviewFailure: null,
    overviewOverride: null,
    projectOverride: null,
    missingBotError: 'botId：机器人不存在',
    botFailure: null,
    pauseOverview: false,
    releaseOverviews() { paused.splice(0).forEach(release => release()) },
    calls: [],
    byId(kind, id) {
      return backend.calls.filter(path => path.startsWith(`${kind}?`) && new URLSearchParams(path.slice(kind.length + 1)).get('id') === id)
    },
  }

  vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
    const path = String(input).replace(/^.*agent-hub\//, '')
    backend.calls.push(path)
    if (backend.offline) throw new TypeError('Failed to fetch')
    const answer = respond(path)
    if (path.startsWith('overview') && backend.pauseOverview) await new Promise<void>(resolve => paused.push(resolve))
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  })
  return backend
}

/**
 * 等所有异步收尾。假接口要走好几轮 Promise，断言「没有发生某个请求」之前，
 * 必须确认后续动作已经跑完，否则没发请求可能只是还没轮到。
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise(resolve => setTimeout(resolve, 0))
}
