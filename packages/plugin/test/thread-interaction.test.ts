/**
 * 多行发送与滚动回归：覆盖输入法、换行、前插历史以及阅读期间收到长回复。
 * 以用户的阅读位置为断言，避免把错误的布局顺序固定成测试。
 */
import { describe, expect, it } from 'vitest'
import { isSendEnter, threadScrollTop } from '../src/client/logic/thread.js'

describe('输入与阅读位置', () => {
  it('普通回车发送；换行和中文候选确认不发送', () => {
    expect(isSendEnter({ key: 'Enter' })).toBe(true)
    expect(isSendEnter({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isSendEnter({ key: 'Enter', isComposing: true })).toBe(false)
    expect(isSendEnter({ key: 'Enter', keyCode: 229 })).toBe(false)
  })
  const base = { previousHeight: 1000, previousTop: 200, viewportHeight: 400, height: 1300, previousLastId: 'a', lastId: 'a' }
  it('加载更早的消息补回新增高度，原来读的内容留在视口', () => {
    expect(threadScrollTop(base)).toBe(500)
    expect(threadScrollTop({ ...base, height: 1000 })).toBe(200)
  })
  it('新回复只有原先在底部时跟随，长回复也一样', () => {
    expect(threadScrollTop({ ...base, lastId: 'b', height: 2400 })).toBe(200)
    expect(threadScrollTop({ ...base, lastId: 'b', height: 2400, previousTop: 600 })).toBe(2000)
  })
  it('首次加载从最新消息开始', () => {
    expect(threadScrollTop({ ...base, previousLastId: null })).toBe(900)
  })
})
