/**
 * P75j 测试：员工右侧栏的技能库一栏、技能详情、技能刻度，以及宿主的四个入口。
 *
 * 做法：测试环境没有真实 DOM，用两个办法检查界面——
 * 1. 没有 hook 的小组件（一栏、刻度）直接调用，把返回的元素树逐层展开成文字和元素，检查画了什么；
 * 2. 有 hook 的组件（技能详情、右侧栏）用 hook 宿主连续渲染，点按钮就是调用元素上的 onClick，再渲染一次看结果。
 * 数据一律来自 core 生成的样例视图（fixture-skill-preview.ts，与 core 实时生成的逐字相同，由 p75j-fixture-consistency 钉住）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { SkillDetail } from '../src/client/components/SkillDetail.js'
import { SkillLibrarySection } from '../src/client/components/SkillLibrarySection.js'
import { SkillTicks } from '../src/client/components/SkillTicks.js'
import { ConfirmDialog } from '../src/client/components/confirm-dialog.js'
import { RetryBox, Skeleton } from '../src/client/components/Ui.js'
import { createHubStore } from '../src/client/hub-state.js'
import {
  NO_SELF_SKILL_TEXT, restoreConfirmText, rollbackConfirmText, skillRowDomId, skillTicksLabel, tickClassName, type SkillApi,
} from '../src/client/logic/skill-library.js'
import { dispatchCommand } from '../src/host/real-hub.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import { buildGuardedRoutes } from '../src/host/routes.js'
import { SAMPLE_SKILL_IDS, createSkillSample } from '../src/shared/fixture-skill.js'
import { previewEmptySkillLibrary, previewSkillDetails, previewSkillLibrary } from '../src/shared/fixture-skill-preview.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import type { CommandResult, SkillDetailView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import type { StubElement } from './helpers/jsx-runtime-stub.js'

// 把 react 换成 hook 宿主的替身；右侧栏的抽屉判断要读真实样式，这里换成不依赖样式的替身。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => false,
}))

afterEach(() => { vi.unstubAllGlobals() })

// ---------------------------------------------------------------------------
// 元素树小工具
// ---------------------------------------------------------------------------

/** 把没有 hook 的函数组件逐层展开成纯元素树（有 hook 的组件不要用它展开）。 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object' || node === null || !('props' in node)) return node
  const element = node as StubElement
  if (typeof element.type === 'function') return expand((element.type as (props: unknown) => unknown)(element.props))
  return { ...element, props: { ...element.props, children: expand(element.props.children) } }
}

/** 收集一棵（已展开的）树上满足条件的元素。 */
function pick(node: unknown, test: (element: StubElement) => boolean): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(child => pick(child, test))
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [...(test(element) ? [element] : []), ...pick(element.props.children, test)]
}
const byType = (type: unknown) => (element: StubElement): boolean => element.type === type
const byClass = (name: string) => (element: StubElement): boolean => String(element.props.className ?? '').split(' ').includes(name)

/** 一棵树上全部文字（元素之间用换行隔开，便于整句匹配）。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  if (typeof node !== 'object' || node === null || !('props' in node)) return ''
  return textOf((node as StubElement).props.children)
}

/** 等晚到的 promise 回调都跑完。 */
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

// ---------------------------------------------------------------------------
// 1. 技能库一栏
// ---------------------------------------------------------------------------

describe('技能库一栏：三组、数量、小标、来源一句、只读的岗位技能', () => {
  const tree = (view = previewSkillLibrary) => expand(SkillLibrarySection({ view, error: null, onRetry: () => undefined, onOpen: () => undefined }))

  it('标题行写条数与最近更新，第二行写上次整理，三组的组名与说明都在', () => {
    const text = textOf(tree())
    for (const line of ['技能库', '6 条', '最近更新　11月24日', '上次整理：11月24日', '自己积累', '4 条，林舟自己维护', '岗位技能', '2 条，预置，只读', '不常用', '3 条']) {
      expect(text, line).toContain(line)
    }
  })

  it('每条自己积累与不常用的技能是一个按钮，带名称、版本、来源一句与「补充自……」；「本周更新」小标只在有的那一条上', () => {
    const buttons = pick(tree(), byType('button'))
    expect(buttons).toHaveLength(7) // 自己积累 4 + 不常用 3
    const form = buttons.find(row => row.props.id === skillRowDomId(SAMPLE_SKILL_IDS.form))!
    expect(textOf(form)).toContain('表单页做法')
    expect(textOf(form)).toContain('第 3 版')
    expect(textOf(form)).toContain('来自 3 件事　评审意见 2、你的纠正 2')
    expect(textOf(buttons.find(row => row.props.id === skillRowDomId(SAMPLE_SKILL_IDS.mobile))!)).toContain('补充自「动手前后自查」')
    const badged = buttons.filter(row => textOf(row).includes('本周更新'))
    expect(badged).toHaveLength(1)
    expect(textOf(badged[0])).toContain('会议纪要格式')
    for (const button of buttons) expect(button.props.type).toBe('button')
  })

  it('岗位技能两行只读：显示名称与说明，不是按钮，没有点击处理', () => {
    const readonly = pick(tree(), byClass('ah-skill-row-readonly'))
    expect(readonly).toHaveLength(2)
    expect(textOf(readonly)).toContain('动手前后自查')
    expect(textOf(readonly)).toContain('工程师岗位自带')
    for (const row of readonly) {
      expect(row.type).toBe('div')
      expect(row.props.onClick).toBeUndefined()
    }
    expect(pick(readonly, byType('button'))).toHaveLength(0)
  })

  it('点一条自己积累的技能，把它的编号交给打开处理；不常用的同样', () => {
    const opened: string[] = []
    const buttons = pick(expand(SkillLibrarySection({ view: previewSkillLibrary, error: null, onRetry: () => undefined, onOpen: id => opened.push(id) })), byType('button'))
    ;(buttons.find(row => row.props.id === skillRowDomId(SAMPLE_SKILL_IDS.form))!.props.onClick as () => void)()
    ;(buttons.find(row => row.props.id === skillRowDomId(SAMPLE_SKILL_IDS.report))!.props.onClick as () => void)()
    expect(opened).toEqual([SAMPLE_SKILL_IDS.form, SAMPLE_SKILL_IDS.report])
  })

  it('没有任何自己积累的技能时，自己积累一组写空状态那句话；有技能时不写', () => {
    expect(textOf(tree(previewEmptySkillLibrary))).toContain(NO_SELF_SKILL_TEXT)
    expect(NO_SELF_SKILL_TEXT).toBe('暂无。员工做完的事经过复盘和核对之后，会写入这里。')
    expect(textOf(tree())).not.toContain(NO_SELF_SKILL_TEXT)
    // 空状态下岗位技能仍显示，且仍然不是按钮。
    expect(pick(tree(previewEmptySkillLibrary), byType('button'))).toHaveLength(0)
  })

  it('视图还没取到时显示骨架占位；取失败显示原因与重试，不画空列表', () => {
    const loading = expand(SkillLibrarySection({ view: null, error: null, onRetry: () => undefined, onOpen: () => undefined }))
    expect(pick(loading, byClass('ah-skeleton'))).toHaveLength(1)
    const failed = SkillLibrarySection({ view: null, error: '连接中断。点击重试；仍失败请确认 DSH 是否已关闭。', onRetry: () => undefined, onOpen: () => undefined })
    expect(pick(failed, byType(RetryBox))).toHaveLength(1)
    expect(pick(failed, byType(Skeleton))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 刻度
// ---------------------------------------------------------------------------

describe('技能刻度：道数、长短、新刻动画', () => {
  const ticks = previewSkillLibrary.ticks
  const rendered = expand(SkillTicks({ ticks }))

  it('上方一行、下方图例与最近一道都在；整条线有可访问名「技能刻度：8 道」，每一道不单独聚焦', () => {
    const text = textOf(rendered)
    expect(text).toContain('刻度　8 道　入职 45 天')
    // 图例每一项是一个整体（小改二）：四项各一个不断行的元素，合起来仍是 core 给的那一句。
    const items = pick(rendered, byClass('ah-skill-legend-item')).map(row => textOf(row))
    expect(items).toEqual(['短：评审意见', '中：验收结果', '长：你的纠正', '主色：整理合并'])
    expect(items.join('　')).toBe(ticks.legend)
    expect(text).toContain('最近一道：11月24日 每周整理，合并 1 条')
    const line = pick(rendered, byClass('ah-skill-ticks-line'))[0]!
    expect(line.props['aria-label']).toBe('技能刻度：8 道')
    expect(skillTicksLabel(ticks)).toBe('技能刻度：8 道')
    for (const slot of pick(rendered, byClass('ah-skill-tick-slot'))) {
      expect(slot.props['aria-hidden']).toBe('true')
      expect(slot.props.tabIndex).toBeUndefined()
    }
  })

  it('八道竖刻，长短类名与视图的 length 一一对应；整理合并那一道是主色类名', () => {
    const marks = pick(rendered, byClass('ah-skill-tick'))
    expect(marks).toHaveLength(8)
    expect(marks.map(row => String(row.props.className).split(' ').find(name => /^ah-skill-tick-(short|mid|long|main)$/.test(name))))
      .toEqual(ticks.ticks.map(row => `ah-skill-tick-${row.length}`))
    expect(marks.filter(row => String(row.props.className).includes('ah-skill-tick-main'))).toHaveLength(1)
  })

  it('只有新刻的一道（fresh）带动画类名', () => {
    const fresh = pick(rendered, byClass('ah-skill-tick-fresh'))
    expect(fresh).toHaveLength(1)
    expect(String(fresh[0]!.props.className)).toContain('ah-skill-tick-main')
    expect(tickClassName({ at: 1, length: 'long', fresh: false })).not.toContain('fresh')
    expect(tickClassName({ at: 1, length: 'long', fresh: true })).toContain('ah-skill-tick-fresh')
  })

  it('样式表里：动画只在没有要求减少动态效果时播放；要求减少时关闭', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/client/workspace.css', import.meta.url)), 'utf8')
    const play = /@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*?\.ah-skill-tick-fresh\s*\{\s*animation:[^}]*\}/.exec(css)
    expect(play, '动画写在 no-preference 的媒体查询里').not.toBeNull()
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ah-skill-tick-fresh\s*\{\s*animation:\s*none;\s*\}\s*\}/)
    // 动画之外没有别处给 fresh 写动画（不在媒体查询之外直接播放）。
    expect(css.split('.ah-skill-tick-fresh').filter(piece => piece.trimStart().startsWith('{') && /^\s*\{\s*animation:\s*ah-/.test(piece))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. 技能详情
// ---------------------------------------------------------------------------

/** 造一个替身入口：详情从样例取（可替换），回退和放回记录调用、按需要返回成功或失败。 */
function fakeApi(options: { rollback?: () => Promise<CommandResult> } = {}) {
  const calls = { detail: [] as string[], rollback: [] as Array<[string, number]>, restore: [] as string[] }
  const byId = new Map<string, SkillDetailView>(Object.values(previewSkillDetails).map(view => [view.skillId, view]))
  const api: SkillApi = {
    detail: async id => { calls.detail.push(id); return byId.get(id)! },
    rollback: async (id, no) => { calls.rollback.push([id, no]); return options.rollback ? options.rollback() : { ok: true } },
    restore: async id => { calls.restore.push(id); return { ok: true } },
  }
  return { api, calls }
}

/** 渲染一次详情并等数据到齐，返回宿主与最新的元素树取得函数。 */
async function openDetail(skillId: string, api: SkillApi) {
  const host = createHookHost()
  const props = { skillId, api, reloadKey: null, onBack: () => undefined }
  host.render(SkillDetail, props)
  await flush()
  return { host, props, view: () => host.render(SkillDetail, props) }
}

const buttonsIn = (node: unknown) => pick(node, byType('button'))
const dialogIn = (node: unknown) => pick(node, byType(ConfirmDialog))[0]

describe('刻度图例：每一项不从中间断行', () => {
  it('样式表里每一项是不换行的行内块（只在项与项之间换行）', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/client/workspace.css', import.meta.url)), 'utf8')
    const rule = /\.ah-skill-legend-item\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('display: inline-block')
    expect(rule![1]).toContain('white-space: nowrap')
  })
})

describe('技能详情：逐句出处、历史版本、对比表', () => {
  it('标题、第几版与时间、「正文　每一句都注明出处」、每句一行并在下方写出处', async () => {
    const { api } = fakeApi()
    const { view } = await openDetail(SAMPLE_SKILL_IDS.form, api)
    const text = textOf(view())
    for (const line of ['表单页做法', '第 3 版　11月20日 17:12', '正文　每一句都注明出处', '提交后显示明确的成功提示，名单写入前先校验必填项。',
      '第 1 版　来自评审意见：「数据核对」任务第 1 轮', '第 3 版　来自你的纠正：会议室预约页验收第 2 条', '历史版本']) {
      expect(text, line).toContain(line)
    }
    expect(pick(view(), byType('li')).length).toBeGreaterThanOrEqual(4)
  })

  it('历史版本新到旧：当前版本标「当前」且没有回退按钮，其余各有「回退到这一版」', async () => {
    const { api } = fakeApi()
    const { view } = await openDetail(SAMPLE_SKILL_IDS.form, api)
    const rows = pick(view(), byClass('ah-skill-version'))
    expect(rows).toHaveLength(3)
    expect(textOf(rows[0])).toContain('当前')
    // P75r7（B5）：每一行开头写「第 n 版」，主人不用自己数行就能对上确认框里的版本号。
    expect(textOf(rows[0])).toContain('第 3 版　11月20日')
    expect(textOf(rows[1])).toContain('第 2 版　11月17日')
    expect(buttonsIn(rows[0])).toHaveLength(0)
    for (const row of rows.slice(1)) {
      expect(textOf(row)).not.toContain('当前')
      expect(buttonsIn(row).map(button => textOf(button))).toEqual(['回退到这一版'])
    }
    // P75r7（B5）：可达名称包含按钮上的可见文字，再注明是第几版。
    expect(buttonsIn(rows[1]).map(button => button.props['aria-label'])).toEqual(['回退到这一版（第 2 版）'])
  })

  it('同类任务对比：标题、五列表头、按次序的行、表下结论；没有对比的技能不画这一块', async () => {
    const { api } = fakeApi()
    // 对比表是单独的小组件（没有 hook），渲染结果要把它展开才看得到表格。
    const withCompare = expand((await openDetail(SAMPLE_SKILL_IDS.form, api)).view())
    expect(textOf(pick(withCompare, byType('thead')))).toBe('第几次\n哪件事\n核对轮数\n验收返工\n回合')
    expect(pick(withCompare, byType('th'))).toHaveLength(5)
    const rows = pick(pick(withCompare, byType('tbody')), byType('tr'))
    expect(rows.map(row => textOf(row).split('\n'))).toEqual([
      ['第 1 次', '活动报名页', '2', '1', '14'], ['第 2 次', '会议室预约页', '1', '1', '9'],
    ])
    expect(textOf(withCompare)).toContain('同类任务：表单页')
    expect(textOf(withCompare)).toContain('第 2 次核对一次通过；验收仍返工 1 次，原因已记入第 3 版。')
    const without = expand((await openDetail(SAMPLE_SKILL_IDS.roster, api)).view())
    expect(pick(without, byType('table'))).toHaveLength(0)
    expect(textOf(without)).not.toContain('同类任务')
  })

  it('详情还没取到显示骨架；取失败显示原因与重试', async () => {
    const host = createHookHost()
    const slow: SkillApi = { ...fakeApi().api, detail: () => new Promise(() => undefined) }
    const first = host.render(SkillDetail, { skillId: SAMPLE_SKILL_IDS.form, api: slow, reloadKey: null, onBack: () => undefined })
    expect(pick(first, byType(Skeleton))).toHaveLength(1)
    const broken: SkillApi = { ...fakeApi().api, detail: async () => { throw new Error('连接中断。点击重试；仍失败请确认 DSH 是否已关闭。') } }
    const host2 = createHookHost()
    const props = { skillId: SAMPLE_SKILL_IDS.form, api: broken, reloadKey: null, onBack: () => undefined }
    host2.render(SkillDetail, props)
    await flush()
    expect(pick(host2.render(SkillDetail, props), byType(RetryBox))).toHaveLength(1)
  })
})

describe('回退到这一版：先确认，取消不调用，确认才调用', () => {
  it('点「回退到这一版」先出确认框，文字逐字照任务卡；取消不调用命令', async () => {
    const { api, calls } = fakeApi()
    const { view } = await openDetail(SAMPLE_SKILL_IDS.form, api)
    const button = buttonsIn(view()).find(row => row.props['aria-label'] === '回退到这一版（第 2 版）')!
    ;(button.props.onClick as () => void)()
    const dialog = dialogIn(view())!
    expect(dialog.props.text).toBe('把「表单页做法」回退到第 2 版？被替换的版本仍保留，可以再回到它。')
    expect(rollbackConfirmText('表单页做法', 2).text).toBe(dialog.props.text)
    ;(dialog.props.onCancel as () => void)()
    expect(dialogIn(view())).toBeUndefined()
    expect(calls.rollback).toEqual([])
  })

  it('确认后以正确参数调用 rollbackSkill，成功后关掉确认框并重取详情', async () => {
    const { api, calls } = fakeApi()
    const { view } = await openDetail(SAMPLE_SKILL_IDS.form, api)
    ;(buttonsIn(view()).find(row => row.props['aria-label'] === '回退到这一版（第 1 版）')!.props.onClick as () => void)()
    ;(dialogIn(view())!.props.onConfirm as () => void)()
    await flush()
    expect(calls.rollback).toEqual([[SAMPLE_SKILL_IDS.form, 1]])
    expect(dialogIn(view())).toBeUndefined()
    expect(calls.detail.length).toBe(2) // 打开时一次，成功后一次
  })

  it('命令失败：确认框不关，显示错误文字；之后可以取消', async () => {
    const { api } = fakeApi({ rollback: async () => ({ ok: false, error: 'versionNo：这条技能没有第 2 版' }) })
    const { view } = await openDetail(SAMPLE_SKILL_IDS.form, api)
    ;(buttonsIn(view()).find(row => row.props['aria-label'] === '回退到这一版（第 2 版）')!.props.onClick as () => void)()
    ;(dialogIn(view())!.props.onConfirm as () => void)()
    await flush()
    const dialog = dialogIn(view())!
    // P75r7（B10）：核心错误开头的英文键名（versionNo：）不显示给主人，中文原因原样保留。
    expect(dialog.props.error).toBe('这条技能没有第 2 版')
    ;(dialog.props.onCancel as () => void)()
    expect(dialogIn(view())).toBeUndefined()
  })
})

describe('放回：不常用的技能显示说明和「放回」，同样先确认', () => {
  it('说明一行与「放回」按钮；当前在用的技能没有', async () => {
    const { api } = fakeApi()
    const collapsed = (await openDetail(SAMPLE_SKILL_IDS.report, api)).view()
    expect(textOf(collapsed)).toContain('34 天内没有用到，移到「不常用」。')
    expect(buttonsIn(collapsed).map(button => textOf(button))).toContain('放回')
    const active = (await openDetail(SAMPLE_SKILL_IDS.form, api)).view()
    expect(buttonsIn(active).map(button => textOf(button))).not.toContain('放回')
  })

  it('点「放回」先出确认框；取消不调用；确认调用 restoreSkill 且参数正确', async () => {
    const { api, calls } = fakeApi()
    const { view } = await openDetail(SAMPLE_SKILL_IDS.template, api)
    const press = (): void => (buttonsIn(view()).find(row => textOf(row) === '放回')!.props.onClick as () => void)()
    press()
    const dialog = dialogIn(view())!
    expect(dialog.props.text).toBe('把「纪要模板」放回员工每次读取的技能目录？')
    expect(restoreConfirmText('纪要模板').text).toBe(dialog.props.text)
    ;(dialog.props.onCancel as () => void)()
    expect(calls.restore).toEqual([])
    press()
    ;(dialogIn(view())!.props.onConfirm as () => void)()
    await flush()
    expect(calls.restore).toEqual([SAMPLE_SKILL_IDS.template])
    expect(dialogIn(view())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. 右侧栏里的键盘路径
// ---------------------------------------------------------------------------

describe('右侧栏：Tab 到技能、Enter 打开、Esc 返回、焦点回到刚才那一条', () => {
  const card = fixtureOverview.bots[0]!
  const detail = fixtureBots[card.id] ?? null
  function mount(onCollapse: () => void = () => undefined) {
    const host = createHookHost()
    const { api } = fakeApi()
    const props = {
      card, detail, costs: undefined, sessions: [], onOpenSession: () => undefined, onCollapse, onEdit: () => undefined,
      skillLibrary: previewSkillLibrary, skillApi: api,
    }
    return { host, props, view: () => host.render(RightPanel, props) }
  }
  const escape = (aside: StubElement): { preventDefault: () => void; stopPropagation: () => void; key: string } => {
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    ;(aside.props.onKeyDown as (e: typeof event) => void)(event)
    return event
  }

  it('技能行是真正的按钮（Tab 可到达、Enter 与空格由浏览器触发点击）：不是 tabIndex=-1，不是 div', () => {
    const { view } = mount()
    const section = pick(view(), byType(SkillLibrarySection))[0]!
    const rows = pick(expand(SkillLibrarySection(section.props as never)), byType('button'))
    expect(rows.length).toBe(7)
    for (const row of rows) {
      expect(row.type).toBe('button')
      expect(row.props.tabIndex).toBeUndefined()
      expect(typeof row.props.id).toBe('string')
    }
  })

  it('打开详情后替换列表显示；Esc 回到列表、不收起侧栏；焦点回到刚才那一条；再按 Esc 才收起侧栏', () => {
    const focus = vi.fn()
    const getElementById = vi.fn(() => ({ focus }))
    vi.stubGlobal('document', { getElementById })
    const onCollapse = vi.fn()
    const { view } = mount(onCollapse)
    const list = view()
    expect(pick(list, byType(SkillLibrarySection))).toHaveLength(1)
    ;(pick(list, byType(SkillLibrarySection))[0]!.props.onOpen as (id: string) => void)(SAMPLE_SKILL_IDS.form)
    const opened = view()
    expect(pick(opened, byType(SkillDetail))).toHaveLength(1)
    expect(pick(opened, byType(SkillLibrarySection))).toHaveLength(0)
    // Esc：回到列表，没有收起侧栏，事件被接住（不再往外传）。
    const event = escape(opened as StubElement)
    expect(event.stopPropagation).toHaveBeenCalled()
    const back = view()
    expect(pick(back, byType(SkillLibrarySection))).toHaveLength(1)
    expect(pick(back, byType(SkillDetail))).toHaveLength(0)
    expect(onCollapse).not.toHaveBeenCalled()
    // 焦点回到刚才点开的那一条。
    expect(getElementById).toHaveBeenCalledWith(skillRowDomId(SAMPLE_SKILL_IDS.form))
    expect(focus).toHaveBeenCalledTimes(1)
    // 列表状态下再按 Esc：收起侧栏。
    escape(back as StubElement)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('详情里的「返回技能库」按钮与 Esc 同样回到列表', () => {
    vi.stubGlobal('document', { getElementById: () => ({ focus: () => undefined }) })
    const { view } = mount()
    ;(pick(view(), byType(SkillLibrarySection))[0]!.props.onOpen as (id: string) => void)(SAMPLE_SKILL_IDS.report)
    const detailElement = pick(view(), byType(SkillDetail))[0]!
    ;(detailElement.props.onBack as () => void)()
    expect(pick(view(), byType(SkillLibrarySection))).toHaveLength(1)
  })

  it('技能库一栏排在「在办的事」之后', () => {
    const { view } = mount()
    const aside = view() as StubElement
    const labels = pick(aside, byType('section')).map(row => row.props['aria-label'])
    expect(labels.indexOf('在办的事')).toBeGreaterThan(-1)
    // 技能库一栏是自己的组件，在「在办的事」那一栏之后渲染。
    const kids = pick(aside, byClass('ah-right-scroll'))[0]!.props.children as unknown[]
    const flat = kids.flat() as Array<StubElement | null | false>
    const workIndex = flat.findIndex(row => row !== null && row !== false && typeof row === 'object' && (row as StubElement).props['aria-label'] === '在办的事')
    const skillIndex = flat.findIndex(row => row !== null && row !== false && typeof row === 'object' && (row as StubElement).type === SkillLibrarySection)
    expect(workIndex).toBeGreaterThan(-1)
    expect(skillIndex).toBeGreaterThan(workIndex)
  })
})

// ---------------------------------------------------------------------------
// 5. 宿主的四个入口：参数检查与行为
// ---------------------------------------------------------------------------

describe('宿主入口：技能库、技能详情两条读取路由，回退、放回两条命令', () => {
  const hub = new FixtureHub()
  const call = (path: string): Promise<Response> => {
    const route = buildGuardedRoutes(hub).find(row => row.path === path.split('?')[0])!
    return route.fetch(new Request(`http://host${path}`))
  }
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined) })

  it('skill-library：给出员工的技能库视图；缺 botId 或员工不存在报中文错误', async () => {
    const ok = await (await call('/api/agent-hub/skill-library?botId=bot-tanlu')).json() as typeof previewSkillLibrary
    expect(ok.groups.map(row => row.key)).toEqual(['self', 'role', 'collapsed'])
    expect(ok.groups[0]!.note).toContain('探路自己维护')
    // 没有内容的员工：自己积累为空。
    const other = await (await call('/api/agent-hub/skill-library?botId=bot-xunjian')).json() as typeof previewSkillLibrary
    expect(other.groups[0]!.items).toEqual([])
    const missing = await call('/api/agent-hub/skill-library')
    expect(missing.status).toBe(500)
    expect(((await missing.json()) as { error: string }).error).toBe('botId：缺少这一项')
    const unknown = await call('/api/agent-hub/skill-library?botId=bot-none')
    expect(unknown.status).toBe(500)
    expect(((await unknown.json()) as { error: string }).error).toContain('没有这个机器人')
  })

  it('skill-detail：给出技能详情；缺 skillId 或技能不存在报中文错误', async () => {
    const ok = await (await call(`/api/agent-hub/skill-detail?skillId=${SAMPLE_SKILL_IDS.form}`)).json() as SkillDetailView
    expect(ok.title).toBe('表单页做法')
    const missing = await call('/api/agent-hub/skill-detail')
    expect(missing.status).toBe(500)
    expect(((await missing.json()) as { error: string }).error).toBe('skillId：缺少这一项')
    const unknown = await call('/api/agent-hub/skill-detail?skillId=sk_nosuchskil')
    expect(unknown.status).toBe(500)
    expect(((await unknown.json()) as { error: string }).error).toContain('技能不存在')
  })

  it('rollbackSkill：缺参数、类型不对、不是整数、小于 1 都报中文错误（真引擎与离线门面同一套）', async () => {
    const own = createSkillSample()
    const real = (input: Record<string, unknown>) => dispatchCommand(own.api, 'rollbackSkill', input)
    const offline = (input: Record<string, unknown>) => hub.command('rollbackSkill', input)
    for (const run of [real, offline]) {
      expect(await run({ versionNo: 2 })).toEqual({ ok: false, error: 'skillId：缺少这一项' })
      expect(await run({ skillId: 5, versionNo: 2 })).toEqual({ ok: false, error: 'skillId：必须是文字' })
      expect(await run({ skillId: '  ', versionNo: 2 })).toEqual({ ok: false, error: 'skillId：不能为空' })
      expect(await run({ skillId: SAMPLE_SKILL_IDS.form })).toEqual({ ok: false, error: 'versionNo：缺少这一项' })
      expect(await run({ skillId: SAMPLE_SKILL_IDS.form, versionNo: '2' })).toEqual({ ok: false, error: 'versionNo：必须是整数' })
      expect(await run({ skillId: SAMPLE_SKILL_IDS.form, versionNo: 1.5 })).toEqual({ ok: false, error: 'versionNo：必须是整数' })
      expect(await run({ skillId: SAMPLE_SKILL_IDS.form, versionNo: 0 })).toEqual({ ok: false, error: 'versionNo：不能小于 1' })
    }
  })

  it('restoreSkill：缺参数、类型不对报中文错误；技能不存在由 core 报错', async () => {
    const own = createSkillSample()
    for (const run of [(input: Record<string, unknown>) => dispatchCommand(own.api, 'restoreSkill', input), (input: Record<string, unknown>) => hub.command('restoreSkill', input)]) {
      expect(await run({})).toEqual({ ok: false, error: 'skillId：缺少这一项' })
      expect(await run({ skillId: 7 })).toEqual({ ok: false, error: 'skillId：必须是文字' })
      const missing = await run({ skillId: 'sk_nosuchskil' })
      expect(missing.ok).toBe(false)
    }
  })

  it('回退与放回的正常路径：离线门面里真的改了样例，并发出该员工的变化事件', async () => {
    const own = new FixtureHub()
    const events: Array<{ scope: string; botId?: string }> = []
    own.subscribe(event => events.push(event))
    expect((await own.command('rollbackSkill', { skillId: SAMPLE_SKILL_IDS.form, versionNo: 2 })).ok).toBe(true)
    expect((await own.skillDetail(SAMPLE_SKILL_IDS.form)).versions.find(row => row.current)!.no).toBe(2)
    expect((await own.command('restoreSkill', { skillId: SAMPLE_SKILL_IDS.report })).ok).toBe(true)
    const library = await own.skillLibrary('bot-tanlu')
    expect(library.groups[0]!.items.map(row => row.title)).toContain('周报排版')
    expect(events.filter(event => event.scope === 'bot' && event.botId === 'bot-tanlu')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 6. 仓库：随员工详情一起取技能库
// ---------------------------------------------------------------------------

describe('仓库：refreshBot 同时取技能库；技能库失败不影响员工详情', () => {
  it('两个请求都发出，视图存进 skillLibraries', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      const body = url.includes('skill-library') ? previewSkillLibrary : { card: { id: 'b_1' } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const hub = createHubStore()
    await hub.refreshBot('b_1')
    await flush()
    expect(urls.some(url => url.includes('bot?id=b_1'))).toBe(true)
    expect(urls.some(url => url.includes('skill-library?botId=b_1'))).toBe(true)
    expect(hub.getSnapshot().skillLibraries.b_1?.countText).toBe('在用 6 条，不常用 3 条')
    expect(hub.getSnapshot().skillLibraryErrors.b_1).toBeUndefined()
  })

  it('技能库取失败：员工详情照常，错误记在技能库一栏里，旧数据不被清掉', async () => {
    let failing = false
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      if (url.includes('skill-library')) {
        return failing
          ? new Response(JSON.stringify({ ok: false, error: '没有这个机器人：b_1' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify(previewSkillLibrary), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ card: { id: 'b_1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createHubStore()
    await hub.refreshBot('b_1')
    await flush()
    failing = true
    await hub.refreshBot('b_1')
    await flush()
    const state = hub.getSnapshot()
    expect(state.bots.b_1).toBeDefined()
    expect(state.skillLibraryErrors.b_1).toBe('没有这个机器人：b_1')
    expect(state.skillLibraries.b_1?.countText).toBe('在用 6 条，不常用 3 条')
    expect(state.connectionDown).toBe(false)
  })
})
