/** 样例数据：覆盖任务卡要求的场景组合（3 机器人、卡片种类、日报、收件箱、活动流、为什么醒/没醒）。 */
import { describe, expect, it } from 'vitest'
import {
  fixtureActivity, fixtureBots, fixtureInbox, fixtureOverview, fixtureSettings, fixtureThreads,
} from '../src/shared/fixtures.js'

describe('样例：机器人与总览', () => {
  it('三个机器人：巡检员（盯守，在盯着 3 项）', () => {
    const x = fixtureOverview.bots.find((b) => b.name === '巡检员')!
    expect(x.role).toBe('sentinel')
    expect(x.activity).toBe('watching')
    expect(x.activityText).toContain('3 项')
  })
  it('探路（调研，正在处理第 12/30 步）', () => {
    const g = fixtureOverview.bots.find((b) => b.name === '探路')!
    expect(g.role).toBe('researcher')
    expect(g.activity).toBe('thinking')
    expect(g.activityText).toContain('12/30')
  })
  it('总管（总管，等你：一个提问）', () => {
    const z = fixtureOverview.bots.find((b) => b.name === '总管')!
    expect(z.role).toBe('chief')
    expect(z.waitingOwner).toBe(true)
    expect(z.activityText).toContain('等你')
  })
  it('每个机器人线程 6–10 条消息', () => {
    for (const t of fixtureThreads) expect(t.messages.length).toBeGreaterThanOrEqual(6)
    // P73e：总管私聊里加了三问与组队卡样例（15 条），上限只对其余线程生效；总管线程另有下面的断言。
    for (const t of fixtureThreads.filter(thread => thread.threadId !== 'bot-zongguan')) expect(t.messages.length).toBeLessThanOrEqual(10)
  })
})

describe('样例：线程内容覆盖', () => {
  const allKinds = fixtureThreads.flatMap((t) => t.messages.map((m) => m.kind))
  const cards = fixtureThreads.flatMap((t) => t.messages.map((m) => m.card).filter((c): c is NonNullable<typeof c> => c !== null))
  it('至少一张提问卡片（带选项）', () => {
    const q = cards.find((c) => c.type === 'question')!
    expect(q.options.length).toBeGreaterThan(0)
    expect(q.defaultOption).toBeTruthy()
  })
  it('至少一张审批卡片', () => {
    expect(cards.some((c) => c.type === 'approval')).toBe(true)
  })
  it('至少一条汇报与一条日报', () => {
    expect(allKinds).toContain('report')
    expect(allKinds).toContain('digest')
  })
  it('文案是中文（不含 lorem ipsum）', () => {
    const all = fixtureThreads.flatMap((t) => t.messages.map((m) => m.text)).join(' ')
    expect(all).not.toMatch(/lorem/i)
    expect(all).toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('样例：收件箱 / 活动流 / 为什么醒', () => {
  it('收件箱 7 项（P69 加了一条旧式审批，P72e 加了一条约定确认，P73e 加了一条组队确认，P75r7 加了一条学习选会话）；新式审批带 approval 四项，旧式没有', () => {
    expect(fixtureInbox.items).toHaveLength(7)
    const fresh = fixtureInbox.items.find(i => i.id === 'inbox-a1')!
    expect(fresh.approval?.actionText).toBeTruthy()
    expect(fresh.approval?.ownerReason).toBeTruthy()
    expect(fresh.approval?.riskNote).toBeTruthy()
    expect(fresh.approval?.argsPreview).toContain('\n')
    const legacy = fixtureInbox.items.find(i => i.id === 'inbox-a2')!
    expect(legacy.type).toBe('approval')
    expect('approval' in legacy).toBe(false)
  })
  it('活动流 10 条', () => {
    expect(fixtureActivity.rows).toHaveLength(10)
  })
  it('巡检员的为什么醒/没醒有 8 条（含被拦截的）', () => {
    const a = fixtureBots['bot-xunjian']!.appraisals
    expect(a).toHaveLength(8)
    expect(a.some((r) => r.decision === 'woke')).toBe(true)
    expect(a.some((r) => r.decision === 'suppressed')).toBe(true)
  })
  it('设置可用（P75r7 复核：已无调用方的最近会话样例一并删去）', () => {
    expect(fixtureSettings.settings.timezone).toBe('Asia/Shanghai')
  })
})

describe('样例：总览里的待办数字和收件箱样例对得上（A-5，P3）', () => {
  it('总数和各类型的数都等于收件箱样例里的实际条数', () => {
    const count = (type: string) => fixtureInbox.items.filter((item) => item.type === type).length
    expect(fixtureOverview.inbox.total).toBe(fixtureInbox.items.length)
    expect(fixtureOverview.inbox.approvals).toBe(count('approval'))
    expect(fixtureOverview.inbox.questions).toBe(count('question'))
    expect(fixtureOverview.inbox.proposals).toBe(count('proposal'))
    expect(fixtureOverview.inbox.alerts).toBe(count('alert'))
  })
})
