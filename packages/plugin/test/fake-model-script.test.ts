/** 假模型剧本测试：hub_commit 参数必须通过 core 的 CommitInputSchema（verified-T8 第 2 节改正①）。 */
import { describe, expect, it } from 'vitest'
import { CommitInputSchema } from '@agent-hub/core'
// 脚本在仓库 scripts/ 目录（包外、无类型声明），测试直接以动态 import 拿纯函数。
// @ts-expect-error 故意引用包外的 .mjs
const { commitArgs, nextAction, ownerMessageOf, isFirstTrialStep, askUserIntercepted } = await import('../../scripts/fake-model-server.mjs') as {
  commitArgs(ownerText: string | null): Record<string, unknown>
  nextAction(body: unknown): { kind: string; name?: string; args?: unknown }
  ownerMessageOf(messages: unknown): string | null
  isFirstTrialStep(messages: unknown): boolean
  askUserIntercepted(messages: unknown): boolean
}

describe('fake-model-server 剧本', () => {
  it('hub_commit 参数通过 core CommitInputSchema（12 个键全给）', () => {
    const args = commitArgs('把收藏整理一下')
    expect(() => CommitInputSchema.parse(args)).not.toThrow()
    expect(Object.keys(args).sort()).toEqual([
      'blocker', 'evidence', 'importance', 'nextThink', 'outcome', 'ownerQuestion',
      'proposals', 'reply', 'report', 'summary', 'verification', 'worldChanges',
    ])
  })
  it('reply 截主人原话前 20 字；试跑回合（没有主人消息）reply 为 null（D05 第 19 条）', () => {
    expect(commitArgs('一二三四五六七八九十一二三四五六七八九十一').reply).toBe('收到：一二三四五六七八九十一二三四五六七八九十')
    expect(commitArgs(null).reply).toBeNull()
    // 两种参数都必须能通过 core 的交账校验。
    expect(() => CommitInputSchema.parse(commitArgs(null))).not.toThrow()
  })
  it('主人消息抽取：取「主人对你说」小节的第一行，遇到下一节停止', () => {
    const wake = [{ role: 'user', content: [{ type: 'text', text: '【中心通知】醒来\n## 主人对你说\n把收藏整理一下\n## 你的志向\n- A' }] }]
    expect(ownerMessageOf(wake)).toBe('把收藏整理一下')
    expect(ownerMessageOf([{ role: 'user', content: [{ type: 'text', text: '没有主人的唤醒包' }] }])).toBeNull()
  })
  it('nextAction：新请求→hub_state_get；state_get 结果→commit；commit 结果→end', () => {
    expect(nextAction({ messages: [{ role: 'user', content: [{ type: 'text', text: '醒' }] }] })).toEqual({ kind: 'tool', name: 'hub_state_get', args: {} })
    const afterState = { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'hub_state_get', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
    ] }
    expect(nextAction(afterState)).toEqual({ kind: 'commit' })
    const afterCommit = { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'hub_commit', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [] }] },
    ] }
    expect(nextAction(afterCommit)).toEqual({ kind: 'end' })
  })
  it('nextAction：主人消息回合的第一步不探针，照常 hub_state_get', () => {
    const wake = [{ role: 'user', content: [{ type: 'text', text: '【中心通知】…\n## 主人对你说\n冒烟：请交账' }] }]
    expect(nextAction({ messages: wake })).toEqual({ kind: 'tool', name: 'hub_state_get', args: {} })
  })
  it('nextAction：concludeTurn 收口后，上一回合的 tool_result 与新唤醒正文拼在同一条消息 → 按新回合处理（D05 第 10/19 条）', () => {
    const merged = { messages: [
      { role: 'user', content: [{ type: 'text', text: '试跑唤醒包' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'hub_state_get', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'hub_commit', input: {} }] },
      // hub_commit 成功后插件请求收口：这条 user 消息 = 上一回合未答复的 tool_result + 新唤醒正文。
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: [] },
        { type: 'text', text: '【中心通知】…\n## 主人对你说\n冒烟：请交账' },
      ] },
    ] }
    expect(nextAction(merged)).toEqual({ kind: 'tool', name: 'hub_state_get', args: {} })
  })
})

describe('fake-model-server 禁用工具探针（D03 先修项 A4）', () => {
  const trialWake = [{ role: 'user', content: [{ type: 'text', text: '【中心通知】唤醒单 w_1（试跑）\n## 第一次试跑\n…' }] }]
  it('试跑回合的第一步先探针调用 ask_user_question', () => {
    expect(isFirstTrialStep(trialWake)).toBe(true)
    expect(nextAction({ messages: trialWake })).toEqual({ kind: 'tool', name: 'ask_user_question', args: { question: '试跑探针：机器人不该能提问' } })
  })
  it('探针结果是被拒绝（is_error 或中文错误文字）→ 继续照常 hub_state_get', () => {
    const denied = [
      ...trialWake,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'ask_user_question', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', is_error: true, content: [{ type: 'text', text: 'Error: Agent 中心的机器人不能使用 ask_user_question' }] }] },
    ]
    expect(askUserIntercepted(denied)).toBe(true)
    expect(nextAction({ messages: denied })).toEqual({ kind: 'tool', name: 'hub_state_get', args: {} })
  })
  it('探针没被拒绝（正常返回）→ 剧本中止（不交账，冒烟失败）', () => {
    const notDenied = [
      ...trialWake,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'ask_user_question', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: '好的，请选择：A 或 B' }] }] },
    ]
    expect(askUserIntercepted(notDenied)).toBe(false)
    expect(nextAction({ messages: notDenied })).toEqual({ kind: 'abort' })
  })
  it('非试跑的第一步不探针', () => {
    expect(isFirstTrialStep([{ role: 'user', content: [{ type: 'text', text: '【中心通知】常规唤醒' }] }])).toBe(false)
    const withResult = [
      ...trialWake,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'hub_state_get', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
    ]
    expect(isFirstTrialStep(withResult)).toBe(false)
  })
})
