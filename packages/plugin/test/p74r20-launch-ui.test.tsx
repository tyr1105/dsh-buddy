/**
 * P74r20 第 2、3 节的渲染与样例测试：发布这一步各种结果在界面上怎样显示。
 *
 * 1 样例：发布结果样例（?job=launch）的快照与实时生成的视图逐字相同；样例里给主人看的句子与 core 现在的输出逐字一致
 *   （core 没有把这些函数放进公开出口，所以测试按文件地址动态读 core 源文件对照）；审批卡风险提示与 core 的 hostCommandRiskNote 一致；
 * 2 进度行：已批准运行中、没有成功、已发布、没有发布四种发布状态各一份，显示的是核心给的文字，不出现「已发布」（成功除外）、
 *   空白、英文状态名；
 * 3 审批卡：已作废的卡在状态词下一行显示作废原因（两种原因各一张），没有原因文字（旧记录、状态不是已撤回）就不显示；
 * 4 「查看原始命令」：展开之后显示命令的全部文字（超过 300 个字符时开头、中间、结尾三段都在），自动换行、很长时在这一块里上下滚动；
 * 5 预览入口 ?job=launch：总管私聊是主线程，四个主题挂进项目的主题列表。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCardPartsSchema, JobProgressViewSchema, TopicFloorsViewSchema } from '@agent-hub/core'
import { ApprovalBlock } from '../src/client/components/ApprovalBlock.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { approvalPartsOf, type ApprovalParts } from '../src/client/logic/cards.js'
import {
  SAMPLE_APPROVAL_TITLE_SENTENCES, SAMPLE_LAUNCH_DONE_TEXT, SAMPLE_LAUNCH_ENDED_REASON, SAMPLE_LAUNCH_FAILED_TEXT, SAMPLE_LAUNCH_GIVEUP_FAILED_TEXT, SAMPLE_LAUNCH_GIVEUP_TEXT,
  SAMPLE_LAUNCH_HOW, SAMPLE_LAUNCH_OTHER_TEXTS, SAMPLE_LAUNCH_REPLACED_REASON, SAMPLE_LAUNCH_RISK_NOTE,
  sampleApprovalThread, sampleLaunchDoneThread, sampleLaunchFailedThread, sampleLaunchGiveUpThread, sampleLaunchRunningThread, sampleLaunchThread,
} from '../src/shared/fixture-job.js'
import {
  previewLaunchDoneThread, previewLaunchFailedThread, previewLaunchGiveUpThread, previewLaunchRunningThread, previewLaunchThread,
} from '../src/shared/fixture-job-preview.js'
import { applyPreviewJobEntry, basePreviewState } from '../src/shared/preview-job-state.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
/**
 * 按文件地址动态读 core 的源文件（这些函数没有放进 core 的公开出口，核心卡片也不允许改出口）。
 * 为什么不用 import 语句：插件的类型检查把 rootDir 限在插件目录内，静态 import core 的内部文件会报 TS6059；
 * 动态 import 由 vitest 在运行时解析，类型检查不看它，返回值按 any 用。
 */
const loadCore = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../core/src/${file}`, import.meta.url).href)
const byClass = (tree: unknown, tag: string, cls: string) => findElements(tree, tag).filter(n => n.props.className === cls)
const actions = { onPick: async () => null }
/** 总管私聊里按审批编号取那张卡。 */
function cardOf(approvalId: string) {
  const message = sampleLaunchThread.messages.find(item => item.card?.approvalId === approvalId)
  if (message === undefined || message.card === null) throw new Error(`样例里缺审批卡 ${approvalId}`)
  return message.card
}

describe('1 样例与核心的输出一致', () => {
  it('发布结果样例的快照与实时生成的视图逐字相同，进度行与楼层通过 core 的视图 schema', () => {
    const pairs: Array<[unknown, unknown]> = [
      [previewLaunchThread, sampleLaunchThread], [previewLaunchRunningThread, sampleLaunchRunningThread],
      [previewLaunchFailedThread, sampleLaunchFailedThread], [previewLaunchDoneThread, sampleLaunchDoneThread],
      [previewLaunchGiveUpThread, sampleLaunchGiveUpThread],
    ]
    for (const [preview, live] of pairs) {
      expect(JSON.stringify(preview)).toBe(JSON.stringify(live))
      const thread = live as { progress?: unknown; floors?: unknown }
      if (thread.progress !== undefined) expect(() => JobProgressViewSchema.parse(thread.progress)).not.toThrow()
      if (thread.floors !== undefined) expect(() => TopicFloorsViewSchema.parse(thread.floors)).not.toThrow()
    }
  })

  it('样例里给主人看的句子与 core 现在的输出逐字一致', async () => {
    const { hostCommandRiskNote } = await loadCore('gate/host-writable.ts')
    const { launchFailedBlockedText } = await loadCore('job/launch-blocked.ts')
    const { launchFailedText, launchSucceededText } = await loadCore('job/launch-result.ts')
    const { VOID_JOB_LAUNCH_ENDED_TEXT, VOID_LAUNCH_REPLACED_TEXT } = await loadCore('job/void-job-approvals.ts')
    expect(SAMPLE_LAUNCH_RISK_NOTE).toBe(hostCommandRiskNote('林舟', true))
    expect(SAMPLE_LAUNCH_FAILED_TEXT).toBe(launchFailedText('会员定价页', { ownerFailureReason: '命令退出码 1', result: '命令退出码 1：cp: x: Permission denied' }))
    expect(SAMPLE_LAUNCH_GIVEUP_FAILED_TEXT).toBe(launchFailedText('活动海报页', { ownerFailureReason: '命令退出码 1', result: '命令退出码 1：cp: x: Permission denied' }))
    expect(SAMPLE_LAUNCH_DONE_TEXT).toBe(launchSucceededText('报名名单导出', SAMPLE_LAUNCH_HOW))
    expect(SAMPLE_LAUNCH_GIVEUP_TEXT).toBe(launchFailedBlockedText('活动海报页', '林舟'))
    expect(SAMPLE_LAUNCH_REPLACED_REASON).toBe(VOID_LAUNCH_REPLACED_TEXT)
    expect(SAMPLE_LAUNCH_ENDED_REASON).toBe(VOID_JOB_LAUNCH_ENDED_TEXT)
  })

  it('其他几句（样例没有单独的状态显示它们，只为文案登记对照）也与 core 现在的输出逐字一致', async () => {
    const { LAUNCH_TOPIC_OWNER_DECLINED_TEXT } = await loadCore('job/launch-approval.ts')
    const { launchLocationBlockedText } = await loadCore('job/launch-blocked.ts')
    const { launchFailedText } = await loadCore('job/launch-result.ts')
    const { VOID_JOB_DELIVERED_TEXT } = await loadCore('job/void-job-approvals.ts')
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.failedOther).toBe(launchFailedText('活动报名页', { ownerFailureReason: '命令退出码 2', result: '命令退出码 2：boom' }))
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.locationBlocked).toBe(launchLocationBlockedText('活动报名页'))
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.ownerDeclined).toBe(LAUNCH_TOPIC_OWNER_DECLINED_TEXT)
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.voidedDelivered).toBe(VOID_JOB_DELIVERED_TEXT)
    const { HOST_SANDBOX_UNAVAILABLE } = await loadCore('io/interfaces.ts')
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.failedSandbox).toBe(launchFailedText('活动报名页', { ownerFailureReason: HOST_SANDBOX_UNAVAILABLE, result: 'x' }))
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.failedTimeout).toBe(launchFailedText('活动报名页', { ownerFailureReason: '命令超时', result: '命令超时：' }))
  })

  it('审批标题里各类命令的说法与 core 的 outwardSentence 逐字一致', async () => {
    const { outwardSentence } = await loadCore('gate/outward-commands.ts')
    const actual = [
      outwardSentence('send_message', 'lark-cli'), outwardSentence('send_message', 'pbcopy'), outwardSentence('send_message', 'open'),
      outwardSentence('system_settings', 'kill'), outwardSentence('system_settings', 'shutdown'),
      outwardSentence('publish_deploy', 'vercel'), outwardSentence('publish_deploy', 'gh'), outwardSentence('publish_deploy', 'twine'),
      outwardSentence('publish_deploy', 'docker'), outwardSentence('publish_deploy', 'npm'),
    ]
    expect([...SAMPLE_APPROVAL_TITLE_SENTENCES]).toEqual(actual)
  })

  it('审批样例（P74i）里原来写死的审批卡提示句已换成核心现在的句子，快照里没有旧句子', async () => {
    const { hostCommandRiskNote } = await loadCore('gate/host-writable.ts')
    const notes = sampleApprovalThread.messages.flatMap(message => message.card?.approval?.riskNote ?? [])
    expect(notes).toContain(hostCommandRiskNote('林舟', true))
    expect(notes.join('')).not.toContain('受限沙箱内运行')
    const source = readFileSync(new URL('../src/shared/fixture-job-preview.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('这条命令在受限沙箱内运行')
  })

  it('样例里五种状态各有一份：已批准运行中、没有成功、已发布、被取代作废、发布结束时作废', () => {
    expect(sampleLaunchRunningThread.progress?.waitingOn).toBe('中心运行发布命令')
    expect(sampleLaunchFailedThread.progress?.stateLabel).toBe('已完成（发布没有成功）')
    expect(sampleLaunchDoneThread.progress?.stateLabel).toBe('已完成')
    expect(sampleLaunchDoneThread.progress?.steps.every(step => step.state === 'done')).toBe(true)
    expect(cardOf('ap_sample0010').approval).toMatchObject({ voided: true, launch: false })
    expect(cardOf('ap_sample0015').approval).toMatchObject({ voided: true, launch: false })
    expect(cardOf('ap_sample0011')).toMatchObject({ status: 'answered', answer: '批准', approval: { launch: true, voided: false } })
    for (const message of sampleLaunchThread.messages) {
      if (message.card?.approval !== undefined) expect(() => ApprovalCardPartsSchema.parse(message.card!.approval)).not.toThrow()
    }
  })
})

describe('2 进度行：按发布状态分支的显示（每种状态显示核心给的文字）', () => {
  const cases: Array<[string, typeof sampleLaunchRunningThread, string, string | null, string]> = [
    ['已批准、命令在运行', sampleLaunchRunningThread, '已完成', '中心运行发布命令', '当前'],
    ['发布没有成功', sampleLaunchFailedThread, '已完成（发布没有成功）', '你', '未到'],
    ['已发布', sampleLaunchDoneThread, '已完成', null, '完成'],
    ['没有发布（执行者无法改正）', sampleLaunchGiveUpThread, '已完成（没有发布）', null, '未到'],
  ]
  for (const [name, thread, stateLabel, waitingOn, launchStep] of cases) {
    it(`${name}：现在写「${stateLabel}」，在等${waitingOn === null ? '没有人' : `「${waitingOn}」`}，发布一步为${launchStep}`, () => {
      const progress = thread.progress!
      const text = textOf(createHookHost().render(JobProgress, { progress }))
      expect(text).toContain(`现在：${stateLabel}`)
      if (waitingOn === null) expect(text).not.toContain('在等')
      else expect(text).toContain(`在等：${waitingOn}`)
      // 发布这一步的样式：current 当前、todo 未到、done 完成。
      const step = findElements(createHookHost().render(JobProgress, { progress }), 'li').find(node => textOf(node) === '发布')!
      expect(String(step.props.className)).toBe({ 当前: 'is-current', 未到: 'is-todo', 完成: 'is-done' }[launchStep])
      // 不出现英文状态名、空白状态；「已发布」只在发布成功时出现（进度行本身从不写「已发布」）。
      expect(text).not.toMatch(/\b(failed|approval|done|declined|preparing|none)\b/)
      expect(text).not.toContain('已发布')
      expect(progress.stateLabel.trim()).not.toBe('')
    })
  }
})

describe('3 已作废的审批卡显示作废原因', () => {
  it('被取代而作废的发布审批：状态词「已作废」，下一行「执行者提交了新的发布命令」，没有按钮', () => {
    const tree = createHookHost().render(InboxCard, { card: cardOf('ap_sample0010'), actions, busy: false })
    expect(textOf(byClass(tree, 'p', 'ah-card-answer'))).toBe('已作废')
    expect(textOf(byClass(tree, 'p', 'ah-card-answer-why'))).toBe('执行者提交了新的发布命令')
    expect(findElements(tree, 'button').filter(node => node.props.className?.toString().includes('ah-btn'))).toHaveLength(0)
  })

  it('发布结束时作废的普通审批：状态词「已作废」，下一行「这件事的发布已结束」', () => {
    const tree = createHookHost().render(InboxCard, { card: cardOf('ap_sample0015'), actions, busy: false })
    expect(textOf(byClass(tree, 'p', 'ah-card-answer'))).toBe('已作废')
    expect(textOf(byClass(tree, 'p', 'ah-card-answer-why'))).toBe('这件事的发布已结束')
  })

  it('反例：没有原因文字的旧记录（状态已过期、答复栏没有原因）只写「已作废」；主人批准的卡没有作废原因行', () => {
    const old = sampleApprovalThread.messages.find(message => message.card?.approval?.voided === true)!.card!
    const oldTree = createHookHost().render(InboxCard, { card: old, actions, busy: false })
    expect(textOf(byClass(oldTree, 'p', 'ah-card-answer'))).toBe('已作废')
    expect(byClass(oldTree, 'p', 'ah-card-answer-why')).toHaveLength(0)
    // 旧写法的作废卡状态是已过期，答复栏可能是到期时按默认记下的「拒绝」：不当作原因。
    const expired = { ...old, status: 'expired' as const, answer: '拒绝' }
    expect(byClass(createHookHost().render(InboxCard, { card: expired, actions, busy: false }), 'p', 'ah-card-answer-why')).toHaveLength(0)
    // 已撤回但答复栏为空：不显示空行。
    const empty = { ...cardOf('ap_sample0010'), answer: null }
    expect(byClass(createHookHost().render(InboxCard, { card: empty, actions, busy: false }), 'p', 'ah-card-answer-why')).toHaveLength(0)
    // 主人批准的发布审批：状态「已选：批准发布」，没有作废原因行。
    const approved = createHookHost().render(InboxCard, { card: cardOf('ap_sample0011'), actions, busy: false })
    expect(textOf(byClass(approved, 'p', 'ah-card-answer'))).toBe('已选：批准发布')
    expect(byClass(approved, 'p', 'ah-card-answer-why')).toHaveLength(0)
  })
})

describe('4 「查看原始命令」展开后显示完整的命令文字', () => {
  /** 超过 300 个字符的命令：开头、中间、结尾各有一段可辨认的文字。 */
  const HEAD = 'bash -c "mkdir -p /tmp/p74r20-site && cp HEAD_MARK_开头'
  const MIDDLE = 'MIDDLE_MARK_中间段_' + 'x'.repeat(120)
  const TAIL = 'TAIL_MARK_结尾 /tmp/p74r20-site/index.html"'
  const longCommand = `${HEAD}_${'a'.repeat(150)}_${MIDDLE}_${'b'.repeat(150)}_${TAIL}`
  // 核心给的 argsPreview 截到 300 字（带省略标记），argsFull 是全文。
  const truncated = `${longCommand.slice(0, 120)}…中间省略…${longCommand.slice(-120)}`
  const parts: ApprovalParts = { actionText: '按约定对外发布', ownerReason: null, riskNote: null, argsPreview: truncated, argsFull: longCommand, notes: null, onBehalfOf: null, launch: true, voided: false }

  it('没有 argsFull（旧数据）时展开显示 argsPreview，照旧', () => {
    const host = createHookHost()
    const props = { approval: { ...parts, argsFull: undefined }, idBase: 'old' }
    ;(byClass(host.render(ApprovalBlock, props), 'button', 'ah-approval-toggle')[0]!.props.onClick as () => void)()
    expect(textOf(byClass(host.render(ApprovalBlock, props), 'pre', 'ah-approval-raw')[0])).toBe(truncated)
  })

  it('收起时不显示命令；展开后优先显示 argsFull：开头、中间、结尾三段都在，没有「…中间省略…」', () => {
    expect(longCommand.length).toBeGreaterThan(300)
    const host = createHookHost()
    const props = { approval: parts, idBase: 'long' }
    const first = host.render(ApprovalBlock, props)
    expect(textOf(first)).not.toContain('HEAD_MARK')
    ;(byClass(first, 'button', 'ah-approval-toggle')[0]!.props.onClick as () => void)()
    const open = host.render(ApprovalBlock, props)
    const raw = textOf(byClass(open, 'pre', 'ah-approval-raw')[0])
    expect(raw).toBe(longCommand)
    expect(raw).toContain('HEAD_MARK')
    expect(raw).toContain('MIDDLE_MARK')
    expect(raw).toContain('TAIL_MARK')
    expect(raw).not.toContain('中间省略')
  })

  it('样例（?job=launch）里那条发布命令约 600 字：argsFull 是全文，argsPreview 被核心截到 300 字；展开显示全文', () => {
    const approval = cardOf('ap_sample0011').approval!
    expect(approval.argsFull!.length).toBeGreaterThan(550)
    expect(approval.argsFull!.length).toBeLessThan(700)
    expect(approval.argsFull).not.toContain('中间省略')
    expect(approval.argsPreview.length).toBeLessThanOrEqual(300)
    const parts = approvalPartsOf({ type: 'approval', approval })!
    const host = createHookHost()
    const props = { approval: parts, idBase: 'sample' }
    ;(byClass(host.render(ApprovalBlock, props), 'button', 'ah-approval-toggle')[0]!.props.onClick as () => void)()
    const raw = textOf(byClass(host.render(ApprovalBlock, props), 'pre', 'ah-approval-raw')[0])
    expect(raw).toBe(approval.argsFull)
    expect(raw).toContain('mkdir -p /tmp/p74r20-site')
    expect(raw).toContain('assets/logo.png')
  })

  it('命令框的样式：自动换行、很长时在这一块里上下滚动', () => {
    const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
    const rule = /\.ah-approval-raw\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/white-space:\s*pre-wrap/)
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule).toMatch(/max-height:\s*\d+px/)
    expect(rule).toMatch(/overflow:\s*auto/)
  })
})

describe('5 预览入口 ?job=launch', () => {
  it('总管私聊是主线程，四个主题挂进项目的主题列表，员工名单里只有这一位总管', () => {
    const state = applyPreviewJobEntry(basePreviewState(), 'launch', Date.parse('2026-11-18T10:00:00+08:00'))
    expect(state.selectedThread).toBe('b_samplechief7')
    const topics = state.project!.projects.flatMap(row => row.topics.map(topic => topic.id))
    for (const id of ['ptp_samplejob12', 'ptp_samplejob13', 'ptp_samplejob14', 'ptp_samplejob15']) {
      expect(topics).toContain(id)
      expect(state.threads[id]).toBeDefined()
    }
    expect(state.project!.projects.flatMap(row => row.topics.map(topic => topic.id)).filter(id => id === 'b_samplechief7')).toHaveLength(0)
    expect(state.overview!.bots.filter(bot => bot.role === 'chief').map(bot => bot.id)).toEqual(['b_samplechief7'])
  })
})
