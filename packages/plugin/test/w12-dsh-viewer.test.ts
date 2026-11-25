/** W12：在 DSH 自带的文件预览里看（logic/dsh-viewer.ts）。DSH 的服务一律用替身。 */
import { describe, expect, it } from 'vitest'
import { sessionFileAddress, viewInDsh, type ViewerTiming } from '../src/client/logic/dsh-viewer.js'

const PATH = '/Users/tyr/AgentHub/projects/prj_1/jobs/job_1/交付/现状梳理与下一步建议.md'
const fast: ViewerTiming = { wait: async () => {}, attempts: 5, stepMs: 0 }

function fakeCtx(opts: { mountAfter?: number; throwTimes?: number; noSidebar?: boolean; sessionIds?: string[] } = {}) {
  const calls: Array<{ address: string; options: unknown }> = []
  const opened: string[] = []
  let reads = 0
  let throws = opts.throwTimes ?? 0
  const sidebar = {
    mounted: { getSnapshot: () => (reads++ >= (opts.mountAfter ?? 0) ? opened.at(-1) : undefined) },
    openResource(address: string, options: unknown) {
      if (throws > 0) { throws--; throw new Error('no store yet') }
      calls.push({ address, options })
    },
  }
  const services: Record<string, unknown> = {
    sidebarRight: opts.noSidebar ? undefined : sidebar,
    uiWorkspace: { openSession: (id: string) => { opened.push(id) } },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: opts.sessionIds ?? ['sess-exec'] }) } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }) } },
  }
  const ctx = { get: (name: string) => services[name] }
  let toChat = 0
  return { host: { ctx, toChat: () => { toChat++ } }, calls, opened, toChatCount: () => toChat }
}

describe('sessionFileAddress', () => {
  it('与 DSH 的写法一致：绝对路径保留前导斜杠，逐段编码', () => {
    expect(sessionFileAddress('s', '/etc/hosts')).toBe('dsh-resource://file/session/s//etc/hosts')
    expect(sessionFileAddress('sess-1', '/a/交付/b c.md')).toBe(`dsh-resource://file/session/sess-1//a/${encodeURIComponent('交付')}/b%20c.md`)
  })
})

describe('viewInDsh', () => {
  it('切回对话侧，打开员工的工作会话，等会话上屏后在右侧边栏打开文件', async () => {
    const f = fakeCtx({ mountAfter: 2, throwTimes: 1 })
    expect(await viewInDsh('sess-exec', PATH, fast, f.host)).toBeNull()
    expect(f.toChatCount()).toBe(1)
    expect(f.opened).toEqual(['sess-exec'])
    expect(f.calls).toEqual([{ address: sessionFileAddress('sess-exec', PATH), options: { destination: 'sidebar' } }])
  })

  it('没有侧栏服务、会话不存在、一直没上屏：返回原因，不抛出', async () => {
    expect(await viewInDsh('sess-exec', PATH, fast, fakeCtx({ noSidebar: true }).host)).toBe('这个版本的 DSH 没有文件预览')
    expect(await viewInDsh('sess-exec', PATH, fast, fakeCtx({ sessionIds: ['other'] }).host)).toBe('打不开员工的工作会话')
    const never = fakeCtx({ mountAfter: 99 })
    expect(await viewInDsh('sess-exec', PATH, fast, never.host)).toBe('DSH 的文件预览没有响应')
    expect(never.calls).toEqual([])
    expect(await viewInDsh('sess-exec', PATH, fast, null)).toBe('界面还没准备好')
  })
})
