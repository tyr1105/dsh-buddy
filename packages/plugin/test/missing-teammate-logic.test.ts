/**
 * 选中的队友已不存在的判断规则（看板 P58）：只测纯函数，每条规则都有正例和反例。
 * 仓库和页面的接线在 missing-teammate-store 与 missing-teammate-wiring 两个测试文件里。
 */
import { describe, expect, it } from 'vitest'
import type { HubState } from '../src/client/hub-state.js'
import {
  canRequestById, exitMissingSelection, isMissingFromRoster, isMissingTopic, nextGoneIds, nextGoneTopicIds, rosterIds,
  shouldExitSelection, shouldExitTopicSelection, TEAM_THREAD_ID,
} from '../src/client/logic/missing-teammate.js'
import { DisabledHub } from '../src/host/real-hub.js'
import type { OverviewView, ProjectView } from '../src/shared/views.js'

/** 造一份只有队友 id 的总览；判断规则只看这一项。 */
function roster(...ids: string[]): OverviewView {
  return { bots: ids.map(id => ({ id })) } as unknown as OverviewView
}

describe('rosterIds：这份总览能不能当名册用', () => {
  it('正常总览：返回全部 id', () => {
    expect([...rosterIds(roster('b_1', 'b_2'))!]).toEqual(['b_1', 'b_2'])
  })
  it('空名册也是有效答案：队友确实一个都没有', () => {
    expect(rosterIds(roster())?.size).toBe(0)
  })
  it('还没加载：不知道，不是没有', () => {
    expect(rosterIds(null)).toBeNull()
  })
  it('接口返回的形状不对：不当名册用', () => {
    expect(rosterIds({} as unknown as OverviewView)).toBeNull()
  })
  it('中心停用时的空占位：不当名册用（用真实的 DisabledHub 验证标记确实带上了）', async () => {
    const placeholder = await new DisabledHub('中心已停用').overview() as unknown as OverviewView
    expect(placeholder.bots).toEqual([])
    expect(rosterIds(placeholder)).toBeNull()
  })
})

describe('isMissingFromRoster：名册明确说没有', () => {
  it('正例：名册里没有这个 id', () => {
    expect(isMissingFromRoster('b_gone', roster('b_1'))).toBe(true)
  })
  it('正例：名册是空的', () => {
    expect(isMissingFromRoster('b_gone', roster())).toBe(true)
  })
  it('反例：名册里有它', () => {
    expect(isMissingFromRoster('b_1', roster('b_1'))).toBe(false)
  })
  it('反例：退役、归档的队友还在名册里', () => {
    const overview = { bots: [{ id: 'b_old', lifecycle: 'retired', archived: true }] } as unknown as OverviewView
    expect(isMissingFromRoster('b_old', overview)).toBe(false)
  })
  it('反例：团队线程不是队友，名册空着也不算', () => {
    expect(isMissingFromRoster(TEAM_THREAD_ID, roster())).toBe(false)
  })
  it('反例：名册不可用时一律不下结论', () => {
    expect(isMissingFromRoster('b_gone', null)).toBe(false)
    expect(isMissingFromRoster('b_gone', { bots: [], rosterUnavailable: true } as unknown as OverviewView)).toBe(false)
  })
})

describe('nextGoneIds：哪些 id 已确认消失', () => {
  it('正例：上一份名册里有、这一份没有', () => {
    expect([...nextGoneIds(new Set(), roster('b_1', 'b_2'), roster('b_2'))]).toEqual(['b_1'])
  })
  it('反例：从没在名册里出现过的 id 不算消失，它可能是刚建好的', () => {
    expect([...nextGoneIds(new Set(), roster('b_1'), roster('b_1'))]).toEqual([])
  })
  it('反例：重新出现的 id 要移出去（比如沙箱数据被恢复）', () => {
    expect([...nextGoneIds(new Set(['b_1']), roster(), roster('b_1'))]).toEqual([])
  })
  it('反例：新名册不可用时什么都不改，旧的结论也保留', () => {
    const gone = new Set(['b_1'])
    expect(nextGoneIds(gone, roster('b_2'), null)).toBe(gone)
    expect(nextGoneIds(gone, roster('b_2'), { bots: [], rosterUnavailable: true } as unknown as OverviewView)).toBe(gone)
  })
  it('反例：上一份不可用时（第一次加载、或停用恢复后）没有可比的，不算消失', () => {
    expect([...nextGoneIds(new Set(), null, roster('b_1'))]).toEqual([])
    expect([...nextGoneIds(new Set(), { bots: [], rosterUnavailable: true } as unknown as OverviewView, roster())]).toEqual([])
  })
})

describe('shouldExitSelection：这份名册落地后要不要退出', () => {
  const check = { selectedThread: 'b_1', roster: roster(), selectedAfterRequest: false, goneIds: new Set<string>() }
  it('正例：名册比选中新、里面没有它', () => {
    expect(shouldExitSelection(check)).toBe(true)
  })
  it('反例：名册里有它', () => {
    expect(shouldExitSelection({ ...check, roster: roster('b_1') })).toBe(false)
  })
  it('反例：选中的是团队线程', () => {
    expect(shouldExitSelection({ ...check, selectedThread: TEAM_THREAD_ID })).toBe(false)
  })
  it('反例：这份名册比选中旧，可能只是队友刚建好', () => {
    expect(shouldExitSelection({ ...check, selectedAfterRequest: true })).toBe(false)
  })
  it('正例：名册比选中旧，但它曾在名册里、现在没了，确实是被删了', () => {
    expect(shouldExitSelection({ ...check, selectedAfterRequest: true, goneIds: new Set(['b_1']) })).toBe(true)
  })
  it('反例：名册不可用', () => {
    expect(shouldExitSelection({ ...check, roster: null })).toBe(false)
  })
})

describe('canRequestById：现在能不能按 id 请求', () => {
  const check = { id: 'b_1', goneIds: new Set<string>(), selectedThread: 'b_1', rosterLoaded: true, selectedThisSession: false }
  it('正例：名册已到，它没被判定消失', () => {
    expect(canRequestById(check)).toBe(true)
  })
  it('正例：团队线程任何时候都可以', () => {
    expect(canRequestById({ ...check, id: TEAM_THREAD_ID, selectedThread: TEAM_THREAD_ID, rosterLoaded: false })).toBe(true)
  })
  it('正例：名册没到，但这是主人刚点选的（来自名册或刚新建），不用等', () => {
    expect(canRequestById({ ...check, rosterLoaded: false, selectedThisSession: true })).toBe(true)
  })
  it('正例：名册没到，但问的不是当前选中，没有「本地恢复」的疑问', () => {
    expect(canRequestById({ ...check, selectedThread: TEAM_THREAD_ID, rosterLoaded: false })).toBe(true)
  })
  it('反例：名册已确认它不存在', () => {
    expect(canRequestById({ ...check, goneIds: new Set(['b_1']) })).toBe(false)
  })
  it('反例：从本地恢复的选中，第一份名册还没到', () => {
    expect(canRequestById({ ...check, rosterLoaded: false })).toBe(false)
  })
})

describe('exitMissingSelection：把选中退回团队全景', () => {
  const state = { selectedThread: 'b_gone', view: 'main', selectionExitSeq: 2 } as unknown as HubState

  it('回到团队线程，次数加一', () => {
    const next = exitMissingSelection(state)
    expect(next.selectedThread).toBe(TEAM_THREAD_ID)
    expect(next.selectionExitSeq).toBe(3)
  })
  it('反例：只改选中，不把主人从当前页面拽走', () => {
    expect(exitMissingSelection({ ...state, view: 'project' }).view).toBe('project')
  })
})

describe('项目主题（P63）：不在名册里，也不算已删除的队友', () => {
  const roster = { bots: [{ id: 'b_1' }] } as unknown as OverviewView
  const view = (ids: string[]): ProjectView => ({ projects: [{ topics: ids.map(id => ({ id })) }] }) as unknown as ProjectView

  it('主题 id 永远不算「名册里没有的队友」', () => {
    expect(isMissingFromRoster('ptp_1', roster)).toBe(false)
    expect(shouldExitSelection({ selectedThread: 'ptp_1', roster, goneIds: new Set(), selectedAfterRequest: false })).toBe(false)
  })

  it('主题不用等名册就能拉楼层；确认没了的不再拉', () => {
    const check = { id: 'ptp_1', goneIds: new Set<string>(), selectedThread: 'ptp_1', rosterLoaded: false, selectedThisSession: false }
    expect(canRequestById(check)).toBe(true)
    expect(canRequestById({ ...check, goneIds: new Set(['ptp_1']) })).toBe(false)
  })

  it('还在不在只看项目视图：有就不算缺失，没有才算', () => {
    expect(isMissingTopic('ptp_1', view(['ptp_1']))).toBe(false)
    expect(isMissingTopic('ptp_1', view(['ptp_2']))).toBe(true)
  })

  it('反例：不是主题、视图没到、形状不对、停用占位，都不下结论', () => {
    expect(isMissingTopic('b_1', view([]))).toBe(false)
    expect(isMissingTopic('ptp_1', null)).toBe(false)
    expect(isMissingTopic('ptp_1', {} as ProjectView)).toBe(false)
    expect(isMissingTopic('ptp_1', { ...view([]), rosterUnavailable: true })).toBe(false)
  })

  it('项目视图缺失后退回；但比这次选中旧的视图，不能判刚建好的主题没了', () => {
    const base = { selectedThread: 'ptp_new', project: view([]), goneIds: new Set<string>() }
    expect(shouldExitTopicSelection({ ...base, selectedAfterRequest: false })).toBe(true)
    expect(shouldExitTopicSelection({ ...base, selectedAfterRequest: true })).toBe(false)
  })

  it('例外：它原来在视图里、现在没了，确实是被删了，旧视图也算数', () => {
    expect(shouldExitTopicSelection({ selectedThread: 'ptp_1', project: view([]), goneIds: new Set(['ptp_1']), selectedAfterRequest: true })).toBe(true)
  })

  it('nextGoneTopicIds：上一份有、这一份没有才算消失；重新出现的移出去', () => {
    expect([...nextGoneTopicIds(new Set(), view(['ptp_1']), view([]))]).toEqual(['ptp_1'])
    expect([...nextGoneTopicIds(new Set(['ptp_1']), view([]), view(['ptp_1']))]).toEqual([])
    expect([...nextGoneTopicIds(new Set(), null, view([]))]).toEqual([])
  })
})
