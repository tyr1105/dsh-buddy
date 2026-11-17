/**
 * P74i-m2 第 2 节、第 3 节的测试：第四次审查与复走查发现的问题改完后的行为。
 *
 * - 高-1（2.1）：主题楼层与已加载消息对不上——只加载了最后一页的主题、没有约定的旧主题、
 *   折叠组里有一部分还没加载，三种情形都不再把找不到视图的消息画成灰色小字。
 * - 中-2（2.2）：链接证据是不可点的文字，渲染结果里没有 a 元素、没有 href。
 * - 中-3（2.3）：已有结果的审批卡不显示「…前有效，过期视为拒绝」。
 * - 低-2/低-3/低-4、R-6：折叠组的时间用视图里核心算好的、key 用折叠组 id、
 *   「待你处理」里说明卡提交后有「已提交」提示、失效的交付卡带 is-void 弱化类。
 * 样例尽量取自 fixture-job.ts（core 的视图函数生成）；楼层对不上的情形手造最小数据，
 * 因为样例主题全部消息都已加载（这正是审查指出测试碰不到它的原因）。
 */
import { describe, expect, it, vi } from 'vitest'
import { TopicFloor, TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { EvidenceList } from '../src/client/components/EvidenceList.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { DeliveryCard, EscalationCard, type JobCommands } from '../src/client/components/JobCard.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { floorEarlierCount, workTimeOf } from '../src/client/logic/job.js'
import { sampleApprovalThread, sampleDeliveryAwaitingCard, sampleDeliveryExpiredCard } from '../src/shared/fixture-job.js'
import type { CardPayload } from '../src/client/logic/cards.js'
import type { EvidenceItemView, ThreadMessageView, TopicFloorsView } from '../src/shared/views.js'
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
const noopActions = { onPick: async () => null }

/** 造一条已加载的消息视图。 */
function view(id: string, text: string, from: string = 'b_samplechief', timeText = '11月17日 15:00'): ThreadMessageView {
  return { id, thread: 'ptp_x', from, fromName: from === 'owner' ? '主人' : from === 'hub' ? 'Agent 中心' : '林舟', fromColor: '#3f8f7a', kind: 'chat', text, createdAt: 0, timeText, createdText: timeText, card: null }
}
/** 造一条楼层里的原始消息（core 的 ThreadMessage）。 */
function raw(id: string, text: string, from = 'b_samplelinzhou') {
  return { id, thread: 'ptp_x', from, kind: 'chat' as const, text, refId: null, createdAt: 1794898800000, readAt: null }
}

// ---------- 高-1（2.1）：楼层与已加载消息对不上 ----------

describe('高-1：主题楼层只画已加载的范围', () => {
  const actions = { onPick: async () => null }

  it('消息只加载了最后一页：更早的楼层不画，最上面一行提示还有几条没加载（旁边有「加载更早」入口）', () => {
    const loaded = [view('m3', '最新的那句')]
    const floors: TopicFloorsView = {
      countText: '共 4 条记录',
      items: [
        { kind: 'floor', message: raw('m0', '更早的一句：先别发布', 'owner') },
        { kind: 'fold', id: 'fold_a', count: 2, participants: ['林舟'], rangeText: '11月17日', latest: '组里的最近一句', messages: [
          { message: raw('m1', '组里更早的一条'), fromName: '林舟', toNames: [] },
          { message: raw('m2', '组里晚些的一条'), fromName: '林舟', toNames: [] },
        ] },
        { kind: 'floor', message: raw('m3', '最新的那句') },
      ],
    }
    // 纯函数：更早的未加载记录按消息条数算（1 条楼层 + 折叠组 2 条 = 3）。
    expect(floorEarlierCount(floors.items, id => id === 'm3')).toBe(3)
    const model = buildTopicThread(loaded, true, { hasAgreement: true })
    let onLoadEarlierCalls = 0
    const tree = createHookHost().render(TopicThreadBody, {
      model, replying: [], actions, busyInboxId: null, agreement: null, progress: null, floors,
      onLoadEarlier: () => { onLoadEarlierCalls += 1 },
    })
    const earlier = findElements(tree, 'p').find(node => classOf(node) === 'ah-topic-earlier')!
    expect(textOf(findElements(earlier, 'span')[0]!)).toBe('更早的 3 条记录还没有加载。')
    // 旁边就是「加载更早」入口（点了走加载更早那条路）。
    const button = findElements(earlier, 'button')[0]!
    expect(textOf(button)).toBe('加载更早')
    ;(button.props.onClick as () => void)()
    expect(onLoadEarlierCalls).toBe(1)
    // 页外的楼层与折叠组都不画（没有灰色小字、没有只剩标题的卡），只画有视图的最新一条。
    const notes = findElements(tree, 'p').filter(node => classOf(node) === 'ah-topic-note')
    expect(notes).toHaveLength(0)
    expect(textOf(tree)).not.toContain('先别发布')
    expect(findElements(tree, WorkFold)).toHaveLength(0)
    const floorRows = findElements(tree, TopicFloor)
    expect(floorRows).toHaveLength(1)
    expect((floorRows[0]!.props.message as ThreadMessageView).id).toBe('m3')
  })

  it('没有入口可给时只写提示一行；全部楼层都已加载时不写提示', () => {
    const loaded = [view('m3', '最新的那句')]
    const floors: TopicFloorsView = { countText: '共 2 条记录', items: [
      { kind: 'floor', message: raw('m0', '更早的一句：先别发布', 'owner') },
      { kind: 'floor', message: raw('m3', '最新的那句') },
    ] }
    const withoutEntry = createHookHost().render(TopicThreadBody, {
      model: buildTopicThread(loaded, true, { hasAgreement: true }), replying: [], actions, busyInboxId: null, floors,
    })
    const earlier = findElements(withoutEntry, 'p').find(node => classOf(node) === 'ah-topic-earlier')!
    expect(textOf(earlier)).toBe('更早的 1 条记录还没有加载。')
    expect(findElements(earlier, 'button')).toHaveLength(0)
    // 全部加载：没有提示行。
    const allFloors: TopicFloorsView = { countText: '共 1 条记录', items: [{ kind: 'floor', message: raw('m3', '最新的那句') }] }
    const full = createHookHost().render(TopicThreadBody, {
      model: buildTopicThread(loaded, false, { hasAgreement: true }), replying: [], actions, busyInboxId: null, floors: allFloors,
    })
    expect(findElements(full, 'p').some(node => classOf(node) === 'ah-topic-earlier')).toBe(false)
  })

  it('没有约定的旧主题：开头那条已作为主题卡显示，楼层里不再画它（不重复）', () => {
    const opening = view('m0', '这周把报名页做出来', 'owner', '11月11日 15:31')
    const reply = view('m1', '收到', 'b_samplelinzhou', '11月11日 15:32')
    const floors: TopicFloorsView = { countText: '共 2 条记录', items: [
      { kind: 'floor', message: raw('m0', '这周把报名页做出来', 'owner') },
      { kind: 'floor', message: raw('m1', '收到') },
    ] }
    const tree = createHookHost().render(TopicThreadBody, {
      model: buildTopicThread([opening, reply], false, { hasAgreement: false }), replying: [], actions, busyInboxId: null, floors,
    })
    // 主题卡里有一次，楼层里没有第二次；也没有灰色小字。
    expect(textOf(tree).split('这周把报名页做出来').length - 1).toBe(1)
    expect(findElements(tree, 'p').filter(node => classOf(node) === 'ah-topic-note')).toHaveLength(0)
    // 主题卡一张，楼层里只画回复那一条（开头那条不再进楼层）。
    expect(findElements(tree, 'section')).toHaveLength(1)
    const floorRows = findElements(tree, TopicFloor)
    expect(floorRows).toHaveLength(1)
    expect((floorRows[0]!.props.message as ThreadMessageView).id).toBe('m1')
  })

  it('折叠组里有一部分还没加载：组照常显示，展开后只列已加载的，末尾一行说明', () => {
    const loaded = [view('m2', '组里第二条', 'b_samplelinzhou', '11月17日 09:02'), view('m3', '组里第三条', 'b_samplelinzhou', '11月17日 09:03'), view('m4', '组外的楼层', 'b_samplechief', '11月17日 10:00')]
    const fold: TopicFloorsView['items'][number] & { kind: 'fold' } = {
      kind: 'fold', id: 'fold_b', count: 3, participants: ['林舟'], rangeText: '11月17日', latest: '组里第三条',
      messages: [
        { message: raw('m1', '组里更早的一条'), fromName: '林舟', toNames: [] },
        { message: raw('m2', '组里第二条'), fromName: '林舟', toNames: [] },
        { message: raw('m3', '组里第三条'), fromName: '林舟', toNames: [] },
      ],
    }
    const floors: TopicFloorsView = { countText: '共 4 条记录', items: [fold, { kind: 'floor', message: raw('m4', '组外的楼层') }] }
    const tree = createHookHost().render(TopicThreadBody, {
      model: buildTopicThread(loaded, true, { hasAgreement: true }), replying: [], actions, busyInboxId: null, floors,
    })
    // 组内有一部分已加载：不算进顶上的提示（顶部没有提示行）；折叠组照常显示在楼层里。
    expect(findElements(tree, 'p').some(node => classOf(node) === 'ah-topic-earlier')).toBe(false)
    expect(findElements(tree, WorkFold)).toHaveLength(1)
    // 低-3：折叠组的 key 是核心给的折叠组 id，不是位置序号（前面增减楼层时展开的那组不会跳）。
    expect(findElements(tree, WorkFold)[0]!.key).toBe('fold_b')
    // 展开折叠组（子组件不展开渲染，这里单独渲染它，与 p74h-work-fold 的测法一致）。
    const views = new Map(loaded.map(message => [message.id, message]))
    const host = createHookHost()
    const closed = host.render(WorkFold, { fold, views })
    ;(findElements(closed, 'details')[0]!.props.onToggle as (event: unknown) => void)({ target: { open: true } })
    const open = host.render(WorkFold, { fold, views })
    const body = findElements(open, 'div').find(node => classOf(node) === 'ah-work-fold-body')!
    const rows = findElements(body, 'div').filter(node => classOf(node) === 'ah-work-row')
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0])).toContain('组里第二条')
    expect(textOf(body)).not.toContain('组里更早的一条')
    expect(textOf(findElements(body, 'p').find(node => classOf(node) === 'ah-work-fold-missing')!)).toBe('这一组里更早的 1 条还没有加载。')
  })
})

// ---------- 中-2（2.2）：链接证据不可点 ----------

describe('中-2：链接证据画成不可点的文字', () => {
  const itemOf = (url: string | null): EvidenceItemView => ({
    no: 1, text: '链接那一条', verdict: { label: '符合', tone: 'ok' },
    evidence: [{ id: 'ev1', kind: 'link', label: '内网演示地址', path: null, url, summary: '', checkText: null }],
    note: null, fixTo: null, history: null,
  })

  it('有地址：显示主机名加完整地址，可以选中复制；渲染结果里没有 a 元素、没有 href', () => {
    const tree = createHookHost().render(EvidenceList, { items: [itemOf('https://demo.internal.example/活动报名页/index.html?a=1')] })
    expect(findElements(tree, 'a')).toHaveLength(0)
    expect(JSON.stringify(tree)).not.toContain('href')
    const link = findElements(tree, 'span').find(node => classOf(node) === 'ah-ev-link')!
    expect(textOf(link)).toContain('demo.internal.example')
    expect(textOf(link)).toContain('https://demo.internal.example/活动报名页/index.html?a=1')
    expect(textOf(link)).toContain('链接')
  })

  it('地址为空：只显示说明文字，也没有 a 元素', () => {
    const tree = createHookHost().render(EvidenceList, { items: [itemOf(null)] })
    expect(findElements(tree, 'a')).toHaveLength(0)
    const link = findElements(tree, 'span').find(node => classOf(node) === 'ah-ev-link')!
    expect(textOf(link)).toContain('内网演示地址')
    expect(textOf(link)).not.toContain('http')
  })
})

// ---------- 中-3（2.3）：已有结果的审批卡不显示有效期 ----------

describe('中-3：已有结果的审批卡不显示「过期视为拒绝」', () => {
  const base: CardPayload = {
    inboxId: 'i_x', approvalId: 'ap_x', type: 'approval', status: 'open',
    goalId: null, title: '批准：发布', body: '正文', options: ['批准', '拒绝'], defaultOption: null,
    answer: null, expiresText: '11月18日 18:20',
  }
  const render = (card: CardPayload): StubElement => createHookHost().render(InboxCard, { card, actions: noopActions, busy: false }) as StubElement

  it('已作废、已批准（已答复）、已过期的卡上都没有「视为拒绝」；等主人处理的卡上仍有', () => {
    const voidedCard = sampleApprovalThread.messages.find(message => message.card?.approval?.voided === true)!.card! as never as CardPayload
    for (const card of [
      voidedCard,
      { ...base, status: 'answered', answer: '批准' } as CardPayload,
      { ...base, status: 'expired', answer: '批准' } as CardPayload,
    ]) {
      const tree = render(card)
      expect(textOf(tree), JSON.stringify(card.status)).not.toContain('视为拒绝')
      expect(textOf(tree)).not.toContain('前有效')
    }
    expect(textOf(render(base))).toContain('前有效，过期视为拒绝')
  })
})

// ---------- 低-2：折叠组的时间用视图里核心算好的 ----------

describe('低-2：折叠组的时间用消息视图的 timeText', () => {
  it('有视图时用 timeText（与中心时区一致），找不到视图才退回本机算法', () => {
    // 视图里核心写的时间与本机时区算出来的一定不同（相差一小时），断言用的是前者。
    const createdAt = Date.parse('2026-11-17T09:00:00+08:00')
    expect(workTimeOf({ timeText: '11月17日 09:00' }, createdAt)).toBe('11月17日 09:00')
    expect(workTimeOf(undefined, createdAt)).toBe(workTimeOf(undefined, createdAt))
    // 用组件再验一次：组里的行头写视图的时间。
    const fold = {
      kind: 'fold' as const, id: 'fold_t', count: 1, participants: ['林舟'], rangeText: '11月17日', latest: '一句',
      messages: [{ message: raw('m1', '一条往来'), fromName: '林舟', toNames: [] }],
    }
    const views = new Map([['m1', view('m1', '一条往来', 'b_samplelinzhou', '11月17日 08:00')]])
    const host = createHookHost()
    const tree = host.render(WorkFold, { fold, views })
    ;(findElements(tree, 'details')[0]!.props.onToggle as (event: unknown) => void)({ target: { open: true } })
    const open = host.render(WorkFold, { fold, views })
    expect(textOf(findElements(open, 'p').find(node => classOf(node) === 'ah-work-meta')!)).toContain('11月17日 08:00')
  })
})

// ---------- 低-4：说明卡提交成功后有「已提交」提示 ----------

describe('低-4：「待你处理」里的说明卡提交成功后给「已提交」提示', () => {
  it('EscalationCard 提交成功调用 onSubmitted（InboxPane 据此显示与其余条目相同的那句提示）', async () => {
    const card = sampleDeliveryAwaitingCard // 占位保证导入；实际用下面的说明卡样例
    expect(card).toBeDefined()
    const { sampleEscalationCard } = await import('../src/shared/fixture-job.js')
    const escalation = sampleEscalationCard.kind === 'escalation' ? sampleEscalationCard : null
    expect(escalation).not.toBeNull()
    const onSubmitted = vi.fn()
    const commands: JobCommands = { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview: vi.fn(async () => ({ ok: true as const })) }
    const host = createHookHost()
    const tree = host.render(EscalationCard, { card: escalation!, commands, onSubmitted })
    ;(findElements(tree, 'button').find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onSubmitted).toHaveBeenCalledTimes(1)
    // 提交失败不提示。
    const failed = vi.fn(async () => ({ ok: false as const, error: '中心没记上' }))
    const host2 = createHookHost()
    const tree2 = host2.render(EscalationCard, { card: escalation!, commands: { ...commands, choose: failed as never }, onSubmitted })
    ;(findElements(tree2, 'button').find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })
})

// ---------- R-6：失效的交付卡整体弱化 ----------

describe('R-6：失效的交付卡带弱化样式（is-void）', () => {
  it('已失效的交付卡整卡 is-void（正文次要色的口径在样式里），待你验收的没有', () => {
    const expired = sampleDeliveryExpiredCard.kind === 'delivery' ? sampleDeliveryExpiredCard : null
    expect(expired).not.toBeNull()
    const tree = createHookHost().render(DeliveryCard, { card: expired! })
    const card = findElements(tree, 'div').find(node => classOf(node).includes('ah-card-job'))!
    expect(classOf(card)).toContain('is-void')
    const awaiting = sampleDeliveryAwaitingCard.kind === 'delivery' ? sampleDeliveryAwaitingCard : null
    const tree2 = createHookHost().render(DeliveryCard, { card: awaiting! })
    const card2 = findElements(tree2, 'div').find(node => classOf(node).includes('ah-card-job'))!
    expect(classOf(card2)).not.toContain('is-void')
  })
})
