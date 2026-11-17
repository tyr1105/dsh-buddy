/**
 * P74i-m5 的测试：并入核心 P74r13、P74r14 之后的同步，以及第五次走查的发现（维护卡 docs/tasks/P74i-m5-sync-and-walk5-fixes.md）。
 *
 * 覆盖：
 * - 第 0 步：发布审批样例的一句话与风险提示的新写法、约定确认条目样例带约定标题；
 * - 第 1 节：发给总管的前缀改用约定标题（有标题、没有标题各一条逐字）；
 * - 第 2 节：约定确认条目卡片上「不会自动按建议处理。……」恰好出现一次；
 * - 第 3 节：处理成功后的提示逐字（十四行各一条）；
 * - 第 4 节：提示吸附在可见区域顶部（样式），读屏属性保持；
 * - 第 5 节：字数提示（附言 179、180、200 个字；另三种输入框）；
 * - 第 6 节：按钮的可达名称带条目标题；「验收通过」是主要按钮、「有不符」是次要按钮；
 * - 第 7 节：?job=b2 只留最新一版约定确认条目；三个新样例各自的入口与行为；十个入口的快照与实时样例一致。
 *
 * 测试环境没有真 React：只渲染传进来的这一个组件，子组件不执行（见 helpers/hook-host.ts）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { EscalationCard } from '../src/client/components/JobCard.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { ObjectionHost, accessibleNameOf } from '../src/client/components/InboxObjection.js'
import { NOTE_CHAR_LIMIT, OBJECTION_CHAR_LIMIT, charCountHint } from '../src/client/logic/char-count.js'
import { inboxHandledNotice } from '../src/client/logic/inbox-notice.js'
import { OBJECTION_TEXT, agreementPrefixOf, clearSentLines, objectionOf } from '../src/client/logic/inbox-objection.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import {
  sampleApprovalInboxEntries, sampleB2InboxEntry, sampleChosenEscalationInboxEntry, sampleEscalationCard, sampleJobInboxEntries,
  sampleNoTopicAcceptInboxEntry, sampleProposalInboxEntry, sampleStopInboxEntry,
} from '../src/shared/fixture-job.js'
import {
  previewChosenEscalationInboxEntry, previewNoTopicAcceptInboxEntry, previewProposalInboxEntry,
} from '../src/shared/fixture-job-preview.js'
import { PREVIEW_JOB_ENTRIES, applyPreviewJobEntry, basePreviewState } from '../src/shared/preview-job-state.js'
import type { EscalationCardView, InboxItemView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

// ---------- 小工具 ----------

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const buttons = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonByText = (tree: unknown, text: string): StubElement | undefined => buttons(tree).find(node => textOf(node) === text)
const inputsOf = (tree: unknown): StubElement[] => findElements(tree, 'input')
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
/** 数一段文字在另一段里出现几次。 */
const countOf = (text: string, part: string): number => text.split(part).length - 1

const fixtureItem = (id: string): InboxItemView => {
  const found = fixtureInbox.items.find(item => item.id === id)
  if (found === undefined) throw new Error(`样例里没有条目 ${id}`)
  return found
}
const agreementItem = fixtureItem('inbox-agr1')
const proposalItem = fixtureItem('inbox-p1')
const [acceptItem, escalateItem, capItem, stallItem] = sampleJobInboxEntries as [InboxItemView, InboxItemView, InboxItemView, InboxItemView]
const approvals = sampleApprovalInboxEntries as unknown as InboxItemView[]
const normalApproval = approvals.find(item => item.approval?.launch === false)!
const launchApproval = approvals.find(item => item.approval?.launch === true)!
const noopActions = { onPick: async () => null }

beforeEach(() => clearSentLines())

/** 渲染一个 ObjectionHost：把按钮和输入区摆在同一个容器里。 */
function renderHost(host: ReturnType<typeof createHookHost>, props: { spec: typeof OBJECTION_TEXT[keyof typeof OBJECTION_TEXT]; itemTitle?: string }): unknown {
  return host.render(ObjectionHost, {
    spec: props.spec, itemKey: `k_${props.spec.buttonLabel}`, send: async () => null, onSent: () => undefined,
    ...(props.itemTitle !== undefined ? { itemTitle: props.itemTitle } : {}),
    children: ({ button, panel }) => ({ type: 'div', props: { children: [button, panel] }, key: null }) as never,
  })
}

/** 点开输入区并写入 n 个字，返回写入之后的树。 */
function typeInto(host: ReturnType<typeof createHookHost>, props: Parameters<typeof renderHost>[1], count: number): unknown {
  ;(buttonByText(renderHost(host, props), props.spec.buttonLabel)!.props.onClick as () => void)()
  ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '字'.repeat(count) } })
  return renderHost(host, props)
}

/** 在 InboxPane 里取某个条目的发送函数，发一句话，返回 onSendMessage 收到的线程与文字。 */
async function sentVia(item: InboxItemView, word: string): Promise<[string, string]> {
  const onSendMessage = vi.fn(async () => null)
  const host = createHookHost()
  const tree = host.render(InboxPane, {
    inbox: { items: [item] }, loading: false, error: null, onRetry: () => undefined,
    actions: noopActions, busyId: null, onOpenThread: () => undefined, onSendMessage,
  })
  await (findElements(tree, ObjectionHost)[0]!.props.send as (text: string) => Promise<string | null>)(word)
  return onSendMessage.mock.calls[0] as unknown as [string, string]
}

// ---------- 第 0 步：样例与核心的新写法对齐 ----------

describe('第 0 步：样例跟上核心 P74r13、P74r14 的写法', () => {
  it('发布审批样例：一句话是「按约定对外发布：{发布方式}」，风险提示是新的末句；普通审批不变', () => {
    expect(launchApproval.title).toBe('批准：按约定对外发布：发到内网演示地址，把地址发给你')
    expect(launchApproval.approval!.actionText).toBe('按约定对外发布：发到内网演示地址，把地址发给你')
    // P74r20 同步（第 2 节第 1 条）：风险提示换成核心 P74r18b 之后生成的句子（原为「这条命令在受限沙箱内运行，……」）。
    expect(launchApproval.approval!.riskNote).toBe('批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。')
    expect(JSON.stringify(sampleApprovalInboxEntries)).not.toContain('看不懂就拒绝')
    expect(JSON.stringify(sampleApprovalInboxEntries)).not.toContain('请中心代为运行')
    expect(normalApproval.title).toBe('批准：把排查结论写进共享目录的交接文件')
  })

  it('约定确认条目样例带约定标题（核心 P74r14 的 agreementTitle）：基础样例、?job=b2、停止样例都有', () => {
    expect(agreementItem.agreementTitle).toBe('活动报名页')
    expect(sampleB2InboxEntry.agreementTitle).toBe('活动报名页')
    expect(sampleStopInboxEntry.agreementTitle).toBe('活动报名页')
  })
})

// ---------- 第 1 节 ----------

describe('第 1 节：发给总管的前缀改用约定的标题（逐字）', () => {
  it('有约定标题：（关于约定「{标题}」第 {版本号} 版）{话}', async () => {
    const item = { ...agreementItem, agreementTitle: '活动报名页', agreementVersion: 2 }
    expect(await sentVia(item, '人数改回 80')).toEqual([item.botId, '（关于约定「活动报名页」第 2 版）人数改回 80'])
    expect(agreementPrefixOf({ ...item, agreementVersion: 4 })).toBe('（关于约定「活动报名页」第 4 版）')
  })

  it('没有约定标题（旧数据）：退回原来的写法（关于{条目标题}）{话}', async () => {
    const item = { ...agreementItem, agreementTitle: null, agreementVersion: 2 }
    expect(await sentVia(item, '人数改回 80')).toEqual([item.botId, '（关于约定第 2 版待你确认：活动报名页）人数改回 80'])
    // 标题为空字符串同样退回。
    expect(agreementPrefixOf({ title: '约定第 2 版待你确认：活动报名页', agreementTitle: '', agreementVersion: 2 })).toBe('（关于约定第 2 版待你确认：活动报名页）')
  })

  it('说明卡、组队确认的前缀不变', async () => {
    expect((await sentVia(escalateItem, '先保留手机号校验'))[1]).toBe('（关于活动报名页：第 3 条三轮未通过）先保留手机号校验')
    expect((await sentVia(fixtureItem('inbox-team-add'), '换一个研究员'))[1]).toBe('（关于组队方案）换一个研究员')
  })
})

// ---------- 第 2 节 ----------

describe('第 2 节：约定确认条目的说明行只出现一次', () => {
  const sentence = '不会自动按建议处理。你确认前，暂停的部分不会做。'
  it('?job=b2 的条目（两栏）：卡片文字里这一句恰好出现一次，条目正文里没有', () => {
    expect(sampleB2InboxEntry.body).not.toContain('不会自动按建议处理')
    const tree = createHookHost().render(InboxCard, { card: itemToCard(sampleB2InboxEntry), actions: noopActions, busy: false })
    expect(countOf(textOf(tree), sentence)).toBe(1)
  })

  it('停止标记的条目：它的说明句同样只出现一次', () => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(sampleStopInboxEntry as unknown as InboxItemView), actions: noopActions, busy: false })
    expect(countOf(textOf(tree), '不会自动按建议处理。你确认后这件事停止；确认前照常在做。')).toBe(1)
    expect(countOf(textOf(tree), '不会自动按建议处理')).toBe(1)
  })
})

// ---------- 第 3 节 ----------

describe('第 3 节：处理成功后的提示只写已经发生的事（十四行各一条，逐字）', () => {
  const agreementConfirm: InboxItemView = { ...acceptItem, jobEntry: null, agreementId: 'agr_x', agreementVersion: 4, options: ['按建议，定了'] }
  const proposal: InboxItemView = { ...sampleProposalInboxEntry }
  const alert: InboxItemView = { ...acceptItem, jobEntry: null, type: 'alert', options: ['知道了'] }
  const plain: InboxItemView = { ...acceptItem, jobEntry: null, options: ['选项甲'] }
  it.each<[string, InboxItemView, string, string]>([
    ['验收条目，验收通过', acceptItem, '验收通过', '已验收。'],
    ['说明卡条目，选了一个办法并提交', escalateItem, '', '已提交你选的办法。'],
    ['普通审批，批准', normalApproval, '批准', '已批准。'],
    ['普通审批，拒绝', normalApproval, '拒绝', '已拒绝，这一步不会执行。'],
    ['发布审批，批准发布', launchApproval, '批准', '已批准发布。'],
    ['发布审批，暂不发布', launchApproval, '拒绝', '已选择暂不发布，这次不会发布。'],
    ['没有进展的条目，再提醒一次', stallItem, '再提醒一次', '已再提醒一次。'],
    ['没有进展的条目，暂停', stallItem, '暂停', '已暂停这件事。'],
    ['回合用到上限的条目，暂停', capItem, '暂停', '已暂停这件事。'],
    ['回合用到上限的条目，再给 N 个回合', capItem, '再给 8 个回合', '已追加 8 个回合。'],
    ['约定确认条目，按建议定了', agreementConfirm, '按建议，定了', '已确认约定。'],
    ['提议，接受', proposal, '接受', '已接受这条提议。'],
    ['提议，不做', proposal, '不做', '已选择不做，这一项不会执行。'],
    ['告警，知道了', alert, '知道了', '已知晓。'],
    ['其余条目', plain, '选项甲', '已提交。'],
  ])('%s', (_name, item, option, expected) => {
    expect(inboxHandledNotice(item, option)).toBe(expected)
    expect(expected).not.toContain('下一步')
  })
})

// ---------- 第 4 节 ----------

describe('第 4 节：成功提示在列表滚动时始终贴在可见区域的顶部', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/client/styles.css'), 'utf8')
  it('提示的样式是吸附定位（position: sticky、top: 0），有层级，不被条目盖住', () => {
    const rule = /\n\.ah-inbox-done \{([^}]*)\}/.exec(css)![1]!
    expect(rule).toContain('position: sticky')
    expect(rule).toContain('top: 0')
    expect(rule).toMatch(/z-index: [1-9]/)
    // 吸附的容器就是会滚动的列表本身（overflow-y: auto），提示是它的直接子元素。
    expect(/\n\.ah-inbox \{[^}]*overflow-y: auto/.test(css)).toBe(true)
  })

  it('读屏可感知的属性保持：提示仍是 role=status，且是列表的直接子元素；处理之后出现', async () => {
    const host = createHookHost()
    const props = { inbox: { items: [launchApproval] }, loading: false, error: null, onRetry: () => undefined, actions: noopActions, busyId: null, onOpenThread: () => undefined }
    const first = host.render(InboxPane, props)
    expect(findElements(first, 'div').some(node => classOf(node) === 'ah-inbox-done')).toBe(false)
    const card = findElements(first, InboxCard)[0]!
    await (card.props.actions as { onPick: (c: unknown, option: string) => Promise<string | null> }).onPick(card.props.card, '批准')
    await flush()
    const done = findElements(host.render(InboxPane, props), 'div').find(node => classOf(node) === 'ah-inbox-done')!
    expect(done.props.role).toBe('status')
    expect(textOf(done)).toContain('已批准发布。')
  })
})

// ---------- 第 5 节 ----------

describe('第 5 节：字数提示', () => {
  it('纯函数：不到九成不提示；九成起写「已输入/上限 字」；到上限写「已到 上限 字的上限」', () => {
    expect(charCountHint(0, 200)).toBeNull()
    expect(charCountHint(179, 200)).toBeNull()
    expect(charCountHint(180, 200)).toBe('180/200 字')
    expect(charCountHint(199, 200)).toBe('199/200 字')
    expect(charCountHint(200, 200)).toBe('已到 200 字的上限')
    expect(charCountHint(449, 500)).toBeNull()
    expect(charCountHint(450, 500)).toBe('450/500 字')
    expect(charCountHint(500, 500)).toBe('已到 500 字的上限')
  })

  /** 提议的附言框里写 n 个字，返回输入框下面的字数提示（没有时 null）。 */
  const noteHintAt = (count: number): string | null => {
    const host = createHookHost()
    const props = { card: { ...itemToCard(proposalItem), options: ['接受', '不做'], defaultOption: null }, actions: noopActions, busy: false }
    const first = host.render(InboxCard, props)
    const note = inputsOf(first).find(node => classOf(node) === 'ah-card-note')!
    expect(note.props.maxLength).toBe(NOTE_CHAR_LIMIT)
    ;(note.props.onChange as (e: unknown) => void)({ target: { value: '字'.repeat(count) } })
    const hint = findElements(host.render(InboxCard, props), 'p').find(node => classOf(node) === 'ah-card-note-count')
    return hint === undefined ? null : textOf(hint)
  }
  it('附言 179 个字：没有提示', () => { expect(noteHintAt(179)).toBeNull() })
  it('附言 180 个字：180/200 字', () => { expect(noteHintAt(180)).toBe('180/200 字') })
  it('附言 200 个字：已到 200 字的上限', () => { expect(noteHintAt(200)).toBe('已到 200 字的上限') })

  it('「要修改」「有不符」「都不合适」三种输入框：上限 500，450 字起写字数，500 字写已到上限', () => {
    expect(OBJECTION_CHAR_LIMIT).toBe(500)
    for (const spec of [OBJECTION_TEXT.agreement, OBJECTION_TEXT.accept, OBJECTION_TEXT.escalate]) {
      const hostA = createHookHost()
      const below = typeInto(hostA, { spec }, 449)
      expect(inputsOf(below)[0]!.props.maxLength).toBe(500)
      expect(findElements(below, 'p').some(node => classOf(node) === 'ah-inbox-objection-count')).toBe(false)
      const near = typeInto(createHookHost(), { spec }, 450)
      expect(textOf(findElements(near, 'p').find(node => classOf(node) === 'ah-inbox-objection-count'))).toBe('450/500 字')
      const full = typeInto(createHookHost(), { spec }, 500)
      expect(textOf(findElements(full, 'p').find(node => classOf(node) === 'ah-inbox-objection-count'))).toBe('已到 500 字的上限')
    }
  })
})

// ---------- 第 6 节 ----------

describe('第 6 节：按钮分得清', () => {
  it('可达名称 =「按钮上的字：条目标题」（要修改、有不符、都不合适各一条），显示的文字不变', () => {
    const cases: Array<[typeof OBJECTION_TEXT[keyof typeof OBJECTION_TEXT], string, string]> = [
      [OBJECTION_TEXT.agreement, '约定第 2 版待你确认：活动报名页', '要修改'],
      [OBJECTION_TEXT.accept, '活动报名页：待你验收', '有不符'],
      [OBJECTION_TEXT.escalate, '活动报名页：第 3 条三轮未通过', '都不合适'],
    ]
    for (const [spec, title, label] of cases) {
      const tree = renderHost(createHookHost(), { spec, itemTitle: title })
      const button = buttons(tree).find(node => textOf(node) === label)!
      expect(button.props['aria-label']).toBe(`${label}：${title}`)
    }
  })

  it('「发送」「取消」的可达名称同样带条目标题，显示的文字仍是「发送」「取消」', () => {
    const host = createHookHost()
    const props = { spec: OBJECTION_TEXT.agreement, itemTitle: '约定第 2 版待你确认：活动报名页' }
    ;(buttonByText(renderHost(host, props), '要修改')!.props.onClick as () => void)()
    const tree = renderHost(host, props)
    expect(buttonByText(tree, '发送')!.props['aria-label']).toBe('发送：约定第 2 版待你确认：活动报名页')
    expect(buttonByText(tree, '取消')!.props['aria-label']).toBe('取消：约定第 2 版待你确认：活动报名页')
    // 没有标题时不带冒号。
    expect(accessibleNameOf('发送', '')).toBe('发送')
  })

  it('同一页有多条条目时，InboxPane 给每条的 ObjectionHost 传各自的标题，名称互不相同', () => {
    const host = createHookHost()
    const tree = host.render(InboxPane, {
      inbox: { items: [agreementItem, acceptItem, escalateItem] }, loading: false, error: null, onRetry: () => undefined,
      actions: noopActions, busyId: null, onOpenThread: () => undefined, onSendMessage: async () => null,
    })
    // 列表按优先级、时间排序，顺序不固定，这里只看每条各传了自己的标题。
    const titles = findElements(tree, ObjectionHost).map(node => String(node.props.itemTitle))
    expect([...titles].sort()).toEqual([agreementItem.title, acceptItem.title, escalateItem.title].sort())
    expect(new Set(titles).size).toBe(3)
  })

  it('「验收通过」是主要按钮的样子，「有不符」是次要按钮的样子（无 ah-btn-primary）', () => {
    const card = createHookHost().render(InboxCard, { card: itemToCard(acceptItem), actions: noopActions, busy: false })
    expect(classOf(buttonByText(card, '验收通过')!)).toContain('ah-btn-primary')
    const objection = buttonByText(renderHost(createHookHost(), { spec: OBJECTION_TEXT.accept, itemTitle: acceptItem.title }), '有不符')!
    expect(classOf(objection)).toBe('ah-btn')
  })

  it('说明卡：「按所选办法处理」是主要按钮，「都不合适」是次要按钮', () => {
    const card: EscalationCardView = sampleEscalationCard.kind === 'escalation' ? sampleEscalationCard : (() => { throw new Error('应是三轮不过卡') })()
    const tree = createHookHost().render(EscalationCard, { card })
    expect(classOf(buttonByText(tree, '按所选办法处理')!)).toContain('ah-btn-primary')
    const objection = buttonByText(renderHost(createHookHost(), { spec: OBJECTION_TEXT.escalate, itemTitle: escalateItem.title }), '都不合适')!
    expect(classOf(objection)).toBe('ah-btn')
  })

  it('对照：约定确认条目「按建议，定了」主要、「要修改」次要，本卡没有改变', () => {
    const card = createHookHost().render(InboxCard, { card: itemToCard(agreementItem), actions: noopActions, busy: false })
    expect(classOf(buttonByText(card, '按建议，定了')!)).toContain('ah-btn-primary')
    expect(classOf(buttonByText(renderHost(createHookHost(), { spec: OBJECTION_TEXT.agreement }), '要修改')!)).toBe('ah-btn')
  })
})

// ---------- 第 7 节 ----------

describe('第 7 节：样例', () => {
  const NOW = Date.parse('2026-11-13T10:00:00+08:00')
  const stateOf = (entry: (typeof PREVIEW_JOB_ENTRIES)[number]) => applyPreviewJobEntry(basePreviewState(), entry, NOW)
  const agreementEntries = (entry: (typeof PREVIEW_JOB_ENTRIES)[number]): InboxItemView[] =>
    stateOf(entry).inbox!.items.filter(item => typeof item.agreementId === 'string' && item.agreementId !== '')

  it('?job=b2：「待你处理」里约定确认条目只有最新一版（第 4 版），没有第 2 版', () => {
    const items = agreementEntries('b2')
    expect(items).toHaveLength(1)
    expect(items[0]!.agreementVersion).toBe(4)
    expect(stateOf('b2').inbox!.items.map(item => item.title)).not.toContain('约定第 2 版待你确认：活动报名页')
  })

  it('?job=stop：同样只留停止样例那一条约定确认条目', () => {
    const items = agreementEntries('stop')
    expect(items).toHaveLength(1)
    expect(items[0]!.agreementStop).toBe(true)
  })

  it('不带约定条目的入口保留基础样例里的约定确认条目（?job=delivery）', () => {
    expect(agreementEntries('delivery')).toHaveLength(1)
    expect(agreementEntries('delivery')[0]!.agreementVersion).toBe(2)
  })

  it('已经选过办法的说明卡条目（?job=escalation-states）：卡上已选，没有「都不合适」', () => {
    const entry = stateOf('escalation-states').inbox!.items.find(item => item.id === 'i_sampleview6')!
    expect(entry.jobEntry?.kind).toBe('escalate')
    expect(entry.escalationCard!.chosen).not.toBeNull()
    expect(objectionOf(entry)).toBeNull()
    // 对照：没选过的说明卡条目有「都不合适」。
    expect(objectionOf(escalateItem)).not.toBeNull()
  })

  it('没有主题编号的验收条目（?job=delivery）：没有「有不符」；带主题编号的那条仍有', () => {
    const items = stateOf('delivery').inbox!.items
    const noTopic = items.find(item => item.id === 'i_sampleview7')!
    expect(noTopic.jobEntry?.kind).toBe('accept')
    expect(noTopic.topicId).toBeNull()
    expect(objectionOf(noTopic)).toBeNull()
    expect(objectionOf(items.find(item => item.id === 'i_sampleview1')!)).not.toBeNull()
    // 事的编号不同，点其中一条的验收不会移走另一条。
    expect(noTopic.jobEntry?.jobId).not.toBe(items.find(item => item.id === 'i_sampleview1')!.jobEntry?.jobId)
  })

  it('按钮是「接受」「不做」的提议（?job=approval）：默认「接受」，提示分别是已接受、已选择不做', () => {
    const entry = stateOf('approval').inbox!.items.find(item => item.id === 'i_sampleview8')!
    expect(entry.type).toBe('proposal')
    expect(entry.options).toEqual(['接受', '不做'])
    expect(inboxHandledNotice(entry, '接受')).toBe('已接受这条提议。')
    expect(inboxHandledNotice(entry, '不做')).toBe('已选择不做，这一项不会执行。')
  })

  it('新增的三个样例没有新增入口：入口只在原有十个上加 P75k 的 retro、P74r20 的 launch、P81r1 的 localdir，共十三个；快照与实时样例逐字相同', () => {
    expect(PREVIEW_JOB_ENTRIES).toHaveLength(13)
    expect(JSON.stringify(previewChosenEscalationInboxEntry)).toBe(JSON.stringify(sampleChosenEscalationInboxEntry))
    expect(JSON.stringify(previewNoTopicAcceptInboxEntry)).toBe(JSON.stringify(sampleNoTopicAcceptInboxEntry))
    expect(JSON.stringify(previewProposalInboxEntry)).toBe(JSON.stringify(sampleProposalInboxEntry))
  })

  it('十个入口各自加完条目之后，左栏与顶部的计数与条数一致', () => {
    for (const entry of PREVIEW_JOB_ENTRIES) {
      const state = stateOf(entry)
      expect(state.overview!.inbox.total, entry).toBeGreaterThanOrEqual(0)
      if (state.inbox!.items.length !== basePreviewState().inbox!.items.length) {
        expect(state.overview!.inbox.total, entry).toBe(state.inbox!.items.length)
      }
    }
  })
})
