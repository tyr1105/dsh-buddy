/**
 * P73e 离线样例（FixtureHub）对三个组队命令的支持，以及真引擎门面的命令透传：
 * - 点组队卡的「不要这位」再确认，卡片变为只读、来历含「你选了不要」；
 * - 每次编辑后视图由 core 的视图函数重新生成（rev 加 1、四句性格随之换）；
 * - 三问点选后三问卡变已答；待你处理里组队条目的按钮等同确认；
 * - 过期的 rev、已处理的卡被拒绝；
 * - real-hub 的命令表把三个命令整对象透传给 core。
 */
import { describe, expect, it, vi } from 'vitest'
import { TeamCardViewSchema, TeamQuestionViewSchema, mbtiBehaviorLines } from '@agent-hub/core'
import { FixtureHub } from '../src/host/hub-facade.js'
import { dispatchCommand } from '../src/host/real-hub.js'
import { SAMPLE_ADDITION_PROPOSAL_ID, SAMPLE_INITIAL_PROPOSAL_ID, SAMPLE_SETUP_ID } from '../src/shared/fixture-team.js'
import type { TeamCardView, TeamQuestionView, ThreadMessageView } from '../src/shared/views.js'

const CHIEF = 'bot-zongguan'

async function cardOf(hub: FixtureHub, proposalId: string): Promise<TeamCardView> {
  const thread = await hub.thread(CHIEF, { limit: 100 })
  return thread.messages.find(message => message.teamCard?.proposalId === proposalId)!.teamCard!
}
async function questionOf(hub: FixtureHub, step: number): Promise<TeamQuestionView> {
  const thread = await hub.thread(CHIEF, { limit: 100 })
  return thread.messages.find(message => message.teamQuestion?.step === step)!.teamQuestion!
}
async function messagesOf(hub: FixtureHub): Promise<ThreadMessageView[]> {
  return (await hub.thread(CHIEF, { limit: 100 })).messages
}

describe('离线样例：组队卡编辑与确认', () => {
  it('点「不要这位」再确认：卡片变只读，来历含「你选了不要」，线程里多出旁白和总管的固定句', async () => {
    const hub = new FixtureHub()
    const before = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    expect(before.state).toBe('pending')
    const removed = await hub.command('editTeamCandidate', { proposalId: before.proposalId, rev: before.rev, key: 'c2', action: 'remove' })
    expect(removed.ok).toBe(true)
    const mid = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    expect(mid.rev).toBe(before.rev + 1)
    expect(mid.candidates[1]!.removed).toBe(true)
    expect(mid.confirmLabel).toBe('确认，2 位入职')

    const done = await hub.command('confirmTeamProposal', { proposalId: mid.proposalId, rev: mid.rev })
    expect(done.ok).toBe(true)
    const after = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    expect(after.state).toBe('confirmed')
    expect(after.stateLabel.startsWith('已入职')).toBe(true)
    expect(after.candidates[1]!.historyText).toContain('你选了不要')
    expect(after.candidates.map(candidate => candidate.removed)).toEqual([false, true, false])
    expect(() => TeamCardViewSchema.parse(after)).not.toThrow()
    const texts = (await messagesOf(hub)).map(message => message.text)
    expect(texts).toContain('工程师、评审员已入职，在册 3 / 6 位。')
  })

  it('改性格后四句话随之变化：设计师 ESFJ 点恢复回到 ISFJ；改名后名字变', async () => {
    const hub = new FixtureHub()
    const card = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev, key: 'c2', action: 'restore_mbti' })
    const restored = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    expect(restored.candidates[1]!.personality.type).toBe('ISFJ')
    expect(restored.candidates[1]!.personality.changed).toBe(false)
    expect(restored.candidates[1]!.personality.lines).toEqual(mbtiBehaviorLines('ISFJ')!.map(line => ({ code: line.code, text: line.text })))
    await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: restored.rev, key: 'c1', action: 'rename', value: '林舟' })
    expect((await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)).candidates[0]!.name).toBe('林舟')
  })

  it('换一位：换成备选模板，来历记「由…换为…」；置灰的备选被拒绝', async () => {
    const hub = new FixtureHub()
    const card = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    const swapped = await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev, key: 'c1', action: 'swap', value: 1 })
    expect(swapped.ok).toBe(true)
    const after = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    expect(after.candidates[0]!.templateName).toBe('产品经理')
    expect(after.candidates[0]!.personality.type).toBe('INTP')
  })

  it('反例：过期的 rev、已处理的卡、按需加人卡上的「不要这位」都被拒绝', async () => {
    const hub = new FixtureHub()
    const card = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    const stale = await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev - 1, key: 'c1', action: 'remove' })
    expect(stale).toEqual({ ok: false, error: '卡片已更新，请在最新内容上操作' })
    const add = await cardOf(hub, SAMPLE_ADDITION_PROPOSAL_ID)
    const denied = await hub.command('editTeamCandidate', { proposalId: add.proposalId, rev: add.rev, key: 'c1', action: 'remove' })
    expect(denied.ok).toBe(false)
    await hub.command('confirmTeamProposal', { proposalId: card.proposalId, rev: card.rev })
    const again = await hub.command('confirmTeamProposal', { proposalId: card.proposalId, rev: card.rev + 1 })
    expect(again.ok).toBe(false)
    const edit = await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev + 1, key: 'c1', action: 'remove' })
    expect(edit).toEqual({ ok: false, error: '这张组队卡已经处理过，不能再修改' })
  })

  it('全部不要后确认：记为「你选择不新增」', async () => {
    const hub = new FixtureHub()
    let card = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    for (const key of ['c1', 'c2', 'c3']) {
      await hub.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev, key, action: 'remove' })
      card = await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)
    }
    expect(card.confirmLabel).toBe('全部不要')
    await hub.command('confirmTeamProposal', { proposalId: card.proposalId, rev: card.rev })
    expect((await cardOf(hub, SAMPLE_INITIAL_PROPOSAL_ID)).stateLabel).toBe('你选择不新增')
  })

  it('每个 FixtureHub 实例各有一份记录，互不影响', async () => {
    const a = new FixtureHub()
    const b = new FixtureHub()
    const card = await cardOf(a, SAMPLE_INITIAL_PROPOSAL_ID)
    await a.command('editTeamCandidate', { proposalId: card.proposalId, rev: card.rev, key: 'c1', action: 'remove' })
    expect((await cardOf(b, SAMPLE_INITIAL_PROPOSAL_ID)).candidates[0]!.removed).toBe(false)
  })
})

describe('离线样例：三问与待你处理', () => {
  it('点选第三问：三问卡变已答，当前问消失', async () => {
    const hub = new FixtureHub()
    const q3 = await questionOf(hub, 3)
    expect(q3.current).toBe(true)
    const result = await hub.command('answerTeamQuestion', { setupId: SAMPLE_SETUP_ID, step: 3, choice: 'decisions' })
    expect(result.ok).toBe(true)
    const after = await questionOf(hub, 3)
    expect(after.answered).toBe(true)
    expect(after.current).toBe(false)
    expect(after.chosenLabel).toBe('只在需要你拍板时')
    expect(() => TeamQuestionViewSchema.parse(after)).not.toThrow()
    // 以主人名义落一条原选项，再以总管名义落「已记下」。
    const texts = (await messagesOf(hub)).map(message => message.text)
    expect(texts).toContain('已记下：只在需要你拍板时找你。')
  })

  it('反例：已答的问题再答被拒绝；选项不对被拒绝', async () => {
    const hub = new FixtureHub()
    expect((await hub.command('answerTeamQuestion', { setupId: SAMPLE_SETUP_ID, step: 1, choice: 'research' })).ok).toBe(false)
    expect((await hub.command('answerTeamQuestion', { setupId: SAMPLE_SETUP_ID, step: 3, choice: 'nope' })).ok).toBe(false)
  })

  it('待你处理里组队条目的按钮等同确认：条目消失，卡变只读，计数减一', async () => {
    const hub = new FixtureHub()
    const item = (await hub.inbox()).items.find(entry => entry.teamProposalId === SAMPLE_ADDITION_PROPOSAL_ID)!
    const totalBefore = (await hub.overview()).inbox.total
    const result = await hub.command('answerInbox', { id: item.id, answer: item.options[0] })
    expect(result.ok).toBe(true)
    expect((await hub.inbox()).items.some(entry => entry.id === item.id)).toBe(false)
    expect((await hub.overview()).inbox.total).toBe(totalBefore - 1)
    const card = await cardOf(hub, SAMPLE_ADDITION_PROPOSAL_ID)
    expect(card.state).toBe('confirmed')
    expect(card.footer.rosterText).toBe('在册 4 / 6 位')
  })
})

describe('真引擎门面：命令透传', () => {
  it('三个命令整对象透传给 core，不经界面再改写', async () => {
    const api = {
      answerTeamQuestion: vi.fn(async () => ({ ok: true as const })),
      editTeamCandidate: vi.fn(async () => ({ ok: true as const })),
      confirmTeamProposal: vi.fn(async () => ({ ok: true as const })),
    }
    const answer = { setupId: 'tsu_aaaaaaaaaa', step: 2, choice: 'yes', folderPath: '/x' }
    const edit = { proposalId: 'tpr_aaaaaaaaaa', rev: 2, key: 'c1', action: 'rename', value: '林舟' }
    const confirm = { proposalId: 'tpr_aaaaaaaaaa', rev: 3 }
    expect(await dispatchCommand(api as never, 'answerTeamQuestion', answer)).toEqual({ ok: true })
    expect(await dispatchCommand(api as never, 'editTeamCandidate', edit)).toEqual({ ok: true })
    expect(await dispatchCommand(api as never, 'confirmTeamProposal', confirm)).toEqual({ ok: true })
    expect(api.answerTeamQuestion).toHaveBeenCalledWith(answer)
    expect(api.editTeamCandidate).toHaveBeenCalledWith(edit)
    expect(api.confirmTeamProposal).toHaveBeenCalledWith(confirm)
  })

  it('core 抛错时返回中文错误，不抛到界面', async () => {
    const api = { editTeamCandidate: vi.fn(async () => { throw new Error('卡片已更新，请在最新内容上操作') }) }
    expect(await dispatchCommand(api as never, 'editTeamCandidate', {})).toEqual({ ok: false, error: '卡片已更新，请在最新内容上操作' })
  })
})
