/**
 * P74i-m3 的测试（第 2 节在 p74i-m3-drawer.test.tsx）：第四次走查与真实沙箱里发现的界面问题。
 *
 * - 第 1、3 节：版面（420 宽下项目页清单、「待你处理」面板）由走查在浏览器里确认；这里按现有写法
 *   断言样式文件里相关的类名与规则存在。
 * - 第 4 节：「待你处理」处理成功后的提示，表里每一行一条，逐字。
 * - 第 5 节：楼层汇总一句：有更早记录、没有更早记录各一条；主题卡不再被当成「没加载」。
 * - 第 6 节：发布审批点完之后的结果写「已选：批准发布」「已选：暂不发布」，普通审批不变。
 * - 第 7 节：顶栏计数与说明卡两个小标题的书面表达。
 * - 第 8 节：三个新样例（链接证据、已过期的审批、折叠组部分未加载）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { TopBar } from '../src/client/components/TopBar.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { WorkFold } from '../src/client/components/WorkFold.js'
import { cardResultText, type CardPayload } from '../src/client/logic/cards.js'
import { inboxHandledNotice } from '../src/client/logic/inbox-notice.js'
import { JOB_TEXT, floorEarlierCount, floorsCountText } from '../src/client/logic/job.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import {
  sampleApprovalInboxEntries, sampleApprovalThread, sampleDeliveryAwaitingCard, sampleJobInboxEntries,
  samplePartialTopicThread, sampleReviewTopicThread,
} from '../src/shared/fixture-job.js'
import { applyPreviewJobEntry, basePreviewState } from '../src/shared/preview-job-state.js'
import type { InboxItemView, ThreadMessageView, TopicFloorsView } from '../src/shared/views.js'
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
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const clientDir = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8')

// ---------- 第 1 节：项目页「当前事务清单」420 宽 ----------

describe('第 1 节：项目页清单在窄宽度下允许换行', () => {
  const css = clientDir('workspace.css')
  /** 取窄宽度容器查询那一段规则体。 */
  const narrow = (): string => {
    const start = css.indexOf('@container prj-tasks (max-width: 560px)')
    expect(start).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('\n}', start))
  }

  it('窄宽度下每行改为弹性换行，标题独占第一行', () => {
    const body = narrow()
    expect(body).toMatch(/\.ah-prj-task-grid \.ah-prj-item \{[^}]*display: flex[^}]*flex-wrap: wrap/)
    expect(body).toMatch(/\.ah-prj-item-title \{[^}]*flex: 0 0 100%/)
  })

  it('执行者列有最小宽度，状态标签与时间都不超出卡片（max-width 100%）', () => {
    const body = narrow()
    expect(body).toMatch(/\.ah-prj-note \{[^}]*min-width: 3\.5em[^}]*max-width: 100%/)
    expect(body).toMatch(/\.ah-tag \{[^}]*max-width: 100%/)
  })

  it('宽屏的网格列规则没有改动（720、1440 宽的样子不变）', () => {
    expect(css).toContain('.ah-prj-task-grid .ah-prj-item { display: grid; grid-template-columns: minmax(5em, 1fr) minmax(3.5em, auto) max-content max-content;')
  })
})

// ---------- 第 3 节：「待你处理」420 宽 ----------

describe('第 3 节：「待你处理」面板内容跟随面板宽度', () => {
  const css = clientDir('styles.css')
  it('面板和条目的单列网格都写成 minmax(0, 1fr)，条目内文字换行，不出现横向滚动', () => {
    const rule = (selector: string): string => new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)![1]!
    expect(rule('.ah-inbox')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(rule('.ah-inbox')).toContain('overflow-x: hidden')
    expect(rule('.ah-inbox-row')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(rule('.ah-inbox-row')).toContain('min-width: 0')
    expect(rule('.ah-inbox-row')).toContain('overflow-wrap: anywhere')
  })
})

// ---------- 第 4 节：处理成功后的提示 ----------

describe('第 4 节：「待你处理」处理成功后的提示（逐字）', () => {
  const entries = sampleJobInboxEntries as InboxItemView[]
  const byKind = (kind: string): InboxItemView => entries.find(item => item.jobEntry?.kind === kind)!
  const approvals = sampleApprovalInboxEntries as unknown as InboxItemView[]
  const normalApproval = approvals.find(item => item.approval?.launch === false)!
  const launchApproval = approvals.find(item => item.approval?.launch === true)!
  const agreementItem: InboxItemView = { ...byKind('accept'), jobEntry: null, agreementId: 'agr_x', agreementVersion: 4, options: ['按建议，定了'] }
  const plainQuestion: InboxItemView = { ...byKind('accept'), jobEntry: null, options: ['选项甲', '选项乙'] }

  it('样例审批条目上的员工名是「总管」（下面逐字写死员工名；提示里的 {员工} 取条目上的员工名）', () => {
    expect(normalApproval.botName).toBe('总管')
    expect(launchApproval.botName).toBe('总管')
  })

  it('验收条目，验收通过：已验收。', () => {
    expect(inboxHandledNotice(byKind('accept'), '验收通过')).toBe('已验收。')
  })
  it('说明卡条目，选了办法并提交：已提交你选的办法。', () => {
    // P74i-m5（第 3 节）改了预期：原为「已提交你选的办法。下一步：总管按这个办法处理。」，提示只写已发生的事。
    expect(inboxHandledNotice(byKind('escalate'), '')).toBe('已提交你选的办法。')
  })
  it('普通审批，批准：已批准。', () => {
    // P74i-m5（第 3 节）改了预期：原为「已批准。下一步：林舟执行这一步。」（P79 取卡上的执行者），提示只写已发生的事。
    expect(inboxHandledNotice(normalApproval, '批准')).toBe('已批准。')
  })
  it('普通审批，拒绝：已拒绝，这一步不会执行。', () => {
    expect(inboxHandledNotice(normalApproval, '拒绝')).toBe('已拒绝，这一步不会执行。')
  })
  it('发布审批，批准发布：已批准发布。', () => {
    // P74i-m5（第 3 节）改了预期：原为「已批准发布。下一步：林舟执行发布。」，提示只写已发生的事。
    expect(inboxHandledNotice(launchApproval, '批准')).toBe('已批准发布。')
  })
  it('发布审批，暂不发布：已选择暂不发布，这次不会发布。', () => {
    expect(inboxHandledNotice(launchApproval, '拒绝')).toBe('已选择暂不发布，这次不会发布。')
  })
  it('没有进展的条目，再提醒一次：已再提醒一次。', () => {
    expect(inboxHandledNotice(byKind('stall'), '再提醒一次')).toBe('已再提醒一次。')
  })
  it('没有进展的条目，暂停：已暂停这件事。', () => {
    expect(inboxHandledNotice(byKind('stall'), '暂停')).toBe('已暂停这件事。')
  })
  it('回合用到上限的条目，暂停：已暂停这件事。', () => {
    expect(inboxHandledNotice(byKind('cap'), '暂停')).toBe('已暂停这件事。')
  })
  it('回合用到上限的条目，再给 8 个回合：已追加 8 个回合。', () => {
    expect(inboxHandledNotice(byKind('cap'), '再给 8 个回合')).toBe('已追加 8 个回合。')
  })
  it('约定确认条目，按建议定了：已确认约定。', () => {
    expect(inboxHandledNotice(agreementItem, '按建议，定了')).toBe('已确认约定。')
  })
  it('表里没有列到的条目写通用句「已提交。」（有员工名与没有员工名一样）', () => {
    // P74i-m5（第 3 节）改了预期：原为「已提交。下一步：继续执行，负责人 林舟。」与「已提交。下一步：待安排。」。
    expect(inboxHandledNotice({ ...plainQuestion, botName: '林舟' }, '选项甲')).toBe('已提交。')
    expect(inboxHandledNotice({ ...plainQuestion, botName: null }, '选项甲')).toBe('已提交。')
  })
  it('表外补充：提议选「不做」、告警点「知道了」不再写「继续执行」；提议的其余按钮写通用句', () => {
    const proposal: InboxItemView = { ...plainQuestion, type: 'proposal', botName: '林舟', options: ['接受', '不做'] }
    expect(inboxHandledNotice(proposal, '不做')).toBe('已选择不做，这一项不会执行。')
    // P74i-m5（第 3 节）改了预期：提议选「接受」原为通用句「已提交。下一步：继续执行，负责人 林舟。」，现在有自己的一句。
    expect(inboxHandledNotice(proposal, '接受')).toBe('已接受这条提议。')
    expect(inboxHandledNotice({ ...proposal, options: ['接受', '先保持'] }, '先保持')).toBe('已提交。')
    expect(inboxHandledNotice({ ...plainQuestion, type: 'alert', options: ['知道了'] }, '知道了')).toBe('已知晓。')
  })
  it('条目没有员工名时，审批批准同样只写结果', () => {
    // P79（第 5 节）：卡上没有「由……执行」这一行、条目也没有员工名；P74i-m5 起有无员工名提示都一样。
    expect(inboxHandledNotice({ ...normalApproval, botName: null, approval: { ...normalApproval.approval!, onBehalfOf: null } }, '批准')).toBe('已批准。')
    expect(inboxHandledNotice({ ...launchApproval, botName: null, approval: { ...launchApproval.approval!, onBehalfOf: null } }, '批准')).toBe('已批准发布。')
  })

  it('经过 InboxPane：批准一条发布审批后，页面顶上的提示就是上面那句', async () => {
    const host = createHookHost()
    const props = {
      inbox: { items: [launchApproval] }, loading: false, error: null, onRetry: () => undefined,
      actions: noopActions, busyId: null, onOpenThread: () => undefined,
    }
    const first = host.render(InboxPane, props)
    const card = findElements(first, InboxCard)[0]!
    const onPick = (card.props.actions as { onPick: (c: CardPayload, option: string) => Promise<string | null> }).onPick
    await onPick(card.props.card as CardPayload, '批准')
    await flush()
    const after = host.render(InboxPane, props)
    const done = findElements(after, 'div').find(node => classOf(node) === 'ah-inbox-done')
    expect(done).toBeDefined()
    // P74i-m5（第 3 节）改了预期：原为「已批准发布。下一步：林舟执行发布。」，提示只写已发生的事。
    expect(textOf(done)).toContain('已批准发布。')
    expect(textOf(done)).not.toContain('下一步')
  })
})

// ---------- 第 5 节：记录条数的说法 ----------

describe('第 5 节：楼层汇总一句与「更早的 n 条」要一致', () => {
  const raw = (id: string, from = 'b_samplelinzhou') => ({ id, thread: 'ptp_x', from, kind: 'chat' as const, text: id, refId: null, createdAt: 1, readAt: null })
  /** 一个楼层加一组两条往来共 3 条记录；核心给的汇总是「共 3 条记录：给你的 1 条，员工之间的往来 2 条（已收起）」。 */
  const floors: TopicFloorsView = {
    countText: '共 3 条记录：给你的 1 条，员工之间的往来 2 条（已收起）',
    items: [
      { kind: 'floor', message: raw('m0', 'owner') },
      { kind: 'fold', id: 'f1', count: 2, participants: ['林舟'], rangeText: '11月17日', latest: 'x', messages: [
        { message: raw('m1'), fromName: '林舟', toNames: [] }, { message: raw('m2'), fromName: '林舟', toNames: [] }] },
    ],
  } as unknown as TopicFloorsView

  it('全部已加载：照旧显示核心给的「共 n 条记录：……」', () => {
    expect(floorsCountText(floors, () => true)).toBe('共 3 条记录：给你的 1 条，员工之间的往来 2 条（已收起）')
  })
  it('有更早的记录没加载：改为「已加载 n 条记录：……」，n 与分项都只数已加载的', () => {
    // 楼层那条没加载，折叠组里只加载了 m2。
    const loaded = (id: string): boolean => id === 'm2'
    expect(floorEarlierCount(floors.items, loaded)).toBe(1)
    expect(floorsCountText(floors, loaded)).toBe('已加载 1 条记录：给你的 0 条，员工之间的往来 1 条（已收起）')
  })
  it('有更早的记录没加载，且已加载的里没有工作往来：只写「已加载 n 条记录」', () => {
    const only = { countText: '共 2 条记录：给你的 1 条，员工之间的往来 1 条（已收起）', items: [
      { kind: 'floor', message: raw('a0', 'owner') }, { kind: 'floor', message: raw('a1', 'owner') },
      { kind: 'fold', id: 'f9', count: 1, participants: [], rangeText: '', latest: '', messages: [{ message: raw('a2'), fromName: '林舟', toNames: [] }] },
    ] } as unknown as TopicFloorsView
    expect(floorsCountText(only, id => id === 'a1')).toBe('已加载 1 条记录')
  })

  it('主题卡（opening）已显示，不再被当成「更早的、没加载的」：完整加载的样例主题不写「更早的 n 条」', () => {
    // 此前这里会写「更早的 1 条记录还没有加载。」，同页又写「共 8 条记录」。
    const thread = sampleReviewTopicThread
    // P74i-m6（第 2 节）：这个主题现在挂了一份约定（为了让进度行看得到「已完成（你暂不发布）」），有约定面板时主题卡
    // 不再单独显示（opening 为空，约定面板代替它）。这条测试要钉住的是「主题卡显示时不被当成没加载的」，
    // 所以这里照没有约定面板的口径（hasAgreement 为假）构造；有约定面板的真实样子由下面的第二条断言覆盖。
    const model = buildTopicThread(thread.messages as ThreadMessageView[], thread.hasMore, { hasAgreement: false })
    expect(model.opening).not.toBeNull()
    expect(buildTopicThread(thread.messages as ThreadMessageView[], thread.hasMore, { hasAgreement: thread.agreement != null }).opening).toBeNull()
    const tree = createHookHost().render(TopicThreadBody, {
      model, replying: [], actions: noopActions, busyInboxId: null, floors: thread.floors,
    })
    const text = textOf(tree)
    expect(text).not.toContain('还没有加载')
    expect(text).toContain(thread.floors!.countText)
    expect(thread.floors!.countText).toMatch(/^共 \d+ 条记录/)
  })
})

// ---------- 第 6 节：发布审批的结果用词 ----------

describe('第 6 节：发布审批点完之后的结果与按钮用词一致', () => {
  const base = (launch: boolean, answer: string): CardPayload => ({
    inboxId: 'i1', approvalId: 'ap1', type: 'approval', status: 'answered', goalId: null, title: 't', body: 'b',
    options: [], defaultOption: null, answer, expiresText: null,
    approval: { actionText: 'a', ownerReason: null, riskNote: null, argsPreview: '', notes: null, onBehalfOf: null, launch, voided: false },
  } as CardPayload)
  it('发布审批批准：已选：批准发布', () => {
    expect(cardResultText(base(true, '批准'))).toBe(`已选：${JOB_TEXT.approvalLaunchApprove}`)
    expect(cardResultText(base(true, '批准'))).toBe('已选：批准发布')
  })
  it('发布审批拒绝：已选：暂不发布', () => {
    expect(cardResultText(base(true, '拒绝'))).toBe('已选：暂不发布')
  })
  it('普通审批不变：已选：批准、已选：拒绝', () => {
    expect(cardResultText(base(false, '批准'))).toBe('已选：批准')
    expect(cardResultText(base(false, '拒绝'))).toBe('已选：拒绝')
  })
})

// ---------- 第 7 节：书面表达 ----------

describe('第 7 节：界面自己的三处文字', () => {
  const topBarText = (patch: Record<string, unknown>): string => {
    const overview = { ...structuredClone(fixtureOverview), ...patch } as typeof fixtureOverview
    return textOf(findElements(createHookHost().render(TopBar, { overview }), 'span').find(node => classOf(node) === 'ah-topbar-now'))
  }
  it('顶栏计数：{n} 位员工在工作，{m} 件事等你处理。', () => {
    const overview = structuredClone(fixtureOverview)
    overview.quietNow = false
    const busy = overview.bots.filter(bot => bot.activity === 'thinking').length
    expect(topBarText({ quietNow: false, inbox: { ...overview.inbox, total: 3 } })).toBe(`${busy} 位员工在工作，3 件事等你处理。`)
    expect(topBarText({ quietNow: false, inbox: { ...overview.inbox, total: 0 } })).toBe(`${busy} 位员工在工作，0 件事等你处理。`)
  })
  it('免打扰：免打扰已开启。提醒暂存，结束后一并发给你。', () => {
    expect(topBarText({ quietNow: true })).toBe('免打扰已开启。提醒暂存，结束后一并发给你。')
  })
  it('说明卡的两个小标题：受阻原因、已尝试的办法', () => {
    expect(JOB_TEXT.escalationStuck).toBe('受阻原因')
    expect(JOB_TEXT.escalationTried).toBe('已尝试的办法')
  })
})

// ---------- 第 8 节：三个新样例 ----------

describe('第 8 节：补三个样例', () => {
  it('1. 交付卡里有一条链接证据，地址是 https://example.com/ 开头的样例地址（入口 ?job=delivery）', () => {
    if (sampleDeliveryAwaitingCard.kind !== 'delivery') throw new Error('应是交付卡')
    const links = sampleDeliveryAwaitingCard.items.flatMap(item => item.evidence).filter(evidence => evidence.kind === 'link')
    expect(links).toHaveLength(1)
    expect(links[0]!.url).toMatch(/^https:\/\/example\.com\//)
  })

  it('2. ?job=approval 的对话里有一张已过期（不是已作废）的审批卡', () => {
    const cards = sampleApprovalThread.messages.filter(message => message.card !== null).map(message => message.card!)
    const expired = cards.filter(card => card.status === 'expired' && card.approval?.voided === false)
    expect(expired).toHaveLength(1)
    // 已作废的那张仍在，且与已过期的不同。
    expect(cards.filter(card => card.approval?.voided === true)).toHaveLength(1)
    // 卡的结果文字：已过期、已按默认拒绝；不写已作废。
    expect(cardResultText(expired[0]! as CardPayload)).toBe('已过期，已按默认：拒绝')
  })

  it('3. ?job=topic 的线程只带最新一页：楼层上方写「更早的 2 条」，第一组往来里更早的 1 条没加载', () => {
    const thread = samplePartialTopicThread
    expect(thread.hasMore).toBe(true)
    expect(thread.messages).toHaveLength(6)
    const loaded = new Set(thread.messages.map(message => message.id))
    const floors = thread.floors!
    expect(floorEarlierCount(floors.items, id => loaded.has(id))).toBe(2)
    const model = buildTopicThread(thread.messages as ThreadMessageView[], thread.hasMore, { hasAgreement: thread.agreement != null })
    const tree = createHookHost().render(TopicThreadBody, {
      model, replying: [], actions: noopActions, busyInboxId: null, floors, onLoadEarlier: () => undefined,
    })
    const text = textOf(tree)
    expect(text).toContain('更早的 2 条记录还没有加载。')
    expect(text).toContain('已加载 6 条记录：给你的 1 条，员工之间的往来 5 条（已收起）')
    // 折叠组（4 条里已加载 3 条）带「这一组里更早的 1 条还没有加载」的说明；展开后才画，这里核对折叠组数据本身。
    const fold = floors.items.find(item => item.kind === 'fold')!
    if (fold.kind !== 'fold') throw new Error('应是折叠组')
    const views = new Map(thread.messages.map(message => [message.id, message]))
    expect(fold.messages.filter(entry => views.has(entry.message.id))).toHaveLength(3)
    expect(fold.messages).toHaveLength(4)
    const foldTree = createHookHost().render(WorkFold, { fold, views: views as never })
    expect(foldTree).toBeDefined()
  })

  it('预览入口 ?job=topic 用的就是这条只加载一页的线程，其余入口不变', () => {
    const state = applyPreviewJobEntry(basePreviewState(), 'topic', Date.now())
    expect(state.threads[state.selectedThread]!.messages).toHaveLength(6)
    expect(state.threads[state.selectedThread]!.hasMore).toBe(true)
  })
})
