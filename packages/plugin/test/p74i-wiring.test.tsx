/**
 * P74i 接线测试：宿主命令表的四条新命令（acceptJob、chooseJobOption、answerJobCap、answerJobStall）
 * 整对象透传给 core；样例模式（FixtureHub）里这四条命令改样例状态；折叠组里卡片前面加行头
 * 「谁 → 谁　时间」且截图定位参数取卡片视图的两个编号；截图大图按模态弹窗处理（无障碍契约另册登记）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, UiApi } from '@agent-hub/core'
import { dispatchCommand } from '../src/host/real-hub.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { JobCard } from '../src/client/components/JobCard.js'
import { sampleJobTopicThread } from '../src/shared/fixture-job.js'
import { previewDeliveryTopicThread } from '../src/shared/fixture-job-preview.js'
import type { ThreadMessageView, TopicFloorsView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')

/** 只记录调用的假 UiApi（四条新命令以外的方法不会被碰到）。 */
function fakeApi(): UiApi & { calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = []
  const ok = () => Promise.resolve({ ok: true } as CommandResult)
  const record = (name: string) => (input: unknown) => { calls.push({ name, input }); return ok() }
  return {
    calls,
    acceptJob: record('acceptJob') as never,
    chooseJobOption: record('chooseJobOption') as never,
    answerJobCap: record('answerJobCap') as never,
    answerJobStall: record('answerJobStall') as never,
  } as unknown as UiApi & { calls: Array<{ name: string; input: unknown }> }
}

describe('宿主命令表（P74i）', () => {
  it('四条新命令整对象透传给 core（UiApi 内部再用 zod 校验）', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'acceptJob', { jobId: 'job_0000000001', stage: 1, revision: 0 })
    await dispatchCommand(api, 'chooseJobOption', { jobId: 'job_0000000001', stage: 1, option: 2, revision: 1 })
    await dispatchCommand(api, 'answerJobCap', { jobId: 'job_0000000001', answer: '先停下' })
    await dispatchCommand(api, 'answerJobStall', { jobId: 'job_0000000001', answer: '再叫一次' })
    expect(api.calls).toEqual([
      { name: 'acceptJob', input: { jobId: 'job_0000000001', stage: 1, revision: 0 } },
      { name: 'chooseJobOption', input: { jobId: 'job_0000000001', stage: 1, option: 2, revision: 1 } },
      { name: 'answerJobCap', input: { jobId: 'job_0000000001', answer: '先停下' } },
      { name: 'answerJobStall', input: { jobId: 'job_0000000001', answer: '再叫一次' } },
    ])
  })

  it('参数原样透传（缺哪一项由 core 的 zod 用中文说清，边界不另抄一份校验）', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'acceptJob', {})
    expect(api.calls).toEqual([{ name: 'acceptJob', input: {} }])
  })
})

describe('样例模式的四条命令（P74i）', () => {
  it('四条命令都安静成功（样例收件箱里没有对应条目时不报错、不改状态）', async () => {
    const hub = new FixtureHub()
    const before = (await hub.inbox()).items.length
    expect((await hub.command('acceptJob', { jobId: 'job_sample0004', stage: 1 })).ok).toBe(true)
    expect((await hub.command('chooseJobOption', { jobId: 'job_sample0006', stage: 1, option: 0 })).ok).toBe(true)
    expect((await hub.command('answerJobCap', { jobId: 'job_sample0006', answer: '先停下' })).ok).toBe(true)
    expect((await hub.command('answerJobStall', { jobId: 'job_sample0006', answer: '再叫一次' })).ok).toBe(true)
    expect((await hub.inbox()).items.length).toBe(before)
  })
})

/** 从样例主题视图里取装着卡片消息的那个折叠组。 */
function cardFold(thread: { floors?: TopicFloorsView | null }): Extract<TopicFloorsView['items'][number], { kind: 'fold' }> {
  type Fold = Extract<TopicFloorsView['items'][number], { kind: 'fold' }>
  const fold = thread.floors!.items.find((item): item is Fold => item.kind === 'fold' && item.messages.some(entry => entry.message.kind === 'job_card'))
  if (fold === undefined) throw new Error('样例主题应有装卡片的折叠组')
  return fold
}

describe('折叠组里的卡片行（P74i）', () => {
  it('交回卡前面加与普通往来相同的行头「谁 → 谁　时间」（卡片消息带接收者）', () => {
    const thread = sampleJobTopicThread
    const fold = cardFold(thread)
    const views = new Map<string, ThreadMessageView>(thread.messages.map(message => [message.id, message]))
    const tree = createHookHost().render(WorkFold, { fold, views })
    const cardRow = findElements(tree, 'div').find(node => classOf(node) === 'ah-work-row ah-work-card-row')!
    expect(textOf(cardRow)).toContain('林舟 → 评审员、总管　11月16日 11:20')
    // 卡片本身仍在（JobCard 收到视图，截图定位参数取卡片视图的两个编号）。
    const card = findElements(cardRow, JobCard)[0]!
    expect(card.props.shotRef).toEqual({ jobId: 'job_sample0001', submissionId: 'jsb_sample001' })
  })

  it('交付卡的截图定位参数取视图的 evidenceJobId、evidenceSubmissionId', () => {
    const thread = previewDeliveryTopicThread as unknown as { messages: Array<{ jobCard?: { kind: string; evidenceJobId: string | null; evidenceSubmissionId: string | null } }> }
    const deliveryMessage = thread.messages.find(message => message.jobCard?.kind === 'delivery')
    expect(deliveryMessage?.jobCard?.evidenceJobId).toBe('job_sample0004')
    expect(deliveryMessage?.jobCard?.evidenceSubmissionId).toBe('jsb_sample032')
  })
})
