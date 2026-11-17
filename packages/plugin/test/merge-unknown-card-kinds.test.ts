/**
 * 合并第三块与第四块之后的衔接测试：界面不会画的卡片种类不能让界面抛错，也不能画出内容。
 * P75k 画出了复盘卡（retro）与技能核对卡（skill_check）并加进白名单，所以这里的「不会画的种类」
 * 改用一个核心将来可能新增、插件还不认识的虚构种类；原来针对 retro 的三条断言同步改成针对这个虚构种类，
 * 另加断言：retro 与 skill_check 现在是会画的种类，JobCard 会画出内容。
 * - JobCard 遇到不认识的种类：返回 null。
 * - 守卫 isDrawableJobCard 按白名单判断：已画的七种为真，未来的新种类为假。
 * - 折叠组里遇到不认识种类的消息：整条跳过（不抛错、不取截图编号、不画卡片）。
 */
import { describe, expect, it, vi } from 'vitest'
import { JobCard } from '../src/client/components/JobCard.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { isDrawableJobCard } from '../src/shared/job-card-kinds.js'
import { sampleJobTopicThread, sampleReviewPassCard } from '../src/shared/fixture-job.js'
import type { JobCardView, ThreadMessageView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 按核心的复盘卡类型造一个最小的合法对象。 */
const retroCard = {
  kind: 'retro', head: '复盘', title: '测试复盘', countsText: '0 条', rows: [], footer: null,
} as unknown as JobCardView

/** 一个核心将来可能新增、插件还不认识的虚构种类。 */
const futureCard = { kind: 'future_kind', head: '未来的卡' } as unknown as JobCardView
/** 按核心的技能核对卡类型造一个最小的合法对象。 */
const skillCheckCard = {
  kind: 'skill_check', head: '核对', title: '测试核对', stateText: '已写入', sources: [], content: [], checks: [], note: null, footer: null,
} as unknown as JobCardView

describe('不会画的卡片种类（合并衔接）', () => {
  it('守卫按白名单判断：已画的种类（含 P75k 起的 retro、skill_check）为真，未知种类为假', () => {
    expect(isDrawableJobCard(sampleReviewPassCard)).toBe(true)
    expect(isDrawableJobCard(retroCard)).toBe(true)
    expect(isDrawableJobCard(skillCheckCard)).toBe(true)
    expect(isDrawableJobCard(futureCard)).toBe(false)
    expect(isDrawableJobCard(null)).toBe(false)
  })

  it('JobCard 遇到不认识的种类：不抛错，不渲染内容；retro 与 skill_check 会渲染内容', () => {
    const host = createHookHost()
    expect(host.render(JobCard, { card: futureCard })).toBeNull()
    expect(host.render(JobCard, { card: retroCard })).not.toBeNull()
    expect(host.render(JobCard, { card: skillCheckCard })).not.toBeNull()
  })

  it('折叠组遇到不认识种类的消息：整条跳过，不抛错', () => {
    // 取样例里的第一个折叠组，把其中第一条消息换成 retro 卡片消息。
    const fold = sampleJobTopicThread.floors?.items.find(item => item.kind === 'fold')
    expect(fold).toBeDefined()
    if (fold === undefined || fold.kind !== 'fold') return
    const entry = fold.messages[0]!
    const message = { ...entry.message, kind: 'job_card', from: 'someone' }
    const view = { id: message.id, jobCard: { ...futureCard, title: '测试复盘' } } as unknown as ThreadMessageView
    const onlyRetro = { ...fold, messages: [{ ...entry, message }] } as typeof fold
    const views = new Map<string, ThreadMessageView>([[message.id, view]])
    const tree = createHookHost().render(WorkFold, { fold: onlyRetro, views })
    // 折叠组本身照常画，但里面没有任何卡片行，也没有「更早的记录没加载」的提示。
    expect(findElements(tree, JobCard as never)).toHaveLength(0)
    const text = JSON.stringify(tree, (_k, v) => (typeof v === 'symbol' ? String(v) : v))
    expect(text).not.toContain('测试复盘')
    expect((tree as StubElement).type).toBe('details')
  })
})
