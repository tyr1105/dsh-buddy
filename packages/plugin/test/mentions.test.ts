/**
 * 项目会话 @ 队友规则测试（P37）。
 *
 * 为什么单测：@ 只允许出现在项目工作会话，候选名单必须是「项目成员 ∩ 在册队友」
 * 且排除本人；这些过滤条件只要错一条，主人就会 @ 到一个不存在或已退役的人。
 * 插入规则则决定光标落点和空格，错了会让整句话粘成一团。
 */
import { describe, expect, it } from 'vitest'
import type { BotCard, ProjectMemberView, ProjectViewRow } from '../src/shared/views.js'
import { insertMention, mentionMembers } from '../src/client/logic/mentions.js'

/** 造一位队友，只覆盖 @ 规则关心的字段。 */
function bot(id: string, patch: Partial<BotCard> = {}): BotCard {
  return {
    id,
    name: id,
    role: 'researcher',
    roleLabel: '调研',
    color: '#6366f1',
    initials: id.slice(0, 1),
    lifecycle: 'active',
    lifecycleLabel: '在册',
    activity: 'resting',
    activityLabel: '待命',
    activityText: '',
    nextThinkText: '',
    lastOutcome: null,
    lastOutcomeLabel: null,
    lastActiveText: null,
    unread: 0,
    todayThinks: 0,
    todayBudget: 0,
    todayTokens: 0,
    waitingOwner: false,
    ...patch,
  }
}

/** 造一个项目行：@ 规则只读 members，其余字段用断言绕过（本文件不测项目渲染）。 */
function row(members: ProjectMemberView[]): ProjectViewRow {
  return { members } as unknown as ProjectViewRow
}

const member = (botId: string, invalid = false): ProjectMemberView => ({ botId, name: invalid ? null : botId, invalid })

describe('mentionMembers：项目成员 ∩ 在册队友', () => {
  it('正例：按项目成员顺序列出有效队友', () => {
    const list = mentionMembers(
      row([member('bot-a'), member('bot-b')]),
      [bot('bot-b', { name: '巡检员' }), bot('bot-a', { name: '探路' })],
      'bot-self',
    )
    expect(list.map(m => m.botId)).toEqual(['bot-a', 'bot-b'])
    expect(list.map(m => m.name)).toEqual(['探路', '巡检员'])
  })

  it('反例：失效成员、已退役队友、不在册队友都不出现', () => {
    const list = mentionMembers(
      row([member('bot-gone', true), member('bot-retired'), member('bot-unknown'), member('bot-ok')]),
      [bot('bot-retired', { lifecycle: 'retired' }), bot('bot-ok')],
      'bot-self',
    )
    expect(list.map(m => m.botId)).toEqual(['bot-ok'])
  })

  it('排除正在对话的队友本人（@ 自己没有意义）', () => {
    const list = mentionMembers(row([member('bot-a'), member('bot-b')]), [bot('bot-a'), bot('bot-b')], 'bot-a')
    expect(list.map(m => m.botId)).toEqual(['bot-b'])
  })

  it('成员名单重复时只保留第一次出现', () => {
    const list = mentionMembers(row([member('bot-a'), member('bot-a'), member('bot-b')]), [bot('bot-a'), bot('bot-b')], 'bot-self')
    expect(list.map(m => m.botId)).toEqual(['bot-a', 'bot-b'])
  })

  it('反例：项目没有成员时返回空数组（界面据此不渲染 @ 入口）', () => {
    expect(mentionMembers(row([]), [bot('bot-a')], 'bot-a')).toEqual([])
  })
})

describe('insertMention：插入 @名字 并给出新光标位置', () => {
  it('空文本：直接插入，不补前导空格', () => {
    expect(insertMention('', 0, 0, '巡检员')).toEqual({ text: '@巡检员', caret: 4 })
  })

  it('前面紧挨着字：补一个空格，避免「帮我@巡检员」', () => {
    const result = insertMention('帮我', 2, 2, '巡检员')
    expect(result.text).toBe('帮我 @巡检员')
    expect(result.caret).toBe(result.text.length)
  })

  it('后面紧挨着字：补一个空格，避免「@巡检员看一下」粘成词', () => {
    const result = insertMention('看一下', 0, 0, '巡检员')
    expect(result.text).toBe('@巡检员 看一下')
    // 光标落在补出的空格之后（「看一下」之前）：继续打字不会和 @名字 粘在一起。
    expect(result.caret).toBe('@巡检员 '.length)
  })

  it('前后已有空白：不重复补空格', () => {
    expect(insertMention('帮我 看 ', 3, 3, '巡检员').text).toBe('帮我 @巡检员 看 ')
  })

  it('有选区时替换选中的文字，光标落在插入内容之后', () => {
    const result = insertMention('请 张三 看一下', 2, 5, '巡检员')
    expect(result.text).toBe('请 @巡检员 看一下')
    // 光标在「看一下」之前（含补出的尾随空格），原句后半段保持不变。
    expect(result.caret).toBe('请 @巡检员 '.length)
  })

  it('越界的选区按文本长度收口，不抛错', () => {
    expect(insertMention('好', 99, 120, '巡检员').text).toBe('好 @巡检员')
  })
})
