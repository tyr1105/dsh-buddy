/**
 * 冒烟跑者判定函数测试（D05 第 19 条 / D07 第 1、23 条）：
 * - 主人消息那一轮的 reply 判定（试跑回合的 reply 不能提前满足）；
 * - H7 结论用「预登记 id → 实际 id」映射比对（名册本身会迁到实际 id，
 *   用名册比对永远「一致」，查不出另铸——D07 第 23 条修的就是这个）；
 * - 设置接口检查（D07 第 1 条）：200 且 modelOptions 多于 1 项才通过。
 */
import { describe, expect, it } from 'vitest'
// 跑者在仓库 scripts/smoke-runner（包外、无类型声明），动态 import 拿纯函数。
// @ts-expect-error 故意引用包外的 .mjs
const { ownerReplyOf, h7NoteOf, settingsCheckOf } = await import('../../scripts/smoke-runner/index.mjs') as {
  ownerReplyOf(replies: Array<{ text: string }>, repliesBeforePoke: number, pokeText: string, real: boolean): string | null
  h7NoteOf(actualSession: string | null, mints: Array<[string, string]>): string
  settingsCheckOf(hub: unknown): Promise<{ ok: boolean; note: string }>
}

const pokeText = '冒烟：请交账'
const expected = `收到：${[...pokeText].slice(0, 20).join('')}`

describe('ownerReplyOf（主人消息那一轮的回复判定）', () => {
  it('正例：poke 之后出现内容恰为「收到：+原话前 20 字」的 reply', () => {
    expect(ownerReplyOf([{ text: expected }], 0, pokeText, false)).toBe(expected)
  })
  it('试跑那条 reply 在 poke 之前：不能提前满足判定（修复前的漏洞）', () => {
    expect(ownerReplyOf([{ text: expected }], 1, pokeText, false)).toBeNull()
  })
  it('反例：第二轮 reply 内容与主人原话不对应（主人原话没进唤醒包）', () => {
    expect(ownerReplyOf([{ text: '收到：冒烟测试交账' }], 0, pokeText, false)).toBeNull()
    expect(ownerReplyOf([{ text: '别的回复' }], 0, pokeText, false)).toBeNull()
  })
  it('真实模式：取 poke 之后的第一条 reply（不预设开头字样）', () => {
    expect(ownerReplyOf([{ text: '（回答主人）hello.txt 已创建' }], 0, pokeText, true)).toBe('（回答主人）hello.txt 已创建')
    expect(ownerReplyOf([{ text: 'x' }], 1, pokeText, true)).toBeNull()
  })
})

describe('h7NoteOf（预登记 id → 实际 id 比对，D07 第 23 条）', () => {
  it('一致：未走退回分支', () => {
    expect(h7NoteOf('session-abc', [['session-abc', 'session-abc']])).toContain('一致')
    expect(h7NoteOf('session-abc', [['session-abc', 'session-abc']])).not.toContain('走了退回分支')
  })
  it('另铸 id（即使也是 session- 开头）：报告退回分支并带预登记 id', () => {
    const note = h7NoteOf('session-minted', [['session-wanted', 'session-minted']])
    expect(note).toContain('退回分支')
    expect(note).toContain('session-wanted')
  })
  it('没有对应记录（例如重启前建的会话）：说明无法比对，不误报一致', () => {
    expect(h7NoteOf('session-x', [])).toContain('无法比对')
  })
  it('还没有会话', () => {
    expect(h7NoteOf(null, [])).toContain('还没有会话')
  })
})

describe('settingsCheckOf（设置接口检查，D07 第 1 条）', () => {
  it('正例：200 且 modelOptions 多于 1 项', async () => {
    const hub = { request: async () => ({ status: 200, body: { modelOptions: [{ value: null }, { value: { provider: 'p', model: 'm' } }] } }) }
    const check = await settingsCheckOf(hub)
    expect(check.ok).toBe(true)
    expect(check.note).toContain('模型选项 2 项')
  })
  it('反例：只有「跟随默认」一项（目录没列出模型）不通过', async () => {
    const hub = { request: async () => ({ status: 200, body: { modelOptions: [{ value: null }] } }) }
    const check = await settingsCheckOf(hub)
    expect(check.ok).toBe(false)
    expect(check.note).toContain('少于 2 项')
  })
  it('反例：500（例如目录回调抛错）不通过并带状态码', async () => {
    const hub = { request: async () => ({ status: 500, body: { ok: false, error: '模型目录读取失败：…' } }) }
    const check = await settingsCheckOf(hub)
    expect(check.ok).toBe(false)
    expect(check.note).toContain('500')
  })
  it('反例：诊断服务没有 request 入口 / 请求抛错', async () => {
    expect((await settingsCheckOf({})).ok).toBe(false)
    expect((await settingsCheckOf({ request: async () => { throw new Error('炸了') } })).ok).toBe(false)
  })
})
