/**
 * D04 1b / D06 2、3：真引擎装配与新命令的接线测试。
 * - 1b：createEngineHub 把 ownerHome=os.homedir() 传给 core（M02 新接口）。验证方式：
 *   用 core 的 FakeHost 建一个真实 Hub 与机器人会话，敏感路径（~/.ssh/id_rsa、
 *   ~/.dsh/.credentials.yaml，含展开后的绝对路径形式）的动作闸一律拒绝——ownerHome
 *   没传时带 ~ 的路径只能按需审批、且无法识别主人目录下的敏感文件。
 * - D06：interruptBot 与 lifecycleAction 经路由命令直接交给 core（M07 新接口），
 *   插件不再自己 cancel 或写系统消息。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testing, type Hub } from '@agent-hub/core'
import { createEngineHub } from '../src/host/index.js'
import { RealHubFacade } from '../src/host/real-hub.js'

let rootDir: string
let host: testing.FakeHost
let hubs: Hub[]

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'agent-hub-engine-'))
  host = new testing.FakeHost()
  hubs = []
})

afterEach(async () => {
  // 同步动作守卫会排队异步落盘；必须先等中心串行收口，再移除自己的测试目录。
  for (const hub of hubs) await hub.stop()
  // 只删自己建在系统临时目录下的引擎根目录。
  await rm(rootDir, { recursive: true, force: true })
})

/** 建一个真实引擎（FakeHost）并创建一个机器人，返回引擎拼装件与机器人 id。 */
async function engineWithBot() {
  const parts = createEngineHub(rootDir, host)
  hubs.push(parts.hub)
  await parts.hub.start()
  const created = await parts.hub.api.createBot({
    name: '守门员', role: 'sentinel', persona: '测试用', aspirations: ['看好门'],
  })
  if (!created.ok || created.data === undefined) throw new Error(created.ok ? '没有返回机器人数据' : created.error)
  const botId = created.data.id
  const bot = await parts.hub.api.bot(botId)
  return { ...parts, botId, sessionId: bot.profile.sessionId! }
}

describe('D04 1b：ownerHome 传入后动作闸拒绝敏感读取', () => {
  it('read_file ~/.ssh/id_rsa 被拒绝（~ 展开成主人目录后命中敏感路径）', async () => {
    const { hub, sessionId } = await engineWithBot()
    const decision = hub.guardToolCall(sessionId, 'read_file', { path: '~/.ssh/id_rsa' })
    expect(decision.allow).toBe(false)
  })

  it('bash cat ~/.dsh/.credentials.yaml 被拒绝', async () => {
    const { hub, sessionId } = await engineWithBot()
    const decision = hub.guardToolCall(sessionId, 'bash', { command: 'cat ~/.dsh/.credentials.yaml' })
    expect(decision.allow).toBe(false)
  })

  it('主人目录展开后的绝对路径同样被拒绝（证明 ownerHome 确实传入了）', async () => {
    const { hub, sessionId } = await engineWithBot()
    const expanded = hub.guardToolCall(sessionId, 'read_file', { path: join(homedir(), '.ssh', 'id_rsa') })
    expect(expanded.allow).toBe(false)
    const expandedBash = hub.guardToolCall(sessionId, 'bash', { command: `cat ${join(homedir(), '.dsh', '.credentials.yaml')}` })
    expect(expandedBash.allow).toBe(false)
  })

  it('区分性反例：read_file ~/Documents/notes.txt 放行——ownerHome 没传时它会被拦成「需要主人批准」', async () => {
    // D05 第 20 条：敏感路径的拒绝与 ownerHome 无关（不传也一样拒绝），
    // 只有这条 ~ 路径能证明 ownerHome 确实传进了 createHub。
    const { hub, sessionId } = await engineWithBot()
    const decision = hub.guardToolCall(sessionId, 'read_file', { path: '~/Documents/notes.txt' })
    expect(decision.allow).toBe(true)
  })
})

describe('D06 2/3：interruptBot 与 lifecycleAction 经路由命令走 core', () => {
  it('interruptBot 交给 core：取消在跑回合、写系统线程消息（core 做，插件不再自己写）', async () => {
    const engine = await engineWithBot()
    const facade = new RealHubFacade(engine.hub)
    // 新建机器人的试跑唤醒正在 running（FakeHost 不回报合事件，正好保持在跑）。
    const result = await facade.command('interruptBot', { botId: engine.botId })
    expect(result.ok).toBe(true)
    expect((result as { data?: { canceledBy?: string } }).data?.canceledBy).toBe('owner')
    expect(host.calls.some(c => c.method === 'cancel' && c.args[0] === engine.sessionId)).toBe(true)
    // core 会写一次系统消息（插件侧的旧实现已删，这条来自 core）。
    const thread = await facade.thread(engine.botId)
    expect(thread.messages.some(m => m.kind === 'system' && m.text.includes('你打断了它'))).toBe(true)
    // 打断不算错误收尾（M07：不增加 consecutiveNoCommit / consecutiveErrors）。
    const bot = await engine.hub.api.bot(engine.botId)
    expect(bot.wakes.some(w => w.status === 'error')).toBe(false)
  })

  it('interruptBot 对空闲（已交账）机器人返回中文错误且不调 HostPort.cancel', async () => {
    const engine = await engineWithBot()
    // 让试跑回合正常结束（交账），机器人回到空闲。
    const at = engine.clock.now()
    await engine.hub.onTurnEvent({ type: 'started', sessionId: engine.sessionId, at })
    await engine.hub.onTurnEvent({ type: 'ended', sessionId: engine.sessionId, at: at + 1, finalText: '试跑完成', tokens: 5 })
    const facade = new RealHubFacade(engine.hub)
    const result = await facade.command('interruptBot', { botId: engine.botId })
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('没在处理')
    expect(host.calls.some(c => c.method === 'cancel')).toBe(false)
  })

  it('lifecycleAction：pause → paused；resume → probation；promote 未满 3 天给中文错误', async () => {
    const engine = await engineWithBot()
    const facade = new RealHubFacade(engine.hub)
    const paused = await facade.command('lifecycleAction', { botId: engine.botId, action: 'pause' })
    expect(paused.ok).toBe(true)
    expect(((paused as { data?: { lifecycle?: string } }).data)?.lifecycle).toBe('paused')
    const resumed = await facade.command('lifecycleAction', { botId: engine.botId, action: 'resume' })
    expect(((resumed as { data?: { lifecycle?: string } }).data)?.lifecycle).toBe('probation')
    const promoted = await facade.command('lifecycleAction', { botId: engine.botId, action: 'promote' })
    // 刚建的机器人试岗不满 3 天：core 拒绝并说明还差几天（以 core 的错误为准）。
    expect(promoted.ok).toBe(false)
    expect((promoted as { error: string }).error).toContain('天')
  })
})
