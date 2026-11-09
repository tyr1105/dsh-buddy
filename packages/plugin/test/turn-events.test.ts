/** session/event → TurnEvent 翻译层测试（含主人直聊、桥投递排除、子代理排除、token 累计）。 */
import { describe, expect, it } from 'vitest'
import { SessionEventTranslator, usageOf, textOfContent, isOwnerTyped, abortSourceOf, BRIDGE_RPC_PREFIX, RELAY_RPC_PREFIX, APPROVAL_PAIR_WAIT_MS, UNTITLED_SESSION } from '../src/host/turn-events.js'
import type { Hub } from '@agent-hub/core'

/** 记录全部 core 入口调用的假 Hub。 */
function fakeHub() {
  const hub: any = {
    turns: [], owner: [], external: [],
    onTurnEvent: async (e: any) => { hub.turns.push(e) },
    onOwnerActivity: async (at: number) => { hub.owner.push(at) },
    onExternalSessionEvent: async (e: any) => { hub.external.push(e) },
  }
  return hub as Hub & { turns: any[]; owner: number[]; external: any[] }
}

/** 手动定时器注册表：测试审批配对的 30 秒等待（不依赖真实时间，记录传入的毫秒数）。 */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): number => { const id = next++; pending.set(id, { fn, ms }); return id },
    clearTimer: (handle: unknown): void => { pending.delete(handle as number) },
    fire(): void { for (const { fn } of [...pending.values()]) fn() },
    get size(): number { return pending.size },
    lastMs: (): number => Math.max(0, ...[...pending.values()].map(p => p.ms)),
  }
}

function makeTranslator(botIds: string[] = ['bot-s'], timers?: ReturnType<typeof manualTimers>, externalTitle?: (session: unknown) => string | null) {
  const hub = fakeHub()
  const translator = new SessionEventTranslator({
    hub, now: () => 1_000,
    botIdFor: id => (botIds.includes(id) ? 'b_1' : null),
    externalTitle,
    setTimer: timers?.setTimer, clearTimer: timers?.clearTimer,
  })
  return { hub, translator }
}

const botSession = { id: 'bot-s', header: { origin: 'x' } }
const otherSession = { id: 'other-s', header: {} }
const subSession = { id: 'bot-s', header: { origin: 'subagent', parentSession: 'p' } }
const ev = (type: string, data: unknown, time = 5_000) => ({ type, data, seq: 1, time })

describe('usage / 文本抽取（verified-T3 Q4-a + 手册 3.4 口径）', () => {
  it('assistant/message 先取 usage.totalTokens，再退回 input+output（+cache 字段）', () => {
    expect(usageOf(ev('assistant/message', { usage: { totalTokens: 42 } }))).toBe(42)
    expect(usageOf(ev('assistant/message', { usage: { inputTokens: 10, outputTokens: 5 } }))).toBe(15)
    // 无 totalTokens 时 cacheRead/cacheWrite 也计入口径（D05 第 11 条）。
    expect(usageOf(ev('assistant/message', { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 } }))).toBe(1050)
  })
  it('缺 usage 时退回 stream 最后一条 usage chunk', () => {
    const stream = [{ type: 'chunk', chunk: { type: 'text', text: 'a' } }, { type: 'chunk', chunk: { type: 'usage', usage: { totalTokens: 9 } } }]
    expect(usageOf(ev('assistant/message', { stream }))).toBe(9)
  })
  it('拿不到就给 null（不是 0）；textOfContent 只拼 text 块', () => {
    expect(usageOf(ev('assistant/message', {}))).toBeNull()
    expect(usageOf(ev('assistant/attempt', {}))).toBeNull()
    expect(textOfContent([{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
})

describe('abortSourceOf：中止来源的无状态识别（D07 第 4 条）', () => {
  it('中心自己的 hook（reason 以 agent-hub: 开头）→ hub', () => {
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'hook', reason: 'agent-hub:cancel' } })).toBe('hub')
  })
  it('其余一切中止 → external（user / disposed / parent / 其他插件的 hook / 无内层）', () => {
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'user' } })).toBe('external')
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'disposed' } })).toBe('external')
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'parent' } })).toBe('external')
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } })).toBe('external')
    expect(abortSourceOf({ kind: 'aborted', reason: { kind: 'hook' } })).toBe('external')
    expect(abortSourceOf({ kind: 'aborted' })).toBe('external')
  })
  it('非中止类 → null（DSH 没有 cancelled/canceled 这种 kind）', () => {
    expect(abortSourceOf({ kind: 'completed' })).toBeNull()
    expect(abortSourceOf({ kind: 'error', error: { message: 'x' } })).toBeNull()
    expect(abortSourceOf({ kind: 'cancelled' })).toBeNull()
    expect(abortSourceOf(null)).toBeNull()
  })
  it('翻译层按内层原因分流：agent-hub hook 不发事件；user/disposed/其他 hook 都翻译成 interrupted', async () => {
    const cases: Array<{ reason: unknown; interrupted: boolean }> = [
      { reason: { kind: 'aborted', reason: { kind: 'user' } }, interrupted: true },
      { reason: { kind: 'aborted', reason: { kind: 'disposed' } }, interrupted: true },
      { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }, interrupted: true },
      { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'agent-hub:cancel' } }, interrupted: false },
    ]
    for (const { reason, interrupted } of cases) {
      const { hub, translator } = makeTranslator()
      translator.handle(botSession, ev('turn/start', {}))
      translator.handle(botSession, ev('turn/end', { reason }))
      await Promise.resolve()
      const hit = hub.turns.find(e => e.type === 'interrupted')
      if (interrupted) expect(hit).toMatchObject({ by: 'owner' })
      else {
        expect(hit).toBeUndefined()
        expect(hub.turns.some(e => e.type === 'ended')).toBe(false)
      }
    }
  })
})

describe('机器人会话的回合翻译', () => {
  it('turn/start → started；tool/call → step（steps 累计、tokens 是回合累计值）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '思考中' }] }, usage: { totalTokens: 30 } }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 1, name: 'hub_state_get', callId: 'c1' }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 2, name: 'hub_commit', callId: 'c2' }))
    await Promise.resolve()
    const steps = hub.turns.filter(e => e.type === 'step')
    expect(steps.map(s => s.steps)).toEqual([1, 2])
    expect(steps.every(s => s.tokens === 30)).toBe(true)
    expect(hub.turns[0]).toMatchObject({ type: 'started', sessionId: 'bot-s', at: 5_000 })
  })

  it('tool/result → tool_call：工具名、参数、失败标记与结果摘要都带上（F02）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 1, name: 'read_file', callId: 'c1', arguments: { path: '/hub/notes.txt' } }))
    translator.handle(botSession, ev('tool/result', {
      turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }], isError: false },
    }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'tool_call')).toMatchObject({
      type: 'tool_call', name: 'read_file', callId: 'c1', args: { path: '/hub/notes.txt' }, isError: false, resultText: '文件内容',
    })
  })

  it('tool/result 失败且没有文本时用错误消息；找不到配对的 call 仍报「未知工具」（F02 反例）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'ghost', isError: true }, error: { message: '权限不足' } }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'tool_call')).toMatchObject({
      name: '未知工具', callId: 'ghost', isError: true, resultText: '权限不足',
    })
  })

  it('多步回合的 token 按 step 累计（D05 第 11 条）：三步 8000/9000/10000 → ended 27000', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, usage: { totalTokens: 8000 }, message: { content: [] } }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 2, usage: { totalTokens: 9000 }, message: { content: [] } }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 2 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 3, usage: { totalTokens: 10000 }, message: { content: [{ type: 'text', text: '最终回复' }] } }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.resolve()
    const steps = hub.turns.filter(e => e.type === 'step')
    expect(steps.map(s => s.tokens)).toEqual([8000, 17000])
    expect(hub.turns.find(e => e.type === 'ended')).toMatchObject({ finalText: '最终回复', tokens: 27000 })
  })

  it('整轮拿不到用量时 step 的 tokens 是 null；主人中止回合翻译成 interrupted（D06 第 2 条）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没有用量' }] } }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 1 }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    await Promise.resolve()
    expect(hub.turns.filter(e => e.type === 'step').every(s => s.tokens === null)).toBe(true)
    // 主人在 DSH 界面里停止回合：不再报 ended，而是 interrupted（by=owner）。
    expect(hub.turns.find(e => e.type === 'ended')).toBeUndefined()
    expect(hub.turns.find(e => e.type === 'interrupted')).toMatchObject({ sessionId: 'bot-s', by: 'owner', at: 5_000 })
  })

  it('正常结束（completed）且整轮拿不到用量时 ended.tokens 是 null（不是 0）（D05 第 11 条 / D07 第 21 条）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没有用量' }] } }))
    translator.handle(botSession, ev('tool/call', { turn: 1, step: 1 }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(hub.turns.filter(e => e.type === 'step').every(s => s.tokens === null)).toBe(true)
    const ended = hub.turns.find(e => e.type === 'ended') as { tokens: number | null } | undefined
    expect(ended).toBeDefined()
    expect(ended!.tokens).toBeNull()
  })

  it('llm/retry-started 后同一 (turn, step) 的用量相加：attempt 5000 → retry → 6000 = 11000（D07 第 16 条）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { totalTokens: 5000 } } }] }))
    translator.handle(botSession, ev('llm/retry-started', { turn: 1, step: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, usage: { totalTokens: 6000 }, message: { content: [] } }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'ended')).toMatchObject({ tokens: 11000 })
  })

  it('没有 retry-started 时同一 (turn, step) 后到样本仍替换（不重复累计）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', { turn: 1 }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, usage: { totalTokens: 3000 }, message: { content: [] } }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, usage: { totalTokens: 4000 }, message: { content: [] } }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'ended')).toMatchObject({ tokens: 4000 })
  })

  it('turn/end → ended，finalText 取本轮最后一条 assistant 文本', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', {}))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一段' }] }, usage: { totalTokens: 10 } }))
    translator.handle(botSession, ev('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: '最终回复' }] }, usage: { totalTokens: 20 } }))
    translator.handle(botSession, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.resolve()
    const ended = hub.turns.find(e => e.type === 'ended')
    expect(ended).toMatchObject({ finalText: '最终回复', tokens: 30, sessionId: 'bot-s' })
  })

  it('reason.kind=error → error 事件带错误文本', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('turn/start', {}))
    translator.handle(botSession, ev('turn/end', { reason: { kind: 'error', error: { message: '额度不足', code: 'QUOTA' } } }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'error')).toMatchObject({ errorText: '额度不足' })
    expect(hub.turns.some(e => e.type === 'ended')).toBe(false)
  })

  it('approval/asked 后紧跟配对的 decided（never 自动拒绝）不产生 awaiting_approval', async () => {
    const timers = manualTimers()
    const { hub, translator } = makeTranslator(['bot-s'], timers)
    translator.handle(botSession, ev('approval/asked', { id: 'q1', toolName: 'bash', reason: 'escalate' }))
    translator.handle(botSession, ev('approval/decided', { id: 'q1', outcome: 'rejected' }))
    expect(timers.size).toBe(0) // 定时器已随配对清理
    timers.fire() // 即使时间到了也不能再报
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'awaiting_approval')).toBeUndefined()
  })

  it('approval/asked 后等待的毫秒数是 30_000（不是别的值）', () => {
    const timers = manualTimers()
    const { translator } = makeTranslator(['bot-s'], timers)
    translator.handle(botSession, ev('approval/asked', { id: 'qx', toolName: 'bash', reason: 'escalate' }))
    expect(timers.lastMs()).toBe(APPROVAL_PAIR_WAIT_MS)
    expect(APPROVAL_PAIR_WAIT_MS).toBe(30_000)
  })

  it('approval/asked 后 30 秒仍没有配对的 decided 才产生 awaiting_approval', async () => {
    const timers = manualTimers()
    const { hub, translator } = makeTranslator(['bot-s'], timers)
    translator.handle(botSession, ev('approval/asked', { id: 'q2', toolName: 'bash', reason: 'escalate' }))
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'awaiting_approval')).toBeUndefined() // 配对窗口内不报
    timers.fire()
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'awaiting_approval')).toMatchObject({ tool: 'bash', summary: 'escalate', sessionId: 'bot-s' })
  })

  it('回合结束清理该会话的未决审批记录（之后定时器到点也不再报）', async () => {
    const timers = manualTimers()
    const { hub, translator } = makeTranslator(['bot-s'], timers)
    translator.handle(botSession, ev('turn/start', {}))
    translator.handle(botSession, ev('approval/asked', { id: 'q3', toolName: 'bash', reason: 'escalate' }))
    translator.handle(botSession, ev('turn/end', { reason: { kind: 'completed' } }))
    expect(timers.size).toBe(0)
    timers.fire()
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'awaiting_approval')).toBeUndefined()
  })

  it('dispose 清掉全部未决审批定时器（插件卸载后不能再报）', async () => {
    const timers = manualTimers()
    const { hub, translator } = makeTranslator(['bot-s'], timers)
    translator.handle(botSession, ev('turn/start', {}))
    translator.handle(botSession, ev('approval/asked', { id: 'q4', toolName: 'bash', reason: 'escalate' }))
    expect(timers.size).toBe(1)
    translator.dispose()
    expect(timers.size).toBe(0)
    timers.fire()
    await Promise.resolve()
    expect(hub.turns.find(e => e.type === 'awaiting_approval')).toBeUndefined()
  })

  it('主人亲手发言 → owner_direct + onOwnerActivity；中心投递（kind=agent-hub）与桥/转发都排除', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(botSession, ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '主人的话' }], source: { kind: 'user' } }))
    // 中心投递（D05 第 8 条）：kind 是 agent-hub，不是主人亲手发言。
    translator.handle(botSession, ev('user/message', { id: 'm2', role: 'user', content: [{ type: 'text', text: '唤醒包' }], source: { kind: 'agent-hub', wakeId: 'w_9' } }))
    translator.handle(botSession, ev('user/message', { id: 'm3', role: 'user', content: [{ type: 'text', text: '桥' }], source: { kind: 'user', rpcId: `${BRIDGE_RPC_PREFIX}123` } }))
    translator.handle(botSession, ev('user/message', { id: 'm4', role: 'user', content: [{ type: 'text', text: '转发' }], source: { kind: 'user', rpcId: `${RELAY_RPC_PREFIX}m1` } }))
    await Promise.resolve()
    const directs = hub.turns.filter(e => e.type === 'owner_direct')
    expect(directs).toHaveLength(1)
    expect(directs[0]).toMatchObject({ text: '主人的话' })
    expect(hub.owner).toEqual([5_000])
  })

  it('子代理会话一律忽略（不产生回合事件）', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(subSession, ev('turn/start', {}))
    translator.handle(subSession, ev('turn/end', { reason: { kind: 'completed' } }))
    translator.handle(subSession, ev('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await Promise.resolve()
    expect(hub.turns).toHaveLength(0)
    expect(hub.owner).toHaveLength(0)
    expect(hub.external).toHaveLength(0)
  })

  it('翻译器内部异常不外泄（兜住只记日志）', () => {
    const { translator } = makeTranslator()
    expect(() => translator.handle(botSession, null)).not.toThrow()
    expect(() => translator.handle(botSession, ev('turn/start', undefined))).not.toThrow()
  })
})

describe('非机器人会话', () => {
  it('主人亲手发言只记 onOwnerActivity', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(otherSession, ev('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    translator.handle(otherSession, ev('user/message', { content: [{ type: 'text', text: 'schedule' }], source: { kind: 'schedule' } }))
    await Promise.resolve()
    expect(hub.owner).toEqual([5_000])
    expect(hub.turns).toHaveLength(0)
  })

  it('turn/end → onExternalSessionEvent；标题优先 sessionProjections 快照（D05 第 15 条）', async () => {
    const { hub, translator } = makeTranslator(['bot-s'], undefined, () => '部署 staging 环境')
    translator.handle(otherSession, ev('turn/end', { reason: { kind: 'completed' } }))
    translator.handle(otherSession, ev('turn/end', { reason: { kind: 'error', error: { message: '网络断开' } } }))
    await Promise.resolve()
    expect(hub.external).toHaveLength(2)
    expect(hub.external[0]).toMatchObject({ type: 'finished', title: '部署 staging 环境', sessionId: 'other-s' })
    expect(hub.external[1]).toMatchObject({ type: 'error' })
  })

  it('快照与缓存都取不到时用「未命名会话」，绝不用会话 id', async () => {
    const { hub, translator } = makeTranslator()
    translator.handle(otherSession, ev('turn/end', { reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(hub.external[0]).toMatchObject({ title: UNTITLED_SESSION })
    expect(hub.external[0].title).not.toContain('other-s')
  })

  it('重启后（没有 title 事件缓存）也能从快照取到标题；快照取不到时缓存兜底', async () => {
    // 只有缓存（session/title 事件）也能取到。
    const cached = makeTranslator()
    cached.translator.handle(otherSession, ev('session/title', { title: '排查服务' }))
    cached.translator.handle(otherSession, ev('turn/end', { reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(cached.hub.external[0]).toMatchObject({ title: '排查服务' })
    // 快照优先于缓存。
    const both = makeTranslator(['bot-s'], undefined, () => '快照标题')
    both.translator.handle(otherSession, ev('session/title', { title: '缓存标题' }))
    both.translator.handle(otherSession, ev('turn/end', { reason: { kind: 'completed' } }))
    await Promise.resolve()
    expect(both.hub.external[0]).toMatchObject({ title: '快照标题' })
  })
})

describe('isOwnerTyped 纯函数（D05 第 8 条：按 source.kind 判定）', () => {
  it('kind 非 user 一律不算（中心投递带 agent-hub，天然排除）', () => {
    expect(isOwnerTyped({ kind: 'schedule' })).toBe(false)
    expect(isOwnerTyped({ kind: 'agent-hub', wakeId: 'w_1' })).toBe(false)
    expect(isOwnerTyped(undefined)).toBe(false)
  })
  it('桥前缀与中心转发前缀排除，其余 kind=user 视为主人输入', () => {
    expect(isOwnerTyped({ kind: 'user', rpcId: 'claude-bridge-1' })).toBe(false)
    expect(isOwnerTyped({ kind: 'user', rpcId: 'agent-hub:m1' })).toBe(false)
    expect(isOwnerTyped({ kind: 'user', rpcId: 'w_other' })).toBe(true)
    expect(isOwnerTyped({ kind: 'user' })).toBe(true)
  })
})
