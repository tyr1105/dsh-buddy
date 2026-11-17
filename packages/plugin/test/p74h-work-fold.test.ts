/**
 * P74h 工作往来折叠组的测试：收起时显示参与者、条数、日期和「最近」一句；展开后每条
 * 「谁 → 谁」；键盘可以用 Enter 或空格展开收起（原生 details 的行为——这里断言用的正是
 * 原生 details/summary，而不是自定义按钮）；交回卡、核对卡在组内画出。样例取自
 * fixture-job.ts（core 的视图函数生成），不手写视图字段。
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { sampleJobTopicThread } from '../src/shared/fixture-job.js'
import { JobCard } from '../src/client/components/JobCard.js'
import { workHead } from '../src/client/logic/job.js'
import type { ThreadMessageView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')

/** 楼层视图里第一组工作往来（B1：开工、提问、回答、中心概括）和它的消息视图。 */
const fold1 = sampleJobTopicThread.floors!.items[2]!
const fold2 = sampleJobTopicThread.floors!.items[4]!
if (fold1.kind !== 'fold' || fold2.kind !== 'fold') throw new Error('样例的第三、五项应是折叠组')
const viewsById = new Map<string, ThreadMessageView>(sampleJobTopicThread.messages.map(message => [message.id, message]))

describe('工作往来折叠组（P74h）', () => {
  it('收起时显示「工作往来」、参与者（顿号连接）、条数、日期范围和「最近」一句', () => {
    const tree = createHookHost().render(WorkFold, { fold: fold1, views: viewsById })
    const line = findElements(tree, 'span').find(node => classOf(node) === 'ah-work-fold-line')!
    expect(textOf(line)).toContain('工作往来')
    expect(textOf(line)).toContain('林舟、总管')
    expect(textOf(line)).toContain('4 条')
    expect(textOf(line)).toContain('11月11日至12日')
    expect(textOf(line)).toContain('展开')
    expect(textOf(findElements(tree, 'span').find(node => classOf(node) === 'ah-work-fold-latest')))
      .toBe('最近：总管按约定答复了林舟 1 个问题，不需要你处理。')
  })

  it('用的是原生 details/summary：Enter 或空格展开收起由浏览器自带，不需要自己写键盘逻辑', () => {
    const tree = createHookHost().render(WorkFold, { fold: fold1, views: viewsById })
    expect(findElements(tree, 'details').length).toBe(1)
    expect(findElements(tree, 'summary').length).toBe(1)
    // 组内没有自定义的展开按钮（展开收起只靠 summary 本身）。
    expect(findElements(tree, 'button')).toHaveLength(0)
  })

  it('展开后每条一行「谁 → 谁」（没有接收者时只写发出者）；中心提示居中；时间用视图里核心算好的（P74i-m2 低-2）', () => {
    const host = createHookHost()
    const tree = host.render(WorkFold, { fold: fold1, views: viewsById })
    // 模拟原生 details 展开后抛出的 toggle 事件：展开状态记在组件状态里。
    const details = findElements(tree, 'details')[0]!
    ;(details.props.onToggle as (event: unknown) => void)({ target: { open: true } })
    const open = host.render(WorkFold, { fold: fold1, views: viewsById })
    expect(textOf(findElements(open, 'summary')[0])).toContain('已展开，点击收起')
    const heads = findElements(open, 'p').filter(node => classOf(node) === 'ah-work-meta').map(textOf)
    // 行头的时间不再是本机时区另算，而是消息视图里的 timeText（核心按中心设置的时区生成，P74i-m2 低-2）。
    expect(heads).toHaveLength(fold1.messages.filter(entry => entry.message.from !== 'hub').length)
    for (const entry of fold1.messages) {
      if (entry.message.from === 'hub') continue
      const view = viewsById.get(entry.message.id)!
      expect(heads, entry.message.id).toContain(`${workHead(entry.fromName, entry.toNames)}　${view.timeText}`)
    }
    expect(heads.some(head => head.startsWith('林舟　'))).toBe(true)
    // 中心提示画成居中小字（不算参与者）。
    expect(textOf(findElements(open, 'p').find(node => classOf(node) === 'ah-work-note')))
      .toBe('总管按约定答复了林舟 1 个问题，不需要你处理。')
  })

  it('交回卡在组内画出（core 的消息视图里带 jobCard）', () => {
    const host = createHookHost()
    const tree = host.render(WorkFold, { fold: fold2, views: viewsById })
    const details = findElements(tree, 'details')[0]!
    ;(details.props.onToggle as (event: unknown) => void)({ target: { open: true } })
    const open = host.render(WorkFold, { fold: fold2, views: viewsById })
    expect(findElements(open, JobCard).length).toBe(1)
  })
})
