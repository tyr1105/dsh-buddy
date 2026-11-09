/**
 * P32 共享骨架测试：空间能力探测只读且安全；切换控件受控、文案唯一；
 * 团队空间骨架有可读标题与返回路径。
 *
 * 为什么用静态契约检查组件源码：测试环境把 react 指到桩（见 vitest.config.ts），
 * 不渲染组件；这里检查的是「组件必须遵守的形状」——受控、原生按钮、统一文案，
 * 防止以后有人加一份内部状态或改掉文案造成两条路径不一致。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  detectSpaceCapability,
  otherSpaceMode,
  SPACE_MODE_LABELS,
  SPACE_MODES,
  type SpaceMountProbe,
} from '../src/client/logic/space-capability.js'

const clientRoot = new URL('../src/client/', import.meta.url)

describe('空间能力探测', () => {
  it('找到挂载容器时返回 slot', () => {
    const mount = {} as HTMLElement
    const capability = detectSpaceCapability({ findMount: () => mount })
    expect(capability).toEqual({ kind: 'slot', mount })
  })

  it('找不到锚点时为 fallback/no-anchor', () => {
    expect(detectSpaceCapability({ findMount: () => null })).toEqual({ kind: 'fallback', reason: 'no-anchor' })
  })

  it('探针缺失时按降级处理，不抛错', () => {
    expect(detectSpaceCapability(null)).toEqual({ kind: 'fallback', reason: 'no-anchor' })
    expect(detectSpaceCapability(undefined)).toEqual({ kind: 'fallback', reason: 'no-anchor' })
  })

  it('探针抛错时降级为 probe-error，异常不外抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken: SpaceMountProbe = { findMount: () => { throw new Error('宿主结构变了') } }
    expect(() => detectSpaceCapability(broken)).not.toThrow()
    expect(detectSpaceCapability(broken)).toEqual({ kind: 'fallback', reason: 'probe-error' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('只有对话与队友两个模式，切换互为反向', () => {
    expect(SPACE_MODES).toEqual(['chat', 'team'])
    expect(otherSpaceMode('chat')).toBe('team')
    expect(otherSpaceMode('team')).toBe('chat')
  })

  it('文案固定为「对话 / 队友」', () => {
    expect(SPACE_MODE_LABELS).toEqual({ chat: '对话', team: '队友' })
  })
})

describe('共享切换控件契约', () => {
  const source = readFileSync(new URL('components/space-switch.tsx', clientRoot), 'utf8')

  it('两个原生按钮，type=button，键盘可切换', () => {
    expect(source).toContain('type="button"')
    expect(source).toContain('SPACE_MODES.map')
    expect(source).toContain('onClick')
  })

  it('受控：模式来自 props，组件内部不存状态', () => {
    expect(source).toContain('props.mode')
    expect(source).toContain('aria-pressed={active}')
    expect(source).not.toContain('useState')
  })

  it('文案不写死第二份，统一从常量取', () => {
    expect(source).toContain('SPACE_MODE_LABELS[mode]')
    expect(source).not.toContain("'对话'")
    expect(source).not.toContain("'队友'")
  })
})

describe('团队空间页面骨架', () => {
  const source = readFileSync(new URL('pages/TeamSpacePage.tsx', clientRoot), 'utf8')

  it('有可读标题与返回对话的路径', () => {
    expect(source).toContain('团队空间')
    expect(source).toContain('回到对话界面')
    expect(source).toContain('onBackToChat')
  })

  it('切换条复用共享控件，不另造一套按钮', () => {
    expect(source).toContain('<SpaceSwitch')
  })
})
