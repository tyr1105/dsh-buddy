/**
 * P74h 核对卡与接线测试：
 * - 核对卡通过时只列本轮条目并显示沿用说明；不通过时显示剩余轮数。
 * - 交回卡的卡头、标题、状态与产出物一行。
 * - 主题楼层按 floors 画（楼层与折叠组交替、总数行换新句子、进度行在约定面板底部）；
 *   job_card 楼层里还没有视图的（交付卡，P74i）先只显示标题。
 * - 私聊里 kind 为 work 的消息按普通中心提示画；job_card 交给 JobCard。
 * 样例全部取自 fixture-job.ts（core 的视图函数生成）。
 */
import { describe, expect, it, vi } from 'vitest'
import { JobCard } from '../src/client/components/JobCard.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { sampleB2Thread, sampleJobTopicThread, sampleReviewPassCard, sampleReviewReturnCard, sampleSubmissionCard } from '../src/shared/fixture-job.js'
import type { ThreadMessageView, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { AgreementPanel } from '../src/client/components/AgreementPanel.js'
import { EvidenceList } from '../src/client/components/EvidenceList.js'
import { TopicFloor } from '../src/client/components/TopicThreadBody.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')

/** 主题页的模型与视图表（与 ThreadPane 的接线同一套拼法）。 */
const topicModel = buildTopicThread(sampleJobTopicThread.messages, sampleJobTopicThread.hasMore, { hasAgreement: true })
const viewsById = new Map<string, ThreadMessageView>(sampleJobTopicThread.messages.map(message => [message.id, message]))
const topicProps = {
  model: topicModel, replying: [], actions: { onConfirmAgreement: async () => null } as never,
  busyInboxId: null, agreement: sampleJobTopicThread.agreement ?? null,
  progress: sampleJobTopicThread.progress ?? null, floors: sampleJobTopicThread.floors,
}

describe('核对卡（P74h）', () => {
  it('通过时只列本轮条目（沿用的不重复）并显示沿用说明与底部固定一行', () => {
    const tree = createHookHost().render(JobCard, { card: sampleReviewPassCard })
    const text = textOf(tree)
    expect(text).toContain('第 2 轮　通过：6 条均符合')
    expect(text).toContain('已通过')
    // 本轮只有第 3 条（沿用第 1 轮结论的 5 条不重复列出）：清单组件收到的条目只有第 3 条。
    const list = findElements(tree, EvidenceList)[0]!
    expect((list.props.items as Array<{ no: number }>).map(item => item.no)).toEqual([3])
    expect(text).toContain('其余 5 条沿用第 1 轮结论：本轮只改了提示文字，不影响它们；抽查了第 2 条，仍然符合。')
    expect(text).toContain('只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。')
  })

  it('不通过时列出全部条目并显示剩余轮数', () => {
    const tree = createHookHost().render(JobCard, { card: sampleReviewReturnCard })
    const text = textOf(tree)
    expect(text).toContain('第 1 轮　不通过：1 条不符')
    expect(text).toContain('剩余 2 轮')
    expect((findElements(tree, EvidenceList)[0]!.props.items as unknown[])).toHaveLength(6)
  })

  it('交回卡的卡头小标签「交回」、标题、右侧状态和产出物一行', () => {
    const tree = createHookHost().render(JobCard, { card: sampleSubmissionCard })
    const text = textOf(tree)
    expect(text).toContain('交回')
    expect(text).toContain('活动报名页　第 1 轮')
    expect(text).toContain('按约定第 4 版　自查 6 条')
    expect(text).toContain('产出物：报名页.html、提交成功页.html、报名名单表格.numbers，在主题文件夹「交付」里。')
  })
})

describe('主题页接线（P74h）', () => {
  it('楼层与折叠组交替，总数行改用 floors.countText，进度行画在约定面板底部', () => {
    const tree = createHookHost().render(TopicThreadBody, topicProps)
    // 总数行换成 core 算的那句（写清多少条已收起）。
    expect(textOf(findElements(tree, 'p').find(node => classOf(node) === 'ah-topic-count')))
      .toBe('共 9 条记录：给你的 3 条，员工之间的往来 6 条（已收起）')
    // 两组折叠组（WorkFold）；进度行传进约定面板（JobProgress 画在面板最下方）。
    expect(findElements(tree, WorkFold)).toHaveLength(2)
    const panel = findElements(tree, AgreementPanel)[0]!
    expect(panel.props.progress).toBe(sampleJobTopicThread.progress)
  })

  it('没有 floors 的旧主题照旧（不画折叠组，总数行还是「N 条回复」）', () => {
    const tree = createHookHost().render(TopicThreadBody, { ...topicProps, floors: undefined, agreement: null, progress: null })
    expect(findElements(tree, WorkFold)).toHaveLength(0)
    expect(textOf(tree)).toContain('7 条回复')
  })

  it('job_card 楼层里还没有视图的（交付卡，P74i）先只显示标题', () => {
    // 构造一条 core 还没有视图的 job_card 楼层（refId 是 delivery:，视图里 jobCard 为 null）。
    const deliveryMessage: ThreadMessageView = {
      id: 'm_sample0010', thread: 'ptp_samplejob1', from: 'b_samplechief', fromName: '总管', fromColor: '#5b6b8c',
      kind: 'job_card', text: '活动报名页　按约定第 4 版', createdAt: 0, timeText: '11月17日 10:30', card: null, jobCard: null,
    }
    const model = buildTopicThread([...sampleJobTopicThread.messages, deliveryMessage], false, { hasAgreement: true })
    const tree = createHookHost().render(TopicThreadBody, { ...topicProps, model, floors: undefined })
    // 楼层组件收到的这条消息没有卡片视图：只显示标题（P74i 会替换成真正的交付卡）。
    const floor = findElements(tree, TopicFloor).find(node => (node.props.message as ThreadMessageView).id === 'm_sample0010')!
    expect((floor.props.message as ThreadMessageView).text).toBe('活动报名页　按约定第 4 版')
  })
})

/** 私聊渲染要的最小 props（与 p72e 的测试同一套形状）。 */
function paneProps(thread: ThreadView) {
  return {
    threadId: thread.threadId, thread, loading: false,
    header: { name: '总管', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
    inputPlaceholderName: '总管', chiefEntry: true, banner: null, onBannerDismiss: () => {}, onLoadEarlier: () => {},
    onSend: async () => {}, actions: { onConfirmAgreement: async () => null } as never, busyInboxId: null,
    onRetry: () => {}, error: null, onOpenSession: () => {}, onTogglePause: () => {}, onInterrupt: () => {},
  }
}

describe('私聊接线（P74h）', () => {
  it('待确认的约定卡整张渲染（B2：两栏、交付时间、退路都在卡上）', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(sampleB2Thread))
    const card = findElements(tree, AgreementCard)[0]!
    const view = card.props.card as NonNullable<(typeof sampleB2Thread)['messages'][number]['agreement']>
    expect(view?.jobSplit?.paused).toEqual(['名额计数与「名额已满」'])
  })

  it('kind 为 work 的消息兜底按普通中心提示画，不冒充总管的话', () => {
    const withWork: ThreadView = {
      ...sampleB2Thread,
      messages: [...sampleB2Thread.messages, {
        id: 'm_sample0011', thread: sampleB2Thread.threadId, from: 'b_samplelinzhou', fromName: '林舟', fromColor: '#3f8f7a',
        kind: 'work', text: '已读约定第 4 版和草图，开始做。', createdAt: 0, timeText: '11月13日 16:00', card: null,
      }],
    }
    const tree = createHookHost().render(ThreadPane, paneProps(withWork))
    const center = findElements(tree, 'div').filter(node => classOf(node) === 'ah-msg ah-msg-center')
    expect(textOf(center.at(-1))).toContain('已读约定第 4 版和草图，开始做。')
    // 工作往来不画成带头像的普通气泡。
    expect(textOf(tree)).not.toContain('林舟 · 11月13日 16:00')
  })

  it('job_card 消息交给 JobCard 画', () => {
    const withCard: ThreadView = {
      ...sampleB2Thread,
      messages: [...sampleB2Thread.messages, {
        id: 'm_sample0012', thread: sampleB2Thread.threadId, from: 'b_samplelinzhou', fromName: '林舟', fromColor: '#3f8f7a',
        kind: 'job_card', text: '活动报名页　第 1 轮', createdAt: 0, timeText: '11月16日 11:20', card: null,
        jobCard: sampleSubmissionCard,
      }],
    }
    const tree = createHookHost().render(ThreadPane, paneProps(withCard))
    expect(findElements(tree, JobCard)).toHaveLength(1)
  })
})
