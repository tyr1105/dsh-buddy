/**
 * 队友右侧边栏的内容规则测试（P64）：忙碌状态、额度、在办的事。
 * 全是纯函数，每条规则一个正例一个反例；工作会话用 shared/fixture-project 的样例，和预览里看到的一致。
 */
import { describe, expect, it } from 'vitest'
import type { Activity, BotCard, CostView } from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { collectWorkSessions, sessionsForBot } from '../src/client/logic/work-session.js'
import {
  NO_ACTIVE_WORK_TEXT, activeWorkGroups, teammateBusy, teammateQuota, tokensToday,
} from '../src/client/logic/teammate-panel.js'

type BusyInput = Pick<BotCard, 'lifecycle' | 'activity' | 'activityText' | 'waitingOwner'>

/** 一位在岗、空闲的队友；每条用例只改自己关心的字段。 */
function card(patch: Partial<BusyInput> = {}): BusyInput {
  return { lifecycle: 'active', activity: 'watching', activityText: '在盯着：3 项', waitingOwner: false, ...patch }
}

describe('teammateBusy：一句人话说清在忙什么', () => {
  it('正在处理：结论是「正在忙」，细节原样用 core 写好的活动句', () => {
    expect(teammateBusy(card({ activity: 'thinking', activityText: '正在处理：数据日报没出' })))
      .toEqual({ tone: 'busy', label: '正在忙', detail: '正在处理：数据日报没出' })
  })

  it('盯着和休息都算空闲', () => {
    expect(teammateBusy(card()).label).toBe('空闲')
    expect(teammateBusy(card({ activity: 'resting', activityText: '额度保护，明天 09:00 恢复' })).label).toBe('空闲')
  })

  it('活动状态就是等主人：活动句说得清等什么，原样用', () => {
    expect(teammateBusy(card({ activity: 'waiting_owner', activityText: '等你：要不要改频率？', waitingOwner: true })))
      .toEqual({ tone: 'waiting', label: '在等你', detail: '等你：要不要改频率？' })
  })

  it('有问题等主人但活动句在说别的：换成告诉主人去哪处理的提示', () => {
    const busy = teammateBusy(card({ waitingOwner: true }))
    expect(busy.label).toBe('在等你')
    expect(busy.detail).toBe('有事等你回复，去「待你处理」看看。')
  })

  it('反例：模型正在跑时，就算有问题等主人，当下的回答也是「正在忙」', () => {
    expect(teammateBusy(card({ activity: 'thinking', activityText: '正在处理：周报', waitingOwner: true })).label).toBe('正在忙')
  })

  it('暂停后按生命周期说话，不看残留的活动状态', () => {
    expect(teammateBusy(card({ lifecycle: 'paused', activity: 'thinking', activityText: '状态已更新，当前回合等待结束' })))
      .toEqual({ tone: 'off', label: '已暂停', detail: '状态已更新，当前回合等待结束' })
  })

  it('活动句开头已经是结论：合成一句，不写两遍', () => {
    expect(teammateBusy(card({ lifecycle: 'paused', activity: 'resting', activityText: '已暂停（你暂停的）' })))
      .toEqual({ tone: 'off', label: '已暂停（你暂停的）', detail: null })
    expect(teammateBusy(card({ lifecycle: 'retired', activity: 'resting', activityText: '已退役' })))
      .toEqual({ tone: 'off', label: '已退役', detail: null })
  })

  it('反例：活动句为空时用兜底说法，不留一块空白', () => {
    expect(teammateBusy(card({ activityText: '  ' }))).toEqual({ tone: 'idle', label: '空闲', detail: '现在没事，有变化时会自己醒。' })
  })

  it('反例：不认识的活动状态退回空闲，不把整块弄崩', () => {
    expect(teammateBusy(card({ activity: 'dreaming' as Activity })).tone).toBe('idle')
  })

  it('九种活动状态都有结论，没有漏项', () => {
    const all: Activity[] = ['watching', 'queued', 'thinking', 'waiting_owner', 'waiting_peer', 'blocked', 'resting', 'reflecting', 'catching_up']
    for (const activity of all) expect(teammateBusy(card({ activity, activityText: '' })).label).not.toBe('')
  })
})

describe('teammateQuota：额度块只有一行 token', () => {
  const costs = (tokens: number) => ({ days: [{ bots: [{ botId: 'b_1', tokens }] }, { bots: [{ botId: 'b_1', tokens: 1 }] }] }) as unknown as CostView

  it('成本视图有 token：按万保留一位，取第一天（今天）', () => {
    expect(teammateQuota({ costs: costs(121000), botId: 'b_1', cardTokens: 5 })).toBe('今天用了约 12.1 万 token')
  })

  it('不足 1 万：不给假精度', () => {
    expect(teammateQuota({ costs: costs(9999), botId: 'b_1', cardTokens: null })).toBe('今天用了不到 1 万 token')
  })

  it('只有队友卡 todayTokens（没有成本视图，或视图里没有这位队友）也能显示', () => {
    expect(teammateQuota({ costs: undefined, botId: 'b_1', cardTokens: 41000 })).toBe('今天用了约 4.1 万 token')
    expect(teammateQuota({ costs: costs(1), botId: 'b_other', cardTokens: 68000 })).toBe('今天用了约 6.8 万 token')
  })

  it('反例：两种来源都读不到：说没有记录，不编数字', () => {
    expect(teammateQuota({ costs: undefined, botId: 'b_1', cardTokens: null })).toBe('今天还没有用量记录')
    expect(teammateQuota({ costs: undefined, botId: 'b_1', cardTokens: undefined })).toBe('今天还没有用量记录')
  })

  it('不再出现回合、上限、全队', () => {
    const text = teammateQuota({ costs: costs(20000), botId: 'b_1', cardTokens: 0 })
    for (const word of ['回合', '上限', '全队']) expect(text).not.toContain(word)
  })
})

describe('tokensToday：这位队友今天的 token', () => {
  const costs = { days: [{ bots: [{ botId: 'b_1', tokens: 30000 }] }] } as unknown as CostView
  it('取今天这一行', () => expect(tokensToday(costs, 'b_1')).toBe(30000))
  it('反例：没有成本视图或没有这位队友：null', () => {
    expect(tokensToday(undefined, 'b_1')).toBeNull()
    expect(tokensToday(costs, 'b_9')).toBeNull()
  })
})

describe('activeWorkGroups：在办的事', () => {
  const all = collectWorkSessions(fixtureProject)

  it('只留进行中和受阻，按项目分组，项目名和状态都带着', () => {
    const groups = activeWorkGroups(sessionsForBot(all, 'bot-xunjian'))
    expect(groups.map(group => group.projectName)).toEqual(['竞品周报自动化'])
    expect(groups[0]!.sessions.map(session => [session.id, session.statusLabel])).toEqual([['pt_weekly_3', '受阻']])
  })

  it('反例：待验收和已通过算已经交出去了，不再算在办', () => {
    const ids = activeWorkGroups(sessionsForBot(all, 'bot-tanlu')).flatMap(group => group.sessions.map(session => session.id))
    expect(ids).toEqual(['pt_weekly_2'])
  })

  it('反例：没有在办的事就是空数组，空态文案就是主人要的那句', () => {
    expect(activeWorkGroups(sessionsForBot(all, 'bot-none'))).toEqual([])
    expect(NO_ACTIVE_WORK_TEXT).toBe('现在没有在办的事')
  })
})
