/**
 * 队友右侧边栏的内容规则测试（P64）：忙碌状态、额度、在办的事。
 * 全是纯函数，每条规则一个正例一个反例；工作会话用 shared/fixture-project 的样例，和预览里看到的一致。
 */
import { describe, expect, it } from 'vitest'
import type { Activity, BotCard, CostView } from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { collectWorkSessions, sessionsForBot } from '../src/client/logic/work-session.js'
import {
  NO_ACTIVE_WORK_TEXT, activeWorkGroups, modelQuotaLine, modelTierText, teammateBusy, teammateQuota, teammateStatusLine, tokensToday,
} from '../src/client/logic/teammate-panel.js'

type BusyInput = Pick<BotCard, 'staffStatus' | 'staffStatusReason' | 'activity' | 'activityText' | 'waitingOwner'>

/** 一位在岗、空闲的队友；每条用例只改自己关心的字段。（P73f：状态读 staffStatus，不再读 lifecycle。） */
function card(patch: Partial<BusyInput> = {}): BusyInput {
  return { staffStatus: 'on_duty', staffStatusReason: null, activity: 'watching', activityText: '在盯着：3 项', waitingOwner: false, ...patch }
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

  it('P73f：停用后按状态说话，不看残留的活动状态，细节是停用原因', () => {
    expect(teammateBusy(card({ staffStatus: 'suspended', staffStatusReason: '你停用的', activity: 'thinking', activityText: '状态已更新，当前回合等待结束' })))
      .toEqual({ tone: 'off', label: '停用', detail: '你停用的' })
  })

  it('P73f：归档的结论是「归档」；没有原因时用兜底说法', () => {
    expect(teammateBusy(card({ staffStatus: 'archived', activity: 'resting', activityText: '已归档' })))
      .toEqual({ tone: 'off', label: '归档', detail: '不再接活，记录保留可查。' })
  })

  it('活动句开头已经是结论：合成一句，不写两遍', () => {
    expect(teammateBusy(card({ activity: 'resting', activityText: '空闲：额度保护，明天 09:00 恢复' })))
      .toEqual({ tone: 'idle', label: '空闲：额度保护，明天 09:00 恢复', detail: null })
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

describe('P73f teammateStatusLine：状态一行（在岗、停用、归档）', () => {
  /** 带标签的最小卡片。 */
  const withLabel = (patch: Partial<BusyInput> & { staffStatusLabel: string }): Parameters<typeof teammateStatusLine>[0] => ({ ...card(patch), staffStatusLabel: patch.staffStatusLabel })

  it('在岗：「在岗　」接现有的忙碌结论，细节放下一行', () => {
    expect(teammateStatusLine(withLabel({ staffStatusLabel: '在岗', activity: 'thinking', activityText: '正在处理：数据日报没出' })))
      .toEqual({ tone: 'busy', text: '在岗　正在忙', detail: '正在处理：数据日报没出' })
  })

  it('停用：写「停用：原因」', () => {
    expect(teammateStatusLine(withLabel({ staffStatusLabel: '停用', staffStatus: 'suspended', staffStatusReason: '连续出错，系统已停用：额度' })))
      .toEqual({ tone: 'off', text: '停用：连续出错，系统已停用：额度', detail: null })
  })

  it('归档：只写「归档」', () => {
    expect(teammateStatusLine(withLabel({ staffStatusLabel: '归档', staffStatus: 'archived' })).text).toBe('归档')
  })

  it('反例：在岗的状态行里没有「停用」「归档」，也没有「试岗」', () => {
    const text = teammateStatusLine(withLabel({ staffStatusLabel: '在岗' })).text
    for (const word of ['停用', '归档', '试岗']) expect(text).not.toContain(word)
  })
})

describe('P73f modelTierText 与 modelQuotaLine：「模型与额度」一行', () => {
  const tiers = { standard: null, light: { provider: 'p', model: 'flash' }, lightAvailable: true }
  it('跟随默认或等于标准档：标准档；等于轻档：轻档；其余写模型显示名', () => {
    expect(modelTierText(null, 'DSH 默认', tiers)).toBe('标准档')
    expect(modelTierText({ provider: 'p', model: 'flash' }, 'p / flash', tiers)).toBe('轻档')
    expect(modelTierText({ provider: 'p', model: 'pro' }, 'p / pro', tiers)).toBe('p / pro')
    const named = { standard: { provider: 'p', model: 'pro' }, light: null, lightAvailable: false }
    expect(modelTierText({ provider: 'p', model: 'pro' }, 'p / pro', named)).toBe('标准档')
  })
  it('反例：没有档位信息时不猜，写模型显示名；轻档不可用时不会判成轻档', () => {
    expect(modelTierText({ provider: 'p', model: 'flash' }, 'p / flash', null)).toBe('p / flash')
    expect(modelTierText({ provider: 'p', model: 'flash' }, 'p / flash', { standard: null, light: null, lightAvailable: false })).toBe('p / flash')
  })
  it('一行写档位和 token（设计稿场景 D 的句式）', () => {
    expect(modelQuotaLine({ tierText: '标准档', costs: undefined, botId: 'b', cardTokens: 410000 })).toBe('标准档。今天约 410K token。')
  })
  it('反例：小于 1000 原样写数字（P80，原「不到 1 万」一档取消）；两边都读不到说没有记录', () => {
    expect(modelQuotaLine({ tierText: '轻档', costs: undefined, botId: 'b', cardTokens: 500 })).toBe('轻档。今天约 500 token。')
    expect(modelQuotaLine({ tierText: '标准档', costs: undefined, botId: 'b', cardTokens: null })).toBe('标准档。今天还没有用量记录。')
  })
})

describe('teammateQuota：额度块只有一行 token', () => {
  const costs = (tokens: number) => ({ days: [{ bots: [{ botId: 'b_1', tokens }] }, { bots: [{ botId: 'b_1', tokens: 1 }] }] }) as unknown as CostView

  it('成本视图有 token：按 K、M 单位换算（P80），取第一天（今天）', () => {
    expect(teammateQuota({ costs: costs(121000), botId: 'b_1', cardTokens: 5 })).toBe('今天用了约 121K token')
    expect(teammateQuota({ costs: costs(1636469), botId: 'b_1', cardTokens: 5 })).toBe('今天用了约 1.64M token')
  })

  it('小于 1000：原样写数字（P80，原「不到 1 万」一档取消）', () => {
    expect(teammateQuota({ costs: costs(856), botId: 'b_1', cardTokens: null })).toBe('今天用了约 856 token')
  })

  it('只有队友卡 todayTokens（没有成本视图，或视图里没有这位队友）也能显示', () => {
    expect(teammateQuota({ costs: undefined, botId: 'b_1', cardTokens: 41000 })).toBe('今天用了约 41K token')
    expect(teammateQuota({ costs: costs(1), botId: 'b_other', cardTokens: 68000 })).toBe('今天用了约 68K token')
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
