/**
 * P74i-m7 的测试：告警条目上的「恢复在岗」，以及并入核心 P74r16a、P74r16b 之后的同步
 * （维护卡 docs/tasks/P74i-m7-reinstate-button-and-sync-r16.md）。
 *
 * 覆盖：
 * - 第 0 步：样例与快照里没有核心 P74r16 之前的旧句；新增与改动过的快照导出与实时样例逐字相同；
 * - 第 1 节：带 reinstate 字段的告警条目有「知道了」「恢复在岗」两个按钮且主次分明；没有字段时只有「知道了」；
 *   点「恢复在岗」发出的答复是 reinstate；成功提示逐字；失败时显示核心的原文且条目不动；可达名称带条目标题；
 *   处理中两个按钮都禁用；
 * - 第 2 节：三句新句子各在对应预览入口渲染出来的文字里（逐字）。
 *
 * 为什么用「入口」取样例：预览入口（?job=）的状态由 applyPreviewJobEntry 准备，这里照走查时看到的那份状态断言，
 * 而不是直接读样例变量——这样「看得到」是对入口说的，不只是样例里有这句话。
 *
 * 测试环境没有真 React：只渲染传进来的这一个组件，子组件不执行（见 helpers/hook-host.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard, type CardActions } from '../src/client/components/Cards.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { cardSubmission } from '../src/client/logic/cards.js'
import { inboxHandledNotice } from '../src/client/logic/inbox-notice.js'
import { clearSentLines } from '../src/client/logic/inbox-objection.js'
import {
  SAMPLE_SUSPENDED_ALERT_BODY, SAMPLE_SUSPENDED_WAIT_TOPIC_ID, SAMPLE_SUSPENDED_YOU_TOPIC_ID,
  sampleDeliveryTopicThread, sampleSuspendedAlertInboxEntry, sampleSuspendedWaitThread, sampleSuspendedYouThread,
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
const buttons = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonByText = (tree: unknown, text: string): StubElement | undefined => buttons(tree).find(node => textOf(node) === text)
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
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

/** 入口 ?job=escalation-states 的「待你处理」里那条员工被停用的告警。 */
const alertOfEntry = (): InboxItemView => stateOf('escalation-states').inbox!.items.find(item => item.id === 'i_sampleview10') as InboxItemView
/** 同一条告警去掉 reinstate 字段（员工已在岗、手动停用等情形）。 */
const alertWithoutReinstate = (): InboxItemView => {
  const { reinstate: _unused, ...rest } = alertOfEntry()
  return rest as InboxItemView
}

beforeEach(() => clearSentLines())

// ---------- 第 0 步 ----------

describe('第 0 步：样例与快照里没有核心 P74r16 之前的旧句', () => {
  // 旧句的特征：告警标题的旧写法、停用原因的两种旧写法、「暂停，等你确认」清单里的「一句话」那一行、没有候选时的「排队中」括号。
  const OLD_PHRASES = ['告警：隔离', '越界尝试达到', '属于高风险动作', '一句话：', '（排队中）'] as const
  const everything = (): string => JSON.stringify([previews, sampleDeliveryTopicThread, sampleSuspendedAlertInboxEntry, sampleSuspendedWaitThread, sampleSuspendedYouThread])
  it.each(OLD_PHRASES)('预览快照与样例里没有旧句：%s', phrase => {
    expect(everything()).not.toContain(phrase)
  })
  it('告警正文不是旧写法「{名字} 已停用：{原因}」', () => {
    expect(SAMPLE_SUSPENDED_ALERT_BODY).not.toContain('已停用：')
    expect(sampleSuspendedAlertInboxEntry.title).not.toContain('告警')
  })

  it('本卡新增与改动的快照导出与实时生成的样例逐字相同', () => {
    expect(JSON.stringify(previews.previewDeliveryTopicThread)).toBe(JSON.stringify(sampleDeliveryTopicThread))
    expect(JSON.stringify(previews.previewSuspendedWaitThread)).toBe(JSON.stringify(sampleSuspendedWaitThread))
    expect(JSON.stringify(previews.previewSuspendedYouThread)).toBe(JSON.stringify(sampleSuspendedYouThread))
    expect(JSON.stringify(previews.previewSuspendedAlertInboxEntry)).toBe(JSON.stringify(sampleSuspendedAlertInboxEntry))
  })
})

// ---------- 第 1 节 ----------

describe('第 1 节：告警条目上的「恢复在岗」', () => {
  const render = (item: InboxItemView, extra: { busy?: boolean; actions?: CardActions } = {}) => {
    const host = createHookHost()
    const props = { card: itemToCard(item), actions: extra.actions ?? noopActions, busy: extra.busy ?? false }
    return { host, props, tree: host.render(InboxCard, props) }
  }

  it('有 reinstate 字段：「知道了」「恢复在岗」两个按钮都在', () => {
    const { tree } = render(alertOfEntry())
    expect(buttons(tree).map(textOf)).toEqual(['知道了', '恢复在岗'])
  })

  it('样子：「知道了」是主要按钮，「恢复在岗」是次要按钮（与验收条目上「验收通过」「有不符」的关系相同）', () => {
    const { tree } = render(alertOfEntry())
    expect(classOf(buttonByText(tree, '知道了')!)).toContain('ah-btn-primary')
    const secondary = classOf(buttonByText(tree, '恢复在岗')!)
    expect(secondary).toContain('ah-btn')
    expect(secondary).not.toContain('ah-btn-primary')
    expect(secondary).not.toContain('ah-btn-danger')
  })

  it('没有 reinstate 字段：只有「知道了」，样子与原来完全一样（不是主要按钮）', () => {
    const { tree } = render(alertWithoutReinstate())
    expect(buttons(tree).map(textOf)).toEqual(['知道了'])
    expect(classOf(buttonByText(tree, '知道了')!)).toBe('ah-btn')
  })

  it('点「恢复在岗」：回答条目的命令收到的答复是视图给的 reinstate', async () => {
    const calls: Array<{ option: string; note: unknown }> = []
    const actions = { onPick: async (_card: unknown, option: string, note?: string) => { calls.push({ option, note }); return null } }
    const { tree, props } = render(alertOfEntry(), { actions })
    ;(buttonByText(tree, '恢复在岗')!.props.onClick as () => void)()
    await flush()
    expect(calls).toEqual([{ option: 'reinstate', note: undefined }])
    // 提交规则：告警走回答收件箱的命令，答复原样回传。
    expect(cardSubmission(props.card, 'reinstate')).toEqual({ name: 'answerInbox', input: { id: 'i_sampleview10', answer: 'reinstate' } })
  })

  it('成功提示逐字：已恢复{名字}在岗。（名字取 reinstate.botName）；点「知道了」仍是原来的提示', () => {
    expect(inboxHandledNotice(alertOfEntry(), 'reinstate')).toBe('已恢复周岚在岗。')
    const other = { ...alertOfEntry(), reinstate: { botId: 'b_x', botName: '许然', answer: 'reinstate' as const } }
    expect(inboxHandledNotice(other, 'reinstate')).toBe('已恢复许然在岗。')
    expect(inboxHandledNotice(alertOfEntry(), '知道了')).toBe('已知晓。')
    expect(inboxHandledNotice(alertWithoutReinstate(), '知道了')).toBe('已知晓。')
  })

  it('成功提示出现在页面的操作提示位置：role=status，读屏属性与其他条目的提示相同', async () => {
    const host = createHookHost()
    const props = { inbox: { items: [alertOfEntry()] }, loading: false, error: null, onRetry: () => undefined, actions: noopActions, busyId: null, onOpenThread: () => undefined }
    const first = host.render(InboxPane, props)
    expect(findElements(first, 'div').some(node => classOf(node) === 'ah-inbox-done')).toBe(false)
    const card = findElements(first, InboxCard)[0]!
    await (card.props.actions as { onPick: (c: unknown, option: string) => Promise<string | null> }).onPick(card.props.card, 'reinstate')
    await flush()
    const done = findElements(host.render(InboxPane, props), 'div').find(node => classOf(node) === 'ah-inbox-done')!
    expect(done.props.role).toBe('status')
    expect(textOf(done)).toContain('已恢复周岚在岗。')
  })

  it('失败：显示核心返回的原文，条目保持不动，按钮恢复可点', async () => {
    const failure = '周岚已经在岗，不需要恢复。'
    const actions = { onPick: async () => failure }
    const { host, props, tree } = render(alertOfEntry(), { actions })
    ;(buttonByText(tree, '恢复在岗')!.props.onClick as () => void)()
    await flush()
    const after = host.render(InboxCard, props)
    const error = findElements(after, 'p').find(node => node.props.role === 'alert')!
    expect(textOf(error)).toBe(failure)
    // 条目还在：正文没变、两个按钮都在且可点。
    expect(textOf(after)).toContain(SAMPLE_SUSPENDED_ALERT_BODY)
    expect(buttonByText(after, '恢复在岗')!.props.disabled).toBe(false)
    expect(buttonByText(after, '知道了')!.props.disabled).toBe(false)
  })

  it('可达名称：恢复在岗：{条目标题}，界面上显示的文字不变；同一页两条告警的名称互不相同', () => {
    const { tree } = render(alertOfEntry())
    const button = buttonByText(tree, '恢复在岗')!
    expect(button.props['aria-label']).toBe('恢复在岗：周岚已被停用')
    expect(textOf(button)).toBe('恢复在岗')
    const second = { ...alertOfEntry(), id: 'i_other', title: '许然已被停用', reinstate: { botId: 'b_x', botName: '许然', answer: 'reinstate' as const } }
    const secondTree = render(second).tree
    expect(buttonByText(secondTree, '恢复在岗')!.props['aria-label']).toBe('恢复在岗：许然已被停用')
  })

  it('处理中：两个按钮都禁用（点击之后；上层标记处理中时同样）', async () => {
    const actions = { onPick: () => new Promise<string | null>(() => undefined) }
    const { host, props, tree } = render(alertOfEntry(), { actions })
    expect(buttonByText(tree, '恢复在岗')!.props.disabled).toBe(false)
    ;(buttonByText(tree, '恢复在岗')!.props.onClick as () => void)()
    const after = host.render(InboxCard, props)
    expect(buttonByText(after, '恢复在岗')!.props.disabled).toBe(true)
    expect(buttonByText(after, '知道了')!.props.disabled).toBe(true)
    const busy = render(alertOfEntry(), { busy: true }).tree
    expect(buttonByText(busy, '恢复在岗')!.props.disabled).toBe(true)
    expect(buttonByText(busy, '知道了')!.props.disabled).toBe(true)
  })

  it('不加二次确认：点一下就发出答复（没有弹窗，也没有额外一步）', async () => {
    const calls: string[] = []
    const actions = { onPick: async (_card: unknown, option: string) => { calls.push(option); return null } }
    const { tree } = render(alertOfEntry(), { actions })
    ;(buttonByText(tree, '恢复在岗')!.props.onClick as () => void)()
    expect(calls).toEqual(['reinstate'])
  })
})

// ---------- 第 2 节 ----------

describe('第 2 节：三句新句子在预览入口里看得到（逐字）', () => {
  it('1. 告警条目（?job=escalation-states 的「待你处理」页）：标题、正文逐字，带 reinstate，看得到两个按钮', () => {
    const entry = alertOfEntry()
    expect(entry.title).toBe('周岚已被停用')
    expect(entry.body).toBe('中心停用了周岚：越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）。「活动报名页」已停在执行，已告诉总管。')
    expect(entry.reinstate).toEqual({ botId: 'b_samplesusp1', botName: '周岚', answer: 'reinstate' })
    const tree = createHookHost().render(InboxCard, { card: itemToCard(entry), actions: noopActions, busy: false })
    const text = textOf(tree)
    expect(text).toContain('周岚已被停用')
    expect(text).toContain('中心停用了周岚：越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）。「活动报名页」已停在执行，已告诉总管。')
    expect(buttons(tree).map(textOf)).toEqual(['知道了', '恢复在岗'])
  })

  /** 一个入口里随附的主题：在仓库的线程表里、在项目的主题列表里，但不是选中的线程。 */
  const extraTopicOf = (entry: PreviewJobEntry, topicId: string): { thread: ThreadView; listed: boolean; selected: boolean } => {
    const state = stateOf(entry)
    return {
      thread: state.threads[topicId] as ThreadView,
      listed: state.project!.projects.some(row => row.topics.some(topic => topic.id === topicId)),
      selected: state.selectedThread === topicId,
    }
  }

  it('2a. 进度行 在等：周岚（已停用）（?job=review，左栏主题「活动报名页（员工已停用）」）', () => {
    const { thread, listed, selected } = extraTopicOf('review', SAMPLE_SUSPENDED_WAIT_TOPIC_ID)
    expect(listed).toBe(true)
    expect(selected).toBe(false)
    expect(thread.title).toBe('活动报名页（员工已停用）')
    expect(thread.progress!.waitingOn).toBe('周岚（已停用）')
    expect(textOf(createHookHost().render(JobProgress, { progress: thread.progress! }))).toContain('在等：周岚（已停用）')
  })

  it('2b. 进度行 在等：你（?job=delivery-states，左栏主题「活动报名页（总管也已停用）」：参与者停用而总管也不在岗）', () => {
    const { thread, listed, selected } = extraTopicOf('delivery-states', SAMPLE_SUSPENDED_YOU_TOPIC_ID)
    expect(listed).toBe(true)
    expect(selected).toBe(false)
    expect(thread.title).toBe('活动报名页（总管也已停用）')
    expect(thread.progress!.waitingOn).toBe('你')
    expect(textOf(createHookHost().render(JobProgress, { progress: thread.progress! }))).toContain('在等：你')
  })

  it('2c. 随附的主题只在对应入口里有：别的入口的状态里没有这两个主题', () => {
    for (const entry of ['topic', 'delivery', 'escalation-states'] as const) {
      const state = stateOf(entry)
      expect(state.threads[SAMPLE_SUSPENDED_WAIT_TOPIC_ID], entry).toBeUndefined()
      expect(state.threads[SAMPLE_SUSPENDED_YOU_TOPIC_ID], entry).toBeUndefined()
    }
    expect(stateOf('review').threads[SAMPLE_SUSPENDED_YOU_TOPIC_ID]).toBeUndefined()
    expect(stateOf('delivery-states').threads[SAMPLE_SUSPENDED_WAIT_TOPIC_ID]).toBeUndefined()
  })

  it('3. 主题里中心的一句：主题的标题已随约定第 {n} 版改为「{新标题}」。（?job=delivery，工作往来折叠组展开）', () => {
    expect(foldsTextOf(threadOfEntry('delivery'))).toContain('主题的标题已随约定第 4 版改为「活动报名页（交付与验收）」。')
  })
})
