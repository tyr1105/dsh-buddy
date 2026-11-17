/**
 * P74i-m4 的测试：第五次审查的发现与并入核心之后的同步（维护卡 docs/tasks/P74i-m4-sync-and-review5-fixes.md）。
 *
 * 覆盖：
 * - 第 1 节：四种条目发送之后那一行与成功提示逐字；这一行记在「条目编号加条目内容」上，
 *   组队条目就地改版（正文、选项变了）后那一行消失，内容没变时仍在；
 * - 第 2 节：条目正在提交时「要修改」「有不符」「都不合适」禁用，处理完之后不显示（三种条目各一条）；
 * - 第 3 节：发到总管私聊的三种在话前带上界面拼的说明（逐字），验收不加；
 * - 第 4 节（界面一侧）：提议附言输入框限制 200 个字；
 * - 第 5 节：回合数从按钮文字里取、关弹窗后还焦点、?job=b2 的约定确认条目由核心的视图函数生成。
 *
 * 测试环境没有真 React：只渲染传进来的这一个组件，子组件不执行（见 helpers/hook-host.ts），
 * 所以卡片的按钮状态要从传给卡片的属性里看（做法同 p79-inbox-object.test.tsx）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { EscalationCard } from '../src/client/components/JobCard.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { ObjectionHost } from '../src/client/components/InboxObjection.js'
import { inboxHandledNotice } from '../src/client/logic/inbox-notice.js'
import {
  OBJECTION_TEXT, clearSentLines, objectionKey, objectionOf, rememberSent, sentLineOf, type ObjectionLock, type ObjectionSpec,
} from '../src/client/logic/inbox-objection.js'
import { botRowSelector, restoreEditFocus, type FocusableLike } from '../src/client/logic/edit-focus.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import { sampleB2InboxEntry, sampleJobInboxEntries } from '../src/shared/fixture-job.js'
import { previewB2InboxEntry } from '../src/shared/fixture-job-preview.js'
import type { InboxItemView } from '../src/shared/views.js'
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
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const fixtureItem = (id: string): InboxItemView => {
  const found = fixtureInbox.items.find(item => item.id === id)
  if (found === undefined) throw new Error(`样例里没有条目 ${id}`)
  return found
}
const agreementItem = fixtureItem('inbox-agr1')
const teamItem = fixtureItem('inbox-team-add')
const proposalItem = fixtureItem('inbox-p1')
const [acceptItem, escalateItem, capItem] = sampleJobInboxEntries as [InboxItemView, InboxItemView, InboxItemView, InboxItemView]

beforeEach(() => clearSentLines())

/** 渲染一个 ObjectionHost：把按钮和输入区摆在同一个容器里。 */
function renderHost(host: ReturnType<typeof createHookHost>, props: { spec: ObjectionSpec; itemKey: string; lock?: ObjectionLock; send?: (text: string) => Promise<string | null>; onSent?: (notice: string) => void }): unknown {
  return host.render(ObjectionHost, {
    spec: props.spec, itemKey: props.itemKey, send: props.send ?? (async () => null), onSent: props.onSent ?? (() => undefined),
    ...(props.lock !== undefined ? { lock: props.lock } : {}),
    children: ({ button, panel }) => ({ type: 'div', props: { children: [button, panel] }, key: null }) as never,
  })
}

/** 经条目的真实键，让一个条目走一遍「点开、写、发送成功」，返回发送之后的树。 */
async function sendOnce(host: ReturnType<typeof createHookHost>, item: InboxItemView, word = '改一下'): Promise<{ tree: unknown; onSent: ReturnType<typeof vi.fn> }> {
  const target = objectionOf(item)!
  const onSent = vi.fn()
  const props = { spec: target.spec, itemKey: objectionKey(item), onSent }
  ;(buttonByText(renderHost(host, props), target.spec.buttonLabel)!.props.onClick as () => void)()
  ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: word } })
  ;(buttonByText(renderHost(host, props), '发送')!.props.onClick as () => void)()
  await flush()
  return { tree: renderHost(host, props), onSent }
}

// ---------- 第 1 节：那一行只写主人做过的事，条目内容变了就不再显示 ----------

describe('第 1 节：发送之后那一行与成功提示逐字（四种条目）', () => {
  it.each<[string, InboxItemView, string, string]>([
    ['约定确认', agreementItem, '你已提出修改。', '已把这句话发给总管。'],
    ['组队确认', teamItem, '你已提出修改。', '已把这句话发给总管。'],
    ['验收', acceptItem, '你已指出不符。', '已发到这件事的主题里。'],
    ['说明卡', escalateItem, '你已说明都不合适。', '已把这句话发给总管。'],
  ])('%s', async (_name, item, line, notice) => {
    const { tree, onSent } = await sendOnce(createHookHost(), item)
    expect(onSent).toHaveBeenCalledWith(notice)
    const sent = findElements(tree, 'p').find(node => node.props['data-objection-sent'] === 'true')
    expect(textOf(sent)).toBe(line)
    // 不再写「在等总管……」这类替别人预告下一步的话。
    expect(textOf(tree)).not.toContain('在等总管')
    expect(notice).not.toContain('总管会处理')
    expect(notice).not.toContain('再请你确认')
  })
})

describe('第 1 节：记忆键 = 条目编号 + 条目内容', () => {
  /** 总管就地改组队方案：条目编号、组队卡编号都不变，只有正文与选项变了。 */
  const revised: InboxItemView = { ...teamItem, body: `${teamItem.body}（总管已按你的话改过）`, options: ['确认，2 位入职'] }

  it('组队条目就地改版（正文、选项变了）后键不同；内容没变键相同', () => {
    expect(revised.id).toBe(teamItem.id)
    expect(revised.teamProposalId).toBe(teamItem.teamProposalId)
    expect(objectionKey(revised)).not.toBe(objectionKey(teamItem))
    expect(objectionKey({ ...teamItem })).toBe(objectionKey(teamItem))
  })

  it('标题、正文、选项、约定版本号中任何一样变了，键都变', () => {
    const base = objectionKey(agreementItem)
    expect(objectionKey({ ...agreementItem, title: `${agreementItem.title}（改）` })).not.toBe(base)
    expect(objectionKey({ ...agreementItem, body: `${agreementItem.body}。` })).not.toBe(base)
    expect(objectionKey({ ...agreementItem, options: ['别的按钮'] })).not.toBe(base)
    expect(objectionKey({ ...agreementItem, agreementVersion: (agreementItem.agreementVersion ?? 0) + 1 })).not.toBe(base)
  })

  it('组队条目的正文变了之后，「你已提出修改。」消失；内容没变时还在', async () => {
    const host = createHookHost()
    await sendOnce(host, teamItem)
    const spec = OBJECTION_TEXT.agreement
    // 内容没变（页面离开再回来，重新挂载）：这一行还在。
    expect(textOf(renderHost(createHookHost(), { spec, itemKey: objectionKey(teamItem) }))).toContain('你已提出修改。')
    // 总管就地改出新方案：键变了，这一行不再显示。
    expect(sentLineOf(objectionKey(revised))).toBeNull()
    expect(textOf(renderHost(createHookHost(), { spec, itemKey: objectionKey(revised) }))).not.toContain('你已提出修改。')
    // 记忆本身没丢：回到旧内容仍能读到。
    expect(sentLineOf(objectionKey(teamItem))).toBe('你已提出修改。')
  })

  it('记忆按键读写', () => {
    rememberSent('k', '你已指出不符。')
    expect(sentLineOf('k')).toBe('你已指出不符。')
    expect(sentLineOf('other')).toBeNull()
  })
})

// ---------- 第 2 节：已经点了确认或提交之后，不能再发「要修改」「都不合适」 ----------

describe('第 2 节：次要按钮与输入框随条目的提交状态', () => {
  const spec = OBJECTION_TEXT.agreement

  it('正在提交：按钮禁用，已展开的输入框、「发送」「取消」都禁用', () => {
    const host = createHookHost()
    const props = { spec, itemKey: 'k' }
    ;(buttonByText(renderHost(host, props), '要修改')!.props.onClick as () => void)()
    ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '写了一半' } })
    const submitting = renderHost(host, { ...props, lock: 'submitting' })
    expect(buttonByText(submitting, '要修改')!.props.disabled).toBe(true)
    expect(inputsOf(submitting)[0]!.props.disabled).toBe(true)
    expect(buttonByText(submitting, '发送')!.props.disabled).toBe(true)
    expect(buttonByText(submitting, '取消')!.props.disabled).toBe(true)
    // 提交失败恢复（lock 回到 none）：草稿还在，可以继续。
    const back = renderHost(host, { ...props, lock: 'none' })
    expect(inputsOf(back)[0]!.props.value).toBe('写了一半')
    expect(buttonByText(back, '发送')!.props.disabled).toBe(false)
  })

  it('已经处理完：按钮不显示，已展开的输入框收起；之前发过的那一行仍显示', async () => {
    const host = createHookHost()
    const props = { spec, itemKey: objectionKey(agreementItem) }
    ;(buttonByText(renderHost(host, props), '要修改')!.props.onClick as () => void)()
    expect(inputsOf(renderHost(host, props))).toHaveLength(1)
    const done = renderHost(host, { ...props, lock: 'done' })
    expect(buttons(done)).toHaveLength(0)
    expect(inputsOf(done)).toHaveLength(0)
    // 先发过修改意见、之后条目才处理完：那一行是主人做过的事，仍显示。
    rememberSent(props.itemKey, spec.pendingLine)
    expect(textOf(renderHost(createHookHost(), { ...props, lock: 'done' }))).toContain('你已提出修改。')
  })

  /** 渲染「待你处理」，返回宿主、属性。 */
  function renderPane(item: InboxItemView, onPick: (card: unknown, option: string, note?: string) => Promise<string | null>): { host: ReturnType<typeof createHookHost>; props: Parameters<typeof InboxPane>[0] } {
    const host = createHookHost()
    const props = {
      inbox: { items: [item] }, loading: false, error: null, onRetry: () => undefined,
      actions: { onPick } as never, busyId: null, onOpenThread: () => undefined, onSendMessage: async () => null,
    } as Parameters<typeof InboxPane>[0]
    return { host, props }
  }
  const lockOf = (tree: unknown): unknown => findElements(tree, ObjectionHost)[0]!.props.lock
  /** 展开 ObjectionHost 的渲染函数，取里面的卡片元素。 */
  const cardOf = (tree: unknown, component: unknown): StubElement => {
    const entry = findElements(tree, ObjectionHost)[0]!
    const rendered = (entry.props.children as (parts: { button: unknown; panel: unknown }) => unknown)({ button: 'BTN', panel: 'PANEL' })
    return findElements(rendered, component as never)[0]!
  }

  it.each<[string, InboxItemView, string]>([
    ['约定确认', agreementItem, '按建议，定了'],
    ['验收', acceptItem, '验收通过'],
  ])('%s：点确认后先是提交中、成功后是处理完；失败恢复', async (_name, item, option) => {
    let release!: (value: string | null) => void
    const pending = new Promise<string | null>(resolve => { release = resolve })
    const onPick = vi.fn(() => pending)
    const { host, props } = renderPane(item, onPick)
    expect(lockOf(host.render(InboxPane, props))).toBe('none')
    // 点确认（经 InboxPane 包过的 onPick）：提交中。
    const first = host.render(InboxPane, props)
    const pick = cardOf(first, InboxCard).props.actions as { onPick: (card: unknown, option: string) => Promise<string | null> }
    const done = pick.onPick(itemToCard(item), option)
    expect(lockOf(host.render(InboxPane, props))).toBe('submitting')
    release(null)
    await done
    expect(lockOf(host.render(InboxPane, props))).toBe('done')

    // 另一次：失败后解锁。
    const failing = renderPane(item, async () => '连接中断')
    const second = failing.host.render(InboxPane, failing.props)
    const failPick = cardOf(second, InboxCard).props.actions as { onPick: (card: unknown, option: string) => Promise<string | null> }
    expect(await failPick.onPick(itemToCard(item), option)).toBe('连接中断')
    expect(lockOf(failing.host.render(InboxPane, failing.props))).toBe('none')
  })

  it('说明卡：点「按所选办法处理」后提交中、成功后处理完；失败恢复', () => {
    const { host, props } = renderPane(escalateItem, async () => null)
    const card = cardOf(host.render(InboxPane, props), EscalationCard)
    const change = card.props.onLockChange as (lock: ObjectionLock) => void
    expect(lockOf(host.render(InboxPane, props))).toBe('none')
    change('submitting')
    expect(lockOf(host.render(InboxPane, props))).toBe('submitting')
    change('done')
    expect(lockOf(host.render(InboxPane, props))).toBe('done')
    change('none')
    expect(lockOf(host.render(InboxPane, props))).toBe('none')
  })

  it('反过来的方向不变：发了修改意见之后，确认按钮仍可点（卡片不忙）', async () => {
    const { host, props } = renderPane(agreementItem, async () => null)
    const entry = findElements(host.render(InboxPane, props), ObjectionHost)[0]!
    await (entry.props.send as (text: string) => Promise<string | null>)('改一下')
    const card = cardOf(host.render(InboxPane, props), InboxCard)
    expect(card.props.busy).toBe(false)
  })
})

// ---------- 第 3 节：发给总管的那句话带上针对哪一条 ----------

describe('第 3 节：话前由界面拼的说明（逐字）', () => {
  /** 在 InboxPane 里取某个条目的发送函数，发一句话，返回 onSendMessage 收到的线程与文字。 */
  async function sentVia(item: InboxItemView, word: string): Promise<[string, string]> {
    const onSendMessage = vi.fn(async () => null)
    const host = createHookHost()
    const tree = host.render(InboxPane, {
      inbox: { items: [item] }, loading: false, error: null, onRetry: () => undefined,
      actions: { onPick: async () => null }, busyId: null, onOpenThread: () => undefined, onSendMessage,
    })
    await (findElements(tree, ObjectionHost)[0]!.props.send as (text: string) => Promise<string | null>)(word)
    return onSendMessage.mock.calls[0] as unknown as [string, string]
  }

  // P74i-m5（第 1 节）改了前提：条目带 agreementTitle 时前缀改为「（关于约定「{标题}」第 {版本号} 版）」（见 p74i-m5-fixes.test.tsx）；
  // 本条保留原来的写法，前提改为「没有约定标题的旧数据」（agreementTitle 为空），断言不变。
  it('约定确认（旧数据，没有约定标题）：（关于{条目标题}）{话}', async () => {
    const item = { ...agreementItem, agreementTitle: null, title: '约定「活动报名页」第 4 版' }
    expect(await sentVia(item, '人数改回 80。')).toEqual([item.botId, '（关于约定「活动报名页」第 4 版）人数改回 80。'])
  })

  it('说明卡：（关于{条目标题}）{话}', async () => {
    const item = { ...escalateItem, title: '活动报名页：第 3 条三轮未通过' }
    expect(await sentVia(item, '这几个办法都不合适，先保留手机号校验。'))
      .toEqual([item.botId, '（关于活动报名页：第 3 条三轮未通过）这几个办法都不合适，先保留手机号校验。'])
  })

  it('组队确认：（关于组队方案）{话}', async () => {
    expect(await sentVia(teamItem, '把第二位换成设计师。')).toEqual([teamItem.botId, '（关于组队方案）把第二位换成设计师。'])
  })

  it('验收：发在这件事自己的主题里，不加说明', async () => {
    expect(await sentVia(acceptItem, '第 3 条不符。')).toEqual([acceptItem.topicId, '第 3 条不符。'])
  })

  it('核心给的真实约定条目（标题「约定第 n 版待你确认：…」，带约定标题）：前缀用约定标题，不再把整句标题塞进括号', async () => {
    // P74i-m5（第 1 节）改了预期：原为 `（关于约定第 2 版待你确认：活动报名页）改一下。`。
    expect(agreementItem.title).toBe('约定第 2 版待你确认：活动报名页')
    expect((await sentVia(agreementItem, '改一下。'))[1]).toBe('（关于约定「活动报名页」第 2 版）改一下。')
  })
})

// ---------- 第 4 节（界面一侧）：提议附言最多 200 个字 ----------

describe('第 4 节：提议附言输入框限制 200 个字', () => {
  it('提议的附言框 maxLength 为 200；审批的备注框不受影响', () => {
    const proposalCard = { ...itemToCard(proposalItem), options: ['接受', '不做'], defaultOption: null }
    const tree = createHookHost().render(InboxCard, { card: proposalCard, actions: { onPick: async () => null }, busy: false })
    const note = inputsOf(tree).find(node => node.props.className === 'ah-card-note')!
    expect(note.props['aria-label']).toBe('附言（可不填）')
    expect(note.props.maxLength).toBe(200)
  })
})

// ---------- 第 5 节 ----------

describe('第 5 节第 1 条：「已追加 N 个回合。」的 N 取自按钮文字', () => {
  it('按钮「再给 8 个回合」写 8；设置覆盖成 12 时写 12；取不出数字时写「已追加回合。」', () => {
    expect(inboxHandledNotice(capItem, '再给 8 个回合')).toBe('已追加 8 个回合。')
    expect(inboxHandledNotice(capItem, '再给 12 个回合')).toBe('已追加 12 个回合。')
    expect(inboxHandledNotice(capItem, '再给一些回合')).toBe('已追加回合。')
    expect(inboxHandledNotice(capItem, '再给')).toBe('已追加回合。')
  })

  it('点「暂停」仍是「已暂停这件事。」', () => {
    expect(inboxHandledNotice(capItem, '暂停')).toBe('已暂停这件事。')
  })
})

describe('第 5 节第 2 条：关掉「编辑员工」弹窗之后还焦点', () => {
  /** 假元素：记录是否被聚焦。 */
  const element = (isConnected: boolean): FocusableLike & { focused: number } => {
    const node = { isConnected, focused: 0, focus() { node.focused += 1 } }
    return node
  }

  it('触发按钮还在：回到触发按钮', () => {
    const opener = element(true)
    const row = element(true)
    expect(restoreEditFocus(opener, 'bot_a', () => row)).toBe('opener')
    expect(opener.focused).toBe(1)
    expect(row.focused).toBe(0)
  })

  it('触发按钮已不在页面上：回到这位员工那一行（用 data-bot-row 选择器找）', () => {
    const opener = element(false)
    const row = element(true)
    const asked: string[] = []
    expect(restoreEditFocus(opener, 'bot_a', selector => { asked.push(selector); return row })).toBe('row')
    expect(asked).toEqual(['[data-bot-row="bot_a"]'])
    expect(opener.focused).toBe(0)
    expect(row.focused).toBe(1)
    // 没有记下触发元素时同样回到那一行。
    expect(restoreEditFocus(null, 'bot_a', () => row)).toBe('row')
  })

  it('都找不到：什么都不做；取元素抛错也不外抛', () => {
    expect(restoreEditFocus(element(false), 'bot_a', () => null)).toBe('none')
    expect(restoreEditFocus(null, 'bot_a', () => { throw new Error('选择器失败') })).toBe('none')
  })

  it('选择器对员工编号里的引号与反斜杠转义', () => {
    expect(botRowSelector('a"b\\c')).toBe('[data-bot-row="a\\"b\\\\c"]')
  })
})

describe('第 5 节第 3 条：?job=b2 的约定确认条目由核心的视图函数生成', () => {
  it('条目带主题编号、约定编号与版本号、两栏标记；标题与正文是核心的写法', () => {
    const item = sampleB2InboxEntry
    expect(item.topicId).toBe('ptp_samplejob2')
    expect(item.agreementId).toBe('agr_samplejob2')
    expect(item.agreementVersion).toBe(4)
    expect(item.agreementJobSplit).toBe(true)
    expect(item.title).toBe('约定第 4 版待你确认：活动报名页')
    // P74i-m5（第 0 步）改了预期：核心 P74r14 起正文只剩「问题：建议」各行，问号去掉，不再带「不会自动按建议处理。……」一句；
    // 原为 '是否限制报名人数？：限 80 人，满额后停止报名\n不会自动按建议处理。你确认前，暂停的部分不会做。'。条目另带 agreementTitle。
    expect(item.body).toBe('是否限制报名人数：限 80 人，满额后停止报名')
    expect(item.agreementTitle).toBe('活动报名页')
    expect(item.options).toEqual(['按建议，定了'])
    expect(item.type).toBe('question')
  })

  it('预览快照与实时生成的条目逐字相同；发给总管的话前带这张约定的标题', () => {
    // P76g 的最小同步：核心的条目视图新增 waitedText（开着满 1 小时才有，界面卡 P76k 才画它）。样例条目的建立时间早于样例时钟的「现在」，
    // 实时生成的条目带这一项，预览快照里没有；除这一项之外两者仍逐字相同。
    const { waitedText, ...live } = sampleB2InboxEntry as InboxItemView & { waitedText?: string }
    expect(waitedText).toMatch(/^已等 \d+ (小时|天)$/)
    expect(JSON.stringify(previewB2InboxEntry)).toBe(JSON.stringify(live))
    expect(objectionOf(sampleB2InboxEntry)).toMatchObject({ threadId: 'b_samplechief', prefix: '（关于约定「活动报名页」第 4 版）' })
  })
})
