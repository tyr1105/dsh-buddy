/**
 * 新建队友编排测试：createBot →（模板带色时）存色 → 刷新总览的调用顺序与失败语义。
 *
 * 为什么单独测：最关键的取舍是「颜色保存失败不能丢队友」——队友已经建成是事实，
 * 存色只是次要字段；只有创建本身失败才把中文原因交回表单。用记录调用的假 hub
 * 把调用序列与刷新时机逐条钉死，界面层不用真跑 core。
 * 编制取消后没有「入座」这一步：队友建成即出现在办公室里。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../src/shared/views.js'
import { createTeammate, type WizardCreateHub } from '../src/client/logic/wizard-create.js'

/** 记录全部命令调用与刷新时机的假 hub；命令结果可按 name 排队给出。 */
function fakeHub(plan: Record<string, CommandResult> = {}): WizardCreateHub & { calls: Array<{ name: string; arg: unknown }>; refreshed: string[] } {
  const calls: Array<{ name: string; arg: unknown }> = []
  const refreshed: string[] = []
  return {
    calls,
    refreshed,
    command: async (name, input) => {
      // 两个命令都整对象透传，直接记录首参便于逐条断言。
      calls.push({ name, arg: input })
      return plan[name] ?? { ok: true, data: { id: 'bot-new' } }
    },
    refreshOverview: async () => { refreshed.push('overview') },
  }
}

describe('createTeammate：建队友 + 刷总览', () => {
  it('表单创建不选颜色：只有 createBot，core 按执行风格给默认色', async () => {
    const hub = fakeHub()
    const result = await createTeammate(hub, { name: '新来的' })
    expect(result).toEqual({ botId: 'bot-new' })
    expect(hub.calls.map(c => c.name)).toEqual(['createBot'])
    expect(hub.refreshed).toEqual(['overview'])
  })
  it('模板带颜色时：createBot→updateBot 存色，成功后刷总览', async () => {
    const hub = fakeHub()
    const result = await createTeammate(hub, { name: '新来的' }, '#abcdef')
    expect(result).toEqual({ botId: 'bot-new' })
    expect(hub.calls.map(c => c.name)).toEqual(['createBot', 'updateBot'])
    expect(hub.calls[1]!.arg).toEqual({ botId: 'bot-new', patch: { color: '#abcdef' } })
    expect(hub.refreshed).toEqual(['overview'])
  })
  it('反例：createBot 失败 → 返回 error，不存色、不刷新', async () => {
    const hub = fakeHub({ createBot: { ok: false, error: '名字不能空' } })
    const result = await createTeammate(hub, { name: '' }, '#000000')
    expect(result).toEqual({ error: '名字不能空' })
    expect(hub.calls.map(c => c.name)).toEqual(['createBot'])
    expect(hub.refreshed).toEqual([])
  })
  it('存色失败不挡创建（颜色是次要字段，core 已按执行风格给默认色）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hub = fakeHub({ updateBot: { ok: false, error: '颜色无效' } })
    const result = await createTeammate(hub, { name: '新来的' }, 'bad')
    expect(result).toEqual({ botId: 'bot-new' })
    expect(hub.calls.map(c => c.name)).toEqual(['createBot', 'updateBot'])
    expect(hub.refreshed).toEqual(['overview'])
    expect(errSpy).toHaveBeenCalledOnce()
    errSpy.mockRestore()
  })
  it('反例：core 没返回 id 属契约破坏，按创建失败处理、不发后续命令', async () => {
    const hub = fakeHub({ createBot: { ok: true } })
    const result = await createTeammate(hub, { name: '新来的' }, '#abcdef')
    expect(result).toEqual({ error: '创建成功但没有返回机器人 id' })
    expect(hub.calls.map(c => c.name)).toEqual(['createBot'])
    expect(hub.refreshed).toEqual([])
  })
})
