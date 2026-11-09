/**
 * 样例资料授权矩阵（V2-PH2-04 样例数据模式专用）：给 FixtureHub 与离线走查提供一份
 * 与 fixtures.ts 三个样例队友一致的资料视图：普通目录一条（全队可读）、受限文件一条
 * （队友只读与读写两类授权）、受限链接一条（含一条授权对象已找不到、subjectName 为 null
 * 的历史授权）、已归档资料一条。
 *
 * 为什么单独成文件：资料行内嵌授权行，混进 fixtures.ts 会淹没其他样例；形状严格照
 * core 的 ResourceView（api/resource-views.ts），正式运行时由 /api/agent-hub/resource 返回。
 * 主人取消编制后授权对象只认队友本人，不再有席位与部门授权。
 * 这是静态样例，不追求像 resourceView 那样自动拼标签——标签与计数在本文件底部手工对齐。
 */
import type { Grant, Resource, ResourceGrantViewRow, ResourceView, ResourceViewRow } from './views.js'

/** 样例基准时刻：与样例办公室/项目一致（2026-11-06 14:20 UTC），避免每次刷新漂移。 */
const NOW = Date.UTC(2026, 10, 6, 14, 20)
const MIN = 60_000

/** 样例队友名字：与 fixtures.ts / fixture-office 保持一致。 */
const BOT_NAME: Readonly<Record<string, string>> = {
  'bot-tanlu': '探路',
  'bot-xunjian': '巡检员',
  'bot-zongguan': '总管',
}

/** 造一条资料事实：样例只关心展示字段，时间戳统一写死。 */
function resource(input: {
  id: string
  name: string
  kind: Resource['kind']
  locator: string
  sensitivity: Resource['sensitivity']
  createdAt: number
  archivedAt?: number | null
}): Resource {
  const createdAt = input.createdAt
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    locator: input.locator,
    sensitivity: input.sensitivity,
    createdAt,
    updatedAt: input.archivedAt ?? createdAt,
    archivedAt: input.archivedAt ?? null,
  }
}

/** 造一条授权事实（本期只有主人能授权，createdBy 固定 owner；对象只能是队友）。 */
function grant(input: {
  id: string
  resourceId: string
  subjectId: string
  level: Grant['level']
  createdAt: number
}): Grant {
  return {
    id: input.id, resourceId: input.resourceId, subjectKind: 'bot', subjectId: input.subjectId,
    level: input.level, createdAt: input.createdAt, createdBy: 'owner',
  }
}

// ---------- 资料事实：未归档在前、已归档在后（与 core resourceView 排序一致） ----------

const resShared = resource({
  id: 'res_shared', name: '团队共享资料', kind: 'dir', sensitivity: 'normal',
  locator: '/Users/demo/AgentHub/shared/团队资料', createdAt: NOW - 40 * MIN,
})
const resPlaybook = resource({
  id: 'res_playbook', name: '竞品打法手册', kind: 'file', sensitivity: 'restricted',
  locator: '/Users/demo/AgentHub/shared/调研资料/竞品打法手册.md', createdAt: NOW - 30 * MIN,
})
const resDashboard = resource({
  id: 'res_dashboard', name: '经营看板（内部）', kind: 'url', sensitivity: 'restricted',
  locator: 'https://inside.example.com/dashboard', createdAt: NOW - 20 * MIN,
})
const resOld = resource({
  id: 'res_old', name: '旧版值班表', kind: 'file', sensitivity: 'normal',
  locator: '/Users/demo/AgentHub/shared/盯守资料/旧版值班表.md', createdAt: NOW - 90 * MIN, archivedAt: NOW - 10 * MIN,
})

// ---------- 授权事实：覆盖两种级别，含一条找不到对象的历史授权 ----------

const grTanlu = grant({
  id: 'gr_tanlu_playbook', resourceId: 'res_playbook', subjectId: 'bot-tanlu', level: 'read', createdAt: NOW - 28 * MIN,
})
const grXunjian = grant({
  id: 'gr_xunjian_playbook', resourceId: 'res_playbook', subjectId: 'bot-xunjian', level: 'write', createdAt: NOW - 24 * MIN,
})
// 对象已退役且查无此 Bot：core 视图会给 subjectName=null，界面要显示「对象已删除或归档」。
const grGone = grant({
  id: 'gr_bot_gone', resourceId: 'res_dashboard', subjectId: 'bot-gone', level: 'read', createdAt: NOW - 16 * MIN,
})

/** 把授权事实包装成展开行（中文名与级别文案照 core resource-views 的口径手工对齐）。 */
function grantRow(g: Grant, resourceName: string): ResourceGrantViewRow {
  const subjectName = BOT_NAME[g.subjectId] ?? null
  return {
    grant: g, resourceName, subjectKind: 'bot', subjectKindLabel: '队友',
    subjectId: g.subjectId, subjectName, level: g.level, levelLabel: g.level === 'read' ? '只读' : '读写',
  }
}

const grantRows: ResourceGrantViewRow[] = [
  grantRow(grTanlu, '竞品打法手册'),
  grantRow(grXunjian, '竞品打法手册'),
  grantRow(grGone, '经营看板（内部）'),
]

/** 把资料事实包装成视图行：中文标签、归档标记与该资料的全部授权。 */
function row(r: Resource, kindLabel: string, sensitivityLabel: string): ResourceViewRow {
  return {
    resource: r,
    kindLabel, sensitivityLabel,
    archived: r.archivedAt !== null,
    grants: grantRows.filter(g => g.grant.resourceId === r.id),
  }
}

/** 样例资料全貌：3 条活跃 + 1 条归档、3 条授权。 */
export const fixtureResource: ResourceView = {
  asOf: NOW,
  resources: [
    row(resShared, '目录', '全员可读'),
    row(resPlaybook, '文件', '指定队友可读'),
    row(resDashboard, '链接', '指定队友可读'),
    row(resOld, '文件', '全员可读'),
  ],
  grants: grantRows,
  counts: { total: 4, active: 3, archived: 1, grants: 3 },
}
