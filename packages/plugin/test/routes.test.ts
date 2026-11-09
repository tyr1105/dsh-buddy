/** 路由：path/methods/requestBody 与 JSON 形状（与 15.1 一致）；处理函数抛错返回 500 且 ok:false。 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import { buildRoutes, buildGuardedRoutes, registerRoutes } from '../src/host/routes.js'
import type { OverviewView, ThreadView } from '../src/shared/views.js'

const hub = new FixtureHub()

function call(pathWithQuery: string, init?: RequestInit): Promise<Response> {
  const path = pathWithQuery.split('?')[0]!
  // 走兜错后的版本（与真实注册的一致）。
  const route = buildGuardedRoutes(hub).find((r) => r.path === path)!
  return route.fetch(new Request(`http://host${pathWithQuery}`, init))
}

describe('路由注册（假 ctx 记录 fetch.register 调用）', () => {
  it('注册了 13 条路由', () => {
    const { ctx, fetchRoutes } = createFakeCtx()
    registerRoutes(ctx as never, hub)
    expect(fetchRoutes).toHaveLength(13)
  })
  it('读路由全部是 GET + requestBody buffered；写路由是 POST', () => {
    for (const route of buildRoutes(hub)) {
      expect(route.requestBody).toBe('buffered')
      if (route.path.endsWith('/command')) expect(route.methods).toEqual(['POST'])
      else expect(route.methods).toEqual(['GET'])
    }
  })
  it('路径都在 /api/agent-hub/ 下且每段合法', () => {
    for (const route of buildRoutes(hub)) {
      expect(route.path.startsWith('/api/agent-hub/')).toBe(true)
      for (const seg of route.path.split('/').slice(2)) expect(seg).toMatch(/^[A-Za-z0-9_$.-]+$/)
    }
  })
})

describe('GET overview', () => {
  it('返回 15.1 的 OverviewView 形状', async () => {
    const res = await call('/api/agent-hub/overview')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    const data = await res.json() as OverviewView
    expect(data.bots).toHaveLength(3)
    expect(data.quota).toHaveProperty('light')
    expect(data.quota).toHaveProperty('usedText')
    expect(data.health).toHaveProperty('heartbeatText')
    expect(typeof data.nowText).toBe('string')
    expect(typeof data.quietNow).toBe('boolean')
  })
  it('BotCard 逐字段（抽查关键字段名不得改）', async () => {
    const data = await (await call('/api/agent-hub/overview')).json() as OverviewView
    const b = data.bots[0]
    for (const key of ['id', 'name', 'role', 'roleLabel', 'color', 'initials', 'lifecycle', 'lifecycleLabel', 'activity', 'activityLabel', 'activityText', 'nextThinkText', 'lastOutcome', 'lastOutcomeLabel', 'lastActiveText', 'unread', 'todayThinks', 'todayBudget', 'todayTokens', 'waitingOwner']) {
      expect(b).toHaveProperty(key)
    }
  })
})

describe('GET thread', () => {
  it('返回 15.1 的 ThreadView 并带分页字段', async () => {
    const data = await (await (call('/api/agent-hub/thread?id=bot-tanlu&limit=3'))).json() as ThreadView
    expect(data.threadId).toBe('bot-tanlu')
    expect(data.messages).toHaveLength(3)
    expect(data.hasMore).toBe(true)
    expect(data.oldestId).toBeTypeOf('string')
  })
  it('before + limit 生效（分页）', async () => {
    const full = await (await call('/api/agent-hub/thread?id=team')).json() as ThreadView
    const limited = await (await call('/api/agent-hub/thread?id=team&limit=2')).json() as ThreadView
    expect(limited.messages).toHaveLength(2)
    expect(limited.hasMore).toBe(true)
    // 最后一页的最后一条 = 全量列表的倒数第二条之前的两条（limit=2 取末尾两条）。
    expect(limited.messages[0]!.id).toBe(full.messages.at(-2)!.id)
    expect(limited.messages[1]!.id).toBe(full.messages.at(-1)!.id)
    const earlier = await (await call(`/api/agent-hub/thread?id=team&before=${limited.oldestId}&limit=2`)).json() as ThreadView
    expect(earlier.messages.every((m) => m.id !== limited.oldestId)).toBe(true)
  })
  it('缺 id 报 500 + ok:false', async () => {
    const res = await call('/api/agent-hub/thread')
    expect(res.status).toBe(500)
    const body = await res.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('id')
  })
})

describe('POST command', () => {
  it('sendMessage 成功并把主人消息追加进线程', async () => {
    const before = await (await call('/api/agent-hub/thread?id=team')).json() as ThreadView
    const res = await call('/api/agent-hub/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sendMessage', input: { threadId: 'team', text: '主人来过' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const after = await (await call('/api/agent-hub/thread?id=team')).json() as ThreadView
    expect(after.messages.length).toBe(before.messages.length + 1)
    expect(after.messages.at(-1)!.from).toBe('owner')
    expect(after.messages.at(-1)!.text).toBe('主人来过')
  })
  it('sendMessage 触发 changed 事件（thread + overview）', async () => {
    const events: string[] = []
    const h = new FixtureHub()
    h.subscribe((e) => events.push(e.scope))
    const route = buildRoutes(h).find((r) => r.path.endsWith('/command'))!
    await route.fetch(new Request('http://host/api/agent-hub/command', { method: 'POST', body: JSON.stringify({ name: 'sendMessage', input: { threadId: 'team', text: '再看一条' } }) }))
    expect(events).toContain('thread')
    expect(events).toContain('overview')
  })
  it('缺命令名报 400', async () => {
    const res = await call('/api/agent-hub/command', { method: 'POST', body: JSON.stringify({ input: {} }) })
    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBe(false)
  })
  it('请求体不是 JSON 报 400', async () => {
    const res = await call('/api/agent-hub/command', { method: 'POST', body: 'not-json' })
    expect(res.status).toBe(400)
  })
  it('未知命令返回 ok:true（D01 样例模式）', async () => {
    const res = await call('/api/agent-hub/command', { method: 'POST', body: JSON.stringify({ name: 'markThreadRead', input: { threadId: 'team' } }) })
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('其余 GET 路由', () => {
  it('bot?id= 返回 BotView（含 appraisals / wakes / stats）', async () => {
    const data = await (await call('/api/agent-hub/bot?id=bot-xunjian')).json() as Record<string, unknown>
    for (const key of ['card', 'profile', 'aspirations', 'goals', 'agenda', 'watches', 'routines', 'rules', 'memoryExcerpt', 'wakes', 'appraisals', 'stats']) {
      expect(data).toHaveProperty(key)
    }
  })
  it('bot 不存在报 500', async () => {
    const res = await call('/api/agent-hub/bot?id=bot-none')
    expect(res.status).toBe(500)
  })
  it('inbox 返回 3 项且形状正确', async () => {
    const data = await (await call('/api/agent-hub/inbox')).json() as { items: unknown[] }
    expect(data.items).toHaveLength(3)
  })
  it('activity 返回 10 条且带 hasMore', async () => {
    const data = await (await call('/api/agent-hub/activity')).json() as { rows: unknown[]; hasMore: boolean }
    expect(data.rows).toHaveLength(10)
    expect(typeof data.hasMore).toBe('boolean')
  })
  it('settings 与 recent-sessions 可用', async () => {
    const settings = await (await call('/api/agent-hub/settings')).json() as { settings: { rootDir: string } }
    expect(settings.settings.rootDir).toBeTypeOf('string')
    const sessions = await (await call('/api/agent-hub/recent-sessions')).json() as unknown[]
    expect(sessions.length).toBeGreaterThan(0)
  })
  it('office 返回办公室投影（F03）：座位就是一位在岗队友，带灯与房间健康', async () => {
    const data = await (await call('/api/agent-hub/office')).json() as {
      asOf: number; seats: Array<{ botId: string; title: string; occupant: { name: string }; light: string; lightLabel: string }>
      doorway: { count: number }; health: { ok: boolean }; truncated: boolean
    }
    expect(typeof data.asOf).toBe('number')
    expect(data.seats.length).toBeGreaterThan(0)
    expect(data.seats[0]!.botId).toBeTypeOf('string')
    expect(data.seats[0]!.occupant.name).toBeTypeOf('string')
    expect(data.seats[0]!.light).toBeTypeOf('string')
    expect(data.seats[0]!.lightLabel).toBeTypeOf('string')
    expect(typeof data.doorway.count).toBe('number')
    expect(typeof data.health.ok).toBe('boolean')
    expect(data.truncated).toBe(false)
    // 编制取消：办公室不再有部门分组、来源与板凳字段。
    expect(data).not.toHaveProperty('departments')
    expect(data).not.toHaveProperty('source')
    expect(data).not.toHaveProperty('bench')
  })
  it('org 路由已随编制移除：路由表里没有 /api/agent-hub/org', () => {
    expect(buildRoutes(hub).some(r => r.path === '/api/agent-hub/org')).toBe(false)
  })
  it('resource 返回资料授权矩阵（V2-PH2-04）：有资料行、授权行与计数', async () => {
    const data = await (await call('/api/agent-hub/resource')).json() as {
      asOf: number
      resources: Array<{ resource: { id: string; name: string; kind: string }; kindLabel: string; sensitivityLabel: string; archived: boolean; grants: unknown[] }>
      grants: unknown[]
      counts: { total: number; active: number; archived: number; grants: number }
    }
    expect(typeof data.asOf).toBe('number')
    expect(data.resources.length).toBeGreaterThan(0)
    // 未归档在前、已归档在后（core resourceView 的排序契约）。
    const archivedAt = data.resources.findIndex(r => r.archived)
    if (archivedAt >= 0) expect(data.resources.slice(archivedAt).every(r => r.archived)).toBe(true)
    for (const key of ['kindLabel', 'sensitivityLabel', 'grants']) expect(data.resources[0]!).toHaveProperty(key)
    expect(data.grants.length).toBeGreaterThan(0)
    expect(data.counts).toEqual({
      total: data.resources.length,
      active: data.resources.filter(r => !r.archived).length,
      archived: data.resources.filter(r => r.archived).length,
      grants: data.grants.length,
    })
  })
  it('project 返回项目容器（V2-PH4-02）：有项目行、任务展开与计数', async () => {
    const data = await (await call('/api/agent-hub/project')).json() as {
      asOf: number
      projects: Array<{ project: { id: string; status: string }; tasks: unknown[]; issues: unknown[] }>
      counts: { active: number; paused: number; done: number; archived: number; total: number; tasksTotal: number; tasksPendingCheck: number }
    }
    expect(typeof data.asOf).toBe('number')
    expect(data.projects).toHaveLength(5)
    // 归档项目沉底（core projectView 的排序契约）。
    expect(data.projects.at(-1)!.project.status).toBe('archived')
    // 计数与行内容一致：总数、任务合计、待验收一条（pt_weekly_5）。
    expect(data.counts.total).toBe(5)
    expect(data.counts.tasksTotal).toBe(10)
    expect(data.counts.tasksPendingCheck).toBe(1)
    expect(data.counts.tasksTotal).toBe(data.projects.reduce((n, row) => n + row.tasks.length, 0))
  })
})

describe('GET wake-ledger / wake-ledger-detail（F02 最小读法）', () => {
  it('按机器人返回账本摘要列表（含回填 / 完整度标签）', async () => {
    const res = await call('/api/agent-hub/wake-ledger?botId=bot-tanlu')
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<{ wakeId: string; sourceLabel: string; completenessLabel: string; openedText: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(row => row.sourceLabel === '回填')).toBe(true)
    expect(rows.every(row => typeof row.openedText === 'string')).toBe(true)
  })
  it('limit 生效；缺 botId 报 500 且 ok:false', async () => {
    const limited = await (await call('/api/agent-hub/wake-ledger?botId=bot-tanlu&limit=1')).json() as unknown[]
    expect(limited).toHaveLength(1)
    const res = await call('/api/agent-hub/wake-ledger')
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
  it('详情返回完整账本；未知唤醒单返回 null；缺 wakeId 报 500', async () => {
    const data = await (await call('/api/agent-hub/wake-ledger-detail?wakeId=wk2')).json() as { entry?: { source: string }; row?: { wakeId: string } }
    expect(data.entry?.source).toBe('live')
    expect(data.row?.wakeId).toBe('wk2')
    expect(await (await call('/api/agent-hub/wake-ledger-detail?wakeId=no-such')).json()).toBeNull()
    const res = await call('/api/agent-hub/wake-ledger-detail')
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})

describe('处理函数兜错', () => {
  it('hub 抛错时返回 500 且 ok:false（不冒泡）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const badHub = {
      ...hub,
      overview: async () => { throw new Error('引擎没了') },
    }
    const route = buildGuardedRoutes(badHub as never).find((r) => r.path.endsWith('/overview'))!
    const res = await route.fetch(new Request('http://host/api/agent-hub/overview'))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    error.mockRestore()
  })
})
