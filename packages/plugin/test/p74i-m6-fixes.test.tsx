/**
 * P74i-m6 的测试：并入核心 P74r15 之后的同步，以及 m5 留下的两项（维护卡 docs/tasks/P74i-m6-sync-r15-and-leftovers.md）。
 *
 * 覆盖：
 * - 第 0 步：样例与快照里不再带核心 P74r15 之前的旧句；新增与改动过的预览快照与实时样例逐字相同；
 * - 第 1 节：核心 P74r15 新增的五句话各在对应入口渲染出来的文字里（逐字）；
 * - 第 2 节：进度行的两个状态小标签 `已完成（你暂不发布）`、`已完成（没有发布）` 逐字出现在进度行里；
 * - 第 3 节：审批附言框（普通审批与发布审批）上限 200 个字、179 个字没有提示、180 与 200 个字各一条逐字。
 *
 * 为什么用「入口」取样例：预览入口（?job=）的状态由 applyPreviewJobEntry 准备，这里照走查时看到的那份状态断言，
 * 而不是直接读样例变量——这样「看得到」是对入口说的，不只是样例里有这句话。
 *
 * 测试环境没有真 React：只渲染传进来的这一个组件，子组件不执行（见 helpers/hook-host.ts）。
 */
import { describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { NOTE_CHAR_LIMIT } from '../src/client/logic/char-count.js'
import {
  sampleApprovalInboxEntries, sampleApprovalThread, sampleChiefStallInboxEntry, sampleDeclinedByHubJob, sampleDeclinedByOwnerJob,
  sampleDeliveryStatesThread, sampleDeliveryTopicThread, sampleReviewTopicThread,
} from '../src/shared/fixture-job.js'
import * as previews from '../src/shared/fixture-job-preview.js'
import { applyPreviewJobEntry, basePreviewState, type PreviewJobEntry } from '../src/shared/preview-job-state.js'
import type { InboxItemView, ThreadMessageView, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

const NOW = Date.parse('2026-11-18T10:00:00+08:00')

// ---------- 小工具 ----------

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const noopActions = { onPick: async () => null }

/** 一个预览入口准备好之后的状态（走查时看到的那份）。 */
const stateOf = (entry: PreviewJobEntry) => applyPreviewJobEntry(basePreviewState(), entry, NOW)
/** 一个入口选中的线程。 */
const threadOfEntry = (entry: PreviewJobEntry): ThreadView => {
  const state = stateOf(entry)
  return state.threads[state.selectedThread!] as ThreadView
}

/** 把一个入口线程里所有折叠组逐个展开，返回展开后渲染出来的全部文字。 */
function foldsTextOf(thread: ThreadView): string {
  const views = new Map<string, ThreadMessageView>(thread.messages.map(message => [message.id, message]))
  const parts: string[] = []
  for (const item of thread.floors!.items) {
    if (item.kind !== 'fold') continue
    const host = createHookHost()
    const tree = host.render(WorkFold, { fold: item, views })
    // 模拟原生 details 展开后抛出的 toggle 事件。
    ;(findElements(tree, 'details')[0]!.props.onToggle as (event: unknown) => void)({ target: { open: true } })
    parts.push(textOf(host.render(WorkFold, { fold: item, views })))
  }
  return parts.join('\n')
}

// ---------- 第 0 步 ----------

describe('第 0 步：样例与快照里没有核心 P74r15 之前的旧句', () => {
  // 六种旧句的特征加连着两个句号；样例（live）与快照（preview）两处都查。
  const OLD_PHRASES = ['。。', '一直没有提交核对结论', '一直没有回答', '叫了你两次', '两次被叫醒', '的发布这一步没有做成'] as const
  const everything = (): string => JSON.stringify([
    previews, sampleReviewTopicThread, sampleDeliveryTopicThread, sampleApprovalThread, sampleDeliveryStatesThread,
    sampleChiefStallInboxEntry, sampleApprovalInboxEntries,
  ])
  it.each(OLD_PHRASES)('预览快照与样例里没有旧句：%s', phrase => {
    expect(everything()).not.toContain(phrase)
  })

  it('本卡改动的快照导出与实时生成的样例逐字相同', () => {
    expect(JSON.stringify(previews.previewReviewTopicThread)).toBe(JSON.stringify(sampleReviewTopicThread))
    expect(JSON.stringify(previews.previewDeliveryTopicThread)).toBe(JSON.stringify(sampleDeliveryTopicThread))
    expect(JSON.stringify(previews.previewApprovalThread)).toBe(JSON.stringify(sampleApprovalThread))
    expect(JSON.stringify(previews.previewDeliveryStatesThread)).toBe(JSON.stringify(sampleDeliveryStatesThread))
    expect(JSON.stringify(previews.previewChiefStallInboxEntry)).toBe(JSON.stringify(sampleChiefStallInboxEntry))
  })
})

// ---------- 第 1 节 ----------

describe('第 1 节：核心 P74r15 新增的五句话在预览入口里看得到（逐字）', () => {
  it('1. 工作往来：{员工}的一个回合超过 60 分钟，中心已结束它。已告诉总管。（?job=review，工作往来折叠组展开）', () => {
    expect(foldsTextOf(threadOfEntry('review'))).toContain('林舟的一个回合超过 60 分钟，中心已结束它。已告诉总管。')
  })

  it('2. 「待你处理」里的「没有进展」条目：标题 {标题}：没有进展，正文逐字，按钮与现有「没有进展」条目相同（?job=escalation-states）', () => {
    const entry = stateOf('escalation-states').inbox!.items.find(item => item.id === 'i_sampleview9') as InboxItemView
    expect(entry.title).toBe('报名名单导出：没有进展')
    expect(entry.jobEntry?.kind).toBe('stall')
    const card = itemToCard(entry)
    const text = textOf(createHookHost().render(InboxCard, { card, actions: noopActions, busy: false }))
    expect(text).toContain('总管的核对回合在第 2 轮里已被中心结束两次（最近一次：超过 60 分钟），中心不再自动叫醒总管。')
    expect(text).toContain('报名名单导出：没有进展')
    // 按钮与基础样例里的「没有进展」条目一致：「再提醒一次」「暂停」。
    expect(entry.options).toEqual(['再提醒一次', '暂停'])
  })

  it('3a. 主题：约定第 {n} 版去掉了对外发布，但这次发布已经在执行，没有中止。（?job=delivery，工作往来折叠组展开）', () => {
    expect(foldsTextOf(threadOfEntry('delivery'))).toContain('约定第 5 版去掉了对外发布，但这次发布已经在执行，没有中止。')
  })

  it('3b. 主题：约定第 {n} 版去掉了对外发布；这次发布在此之前已经完成。（?job=delivery，同一个折叠组里的第二条）', () => {
    expect(foldsTextOf(threadOfEntry('delivery'))).toContain('约定第 6 版去掉了对外发布；这次发布在此之前已经完成。')
  })

  it('4. 总管私聊：{执行者}准备发布「{标题}」的回合超过 60 分钟，中心已结束它，这次没有发布。（?job=approval）', () => {
    const thread = threadOfEntry('approval')
    const host = createHookHost()
    const tree = host.render(ThreadPane, {
      threadId: thread.threadId, thread, loading: false, header: null, inputPlaceholderName: '总管', chiefEntry: true,
      banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined,
      actions: noopActions, busyInboxId: null, onRetry: () => undefined, error: null,      onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined,
    })
    expect(textOf(tree)).toContain('林舟准备发布「报名名单导出」的回合超过 60 分钟，中心已结束它，这次没有发布。')
  })
})

// ---------- 第 2 节 ----------

describe('第 2 节：进度行的两个状态小标签有样例（逐字）', () => {
  /** 一个入口线程的进度行，渲染出来的文字。 */
  const progressTextOf = (entry: PreviewJobEntry): string => {
    const progress = threadOfEntry(entry).progress
    if (progress === null || progress === undefined) throw new Error(`入口 ${entry} 的线程没有进度行`)
    return textOf(createHookHost().render(JobProgress, { progress }))
  }

  it('已完成（你暂不发布）：?job=review，主人自己点了暂不发布（endedBy 为 owner）', () => {
    expect(sampleDeclinedByOwnerJob.launch.endedBy).toBe('owner')
    expect(threadOfEntry('review').progress!.stateLabel).toBe('已完成（你暂不发布）')
    expect(progressTextOf('review')).toContain('已完成（你暂不发布）')
  })

  it('已完成（没有发布）：?job=delivery-states，中心结束了发布这一步（endedBy 为 hub）', () => {
    expect(sampleDeclinedByHubJob.launch.endedBy).toBe('hub')
    expect(threadOfEntry('delivery-states').progress!.stateLabel).toBe('已完成（没有发布）')
    expect(progressTextOf('delivery-states')).toContain('已完成（没有发布）')
  })
})

// ---------- 第 3 节 ----------

describe('第 3 节：审批附言框的字数上限与提示（普通审批、发布审批都算）', () => {
  const approvals = sampleApprovalInboxEntries as unknown as InboxItemView[]
  const normalApproval = approvals.find(item => item.approval?.launch === false)!
  const launchApproval = approvals.find(item => item.approval?.launch === true)!
  const KINDS: [string, InboxItemView][] = [['普通审批', normalApproval], ['发布审批', launchApproval]]

  /** 在审批的附言框里写 n 个字，返回输入框与它下面的字数提示（没有时 null）。 */
  const noteAt = (item: InboxItemView, count: number): { maxLength: unknown; hint: string | null } => {
    const host = createHookHost()
    const props = { card: itemToCard(item), actions: noopActions, busy: false }
    const note = findElements(host.render(InboxCard, props), 'input').find(node => node.props['aria-label'] === '审批附言（可不填）')!
    ;(note.props.onChange as (e: unknown) => void)({ target: { value: '字'.repeat(count) } })
    const hint = findElements(host.render(InboxCard, props), 'p').find(node => classOf(node) === 'ah-card-note-count')
    return { maxLength: note.props.maxLength, hint: hint === undefined ? null : textOf(hint) }
  }

  it('maxLength 为 200（用现有的 NOTE_CHAR_LIMIT）', () => {
    expect(NOTE_CHAR_LIMIT).toBe(200)
    for (const [kind, item] of KINDS) expect(noteAt(item, 0).maxLength, kind).toBe(200)
  })
  it('179 个字：没有提示', () => {
    for (const [kind, item] of KINDS) expect(noteAt(item, 179).hint, kind).toBeNull()
  })
  it('180 个字：180/200 字', () => {
    for (const [kind, item] of KINDS) expect(noteAt(item, 180).hint, kind).toBe('180/200 字')
  })
  it('200 个字：已到 200 字的上限', () => {
    for (const [kind, item] of KINDS) expect(noteAt(item, 200).hint, kind).toBe('已到 200 字的上限')
  })
})
