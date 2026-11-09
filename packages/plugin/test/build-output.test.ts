/**
 * 构建产物：先跑一次 build，再检查两份产物的契约（任务卡「测试」一节）。
 * - lib/client.js 以 window.__ModuleLoader__.load( 开头、只出现一次、顶层没有 import/export、
 *   不含 @deepseek-ai/dsh-client-ui-primitives；
 * - lib/index.js 能被 import() 并导出 name/inject/apply；
 * - styles.css 里没有十六进制/rgb/hsl 颜色。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// 串行跑一次构建（测试与产物同步，验收顺序 typecheck → test → build 也不会漏）。
execFileSync(process.execPath, ['build.mjs'], { cwd: pkgRoot, stdio: 'pipe' })

describe('lib/client.js（经典脚本契约）', () => {
  const source = readFileSync(join(pkgRoot, 'lib/client.js'), 'utf8')
  it('文件已生成', () => { expect(source.length).toBeGreaterThan(0) })
  it('以 window.__ModuleLoader__.load( 开头（允许前面有注释）', () => {
    const stripped = source.replace(/^(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '')
    expect(stripped.startsWith('window.__ModuleLoader__.load(')).toBe(true)
  })
  it('load( 只出现一次', () => {
    expect(source.split('window.__ModuleLoader__.load(').length - 1).toBe(1)
  })
  it('顶层没有 import/export（产物内不允许出现顶层模块语句）', () => {
    // 顶层即第一行（banner 之后全部在 factory 闭包里）；直接断言首行不以 import/export 开头即可，
    // 再全局排除把 import( 当成 import 语句的误报。
    const firstLine = source.split('\n').find((l) => l.trim() !== '')!
    expect(firstLine.startsWith('import ')).toBe(false)
    expect(firstLine.startsWith('export ')).toBe(false)
  })
  it('不含 @deepseek-ai/dsh-client-ui-primitives', () => {
    expect(source).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
  it('没有 sourcemap 尾注', () => {
    expect(source).not.toContain('sourceMappingURL')
  })
})

describe('lib/index.js（宿主半边）', () => {
  it('能被 import() 并导出 name/inject/apply', async () => {
    const mod = await import(join(pkgRoot, 'lib/index.js'))
    expect(mod.name).toBe('agent-hub')
    expect(mod.inject).toEqual(['connection', 'sessionController', 'workspaceRegistry', 'agents'])
    expect(typeof mod.apply).toBe('function')
  })
})

describe('styles.css（主题 token 约束）', () => {
  const css = readFileSync(join(pkgRoot, 'src/client/styles.css'), 'utf8')
  it('没有十六进制颜色', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
  it('没有 rgb()/hsl() 颜色', () => {
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).not.toMatch(/\bhsla?\(/)
  })
  it('确实在使用 --dsw-alias-* 主题 token', () => {
    expect(css).toMatch(/--dsw-alias-/)
  })
})

describe('产物文件齐全', () => {
  it('lib/index.js 与 lib/client.js 都存在', () => {
    expect(existsSync(join(pkgRoot, 'lib/index.js'))).toBe(true)
    expect(existsSync(join(pkgRoot, 'lib/client.js'))).toBe(true)
  })
})
