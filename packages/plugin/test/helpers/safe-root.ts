/**
 * 测试守护（D05 第 2 条 / D07 第 22 条）：任何会启动真引擎的测试，根目录绝不允许
 * 是主人真实的 ~/AgentHub。守护分两道：
 * 1. vitest setupFiles 把 HOME 与 AGENT_HUB_ROOT 指到 mkdtemp 临时目录（setup-env.ts）；
 * 2. resolveRootDir 在 VITEST 环境下对「落到默认 ~/AgentHub 的解析」直接抛错。
 * 本文件只再提供 mkdtemp 临时根目录与一个直接断言辅助（对既有 root 变量复检用）。
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 HOME 下的默认根目录（setupFiles 已把 HOME 指向临时目录，这里只是参照值）。 */
export const REAL_DEFAULT_ROOT = join(homedir(), 'AgentHub')

/**
 * 测试专用的根目录：mkdtemp 临时目录。真正的越界守护在 setup-env.ts 与
 * resolveRootDir 里（D07 第 22 条），这里不再重复比较环境变量。
 */
export function safeTempRoot(prefix = 'agent-hub-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 直接断言一个根目录不是当前 HOME 下的默认 ~/AgentHub（对既有 root 变量复检用）。 */
export function assertNotRealRoot(root: string): void {
  if (join(root) === REAL_DEFAULT_ROOT) {
    throw new Error(`测试守护：根目录解析成了 ${REAL_DEFAULT_ROOT}，测试不得使用`)
  }
}
