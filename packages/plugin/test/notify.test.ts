/** 通知工具的纯函数测试：转义、截断、平台判断。 */
import { describe, expect, it } from 'vitest'
import { escapeAppleScript, notifyCommandArgs, truncateForNotify } from '../src/host/notify.js'

describe('notify：AppleScript 转义与截断', () => {
  it('反斜杠与双引号会被转义，换行压成空格', () => {
    expect(escapeAppleScript('a\\b"c\nd')).toBe('a\\\\b\\"c d')
    expect(escapeAppleScript('普通正文')).toBe('普通正文')
  })
  it('按字符截断到 200 字（正例恰好 200、反例不超）', () => {
    expect([...truncateForNotify('a'.repeat(300))].length).toBe(200)
    expect(truncateForNotify('短文本')).toBe('短文本')
    expect([...truncateForNotify('你'.repeat(300))].length).toBe(200)
  })
  it('非 macOS 平台不生成命令', () => {
    expect(notifyCommandArgs('标题', '正文', 'linux')).toBeNull()
    expect(notifyCommandArgs('标题', '正文', 'win32')).toBeNull()
  })
  it('macOS 平台生成 -e 参数且正文已转义、已截断', () => {
    const maybe = notifyCommandArgs('标题"x', `${'长'.repeat(250)}"引号"`, 'darwin')
    expect(maybe).not.toBeNull()
    const args = maybe as string[]
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('display notification')
    expect(args[1]).toContain('标题\\"x')
    expect([...args[1]!].length).toBeLessThanOrEqual(400)
  })
  it('多字节字符截断后仍是合法字符串', () => {
    const args = notifyCommandArgs('t', '你'.repeat(300), 'darwin')
    expect(args?.[1]).not.toContain('undefined')
  })
})
