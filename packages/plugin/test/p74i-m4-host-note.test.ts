/**
 * P74i-m4（第 4 节第 3 条）：宿主把「提议的附言」转给核心的那一处补测试。
 *
 * 背景：第五次审查发现，把 real-hub.ts 里 answerInbox 命令转发附言的那一处（optStr(raw, 'note')）去掉后，
 * 全部相关测试仍通过——附言在宿主这一层被丢掉，主人写的话到不了核心，却没有任何测试报出来。
 * 做法：照 real-hub.test.ts 里宿主命令转发的写法，用一个只记录调用参数的假 UiApi，
 * 经 dispatchCommand 发 answerInbox 命令，断言核心收到的第三个参数。
 * 验证有效性：临时把宿主的转发去掉，下面「带附言」这一条必须失败（见 docs/progress/P74i-m4.md）。
 */
import { describe, expect, it } from 'vitest'
import type { CommandResult, UiApi } from '@agent-hub/core'
import { dispatchCommand } from '../src/host/real-hub.js'

/** 只实现 answerInbox 的假 UiApi：记下收到的全部参数，返回成功。 */
function answerInboxApi(): { api: UiApi; calls: unknown[][] } {
  const calls: unknown[][] = []
  const api = {
    answerInbox: (...args: unknown[]): Promise<CommandResult> => { calls.push(args); return Promise.resolve({ ok: true }) },
  } as unknown as UiApi
  return { api, calls }
}

describe('宿主转发提议附言（answerInbox 的第三个参数）', () => {
  it('带附言：核心收到的第三个参数就是主人写的那句话', async () => {
    const { api, calls } = answerInboxApi()
    const result = await dispatchCommand(api, 'answerInbox', { id: 'i1', answer: '不做', note: '这个方向先放一放' })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([['i1', '不做', '这个方向先放一放']])
  })

  it('不带附言：核心收到的第三个参数是 undefined（与改动前相同）', async () => {
    const { api, calls } = answerInboxApi()
    await dispatchCommand(api, 'answerInbox', { id: 'i1', answer: '接受' })
    expect(calls).toEqual([['i1', '接受', undefined]])
    expect(calls[0]).toHaveLength(3)
  })
})
