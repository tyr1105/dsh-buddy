/**
 * P75k：主题里的「复盘」折叠组、复盘卡与技能核对卡（任务卡第 6 节，第 12 节第 4 条）。
 * 样例是 shared/fixture-retro.ts 由 core 的线程视图生成的主题线程（设计稿 A、B 的数据），快照在 fixture-retro-preview.ts。
 * 覆盖：折叠组带「复盘」标题（其余组仍是「工作往来」）；两种卡逐字渲染 core 给的文字；核对卡三种状态；
 * 复盘卡、技能核对卡在白名单里，主题线程把它们交给 JobCard；这两种卡没有按钮；折叠组里的截图定位逻辑跳过它们。
 */
import { describe, expect, it, vi } from 'vitest'
import { JobCard } from '../src/client/components/JobCard.js'
import { RetroCard, SkillCheckCard } from '../src/client/components/SkillCards.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { sampleJobTopicThread } from '../src/shared/fixture-job.js'
import { previewRetroTopicThread } from '../src/shared/fixture-retro-preview.js'
import { DRAWABLE_JOB_CARD_KINDS } from '../src/shared/job-card-kinds.js'
import type { RetroCardView, SkillCheckCardView, ThreadMessageView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

const thread = previewRetroTopicThread
const fold = thread.floors!.items.find(item => item.kind === 'fold')!
if (fold.kind !== 'fold') throw new Error('样例里没有折叠组')
const viewsById = new Map<string, ThreadMessageView>(thread.messages.map(message => [message.id, message]))
const cards = thread.messages.flatMap(message => message.jobCard !== undefined && message.jobCard !== null ? [message.jobCard] : [])
const retroCards = cards.filter((card): card is RetroCardView => card.kind === 'retro')
const checkCards = cards.filter((card): card is SkillCheckCardView => card.kind === 'skill_check')

describe('「复盘」折叠组', () => {
  it('整组都是复盘类往来时 core 给 label「复盘」，折叠行开头显示它；摘要与最近一句照旧', () => {
    expect(fold.label).toBe('复盘')
    const tree = createHookHost().render(WorkFold, { fold, views: viewsById })
    const summary = findElements(tree, 'summary')[0]!
    expect(textOf(summary)).toContain('复盘')
    expect(textOf(summary)).not.toContain('工作往来')
    // 参与者、条数、日期范围与「最近：……」仍是 core 算的那几句（foldSummary 的写法不变）。
    expect(textOf(summary)).toContain('林舟、评审员、总管')
    expect(textOf(summary)).toContain('7 条')
    expect(textOf(summary)).toContain('最近：2 条技能更新核对通过，写入技能库。')
  })

  it('没有 label 的组（普通工作往来）开头仍是「工作往来」', () => {
    const plain = sampleJobTopicThread.floors!.items.find(item => item.kind === 'fold')!
    if (plain.kind !== 'fold') throw new Error('样例里没有折叠组')
    expect(plain.label).toBeUndefined()
    const views = new Map<string, ThreadMessageView>(sampleJobTopicThread.messages.map(message => [message.id, message]))
    expect(textOf(findElements(createHookHost().render(WorkFold, { fold: plain, views }), 'summary')[0])).toContain('工作往来')
  })

  it('展开后组里六张卡（三张复盘卡、三张核对卡）都交给 JobCard，小结是一行往来文字；没有截图定位参数', () => {
    const tree = createHookHost().render(WorkFold, { fold, views: viewsById })
    const jobCards = findElements(tree, JobCard)
    expect(jobCards).toHaveLength(6)
    expect(jobCards.map(element => (element.props.card as { kind: string }).kind)).toEqual(['retro', 'retro', 'skill_check', 'skill_check', 'retro', 'skill_check'])
    // 复盘卡与核对卡没有证据截图：不带 shotRef。
    expect(jobCards.every(element => element.props.shotRef === null)).toBe(true)
    expect(textOf(tree)).toContain('2 条技能更新核对通过，写入技能库。其中 1 条改写后通过。')
    // 每张卡的行头是「谁 → 谁」。
    expect(textOf(tree)).toContain('林舟 → 评审员')
    expect(textOf(tree)).toContain('评审员 → 总管')
  })

  it('主题线程（TopicThreadBody）把「复盘」折叠组画在两条楼层之后', () => {
    const model = buildTopicThread(thread.messages, thread.hasMore, { hasAgreement: false })
    const tree = createHookHost().render(TopicThreadBody, {
      model, replying: [], actions: { onPick: async () => null } as never, busyInboxId: null, floors: thread.floors,
    })
    const folds = findElements(tree, WorkFold)
    expect(folds).toHaveLength(1)
    expect((folds[0]!.props.fold as { label?: string }).label).toBe('复盘')
  })
})

describe('白名单与分派', () => {
  it('复盘卡、技能核对卡在白名单里（七种）；JobCard 对它们画出内容，其余未知种类仍不画', () => {
    expect([...DRAWABLE_JOB_CARD_KINDS]).toEqual(['submission', 'review', 'delivery', 'escalation', 'receipt', 'retro', 'skill_check'])
    for (const card of cards) expect(createHookHost().render(JobCard, { card })).not.toBeNull()
  })
})

describe('复盘卡逐字渲染 core 的卡片视图（设计稿 A）', () => {
  it('林舟的复盘卡：头、标题、计数一行；三行出处与去向；底部一句；没有按钮', () => {
    const card = retroCards[0]!
    const tree = createHookHost().render(RetroCard, { card })
    const text = textOf(tree)
    expect(card.title).toBe('林舟　活动报名页')
    expect(card.countsText).toBe('出处 3 条　技能更新 1 条')
    for (const piece of [card.head, card.title, card.countsText, card.footer!]) expect(text).toContain(piece)
    for (const row of card.rows) {
      for (const piece of [row.sourceKindText, row.sourceText, row.target, row.targetDetail!]) expect(text).toContain(piece)
    }
    expect(findElements(tree, 'li').filter(row => String(row.props.className) === 'ah-retro-row')).toHaveLength(3)
    expect(findElements(tree, 'button')).toHaveLength(0)
    // 设计稿 A 的几句话（逐字）。
    expect(text).toContain('第 1 轮退回第 3 条：「提示文字是「手机号格式不正确」，与约定不一致。」')
    expect(text).toContain('更新「表单页做法」')
    expect(text).toContain('记为「表单页」类任务的第 1 次数据，供下次对比。')
    expect(text).toContain('两处新增合并为一次更新：「表单页做法」第 1 版改为第 2 版，等评审员核对。')
  })

  it('评审员的复盘卡与改写卡：新建技能一行；改写卡标题带（改写）、计数只写技能更新', () => {
    const reviewer = retroCards[1]!
    expect(textOf(createHookHost().render(RetroCard, { card: reviewer }))).toContain('新建「表单类交付核对」')
    const rewrite = retroCards[2]!
    expect(rewrite.title).toBe('评审员　活动报名页（改写）')
    expect(rewrite.countsText).toBe('技能更新 1 条')
    expect(textOf(createHookHost().render(RetroCard, { card: rewrite }))).toContain('评审员　活动报名页（改写）')
  })

  it('footer 为空时不画底部一句', () => {
    const card = { ...retroCards[0]!, footer: null }
    const tree = createHookHost().render(RetroCard, { card })
    expect(findElements(tree, 'p').filter(row => String(row.props.className) === 'ah-job-footer')).toHaveLength(0)
  })
})

describe('技能核对卡逐字渲染 core 的卡片视图（设计稿 B）', () => {
  it('已写入：状态小章、出处原文块、更新内容块、三行检查全是「符合」，没有说明与底部', () => {
    const card = checkCards[0]!
    const tree = createHookHost().render(SkillCheckCard, { card })
    const text = textOf(tree)
    expect(card.stateText).toBe('已写入')
    for (const piece of [card.head, card.title, card.stateText, '出处原文', '更新内容']) expect(text).toContain(piece)
    for (const source of card.sources) { expect(text).toContain(source.kindText); expect(text).toContain(source.text) }
    for (const line of card.content) expect(text).toContain(line)
    for (const check of card.checks) { expect(text).toContain(check.label); expect(check.verdict).toBe('符合') }
    expect(findElements(tree, 'p').some(row => String(row.props.className) === 'ah-skillcheck-note')).toBe(false)
    expect(findElements(tree, 'p').some(row => String(row.props.className) === 'ah-job-footer')).toBe(false)
    expect(findElements(tree, 'button')).toHaveLength(0)
    // 设计稿 B 的文字（逐字）。
    expect(text).toContain('技能更新　「表单页做法」第 2 版')
    expect(text).toContain('页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。')
    expect(text).toContain('自测数据要覆盖选填项填写和不填两种情况。')
  })

  it('等待改写：「不符」那一项，核对人的说明与底部「最多改写一次」一句；符合与不符用不同的样式类', () => {
    const card = checkCards[1]!
    const tree = createHookHost().render(SkillCheckCard, { card })
    const text = textOf(tree)
    expect(card.stateText).toBe('等待改写')
    expect(text).toContain('不符')
    expect(text).toContain(card.note!)
    expect(text).toContain('一条更新最多改写一次，第二次仍不符就放弃，只留在记录里。')
    const verdicts = findElements(tree, 'strong')
    expect(verdicts.map(row => textOf(row))).toEqual(['符合', '符合', '不符'])
    expect(String(verdicts[0]!.props.className)).toContain('ah-skillcheck-ok')
    expect(String(verdicts[2]!.props.className)).toContain('ah-skillcheck-bad')
    // 状态小章用中性样式类，不冒充成功或失败。
    expect(findElements(tree, 'span').some(row => String(row.props.className).includes('ah-skillcheck-wait'))).toBe(true)
  })

  it('改写后已写入：底部「改写后核对通过。」；状态小章用成功样式类', () => {
    const card = checkCards[2]!
    const tree = createHookHost().render(SkillCheckCard, { card })
    expect(card.stateText).toBe('已写入')
    expect(textOf(tree)).toContain('改写后核对通过。')
    expect(findElements(tree, 'span').some(row => String(row.props.className).includes('ah-skillcheck-ok'))).toBe(true)
  })

  it('三张核对卡共用一份三项检查的名称', () => {
    for (const card of checkCards) expect(card.checks.map(check => check.label)).toEqual(['出处在记录里真实存在', '更新说的事，出处里说过', '没有超出出处的范围'])
  })
})
