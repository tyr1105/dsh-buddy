/**
 * 资料授权矩阵页的纯逻辑（V2-PH2-04）：把 core 的 ResourceView 翻译成页面直接用的
 * 中文结论与表单模型——顶部计数一句话、普通/受限资料的访问结论、授权 chip 文案
 * （含对象已删除或归档的历史授权）、授权对象（只认队友）选项、资料表单的前置校验与
 * saveResource/setGrant 命令入参拼装。
 *
 * 为什么单独成文件：这些文案与校验是交互契约，写成纯函数才能逐条单测；组件只负责
 * 渲染，不自己猜授权语义。边界纪律：
 * - 路径是否在 rootDir/shared 子树内、授权对象是否存在、是否归档，全由 core 判定；
 * - canRead/effectiveGrants 等真正的授权判定只在 core，前端不复制；
 * - 前端只拦「空、超长、明显不是 http(s)、明显不是绝对路径」这类不用查数据就能发现的错，
 *   让错误就近出现在对应字段下方，core 的中文报错仍会在提交时兜底。
 * 主人取消编制后授权对象只认队友本人，不再有部门与席位授权。
 */
import type { Lifecycle, ResourceGrantViewRow, ResourceView, ResourceViewRow } from '../../shared/views.js'

/** 资料类型（从视图行上取索引类型，避免再抄一份枚举；note 本期 core 拒绝创建）。 */
export type ResourceKind = ResourceViewRow['resource']['kind']
/** 表单允许新建的资料类型：不给 note 入口（core 本期保守拒绝）。 */
export type FormResourceKind = Exclude<ResourceKind, 'note'>
/** 敏感级别（普通 / 受限）。 */
export type ResourceSensitivity = ResourceViewRow['resource']['sensitivity']
/** 授权对象类型（当前只有队友）与级别（只读 / 读写）。 */
export type GrantSubjectKind = ResourceGrantViewRow['subjectKind']
export type GrantLevel = ResourceGrantViewRow['level']

/**
 * 表单里的静态选项。客户端 bundle 不能 import core 运行时（红线：对 core 只许
 * type-only import），所以这里按 core 的 RESOURCE_KIND_LABELS / RESOURCE_SENSITIVITY_LABELS /
 * GRANT_SUBJECT_KIND_LABELS / GRANT_LEVEL_LABELS 手工对齐一份；core 改枚举时类型检查
 * （value 联合类型）会报出来，中文标签变化需同步这里。
 */
export const RESOURCE_KIND_OPTIONS: ReadonlyArray<{ value: FormResourceKind; label: string }> = [
  { value: 'dir', label: '目录' },
  { value: 'file', label: '文件' },
  { value: 'url', label: '链接' },
]
export const RESOURCE_SENSITIVITY_OPTIONS: ReadonlyArray<{ value: ResourceSensitivity; label: string }> = [
  { value: 'normal', label: '全员可读' },
  { value: 'restricted', label: '指定队友可读' },
]
export const GRANT_SUBJECT_OPTIONS: ReadonlyArray<{ value: GrantSubjectKind; label: string }> = [
  { value: 'bot', label: '队友' },
]
export const GRANT_LEVEL_OPTIONS: ReadonlyArray<{ value: GrantLevel; label: string }> = [
  { value: 'read', label: '只读' },
  { value: 'write', label: '读写' },
]

/**
 * 常驻边界横幅原文（U11 文案 audit #30 定稿，替换任务卡旧句）：
 * 先说管什么、再说不管什么，不用「治理」「授权矩阵」这类内部词。
 */
export const RESOURCE_BOUNDARY_TEXT = '这里只管一件事：队友通过插件读资料时，要不要你批准。它自己在 DSH 里打开文件，不归这里管。'

/** 顶部一句话计数：资料总数、活跃、归档与授权条数都取自 core 视图，界面不自己数。 */
export function resourceSummary(view: ResourceView): string {
  const c = view.counts
  return `资料 ${c.total} 条·活跃 ${c.active}·归档 ${c.archived}·授权 ${c.grants} 条`
}

/** 活跃资料行：直接用视图顺序，不重排（core resourceView 已保证未归档在前）。 */
export function activeRows(view: ResourceView): ResourceViewRow[] {
  return view.resources.filter(row => !row.archived)
}

/** 已归档资料行：同样保持视图顺序。 */
export function archivedRows(view: ResourceView): ResourceViewRow[] {
  return view.resources.filter(row => row.archived)
}

/**
 * 一行资料的访问结论：
 * - 普通资料不看授权，全队在岗队友经中心都可读；
 * - 受限资料只认显式授权，直接报授权对象个数（0 个也要如实说，提醒主人还没人能读）。
 */
export function accessConclusion(row: ResourceViewRow): string {
  if (row.resource.sensitivity === 'normal') return '在岗队友都能读'
  return row.grants.length === 0 ? '暂未选择队友，当前无人可读' : `${row.grants.length} 位队友能读`
}

/** 授权对象名：历史授权的对象可能已删除或归档（视图给 null），用固定中文占位。 */
export function grantSubjectText(grant: ResourceGrantViewRow): string {
  return grant.subjectName ?? '队友已删除或退役'
}

/**
 * 授权 chip 文案：对象类型＋对象名＋级别，例如「队友：探路（只读）」。
 * 对象找不到时不显示裸 id，而是「队友：队友已删除或退役（只读）」，id 放 title 供追查。
 */
export function grantChipText(grant: ResourceGrantViewRow): string {
  return `${grant.subjectKindLabel}：${grantSubjectText(grant)}（${grant.levelLabel}）`
}

/** 空态文案：一条资料都没有 / 只剩归档资料；有活跃资料时返回 null（不算空态）。 */
export function resourceEmptyText(view: ResourceView): string | null {
  const active = activeRows(view).length
  const archived = archivedRows(view).length
  if (active === 0 && archived === 0) {
    return '暂无资料授权。点击「＋ 新资料」登记目录、文件或链接，并选择可读对象。'
  }
  if (active === 0) {
    return `暂无未归档资料。归档区保留 ${archived} 条历史资料。`
  }
  return null
}

/** 授权对象只有一个可选项：队友本人。 */
export interface GrantSubjectOption {
  kind: GrantSubjectKind
  id: string
  label: string
}

/** 授权对象选项（当前只有队友一组）。 */
export interface GrantSubjectGroups {
  bot: GrantSubjectOption[]
}

/**
 * 非在岗但仍允许选为授权对象的队友状态后缀。
 * 保守口径：只排除 retired（退役队友在 core 里也过不了 setGrant 对象校验）；
 * 隔离中（quarantined）/暂停/草稿仍保留——授权是配置动作，主人可能要提前配好，
 * 是否生效由 core 在读取时按生命周期把关。这里如实标注状态，避免主人误选。
 */
const BOT_STATE_SUFFIX: Partial<Record<Lifecycle, string>> = {
  draft: '草稿',
  paused: '已暂停',
  quarantined: '隔离中',
}

/**
 * 拼授权对象选项：总览里除 retired 外都保留，非在岗/试岗的状态在文案里点出。
 * 调用方在总览还没加载时传空数组，对话框据此显示空态。
 */
export function grantSubjectGroups(
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle }>,
): GrantSubjectGroups {
  const bot: GrantSubjectOption[] = bots
    .filter(b => b.lifecycle !== 'retired')
    .map(b => {
      const suffix = BOT_STATE_SUFFIX[b.lifecycle]
      return { kind: 'bot' as const, id: b.id, label: suffix ? `${b.name}（${suffix}）` : b.name }
    })
  return { bot }
}

/** 取某一组选项（保持按类型索引的调用方式）。 */
export function subjectOptionsOf(groups: GrantSubjectGroups, kind: GrantSubjectKind): GrantSubjectOption[] {
  return kind === 'bot' ? groups.bot : []
}

/** 找到某资料上指定对象的现有授权（null=新授权；非 null 时再设就是改级别）。 */
export function findGrant(
  row: ResourceViewRow,
  subjectKind: GrantSubjectKind,
  subjectId: string,
): ResourceGrantViewRow | null {
  return row.grants.find(g => g.subjectKind === subjectKind && g.subjectId === subjectId) ?? null
}

/** 资料名称的前置校验（trim 后判空与超长）；错误文案说清是哪一项。 */
export function validateResourceName(name: string): string | null {
  const value = name.trim()
  if (value === '') return '资料名称：不能为空'
  if (value.length > 120) return `资料名称：不能超过 120 字（现在 ${value.length} 字）`
  return null
}

/**
 * 资料位置的前置校验：
 * - 空 / 超长先拦；
 * - url 必须是能解析的 http(s) 地址（ftp、mailto、裸域名都不放行）；
 * - dir/file 只提示必须是以 / 开头的绝对路径——是否落在 rootDir/shared 子树内、
 *   是否指向凭据位置，全部由 core 的 resolveSharedLocator 判定，前端不复制路径规则。
 */
export function validateResourceLocator(kind: FormResourceKind, locator: string): string | null {
  const value = locator.trim()
  if (value === '') return '资料位置：不能为空'
  if (value.length > 1000) return `资料位置：不能超过 1000 字（现在 ${value.length} 字）`
  if (kind === 'url') {
    let url: URL | null = null
    try { url = new URL(value) } catch { url = null }
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return '资料链接：必须是 http:// 或 https:// 开头的有效地址'
    }
    return null
  }
  if (!value.startsWith('/')) {
    return '资料路径：必须填写共享目录内的绝对路径（以 / 开头）；是否在共享目录内由中心校验'
  }
  return null
}

/** 表单当前值。 */
export interface ResourceFormValues {
  name: string
  kind: FormResourceKind
  locator: string
  sensitivity: ResourceSensitivity
}

/** 表单校验失败：带上出错字段，对话框据此把焦点送到第一个出错的控件。 */
export interface ResourceFormError {
  field: 'name' | 'locator' | 'access'
  message: string
}

/** 整张资料表单的前置校验：名称先于位置（自上而下第一个错误）。 */
export function validateResourceForm(values: ResourceFormValues): ResourceFormError | null {
  const nameError = validateResourceName(values.name)
  if (nameError) return { field: 'name', message: nameError }
  const locatorError = validateResourceLocator(values.kind, values.locator)
  if (locatorError) return { field: 'locator', message: locatorError }
  return null
}

/** 「谁能读」的校验：必须明确选一项，选了指定队友就至少勾一位。 */
export function validateResourceAccess(access: ResourceSensitivity | null, botIds: readonly string[]): ResourceFormError | null {
  if (access === null) return { field: 'access', message: '谁能读：请选择全员可读或指定队友可读' }
  if (access === 'restricted' && botIds.length === 0) return { field: 'access', message: '谁能读：至少勾选一位队友' }
  return null
}

/** 比较勾选结果和现有授权，算出要新增和要取消的队友。 */
export function grantChanges(row: ResourceViewRow | null, botIds: readonly string[]): { add: string[]; remove: string[] } {
  const current = (row?.grants ?? []).filter(g => g.subjectKind === 'bot').map(g => g.subjectId)
  return {
    add: botIds.filter(id => !current.includes(id)),
    remove: current.filter(id => !botIds.includes(id)),
  }
}

/**
 * 拼 saveResource 入参（core 是 strictObject，不能多键）：
 * - 名称/位置提交 trim 后的值；
 * - 编辑带 id；类型始终带上（core 规定类型创建后不可改，编辑框里类型禁用）。
 */
export function buildSaveResourceInput(values: ResourceFormValues, editingId?: string | null): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    name: values.name.trim(),
    kind: values.kind,
    locator: values.locator.trim(),
    sensitivity: values.sensitivity,
  }
  if (editingId) raw.id = editingId
  return raw
}

/** 拼 setGrant 入参：同 resourceId+subjectKind+subjectId 再设即改级别（core upsert）。 */
export function buildSetGrantInput(
  resourceId: string,
  subjectKind: GrantSubjectKind,
  subjectId: string,
  level: GrantLevel,
): Record<string, unknown> {
  return { resourceId, subjectKind, subjectId, level }
}
