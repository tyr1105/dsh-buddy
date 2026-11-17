/**
 * P69 B1：hub_project_put 出现在队友会话的工具里。
 * 用真实的中心（core 的 FakeHost）取工具清单，再经插件的安装器装进一个假的队友会话：
 * 工具是 for (const tool of hub.tools()) 整批登记的，不需要逐个点名，所以这里断言它真的在。
 * 反例：非队友会话什么都不装。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testing, type Hub } from '@agent-hub/core'
import { createEngineHub } from '../src/host/index.js'
import { createBotToolsInstaller } from '../src/host/bot-tools.js'

const roots: string[] = []
const hubs: Hub[] = []
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function fakeAgent(id: string) {
  const names: string[] = []
  const tools = {
    register: (def: any) => { names.push(def.name); return () => undefined },
    get: () => undefined,
    view: () => ({ visible: new Map(), knownNames: new Set<string>(), restrictableNames: new Set<string>() }),
    restrict: () => () => undefined,
  }
  return { agent: { id, session: { header: { origin: 'x' } }, ctx: { tools } }, names }
}

describe('hub_project_put 进入队友会话', () => {
  it('真实中心的工具清单里有它；装进队友会话后在登记名单中，描述不为空', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-hub-p69-'))
    roots.push(root)
    const parts = createEngineHub(root, new testing.FakeHost())
    hubs.push(parts.hub)
    const listed = parts.hub.tools().find(tool => tool.name === 'hub_project_put')
    expect(listed).toBeDefined()
    expect(listed!.description.length).toBeGreaterThan(0)

    const installer = createBotToolsInstaller({ hub: parts.hub, isBotSession: id => id === 'bot-s' })
    const bot = fakeAgent('bot-s')
    installer.install(bot.agent)
    expect(bot.names).toContain('hub_project_put')
    expect(bot.names).toContain('hub_outbox_submit') // 同一批里的老工具一起在，证明是整批装配

    const stranger = fakeAgent('plain-s')
    installer.install(stranger.agent)
    expect(stranger.names).toEqual([])
  })
})
