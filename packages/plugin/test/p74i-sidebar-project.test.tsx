/**
 * P74i 侧栏与项目页测试（第六类）：
 * - 侧栏总管那一行的角色文字：chiefJobLine 不为 null 时用它，为 null 时保持「有事先找我」；
 * - 项目页事务清单：一件事行排在旧事务前面（标题、执行者、状态小标签按 stateTone 着色、交付时间），
 *   点击进入这件事的主题；旧事务的状态词读视图。
 */
import { describe, expect, it, vi } from 'vitest'
import { PathRow, ProjectBoard } from '../src/client/pages/ProjectPage.js'
import { roleLineOf } from '../src/client/logic/agreement.js'
import { projectTaskRows } from '../src/client/logic/project-page.js'
import { sampleProjectJobRows } from '../src/shared/fixture-job.js'
import type { ProjectViewRow } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')

const chief = { role: 'chief', lifecycle: 'active', staffStatus: 'active', roleLabel: '总管', staffStatusLabel: '在岗' }

describe('侧栏总管那一行（P74i）', () => {
  it('chiefJobLine 不为 null 时用它；为 null 或没有这个字段时保持「有事先找我」', () => {
    expect(roleLineOf({ ...chief, chiefJobLine: '活动报名页　核对中' })).toBe('活动报名页　核对中')
    expect(roleLineOf({ ...chief, chiefJobLine: '2 件在办' })).toBe('2 件在办')
    expect(roleLineOf({ ...chief, chiefJobLine: null })).toBe('有事先找我')
    expect(roleLineOf(chief)).toBe('有事先找我')
    // 其他员工不受影响。
    expect(roleLineOf({ ...chief, role: 'executor', roleLabel: '执行' })).toBe('执行　在岗')
  })
})

/** 造一个带一件事行与一条旧事务的项目行（其余字段只满足形状）。 */
function rowWithJobs(): ProjectViewRow {
  const base = {
    project: { id: 'prj_1', name: '活动项目', status: 'active', memberBotIds: [], createdAt: 0, updatedAt: 0, ownerBotId: 'b_1' },
    statusLabel: '进行中',
    members: [{ botId: 'b_1', name: '总管', role: 'chief', roleLabel: '总管', invalid: false, isOwner: true }],
    tasks: [{
      task: { id: 'pt_old1', title: '旧事务：整理场地清单', status: 'doing', projectId: 'prj_1', createdAt: 0, updatedAt: 0 },
      title: '旧事务：整理场地清单', assigneeName: '林舟', assigneeInvalid: false, statusLabel: '进行中', topicId: 'ptp_old1',
    }],
    acceptance: [], issues: [], teamLayers: { layers: [] }, topics: [],
    contextEmpty: true, contextFilePath: '/x/context.md', contextRevisions: [], contextProposals: [],
    background: { text: '', updatedByName: null, updatedText: null, sourceLabels: [] },
    path: { workspaceDir: '/x/work', sharedDir: '/x/work' },
    jobRows: sampleProjectJobRows,
  } as unknown as ProjectViewRow
  return base
}

describe('项目页的一件事行（P74i）', () => {
  it('排在旧事务前面；列：标题、执行者、状态小标签（按 stateTone 着色）、交付时间；点击进入这件事的主题', () => {
    const onOpenTopic = vi.fn()
    const tree = createHookHost().render(ProjectBoard, { row: rowWithJobs(), onOpenTopic })
    const text = textOf(tree)
    // 一件事在前、旧事务在后。
    expect(text.indexOf('待你验收')).toBeLessThan(text.indexOf('旧事务：整理场地清单'))
    // 三行一件事都在（待你验收、受阻、已完成），状态小标签着色类来自 stateTone。
    const tags = findElements(tree, 'span').filter(node => classOf(node).startsWith('ah-tag'))
    expect(tags.some(node => classOf(node) === 'ah-tag is-you' && textOf(node) === '待你验收')).toBe(true)
    expect(tags.some(node => classOf(node) === 'ah-tag is-ok' && textOf(node) === '已完成')).toBe(true)
    expect(text).toContain('林舟')
    expect(text).toContain('11月17日 18:00 前')
    // 点击一件事进入它的主题（topicId 来自 core 的行）。
    const items = findElements(tree, 'button').filter(node => classOf(node).includes('ah-prj-item-link'))
    ;(items[0]!.props.onClick as () => void)()
    expect(onOpenTopic).toHaveBeenCalledWith(sampleProjectJobRows[0]!.topicId)
  })

  it('没有 jobRows 时照旧（只有旧事务，不画空的区块）', () => {
    const row = rowWithJobs()
    delete (row as Partial<ProjectViewRow>).jobRows
    const tree = createHookHost().render(ProjectBoard, { row, onOpenTopic: () => undefined })
    expect(textOf(tree)).not.toContain('待你验收')
    expect(textOf(tree)).toContain('旧事务：整理场地清单')
  })

  it('旧事务的状态词读视图（statusLabel），插件不写死', () => {
    const row = rowWithJobs()
    delete (row as Partial<ProjectViewRow>).jobRows
    const rows = projectTaskRows(row)
    expect(rows[0]!.statusLabel).toBe('进行中')
    const tree = createHookHost().render(ProjectBoard, { row, onOpenTopic: () => undefined })
    expect(textOf(tree)).toContain('进行中')
  })
})

describe('项目页的文件路径行（U05）', () => {
  it('正文只显示目录名，完整路径进悬停，复制按钮仍在且拷贝完整路径', () => {
    const tree = createHookHost().render(PathRow, {
      row: { label: '项目目录', value: '/x/work', display: 'work/', title: '/x/work' },
    })
    const path = findElements(tree, 'code').find(node => classOf(node) === 'ah-prj-path-value')!
    expect(textOf(path)).toBe('work/')
    expect(path.props.title).toBe('/x/work')
    const copy = findElements(tree, 'button').find(node => node.props['aria-label'] === '复制项目目录')!
    expect(copy).toBeDefined()
  })

  it('没有设置目录时正文写「未设置」，不挂悬停，也不给复制按钮', () => {
    const tree = createHookHost().render(PathRow, {
      row: { label: '项目目录', value: '', display: '未设置' },
    })
    const path = findElements(tree, 'code').find(node => classOf(node) === 'ah-prj-path-value')!
    expect(textOf(path)).toBe('未设置')
    expect(path.props.title).toBeUndefined()
    expect(findElements(tree, 'button').some(node => node.props['aria-label'] === '复制项目目录')).toBe(false)
  })
})
