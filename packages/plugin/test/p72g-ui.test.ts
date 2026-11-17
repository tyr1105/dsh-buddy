/**
 * P72g B 部分（插件界面 6 处修复）的测试：
 * B1 名字不被标签挤没（样式约定）、B2 约定条目的「查看对话」去总管私聊、
 * B3 第 2 版起的待确认卡默认只显示改动、B4 主题楼层里没有约定卡、
 * B5 总管私聊顶部「全队入口」标签与待确认状态行、B6 样例约定挂在总管负责的项目下。
 *
 * 和 P72e 的测试一样，用 hook 宿主渲染真实组件：只看这一层交出的元素，子组件不展开。
 * 每条规则至少一个正例一个反例。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { AGR_TEXT, condensedPlan, hasPendingAgreement, hasPendingTeamCard, unchangedPendingText, unchangedRestText } from '../src/client/logic/agreement.js'
import { inboxThreadId } from '../src/client/logic/feeds.js'
import { projectPaneBase, topicPaneInfo, findTopic } from '../src/client/logic/topics.js'
import { sampleAgreementV1, sampleAgreementV2, SAMPLE_AGREEMENT_PROJECT_ID } from '../src/shared/fixture-agreement.js'
import { fixtureProject, fixtureTopicThreads } from '../src/shared/fixture-project.js'
import { fixtureInbox, fixtureOverview, fixtureThreads } from '../src/shared/fixtures.js'
import type { AgreementCardView, InboxItemView, ThreadView } from '../src/shared/views.js'
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
const buttonNamed = (tree: unknown, label: string): StubElement | undefined => findElements(tree, 'button').find(node => textOf(node) === label)
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const headingsOf = (tree: unknown): string[] => findElements(tree, 'p').filter(node => classOf(node) === 'ah-agr-sec-h').map(textOf)

const pendingV2: AgreementCardView = sampleAgreementV2

// ---------------------------------------------------------------------------
// B1：名字不被标签挤没
// ---------------------------------------------------------------------------

describe('B1 员工列表里名字不被标签挤没', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/client/styles.css', import.meta.url)), 'utf-8')

  it('正例：名字行允许换行，标签放不下时换到下一行；名字文本不会收缩成 0', () => {
    const row = /\.ah-bot-row-name \{[^}]*\}/.exec(css)![0]
    expect(row).toContain('flex-wrap: wrap')
    const nameText = /\.ah-bot-row-name-text \{[^}]*\}/.exec(css)![0]
    // 名字最多收缩到容器宽度（省略号兜底），但不会因为兄弟标签而收缩到 0：由换行负责腾位置。
    expect(nameText).toContain('max-width: 100%')
    expect(nameText).toContain('text-overflow: ellipsis')
  })

  it('反例：标签自己不收缩、不断字（放不下就换行，不能让标签竖排）', () => {
    expect(css).toMatch(/\.ah-bot-row-name \.ah-tag \{[^}]*flex: none[^}]*white-space: nowrap/)
  })
})

// ---------------------------------------------------------------------------
// B2：「查看对话」去总管私聊
// ---------------------------------------------------------------------------

/** 造一条收件箱项：默认是带主题的约定条目。 */
function agreementItem(patch: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: 'inbox-agr', botId: 'bot-zongguan', botName: '总管', botColor: null, type: 'question', typeLabel: '提问', priority: 'P1',
    approvalId: null, title: '约定第 2 版待你确认：活动报名页', body: '4 项待你定', options: ['按建议，定了'], defaultOption: '按建议，定了',
    createdAt: 1, createdText: '刚刚', expiresText: null, topicId: 'ptp_signup', topicTitle: '活动报名页', agreementId: 'agr_signuppage', agreementVersion: 2, ...patch,
  }
}

describe('B2 约定条目的「查看对话」', () => {
  it('正例：约定条目即使带着主题 id，也去总管私聊（botId），不去主题', () => {
    expect(inboxThreadId(agreementItem())).toBe('bot-zongguan')
  })

  it('反例：没有约定的条目仍按原规则（主题优先，其次私聊）；约定条目没有 botId 时没有入口', () => {
    expect(inboxThreadId({ botId: 'bot-tanlu', topicId: 'ptp_x', agreementId: null })).toBe('ptp_x')
    expect(inboxThreadId({ botId: 'bot-tanlu', topicId: null })).toBe('bot-tanlu')
    expect(inboxThreadId(agreementItem({ botId: null }))).toBeNull()
  })

  it('InboxPane：点约定条目的「查看对话」把线程 id 和约定 id 一起交出去；其他条目只交线程 id', () => {
    const onOpenThread = vi.fn()
    const plain: InboxItemView = {
      id: 'i_q', botId: 'bot-tanlu', botName: '探路', botColor: null, type: 'question', typeLabel: '提问', priority: 'P1', approvalId: null,
      title: '选 A 还是 B', body: 'x', options: ['A', 'B'], defaultOption: 'A', createdAt: 1, createdText: '刚刚', expiresText: null,
    }
    const props = (items: InboxItemView[]) => ({
      inbox: { items }, loading: false, error: null, onRetry: () => undefined, actions: { onPick: async () => null }, busyId: null, onOpenThread,
    })
    const agreementTree = createHookHost().render(InboxPane, props([agreementItem()]))
    ;(buttonNamed(agreementTree, '查看对话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenLastCalledWith('bot-zongguan', 'agr_signuppage')
    const plainTree = createHookHost().render(InboxPane, props([plain]))
    ;(buttonNamed(plainTree, '查看对话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenLastCalledWith('bot-tanlu')
  })
})

// ---------------------------------------------------------------------------
// B3：第 2 版起的待确认卡默认只显示改动
// ---------------------------------------------------------------------------

describe('B3 condensedPlan（纯规则）', () => {
  it('正例：第 2 版待确认——3 项待定没改动，我已定的、这次做与不做收起，怎样算做完有改动照常显示', () => {
    expect(condensedPlan(pendingV2)).toEqual({
      applies: true, unchangedPending: 3, showDecided: false, showScope: false, showDoneWhen: true, anyFolded: true,
    })
  })

  it('反例：第 1 版、已固定的版本都不收起', () => {
    const v1 = { ...sampleAgreementV1, state: 'pending' as const }
    expect(condensedPlan(v1)).toMatchObject({ applies: false, anyFolded: false, showDecided: true, showScope: true, showDoneWhen: true })
    expect(condensedPlan({ ...pendingV2, state: 'locked' })).toMatchObject({ applies: false, anyFolded: false })
  })

  it('一块里只要有一条改动就整块照常显示；全部都有改动时没有任何收起', () => {
    const changedDecided = { ...pendingV2, decided: pendingV2.decided.map((item, i) => ({ ...item, changed: i === 0 })) }
    expect(condensedPlan(changedDecided).showDecided).toBe(true)
    const everything: AgreementCardView = {
      ...pendingV2,
      pending: pendingV2.pending.map(item => ({ ...item, changed: true })),
      decided: pendingV2.decided.map(item => ({ ...item, changed: true })),
      scopeIn: pendingV2.scopeIn.map(item => ({ ...item, changed: true })),
      scopeOut: pendingV2.scopeOut.map(item => ({ ...item, changed: true })),
      doneWhen: pendingV2.doneWhen.map(item => ({ ...item, changed: true })),
    }
    expect(condensedPlan(everything)).toMatchObject({ applies: true, unchangedPending: 0, anyFolded: false })
  })

  it('文字：其余 N 项与上一版相同；除上面标出的改动外，与第 N 版相同', () => {
    expect(unchangedPendingText(3)).toBe('其余 3 项与上一版相同')
    expect(unchangedRestText(1)).toBe('除上面标出的改动外，与第 1 版相同。')
    expect(unchangedRestText(4)).toBe('除上面标出的改动外，与第 4 版相同。')
  })
})

describe('B3 约定卡：第 2 版默认只显示改动', () => {
  it('默认：本版改动、改动的待定项和怎样算做完在；没改的待定项收成一行；我已定的和这次做与不做收起', () => {
    const tree = createHookHost().render(AgreementCard, { card: pendingV2, onConfirm: async () => null })
    const text = textOf(tree)
    expect(text).toContain('本版改动')
    // 待定项：只列第 1 项（有改动），其余 3 项一行带过。
    expect(findElements(tree, 'div').filter(node => node.props.role === 'radiogroup')).toHaveLength(1)
    expect(text).toContain('其余 3 项与上一版相同')
    // 三块里整块没改的收起，有改动的怎样算做完保留。
    const headings = headingsOf(tree)
    expect(headings.some(title => title.startsWith('我已定的'))).toBe(false)
    expect(headings.some(title => title === '这次做' || title === '这次不做')).toBe(false)
    expect(headings.some(title => title.startsWith('怎样算做完'))).toBe(true)
    expect(text).toContain('除上面标出的改动外，与第 1 版相同。')
    expect(buttonNamed(tree, '展开全文')).toBeDefined()
    // 「定了」仍然只有一个。
    expect(findElements(tree, 'button').filter(node => textOf(node) === '定了')).toHaveLength(1)
  })

  it('点「展开全文」：整张卡和第 1 版一样完整，收起提示消失', () => {
    const host = createHookHost()
    const props = { card: pendingV2, onConfirm: async () => null }
    ;(buttonNamed(host.render(AgreementCard, props), '展开全文')!.props.onClick as () => void)()
    const tree = host.render(AgreementCard, props)
    const headings = headingsOf(tree)
    for (const title of ['待你定（4 项）', '我已定的（6 项）', '这次做', '这次不做', '怎样算做完']) {
      expect(headings.some(text => text.startsWith(title))).toBe(true)
    }
    expect(findElements(tree, 'div').filter(node => node.props.role === 'radiogroup')).toHaveLength(4)
    expect(textOf(tree)).not.toContain('其余 3 项与上一版相同')
    expect(buttonNamed(tree, '展开全文')).toBeUndefined()
  })

  it('收起时点「定了」，没改动的待定项仍按建议提交（四项都在 choices 里）', () => {
    const onConfirm = vi.fn(async (_agreementId: string, _version: number, _choices: Record<string, string>) => null)
    const tree = createHookHost().render(AgreementCard, { card: pendingV2, onConfirm })
    ;(buttonNamed(tree, '定了')!.props.onClick as () => void)()
    const choices = onConfirm.mock.calls[0]![2]
    expect(Object.keys(choices).sort()).toEqual(pendingV2.pending.map(item => item.key).sort())
    for (const item of pendingV2.pending) expect(choices[item.key]).toBe(item.suggested)
  })

  it('反例：第 1 版整张展开，没有收起提示和「展开全文」', () => {
    const v1 = { ...sampleAgreementV1, state: 'pending' as const, canConfirm: true, supersededBy: null }
    const tree = createHookHost().render(AgreementCard, { card: v1, onConfirm: async () => null })
    expect(findElements(tree, 'div').filter(node => node.props.role === 'radiogroup')).toHaveLength(4)
    expect(textOf(tree)).not.toContain('与上一版相同')
    expect(textOf(tree)).not.toContain('与第 0 版相同')
    expect(buttonNamed(tree, '展开全文')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// B4：主题楼层里没有约定卡
// ---------------------------------------------------------------------------

describe('B4 主题里不重复显示约定', () => {
  it('正例：有约定的主题只有第一层面板，楼层消息里没有任何约定卡；总管私聊里有', () => {
    const topic = fixtureTopicThreads.find(thread => thread.agreement)!
    expect(topic.agreement).toBeTruthy()
    expect(topic.messages.some(message => message.kind === 'agreement' || message.agreement)).toBe(false)
    const chief = fixtureThreads.find(thread => thread.threadId === 'bot-zongguan')!
    expect(chief.messages.some(message => message.kind === 'agreement')).toBe(true)
  })

  it('反例：没有约定的主题照旧，没有面板', () => {
    const plain = fixtureTopicThreads.filter(thread => !thread.agreement)
    expect(plain.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// B5：总管私聊顶部
// ---------------------------------------------------------------------------

/** 总管私聊页的最小入参。 */
function paneProps(thread: ThreadView, patch: Partial<Parameters<typeof ThreadPane>[0]> = {}): Parameters<typeof ThreadPane>[0] {
  return {
    threadId: thread.threadId, thread, loading: false,
    header: { name: '总管', roleLabel: '总管', activityText: '空闲。交代的事由我安排，结果由我交回。', nextThinkText: null, staffStatus: 'on_duty', thinking: false },
    inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined,
    actions: { onPick: async () => null }, busyInboxId: null, onRetry: () => undefined, error: null,    onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined, ...patch,
  }
}

describe('B5 总管私聊顶部', () => {
  const chiefThread = fixtureThreads.find(thread => thread.threadId === 'bot-zongguan')!

  it('hasPendingAgreement：有最新版待确认卡才为真；已固定、没有卡都为假', () => {
    expect(hasPendingAgreement(chiefThread.messages)).toBe(true)
    const locked = chiefThread.messages.map(message => message.agreement
      ? { ...message, agreement: { ...message.agreement, state: 'locked' as const, canConfirm: false } } : message)
    expect(hasPendingAgreement(locked)).toBe(false)
    expect(hasPendingAgreement([])).toBe(false)
    expect(hasPendingAgreement(chiefThread.messages.filter(message => !message.agreement))).toBe(false)
  })

  it('正例：名字旁有「全队入口」标签；有待确认约定时状态行是「等你确认约定。确认前不会开工。」', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(chiefThread, { chiefEntry: true }))
    const h2 = findElements(tree, 'h2')[0]!
    expect(textOf(h2)).toBe('总管全队入口')
    expect(findElements(h2, 'span').some(node => classOf(node).includes('ah-tag-entry'))).toBe(true)
    const statuses = findElements(tree, 'p').filter(node => classOf(node) === 'ah-thread-status').map(textOf)
    expect(statuses).toEqual(['等你确认约定。确认前不会开工。'])
    expect(AGR_TEXT.chiefPendingStatus).toBe('等你确认约定。确认前不会开工。')
  })

  it('P73f：只有待确认组队卡时，状态行是「等你确认组队卡。确认前没有员工入职。」，位置和写法与约定卡待确认时相同', () => {
    const teamOnly: ThreadView = { ...chiefThread, messages: chiefThread.messages.filter(message => !message.agreement) }
    expect(hasPendingTeamCard(teamOnly.messages)).toBe(true)
    const tree = createHookHost().render(ThreadPane, paneProps(teamOnly, { chiefEntry: true }))
    const statuses = findElements(tree, 'p').filter(node => classOf(node) === 'ah-thread-status')
    expect(statuses.map(textOf)).toEqual(['等你确认组队卡。确认前没有员工入职。'])
    expect(statuses[0]!.props['data-testid']).toBe('ah-chief-pending-status')
    expect(AGR_TEXT.chiefPendingTeamStatus).toBe('等你确认组队卡。确认前没有员工入职。')
    // 反例：约定卡待确认时仍是约定那一行（两种卡不会同时待确认，样例里并存只为了看全）。
    expect(hasPendingTeamCard([])).toBe(false)
    // 反例：卡已确认后不再显示这一行。
    const confirmed = teamOnly.messages.map(message => message.teamCard ? { ...message, teamCard: { ...message.teamCard, state: 'confirmed' as const } } : message)
    expect(hasPendingTeamCard(confirmed)).toBe(false)
  })

  it('反例：没有待确认约定时状态行仍是原来的活动句；其他员工没有标签', () => {
    // P73f：样例线程里还有一张待确认的组队卡，这里一并去掉，才是「没有任何待确认的卡」。
    const noCards: ThreadView = { ...chiefThread, messages: chiefThread.messages.filter(message => !message.agreement && !message.teamCard) }
    const tree = createHookHost().render(ThreadPane, paneProps(noCards, { chiefEntry: true }))
    const statuses = findElements(tree, 'p').filter(node => classOf(node) === 'ah-thread-status').map(textOf)
    expect(statuses).toEqual(['空闲。交代的事由我安排，结果由我交回。'])
    expect(textOf(findElements(tree, 'h2')[0])).toBe('总管全队入口')

    const other = createHookHost().render(ThreadPane, paneProps(chiefThread, {
      header: { name: '探路', roleLabel: '调研', activityText: '在查数据', nextThinkText: null, staffStatus: 'on_duty', thinking: false },
    }))
    expect(textOf(findElements(other, 'h2')[0])).toBe('探路调研')
    expect(findElements(other, 'p').some(node => textOf(node) === '等你确认约定。确认前不会开工。')).toBe(false)
  })

  it('反例：主题线程即使传了 chiefEntry 也不画「全队入口」', () => {
    const topic = fixtureTopicThreads.find(thread => thread.agreement)!
    const tree = createHookHost().render(ThreadPane, paneProps(topic, {
      chiefEntry: true, topic: { title: topic.title, projectName: '活动报名页', placeholder: 'x', readOnlyText: null, members: [], replying: [] },
    }))
    expect(textOf(findElements(tree, 'h2')[0])).not.toContain('全队入口')
  })
})

// ---------------------------------------------------------------------------
// B6：样例数据
// ---------------------------------------------------------------------------

describe('B6 样例约定挂在总管负责的项目下', () => {
  it('正例：约定所属项目的负责人是总管，主题在这个项目下，主题输入框默认发给总管', () => {
    const card = pendingV2
    expect(card.projectId).toBe(SAMPLE_AGREEMENT_PROJECT_ID)
    const found = findTopic(fixtureProject, card.topicId)!
    expect(found).not.toBeNull()
    expect(found.row.project.id).toBe(card.projectId)
    expect(found.row.ownerBotId).toBe('bot-zongguan')
    expect(found.row.ownerName).toBe('总管')
    expect(found.row.project.status).toBe('active')
    expect(projectPaneBase(found.row, fixtureOverview.bots).placeholder).toBe('默认发给 总管，@ 可以点名…')
    expect(topicPaneInfo(found, null, fixtureOverview.bots).projectName).toBe('活动报名页')
  })

  it('反例：这个主题不再出现在别的项目（竞品周报）下；约定条目指向同一个主题', () => {
    const weekly = fixtureProject.projects.find(row => row.project.id === 'prj_weekly')!
    expect(weekly.topics.some(topic => topic.id === pendingV2.topicId)).toBe(false)
    const item = fixtureInbox.items.find(entry => entry.agreementId)!
    expect(item.topicId).toBe(pendingV2.topicId)
  })
})
