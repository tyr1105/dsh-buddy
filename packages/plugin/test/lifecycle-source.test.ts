/**
 * 生命周期按钮纯逻辑测试（D07 第 24 条）：lifecycleButtons / pauseResumeAction /
 * lifecycleAllTargets 按 probation/active/paused/quarantined/retired/draft 逐一断言
 * 哪些按钮出现、哪些不出现，以及各自的 action——按钮发错动作或动作对调都会在这里失败。
 * 另附 D07 第 3 条的源码检查：切换队友时 RightPanel / ThreadPane 必须带 key，
 * 否则 A 上的退役确认、打断确认、编辑草稿会带到 B（一下就把另一个队友退役/打断）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lifecycleButtons, pauseResumeAction, lifecycleAllTargets } from '../src/client/logic/lifecycle.js'

const buttonsOf = (lifecycle: Parameters<typeof lifecycleButtons>[0]) =>
  lifecycleButtons(lifecycle).map(button => `${button.action}:${button.label}`)

describe('lifecycleButtons（D07 第 24 条，与 core 的资格校验一致）', () => {
  it('probation：暂停 + 转正 + 退役（无恢复/解除停用）', () => {
    expect(buttonsOf('probation')).toEqual(['pause:暂停', 'promote:转正', 'retire:退役'])
  })
  it('active：暂停 + 退役（无恢复/转正/解除停用）', () => {
    expect(buttonsOf('active')).toEqual(['pause:暂停', 'retire:退役'])
  })
  it('paused：恢复 + 退役（无暂停/转正）', () => {
    expect(buttonsOf('paused')).toEqual(['resume:恢复', 'retire:退役'])
  })
  it('quarantined：解除停用（发 release_quarantine 而不是 resume）+ 退役', () => {
    expect(buttonsOf('quarantined')).toEqual(['release_quarantine:解除停用', 'retire:退役'])
  })
  it('retired：一个按钮都没有', () => {
    expect(buttonsOf('retired')).toEqual([])
  })
  it('draft：只有退役', () => {
    expect(buttonsOf('draft')).toEqual(['retire:退役'])
  })
})

describe('pauseResumeAction（线程头部与 togglePause 共用）', () => {
  it('在岗/试岗 → pause；暂停 → resume；隔离/退役/草稿 → null（头部不显示）', () => {
    expect(pauseResumeAction('active')).toBe('pause')
    expect(pauseResumeAction('probation')).toBe('pause')
    expect(pauseResumeAction('paused')).toBe('resume')
    expect(pauseResumeAction('quarantined')).toBeNull()
    expect(pauseResumeAction('retired')).toBeNull()
    expect(pauseResumeAction('draft')).toBeNull()
  })
})

describe('lifecycleAllTargets（全部暂停/全部恢复的选目标）', () => {
  const bots = [
    { id: 'a', lifecycle: 'active' as const },
    { id: 'p', lifecycle: 'probation' as const },
    { id: 's', lifecycle: 'paused' as const },
    { id: 'q', lifecycle: 'quarantined' as const },
    { id: 'r', lifecycle: 'retired' as const },
  ]
  it('全部暂停选在岗+试岗；全部恢复只选暂停', () => {
    expect(lifecycleAllTargets(bots, 'paused')).toEqual(['a', 'p'])
    expect(lifecycleAllTargets(bots, 'active')).toEqual(['s'])
  })
})

describe('D07 第 3 条：切换队友时本地状态必须复位（源码检查）', () => {
  // 组件测试没有 jsdom 渲染环境（react 是桩），这里退而检查 HubPage 对两个组件
  // 传了 key：key 变化会让 React 丢弃旧实例，退役确认/打断确认/编辑草稿/输入草稿
  // 全部随之消失。删掉 key 会立刻在这里失败。
  const page = readFileSync(fileURLToPath(new URL('../src/client/pages/HubPage.tsx', import.meta.url)), 'utf8')
  it('ThreadPane 带 key={selectedThread}（A 的打断确认/输入草稿不会带到 B）', () => {
    expect(page).toMatch(/<ThreadPane[^>]*\bkey=\{selectedThread\}/s)
  })
  it('RightPanel 带 key={selectedBot?.id ?? \'none\'}（A 的退役确认/编辑档案不会带到 B）', () => {
    expect(page).toMatch(/<RightPanel[^>]*\bkey=\{selectedBot\?\.(id|card\.id)/s)
  })
})
