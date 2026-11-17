/**
 * 样例模式的组队命令（P73e）：三问回答、组队卡编辑、确认入职。
 *
 * 真实引擎由 core 校验、写表、发事件；样例模式不接引擎，这里在内存里做同样的事，
 * 让离线走查能看到：点「不要这位」再确认，卡片变只读并写明来历；点选第三问后三问卡变已答、
 * 输入框占位恢复。做法与 core 一致：只改**记录**（TeamSetup、TeamProposal），
 * 改完后重新调用 core 的视图函数生成视图（fixture-team.ts），不手写视图字段。
 *
 * 只服务 FixtureHub：编辑规则是 core editTeamCandidate 的简版（样例用），不是第二份真实逻辑。
 */
import type { TeamProposal, TeamSetup } from '@agent-hub/core'
import { BOT_TEMPLATES, ackText, alternatesFor } from '@agent-hub/core/team'
import type { ChangedEvent } from './hub-facade.js'
import type { CommandResult, InboxView, OverviewView, ThreadMessageView, ThreadView } from '../shared/views.js'
import {
  SAMPLE_MAX_BOTS, SAMPLE_TEAM_TIERS, sampleAdditionProposal, sampleConfirmedProposal, sampleDefaultTier, sampleInitialProposal,
  sampleQuestionViews, sampleSetup, sampleViewOfProposal,
} from '../shared/fixture-team.js'

/** 样例命令运行时需要的现场：线程、待你处理、总览，以及发事件和取序号的函数。 */
export interface OfflineTeamEnv {
  threads: ThreadView[]
  inbox: InboxView
  overview: OverviewView
  emit: (event: ChangedEvent) => void
  nextSeq: () => number
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const MBTI_PATTERN = /^[EI][SN][TF][JP]$/

/** 一份样例组队记录的可变副本：每个 FixtureHub 实例一份，互不影响。 */
export class OfflineTeam {
  private setup: TeamSetup = clone(sampleSetup)
  private readonly proposals = new Map<string, TeamProposal>(
    [sampleInitialProposal, sampleConfirmedProposal, sampleAdditionProposal].map(proposal => [proposal.id, clone(proposal)]),
  )

  /** 按当前记录重新生成线程里所有三问卡、组队卡的视图（core 的视图函数）。 */
  refreshViews(threads: ThreadView[]): void {
    const questions = sampleQuestionViews(this.setup)
    for (const thread of threads) {
      for (const message of thread.messages) {
        if (message.kind === 'team_question' && message.teamQuestion) {
          const step = message.teamQuestion.step
          message.teamQuestion = questions[step - 1]!
        }
        if (message.kind === 'team' && message.teamCard) {
          const proposal = this.proposals.get(message.teamCard.proposalId)
          if (proposal !== undefined) message.teamCard = sampleViewOfProposal(proposal)
        }
      }
    }
  }

  /** 处理一条组队命令；不是组队命令返回 null，让调用方继续按别的命令处理。 */
  handle(name: string, input: Record<string, unknown>, env: OfflineTeamEnv): CommandResult | null {
    try {
      if (name === 'answerTeamQuestion') return this.answer(input, env)
      if (name === 'editTeamCandidate') return this.edit(input, env)
      if (name === 'confirmTeamProposal') return this.confirm(input, env)
      return null
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 把一条消息追加到总管私聊（样例里组队的消息都在这条线程里）。 */
  private post(env: OfflineTeamEnv, message: Partial<ThreadMessageView> & Pick<ThreadMessageView, 'from' | 'fromName' | 'kind' | 'text'>): void {
    const thread = env.threads.find(item => item.threadId === 'bot-zongguan')
    if (thread === undefined) return
    const at = Date.now()
    thread.messages.push({
      id: `team-${at}-${env.nextSeq()}`, thread: thread.threadId, fromColor: message.from === 'bot-zongguan' ? 'var(--dsw-alias-warning)' : null,
      createdAt: at, timeText: '刚刚', card: null, ...message,
    })
  }

  private publish(env: OfflineTeamEnv): void {
    this.refreshViews(env.threads)
    env.emit({ scope: 'thread', botId: 'bot-zongguan' })
    env.emit({ scope: 'inbox' })
    env.emit({ scope: 'overview' })
  }

  // ---------- 三问 ----------

  private answer(input: Record<string, unknown>, env: OfflineTeamEnv): CommandResult {
    const step = Number(input.step)
    const choice = typeof input.choice === 'string' ? input.choice : ''
    if (input.setupId !== this.setup.id) return { ok: false, error: 'setupId：三问记录不存在' }
    if (this.setup.state !== 'asking') return { ok: false, error: '这个问题已经回答过了' }
    if (step !== this.setup.step) return { ok: false, error: '这个问题已经回答过了' }
    const view = sampleQuestionViews(this.setup)[step - 1]!
    const option = view.options.find(item => item.value === choice)
    if (option === undefined) return { ok: false, error: 'choice：不是这一问的选项' }
    if (step === 1) this.setup.answers.work = choice as TeamSetup['answers']['work']
    if (step === 2) {
      if (choice === 'yes' && typeof input.folderPath !== 'string') return { ok: false, error: '第二问选「有」时必须给出项目文件夹' }
      this.setup.answers.hasProject = choice === 'yes'
      this.setup.answers.projectFolder = typeof input.folderPath === 'string' ? input.folderPath : null
    }
    if (step === 3) this.setup.answers.notify = choice as TeamSetup['answers']['notify']
    this.post(env, { from: 'owner', fromName: '我', kind: 'chat', text: option.label })
    this.post(env, { from: 'bot-zongguan', fromName: '总管', kind: 'chat', text: ackText(step as 1 | 2 | 3, { value: choice }) })
    // 样例只有第三问是「当前问」：答完三问结束，等你确认已经发出的组队卡。
    if (step === 3) this.setup.state = 'proposed'
    this.publish(env)
    return { ok: true, data: { setupId: this.setup.id, step } }
  }

  // ---------- 组队卡编辑 ----------

  private edit(input: Record<string, unknown>, env: OfflineTeamEnv): CommandResult {
    const proposal = this.proposals.get(String(input.proposalId ?? ''))
    if (proposal === undefined) return { ok: false, error: 'proposalId：组队卡不存在' }
    if (proposal.state !== 'pending') return { ok: false, error: '这张组队卡已经处理过，不能再修改' }
    if (input.rev !== proposal.rev) return { ok: false, error: '卡片已更新，请在最新内容上操作' }
    const index = proposal.candidates.findIndex(item => item.key === input.key)
    if (index < 0) return { ok: false, error: 'key：这张卡上没有这位候选' }
    const candidate = proposal.candidates[index]!
    const action = String(input.action ?? '')
    const value = input.value
    if (candidate.removed && action !== 'unremove') return { ok: false, error: '这位已选不要，请先撤销' }
    switch (action) {
      case 'rename': {
        const name = typeof value === 'string' ? value.trim() : ''
        if (name === '' || [...name].length > 20) return { ok: false, error: '名字：必须是 1 到 20 字' }
        if (proposal.candidates.some(item => item.key !== candidate.key && item.name === name)) {
          return { ok: false, error: '名字：已有同名员工（含已归档的）或卡上已有同名的人，请换一个名字' }
        }
        candidate.name = name
        break
      }
      case 'set_mbti':
        if (typeof value !== 'string' || !MBTI_PATTERN.test(value)) return { ok: false, error: 'value：不是 16 型之一' }
        candidate.mbti = value as typeof candidate.mbti
        break
      case 'set_model':
        if (value !== 'standard' && value !== 'light') return { ok: false, error: 'value：档位必须是标准档或轻档' }
        if (value === 'light' && !SAMPLE_TEAM_TIERS.lightAvailable) return { ok: false, error: '轻档不可用：模型目录里没有可用的轻量模型' }
        candidate.modelTier = value
        break
      case 'restore_mbti': candidate.mbti = candidate.suggested.mbti; break
      case 'restore_model': candidate.modelTier = candidate.suggested.modelTier; break
      case 'swap': {
        const alternate = candidate.alternates[Number(value)]
        if (alternate === undefined) return { ok: false, error: 'value：没有这个备选' }
        const view = sampleViewOfProposal(proposal).candidates[index]!.alternates[Number(value)]!
        if (view.disabled) return { ok: false, error: `${alternate.label}：${view.reason ?? '不能换到这一位'}` }
        const template = BOT_TEMPLATES.find(item => item.id === alternate.templateId)!
        const taken = proposal.candidates.filter(item => item.key !== candidate.key).map(item => item.name)
        const name = template.id === candidate.templateId ? candidate.name : (taken.includes(template.name) ? `${template.name}2` : template.name)
        const tier = sampleDefaultTier(template.id)
        // 换一位：整体换成新模板的建议值，原模板记进来历。
        Object.assign(candidate, {
          swappedFrom: candidate.swappedFrom ?? candidate.templateId, templateId: template.id, name, mbti: alternate.mbti, modelTier: tier, brief: null,
          suggested: { templateId: template.id, name, mbti: alternate.mbti, modelTier: tier },
          alternates: alternatesFor(template.id).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
        })
        break
      }
      case 'remove':
        if (proposal.kind !== 'initial') return { ok: false, error: '这张卡上不能去掉这位员工；不新增请回复「不新增」' }
        candidate.removed = true
        break
      case 'unremove': candidate.removed = false; break
      default: return { ok: false, error: 'action：不是可用的修改动作' }
    }
    proposal.rev += 1
    proposal.updatedAt = Date.now()
    this.publish(env)
    return { ok: true, data: clone(proposal) }
  }

  // ---------- 确认 ----------

  private confirm(input: Record<string, unknown>, env: OfflineTeamEnv): CommandResult {
    const proposal = this.proposals.get(String(input.proposalId ?? ''))
    if (proposal === undefined) return { ok: false, error: 'proposalId：组队卡不存在' }
    return this.settle(proposal, Number(input.rev), env)
  }

  /** 待你处理里点了条目的按钮：等同卡片确认。条目没有对应的样例卡时返回 null。 */
  confirmFromInbox(proposalId: string, env: OfflineTeamEnv): CommandResult | null {
    const proposal = this.proposals.get(proposalId)
    if (proposal === undefined) return null
    return this.settle(proposal, proposal.rev, env)
  }

  private settle(proposal: TeamProposal, rev: number, env: OfflineTeamEnv): CommandResult {
    if (proposal.state !== 'pending') return { ok: false, error: '这张组队卡已经处理过了' }
    if (rev !== proposal.rev) return { ok: false, error: '卡片已更新，请在最新内容上确认' }
    const kept = proposal.candidates.filter(item => !item.removed)
    const initial = proposal.kind === 'initial'
    // 在册人数：初始卡发出时只有总管一位，按需加人卡发出时已有三位。
    const rosterAfter = (initial ? 1 : 3) + kept.length
    proposal.rev += 1
    proposal.decidedAt = Date.now()
    proposal.decidedVia = 'button'
    proposal.updatedAt = proposal.decidedAt
    if (kept.length === 0) {
      proposal.state = 'declined'
      for (const item of proposal.candidates) item.outcome = { kind: 'not_hired' }
      this.post(env, { from: 'hub', fromName: '中心', kind: 'system', text: '你选择不新增员工。' })
    } else {
      proposal.state = 'confirmed'
      proposal.rosterAfter = rosterAfter
      for (const item of proposal.candidates) {
        // 样例入职的员工只在这张卡的记录里，不进样例名册（离线走查不新增侧栏里的员工）。
        item.outcome = item.removed ? { kind: 'not_hired' } : { kind: 'hired', botId: `b_sample${String(env.nextSeq()).padStart(4, '0')}` }
      }
      const names = kept.map(item => item.name).join('、')
      if (!initial) this.post(env, { from: 'owner', fromName: '我', kind: 'chat', text: '确认入职' })
      this.post(env, { from: 'hub', fromName: '中心', kind: 'system', text: `${names}已入职，在册 ${rosterAfter} / ${SAMPLE_MAX_BOTS} 位。` })
      if (initial) {
        this.post(env, { from: 'bot-zongguan', fromName: '总管', kind: 'chat', text: '团队已就位。你交代的第一件真实的事，就是他们的试用；做完后我会告诉你每位做得怎样。现在可以直接把事情交给我。' })
      }
    }
    // 待你处理里这张卡的条目了结：从列表消失，总览的计数同步减掉。
    const gone = env.inbox.items.filter(item => item.teamProposalId === proposal.id)
    if (gone.length > 0) {
      env.inbox.items = env.inbox.items.filter(item => item.teamProposalId !== proposal.id)
      env.overview.inbox.total = Math.max(0, env.overview.inbox.total - gone.length)
      env.overview.inbox.questions = Math.max(0, env.overview.inbox.questions - gone.length)
    }
    this.publish(env)
    return { ok: true, data: clone(proposal) }
  }
}
