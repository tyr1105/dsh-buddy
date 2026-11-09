/**
 * P43 内部导航归位测试：上次表面（视图 + 线程）的存取与兜底、
 * 提示点进来先记目标再切队友、键盘切换后的焦点归位，以及页面消费一次后清空。
 *
 * 为什么用纯函数与静态契约：测试环境把 react 指到桩（见 vitest.config.ts），
 * 组件不渲染；这里锁定存储格式与接线形状，真实浏览器行为由 P43 走查脚本覆盖。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSurface, saveSurface, spaceModeStorageKey, spaceSurfaceStorageKey } from '../src/client/logic/mode-nav.js'
import { focusAfterSwitch, type FocusDoc } from '../src/client/logic/space-focus.js'

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, clientRoot), 'utf8')

/** 内存版 localStorage：key 任意，方便假装别的键或坏值。 */
function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  data: Map<string, string>
} {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    data,
  }
}

describe('上次表面的存取', () => {
  it('没有记录、空串或空对象都按「没有上次表面」处理', () => {
    expect(readSurface(() => memoryStorage())).toBeNull()
    expect(readSurface(() => memoryStorage({ [spaceSurfaceStorageKey]: '' }))).toBeNull()
    expect(readSurface(() => null)).toBeNull()
  })

  it('写入后能按原样读回视图与线程', () => {
    const storage = memoryStorage()
    saveSurface(() => storage, { view: 'inbox', threadId: 'bot-tanlu' })
    expect(readSurface(() => storage)).toEqual({ view: 'inbox', threadId: 'bot-tanlu' })
  })

  it('坏 JSON、非对象、未知视图、空线程都落回默认表面', () => {
    const at = (value: string): ReturnType<typeof readSurface> =>
      readSurface(() => memoryStorage({ [spaceSurfaceStorageKey]: value }))
    expect(at('{')).toBeNull()
    expect(at('null')).toBeNull()
    expect(at('3')).toBeNull()
    expect(at(JSON.stringify({ view: 'secret', threadId: 'bot-1' }))).toBeNull()
    expect(at(JSON.stringify({ view: 'main', threadId: '' }))).toBeNull()
    expect(at(JSON.stringify({ view: 'main', threadId: '   ' }))).toBeNull()
    expect(at(JSON.stringify({ view: 'main' }))).toBeNull()
  })

  it('存储抛错时读写都不外抛', () => {
    const broken = () => ({
      getItem: () => { throw new Error('隐私模式') },
      setItem: () => { throw new Error('配额不足') },
    })
    expect(readSurface(broken)).toBeNull()
    expect(() => saveSurface(broken, { view: 'main', threadId: 'team' })).not.toThrow()
  })

  it('表面与模式各用独立键，互不覆盖', () => {
    const storage = memoryStorage()
    saveSurface(() => storage, { view: 'office', threadId: 'team' })
    expect(storage.data.get(spaceSurfaceStorageKey)).toBe(JSON.stringify({ view: 'office', threadId: 'team' }))
    expect(storage.data.has(spaceModeStorageKey)).toBe(false)
  })
})

describe('键盘切换后的焦点归位', () => {
  const teamFirst = '.ah-team-sidebar .ah-nav-office'
  const teamAny = '.ah-team-sidebar button'
  const teamSwitch = '.ah-space-switch-btn[data-space-mode="team"]'
  const chatSwitch = '.ah-space-switch-btn[data-space-mode="chat"]'

  /** 假文档：按选择器决定节点是否存在，并记录谁被聚焦。 */
  function docWith(found: Record<string, boolean>): { doc: FocusDoc; focused: string[] } {
    const focused: string[] = []
    const doc: FocusDoc = {
      querySelector: selector => (found[selector]
        ? { focus: () => { focused.push(selector) } } as unknown as Element
        : null),
    }
    return { doc, focused }
  }

  /** 手动帧队列：由测试决定何时进入下一帧。 */
  function queue(): { schedule: (run: () => void) => void; step: () => void; flush: () => void } {
    const jobs: Array<() => void> = []
    return {
      schedule: run => { jobs.push(run) },
      step: () => { jobs.shift()?.() },
      flush: () => { let n = 0; while (jobs.length > 0 && n < 100) { jobs.shift()!(); n += 1 } },
    }
  }

  it('队友侧优先落到队友导航第一行', () => {
    const { doc, focused } = docWith({ [teamFirst]: true, [teamAny]: true })
    const frames = queue()
    focusAfterSwitch('team', doc, frames.schedule)
    frames.flush()
    expect(focused).toEqual([teamFirst])
  })

  it('侧栏晚挂载时继续等后续帧，不立刻退回切换按钮', () => {
    let ready = false
    const focused: string[] = []
    const doc: FocusDoc = {
      querySelector: selector => (selector === teamFirst && ready
        ? { focus: () => { focused.push(selector) } } as unknown as Element
        : null),
    }
    const frames = queue()
    focusAfterSwitch('team', doc, frames.schedule)
    frames.step()
    frames.step()
    expect(focused).toEqual([])
    ready = true
    frames.step()
    expect(focused).toEqual([teamFirst])
  })

  it('一直找不到内容区目标时，等完重试帧数后退回切换按钮', () => {
    const { doc, focused } = docWith({ [teamSwitch]: true, [chatSwitch]: true })
    const frames = queue()
    focusAfterSwitch('team', doc, frames.schedule)
    frames.flush()
    expect(focused).toEqual([teamSwitch])
  })

  it('对话侧不碰原生列表，直接把焦点放回「对话」按钮', () => {
    const { doc, focused } = docWith({ [chatSwitch]: true })
    let scheduled = 0
    focusAfterSwitch('chat', doc, () => { scheduled += 1 })
    expect(focused).toEqual([chatSwitch])
    expect(scheduled).toBe(0)
  })

  it('没有下一帧能力时只立即试一次', () => {
    const { doc, focused } = docWith({ [teamFirst]: true })
    focusAfterSwitch('team', doc)
    expect(focused).toEqual([teamFirst])
  })
})

describe('提示进入与焦点归位（源码契约）', () => {
  const index = read('index.tsx')

  it('点提示先记收件箱目标，再切队友侧开中心页', () => {
    const body = index.slice(index.indexOf('const openInboxFromToast'), index.indexOf('// 2) 样式'))
    expect(body).toContain('inboxFocus.set(inboxItemId)')
    expect(body).toContain("switchSpace('team', 'pointer')")
    expect(body.indexOf('inboxFocus.set')).toBeLessThan(body.indexOf('switchSpace'))
  })

  it('提示层只交 onOpen，不再自己碰面板', () => {
    expect(index).toContain('HubToastOverlay({ hub, onOpen: openInboxFromToast })')
    expect(index).not.toContain('HubToastOverlay({ hub, clientCtx: ctx })')
  })

  it('只有键盘来源才归位焦点，鼠标切换不抢焦点', () => {
    expect(index).toContain("if (source === 'keyboard') focusOnSwitch(next)")
    expect(index).toContain('focusAfterSwitch(next, document)')
  })

  it('启动恢复上次表面并持续写入（值不变不重复写）', () => {
    expect(index).toContain('readSurface(storage)')
    expect(index).toContain('view: saved.view, selectedThread: saved.threadId')
    expect(index).toContain('saveSurface(storage, { view: current.view, threadId: current.selectedThread })')
    expect(index).toContain('hub.subscribe(write)')
    expect(index).toContain("'dsh-buddy: surface'")
  })
})

describe('表面消费与提示层（源码契约）', () => {
  const page = read('pages/HubPage.tsx')
  const toast = read('components/HubToastOverlay.tsx')

  it('HubPage 接收 inboxFocus，并有空仓库兜底保证 hooks 顺序', () => {
    expect(page).toContain('inboxFocus?: Store<string | null>')
    expect(page).toContain('EMPTY_INBOX_FOCUS')
    expect(page).toContain('props.inboxFocus ?? EMPTY_INBOX_FOCUS')
  })

  it('消费目标后切到收件箱、定位该项并清空仓库', () => {
    const body = page.slice(page.indexOf('const pendingInboxFocus'), page.indexOf('// 选中机器人时拉它的详情'))
    expect(body).toContain("hub.setView('inbox')")
    expect(body).toContain('setFocusInboxId(pendingInboxFocus)')
    expect(body).toContain('void hub.refreshInbox()')
    expect(body).toContain('inboxFocusStore.set(null)')
  })

  it('提示层点击：先收起提示、打开收件箱并刷新，再交给 onOpen 切空间', () => {
    expect(toast).toContain('onOpen: (inboxItemId: string) => void')
    expect(toast).not.toContain('clientCtx')
    expect(toast).not.toContain('selectPanel')
    const body = toast.slice(toast.indexOf('onClick={() => {'), toast.indexOf('}}>'))
    expect(body).toContain('dismissToast')
    expect(body).toContain("setView('inbox')")
    expect(body).toContain('refreshInbox')
    expect(body).toContain('props.onOpen(toast.inboxItemId)')
  })
})
