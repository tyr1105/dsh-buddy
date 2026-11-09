/**
 * 一级侧栏导航的安全边界：打不开宿主面板时保留当前线程，
 * 不能显示已经切换的假象；服务和回调异常不能传回宿主事件分发。
 */
import { describe, expect, it } from 'vitest'
import { openHubPanel } from '../src/client/logic/host-sidebar.js'

describe('一级侧栏打开队友', () => {
  it('先打开宿主面板，随后切换线程', () => {
    const calls: string[] = []
    const ctx = { get: (name: string) => {
      expect(name).toBe('layout')
      return { selectPanel: (key: string) => calls.push(key) }
    } }
    expect(openHubPanel(ctx, () => calls.push('thread'))).toBe(true)
    expect(calls).toEqual(['agent-hub', 'thread'])
  })
  it('宿主服务缺失时不改变线程', () => {
    let navigated = false
    expect(openHubPanel({}, () => { navigated = true })).toBe(false)
    expect(openHubPanel(null, () => { navigated = true })).toBe(false)
    expect(navigated).toBe(false)
  })
  it('宿主查服务或开面板失败时保留线程，异常不抛出', () => {
    let navigated = false
    const brokenGet = { get: () => { throw new Error('服务重载中') } }
    const brokenPanel = { get: () => ({ selectPanel: () => { throw new Error('面板重载中') } }) }
    expect(openHubPanel(brokenGet, () => { navigated = true })).toBe(false)
    expect(openHubPanel(brokenPanel, () => { navigated = true })).toBe(false)
    expect(navigated).toBe(false)
  })
  it('内部导航失败也被隔离', () => {
    expect(openHubPanel({ get: () => ({ selectPanel: () => {} }) }, () => { throw new Error('线程刷新失败') })).toBe(false)
  })
})
