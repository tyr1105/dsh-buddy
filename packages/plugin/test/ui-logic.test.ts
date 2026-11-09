/**
 * 设置校验与线程逻辑测试（任务卡「测试」一节：设置项校验、openBotSession 各分支、气泡分组）。
 */
import { describe, expect, it } from 'vitest'
import { buildSettingsPatch, draftFromSettings, modelSelectOptions, validateClockTime, validateSettingsDraft } from '../src/client/logic/settings.js'
import { OPEN_SESSION_HINTS, groupMessages, isCenterMessage, isSendEnter, openBotSessionWith, shouldStickToBottom } from '../src/client/logic/thread.js'
import type { Settings } from '@agent-hub/core'
import type { ThreadMessageView } from '../src/shared/views.js'

// ---------- 设置 ----------

const settings = {
  id: 'settings', rootDir: '~/AgentHub', timezone: 'Asia/Shanghai',
  quietHours: { start: '23:00', end: '08:00' }, digestAt: '08:30',
  pushChannel: 'macos', defaultModel: null, workDataPaths: [], l3Grants: [],
} as unknown as Settings

describe('设置项校验', () => {
  it('HH:mm 形状：好的通过、坏的报错并点名字段', () => {
    expect(validateClockTime('23:00', '免打扰开始')).toBeNull()
    expect(validateClockTime('9:00', '免打扰开始')).toContain('免打扰开始')
    expect(validateClockTime('25:00', '免打扰结束')).toContain('免打扰结束')
  })
  it('从 Settings 派生表单草稿', () => {
    const draft = draftFromSettings(settings)
    expect(draft.quietStart).toBe('23:00')
    expect(draft.pushChannel).toBe('macos')
    expect(draft.defaultModel).toBe('')
  })
  it('单推上限范围：全体 0–10、每个 0–3，且每个不能超全体', () => {
    const draft = { ...draftFromSettings(settings), dailyPushCap: '11' }
    expect(validateSettingsDraft(draft)).toContain('全体')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '4' })).toContain('每个队友')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '5' })).toContain('每个队友')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '2' })).toBeNull()
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '2.5', botDailyPushCap: '2' })).toContain('整数')
  })
  it('推送渠道只能选合法值', () => {
    expect(validateSettingsDraft({ ...draftFromSettings(settings), pushChannel: 'sms' })).toContain('推送渠道')
  })
  it('patch 只带会改的字段；默认模型空值转 null', () => {
    const draft = { ...draftFromSettings(settings), dailyPushCap: '5', botDailyPushCap: '2' }
    const patch = buildSettingsPatch(draft) as Record<string, unknown>
    expect(patch).toMatchObject({ digestAt: '08:30', dailyPushCap: 5, botDailyPushCap: 2, defaultModel: null })
    expect(patch.quietHours).toEqual({ start: '23:00', end: '08:00' })
    expect('rootDir' in patch).toBe(false)
  })
  it('defaultModel 与加载值相同时不进 patch（D07 第 7 条：目录坏了也能只改推送渠道）', () => {
    const loaded = { ...draftFromSettings(settings), defaultModel: '{"provider":"p","model":"m"}' }
    const draft = { ...loaded, pushChannel: 'none' } // 只改推送渠道
    const patch = buildSettingsPatch(draft, loaded)
    expect('defaultModel' in patch).toBe(false)
    expect(patch.pushChannel).toBe('none')
  })
  it('defaultModel 改了才进 patch；改成跟随默认显式提交 null', () => {
    const loaded = { ...draftFromSettings(settings), defaultModel: '{"provider":"p","model":"m"}' }
    const changed = buildSettingsPatch({ ...loaded, defaultModel: '{"provider":"q","model":"n"}' }, loaded) as Record<string, unknown>
    expect(changed.defaultModel).toEqual({ provider: 'q', model: 'n' })
    const cleared = buildSettingsPatch({ ...loaded, defaultModel: '' }, loaded) as Record<string, unknown>
    expect(cleared.defaultModel).toBeNull()
  })

// ---------- 模型下拉选项（D07 第 7 条） ----------

describe('modelSelectOptions：当前值已不在宿主目录时补一项如实显示', () => {
  const options = [
    { value: null, label: '跟随宿主默认模型' },
    { value: { provider: 'deepseek', model: 'chat' }, label: 'Chat' },
  ]
  it('当前值为 null 或仍在目录里：不加额外项', () => {
    expect(modelSelectOptions(undefined, options)).toHaveLength(2)
    expect(modelSelectOptions({ provider: 'deepseek', model: 'chat' }, options)).toHaveLength(2)
  })
  it('当前值已下架：追加「provider / model（已不在宿主目录…）」一项', () => {
    const list = modelSelectOptions({ provider: 'old', model: 'gone' }, options)
    expect(list).toHaveLength(3)
    expect(list.at(-1)?.label).toContain('old / gone')
    expect(list.at(-1)?.label).toContain('已不在宿主目录')
    expect(list.at(-1)?.value).toEqual({ provider: 'old', model: 'gone' })
  })
})
})

// ---------- 打开会话 ----------

function fakeCtx(services: Record<string, unknown>): { get: (name: string) => unknown } {
  return { get: (name: string) => services[name] }
}

const okServices = {
  uiWorkspace: { openSession: (id: string) => { if (id === 'throw') throw new Error('no') } },
  sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s1', 's2'] }) } },
  workspaces: { list: { getSnapshot: () => ({ phase: 'ready', state: 'ok', archivedSessionIds: ['s2'] }) } },
}

describe('openBotSession 各分支（verified-T5 Q4-3 完整口径）', () => {
  it('在列表里 → opened', () => {
    expect(openBotSessionWith(fakeCtx(okServices), 's1')).toBe('opened')
  })
  it('已归档 → archived', () => {
    expect(openBotSessionWith(fakeCtx(okServices), 's2')).toBe('archived')
  })
  it('工作区列表出错 → unavailable（官方第一步）', () => {
    const bad = { ...okServices, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', state: 'error' }) } } }
    expect(openBotSessionWith(fakeCtx(bad), 's1')).toBe('unavailable')
  })
  it('列表还在加载 → loading', () => {
    const pending = { ...okServices, sessions: { list: { getSnapshot: () => ({ phase: 'pending', ids: [] }) } } }
    expect(openBotSessionWith(fakeCtx(pending), 's1')).toBe('loading')
  })
  it('不在会话列表 / 服务拿不到 / openSession 抛错 → unavailable', () => {
    expect(openBotSessionWith(fakeCtx(okServices), 's9')).toBe('unavailable')
    expect(openBotSessionWith(fakeCtx({}), 's1')).toBe('unavailable')
    expect(openBotSessionWith(fakeCtx(okServices), 'throw')).toBe('unavailable')
  })
  it('每个分支都有一句中文提示或 null', () => {
    for (const hint of Object.values(OPEN_SESSION_HINTS)) {
      if (hint !== null) expect(hint).toMatch(/[\u4e00-\u9fff]/)
    }
  })
})

// ---------- 气泡分组 ----------

function msg(overrides: Partial<ThreadMessageView>): ThreadMessageView {
  return {
    id: 'm', thread: 'team', from: 'owner', fromName: '我', fromColor: null,
    kind: 'chat', text: 'x', createdAt: 1, timeText: '刚刚', card: null, ...overrides,
  }
}

describe('气泡分组（连续同一发送者合并头像）', () => {
  const messages = [
    msg({ id: '1', from: 'hub', kind: 'system' }),
    msg({ id: '2', from: 'bot-a', fromName: '甲' }),
    msg({ id: '3', from: 'bot-a', fromName: '甲' }),
    msg({ id: '4', from: 'owner' }),
    msg({ id: '5', from: 'bot-a', fromName: '甲' }),
    msg({ id: '6', from: 'hub', kind: 'digest' }),
    msg({ id: '7', from: 'owner' }),
  ]
  it('中心消息居中且自成一组（system/digest）', () => {
    expect(isCenterMessage(messages[0]!)).toBe(true)
    expect(isCenterMessage(messages[1]!)).toBe(false)
  })
  it('连续同一发送者只在第一条显示头像；换发送者重新显示；中心消息打断分组', () => {
    const slots = groupMessages(messages)
    expect(slots.map(s => `${s.message.id}:${s.showHeader ? 'H' : '-'}`).join(' ')).toBe('1:H 2:H 3:- 4:H 5:H 6:H 7:H')
  })
  it('汇报（report）不居中、走机器人气泡（左侧色条由样式加）', () => {
    expect(isCenterMessage(msg({ kind: 'report' }))).toBe(false)
  })
})

// ---------- 交互审查：滚动贴底与回车发送 ----------

describe('shouldStickToBottom（贴底判定，交互审查第 2 条）', () => {
  it('刚切到线程（无上一帧）：贴底', () => {
    expect(shouldStickToBottom({ prevLastId: null, lastId: 'm9', nearBottom: false })).toBe(true)
  })
  it('加载更早（最后一条没变）：不贴底——用户在读历史', () => {
    expect(shouldStickToBottom({ prevLastId: 'm9', lastId: 'm9', nearBottom: true })).toBe(false)
  })
  it('来了新消息：在底部附近才贴底；正在上翻就不打扰', () => {
    expect(shouldStickToBottom({ prevLastId: 'm9', lastId: 'm10', nearBottom: true })).toBe(true)
    expect(shouldStickToBottom({ prevLastId: 'm9', lastId: 'm10', nearBottom: false })).toBe(false)
  })
})

describe('isSendEnter（回车发送判定，交互审查第 3 条）', () => {
  it('普通回车：发送', () => {
    expect(isSendEnter({ key: 'Enter' })).toBe(true)
  })
  it('中文输入法组合态：不发送（isComposing 或 keyCode 229）', () => {
    expect(isSendEnter({ key: 'Enter', isComposing: true })).toBe(false)
    expect(isSendEnter({ key: 'Enter', keyCode: 229 })).toBe(false)
  })
  it('组合结束后的回车：发送', () => {
    expect(isSendEnter({ key: 'Enter', isComposing: false })).toBe(true)
  })
  it('非回车键：不发送', () => {
    expect(isSendEnter({ key: 'a' })).toBe(false)
  })
})
