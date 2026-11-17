/**
 * P73f：样例数据里的员工状态字段与 core 一致，以及界面文字里不再出现旧的试岗、转正、退役、解除隔离。
 *
 * 第一部分：样例员工（总览、办公室）的状态三个字段都由 core 的 staffStatus 生成（shared/fixture-status.ts），
 * 这里用 core 的函数对同样的输入再算一遍，逐字段比对——样例不手写标签，core 改了叫法样例会跟着变。
 * 第二部分：把全部样例视图和客户端源码里的字符串都扫一遍，断言旧状态词不再出现；
 * 另外锁住「调度拦截原因新增的听吩咐」在插件类型里存在，且界面没有自己再抄一份拦截原因的文字表。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { staffStatus, STAFF_STATUS_LABELS, SUPPRESSION_REASON_LABELS, SUPPRESSION_REASONS } from '@agent-hub/core'
import { sampleStaffFields } from '../src/shared/fixture-status.js'
import { fixtureOffice } from '../src/shared/fixture-office.js'
import { fixtureBots, fixtureOverview, fixtureThreads, fixtureInbox, fixtureActivity } from '../src/shared/fixtures.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureResource } from '../src/shared/fixture-resource.js'
import type { SuppressionReason } from '../src/shared/views.js'

describe('样例员工的状态字段与 core staffStatus 的结果一致', () => {
  it('sampleStaffFields 对每种存储状态的结果等于 core 的 staffStatus', () => {
    for (const lifecycle of ['draft', 'probation', 'active', 'paused', 'quarantined', 'retired'] as const) {
      const core = staffStatus({ lifecycle, archivedAt: null, quarantineReason: lifecycle === 'quarantined' ? '额度保护' : null })
      expect(sampleStaffFields(lifecycle, { quarantineReason: lifecycle === 'quarantined' ? '额度保护' : null }))
        .toEqual({ staffStatus: core.status, staffStatusLabel: core.label, staffStatusReason: core.reason })
    }
  })

  it('总览里每位样例员工：字段都有，且等于 core 对同样输入的结果', () => {
    for (const bot of fixtureOverview.bots) {
      const core = staffStatus({ lifecycle: bot.lifecycle, archivedAt: bot.archived === true ? 1 : null, quarantineReason: null })
      expect([bot.id, bot.staffStatus, bot.staffStatusLabel, bot.staffStatusReason]).toEqual([bot.id, core.status, core.label, core.reason])
      // 标签必须是 core 的三种叫法之一，不是手写的。
      expect(Object.values(STAFF_STATUS_LABELS)).toContain(bot.staffStatusLabel)
    }
  })

  it('办公室里每个座位的占用者也一样；今天入职的林舟 joinedToday 为真，其余为假', () => {
    for (const seat of fixtureOffice.seats) {
      const core = staffStatus({ lifecycle: seat.occupant.lifecycle, archivedAt: null, quarantineReason: null })
      expect([seat.botId, seat.occupant.staffStatus, seat.occupant.staffStatusLabel, seat.occupant.staffStatusReason])
        .toEqual([seat.botId, core.status, core.label, core.reason])
    }
    expect(fixtureOffice.seats.filter(seat => seat.joinedToday).map(seat => seat.occupant.name)).toEqual(['林舟'])
    expect(fixtureOffice.seats.find(seat => seat.joinedToday)!.joinedAt).not.toBeNull()
    // 反例：老员工没有入职记录，joinedAt 为 null，不会在升级当天一起「报到」。
    expect(fixtureOffice.seats.filter(seat => !seat.joinedToday).every(seat => seat.joinedAt === null)).toBe(true)
  })

  it('详情里的卡片和总览是同一份（状态字段不会各说各话）', () => {
    for (const [id, view] of Object.entries(fixtureBots)) {
      const card = fixtureOverview.bots.find(bot => bot.id === id)
      expect(view.card.staffStatus).toBe(card?.staffStatus)
    }
  })
})

/** 扫描用：去掉注释后的源码（注释里允许写旧词来解释历史，字符串和界面文字里不允许）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|css)$/.test(name) ? [path] : []
  })
}

describe('界面上不再出现「试岗」「转正」「退役」「解除隔离」', () => {
  const banned = /试岗|转正|退役|解除隔离/

  it('全部样例视图（总览、详情、线程、收件箱、动态、办公室、项目、资料）的文字里都没有', () => {
    const everything = JSON.stringify({
      fixtureOverview, fixtureBots, fixtureThreads, fixtureInbox, fixtureActivity, fixtureOffice, fixtureProject, fixtureResource,
    })
    expect(everything.match(banned)).toBeNull()
  })

  it('客户端和样例的源码里（去掉注释后）没有这四个词：按钮、文字、提示都已统一为停用和归档', () => {
    const hits = walk(srcRoot)
      .filter(path => !path.includes(`${join('src', 'host')}`))
      .map(path => ({ path, match: stripComments(readFileSync(path, 'utf8')).match(banned) }))
      .filter(item => item.match !== null)
      .map(item => `${item.path.replace(srcRoot, '')}：${item.match![0]}`)
    expect(hits).toEqual([])
  })
})

describe('调度拦截原因新增的「听吩咐」（P73r2）', () => {
  it('core 的拦截原因里有 on_demand，显示文字以「听吩咐」开头；插件的类型也认这一项', () => {
    expect(SUPPRESSION_REASONS).toContain('on_demand')
    expect(SUPPRESSION_REASON_LABELS.on_demand.startsWith('听吩咐')).toBe(true)
    // 编译期检查：on_demand 是合法的 SuppressionReason（不合法这里类型检查就会失败）。
    const reason: SuppressionReason = 'on_demand'
    expect(reason).toBe('on_demand')
  })

  it('界面没有自己再抄一份拦截原因的文字表：拦截的原因文字一律来自 core 的评估记录（appraisal.text），所以新增项自动正确显示', () => {
    const clientSource = walk(join(srcRoot, 'client')).map(path => stripComments(readFileSync(path, 'utf8'))).join('\n')
    // 客户端不读 suppressedBy 来拼文字，也不引用拦截原因的各个取值。
    expect(clientSource).not.toMatch(/\.suppressedBy/)
    expect(clientSource).not.toMatch(/pace_min|daily_cap|bot_budget|dispatch_gap|startup_quiet|retry_backoff/)
  })
})
