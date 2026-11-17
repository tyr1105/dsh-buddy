/**
 * P73e 一致性测试（第一块的教训）：样例数据里的三问视图、组队卡视图必须由 core 的视图函数生成，
 * 并且符合 core 导出的视图 schema。手写的样例与真实数据的约定不一致时，预览和测试都发现不了——
 * 这里把这一层补上：
 * 1. 样例里每个三问视图、组队卡视图都通过 core 的 zod 视图 schema；
 * 2. 样例卡片的四句性格与 core 的 mbtiBehaviorLines 逐字相同；
 * 3. fixture-team.ts 的源码里没有手写的视图字段（确认按钮文字、在册人数文字等）；
 * 4. 线程里、待你处理里的样例确实带着这些视图。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TeamCardViewSchema, TeamQuestionViewSchema, mbtiBehaviorLines, teamConfirmLabel } from '@agent-hub/core'
import {
  SAMPLE_ADDITION_PROPOSAL_ID, sampleAdditionProposal, sampleConfirmedProposal, sampleInitialProposal, sampleQuestionViews, sampleSetup,
  sampleViewOfProposal,
} from '../src/shared/fixture-team.js'
import { fixtureInbox, fixtureThreads } from '../src/shared/fixtures.js'
import type { TeamCardView, TeamQuestionView } from '../src/shared/views.js'

const chiefThread = fixtureThreads.find(thread => thread.threadId === 'bot-zongguan')!
const cardViews = (): TeamCardView[] => chiefThread.messages.flatMap(message => message.teamCard ? [message.teamCard] : [])
const questionViews = (): TeamQuestionView[] => chiefThread.messages.flatMap(message => message.teamQuestion ? [message.teamQuestion] : [])

describe('样例视图符合 core 的视图 schema', () => {
  it('三问：三个问题视图都通过 TeamQuestionViewSchema，且前两问已答、第三问是当前问', () => {
    const views = sampleQuestionViews(sampleSetup)
    for (const view of views) expect(() => TeamQuestionViewSchema.parse(view)).not.toThrow()
    expect(views.map(view => view.answered)).toEqual([true, true, false])
    expect(views.map(view => view.current)).toEqual([false, false, true])
    expect(views[1]!.folderPick).toBe(true)
  })

  it('组队卡：三张样例卡都通过 TeamCardViewSchema（待确认的初始卡、确认后只读的卡、按需加人的卡）', () => {
    for (const proposal of [sampleInitialProposal, sampleConfirmedProposal, sampleAdditionProposal]) {
      expect(() => TeamCardViewSchema.parse(sampleViewOfProposal(proposal))).not.toThrow()
    }
  })

  it('线程里摆出来的视图也都通过 schema，而且与现生成的视图深相等（样例没有被手改过）', () => {
    expect(questionViews()).toHaveLength(3)
    expect(cardViews()).toHaveLength(3)
    for (const view of questionViews()) expect(() => TeamQuestionViewSchema.parse(view)).not.toThrow()
    for (const view of cardViews()) expect(() => TeamCardViewSchema.parse(view)).not.toThrow()
    expect(questionViews()).toEqual(sampleQuestionViews(sampleSetup))
    expect(cardViews().map(view => view.proposalId)).toEqual([sampleInitialProposal.id, sampleConfirmedProposal.id, sampleAdditionProposal.id])
  })

  it('反例：schema 是严格的，多出手写字段的视图会被拒绝', () => {
    const view = sampleViewOfProposal(sampleInitialProposal)
    expect(() => TeamCardViewSchema.parse({ ...view, handWritten: '手写字段' })).toThrow()
  })
})

describe('样例卡片的内容取自 core', () => {
  it('每位候选的四句性格与 core 的 mbtiBehaviorLines 逐字相同', () => {
    for (const view of cardViews()) {
      for (const candidate of view.candidates) {
        const expected = mbtiBehaviorLines(candidate.personality.type as never)!.map(line => ({ code: line.code, text: line.text }))
        expect(candidate.personality.lines).toEqual(expected)
        expect(candidate.personality.lines).toHaveLength(4)
      }
    }
  })

  it('确认按钮文字、在册人数文字都出自 core：按钮与 teamConfirmLabel 一致', () => {
    const initial = sampleViewOfProposal(sampleInitialProposal)
    expect(initial.confirmLabel).toBe(teamConfirmLabel(sampleInitialProposal))
    expect(initial.confirmLabel).toBe('确认，3 位入职')
    expect(initial.footer.rosterText).toBe('入职后在册 4 / 6 位（含总管）')
    expect(sampleViewOfProposal(sampleAdditionProposal).confirmLabel).toBe('确认入职，接手这件事')
  })

  it('设计稿 A3：设计师的性格已由建议的 ISFJ 改为 ESFJ，视图标「已改」并给出恢复文字', () => {
    const designer = sampleViewOfProposal(sampleInitialProposal).candidates[1]!
    expect(designer.personality.type).toBe('ESFJ')
    expect(designer.personality.changed).toBe(true)
    expect(designer.personality.restoreText).toBe('恢复为建议值 ISFJ')
  })

  it('设计稿 A4：确认后的卡带来历，被去掉的写「你选了不要」', () => {
    const view = sampleViewOfProposal(sampleConfirmedProposal)
    expect(view.state).toBe('confirmed')
    expect(view.candidates.map(candidate => candidate.historyText)).toEqual([
      '由「工程师」改名', '你选了不要', '模型由建议的「轻档」改为「标准档」',
    ])
  })
})

describe('样例里的待你处理与源码纪律', () => {
  it('收件箱有一条按需加人的组队条目：带组队卡 id，只有一个按钮，没有默认处理和到期', () => {
    const item = fixtureInbox.items.find(entry => entry.teamProposalId === SAMPLE_ADDITION_PROPOSAL_ID)!
    expect(item).toBeDefined()
    expect(item.options).toEqual([sampleViewOfProposal(sampleAdditionProposal).confirmLabel])
    expect(item.defaultOption).toBeNull()
    expect(item.expiresText).toBeNull()
  })

  it('fixture-team.ts 源码里没有手写的视图字段：确认按钮、在册人数、卡下说明都不在源码里', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/shared/fixture-team.ts', import.meta.url)), 'utf8')
    // 这些字段只能由 core 的 teamCardView 生成。
    for (const forbidden of ['confirmLabel', 'rosterText', 'idleText', 'tokenText', 'stateLabel', 'restoreText', 'historyText', '确认，', '入职后在册']) {
      expect(source, `不应手写：${forbidden}`).not.toContain(forbidden)
    }
    // 视图一律经 core 的两个函数生成。
    expect(source).toContain('teamCardView(')
    expect(source).toContain('teamQuestionView(')
  })
})
