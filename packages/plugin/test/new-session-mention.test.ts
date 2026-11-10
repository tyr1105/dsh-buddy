/**
 * 新会话页 @ 队友规则的单元测试（P57）。
 *
 * 钉住主人定的口径：队友模式的新会话，没选项目时 @ 写在最前面才列队友，选中后发给它本人；
 * 选了项目时写在哪都列，走项目路线；对话模式和进行中的会话完全不受影响。
 */
import { describe, expect, it } from 'vitest'
import {
  directHint,
  mentionRoute,
  mentionToken,
  mentionableTeammates,
  teammateFromToken,
  type MentionSituation,
} from '../src/client/logic/new-session-mention.js'
import type { BotCard } from '../src/shared/views.js'

/** 只造规则用得到的字段，其余类型上强转，测试不依赖无关字段。 */
function bot(overrides: Partial<BotCard> & Pick<BotCard, 'id' | 'name'>): BotCard {
  return { roleLabel: '调研', lifecycle: 'active', archived: false, color: '#123456', initials: '小', ...overrides } as BotCard
}

const situation: MentionSituation = { teamMode: true, blankSession: true, quoted: false, position: 'leading', projectSelected: false }

describe('@ 走哪条路', () => {
  it('没选项目、写在最前面：发给本人', () => {
    expect(mentionRoute(situation)).toBe('direct')
  })

  it('没选项目、写在句中：不列（宿主只允许开头的标记接管发送）', () => {
    expect(mentionRoute({ ...situation, position: 'inline' })).toBeNull()
  })

  it('选了项目：走项目路线，写在句中也列', () => {
    expect(mentionRoute({ ...situation, projectSelected: true })).toBe('project')
    expect(mentionRoute({ ...situation, projectSelected: true, position: 'inline' })).toBe('project')
  })

  it('对话模式保持 DSH 原样', () => {
    expect(mentionRoute({ ...situation, teamMode: false })).toBeNull()
    expect(mentionRoute({ ...situation, teamMode: false, projectSelected: true })).toBeNull()
  })

  it('进行中的会话不插手：@ 不会把正在聊的话转走', () => {
    expect(mentionRoute({ ...situation, blankSession: false })).toBeNull()
  })

  it('@" 是宿主约定的搜文件写法', () => {
    expect(mentionRoute({ ...situation, quoted: true })).toBeNull()
  })
})

describe('能被 @ 的队友', () => {
  const bots = [
    bot({ id: 'b_1', name: '小李', roleLabel: '调研' }),
    bot({ id: 'b_2', name: '老王', roleLabel: '执行' }),
    bot({ id: 'b_3', name: '退休员', lifecycle: 'retired' }),
    bot({ id: 'b_4', name: '已归档', archived: true }),
  ]

  it('已退役、已归档的不列', () => {
    expect(mentionableTeammates(bots, '').map(item => item.id)).toEqual(['b_1', 'b_2'])
  })

  it('按名字或执行风格搜索', () => {
    expect(mentionableTeammates(bots, '小').map(item => item.id)).toEqual(['b_1'])
    expect(mentionableTeammates(bots, '执行').map(item => item.id)).toEqual(['b_2'])
  })

  it('搜不到时为空', () => {
    expect(mentionableTeammates(bots, '不存在')).toEqual([])
  })

  it('从标签文字反查队友要名字完全相等', () => {
    expect(teammateFromToken(bots, '@小李 ')?.id).toBe('b_1')
    expect(teammateFromToken(bots, '@小')).toBeUndefined()
    expect(teammateFromToken(bots, '小李')).toBeUndefined()
  })

  it('已归档的队友不能靠标签文字找回来', () => {
    expect(teammateFromToken(bots, '@已归档')).toBeUndefined()
  })
})

describe('标签', () => {
  it('带尾随空格，后面的字才算正文', () => {
    expect(mentionToken('小李')).toBe('@小李 ')
  })

  it('提示里说清要发给谁', () => {
    expect(directHint('小李')).toContain('小李')
  })
})
