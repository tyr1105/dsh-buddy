/**
 * 设置校验与线程逻辑测试（任务卡「测试」一节：设置项校验、openBotSession 各分支、气泡分组）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch, draftFromSettings, dropSettingsDraft, knowledgeConfigFromDraft,
  modelSelectOptions, restoreSettingsDraft, stashSettingsDraft, validateClockTime,
  validateKnowledgeDraft, validateSettingsDraft,
} from '../src/client/logic/settings.js'
import { OPEN_SESSION_HINTS, groupMessages, isCenterMessage, isSendEnter, openBotSessionWith, shouldStickToBottom } from '../src/client/logic/thread.js'
import { quotaMeaning } from '../src/client/logic/quota.js'
import type { Settings } from '@agent-hub/core'
import type { Light, ThreadMessageView } from '../src/shared/views.js'

// ---------- 设置 ----------

const settings = {
  id: 'settings', rootDir: '~/AgentHub', timezone: 'Asia/Shanghai',
  quietHours: { start: '23:00', end: '08:00' }, digestAt: '08:30',
  pushChannel: 'macos', defaultModel: null, workDataPaths: [], l3Grants: [],
  dailyPushCap: 3, botDailyPushCap: 2,
  botDailyTurnBudget: 6, botDailyTokenBudget: 250000,
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
    expect(draft.botDailyTurnBudget).toBe('6')
    expect(draft.botDailyTokenBudget).toBe('250000')
  })
  it('C05 每队友每日预算：回合 1–50、token 1 万–200 万，都必须是整数', () => {
    const base = draftFromSettings(settings)
    expect(validateSettingsDraft({ ...base, botDailyTurnBudget: '0' })).toContain('自己开工')
    expect(validateSettingsDraft({ ...base, botDailyTurnBudget: '51' })).toContain('自己开工')
    expect(validateSettingsDraft({ ...base, botDailyTurnBudget: '2.5' })).toContain('自己开工')
    expect(validateSettingsDraft({ ...base, botDailyTokenBudget: '9999' })).toContain('token')
    expect(validateSettingsDraft({ ...base, botDailyTokenBudget: '2000001' })).toContain('token')
    expect(validateSettingsDraft({ ...base, botDailyTokenBudget: '30000.5' })).toContain('token')
    // 边界值合法：改大回合与 token 后可以保存。
    expect(validateSettingsDraft({ ...base, botDailyTurnBudget: '50', botDailyTokenBudget: '2000000' })).toBeNull()
    expect(validateSettingsDraft({ ...base, botDailyTurnBudget: '1', botDailyTokenBudget: '10000' })).toBeNull()
  })
  it('单推上限范围：全体 0–10、每个 0–3，且每个不能超全体', () => {
    const draft = { ...draftFromSettings(settings), dailyPushCap: '11' }
    expect(validateSettingsDraft(draft)).toContain('全队每天')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '4' })).toContain('每位队友')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '5' })).toContain('每位队友')
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '3', botDailyPushCap: '2' })).toBeNull()
    expect(validateSettingsDraft({ ...draft, dailyPushCap: '2.5', botDailyPushCap: '2' })).toContain('整数')
  })
  it('推送渠道只能选合法值', () => {
    expect(validateSettingsDraft({ ...draftFromSettings(settings), pushChannel: 'sms' })).toContain('通知方式')
  })
  it('patch 只带会改的字段；默认模型空值转 null', () => {
    const draft = { ...draftFromSettings(settings), dailyPushCap: '5', botDailyPushCap: '2' }
    const patch = buildSettingsPatch(draft) as Record<string, unknown>
    expect(patch).toMatchObject({
      digestAt: '08:30', dailyPushCap: 5, botDailyPushCap: 2,
      botDailyTurnBudget: 6, botDailyTokenBudget: 250000, defaultModel: null,
    })
    expect(patch.quietHours).toEqual({ start: '23:00', end: '08:00' })
    expect('rootDir' in patch).toBe(false)
  })
  it('C05 patch 把预算字符串转成整数，交给 core 实时生效', () => {
    const draft = { ...draftFromSettings(settings), botDailyTurnBudget: '12', botDailyTokenBudget: '400000' }
    const patch = buildSettingsPatch(draft) as Record<string, unknown>
    expect(patch.botDailyTurnBudget).toBe(12)
    expect(patch.botDailyTokenBudget).toBe(400000)
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

// ---------- 未保存草稿本地暂存（U01 第 8 轮：切走再回来不丢） ----------

describe('设置草稿暂存：编辑中落本地，基线没变才恢复', () => {
  const DRAFT_KEY = 'dsh-buddy:settings-draft:v2'
  /** 内存版 localStorage（node 测试环境没有真的 localStorage）。 */
  function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size },
    } as Storage
  }

  it('有改动时暂存内容带 version / baseSignature / draft', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    const edited = { ...base, botDailyTurnBudget: '12' }
    stashSettingsDraft(edited, base, store)
    const raw = store.getItem(DRAFT_KEY)
    expect(raw).not.toBeNull()
    const payload = JSON.parse(raw ?? '{}')
    expect(payload.version).toBe(2)
    expect(payload.baseSignature).toBe(JSON.stringify(base))
    expect(payload.draft).toEqual(edited)
  })
  it('草稿与基线一致（没有未保存改动）时不写暂存，已有暂存也清掉', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    stashSettingsDraft(base, base, store)
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    // 先改后改回：暂存被移除，不会提示恢复一份其实没差别的草稿。
    stashSettingsDraft({ ...base, digestAt: '09:00' }, base, store)
    expect(store.getItem(DRAFT_KEY)).not.toBeNull()
    stashSettingsDraft(base, base, store)
    expect(store.getItem(DRAFT_KEY)).toBeNull()
  })
  it('基线没变：读回暂存草稿', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    const edited = { ...base, botDailyTokenBudget: '400000' }
    stashSettingsDraft(edited, base, store)
    expect(restoreSettingsDraft(base, store)).toEqual(edited)
  })
  it('基线设置已在别处变更：不恢复并清掉过期草稿（防把新设置覆盖回旧值）', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    stashSettingsDraft({ ...base, botDailyTurnBudget: '20' }, base, store)
    const newerBase = { ...base, botDailyTurnBudget: '8' }
    expect(restoreSettingsDraft(newerBase, store)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
  })
  it('坏 JSON：返回 null 并清掉，不留永久垃圾', () => {
    const store = memoryStorage()
    store.setItem(DRAFT_KEY, '{oops')
    expect(restoreSettingsDraft(draftFromSettings(settings), store)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
  })
  it('P38 旧版 v1 暂存 / 缺字段 / 版本不对：返回 null 并清掉', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    // P38 升级到 v2：旧 v1 草稿即使内容齐全也整份作废，避免恢复出缺知识库字段的草稿。
    store.setItem(DRAFT_KEY, JSON.stringify({ version: 1, baseSignature: JSON.stringify(base), draft: { ...base } }))
    expect(restoreSettingsDraft(base, store)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    // v2 但草稿缺字段：坏数据不当草稿恢复。
    store.setItem(DRAFT_KEY, JSON.stringify({ version: 2, baseSignature: JSON.stringify(base), draft: { digestAt: '08:30' } }))
    expect(restoreSettingsDraft(base, store)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    store.setItem(DRAFT_KEY, JSON.stringify({ version: 9, baseSignature: JSON.stringify(base), draft: { ...base } }))
    expect(restoreSettingsDraft(base, store)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
  })
  it('从没暂存过：返回 null', () => {
    expect(restoreSettingsDraft(draftFromSettings(settings), memoryStorage())).toBeNull()
  })
  it('drop 清掉暂存；之后读回 null', () => {
    const store = memoryStorage()
    const base = draftFromSettings(settings)
    stashSettingsDraft({ ...base, digestAt: '07:00' }, base, store)
    dropSettingsDraft(store)
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    expect(restoreSettingsDraft(base, store)).toBeNull()
  })
  it('storage 抛错或为 null（隐私模式）：三个函数都静默不抛', () => {
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    } as unknown as Storage
    const base = draftFromSettings(settings)
    expect(() => stashSettingsDraft({ ...base, digestAt: '07:00' }, base, throwing)).not.toThrow()
    expect(restoreSettingsDraft(base, throwing)).toBeNull()
    expect(() => dropSettingsDraft(throwing)).not.toThrow()
    expect(() => stashSettingsDraft({ ...base, digestAt: '07:00' }, base, null)).not.toThrow()
    expect(restoreSettingsDraft(base, null)).toBeNull()
    expect(() => dropSettingsDraft(null)).not.toThrow()
  })
})

// ---------- P38 公共知识库设置草稿 ----------

describe('P38 公共知识库草稿', () => {
  /** 带已配置知识库的设置；其余字段沿用通用 settings 夹具。 */
  function settingsWithKb(kb: Record<string, unknown>): Settings {
    return { ...settings, knowledgeBase: kb } as unknown as Settings
  }
  const validKb = {
    enabled: true, endpoint: 'https://wiki.example.test', authRef: 'vault/wiki',
    protocol: 'generic-json', scope: '人事空间', readOnly: true, maxBytes: 262144,
  }

  it('旧设置缺 knowledgeBase：草稿补默认关闭值，界面不崩', () => {
    const draft = draftFromSettings(settings)
    expect(draft.kbEnabled).toBe(false)
    expect(draft.kbEndpoint).toBe('')
    expect(draft.kbMaxBytes).toBe('262144')
    expect(validateSettingsDraft(draft)).toBeNull()
  })

  it('从已配置设置派生：字段逐项带出，maxBytes 转成输入框字符串', () => {
    const draft = draftFromSettings(settingsWithKb(validKb))
    expect(draft.kbEnabled).toBe(true)
    expect(draft.kbEndpoint).toBe('https://wiki.example.test')
    expect(draft.kbAuthRef).toBe('vault/wiki')
    expect(draft.kbProtocol).toBe('generic-json')
    expect(draft.kbScope).toBe('人事空间')
    expect(draft.kbMaxBytes).toBe('262144')
  })

  it('启用时缺地址或缺协议名：中文报错并点名字段', () => {
    const base = draftFromSettings(settings)
    expect(validateKnowledgeDraft({ ...base, kbEnabled: true })).toContain('连接地址')
    expect(validateKnowledgeDraft({ ...base, kbEnabled: true, kbEndpoint: 'https://wiki.example.test' })).toContain('协议适配名')
  })

  it('地址只收 https：http 与乱码关着也拒；合法 https 通过', () => {
    const base = draftFromSettings(settings)
    expect(validateKnowledgeDraft({ ...base, kbEndpoint: 'http://wiki.example.test' })).toContain('https')
    expect(validateKnowledgeDraft({ ...base, kbEndpoint: 'not a url' })).toContain('https')
    expect(validateKnowledgeDraft({ ...base, kbEndpoint: 'https://wiki.example.test/a' })).toBeNull()
  })

  it('凭据引用拒绝含空格的明文形状；协议名只收小写标识', () => {
    const base = draftFromSettings(settings)
    expect(validateKnowledgeDraft({ ...base, kbAuthRef: 'secret token' })).toContain('凭据引用')
    expect(validateKnowledgeDraft({ ...base, kbAuthRef: 'vault/wiki@prod:1' })).toBeNull()
    expect(validateKnowledgeDraft({ ...base, kbProtocol: 'FakeWiki' })).toContain('协议名')
    expect(validateKnowledgeDraft({ ...base, kbProtocol: 'generic-json_v2' })).toBeNull()
  })

  it('单条读取上限：1024–1048576 的整数，默认 262144', () => {
    const base = draftFromSettings(settings)
    expect(validateKnowledgeDraft({ ...base, kbMaxBytes: '1023' })).toContain('读取上限')
    expect(validateKnowledgeDraft({ ...base, kbMaxBytes: '1048577' })).toContain('读取上限')
    expect(validateKnowledgeDraft({ ...base, kbMaxBytes: 'abc' })).toContain('读取上限')
    expect(validateKnowledgeDraft({ ...base, kbMaxBytes: '1024' })).toBeNull()
    expect(validateKnowledgeDraft({ ...base, kbMaxBytes: '1048576' })).toBeNull()
  })

  it('完整合法的启用草稿通过总校验', () => {
    expect(validateSettingsDraft(draftFromSettings(settingsWithKb(validKb)))).toBeNull()
  })

  it('knowledgeConfigFromDraft：trim 文本、转数字、readOnly 锁死 true', () => {
    const draft = draftFromSettings(settingsWithKb(validKb))
    const config = knowledgeConfigFromDraft({ ...draft, kbEndpoint: '  https://wiki.example.test  ', kbMaxBytes: '4096' })
    expect(config).toEqual({
      enabled: true, endpoint: 'https://wiki.example.test', authRef: 'vault/wiki',
      protocol: 'generic-json', scope: '人事空间', readOnly: true, maxBytes: 4096,
    })
  })

  it('patch：知识库没改不带键；改了才带整段（只改推送渠道不重写知识库）', () => {
    const loaded = draftFromSettings(settingsWithKb(validKb))
    expect('knowledgeBase' in buildSettingsPatch({ ...loaded, pushChannel: 'none' }, loaded)).toBe(false)
    const changed = buildSettingsPatch({ ...loaded, kbScope: '财务空间' }, loaded) as Record<string, unknown>
    expect(changed.knowledgeBase).toMatchObject({ scope: '财务空间', readOnly: true, maxBytes: 262144 })
  })
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

// ---------- 额度状态的人话翻译（工艺问题：不要出现「绿灯」） ----------

describe('quotaMeaning：把额度灯翻译成主人能懂的话', () => {
  it('四档都有明确结论，且不出现色灯字样', () => {
    for (const light of ['green', 'yellow', 'orange', 'red'] as const) {
      const meaning = quotaMeaning(light)
      expect(meaning.label).toMatch(/[\u4e00-\u9fff]/)
      expect(meaning.hint).toMatch(/[\u4e00-\u9fff]/)
      expect(meaning.label).not.toContain('绿灯')
      expect(meaning.label).not.toContain('黄灯')
    }
  })
  it('绿/黄/橙/红分别对应充足/偏紧/紧张/用完', () => {
    expect(quotaMeaning('green').label).toBe('额度充足')
    expect(quotaMeaning('yellow').label).toBe('额度偏紧')
    expect(quotaMeaning('orange').label).toBe('额度紧张')
    expect(quotaMeaning('red').label).toBe('额度用完')
  })
  it('未知状态不猜，如实说读不到', () => {
    // 运行时可能遇到宿主新增的灯色：类型外传一个值，确认默认分支不冒充已知状态。
    const unknown = 'purple' as Light
    expect(quotaMeaning(unknown).label).toContain('未知')
    expect(quotaMeaning(unknown).hint).toContain('读不到')
  })
})
