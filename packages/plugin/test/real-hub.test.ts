/** 真引擎门面测试：命令分发表、边界校验、Lazy/Disabled 门面。 */
import { describe, expect, it, vi } from 'vitest'
import type { UiApi, CommandResult } from '@agent-hub/core'
import { dispatchCommand, RealHubFacade, LazyHubFacade, DisabledHub } from '../src/host/real-hub.js'

/** 办公室视图哨兵：断言门面「同一对象透传、不包一层」时用引用相等。 */
const OFFICE_SENTINEL = { __officeSentinel: true }

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
    // 账本读法：core 的 UiApi 是同步读存储，门面统一成 Promise。
    wakeLedgerList: (...args: unknown[]) => { calls.push({ name: 'wakeLedgerList', args }); return [] },
    wakeLedgerDetail: (...args: unknown[]) => { calls.push({ name: 'wakeLedgerDetail', args }); return null },
    // 资料（F09 并行落地）与办公室投影（F03）：同样只满足形状。
    resourceView: () => ({ resources: [] }) as any,
    officeView: () => OFFICE_SENTINEL as any,
    officeReplay: record('officeReplay') as any,
    saveResource: record('saveResource') as any,
    archiveResource: record('archiveResource') as any,
    revokeGrant: record('revokeGrant') as any,
    setGrant: record('setGrant') as any,
    // 项目容器（F08 / V2-PH4-01）：projectView 只读，十二条项目与任务命令先满足形状。
    projectView: () => ({ projects: [] }) as any,
    saveProject: record('saveProject') as any,
    pauseProject: record('pauseProject') as any,
    resumeProject: record('resumeProject') as any,
    completeProject: record('completeProject') as any,
    archiveProject: record('archiveProject') as any,
    // 归档恢复由 core 尾巴批次新增；插件门面接线由该批次负责，这里先满足 UiApi 形状。
    restoreProject: record('restoreProject') as any,
    // P39 项目共享上下文：保存整对象透传；采纳/驳回只收建议 id。
    saveProjectContext: record('saveProjectContext') as any,
    approveProjectContextProposal: record('approveProjectContextProposal') as any,
    rejectProjectContextProposal: record('rejectProjectContextProposal') as any,
    // P38 知识库连通性自检（core 已有命令，插件门面对应接线由该卡负责），先满足形状。
    testKnowledgeConnection: record('testKnowledgeConnection') as any,
    saveTask: record('saveTask') as any,
    assignTask: record('assignTask') as any,
    // V2-PH4-03 五模式派活：整对象透传由 core zod 校验。
    dispatchTask: record('dispatchTask') as any,
    taskBlock: record('taskBlock') as any,
    taskResume: record('taskResume') as any,
    reportDone: record('reportDone') as any,
    acceptTask: record('acceptTask') as any,
    rejectTask: record('rejectTask') as any,
    // F08 尾巴：任务关联产物，整对象透传由 core 校验。
    attachTaskArtifact: record('attachTaskArtifact') as any,
    createBot: record('createBot') as any,
    updateBot: record('updateBot') as any,
    lifecycleAction: record('lifecycleAction') as any,
    // P48 归档链路：校验只返回形状，归档/恢复/删除满足 UiApi 签名。
    archiveBotCheck: (async (botId: string) => ({ ok: true, data: { botId, botName: '', canArchive: true, reason: null, projectCount: 0, openTaskCount: 0, projects: [] } })) as any,
    archiveBot: record('archiveBot') as any,
    restoreArchivedBot: record('restoreArchivedBot') as any,
    deleteArchivedBot: record('deleteArchivedBot') as any,
    interruptBot: record('interruptBot') as any,
    setLifecycle: record('setLifecycle') as any,
    sendMessage: record('sendMessage') as any,
    answerInbox: record('answerInbox') as any,
    decideApproval: record('decideApproval') as any,
    upsertAspiration: record('upsertAspiration') as any,
    upsertGoal: record('upsertGoal') as any,
    closeGoal: record('closeGoal') as any,
    readArtifactVersion: record('readArtifactVersion') as any,
    reviewArtifact: record('reviewArtifact') as any,
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
  it('F10 倒带走只读 API，整对象透传；拒绝与异常都不冒充成功', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'officeReplay', { at: 123 })
    expect(api.calls).toEqual([{ name: 'officeReplay', args: [{ at: 123 }] }])
    api.officeReplay = async () => ({ ok: false, error: '倒带时间不在今天' })
    expect(await dispatchCommand(api, 'officeReplay', { at: -1 })).toEqual({ ok: false, error: '倒带时间不在今天' })
    api.officeReplay = async () => { throw new Error('历史暂时不可用') }
    expect(await dispatchCommand(api, 'officeReplay', {})).toEqual({ ok: false, error: '历史暂时不可用' })
  })
  it('F09 固定版本查看与验收整对象透传，宿主异常转中文失败', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'readArtifactVersion', { versionId: 'fixed:v1' })
    await dispatchCommand(api, 'reviewArtifact', { versionId: 'fixed:v1', verdict: 'incorrect' })
    expect(api.calls).toEqual([
      { name: 'readArtifactVersion', args: [{ versionId: 'fixed:v1' }] },
      { name: 'reviewArtifact', args: [{ versionId: 'fixed:v1', verdict: 'incorrect' }] },
    ])
    api.readArtifactVersion = async () => { throw new Error('读取暂时失败') }
    expect(await dispatchCommand(api, 'readArtifactVersion', { versionId: 'fixed:v1' }))
      .toEqual({ ok: false, error: '读取暂时失败' })
  })
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
  it('P38 testKnowledgeConnection 整对象透传连接草稿，门面不拆字段', async () => {
    const api = fakeApi()
    const draft = { enabled: true, endpoint: 'https://wiki.example.test', authRef: '', protocol: 'generic-json', scope: '', readOnly: true, maxBytes: 262144 }
    await dispatchCommand(api, 'testKnowledgeConnection', draft)
    expect(api.calls).toEqual([{ name: 'testKnowledgeConnection', args: [draft] }])
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
  it('编制取消后六条编制命令不再出现在命令表：一律中文「未知命令」且不调 UiApi', async () => {
    const api = fakeApi()
    const removed = [
      'saveDepartment', 'archiveDepartment', 'savePosition', 'archivePosition', 'assignPosition', 'unassignPosition',
    ]
    for (const name of removed) {
      const result = await dispatchCommand(api, name, { id: 'x', name: '旧编制入参' })
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.error).toContain('未知命令')
    }
    // 命令表里已经没有这些名字，引擎侧一次都不该被调到。
    expect(api.calls).toEqual([])
  })
  it('V2-PH2-04 saveResource/setGrant 整对象透传（不挑字段，zod 校验留给 core）', async () => {
    const api = fakeApi()
    const saveInput = { name: '手册', kind: 'file', locator: '/x/shared/a.md', sensitivity: 'restricted' }
    const grantInput = { resourceId: 'res_1', subjectKind: 'bot', subjectId: 'b_1', level: 'read' }
    await dispatchCommand(api, 'saveResource', saveInput)
    await dispatchCommand(api, 'setGrant', grantInput)
    expect(api.calls).toEqual([
      { name: 'saveResource', args: [saveInput] },
      { name: 'setGrant', args: [grantInput] },
    ])
    // 引用相等：门面没有拷贝/重包一层。
    expect(api.calls[0]!.args[0]).toBe(saveInput)
    expect(api.calls[1]!.args[0]).toBe(grantInput)
  })
  it('V2-PH2-04 archiveResource 只收 id 字符串，多余字段不透进引擎；缺 id 中文失败且不调 UiApi', async () => {
    const api = fakeApi()
    await dispatchCommand(api, 'archiveResource', { id: 'res_1', name: '不该被透传' })
    expect(api.calls).toEqual([{ name: 'archiveResource', args: ['res_1'] }])
    const missing = await dispatchCommand(api, 'archiveResource', {})
    const blank = await dispatchCommand(api, 'archiveResource', { id: '  ' })
    expect(missing.ok).toBe(false)
    expect(blank.ok).toBe(false)
    expect(missing.ok ? '' : missing.error).toContain('id')
    // 缺参在边界就拦住，引擎侧一次都不该被调到。
    expect(api.calls).toHaveLength(1)
  })
  it('V2-PH2-04 core 抛错时资料命令透传中文失败，不冒充成功', async () => {
    const api = fakeApi()
    ;(api.saveResource as any) = () => Promise.reject(new Error('资料路径必须位于共享目录之内'))
    expect(await dispatchCommand(api, 'saveResource', { name: 'x', kind: 'file', locator: '/etc/passwd' }))
      .toEqual({ ok: false, error: '资料路径必须位于共享目录之内' })
  })
  it('V2-PH4-02 saveProject/saveTask/rejectTask 整对象透传（不挑字段，zod 校验留给 core）', async () => {
    const api = fakeApi()
    const projectInput = { name: '新项目', charter: '目标', ownerBotId: null, memberBotIds: ['bot_1'] }
    const taskInput = { projectId: 'prj_1', title: '新任务', detail: '', assigneeBotId: null }
    const rejectInput = { id: 'pt_1', rejectReason: '信源没覆盖全' }
    await dispatchCommand(api, 'saveProject', projectInput)
    await dispatchCommand(api, 'saveTask', taskInput)
    await dispatchCommand(api, 'rejectTask', rejectInput)
    expect(api.calls).toEqual([
      { name: 'saveProject', args: [projectInput] },
      { name: 'saveTask', args: [taskInput] },
      { name: 'rejectTask', args: [rejectInput] },
    ])
    // 引用相等：门面没有拷贝/重包一层。
    expect(api.calls[0]!.args[0]).toBe(projectInput)
    expect(api.calls[1]!.args[0]).toBe(taskInput)
    expect(api.calls[2]!.args[0]).toBe(rejectInput)
  })
  it('F12 assignTask 整对象透传（任务/队友缺参或类型不对由 core zod 报中文错）', async () => {
    const api = fakeApi()
    const assignInput = { taskId: 'pt_1', botId: 'bot_1' }
    await dispatchCommand(api, 'assignTask', assignInput)
    expect(api.calls).toEqual([{ name: 'assignTask', args: [assignInput] }])
    expect(api.calls[0]!.args[0]).toBe(assignInput)
  })
  it('F08 attachTaskArtifact 整对象透传（任务/产物是否存在、上限由 core 判定）', async () => {
    const api = fakeApi()
    const attachInput = { taskId: 'pt_1', artifactId: 'av_2' }
    await dispatchCommand(api, 'attachTaskArtifact', attachInput)
    expect(api.calls).toEqual([{ name: 'attachTaskArtifact', args: [attachInput] }])
    expect(api.calls[0]!.args[0]).toBe(attachInput)
  })
  it('V2-PH4-04 dispatchTask 整对象透传：projectId/taskId/botId/note 原样进 core（引用相等）', async () => {
    const api = fakeApi()
    const dispatchInput = { projectId: 'prj_1', taskId: 'pt_1', botId: 'bot_1', note: '今天先出初稿' }
    await dispatchCommand(api, 'dispatchTask', dispatchInput)
    // 无留言的形状同样整对象透传，边界不挑字段。
    const bareInput = { projectId: 'prj_1', taskId: 'pt_2', botId: 'bot_2' }
    await dispatchCommand(api, 'dispatchTask', bareInput)
    expect(api.calls).toEqual([
      { name: 'dispatchTask', args: [dispatchInput] },
      { name: 'dispatchTask', args: [bareInput] },
    ])
    expect(api.calls[0]!.args[0]).toBe(dispatchInput)
    expect(api.calls[1]!.args[0]).toBe(bareInput)
  })
  it('V2-PH4-04 反例：raw 为 null/undefined 时门面不拆字段、不崩溃，core zod 的中文报错原样返回', async () => {
    const api = fakeApi()
    // 模拟 core DispatchTaskSchema 对非对象入参的 zod 中文报错（门面只透传，不替 core 校验形状）。
    ;(api.dispatchTask as any) = (raw: unknown) => {
      api.calls.push({ name: 'dispatchTask', args: [raw] })
      if (raw === null || raw === undefined || typeof raw !== 'object') {
        return Promise.reject(new Error('任务派活：期望对象输入'))
      }
      return Promise.resolve({ ok: true })
    }
    for (const raw of [null, undefined]) {
      const result = await dispatchCommand(api, 'dispatchTask', raw as unknown as Record<string, unknown>)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.error).toContain('任务派活')
    }
    // 与整对象透传一致：门面没有因为 raw 为 null 就跳过引擎，调用确实到达了 UiApi。
    expect(api.calls).toHaveLength(2)
  })
  it('V2-PH4-02 九条状态流转命令只收 id 字符串，多余字段不透进引擎', async () => {
    const api = fakeApi()
    const idCommands = [
      'pauseProject', 'resumeProject', 'completeProject', 'archiveProject', 'restoreProject',
      'taskBlock', 'taskResume', 'reportDone', 'acceptTask',
    ] as const
    for (const name of idCommands) {
      await dispatchCommand(api, name, { id: `${name}_id`, title: '不该被透传' })
    }
    expect(api.calls).toEqual(idCommands.map(name => ({ name, args: [`${name}_id`] })))
  })
  it('反例：项目/任务状态流转缺 id 或空白 id → 中文失败且完全不调 UiApi', async () => {
    const api = fakeApi()
    const names = [
      'pauseProject', 'resumeProject', 'completeProject', 'archiveProject', 'restoreProject',
      'taskBlock', 'taskResume', 'reportDone', 'acceptTask',
    ] as const
    for (const name of names) {
      const missing = await dispatchCommand(api, name, {})
      const blank = await dispatchCommand(api, name, { id: '   ' })
      expect(missing.ok).toBe(false)
      expect(blank.ok).toBe(false)
      expect(missing.ok ? '' : missing.error).toContain('id')
      expect(blank.ok ? '' : blank.error).toContain('id')
    }
    expect(api.calls).toEqual([])
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
  it('DisabledHub：账本只读返回空，不把整页打成错误', async () => {
    const hub = new DisabledHub('中心已停用')
    expect(await hub.wakeLedger('b_1')).toEqual([])
    expect(await hub.wakeLedgerDetail('wk_1')).toBeNull()
  })
  it('RealHubFacade 把账本读法转给 core 的同步接口（limit/before 原样传）', async () => {
    const api = fakeApi()
    const hub = { subscribe: () => () => undefined, api } as any
    const facade = new RealHubFacade(hub, fakeStore(null))
    expect(await facade.wakeLedger('b_1')).toEqual([])
    expect(await facade.wakeLedger('b_1', { limit: 5, before: 1000 })).toEqual([])
    expect(await facade.wakeLedgerDetail('w_1')).toBeNull()
    expect(api.calls).toEqual([
      { name: 'wakeLedgerList', args: ['b_1', undefined, undefined] },
      { name: 'wakeLedgerList', args: ['b_1', 5, 1000] },
      { name: 'wakeLedgerDetail', args: ['w_1'] },
    ])
  })
  it('F03 办公室视图 office() 直通 core officeView（同一引用，不包一层）', async () => {
    const api = fakeApi()
    const hub = { subscribe: () => () => undefined, api } as any
    const facade = new RealHubFacade(hub, fakeStore(null))
    expect(await facade.office()).toBe(OFFICE_SENTINEL)
    expect(api.calls).toEqual([]) // 读法不进命令记录
  })
  it('DisabledHub：停用后办公室给一间空房间（无座位、门口无待办），不把整页打成错误', async () => {
    const office = await new DisabledHub('x').office()
    expect(office.seats).toEqual([])
    expect(office.doorway.count).toBe(0)
    expect(office.doorway.items).toEqual([])
    expect(office.health.ok).toBe(false)
    expect(office.truncated).toBe(false)
  })
  it('LazyHubFacade 已接通时 office() 转给底层门面', async () => {
    const lazy = new LazyHubFacade()
    await expect(lazy.office()).rejects.toThrow('尚未就绪')
    lazy.setImpl(new DisabledHub('已停用'))
    const office = await lazy.office()
    expect(office.seats).toEqual([])
    expect(office.doorway.count).toBe(0)
  })
  it('V2-PH2-04 RealHubFacade.resource() 直通 core resourceView（同一引用，不包一层）', async () => {
    const api = fakeApi()
    const hub = { subscribe: () => () => undefined, api } as any
    const facade = new RealHubFacade(hub, fakeStore(null))
    expect(await facade.resource()).toEqual({ resources: [] })
    expect(api.calls).toEqual([]) // 读法不进命令记录
  })
  it('V2-PH2-04 DisabledHub：停用后资料矩阵给空视图（计数全 0、列表全空），每次返回副本', async () => {
    const hub = new DisabledHub('x')
    const resource = await hub.resource()
    expect(resource.resources).toEqual([])
    expect(resource.grants).toEqual([])
    expect(resource.counts).toEqual({ total: 0, active: 0, archived: 0, grants: 0 })
    expect(await new DisabledHub('x').resource()).not.toBe(resource)
  })
  it('V2-PH2-04 LazyHubFacade.resource() 未就绪抛中文错误；接通后转给底层门面', async () => {
    const lazy = new LazyHubFacade()
    await expect(lazy.resource()).rejects.toThrow('尚未就绪')
    lazy.setImpl(new DisabledHub('已停用'))
    const resource = await lazy.resource()
    expect(resource.counts.total).toBe(0)
  })
  it('V2-PH4-02 RealHubFacade.project() 直通 core projectView（同一引用，不包一层）', async () => {
    const api = fakeApi()
    const hub = { subscribe: () => () => undefined, api } as any
    const facade = new RealHubFacade(hub, fakeStore(null))
    expect(await facade.project()).toEqual({ projects: [] })
    expect(api.calls).toEqual([]) // 读法不进命令记录
  })
  it('V2-PH4-02 DisabledHub：停用后项目页给空视图（计数全 0、列表全空），每次返回副本', async () => {
    const hub = new DisabledHub('x')
    const project = await hub.project()
    expect(project.projects).toEqual([])
    expect(project.counts).toEqual({
      active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0,
    })
    // 每次返回副本：调用方改不到门面内部的空视图。
    expect(await new DisabledHub('x').project()).not.toBe(project)
  })
  it('V2-PH4-02 LazyHubFacade.project() 未就绪抛中文错误；接通后转给底层门面', async () => {
    const lazy = new LazyHubFacade()
    await expect(lazy.project()).rejects.toThrow('尚未就绪')
    lazy.setImpl(new DisabledHub('已停用'))
    const project = await lazy.project()
    expect(project.counts.total).toBe(0)
  })
})
