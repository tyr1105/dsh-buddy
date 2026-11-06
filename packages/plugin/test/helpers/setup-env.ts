/**
 * vitest setupFiles（D07 第 22 条）：把 HOME 与 AGENT_HUB_ROOT 指到 mkdtemp 临时目录。
 * 双保险的第二道：即使某个测试忘了传 rootDir（第一道守护在 resolveRootDir 里会抛错），
 * 任何默认解析也只能写进临时目录，绝不碰主人真实的 ~/AgentHub。
 * 每个测试文件一份独立临时目录；进程退出时由操作系统回收（TMPDIR 下）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hub-vitest-home-'))
process.env.HOME = sandbox
process.env.AGENT_HUB_ROOT = join(sandbox, 'AgentHub')
