/**
 * P74h 进度行的组件与纯函数测试：四步与五步、stuck 的样式、delayNote 用括号接在「在等」后、
 * pausedText 另起一行、状态小标签的颜色类。视图全部用 core 的纯函数 jobProgressView 生成
 * （构造不同状态的事），不用手写视图字段。
 */
import { describe, expect, it, vi } from 'vitest'
import { jobProgressView, type Job, type JobProgressInput } from '@agent-hub/core'
import { JobProgress } from '../src/client/components/JobProgress.js'
import { waitingText } from '../src/client/logic/job.js'
import type { JobProgressView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 造一件处于指定状态的事（只填进度行会用到的字段）。 */
function job(patch: Partial<Job>): Job {
  return {
    id: 'job_test0000001', chiefId: 'b_testchief0001', agreementId: 'agr_test000001', projectId: 'prj_test0000001',
    topicId: 'ptp_test0000001', folder: 'jobs/job_test0000001', state: 'checking', executorId: 'b_testexec00001',
    reviewerId: 'b_testrev000001', dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
    stage: 1, round: 1, blocked: null, pause: null, openAsk: null, unmet: [], turnsUsed: 6, turnCap: 16,
    launch: { state: 'none', approvalId: null, link: null }, inboxId: null, firstLockedAt: 0,
    assignedAt: 0, startedAt: 0, deliveredAt: null, acceptedAt: null, stoppedAt: null, createdAt: 0, updatedAt: 0,
    ...patch,
  } as Job
}

const INPUT: JobProgressInput = {
  agreementState: 'locked', agreementVersionNo: 4, job: job({}),
  names: { b_testexec00001: '林舟', b_testrev000001: '评审员' },
  delayNote: null, now: Date.parse('2026-11-13T16:00:00+08:00'), timezone: 'Asia/Shanghai',
}

const classOf = (node: StubElement): string => String(node.props.className ?? '')
const host = () => createHookHost()

describe('进度行（P74h）', () => {
  it('核对中且约定有发布步骤：五步，当前是「核对」，样式类与状态词对得上', () => {
    const progress = jobProgressView(INPUT)!
    const tree = host().render(JobProgress, { progress })
    const steps = findElements(tree, 'li')
    expect(steps.map(textOf)).toEqual(['对齐', '执行', '核对', '你验收', '发布'])
    expect(steps.map(classOf)).toEqual(['is-done', 'is-done', 'is-current', 'is-todo', 'is-todo'])
    // 现在一行：状态小标签（run 主色）加轮次；在等评审员；交付时间。
    const state = findElements(tree, 'span').find(node => classOf(node) === 'ah-job-state is-run')
    expect(textOf(state)).toBe('核对中')
    expect(textOf(tree)).toContain('现在：')
    expect(textOf(tree)).toContain('第 1 轮，共 3 轮')
    expect(textOf(tree)).toContain('在等：评审员')
    expect(textOf(tree)).toContain('交付：11月17日 18:00 前')
  })

  it('约定里没有发布步骤的事只有四步', () => {
    const progress = jobProgressView({ ...INPUT, job: job({ launchStep: false }) })!
    expect(progress.steps.map(step => step.label)).toEqual(['对齐', '执行', '核对', '你验收'])
  })

  it('受阻停在核对那一步：当前步的样式是 stuck（警示色）', () => {
    const progress = jobProgressView({ ...INPUT, job: job({
      state: 'blocked',
      blocked: { kind: 'review_limit', no: 3, text: '核对三轮未通过', since: 0, resumeTo: 'checking' },
    }) })!
    const tree = host().render(JobProgress, { progress })
    const steps = findElements(tree, 'li')
    expect(steps.map(classOf)).toEqual(['is-done', 'is-done', 'is-stuck', 'is-todo', 'is-todo'])
    // 受阻状态的小标签是 you 档（在等你），标签里有文字。
    expect(textOf(findElements(tree, 'span').find(node => classOf(node) === 'ah-job-state is-you'))).toBe('受阻')
  })

  it('delayNote 用括号接在「在等」后面；没有时不带括号', () => {
    expect(waitingText({ waitingOn: '林舟', delayNote: '排队中' })).toBe('在等：林舟（排队中）')
    expect(waitingText({ waitingOn: '林舟', delayNote: null })).toBe('在等：林舟')
    expect(waitingText({ waitingOn: null, delayNote: '排队中' })).toBeNull()
    const progress: JobProgressView = { ...jobProgressView(INPUT)!, waitingOn: '林舟', delayNote: '额度用完，约 21:00 恢复' }
    const tree = host().render(JobProgress, { progress })
    expect(textOf(tree)).toContain('在等：林舟（额度用完，约 21:00 恢复）')
  })

  it('pausedText 有值时另起一行；没有时不出现那一行', () => {
    const paused = jobProgressView({ ...INPUT, job: job({
      state: 'doing',
      pause: { versionNo: 4, continuing: ['页面排版'], paused: ['名额计数'], fallback: null },
    }) })!
    const tree = host().render(JobProgress, { progress: paused })
    const line = findElements(tree, 'p').find(node => classOf(node) === 'ah-job-paused')
    expect(textOf(line)).toBe('暂停：名额计数')
    // 没有暂停记录时没有这一行。
    const plain = host().render(JobProgress, { progress: jobProgressView(INPUT)! })
    expect(findElements(plain, 'p').some(node => classOf(node) === 'ah-job-paused')).toBe(false)
  })
})
