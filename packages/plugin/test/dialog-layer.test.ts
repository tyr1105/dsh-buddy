/**
 * 弹窗叠弹窗：下层弹窗不能把叠在上面的弹窗设成不可交互（2026-11-10 主人发现
 * 「编辑项目 → 归档项目」确认框的按钮全都点不动）。
 *
 * 插件测试环境没有真 DOM，所以把判断抽成纯函数 containsNewerDialog，用假节点测：
 * 节点只需要 matches / getAttribute / querySelectorAll 三个能力。
 */
import { describe, expect, it } from 'vitest'
import { DIALOG_LAYER_ATTR, containsNewerDialog, holdInert, releaseInert, type LayerProbe } from '../src/client/components/use-dialog-focus.js'

/** 造一个假节点：modal 表示它自己是不是模态弹窗，layer 是它登记的层号（null 表示还没登记），inner 是里面的模态弹窗层号。 */
function fakeNode(opts: { modal?: boolean; layer?: string | null; inner?: Array<string | null> }): LayerProbe {
  const attr = (value: string | null | undefined) => (name: string) => (name === DIALOG_LAYER_ATTR ? (value ?? null) : null)
  return {
    matches: selector => selector === '[aria-modal="true"]' && opts.modal === true,
    getAttribute: attr(opts.layer),
    querySelectorAll: () => (opts.inner ?? []).map(layer => ({ getAttribute: attr(layer) })),
  }
}

describe('containsNewerDialog：只隔离比自己早的内容', () => {
  it('后打开、层号更大的弹窗算更晚，下层不隔离它', () => {
    expect(containsNewerDialog(fakeNode({ modal: true, layer: '5' }), 4)).toBe(true)
  })

  it('刚挂上、还没登记层号的弹窗也算更晚（确认框的初始化还没跑）', () => {
    expect(containsNewerDialog(fakeNode({ modal: true, layer: null }), 4)).toBe(true)
  })

  it('比自己早打开的弹窗照常隔离（确认框打开时把编辑弹窗设成不可交互）', () => {
    expect(containsNewerDialog(fakeNode({ modal: true, layer: '3' }), 4)).toBe(false)
  })

  it('普通背景内容（不是弹窗、里面也没有弹窗）照常隔离', () => {
    expect(containsNewerDialog(fakeNode({}), 4)).toBe(false)
  })

  it('节点里面包着一个更晚的弹窗时，整个节点都不隔离', () => {
    expect(containsNewerDialog(fakeNode({ inner: ['2', '7'] }), 4)).toBe(true)
  })

  it('节点里面只有更早的弹窗时照常隔离', () => {
    expect(containsNewerDialog(fakeNode({ inner: ['1', '2'] }), 4)).toBe(false)
  })
})

describe('holdInert / releaseInert：几层弹窗一起关时页面要还原', () => {
  it('编辑弹窗先放手、确认框后放手（两层同时关）：最后页面可交互', () => {
    const page = { inert: false }
    holdInert(page) // 编辑弹窗打开
    holdInert(page) // 确认框叠上来
    releaseInert(page) // React 先清理编辑弹窗
    expect(page.inert).toBe(true)
    releaseInert(page) // 再清理确认框
    expect(page.inert).toBe(false)
  })

  it('反过来的顺序同样还原', () => {
    const page = { inert: false }
    holdInert(page)
    holdInert(page)
    releaseInert(page)
    releaseInert(page)
    expect(page.inert).toBe(false)
  })

  it('只关上面一层（点取消）：下面那层还压着，页面保持不可交互', () => {
    const page = { inert: false }
    holdInert(page)
    holdInert(page)
    releaseInert(page)
    expect(page.inert).toBe(true)
  })

  it('原本就不可交互的节点（比如被抽屉设过），弹窗放手后保持原样', () => {
    const page = { inert: true }
    holdInert(page)
    releaseInert(page)
    expect(page.inert).toBe(true)
  })

  it('没压过的节点放手不报错、不改值', () => {
    const page = { inert: false }
    releaseInert(page)
    expect(page.inert).toBe(false)
  })
})
