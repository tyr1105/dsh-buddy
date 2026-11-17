/**
 * 员工状态按钮的纯逻辑测试（P73f 重写；原为 D07 第 24 条的 lifecycleButtons 等旧函数测试）。
 *
 * 界面上员工状态只有在岗、停用、归档三种：staffStatusOptions 给编辑弹窗的单选组，
 * statusChangeAction 把「从哪个状态改成哪个」翻成 lifecycleAction 的动作名，
 * headerStatusAction 和 staffAllTargets 管线程头部快捷按钮与「全部停用、全部恢复在岗」。
 * 旧的转正、解除隔离、退役按钮已经不存在，这里也断言它们不再出现。
 * 另附 D07 第 3 条的源码检查：切换员工时 RightPanel / ThreadPane 必须带 key，
 * 否则 A 上的归档确认、打断确认、编辑草稿会带到 B（一下就把另一位员工归档或打断）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVED_NO_CHANGE_NOTE, CHIEF_NO_ARCHIVE_NOTE, STAFF_STATUS_HINT, archiveConfirmLines, headerStatusAction, headerStatusLabel,
  isArchivedBot, staffAllTargets, staffLabelOfLifecycle, staffStatusOptions, statusChangeAction,
} from '../src/client/logic/lifecycle.js'

/** 把选项压成「标签:选中/可选/不可选」便于一眼比对。 */
const summary = (status: Parameters<typeof staffStatusOptions>[0], chief = false): string[] =>
  staffStatusOptions(status, { chief }).map(option => `${option.label}:${option.selected ? '选中' : option.disabled ? '不可选' : '可选'}`)

describe('staffStatusOptions：状态单选组的三个选项', () => {
  it('在岗：在岗选中，停用和归档可选', () => {
    expect(summary('on_duty')).toEqual(['在岗:选中', '停用:可选', '归档:可选'])
  })
  it('停用：停用选中，在岗和归档可选', () => {
    expect(summary('suspended')).toEqual(['在岗:可选', '停用:选中', '归档:可选'])
  })
  it('归档：归档选中，其余不可选，原因写在在岗旁边', () => {
    expect(summary('archived')).toEqual(['在岗:不可选', '停用:不可选', '归档:选中'])
    expect(staffStatusOptions('archived')[0]!.note).toBe(ARCHIVED_NO_CHANGE_NOTE)
  })
  it('总管的归档不可选，旁边写「总管不能归档」；其余选项不受影响', () => {
    const options = staffStatusOptions('on_duty', { chief: true })
    expect(options.map(option => `${option.label}:${option.disabled ? '不可选' : '可选'}`)).toEqual(['在岗:可选', '停用:可选', '归档:不可选'])
    expect(options[2]!.note).toBe(CHIEF_NO_ARCHIVE_NOTE)
    expect(CHIEF_NO_ARCHIVE_NOTE).toBe('总管不能归档')
  })
  it('反例：非总管的归档旁边没有说明', () => {
    expect(staffStatusOptions('on_duty')[2]!.note).toBeNull()
  })
  it('单选组下面的说明一行与设计稿原文一致', () => {
    expect(STAFF_STATUS_HINT).toBe('停用：保留记忆和工位，不接新活。归档：腾出名额，记录保留可查。')
  })
})

describe('statusChangeAction：选哪个状态发哪个动作', () => {
  it('在岗选停用发 suspend；停用选在岗发 reinstate；选归档发 archive', () => {
    expect(statusChangeAction('on_duty', 'suspended')).toBe('suspend')
    expect(statusChangeAction('suspended', 'on_duty')).toBe('reinstate')
    expect(statusChangeAction('on_duty', 'archived')).toBe('archive')
    expect(statusChangeAction('suspended', 'archived')).toBe('archive')
  })
  it('反例：选当前状态、已归档的员工选任何状态，都不发动作', () => {
    expect(statusChangeAction('on_duty', 'on_duty')).toBeNull()
    expect(statusChangeAction('suspended', 'suspended')).toBeNull()
    expect(statusChangeAction('archived', 'on_duty')).toBeNull()
    expect(statusChangeAction('archived', 'suspended')).toBeNull()
  })
})

describe('headerStatusAction：线程头部只有「停用」「恢复在岗」', () => {
  it('在岗 → suspend；停用 → reinstate；已归档、不是员工对话 → null（头部不显示）', () => {
    expect(headerStatusAction('on_duty')).toBe('suspend')
    expect(headerStatusAction('suspended')).toBe('reinstate')
    expect(headerStatusAction('archived')).toBeNull()
    expect(headerStatusAction(null)).toBeNull()
  })
  it('按钮文字', () => {
    expect(headerStatusLabel('suspend')).toBe('停用')
    expect(headerStatusLabel('reinstate')).toBe('恢复在岗')
  })
})

describe('staffAllTargets：全部停用、全部恢复在岗的选目标', () => {
  const bots = [
    { id: 'a', staffStatus: 'on_duty' as const },
    { id: 'b', staffStatus: 'on_duty' as const },
    { id: 's', staffStatus: 'suspended' as const },
    { id: 'r', staffStatus: 'archived' as const },
  ]
  it('全部停用只选在岗；全部恢复在岗只选停用；已归档的永远不动', () => {
    expect(staffAllTargets(bots, 'suspend')).toEqual(['a', 'b'])
    expect(staffAllTargets(bots, 'reinstate')).toEqual(['s'])
  })
})

describe('archiveConfirmLines：归档二次确认的文字', () => {
  it('能归档：主句写后果；没有项目成员身份时没有「将移出项目」', () => {
    const lines = archiveConfirmLines('林舟', { canArchive: true, reason: null, memberProjects: [] })
    expect(lines.main).toBe('归档后林舟不再接活，腾出 1 个名额；记录保留可查。归档后不能恢复为在岗。')
    expect(lines.projects).toBeNull()
    expect(lines.blocked).toBeNull()
  })
  it('有 memberProjects：另起一行，项目名用顿号连接', () => {
    const lines = archiveConfirmLines('林舟', {
      canArchive: true, reason: null,
      memberProjects: [{ projectId: 'p1', projectName: '活动报名页' }, { projectId: 'p2', projectName: '竞品周报' }],
    })
    expect(lines.projects).toBe('将移出项目：活动报名页、竞品周报')
  })
  it('反例：不能归档时只有原因，没有主句和项目行', () => {
    expect(archiveConfirmLines('林舟', { canArchive: false, reason: '它还有 1 件在办的事。' })).toEqual({ blocked: '它还有 1 件在办的事。', main: null, projects: null })
  })
  it('旧宿主没有 memberProjects 时按没有处理', () => {
    expect(archiveConfirmLines('林舟', { canArchive: true, reason: null }).projects).toBeNull()
  })
})

describe('旧的退役判断统一为归档', () => {
  it('isArchivedBot：有 staffStatus 以它为准；旧形状按 retired 或归档标记判断', () => {
    expect(isArchivedBot({ staffStatus: 'archived', lifecycle: 'active' })).toBe(true)
    expect(isArchivedBot({ staffStatus: 'on_duty', lifecycle: 'retired' })).toBe(false)
    expect(isArchivedBot({ lifecycle: 'retired' })).toBe(true)
    expect(isArchivedBot({ lifecycle: 'active', archived: true })).toBe(true)
    expect(isArchivedBot({ lifecycle: 'paused' })).toBe(false)
  })
  it('staffLabelOfLifecycle：只有 lifecycle 时按 core 的合并规则翻成三种状态', () => {
    expect(['draft', 'probation', 'active', 'paused', 'quarantined', 'retired'].map(value => staffLabelOfLifecycle(value as never)))
      .toEqual(['在岗', '在岗', '在岗', '停用', '停用', '归档'])
  })
})

describe('D07 第 3 条：切换员工时本地状态必须复位（源码检查）', () => {
  // 组件测试没有 jsdom 渲染环境（react 是桩），这里退而检查 HubPage 对两个组件
  // 传了 key：key 变化会让 React 丢弃旧实例，归档确认/打断确认/编辑草稿/输入草稿
  // 全部随之消失。删掉 key 会立刻在这里失败。
  const page = readFileSync(fileURLToPath(new URL('../src/client/pages/HubPage.tsx', import.meta.url)), 'utf8')
  it('ThreadPane 带 key={selectedThread}（A 的打断确认/输入草稿不会带到 B）', () => {
    expect(page).toMatch(/<ThreadPane[^>]*\bkey=\{selectedThread\}/s)
  })
  it('RightPanel 带 key={selectedBot?.id ?? \'none\'}（A 的归档确认/编辑档案不会带到 B）', () => {
    expect(page).toMatch(/<RightPanel[^>]*\bkey=\{selectedBot\?\.(id|card\.id)/s)
  })
})
