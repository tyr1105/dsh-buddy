/**
 * 办公室界面纯逻辑测试（F03）：灯色、下钻目标与汇总。
 *
 * 为什么单独测：这些函数决定「点哪里去哪」和「顶部报几个数」，
 * 一旦和 core 的投影口径错位，界面会把座位和队友对错人、或把别人的账本打开。
 * 用例全部基于 shared/fixture-office.ts，与样例房间保持同一份形状。
 */
import { describe, expect, it } from 'vitest'
import type { ArtifactVersionRow, OfficeLight, SeatView, WakeLedgerRow } from '../src/shared/views.js'
import { fixtureOffice } from '../src/shared/fixture-office.js'
import { fixtureLedgerRows } from '../src/shared/fixture-ledger.js'
import {
  artifactFocusVersion, deskTarget, doorTarget, doorwayTarget, officeLightTone, officeSummary,
  seatTarget, trailEventsFromWakes, utcOffsetMinutesAt,
} from '../src/client/logic/office.js'

/** 取样例座位并按需改字段（不改原对象，避免用例互相污染）。 */
function seat(index: number, patch: Partial<SeatView> = {}): SeatView {
  return { ...fixtureOffice.seats[index]!, ...patch }
}

describe('officeLightTone：九种灯 → 六种色调', () => {
  it('正例：在跑=成功色、排队/盯守=强调色、等人=警示色、受阻=危险色', () => {
    expect(officeLightTone('working')).toBe('success')
    expect(officeLightTone('queued')).toBe('accent')
    expect(officeLightTone('watching')).toBe('accent')
    expect(officeLightTone('waiting')).toBe('warning')
    expect(officeLightTone('blocked')).toBe('danger')
  })
  it('休息/离线/历史空位灯值统一为弱化色，数据矛盾用 unknown', () => {
    expect(officeLightTone('resting')).toBe('muted')
    expect(officeLightTone('offline')).toBe('muted')
    expect(officeLightTone('vacant')).toBe('muted')
    expect(officeLightTone('unknown')).toBe('unknown')
  })
  it('反例：不会把 blocked 或 waiting 混成同一种颜色', () => {
    expect(officeLightTone('blocked')).not.toBe(officeLightTone('waiting'))
  })
  it('覆盖 core 的全部灯值（新增灯值时这里要报警）', () => {
    const lights: OfficeLight[] = ['working', 'queued', 'waiting', 'blocked', 'resting', 'watching', 'offline', 'vacant', 'unknown']
    for (const light of lights) expect(officeLightTone(light)).toBeTypeOf('string')
  })
})

describe('seatTarget：每个座位就是一位在岗队友', () => {
  it('有占用者 → 打开该队友', () => {
    expect(seatTarget(seat(0))).toEqual({ kind: 'bot', botId: 'bot-tanlu' })
  })
  it('每个座位都指向自己的队友，不会串人', () => {
    expect(seatTarget(seat(1))).toEqual({ kind: 'bot', botId: 'bot-xunjian' })
    expect(seatTarget(seat(2))).toEqual({ kind: 'bot', botId: 'bot-zongguan' })
    expect(fixtureOffice.seats.every(s => s.occupant.botId === s.botId)).toBe(true)
  })
  it('反例：投影里的座位不会带空位（seats 为空才表示空房间）', () => {
    expect(fixtureOffice.seats.length).toBeGreaterThan(0)
    for (const s of fixtureOffice.seats) expect(s.occupant.name.trim()).not.toBe('')
  })
})

describe('deskTarget：桌上的产出按 refKind 下钻', () => {
  it('wake 引用 → 打开队友详情并展开这次账本', () => {
    expect(deskTarget(seat(0))).toEqual({ kind: 'ledger', botId: 'bot-tanlu', wakeId: 'wk1' })
  })
  it('artifact 引用 → 打开队友详情并展开对应产物（F08）', () => {
    const withArtifact = seat(0, {
      desk: {
        kind: 'artifact', kindLabel: '产物', title: '第 45 周周报 v2',
        ref: 'artifact:art_1', refKind: 'artifact', refId: 'art_1',
      },
    })
    expect(deskTarget(withArtifact)).toEqual({ kind: 'artifact', botId: 'bot-tanlu', artifactId: 'art_1' })
  })
  it('bot 引用 → 只打开队友详情，不展开账本', () => {
    expect(deskTarget(seat(2))).toEqual({ kind: 'bot', botId: 'bot-zongguan' })
  })
  it('反例：桌上的 kind 是 none 时仍然只打开队友（座位必有占用者）', () => {
    const emptyDesk = seat(0, { desk: { ...seat(0).desk, kind: 'none', kindLabel: '桌上暂时没有产出', title: null, refKind: 'bot', refId: '' } })
    expect(deskTarget(emptyDesk)).toEqual({ kind: 'bot', botId: 'bot-tanlu' })
  })
  it('反例：wake 引用但 refId 为空时不拼出空 wakeId', () => {
    const broken = seat(0, { desk: { ...seat(0).desk, refKind: 'wake', refId: '' } })
    expect(deskTarget(broken)).toEqual({ kind: 'bot', botId: 'bot-tanlu' })
  })
  it('反例：artifact 引用但 refId 为空时回退成只打开队友', () => {
    const broken = seat(0, { desk: { ...seat(0).desk, refKind: 'artifact', refId: '' } })
    expect(deskTarget(broken)).toEqual({ kind: 'bot', botId: 'bot-tanlu' })
  })
})

describe('artifactFocusVersion：桌面产物落到具体版本', () => {
  /** 版本行工厂：只填挑选规则会读到的字段。 */
  function version(id: string, artifactId: string, number: number, createdAt: number): ArtifactVersionRow {
    return {
      id, artifactId, title: `产物 ${artifactId}`, number, reference: `artifact:${id}`,
      commitId: 'c_1', wakeId: 'w_1', goalIds: [], createdAt, bytes: 10,
      sha256: 'a'.repeat(64), visibility: 'owner', review: null,
    }
  }

  it('同一产物头取最新：先比创建时间，再比版本号', () => {
    const rows = [
      version('av_a1', 'art_a', 1, 100),
      version('av_a2', 'art_a', 2, 200),
      version('av_a3', 'art_a', 3, 200),
      version('av_b1', 'art_b', 9, 300),
    ]
    expect(artifactFocusVersion(rows, 'art_a')?.id).toBe('av_a3')
  })
  it('反例：不会拿别的产物头充数；目标不存在返回 null', () => {
    expect(artifactFocusVersion([version('av_b1', 'art_b', 1, 100)], 'art_a')).toBeNull()
    expect(artifactFocusVersion([], 'art_a')).toBeNull()
  })
  it('结果与列表顺序无关', () => {
    const rows = [version('av_a2', 'art_a', 2, 200), version('av_a1', 'art_a', 1, 100)]
    expect(artifactFocusVersion([...rows].reverse(), 'art_a')?.id).toBe('av_a2')
  })
})

describe('doorTarget / doorwayTarget：门口与总信箱', () => {
  it('座位门口有件数 → 回收件箱并带上这些 id', () => {
    expect(doorTarget(seat(0))).toEqual({ kind: 'inbox', inboxIds: ['inbox-a1', 'inbox-q1'] })
  })
  it('门口逐条带标题与类型（F04），界面不用自己拼文案', () => {
    // 标题与 fixtures.ts 里同 id 的收件箱条目一致，且不带「审批：」前缀（类型由 chip 承担）。
    expect(seat(0).door.items.map(item => item.title)).toEqual(['写交接文件', '探路想读任务日志'])
    expect(seat(0).door.items.map(item => item.type)).toEqual(['approval', 'question'])
  })
  it('座位门口为空 → 不可点', () => {
    expect(doorTarget(seat(1))).toBeNull()
  })
  it('房间总信箱有团队级项 → 回收件箱；空时不可点', () => {
    const withItems = {
      ...fixtureOffice,
      doorway: { ...fixtureOffice.doorway, count: 1, items: [{ inboxId: 'inbox-team', type: 'alert' as const, title: '团队告警', botId: null, ref: 'inbox:inbox-team' }] },
    }
    expect(doorwayTarget(withItems)).toEqual({ kind: 'inbox', inboxIds: ['inbox-team'] })
    expect(doorwayTarget(fixtureOffice)).toBeNull()
  })
  it('反例：门口 id 列表是副本，改动不会回写投影', () => {
    const target = doorTarget(seat(0))!
    target.inboxIds.push('inbox-x')
    expect(seat(0).door.inboxIds).toEqual(['inbox-a1', 'inbox-q1'])
  })
})

describe('officeSummary', () => {
  it('汇总全部来自座位与门口本身', () => {
    expect(officeSummary(fixtureOffice)).toEqual({ occupied: 3, waiting: 1, blocked: 0, doorTotal: 3 })
  })
  it('受阻计数与等人分开统计', () => {
    const withBlocked = { ...fixtureOffice, seats: [seat(0, { light: 'blocked' }), seat(1), seat(2)] }
    expect(officeSummary(withBlocked)).toEqual({ occupied: 3, waiting: 1, blocked: 1, doorTotal: 3 })
  })
  it('空房间汇总全零', () => {
    const empty = { ...fixtureOffice, seats: [], doorway: { ...fixtureOffice.doorway, count: 0, items: [], refs: [] } }
    expect(officeSummary(empty)).toEqual({ occupied: 0, waiting: 0, blocked: 0, doorTotal: 0 })
  })
})

describe('utcOffsetMinutesAt：轨迹按中心设置时区分组', () => {
  /** 2026-11-06 06:20:00 UTC：东八区是当天 14:20，UTC 仍是当天 06:20。 */
  const at = Date.UTC(2026, 10, 6, 6, 20, 0)

  it('正例：东八区是 +480 分钟，UTC 是 0', () => {
    expect(utcOffsetMinutesAt(at, 'Asia/Shanghai')).toBe(480)
    expect(utcOffsetMinutesAt(at, 'UTC')).toBe(0)
  })
  it('跨过夏令时切换后偏移跟着变（纽约冬令时 -300、夏令时 -240）', () => {
    expect(utcOffsetMinutesAt(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-300)
    expect(utcOffsetMinutesAt(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-240)
  })
  it('反例：时区缺失或非法时退回本机时区，不抛错', () => {
    const local = -new Date(at).getTimezoneOffset()
    expect(utcOffsetMinutesAt(at, undefined)).toBe(local)
    expect(utcOffsetMinutesAt(at, 'Mars/Olympus')).toBe(local)
  })
})

describe('trailEventsFromWakes：账本行 → 轨迹事件', () => {
  /** 取样例账本行并覆盖会参与转换的字段。 */
  function row(patch: Partial<WakeLedgerRow>): WakeLedgerRow {
    const base = fixtureLedgerRows('bot-tanlu')[0]!
    return { ...base, ...patch }
  }

  it('正例：id 用 wakeId，正文优先交账摘要，标签用结果文案', () => {
    const event = trailEventsFromWakes([row({
      wakeId: 'wk1', botId: 'bot-tanlu', openedAt: 1000,
      summary: '定位到依赖服务超时', triggerText: '任务日志出新行',
      outcomeLabel: '有进展', statusLabel: '已封存',
    })])[0]!
    expect(event).toEqual({
      id: 'wk1', botId: 'bot-tanlu', at: 1000,
      text: '定位到依赖服务超时', kindLabel: '有进展',
    })
  })
  it('没有交账摘要时退回触发原文；结果文案缺失时退回状态文案', () => {
    const event = trailEventsFromWakes([row({ summary: null, triggerText: '答应主人周五前给结论', outcomeLabel: null, statusLabel: '进行中' })])[0]!
    expect(event.text).toBe('答应主人周五前给结论')
    expect(event.kindLabel).toBe('进行中')
  })
  it('反例：摘要与触发都为空时给一句诚实的兜底，不编内容', () => {
    const event = trailEventsFromWakes([row({ summary: '  ', triggerText: '', variantLabel: '例行' })])[0]!
    expect(event.text).toBe('例行唤醒')
  })
  it('原样保留顺序与条数，不在这里重排', () => {
    const events = trailEventsFromWakes([row({ wakeId: 'a' }), row({ wakeId: 'b' })])
    expect(events.map(event => event.id)).toEqual(['a', 'b'])
  })
})
