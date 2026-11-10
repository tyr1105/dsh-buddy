/**
 * 员工动线时间段的纯逻辑测试（P62）：合并、空闲、等待验收、跨午夜、时区、倒带与坏数据。
 *
 * 为什么逐条测：主人看到的每一行都由这些规则算出来，阈值差一秒、跨午夜归错一天，
 * 面板就会显示错的话。这里用固定 now 和显式时区偏移把每条规则钉死，
 * 每条规则都有正例和反例，界面接线时不用再猜。
 */
import { describe, expect, it } from 'vitest'
import type { WakeLedgerRow } from '../src/shared/views.js'
import { fixtureLedgerRows } from '../src/shared/fixture-ledger.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  TRAIL_MERGE_GAP_MS, TRAIL_MIN_IDLE_MS, TRAIL_PENDING_CHECK_TEXT, TRAIL_UNKNOWN_WORK_TEXT,
  buildTrailTimeline, findTrailWorkItem, trailProjectsFromView, trailTextForTrigger,
  type TrailProjectInput, type TrailTaskInput,
} from '../src/client/logic/office-trail-timeline.js'

const MIN = 60_000
const OFFSET = 480

/** 按东八区 2026-11 月的本地时间造一个 UTC 毫秒值。 */
function atLocal(day: number, hour: number, minute: number, second = 0): number {
  return Date.UTC(2026, 10, day, hour - 8, minute, second)
}

/** 东八区 2026-11-08 12:00。 */
const NOW = atLocal(8, 12, 0)
const TODAY = '2026-11-08'
const YESTERDAY = '2026-11-07'

/** 造一行账本：只改动线会读的字段，其余沿用样例，保证形状和真实接口一致。 */
function row(wakeId: string, openedAt: number, sealedAt: number | null, patch: Partial<WakeLedgerRow> = {}): WakeLedgerRow {
  const base = fixtureLedgerRows('bot-tanlu')[0]!
  return { ...base, wakeId, id: `wl_${wakeId}`, botId: 'bot-a', openedAt, sealedAt, triggerKind: 'owner_message', ...patch }
}

function task(id: string, title: string, wakeIds: string[], patch: Partial<TrailTaskInput> = {}): TrailTaskInput {
  return { id, title, status: 'doing', wakeIds, createdAt: 1, updatedAt: 1, dueAt: null, ...patch }
}

function project(name: string, tasks: TrailTaskInput[]): TrailProjectInput {
  return { name, tasks }
}

/** 算一遍并取某天的整行文案，断言写起来和主人看到的一样。 */
function linesOf(
  rows: WakeLedgerRow[], projects: TrailProjectInput[] = [], dayKey = TODAY,
  options: { now?: number; offset?: number; live?: boolean } = {},
): string[] {
  const timeline = buildTrailTimeline({
    rows, projects, now: options.now ?? NOW, utcOffsetMinutes: options.offset ?? OFFSET, live: options.live,
  })
  return (timeline.segments[dayKey] ?? []).map(segment => segment.line)
}

describe('工作段', () => {
  it('正例：已结束的写真实起止，还没结束的写到现在', () => {
    expect(linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))])[0]).toBe('09:00～09:30：回你的消息')
    expect(linesOf([row('a', atLocal(8, 11, 40), null)])).toEqual(['11:40～现在：回你的消息'])
  })

  it('属于任务时文案是「项目名，任务标题」，不带方括号', () => {
    const lines = linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))], [project('dddd', [task('t1', '来来', ['a'])])])
    expect(lines[0]).toBe('09:00～09:30：dddd，来来')
    expect(lines.join()).not.toMatch(/[[\]]/)
  })

  it('反例：wakeId 不在任何任务里，不会显示别的任务名', () => {
    const lines = linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))], [project('dddd', [task('t1', '来来', ['other'])])])
    expect(lines[0]).toBe('09:00～09:30：回你的消息')
  })
})

describe('不属于任务时按唤醒原因说一句人话', () => {
  it.each([
    ['owner_message', '回你的消息'], ['inbox_reply', '回你的消息'], ['approval_decided', '回你的消息'],
    ['peer_message', '回同事的消息'],
    ['percept', '看外部变化'], ['pile', '看外部变化'],
    ['agenda_due', '按计划继续'], ['next_think', '按计划继续'], ['retry', '按计划继续'],
    ['drive', '自己查看进展'], ['light_check', '自己查看进展'], ['catch_up', '自己查看进展'],
    ['reflection', '复盘'],
  ])('%s → %s', (kind, text) => {
    expect(trailTextForTrigger(kind)).toBe(text)
  })

  it('反例：映射表查不到时写兜底说法，不露内部类型名', () => {
    expect(trailTextForTrigger('trial')).toBe(TRAIL_UNKNOWN_WORK_TEXT)
    expect(trailTextForTrigger('teach')).toBe('处理自己的事')
    expect(trailTextForTrigger('some_future_kind')).toBe('处理自己的事')
  })

  it('反例：账本里的唤醒类型、id、摘要原文一律不进文案', () => {
    const lines = linesOf([row('wk_secret', atLocal(8, 9, 0), atLocal(8, 9, 30), {
      triggerKind: 'percept', triggerKindLabel: '感知', triggerText: '触发原文', summary: '摘要原文', variantLabel: '常规',
    })])
    expect(lines[0]).toBe('09:00～09:30：看外部变化')
    expect(lines.join()).not.toMatch(/wk_secret|感知|触发原文|摘要原文|常规/)
  })
})

describe('两段工作之间的间隔', () => {
  const twoWorks = (first: TrailTaskInput): string[] => linesOf([
    row('a', atLocal(8, 9, 0), atLocal(8, 9, 30)),
    row('b', atLocal(8, 10, 0), atLocal(8, 10, 20)),
  ], [project('周报', [first, task('t2', '抓取', ['b'])])])

  it('普通任务之后是空闲', () => {
    expect(twoWorks(task('t1', '初稿', ['a']))).toEqual([
      '09:00～09:30：周报，初稿', '09:30～10:00：空闲', '10:00～10:20：周报，抓取', '10:20～现在：空闲',
    ])
  })

  it('任务现在待验收且是最后一次工作：间隔写完成工作，等待验收', () => {
    const lines = twoWorks(task('t1', '初稿', ['a'], { status: 'done_pending_check' }))
    expect(lines[1]).toBe(`09:30～10:00：${TRAIL_PENDING_CHECK_TEXT}`)
  })

  it('反例：待验收但后面还接着做过，前面的间隔仍是空闲，最后一次之后才是等待验收', () => {
    const lines = linesOf([
      row('a', atLocal(8, 9, 0), atLocal(8, 9, 30)),
      row('b', atLocal(8, 10, 0), atLocal(8, 10, 20)),
      row('c', atLocal(8, 11, 0), atLocal(8, 11, 10), { triggerKind: 'peer_message' }),
    ], [project('周报', [task('t1', '初稿', ['a', 'b'], { status: 'done_pending_check' })])])
    expect(lines).toEqual([
      '09:00～09:30：周报，初稿', '09:30～10:00：空闲', '10:00～10:20：周报，初稿',
      '10:20～11:00：完成工作，等待验收', '11:00～11:10：回同事的消息', '11:10～现在：空闲',
    ])
  })

  it('反例：已通过、已驳回、进行中都不算等待验收', () => {
    for (const status of ['accepted', 'rejected', 'doing', 'blocked', 'todo'] as const) {
      expect(twoWorks(task('t1', '初稿', ['a'], { status }))[1]).toBe('09:30～10:00：空闲')
    }
  })

  it('「最后一次工作」跨天看：昨天做过、今天还做，昨天的间隔是空闲', () => {
    const lines = linesOf([
      row('a', atLocal(7, 9, 0), atLocal(7, 9, 30)),
      row('x', atLocal(7, 10, 0), atLocal(7, 10, 10), { triggerKind: 'reflection' }),
      row('b', atLocal(8, 9, 0), atLocal(8, 9, 30)),
    ], [project('周报', [task('t1', '初稿', ['a', 'b'], { status: 'done_pending_check' })])], YESTERDAY)
    expect(lines).toEqual(['09:00～09:30：周报，初稿', '09:30～10:00：空闲', '10:00～10:10：复盘'])
  })
})

describe('合并相邻的同一件事', () => {
  const tasks = [project('周报', [task('t1', '初稿', ['a', 'b', 'c']), task('t2', '抓取', ['z'])])]

  it('两个阈值：合并 5 分钟，空闲 1 分钟', () => {
    expect(TRAIL_MERGE_GAP_MS).toBe(5 * MIN)
    expect(TRAIL_MIN_IDLE_MS).toBe(MIN)
  })

  it('正例：同一任务间隔不到 5 分钟并成一段，三段也能连着并', () => {
    expect(linesOf([
      row('a', atLocal(8, 9, 0), atLocal(8, 9, 10)),
      row('b', atLocal(8, 9, 14), atLocal(8, 9, 20)),
      row('c', atLocal(8, 9, 24), atLocal(8, 9, 40)),
    ], tasks)).toEqual(['09:00～09:40：周报，初稿', '09:40～现在：空闲'])
  })

  it('边界：差一毫秒到 5 分钟要合并，正好 5 分钟不合并', () => {
    const end = atLocal(8, 9, 10)
    const merged = linesOf([row('a', atLocal(8, 9, 0), end), row('b', end + 5 * MIN - 1, atLocal(8, 9, 30))], tasks)
    expect(merged[0]).toBe('09:00～09:30：周报，初稿')
    const apart = linesOf([row('a', atLocal(8, 9, 0), end), row('b', end + 5 * MIN, atLocal(8, 9, 30))], tasks)
    expect(apart.slice(0, 3)).toEqual(['09:00～09:10：周报，初稿', '09:10～09:15：空闲', '09:15～09:30：周报，初稿'])
  })

  it('反例：不同任务间隔再短也不合并', () => {
    const lines = linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 10)), row('z', atLocal(8, 9, 12), atLocal(8, 9, 20))], tasks)
    expect(lines.slice(0, 3)).toEqual(['09:00～09:10：周报，初稿', '09:10～09:12：空闲', '09:12～09:20：周报，抓取'])
  })

  it('不属于任务时，同一句人话算同一件事；不同的话不合并', () => {
    expect(linesOf([
      row('m', atLocal(8, 9, 0), atLocal(8, 9, 10), { triggerKind: 'owner_message' }),
      row('n', atLocal(8, 9, 12), atLocal(8, 9, 20), { triggerKind: 'inbox_reply' }),
    ])[0]).toBe('09:00～09:20：回你的消息')
    expect(linesOf([
      row('m', atLocal(8, 9, 0), atLocal(8, 9, 10), { triggerKind: 'owner_message' }),
      row('n', atLocal(8, 9, 12), atLocal(8, 9, 20), { triggerKind: 'peer_message' }),
    ]).slice(0, 3)).toEqual(['09:00～09:10：回你的消息', '09:10～09:12：空闲', '09:12～09:20：回同事的消息'])
  })

  it('合并后最后一段还在进行：整段写到现在，也不再补空闲', () => {
    expect(linesOf([row('a', atLocal(8, 11, 0), atLocal(8, 11, 10)), row('b', atLocal(8, 11, 12), null)], tasks))
      .toEqual(['11:00～现在：周报，初稿'])
  })
})

describe('小于 1 分钟的空闲不单独成行', () => {
  const works = (gap: number): string[] => {
    const end = atLocal(8, 9, 30)
    return linesOf([
      row('a', atLocal(8, 9, 0), end, { triggerKind: 'owner_message' }),
      row('b', end + gap, atLocal(8, 9, 50), { triggerKind: 'peer_message' }),
    ])
  }

  it('差一毫秒到 1 分钟：不成行，前后工作都保留真实起止', () => {
    expect(works(MIN - 1).slice(0, 2)).toEqual(['09:00～09:30：回你的消息', '09:30～09:50：回同事的消息'])
  })

  it('正好 1 分钟：单独成行', () => {
    expect(works(MIN).slice(0, 3)).toEqual(['09:00～09:30：回你的消息', '09:30～09:31：空闲', '09:31～09:50：回同事的消息'])
  })

  it('待验收的间隔同样受这条限制', () => {
    const end = atLocal(8, 9, 30)
    const lines = linesOf([row('a', atLocal(8, 9, 0), end), row('b', end + 30_000, atLocal(8, 9, 50), { triggerKind: 'peer_message' })],
      [project('周报', [task('t1', '初稿', ['a'], { status: 'done_pending_check' })])])
    expect(lines.slice(0, 2)).toEqual(['09:00～09:30：周报，初稿', '09:30～09:50：回同事的消息'])
  })
})

describe('一天的起止', () => {
  it('从第一段活动开始，不补 00:00 起的空闲', () => {
    const lines = linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))])
    expect(lines[0]).toBe('09:00～09:30：回你的消息')
    expect(lines.join()).not.toContain('00:00')
  })

  it('今天最后一段结束后：写到现在的空闲', () => {
    expect(linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))]))
      .toEqual(['09:00～09:30：回你的消息', '09:30～现在：空闲'])
  })

  it('今天最后一段是待验收任务的最后一次工作：写到现在的完成工作，等待验收', () => {
    expect(linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 30))], [project('周报', [task('t1', '初稿', ['a'], { status: 'done_pending_check' })])]))
      .toEqual(['09:00～09:30：周报，初稿', '09:30～现在：完成工作，等待验收'])
  })

  it('反例：最后一段刚结束不到 1 分钟，末尾的空闲还不成行', () => {
    expect(linesOf([row('a', NOW - 10 * MIN, NOW - 30_000)])).toEqual(['11:50～11:59：回你的消息'])
  })

  it('反例：最后一段还在进行，不补末尾空闲', () => {
    expect(linesOf([row('a', atLocal(8, 11, 0), null)])).toEqual(['11:00～现在：回你的消息'])
  })

  it('反例：往日到最后一段结束为止，不写到现在', () => {
    expect(linesOf([row('a', atLocal(7, 9, 0), atLocal(7, 9, 30))], [], YESTERDAY)).toEqual(['09:00～09:30：回你的消息'])
  })

  it('这一天完全没活动：空列表，不编造空闲', () => {
    expect(linesOf([row('a', atLocal(7, 9, 0), atLocal(7, 9, 30))])).toEqual([])
    expect(linesOf([])).toEqual([])
  })

  it('今天第一段不接昨天：两天之间的空档不算进今天', () => {
    expect(linesOf([row('a', atLocal(7, 22, 0), atLocal(7, 22, 30)), row('b', atLocal(8, 9, 0), atLocal(8, 9, 30))])[0])
      .toBe('09:00～09:30：回你的消息')
  })
})

describe('跨午夜的工作按开始那天算', () => {
  it('归开始那天，结束时间照写；第二天不重复出现', () => {
    const rows = [row('a', atLocal(7, 23, 50), atLocal(8, 0, 10))]
    expect(linesOf(rows, [], YESTERDAY)).toEqual(['23:50～00:10：回你的消息'])
    expect(linesOf(rows)).toEqual([])
  })

  it('跨午夜还没结束：写在开始那天并写到现在', () => {
    expect(linesOf([row('a', atLocal(7, 23, 50), null)], [], YESTERDAY)).toEqual(['23:50～现在：回你的消息'])
  })

  it('反例：午夜前后的同一件事不合并，今天的第一段不能被并进昨天', () => {
    const rows = [row('a', atLocal(7, 23, 58), atLocal(7, 23, 59)), row('b', atLocal(8, 0, 1), atLocal(8, 0, 5))]
    expect(linesOf(rows, [], YESTERDAY)).toEqual(['23:58～23:59：回你的消息'])
    expect(linesOf(rows)[0]).toBe('00:01～00:05：回你的消息')
  })
})

describe('时间和时区沿用 buildOfficeTrail', () => {
  it('同一时刻按传入的时区显示，24 小时制', () => {
    const at = Date.UTC(2026, 10, 8, 5, 5)
    const rows = [row('a', at, at + 10 * MIN)]
    expect(linesOf(rows, [], TODAY, { now: Date.UTC(2026, 10, 8, 6, 0), offset: 480 })[0]).toBe('13:05～13:15：回你的消息')
    expect(linesOf(rows, [], TODAY, { now: Date.UTC(2026, 10, 8, 6, 0), offset: 0 })[0]).toBe('05:05～05:15：回你的消息')
  })

  it('时区决定归到哪一天', () => {
    const at = Date.UTC(2026, 10, 7, 16, 30)
    const rows = [row('a', at, at + 5 * MIN)]
    const now = Date.UTC(2026, 10, 8, 4, 0)
    expect(linesOf(rows, [], TODAY, { now, offset: 480 })[0]).toBe('00:30～00:35：回你的消息')
    expect(linesOf(rows, [], TODAY, { now, offset: 0 })).toEqual([])
    expect(linesOf(rows, [], YESTERDAY, { now, offset: 0 })[0]).toBe('16:30～16:35：回你的消息')
  })

  it('按天翻看的分组结果可以直接交给翻页函数', () => {
    const timeline = buildTrailTimeline({
      rows: [row('a', atLocal(6, 9, 0), atLocal(6, 9, 30))], projects: [], now: NOW, utcOffsetMinutes: OFFSET,
    })
    expect(timeline.trail.days.map(day => day.key)).toEqual([TODAY, YESTERDAY, '2026-11-06'])
    expect(timeline.segments[YESTERDAY]).toEqual([])
    expect(timeline.segments['2026-11-06']).toHaveLength(1)
  })
})

describe('倒带（live=false）', () => {
  const at = atLocal(8, 10, 0)

  it('所选时刻之后才开始的工作不出现', () => {
    expect(linesOf([row('a', at + MIN, at + 2 * MIN)], [], TODAY, { now: at, live: false })).toEqual([])
  })

  it('在所选时刻还没结束的工作：结束时间写所选时刻，不写现在', () => {
    expect(linesOf([row('a', at - 10 * MIN, at + 10 * MIN)], [], TODAY, { now: at, live: false })).toEqual(['09:50～10:00：回你的消息'])
  })

  it('末尾的空闲同样写到所选时刻', () => {
    expect(linesOf([row('a', at - 30 * MIN, at - 20 * MIN)], [], TODAY, { now: at, live: false }))
      .toEqual(['09:30～09:40：回你的消息', '09:40～10:00：空闲'])
  })
})

describe('异常数据不把列表弄坏', () => {
  it('开始时间坏了的丢掉，乱序输入照样按时间排', () => {
    expect(linesOf([
      row('late', atLocal(8, 11, 0), atLocal(8, 11, 10), { triggerKind: 'peer_message' }),
      row('bad', Number.NaN, atLocal(8, 9, 0)),
      row('early', atLocal(8, 9, 0), atLocal(8, 9, 10)),
    ]).slice(0, 3)).toEqual(['09:00～09:10：回你的消息', '09:10～11:00：空闲', '11:00～11:10：回同事的消息'])
  })

  it('结束早于开始：按零长度算，不倒着走', () => {
    expect(linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 8, 0))])[0]).toBe('09:00～09:00：回你的消息')
  })

  it('两段时间叠在一起：前一段截到后一段开始', () => {
    expect(linesOf([
      row('a', atLocal(8, 9, 0), atLocal(8, 9, 40)),
      row('b', atLocal(8, 9, 30), atLocal(8, 10, 0), { triggerKind: 'peer_message' }),
    ]).slice(0, 2)).toEqual(['09:00～09:30：回你的消息', '09:30～10:00：回同事的消息'])
  })

  it('残留的未封存账本：后面还有工作时只到下一段开始，不一直写到现在', () => {
    expect(linesOf([
      row('stale', atLocal(8, 9, 0), null),
      row('b', atLocal(8, 10, 0), atLocal(8, 10, 10), { triggerKind: 'peer_message' }),
    ]).slice(0, 2)).toEqual(['09:00～10:00：回你的消息', '10:00～10:10：回同事的消息'])
  })

  it('同一次唤醒重复出现只算一行', () => {
    expect(linesOf([row('a', atLocal(8, 9, 0), atLocal(8, 9, 10)), row('a', atLocal(8, 9, 0), atLocal(8, 9, 10))]))
      .toEqual(['09:00～09:10：回你的消息', '09:10～现在：空闲'])
  })
})

describe('findTrailWorkItem：账本行自带项目名和事项名（P63）', () => {
  const wake = { wakeId: 'w', openedAt: 1000, sealedAt: 2000 }
  const ledger = { ...wake, projectName: '周报', itemTitle: '选题讨论' }

  it('账本行带了两个字段就直接用，主题里的讨论没有任务也能说清在做什么', () => {
    expect(findTrailWorkItem(ledger, { projects: [] })).toEqual({ key: 'item:周报，选题讨论', label: '周报，选题讨论', pendingCheck: false })
  })

  it('优先于按任务查：同一次唤醒顺带记在别的任务上，也说账本行写的那件事', () => {
    const projects = [project('周报', [task('t1', '别的事', ['w'], { status: 'done_pending_check' })])]
    expect(findTrailWorkItem(ledger, { projects })).toEqual({ key: 'item:周报，选题讨论', label: '周报，选题讨论', pendingCheck: false })
  })

  it('「等待验收」只在说的是同一件事时沿用', () => {
    const projects = [project('周报', [task('t1', '选题讨论', ['w'], { status: 'done_pending_check' })])]
    expect(findTrailWorkItem(ledger, { projects })?.pendingCheck).toBe(true)
  })

  it('反例：旧账本没带，或只带了一半，都回到按任务查', () => {
    const projects = [project('周报', [task('t1', '初稿', ['w'])])]
    expect(findTrailWorkItem(wake, { projects })?.key).toBe('task:t1')
    expect(findTrailWorkItem({ ...wake, projectName: '周报', itemTitle: null }, { projects })?.key).toBe('task:t1')
    expect(findTrailWorkItem({ ...wake, projectName: null, itemTitle: '选题讨论' }, { projects })?.key).toBe('task:t1')
  })

  it('同一件事的相邻两次工作并成一段', () => {
    const rows = [
      row('w1', atLocal(8, 10, 0), atLocal(8, 10, 5), { projectName: '周报', itemTitle: '选题讨论' }),
      row('w2', atLocal(8, 10, 6), atLocal(8, 10, 9), { projectName: '周报', itemTitle: '选题讨论' }),
    ]
    const lines = linesOf(rows)
    expect(lines.filter(line => line.includes('周报，选题讨论'))).toHaveLength(1)
  })
})

describe('findTrailWorkItem：这次唤醒属于哪件事', () => {
  const wake = { wakeId: 'w', openedAt: 1000, sealedAt: 2000 }

  it('命中任务时给出同一件事的 key、文案和待验收标记', () => {
    expect(findTrailWorkItem(wake, { projects: [project('周报', [task('t1', '初稿', ['w'], { status: 'done_pending_check' })])] }))
      .toEqual({ key: 'task:t1', label: '周报，初稿', pendingCheck: true })
  })

  it('反例：没有命中返回 null，由调用方按唤醒原因说人话', () => {
    expect(findTrailWorkItem(wake, { projects: [project('周报', [task('t1', '初稿', ['x'])])] })).toBeNull()
    expect(findTrailWorkItem(wake, { projects: [] })).toBeNull()
  })

  it('一次唤醒命中多个任务：更新时间落在工作时段内的优先（这次真的动过它）', () => {
    const projects = [project('周报', [
      task('t1', '早截止', ['w'], { dueAt: 10, updatedAt: 500 }),
      task('t2', '被交验收', ['w'], { updatedAt: 1500, status: 'done_pending_check' }),
    ])]
    expect(findTrailWorkItem(wake, { projects })?.key).toBe('task:t2')
  })

  it('时段内动过好几个：取最晚动过的那个', () => {
    const projects = [project('周报', [
      task('t1', '先动', ['w'], { updatedAt: 1200 }),
      task('t2', '后动', ['w'], { updatedAt: 1800 }),
    ])]
    expect(findTrailWorkItem(wake, { projects })?.key).toBe('task:t2')
  })

  it('反例：时段外的更新不算动过；没有线索时按截止时间、创建时间取第一个，结果和输入顺序无关', () => {
    const late = task('t1', '没截止', ['w'], { dueAt: null, createdAt: 1, updatedAt: 3000 })
    const soon = task('t2', '先截止', ['w'], { dueAt: 100, createdAt: 2, updatedAt: 500 })
    expect(findTrailWorkItem(wake, { projects: [project('周报', [late, soon])] })?.key).toBe('task:t2')
    expect(findTrailWorkItem(wake, { projects: [project('周报', [soon, late])] })?.key).toBe('task:t2')
    const older = task('t3', '更早建', ['w'], { dueAt: 100, createdAt: 1, updatedAt: 500 })
    expect(findTrailWorkItem(wake, { projects: [project('周报', [soon, older])] })?.key).toBe('task:t3')
  })

  it('还在进行的唤醒（没有结束时间）：开始之后的更新都算动过', () => {
    const projects = [project('周报', [task('t1', '先建', ['w']), task('t2', '刚动', ['w'], { createdAt: 9, updatedAt: 9000 })])]
    expect(findTrailWorkItem({ ...wake, sealedAt: null }, { projects })?.key).toBe('task:t2')
  })
})

describe('trailProjectsFromView：项目页视图 → 动线要的形状', () => {
  it('带上项目名和任务的 wakeIds，样例里的唤醒能查到对应任务', () => {
    const projects = trailProjectsFromView(fixtureProject)
    expect(projects.length).toBe(fixtureProject.projects.length)
    const hit = findTrailWorkItem({ wakeId: 'wk1', openedAt: 0, sealedAt: 1 }, { projects })
    expect(hit?.label).toContain('产出第 45 周周报初稿')
    expect(hit?.pendingCheck).toBe(true)
  })
})
