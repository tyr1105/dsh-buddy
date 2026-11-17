/**
 * P72e 约定卡的纯逻辑测试：选择与提交参数、印章是否播放、修订行文字、主题楼层、
 * 状态与采纳文字、草图圆圈与连线、总管置顶与占位、待你处理的约定条目。
 *
 * 每条规则至少一个正例一个反例；这里没有任何组件渲染，组件层的测试在 p72e-agreement-card.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AGR_TEXT, adoptionLine, chiefFirst, composerPlaceholder, conceptLinkTexts, initialChoices, isChangedItem, isChiefEntry,
  revisionLineText, roleLineOf, selectedOptionOf, shouldPlayStamp, sketchHasMark, stampDateText, stateLabelOf, submitChoices,
} from '../src/client/logic/agreement.js'
import { cardSubmission, expiryMeaningOf, type CardPayload } from '../src/client/logic/cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { buildTeamTree, type TeamTreeBotInput } from '../src/client/logic/team-tree.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { sampleAgreementV2 } from '../src/shared/fixture-agreement.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import type { AgreementCardView, AgreementRevisionRow, ThreadMessageView } from '../src/shared/views.js'

// itemToCard 在 InboxPane.tsx 里，加载该文件要用到 react：和其他组件测试一样换成 hook 宿主的替身。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 取样例第 2 版的待定项（4 项，建议项都在选项里）。 */
const card: AgreementCardView = sampleAgreementV2

describe('选择：初始取建议项，改一项只影响那一项', () => {
  it('初始选择：每项取建议项', () => {
    const choices = initialChoices(card)
    expect(Object.keys(choices)).toEqual(['fields', 'limit', 'close', 'copy'])
    for (const item of card.pending) expect(choices[item.key]).toBe(item.suggested)
  })

  it('提交参数：用户改了一项后，该项是新选项，其余是建议', () => {
    const picked = { ...initialChoices(card), limit: '限制人数，满额后停止报名' }
    const out = submitChoices(card, picked)
    expect(out.limit).toBe('限制人数，满额后停止报名')
    expect(out.fields).toBe(card.pending[0]!.suggested)
    expect(out.close).toBe('活动开始前 1 小时自动停止')
    expect(out.copy).toBe('你发来现成的文字')
  })

  it('反例：选择里出现不在选项里的脏值、或缺项，一律退回建议项', () => {
    const out = submitChoices(card, { limit: '不存在的选项' })
    expect(out.limit).toBe('不限')
    expect(out.fields).toBe(card.pending[0]!.suggested)
  })

  it('已固定的卡显示 core 记下的 chosen，还在选的卡显示当前选择', () => {
    const item = { ...card.pending[1]!, chosen: '限制人数，满额后停止报名' }
    expect(selectedOptionOf(item, {}, true)).toBe('限制人数，满额后停止报名')
    expect(selectedOptionOf(item, { limit: '不限' }, false)).toBe('不限')
    expect(selectedOptionOf(item, {}, false)).toBe(item.suggested)
  })
})

describe('shouldPlayStamp：只在待确认变已固定那一刻播一次', () => {
  it('正例：pending 变 locked 且未要求减少动效', () => {
    expect(shouldPlayStamp('pending', 'locked', false)).toBe(true)
  })
  it('反例：要求减少动效时不播', () => {
    expect(shouldPlayStamp('pending', 'locked', true)).toBe(false)
  })
  it('反例：挂载时已经是 locked（上一次也是 locked 或没有上一次）不播', () => {
    expect(shouldPlayStamp('locked', 'locked', false)).toBe(false)
    expect(shouldPlayStamp(null, 'locked', false)).toBe(false)
  })
  it('反例：其他状态变化不播', () => {
    expect(shouldPlayStamp('pending', 'superseded', false)).toBe(false)
    expect(shouldPlayStamp('locked', 'replaced', false)).toBe(false)
  })
})

describe('印章日期', () => {
  it('从已固定时间文字里取「月.日」', () => {
    expect(stampDateText({ lockedText: '11月11日 15:39', lockedAt: null })).toBe('11.11')
    expect(stampDateText({ lockedText: '3月5日 09:00', lockedAt: null })).toBe('3.5')
  })
  it('文字取不到时用时间戳；两者都没有为空串', () => {
    expect(stampDateText({ lockedText: null, lockedAt: new Date(2026, 10, 12, 10, 0).getTime() })).toBe('11.12')
    expect(stampDateText({ lockedText: null, lockedAt: null })).toBe('')
  })
})

describe('修订行文字', () => {
  const row = (patch: Partial<AgreementRevisionRow>): AgreementRevisionRow => ({
    no: 2, timeText: '11月11日 15:39', stateLabel: '已固定', text: '报名信息加入「公司名（选填）」', sourceLabel: '来源：你在对齐时的修改', locked: false, ...patch,
  })

  it('拼接：版本、时间、一句话、来源，句末补句号', () => {
    expect(revisionLineText(row({}))).toBe('第 2 版 11月11日 15:39 报名信息加入「公司名（选填）」。来源：你在对齐时的修改。')
  })
  it('已固定的版本带「固定」', () => {
    expect(revisionLineText(row({ locked: true }))).toBe('第 2 版 11月11日 15:39 固定 报名信息加入「公司名（选填）」。来源：你在对齐时的修改。')
  })
  it('一句话自带句号不重复补；来源为空就不写', () => {
    expect(revisionLineText(row({ text: '初稿，未固定。', sourceLabel: '' }))).toBe('第 2 版 11月11日 15:39 初稿，未固定。')
  })
})

describe('主题楼层：有约定时第一条消息不再是主题卡片', () => {
  const message = (id: string, from: string, patch: Partial<ThreadMessageView> = {}): ThreadMessageView => ({
    id, thread: 'ptp_1', from, fromName: from === 'owner' ? '主人' : '总管', fromColor: null, kind: 'chat', text: id, createdAt: 1, timeText: '刚刚', card: null, ...patch,
  })
  const messages = [message('m1', 'owner'), message('m2', 'bot-a', { kind: 'reply' }), message('m3', 'hub', { kind: 'system' })]

  it('正例：有约定时没有 opening，所有消息都是楼层，回复数不算中心旁白', () => {
    const model = buildTopicThread(messages, false, { hasAgreement: true })
    expect(model.opening).toBeNull()
    expect(model.floors.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(model.replyCount).toBe(2)
  })
  it('反例：没有约定时行为不变——第一条主人消息是主题卡片', () => {
    const model = buildTopicThread(messages, false)
    expect(model.opening?.id).toBe('m1')
    expect(model.floors.map(m => m.id)).toEqual(['m2', 'm3'])
    expect(buildTopicThread(messages, false, { hasAgreement: false }).opening?.id).toBe('m1')
  })
})

describe('状态文字与采纳一行', () => {
  const base = { supersededBy: null as number | null, lockedText: null as string | null }
  it('四种状态各有文字', () => {
    expect(stateLabelOf({ ...base, state: 'pending' })).toBe('待你确认')
    expect(stateLabelOf({ ...base, state: 'locked', lockedText: '11月11日 15:39' })).toBe('已固定 11月11日 15:39')
    expect(stateLabelOf({ ...base, state: 'superseded', supersededBy: 2 })).toBe('已由第 2 版取代')
    expect(stateLabelOf({ ...base, state: 'replaced', supersededBy: 3 })).toBe('已被第 3 版替换')
  })
  it('采纳一行：有 rapport 带累计，没有则省略后半句；没有 adoption 不显示', () => {
    expect(adoptionLine({ adoption: { adopted: 3, total: 4 }, rapport: { adopted: 17, total: 20 } }))
      .toBe('这次你采纳了总管 4 条建议中的 3 条。累计默契度 17 / 20。')
    expect(adoptionLine({ adoption: { adopted: 3, total: 4 }, rapport: null })).toBe('这次你采纳了总管 4 条建议中的 3 条。')
    expect(adoptionLine({ adoption: null, rapport: { adopted: 17, total: 20 } })).toBeNull()
  })
})

describe('改动标记与草图', () => {
  it('changed 或 added 任一为真算改动处', () => {
    expect(isChangedItem({ changed: true })).toBe(true)
    expect(isChangedItem({ added: true })).toBe(true)
    expect(isChangedItem({ changed: false, added: false })).toBe(false)
  })
  it('草图有圆圈数字才为真', () => {
    expect(sketchHasMark(card.sketch.value)).toBe(true)
    expect(sketchHasMark({ layout: 'flow', steps: [{ text: '收到' }] })).toBe(false)
    expect(sketchHasMark({ layout: 'concept', nodes: [{ id: 'a', text: 'A', mark: 2 }] })).toBe(true)
  })
  it('概念草图连线写成「A → B：文字」，节点对不上退回 id', () => {
    const links = conceptLinkTexts({
      layout: 'concept', nodes: [{ id: 'a', text: '访客' }, { id: 'b', text: '报名页' }],
      links: [{ from: 'a', to: 'b', text: '填写' }, { from: 'b', to: 'zz' }],
    })
    expect(links).toEqual(['访客 → 报名页：填写', '报名页 → zz'])
  })
})

describe('总管置顶、角色行与占位', () => {
  const bot = (id: string, role: string, lifecycle = 'active', lastActiveAt = 100): TeamTreeBotInput & { role: string; roleLabel: string } => ({
    id, name: id, color: '#888', initials: id.slice(0, 1), lifecycle: lifecycle as TeamTreeBotInput['lifecycle'], activity: 'resting',
    unread: 0, waitingOwner: false, lastActiveAt, role, roleLabel: role === 'chief' ? '总管' : '调研',
  })

  it('正例：总管即使最后活跃时间最早，也排在第一行；其余相对顺序不变', () => {
    const list = [bot('a', 'researcher', 'active', 300), bot('b', 'researcher', 'active', 200), bot('chief', 'chief', 'active', 1)]
    expect(chiefFirst(list).map(item => item.id)).toEqual(['chief', 'a', 'b'])
  })
  it('反例：没有总管时顺序不变；退役的总管不置顶', () => {
    const list = [bot('a', 'researcher'), bot('b', 'researcher')]
    expect(chiefFirst(list).map(item => item.id)).toEqual(['a', 'b'])
    const retired = [bot('a', 'researcher'), bot('chief', 'chief', 'retired')]
    expect(chiefFirst(retired).map(item => item.id)).toEqual(['a', 'chief'])
    expect(isChiefEntry(retired[1]!)).toBe(false)
  })
  it('团队树排序同样让总管排第一，没有总管时排序不变', () => {
    const withChief = buildTeamTree({
      office: { workingCount: 0, waitingCount: 0, blockedCount: 0 }, projects: [],
      bots: [bot('a', 'researcher', 'active', 300), bot('chief', 'chief', 'active', 1)],
    })
    expect(withChief.teammateGroup.bots.map(node => node.botId)).toEqual(['chief', 'a'])
    const without = buildTeamTree({
      office: { workingCount: 0, waitingCount: 0, blockedCount: 0 }, projects: [],
      bots: [bot('a', 'researcher', 'active', 100), bot('b', 'researcher', 'active', 300)],
    })
    expect(without.teammateGroup.bots.map(node => node.botId)).toEqual(['b', 'a'])
  })
  it('角色行：总管写「有事先找我」，其他沿用角色标签', () => {
    expect(roleLineOf(bot('chief', 'chief'))).toBe(AGR_TEXT.chiefRole)
    expect(roleLineOf(bot('a', 'researcher'))).toBe('调研')
  })
  it('输入框占位：总管用新句子，其他员工仍是「向 名字 发送消息…」', () => {
    expect(composerPlaceholder({ chief: true, name: '总管' })).toBe('交代一件事。需要你拿主意的地方，总管会先和你对齐再开工。')
    expect(composerPlaceholder({ chief: false, name: '探路' })).toBe('向 探路 发送消息…')
  })
})

describe('待你处理里的约定条目', () => {
  const agreementItem = fixtureInbox.items.find(item => item.agreementId !== undefined && item.agreementId !== null)!
  const plainItem = fixtureInbox.items.find(item => item.type === 'question' && !item.agreementId)!

  it('itemToCard 带上 agreementId；普通条目不带', () => {
    expect(itemToCard(agreementItem).agreementId).toBe(agreementItem.agreementId)
    expect('agreementId' in itemToCard(plainItem)).toBe(false)
  })
  it('有效期一行固定写「不会自动按建议处理。你确认前不会开工。」，普通提问照旧', () => {
    expect(expiryMeaningOf(itemToCard(agreementItem))).toBe('不会自动按建议处理。你确认前不会开工。')
    // 普通提问不受影响：视图自带的后果说明原样保留，不会被换成约定那一句。
    expect(expiryMeaningOf(itemToCard(plainItem))).toBe('周五 09:00 按默认处理')
  })
  it('点击仍走 answerInbox，原样回传选项', () => {
    const submission = cardSubmission(itemToCard(agreementItem) as CardPayload, '按建议，定了')
    expect(submission).toEqual({ name: 'answerInbox', input: { id: agreementItem.id, answer: '按建议，定了' } })
  })
})
