/**
 * 会话名册（D07 第 15 条）：把「会话 id → 机器人 id」持久化到
 * `<rootDir>/.hub/plugin/session-roster.json`，createSession 成功即记。
 * 为什么需要：core 的 botIdForSession 只认「当前绑定」的会话，M07 的 interruptBot
 * 打断后会解绑；插件重载或 DSH 重启后，prereg 是新的空 Map，这些旧机器人会话就
 * 认不出来了——它们的工具调用会绕过动作闸、回合结束会被当成外部会话上报。
 * 有了持久名册，重启后 isBotSession 照样命中：工具过闸、事件交给 core（core 对
 * 已解绑会话的事件本来就会忽略）。
 * 写入策略：每次变更先写同目录临时文件再原子改名；失败只记日志，绝不影响建会话。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 名册的磁盘形状（版本字段留作以后迁移）。 */
interface RosterFile { version: 1; sessions: Record<string, string> }

/** 名册的最小接口：与原来传给 host-port 的 Map<string,string> 用法兼容。 */
export interface SessionRoster {
  get(sessionId: string): string | undefined
  set(sessionId: string, botId: string): void
  delete(sessionId: string): void
  has(sessionId: string): boolean
  keys(): IterableIterator<string>
  /** 名册里的全部会话 id（诊断与测试用）。 */
  sessionIds(): string[]
}

/** 内存版名册（样例数据 / 停用模式用；行为与原 Map 完全一致）。 */
export function inMemoryRoster(): SessionRoster {
  const map = new Map<string, string>()
  return {
    get: id => map.get(id),
    set: (id, botId) => { map.set(id, botId) },
    delete: id => { map.delete(id) },
    has: id => map.has(id),
    keys: () => map.keys(),
    sessionIds: () => [...map.keys()],
  }
}

/**
 * 从文件加载持久名册：文件不存在或内容坏了都从空名册开始（不抛错——名册只是
 * 识别辅助，绝不能因为它起不了引擎）。之后每次 set/delete 都尝试落盘。
 */
export function loadSessionRoster(file: string): SessionRoster {
  const sessions = new Map<string, string>()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RosterFile
    if (raw && typeof raw === 'object' && raw.sessions != null && typeof raw.sessions === 'object') {
      for (const [id, botId] of Object.entries(raw.sessions)) {
        if (typeof id === 'string' && id !== '' && typeof botId === 'string' && botId !== '') sessions.set(id, botId)
      }
    }
  } catch { /* 文件不存在或损坏：从空名册开始 */ }

  const persist = (): void => {
    try {
      const payload: RosterFile = { version: 1, sessions: Object.fromEntries(sessions) }
      // .hub/plugin 目录可能还不存在（core 只建自己用的子目录）：先递归建目录。
      mkdirSync(dirname(file), { recursive: true })
      const tmp = join(dirname(file), `.session-roster.${process.pid}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      // 落盘失败只记日志：名册是辅助识别，绝不能拖垮建会话。
      console.error('[agent-hub] 会话名册落盘失败:', error)
    }
  }

  return {
    get: id => sessions.get(id),
    set: (id, botId) => { sessions.set(id, botId); persist() },
    delete: id => { if (sessions.delete(id)) persist() },
    has: id => sessions.has(id),
    keys: () => sessions.keys(),
    sessionIds: () => [...sessions.keys()],
  }
}

/** 名册文件的位置（<rootDir>/.hub/plugin/session-roster.json，任务卡点名的路径）。 */
export function rosterFilePath(rootDir: string): string {
  return join(rootDir, '.hub', 'plugin', 'session-roster.json')
}
