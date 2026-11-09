/**
 * 功能导航记忆的边界：只有明确的折叠偏好才收起，存储异常不能妨碍本次操作。
 * DOM 交互、原生菜单恢复与侧栏空间变化另由真实浏览器走查。
 */
import { describe, expect, it } from 'vitest'
import { navigationStorageKey, readNavigationCollapsed, saveNavigationCollapsed } from '../src/client/logic/host-navigation.js'

describe('功能导航的本机记忆', () => {
  it('明确折叠时恢复，明确展开时保留菜单', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    saveNavigationCollapsed(() => storage, true)
    expect(values.get(navigationStorageKey)).toBe('true')
    expect(readNavigationCollapsed(() => storage)).toBe(true)
    saveNavigationCollapsed(() => storage, false)
    expect(readNavigationCollapsed(() => storage)).toBe(false)
  })
  it('初次使用和损坏的旧值默认展开', () => {
    for (const value of [null, '', '1', '{}', 'null', 'undefined']) {
      expect(readNavigationCollapsed(() => ({ getItem: () => value, setItem() {} }))).toBe(false)
    }
    expect(readNavigationCollapsed(() => null)).toBe(false)
  })
  it('读取存储对象或值失败时默认展开', () => {
    expect(readNavigationCollapsed(() => { throw new Error('存储权限被禁用') })).toBe(false)
    expect(readNavigationCollapsed(() => ({ getItem() { throw new Error('读取失败') }, setItem() {} }))).toBe(false)
  })
  it('写入存储失败不向界面抛错', () => {
    expect(() => saveNavigationCollapsed(() => { throw new Error('存储权限被禁用') }, true)).not.toThrow()
    expect(() => saveNavigationCollapsed(() => ({ getItem: () => null, setItem() { throw new Error('配额不足') } }), false)).not.toThrow()
    expect(() => saveNavigationCollapsed(() => null, true)).not.toThrow()
  })
})
