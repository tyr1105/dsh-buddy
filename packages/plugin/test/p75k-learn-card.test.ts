/**
 * P75k：学习选会话的提问卡（任务卡第 8 节、派活说明第一节第 4 条）。
 * 要员工学某段会话的做法，改为对总管说；总管在私聊里用一张提问卡请主人选会话。卡片视图带 learnRunId（core 给）。
 * 覆盖：正文按行显示（第二行说明选中的会话交给谁阅读）；选项整行可点、会话标题原样显示；没有默认项、没有到期说明、
 * 没有自由文本；点选项走现有的回答入口（cardSubmission → answerInbox，core 已按 learn: 分流）；
 * 普通提问卡不受影响；宿主路由 chooseLearnSession 把 runId 与 option 交给 core。
 */
import { describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { cardSubmission, expiryMeaningOf, type CardPayload } from '../src/client/logic/cards.js'
import { dispatchCommand } from '../src/host/real-hub.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

/** 与 core 建这张卡时写的形状一致：标题「{员工}要学的会话」，正文两行，选项是会话标题，无默认、不到期。 */
const learnCard: CardPayload = {
  inboxId: 'i_samplelearn', approvalId: null, type: 'question', status: 'open', title: '林舟要学的会话',
  body: '以后纪要都照周会那份的写法整理。\n选中的那段会话的内容会交给林舟和核对的同事阅读，其中像密钥的内容会先隐去。',
  options: ['周会记录整理（11月22日）', '名单整理（11月19日）', '纪要模板讨论（11月18日）'],
  defaultOption: null, answer: null, expiresAt: null, expiresText: null, learnRunId: 'sr_samplelearn',
}

describe('学习选会话的提问卡', () => {
  it('正文按行显示：第一行是主人交代的话，第二行说明选中的会话交给谁阅读', () => {
    const tree = createHookHost().render(InboxCard, { card: learnCard, actions: { onPick: async () => null }, busy: false })
    const body = findElements(tree, 'div').find(row => String(row.props.className) === 'ah-card-body')!
    const lines = (Array.isArray(body.props.children) ? body.props.children : [body.props.children]) as StubElement[]
    expect(lines.map(line => textOf(line))).toEqual([
      '以后纪要都照周会那份的写法整理。',
      '选中的那段会话的内容会交给林舟和核对的同事阅读，其中像密钥的内容会先隐去。',
    ])
  })

  it('选项整行可点、会话标题原样显示；没有默认项标记、没有到期说明、没有自由文本输入', () => {
    const tree = createHookHost().render(InboxCard, { card: learnCard, actions: { onPick: async () => null }, busy: false })
    const options = findElements(tree, 'button').filter(button => String(button.props.className).includes('ah-card-option-row'))
    expect(options.map(button => textOf(button))).toEqual(learnCard.options)
    expect(JSON.stringify(tree)).not.toContain('（默认）')
    expect(expiryMeaningOf(learnCard)).toBeNull()
    expect(findElements(tree, 'input')).toHaveLength(0)
    expect(findElements(tree, 'div').some(row => String(row.props.className).includes('ah-card-options-rows'))).toBe(true)
  })

  it('点选项：把原样的选项文字交给回答入口；线程里的学习卡按 cardSubmission 分流成 chooseLearnSession（P75r7 B6）', async () => {
    const picked: Array<[string, string]> = []
    const onPick = async (card: CardPayload, option: string): Promise<string | null> => { picked.push([card.inboxId, option]); return null }
    const host = createHookHost()
    const view = (): unknown => host.render(InboxCard, { card: learnCard, actions: { onPick }, busy: false })
    ;(findElements(view(), 'button').find(button => textOf(button) === '名单整理（11月19日）')!.props.onClick as () => void)()
    await flush()
    expect(picked).toEqual([['i_samplelearn', '名单整理（11月19日）']])
    expect(cardSubmission(learnCard, '名单整理（11月19日）')).toEqual({ name: 'chooseLearnSession', input: { runId: 'sr_samplelearn', option: '名单整理（11月19日）' } })
  })

  it('普通提问卡不受影响：仍有自由文本输入，正文是一整段，默认项照旧标注', () => {
    const plain: CardPayload = { ...learnCard, inboxId: 'i_plain', learnRunId: undefined, body: '一句话。', options: ['可以', '不行'], defaultOption: '可以' }
    const tree = createHookHost().render(InboxCard, { card: plain, actions: { onPick: async () => null }, busy: false })
    expect(findElements(tree, 'input')).toHaveLength(1)
    expect(textOf(tree)).toContain('可以（默认）')
    expect(findElements(tree, 'p').some(row => String(row.props.className) === 'ah-card-body')).toBe(true)
  })

  it('宿主路由 chooseLearnSession：runId 与 option 原样交给 core；缺参数是中文错误、不进 core', async () => {
    const calls: unknown[] = []
    const api = { chooseLearnSession: async (input: unknown) => { calls.push(input); return { ok: true, data: { runId: 'sr_samplelearn' } } } } as never
    expect(await dispatchCommand(api, 'chooseLearnSession', { runId: 'sr_samplelearn', option: '周会记录整理（11月22日）', extra: 1 })).toMatchObject({ ok: true })
    expect(calls).toEqual([{ runId: 'sr_samplelearn', option: '周会记录整理（11月22日）' }])
    expect(await dispatchCommand(api, 'chooseLearnSession', { runId: 'sr_samplelearn' })).toEqual({ ok: false, error: 'option：缺少这一项' })
    expect(calls).toHaveLength(1)
  })
})
