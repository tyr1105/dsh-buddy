/**
 * D06 第 4/5 条的客户端纯逻辑测试：
 * - 卡片提交分流（logic/cards.ts）：审批用 approvalId 走 decideApproval（绝不把
 *   inboxId 当 approvalId），其他卡走 answerInbox 且原样回传选项；提问自由文本放行。
 * - 推送范围刷新计划（logic/scopes.ts）：六个范围各自刷新对应视图，团队线程用
 *   botId=null 归位到 'team'，未知范围兜底刷总览 + 活动流。
 */
import { describe, expect, it } from 'vitest'
import { HUB_EVENT_SCOPES } from '@agent-hub/core'
import { cardSubmission, cardResultText, expiryMeaningOf, isApproveOption, type CardPayload } from '../src/client/logic/cards.js'
import { HUB_SCOPES, refreshPlan } from '../src/client/logic/scopes.js'

function card(overrides: Partial<CardPayload>): CardPayload {
  return {
    inboxId: 'inbox-1', approvalId: null, type: 'question', status: 'open',
    title: 't', body: 'b', options: ['可以', '先不要'], defaultOption: '可以', answer: null, expiresText: null,
    ...overrides,
  }
}

describe('cardSubmission：卡片提交分流（D06 第 4 条）', () => {
  it('审批卡用 approvalId 走 decideApproval；「批准」才 approve；附言可选', () => {
    const approval = card({ type: 'approval', approvalId: 'appr-9', options: ['批准', '拒绝'] })
    expect(cardSubmission(approval, '批准')).toEqual({ name: 'decideApproval', input: { id: 'appr-9', approve: true } })
    expect(cardSubmission(approval, '拒绝', '再想想')).toEqual({ name: 'decideApproval', input: { id: 'appr-9', approve: false, note: '再想想' } })
    expect(isApproveOption('批准')).toBe(true)
    expect(isApproveOption('拒绝')).toBe(false)
  })
  it('反例：审批提交的 id 绝不是 inboxId', () => {
    const approval = card({ inboxId: 'inbox-1', type: 'approval', approvalId: 'appr-9' })
    const result = cardSubmission(approval, '批准') as { name: string; input: { id: string } }
    expect(result.input.id).toBe('appr-9')
    expect(result.input.id).not.toBe('inbox-1')
  })
  it('提议 / 告警 / 提问走 answerInbox，选项原样回传', () => {
    const proposal = card({ type: 'proposal', options: ['接受', '不做'] })
    expect(cardSubmission(proposal, '不做')).toEqual({ name: 'answerInbox', input: { id: 'inbox-1', answer: '不做' } })
    const alert = card({ type: 'alert', options: ['知道了'] })
    expect(cardSubmission(alert, '知道了')).toEqual({ name: 'answerInbox', input: { id: 'inbox-1', answer: '知道了' } })
    const question = card({ type: 'question' })
    expect(cardSubmission(question, '可以')).toEqual({ name: 'answerInbox', input: { id: 'inbox-1', answer: '可以' } })
  })
  it('提问的自由文本同样走 answerInbox；空回答给中文错误', () => {
    expect(cardSubmission(card({ type: 'question' }), '我自己写一句')).toEqual({ name: 'answerInbox', input: { id: 'inbox-1', answer: '我自己写一句' } })
    expect(cardSubmission(card({}), '   ')).toEqual({ error: '回答：不能为空' })
  })
  it('旧数据没有 approvalId 的审批卡退回 answerInbox（core 会委托唯一的审批记录）', () => {
    const legacy = card({ type: 'approval', approvalId: null, options: ['批准', '拒绝'] })
    expect(cardSubmission(legacy, '批准')).toEqual({ name: 'answerInbox', input: { id: 'inbox-1', answer: '批准' } })
  })
})

describe('refreshPlan：六范围刷新计划（D06 第 5 条 / D07 第 25 条加强）', () => {
  it('词表与 core 的 HUB_EVENT_SCOPES 逐项一致（core 改名/加项时这里要报警）', () => {
    expect(Object.keys(HUB_SCOPES).sort()).toEqual(Object.keys(HUB_EVENT_SCOPES).sort())
    for (const key of Object.keys(HUB_EVENT_SCOPES) as Array<keyof typeof HUB_EVENT_SCOPES>) {
      expect(HUB_SCOPES[key as keyof typeof HUB_SCOPES]).toBe(HUB_EVENT_SCOPES[key])
    }
    expect(Object.values(HUB_SCOPES).sort()).toEqual(['activity', 'bot', 'inbox', 'overview', 'settings', 'thread'])
  })
  // D07 第 25 条：每个 scope 用 toEqual 断言**完整**刷新计划（弱断言会让错接存活）。
  it('overview：全局只刷总览；带 id 顺带刷详情', () => {
    expect(refreshPlan('overview', null)).toEqual({ overview: true, bots: [], threads: [], inbox: false, activity: false, settings: false })
    expect(refreshPlan('overview', 'b_1')).toEqual({ overview: true, bots: ['b_1'], threads: [], inbox: false, activity: false, settings: false })
  })
  it('bot：必带 botId → 刷该机器人详情 + 总览，不动线程/收件箱/活动/设置', () => {
    expect(refreshPlan('bot', 'b_1')).toEqual({ overview: true, bots: ['b_1'], threads: [], inbox: false, activity: false, settings: false })
    expect(refreshPlan('bot', null)).toEqual({ overview: true, bots: [], threads: [], inbox: false, activity: false, settings: false })
  })
  it('thread：机器人线程带 id；null 专指 team；同时刷总览（未读汇总）', () => {
    expect(refreshPlan('thread', 'b_2')).toEqual({ overview: true, bots: [], threads: ['b_2'], inbox: false, activity: false, settings: false })
    expect(refreshPlan('thread', null)).toEqual({ overview: true, bots: [], threads: ['team'], inbox: false, activity: false, settings: false })
  })
  it('inbox：刷收件箱 + 总览计数', () => {
    expect(refreshPlan('inbox', null)).toEqual({ overview: true, bots: [], threads: [], inbox: true, activity: false, settings: false })
  })
  it('activity：只刷活动流', () => {
    expect(refreshPlan('activity', 'b_1')).toEqual({ overview: false, bots: [], threads: [], inbox: false, activity: true, settings: false })
  })
  it('settings：只刷设置视图', () => {
    expect(refreshPlan('settings', null)).toEqual({ overview: false, bots: [], threads: [], inbox: false, activity: false, settings: true })
  })
  it('未知 scope（向前兼容）兜底刷总览 + 活动流；内部表名不再是特殊分支（逐项断言）', () => {
    for (const scope of ['wakes', 'bots', 'watches', 'queue', 'no-such']) {
      expect(refreshPlan(scope)).toEqual({ overview: true, bots: [], threads: [], inbox: false, activity: true, settings: false })
    }
  })
})

describe('cardResultText / expiryMeaningOf（D07 第 11/18 条）', () => {
  it('只有主人亲手作答才写「你选了：X」', () => {
    expect(cardResultText(card({ status: 'answered', answer: '可以' }))).toBe('你选了：可以')
  })
  it('过期/撤回/关闭按状态如实写，不冒充主人选的', () => {
    expect(cardResultText(card({ status: 'expired', answer: '先不要' }))).toBe('已过期，已按默认：先不要')
    expect(cardResultText(card({ status: 'withdrawn', answer: '到期撤回' }))).toBe('已撤回')
    expect(cardResultText(card({ status: 'closed', answer: '已关闭' }))).toBe('已关闭')
  })
  it('open 还没结果：null', () => {
    expect(cardResultText(card({}))).toBeNull()
  })
  it('有效期带含义：提问按默认、审批视为拒绝、提议自动撤回（规格第 5 节）', () => {
    expect(expiryMeaningOf(card({ type: 'question', expiresText: '3 天后', defaultOption: '先不要' }))).toBe('3 天前未答复按默认「先不要」处理')
    expect(expiryMeaningOf(card({ type: 'approval', expiresText: '24 小时后' }))).toBe('24 小时前有效，过期视为拒绝')
    expect(expiryMeaningOf(card({ type: 'proposal', expiresText: '7 天后' }))).toBe('7 天前未答复自动撤回')
    expect(expiryMeaningOf(card({ type: 'alert', expiresText: '长期' }))).toBe('长期')
    expect(expiryMeaningOf(card({ type: 'question', expiresText: null }))).toBeNull()
  })
})
