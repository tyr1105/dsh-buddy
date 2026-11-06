/** 动作闸与宿主审批接管测试（verified-T3 Q2-c / Q3-b）。 */
import { describe, expect, it, vi } from 'vitest'
import { registerGuardHooks } from '../src/host/hooks.js'
import type { Hub } from '@agent-hub/core'

function makeHub(guardResult: any = { allow: true }) {
  return {
    guardToolCall: vi.fn(() => guardResult),
    onHostApprovalRequest: vi.fn(() => 'deny' as const),
  } as any as Hub
}

function makeCtx() {
  const listeners = new Map<string, Array<(payload: any) => unknown>>()
  const options = new Map<string, unknown[]>()
  return {
    ctx: {
      on: (name: string, cb: any, opts?: any) => {
        const arr = listeners.get(name) ?? []; arr.push(cb); listeners.set(name, arr)
        const list = options.get(name) ?? []; list.push(opts); options.set(name, list)
        return () => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1) }
      },
    },
    fire: (name: string, ...args: unknown[]) => [...(listeners.get(name) ?? [])].map(cb => (cb as (...a: unknown[]) => unknown)(...args)),
    options,
  }
}

const botExec = { name: 'write', arguments: { file_path: '/tmp/x' }, agent: { id: 'bot-s', session: { header: { origin: 'x' } } } }
const otherExec = { name: 'write', arguments: {}, agent: { id: 'other-s', session: { header: {} } } }
const subExec = { name: 'write', arguments: {}, agent: { id: 'bot-s', session: { header: { origin: 'subagent' } } } }
const isBot = (id: string) => id === 'bot-s'

describe('tools/pre-execute 动作闸', () => {
  it('非机器人会话直接 next（不调 guard）', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const result = await made.fire('tools/pre-execute', otherExec, next)[0]
    expect(result).toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
    expect(hub.guardToolCall).not.toHaveBeenCalled()
  })
  it('机器人会话放行时 return next()；参数原样传给 guard', async () => {
    const hub = makeHub({ allow: true })
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const result = await made.fire('tools/pre-execute', botExec, next)[0]
    expect(result).toEqual({ kind: 'allow' })
    expect(hub.guardToolCall).toHaveBeenCalledWith('bot-s', 'write', botExec.arguments)
  })
  it('拒绝时返回 verified-T3 Q2-c 的 deny 形状，且不再 next', async () => {
    const hub = makeHub({ allow: false, message: '未批准的出站动作，请先走审批' })
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const result: any = await made.fire('tools/pre-execute', botExec, next)[0]
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('出站')
    expect(result.info).toMatchObject({ name: 'HubPolicyError', code: 'HUB_GUARD' })
    expect(next).not.toHaveBeenCalled()
  })
  it('必须 prepend 注册（排在最外层，外层监听器给决定也绕不过动作闸；D05 第 7 条）', () => {
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub: makeHub(), isBotSession: isBot })
    expect(made.options.get('tools/pre-execute')).toEqual([{ prepend: true }])
  })
  it('下游 next() 抛错原样向上传（不吞、不再调一次 next；D05 第 7 条）', async () => {
    const hub = makeHub({ allow: true })
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    let calls = 0
    const next = async () => { calls += 1; throw new Error('下游监听器炸了') }
    await expect(made.fire('tools/pre-execute', botExec, next)[0]).rejects.toThrow('下游监听器炸了')
    await expect(made.fire('tools/pre-execute', otherExec, next)[0]).rejects.toThrow('下游监听器炸了')
    expect(calls).toBe(2) // 每个用例各一次：catch 里绝不重调 next
  })
  it('guard 判定阶段抛错：普通会话 return next()（只一次），机器人会话保守拒绝', async () => {
    const hub = { guardToolCall: () => { throw new Error('boom') }, onHostApprovalRequest: () => 'deny' } as any as Hub
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const ownerResult = await made.fire('tools/pre-execute', otherExec, next)[0]
    expect(ownerResult).toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(1)
    const botResult: any = await made.fire('tools/pre-execute', botExec, next)[0]
    expect(botResult.kind).toBe('deny')
    expect(botResult.reason).toContain('中心动作闸暂时不可用')
    expect(next).toHaveBeenCalledTimes(1) // 机器人被拒，没有多调 next
  })
  it('子代理会话不走机器人闸门（直接 next）', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await made.fire('tools/pre-execute', subExec, next)[0]
    expect(hub.guardToolCall).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1) // 确实放行了，不只是没调 guard
  })
  it('没有 agent 的程序化调用直接 next', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await made.fire('tools/pre-execute', { name: 'x' }, next)[0]
    expect(next).toHaveBeenCalled()
  })
})

describe('tools/pre-execute 禁用工具双保险（D03 先修项 A2）', () => {
  // 这些名字里 subagent/workflow 等来自 preset 层，restrict 删不掉，只能在这里拦。
  const denyCases = ['subagent', 'subagent_fork', 'workflow', 'ask_user_question', 'schedule_create', 'exit_plan_mode', 'create_goal', 'working_directory', 'plugin_manager']
  it.each(denyCases)('机器人调用 %s 一律拒绝（中文原因、不进 guard、不 next）', async (tool) => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const result: any = await made.fire('tools/pre-execute', { name: tool, arguments: {}, agent: { id: 'bot-s', session: { header: {} } } }, next)[0]
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain(`Agent 中心的机器人不能使用 ${tool}：`)
    expect(hub.guardToolCall).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
  it('普通会话调用同样的工具照常放行（双保险只拦机器人会话）', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    const result = await made.fire('tools/pre-execute', { name: 'subagent', arguments: {}, agent: { id: 'other-s', session: { header: {} } } }, next)[0]
    expect(result).toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })
  it('机器人调用不在清单里的工具仍走正常闸门', async () => {
    const hub = makeHub({ allow: true })
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await made.fire('tools/pre-execute', { name: 'read', arguments: {}, agent: { id: 'bot-s', session: { header: {} } } }, next)[0]
    expect(hub.guardToolCall).toHaveBeenCalledWith('bot-s', 'read', {})
  })
})

describe('approval/request 宿主审批接管', () => {
  it('机器人会话一律 rejected 并生成中心审批单', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => 'allowed-once')
    const result = await made.fire('approval/request', { agent: { id: 'bot-s', session: { header: {} } }, toolName: 'bash', reason: 'r' }, next)[0]
    expect(result).toBe('rejected')
    expect(hub.onHostApprovalRequest).toHaveBeenCalledWith('bot-s', 'bash', 'r')
    expect(next).not.toHaveBeenCalled()
  })
  it('非机器人会话与子代理 next（交给桌面面板）', async () => {
    const hub = makeHub()
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = async () => 'allowed-once'
    expect(await made.fire('approval/request', { agent: { id: 'other-s', session: { header: {} } }, toolName: 'bash' }, next)[0]).toBe('allowed-once')
    expect(await made.fire('approval/request', { agent: { id: 'bot-s', session: { header: { origin: 'subagent' } } }, toolName: 'bash' }, next)[0]).toBe('allowed-once')
  })
  it('必须 prepend 注册（api-remotes 的桌面转发器先注册且不调 next）', () => {
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub: makeHub(), isBotSession: isBot })
    expect(made.options.get('approval/request')).toEqual([{ prepend: true }])
  })
  it('监听器自身异常：机器人会话返回 rejected（失败即关闭，不交给桌面面板；D05 第 6 条）', async () => {
    const hub = { guardToolCall: () => ({ allow: true }), onHostApprovalRequest: () => { throw new Error('x') } } as any as Hub
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = vi.fn(async () => 'cancelled')
    expect(await made.fire('approval/request', { agent: { id: 'bot-s', session: { header: {} } }, toolName: 't' }, next)[0]).toBe('rejected')
    expect(next).not.toHaveBeenCalled()
  })
  it('监听器自身异常：非机器人会话仍转交 next', async () => {
    const hub = { guardToolCall: () => ({ allow: true }), onHostApprovalRequest: () => { throw new Error('x') } } as any as Hub
    const made = makeCtx()
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    const next = async () => 'cancelled'
    expect(await made.fire('approval/request', { agent: { id: 'other-s', session: { header: {} } }, toolName: 't' }, next)[0]).toBe('cancelled')
  })
})
