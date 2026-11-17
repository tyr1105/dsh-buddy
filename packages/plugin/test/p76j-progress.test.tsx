/**
 * P76j 第 5 节第 5 条：进度行第三行「消耗」。
 * 有 costTurns 时整行是按钮（aria-expanded），默认收起；点一下展开每个回合，再点收起；
 * 没有明细时只是文字；没有消耗行（旧数据）时第三行不出现。
 */
import { describe, expect, it, vi } from 'vitest'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { sampleJobProgressWithCost } from '../src/shared/fixture-budget.js'
import { createHookHost } from './helpers/hook-host.js'
import type { StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

function allElements(node: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements)
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [element, ...allElements(element.props.children)]
}

/** 第三行那个可展开的按钮。 */
function costToggle(tree: unknown): StubElement | undefined {
  return allElements(tree).find(element => element.props.className === 'ah-job-cost ah-job-cost-toggle')
}

describe('进度行第三行：消耗与逐回合明细', () => {
  it('有明细：默认收起（aria-expanded 为 false），只显示第三行的文字', () => {
    const host = createHookHost()
    const tree = host.render(JobProgress, { progress: sampleJobProgressWithCost })
    expect(textOf(tree)).toContain(sampleJobProgressWithCost.costLine!)
    const toggle = costToggle(tree)!
    expect(toggle).toBeDefined()
    expect(toggle.props.type).toBe('button')
    expect(toggle.props['aria-expanded']).toBe(false)
    expect(allElements(tree).some(element => element.props.className === 'ah-job-cost-turns')).toBe(false)
  })

  it('点一下展开：每个回合一行，时间、谁、步骤、token 都在', () => {
    const host = createHookHost()
    host.render(JobProgress, { progress: sampleJobProgressWithCost })
    const toggle = costToggle(host.render(JobProgress, { progress: sampleJobProgressWithCost }))!
    ;(toggle.props.onClick as () => void)()
    const tree = host.render(JobProgress, { progress: sampleJobProgressWithCost })
    expect(costToggle(tree)!.props['aria-expanded']).toBe(true)
    const text = textOf(tree)
    for (const row of sampleJobProgressWithCost.costTurns ?? []) {
      expect(text).toContain(row.at)
      expect(text).toContain(row.who)
      expect(text).toContain(row.step)
      expect(text).toContain(row.tokens)
    }
    const turns = allElements(tree).find(element => element.props.className === 'ah-job-cost-turns')!
    expect(allElements(turns).filter(element => element.type === 'li')).toHaveLength(sampleJobProgressWithCost.costTurns!.length)
  })

  it('再点收起：明细消失，aria-expanded 回到 false', () => {
    const host = createHookHost()
    host.render(JobProgress, { progress: sampleJobProgressWithCost })
    ;(costToggle(host.render(JobProgress, { progress: sampleJobProgressWithCost }))!.props.onClick as () => void)()
    host.render(JobProgress, { progress: sampleJobProgressWithCost })
    const toggle = costToggle(host.render(JobProgress, { progress: sampleJobProgressWithCost }))!
    ;(toggle.props.onClick as () => void)()
    const tree = host.render(JobProgress, { progress: sampleJobProgressWithCost })
    expect(costToggle(tree)!.props['aria-expanded']).toBe(false)
    expect(allElements(tree).some(element => element.props.className === 'ah-job-cost-turns')).toBe(false)
  })

  it('没有明细（旧数据、还没记过账）：第三行只是文字，不是按钮', () => {
    const progress = { ...sampleJobProgressWithCost, costTurns: [] }
    const tree = createHookHost().render(JobProgress, { progress })
    expect(textOf(tree)).toContain(progress.costLine!)
    expect(costToggle(tree)).toBeUndefined()
    expect(allElements(tree).some(element => element.props.className === 'ah-job-cost')).toBe(true)
  })

  it('没有消耗行：第三行不出现', () => {
    const progress = { ...sampleJobProgressWithCost, costLine: null, costTurns: undefined }
    const tree = createHookHost().render(JobProgress, { progress })
    expect(allElements(tree).some(element => String(element.props.className).includes('ah-job-cost'))).toBe(false)
  })
})
