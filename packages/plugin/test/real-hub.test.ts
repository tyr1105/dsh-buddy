/** 真引擎门面测试：命令分发表、边界校验、Lazy/Disabled 门面。 */
import { describe, expect, it, vi } from 'vitest'
import type { UiApi, CommandResult } from '@agent-hub/core'
import { dispatchCommand, RealHubFacade, LazyHubFacade, DisabledHub } from '../src/host/real-hub.js'

/** 记录方法调用的假 UiApi（全部返回成功）。 */
function fakeApi(): UiApi & { calls: Array<{ name: string; args: unknown[] }> } {
  const calls: Array<{ name: string; args: unknown[] }> = [] as any
  const ok = () => Promise.resolve({ ok: true } as CommandResult)
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); return ok() }
  return {
    calls,
    overview: () => ({ bots: [] }) as any,
    bot: record('bot') as any,
    thread: record('thread') as any,
    inbox: () => ({ items: [] }) as any,
    activity: () => ({ rows: [], hasMore: false }) as any,
    settings: async () => ({ settings: { pushChannel: 'none' }, pushChannelOptions: [], modelOptions: [] }) as any,
    recentSessions: record('recentSessions') as any,
    createBot: record('createBot') as any,
    updateBot: record('updateBot') as any,
    lifecycleAction: record('lifecycleAction') as any,
    interruptBot: record('interruptBot') as any,
    setLifecycle: record('setLifecycle') as any,
    sendMessage: record('sendMessage') as any,
    answerInbox: record('answerInbox') as any,
    decideApproval: record('decideApproval') as any,
    upsertAspiration: record('upsertAspiration') as any,
    upsertGoal: record('upsertGoal') as any,
    closeGoal: record('closeGoal') as any,
    upsertWatch: record('upsertWatch') as any,
    decideWatchProposal: record('decideWatchProposal') as any,
    upsertRule: record('upsertRule') as any,
    editRoutine: record('editRoutine') as any,
    teach: record('teach') as any,
    pokeBot: record('pokeBot') as any,
    updateSettings: record('updateSettings') as any,
    markThreadRead: record('markThreadRead') as any,
  }
}

describe('dispatchCommand：命令表与边界校验', () => {
  it('未知命令给中文错误', async () => {
    const result = await dispatchCommand(fakeApi(), 'nope', {})
    expect(result).toEqual({ ok: false, error: expect.stringContaining('未知命令') })
  })
  it('双参命令正确展开（sendMessage / decideApproval / teach / pokeBot）', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'sendMessage', { threadId: 'team', text: '早' })
    await dispatchCommand(api, 'decideApproval', { id: 'i1', approve: true, note: '可以' })
    await dispatchCommand(api, 'teach', { botId: 'b', sessionId: 's', note: 'n' })
    await dispatchCommand(api, 'pokeBot', { botId: 'b' })
    expect(api.calls).toEqual([
      { name: 'sendMessage', args: ['team', '早'] },
      { name: 'decideApproval', args: ['i1', true, '可以'] },
      { name: 'teach', args: ['b', 's', 'n'] },
      { name: 'pokeBot', args: ['b', undefined] },
    ])
  })
  it('单对象命令透传 input（createBot / upsertRule / updateSettings）', async () => {
    const api = fakeApi()
    const input = { name: '求知', role: 'researcher' }
    await dispatchCommand(api, 'createBot', input)
    await dispatchCommand(api, 'upsertRule', { text: '规矩' })
    await dispatchCommand(api, 'updateSettings', { digestAt: '09:00' })
    expect(api.calls[0]!).toEqual({ name: 'createBot', args: [input] })
    expect(api.calls[1]!.args[0]).toEqual({ text: '规矩' })
    expect(api.calls[2]!.args[0]).toEqual({ digestAt: '09:00' })
  })
  it('M07 新命令 lifecycleAction / interruptBot 整对象透传（D06 第 2/3 条）', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'lifecycleAction', { botId: 'b', action: 'pause' })
    await dispatchCommand(api, 'interruptBot', { botId: 'b' })
    expect(api.calls).toEqual([
      { name: 'lifecycleAction', args: [{ botId: 'b', action: 'pause' }] },
      { name: 'interruptBot', args: [{ botId: 'b' }] },
    ])
  })
  it('updateBot / editRoutine 取 patch 子对象', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'updateBot', { botId: 'b', patch: { persona: 'x' } })
    await dispatchCommand(api, 'editRoutine', { id: 'r', patch: { steps: ['a'] } })
    expect(api.calls[0]!.args).toEqual(['b', { persona: 'x' }])
    expect(api.calls[1]!.args).toEqual(['r', { steps: ['a'] }])
  })
  it('缺必填项 / 类型不对给中文错误且不调 UiApi', async () => {
    const api = fakeApi()
    expect((await dispatchCommand(api, 'sendMessage', { threadId: '', text: 'x' })).ok).toBe(false)
    expect((await dispatchCommand(api, 'sendMessage', { text: 'x' })).ok).toBe(false)
    expect((await dispatchCommand(api, 'decideApproval', { id: 'i', approve: 'yes' })).ok).toBe(false)
    expect(api.calls).toHaveLength(0)
  })
  it('UiApi 抛出的中文错误透传为 CommandResult.error', async () => {
    const api = fakeApi()
    ;(api.sendMessage as any) = () => Promise.reject(new Error('threadId：机器人不存在'))
    expect(await dispatchCommand(api, 'sendMessage', { threadId: 'nope', text: 'x' })).toEqual({ ok: false, error: 'threadId：机器人不存在' })
  })
})

describe('RealHubFacade / LazyHubFacade / DisabledHub', () => {
  /** 可变假存储：settings 行直读（D07 第 6 条：推送渠道不再走会读模型目录的视图）。 */
  function fakeStore(initial: { pushChannel?: unknown } | null | undefined) {
    const store = {
      row: initial,
      fail() { store.throwing = true },
      throwing: false,
      table: (_name: 'settings') => ({ get: (_id: string) => {
        if (store.throwing) throw new Error('存储读失败')
        return store.row ?? null
      } }),
    }
    return store
  }
  it('RealHubFacade 订阅映射 hub.subscribe 事件（D06 第 1 条）', async () => {
    const listeners: Array<(e: any) => void> = []
    const hub = {
      subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
      api: fakeApi(),
    } as any
    const facade = new RealHubFacade(hub, fakeStore({ pushChannel: 'none' }))
    const seen: any[] = []
    const off = facade.subscribe(e => seen.push(e))
    // 第一个监听是门面自己的渠道刷新订阅；发给订阅者的事件走后挂的那个。
    listeners.at(-1)!({ type: 'changed', scope: 'thread', botId: 'b_1' })
    listeners.at(-1)!({ type: 'changed', scope: 'overview', botId: null })
    off()
    expect(seen).toEqual([{ scope: 'thread', botId: 'b_1' }, { scope: 'overview', botId: undefined }])
  })
  it('推送渠道同步直读存储（不走 settings() 视图）：构造即可读，模型目录坏了也不受影响（D07 第 6 条）', () => {
    const listeners: Array<(e: any) => void> = []
    const api = fakeApi()
    api.settings = async () => { throw new Error('模型目录读取失败') } // 视图坏了也不影响
    const hub = { subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => undefined }, api } as any
    const facade = new RealHubFacade(hub, fakeStore({ pushChannel: 'none' }))
    expect(facade.pushChannel()).toBe('none') // 同步可读，无需等异步预热
    const macos = new RealHubFacade({ ...hub, subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => undefined } }, fakeStore({ pushChannel: 'macos' }))
    expect(macos.pushChannel()).toBe('macos')
  })
  it('存储没有 settings 行（从未读到过）按「不推送」处理，绝不默认 dsh（D07 第 6 条）', () => {
    const hub = { subscribe: () => () => undefined, api: fakeApi() } as any
    expect(new RealHubFacade(hub, fakeStore(null)).pushChannel()).toBe('none')
    expect(new RealHubFacade(hub, undefined).pushChannel()).toBe('none')
  })
  it('settings 范围的变化事件从存储刷新缓存（不依赖有没有 SSE 订阅者）', () => {
    const listeners: Array<(e: any) => void> = []
    const hub = { subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => undefined }, api: fakeApi() } as any
    const store = fakeStore({ pushChannel: 'macos' })
    const facade = new RealHubFacade(hub, store)
    expect(facade.pushChannel()).toBe('macos')
    store.row = { pushChannel: 'none' } // 主人改成「不推」后 core 发 settings 事件
    listeners[0]!({ type: 'changed', scope: 'settings', botId: null })
    expect(facade.pushChannel()).toBe('none')
  })
  it('先成功读到 none、之后存储读取失败：保持 none（不回落 dsh、不恢复推送）（D07 第 6/28 条）', () => {
    const listeners: Array<(e: any) => void> = []
    const hub = { subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => undefined }, api: fakeApi() } as any
    const store = fakeStore({ pushChannel: 'none' })
    const facade = new RealHubFacade(hub, store)
    expect(facade.pushChannel()).toBe('none')
    store.fail() // 目录故障期间 settings 刷新时存储读失败
    listeners[0]!({ type: 'changed', scope: 'settings', botId: null })
    expect(facade.pushChannel()).toBe('none')
  })
  it('LazyHubFacade 未就绪时给中文错误；setImpl 后接通', async () => {
    const lazy = new LazyHubFacade()
    await expect(lazy.overview()).rejects.toThrow('尚未就绪')
    expect(lazy.status()).toEqual({ ok: false, mode: 'starting' })
    lazy.setImpl(new DisabledHub('已停用'))
    expect(lazy.status()).toEqual({ ok: false, mode: 'disabled' })
    expect(await lazy.command('x', {})).toEqual({ ok: false, error: '已停用' })
  })
  it('LazyHubFacade 的应用内提示会广播给订阅者', () => {
    const lazy = new LazyHubFacade()
    const seen: any[] = []
    lazy.subscribe(e => seen.push(e))
    lazy.emitInApp('overview')
    expect(seen).toEqual([{ scope: 'overview' }])
  })
  it('引擎就绪前订阅的监听器在 setImpl 后接到引擎上（D05 第 12 条）', () => {
    const lazy = new LazyHubFacade()
    const seen: any[] = []
    lazy.subscribe(e => seen.push(e)) // 引擎未就绪时先连上（宿主重启后页面的 EventSource 重连）
    // 接通一个真门面：引擎产生变化时早订阅者必须收到。
    const listeners: Array<(e: any) => void> = []
    const hub = {
      subscribe: (fn: (e: any) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
      api: fakeApi(),
    } as any
    lazy.setImpl(new RealHubFacade(hub, fakeStore(null)))
    expect(listeners).toHaveLength(2) // 门面自己的渠道刷新订阅 + 早订阅者
    listeners.at(-1)!({ type: 'changed', scope: 'thread', botId: 'b_1' })
    expect(seen).toEqual([{ scope: 'thread', botId: 'b_1' }])
    // 换引擎（重载）时旧引擎退订、新引擎重挂。
    const listeners2: Array<(e: any) => void> = []
    const hub2 = { ...hub, subscribe: (fn: (e: any) => void) => { listeners2.push(fn); return () => { const i = listeners2.indexOf(fn); if (i >= 0) listeners2.splice(i, 1) } } }
    lazy.setImpl(new RealHubFacade(hub2, fakeStore(null)))
    // 旧引擎上只剩旧门面自己的渠道刷新订阅（无副作用，不向界面转发）；早订阅者已重挂到新引擎。
    expect(listeners).toHaveLength(1)
    expect(listeners2).toHaveLength(2)
  })
  it('DisabledHub：overview/inbox/activity 可看，其余拒绝', async () => {
    const hub = new DisabledHub('中心已停用')
    expect((await hub.overview() as any).bots).toEqual([])
    expect((await hub.inbox()).items).toEqual([])
    await expect(hub.bot('b')).rejects.toThrow('中心已停用')
    await expect(hub.settings()).rejects.toThrow('中心已停用')
  })
})
