/**
 * P73r5：新建向导里，自主节奏的显示随「执行风格」的点选实时切换，且与提交参数一致。
 *
 * 真实验证里观察到：从头配置、选「执行」后自主节奏仍显示选项。组件代码在 P73f 已按角色分支；
 * 这里补一条端到端的界面逻辑测试：用状态化的宿主模拟「点风格卡片 -> 草稿更新 -> 重新渲染」，
 * 防止这条显示与事实不符的问题回归。
 */
import { describe, expect, it, vi } from 'vitest'
import { BotConfigFields, FIXED_RHYTHM_TEXT } from '../src/client/components/bot-config-fields.js'
import { buildCreateBotInput, emptyDraft, type BotConfigDraft } from '../src/client/logic/wizard.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 模拟新建向导：草稿由测试持有，onChange 与向导的 set 一样合并更新。 */
function mountWizardFields() {
  const host = createHookHost()
  let draft: BotConfigDraft = { ...emptyDraft(), name: '测试员' }
  const render = (): StubElement => host.render(BotConfigFields, {
    draft, onChange: (partial: Partial<BotConfigDraft>) => { draft = { ...draft, ...partial } },
    modelOptions: [], presetSkillOptions: [], dshSkillOptions: [], chiefTaken: false, problem: null,
  }) as StubElement
  /** 点某张风格卡片（按钮上方的文字为卡片名）。 */
  const pickRole = (label: string): void => {
    const card = findElements(render(), 'button').find(node => findElements(node, 'strong').some(s => textOf(s) === label))!
    ;(card.props.onClick as () => void)()
  }
  /** 自主节奏当前的显示：固定行文字，或选项名与被选中的那一项。 */
  const rhythmView = (): { fixed: string | null; options: string[]; pressed: string[] } => {
    const tree = render()
    const field = findElements(tree, 'div').find(node => findElements(node.props.children, 'span').some(span => span.props.className === 'ah-wizard-label' && textOf(span) === '自主节奏'))!
    const fixed = findElements(field, 'div').find(node => node.props.className === 'ah-fixed-line')
    const group = findElements(field, 'div').find(node => node.props.role === 'group' && node.props['aria-label'] === '自主节奏')
    const buttons = group === undefined ? [] : findElements(group, 'button')
    return {
      fixed: fixed === undefined ? null : textOf(fixed),
      options: buttons.map(b => textOf(findElements(b, 'strong')[0])),
      pressed: buttons.filter(b => b.props['aria-pressed'] === true).map(b => textOf(findElements(b, 'strong')[0])),
    }
  }
  return { pickRole, rhythmView, getDraft: () => draft }
}

describe('新建向导：自主节奏随执行风格切换', () => {
  it('选「执行」后只显示固定的一行，没有选项；提交参数不含节奏字段', () => {
    const w = mountWizardFields()
    w.pickRole('执行')
    expect(w.rhythmView()).toEqual({ fixed: FIXED_RHYTHM_TEXT, options: [], pressed: [] })
    expect(w.getDraft().role).toBe('executor')
    const input = buildCreateBotInput(w.getDraft())
    for (const key of ['onDemand', 'autonomy', 'pace']) expect(input).not.toHaveProperty(key)
  })

  it('从执行类切到「总管」或「盯守」，恢复四个选项；提交参数带所选档位', () => {
    const w = mountWizardFields()
    w.pickRole('执行')
    for (const label of ['盯守', '总管']) {
      w.pickRole(label)
      expect(w.rhythmView().fixed).toBeNull()
      expect(w.rhythmView().options).toEqual(['听吩咐', '提建议', '主动做', '全力推进'])
      expect(w.rhythmView().pressed).toEqual(['提建议'])
      expect(buildCreateBotInput(w.getDraft())).toMatchObject({ autonomy: 'L1', pace: 'normal', onDemand: false })
    }
  })

  it('再切回「调研」「建议」也是固定的一行', () => {
    const w = mountWizardFields()
    w.pickRole('盯守')
    for (const label of ['调研', '建议']) {
      w.pickRole(label)
      expect(w.rhythmView().fixed).toBe(FIXED_RHYTHM_TEXT)
      expect(w.rhythmView().options).toEqual([])
    }
  })
})
