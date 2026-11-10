/**
 * 项目编辑表单的纯逻辑（P60）：字段上限、默认负责人、前置校验和命令入参拼装。
 *
 * 表单只有五项：项目名、负责人、成员、文件路径、背景。
 * 这里只拦「空、超长、没选负责人」这类不用查数据就能发现的错，让错误就近显示；
 * 队友是否存在、负责人是否合规，最终都由 core 判定。
 */
import type { ProjectViewRow } from '../../shared/views.js'
import type { BotOption } from './project-page.js'

// 客户端不能引入 core 的运行时代码，这几个上限手工和 core 的 SaveProjectSchema 对齐。
/** 项目名称上限。 */
export const PROJECT_NAME_MAX = 120
/** 项目目录路径上限。 */
export const PROJECT_SHARED_DIR_MAX = 1000
/** 成员上限（core V2_DEFAULTS.PROJECT_MEMBER_MAX）。 */
export const PROJECT_MEMBER_MAX = 20
/** 项目背景上限（core SaveProjectContextSchema）。 */
export const PROJECT_BACKGROUND_MAX = 2000

/** 表单当前值：ownerBotId 用空串表示还没选。 */
export interface ProjectFormValues {
  name: string
  ownerBotId: string
  memberBotIds: string[]
  sharedDir: string
  background: string
}

export type ProjectFormField = 'name' | 'owner' | 'members' | 'sharedDir' | 'background'

/** 校验失败：带上出错字段，弹窗据此把焦点送过去。 */
export interface ProjectFormError {
  field: ProjectFormField
  message: string
}

/** 这位队友能不能当负责人：建议风格只提意见不动手，不能当。 */
export function canBeOwner(option: Pick<BotOption, 'role'>): boolean {
  return option.role !== 'advisor'
}

/** 算默认负责人时只挑在岗的：挑一个暂停的，主人一开口就会被告知负责人不在岗。 */
function onDuty(option: Pick<BotOption, 'lifecycle'>): boolean {
  return option.lifecycle === 'active' || option.lifecycle === 'probation'
}

/**
 * 默认负责人：成员里的总管，没有总管就是第一位非建议风格的成员。
 * 和 core 的 pickDefaultOwnerId 同一条规则。选不出来返回空串，由校验提示主人。
 */
export function defaultOwnerId(memberBotIds: readonly string[], options: readonly BotOption[]): string {
  const members = memberBotIds.flatMap(id => options.filter(option => option.botId === id))
  const eligible = members.filter(option => canBeOwner(option) && onDuty(option))
  return (eligible.find(option => option.role === 'chief') ?? eligible[0])?.botId ?? ''
}

/**
 * 成员名单变了之后的表单值：现任负责人还在成员里就不动，主人选过的不被覆盖；
 * 被移出去了（或者还没选）才按默认规则重新选一位。
 */
export function withMembers(values: ProjectFormValues, memberBotIds: string[], options: readonly BotOption[]): ProjectFormValues {
  const ownerBotId = values.ownerBotId !== '' && memberBotIds.includes(values.ownerBotId)
    ? values.ownerBotId
    : defaultOwnerId(memberBotIds, options)
  return { ...values, memberBotIds, ownerBotId }
}

/** 负责人下拉里的一项。 */
export interface OwnerChoice {
  botId: string
  name: string
  disabled: boolean
}

/**
 * 负责人的候选：只列已勾选的成员，建议风格的不可选。
 * 例外：现任负责人如果本来就是建议风格（旧项目），仍然显示可选，
 * 否则主人连项目名都改不了，core 也只在负责人变动时才校验风格。
 */
export function ownerChoices(values: ProjectFormValues, options: readonly BotOption[], initialOwnerId: string): OwnerChoice[] {
  return options
    .filter(option => values.memberBotIds.includes(option.botId))
    .map(option => ({
      botId: option.botId,
      name: canBeOwner(option) ? option.name : `${option.name}（建议风格不能当）`,
      disabled: !canBeOwner(option) && option.botId !== initialOwnerId,
    }))
}

/** 打开表单时的初值：失效成员不预选；负责人失效时按默认规则补一位，保存即修好。 */
export function initialProjectForm(row: ProjectViewRow | null, options: readonly BotOption[]): ProjectFormValues {
  if (row === null) return { name: '', ownerBotId: '', memberBotIds: [], sharedDir: '', background: '' }
  const memberBotIds = row.members.filter(member => !member.invalid).map(member => member.botId)
  const ownerValid = !row.ownerInvalid && row.ownerBotId !== null && memberBotIds.includes(row.ownerBotId)
  return {
    name: row.project.name,
    ownerBotId: ownerValid ? row.ownerBotId! : defaultOwnerId(memberBotIds, options),
    memberBotIds,
    sharedDir: row.project.sharedDir,
    background: row.background.text,
  }
}

/** 一次校验整张表单，只报第一个错，焦点跟着错误走。 */
export function validateProjectForm(values: ProjectFormValues, options: readonly BotOption[], initialOwnerId: string): ProjectFormError | null {
  const name = values.name.trim()
  if (name === '') return { field: 'name', message: '项目名称：不能为空' }
  if (name.length > PROJECT_NAME_MAX) return { field: 'name', message: `项目名称：不能超过 ${PROJECT_NAME_MAX} 字（现在 ${name.length} 字）` }
  if (values.memberBotIds.length > PROJECT_MEMBER_MAX) {
    return { field: 'members', message: `项目成员：不能超过 ${PROJECT_MEMBER_MAX} 个队友（现在选了 ${values.memberBotIds.length} 个）` }
  }
  if (values.ownerBotId === '') return { field: 'owner', message: '负责人：请选一位。先勾选成员；建议风格的队友不能当负责人。' }
  if (!values.memberBotIds.includes(values.ownerBotId)) return { field: 'owner', message: '负责人：必须是成员之一，先在成员里勾选 TA。' }
  const owner = options.find(option => option.botId === values.ownerBotId)
  if (owner !== undefined && !canBeOwner(owner) && owner.botId !== initialOwnerId) {
    return { field: 'owner', message: `负责人：「${owner.name}」是建议风格，只提意见不动手，请换一位。` }
  }
  if (values.sharedDir.trim().length > PROJECT_SHARED_DIR_MAX) {
    return { field: 'sharedDir', message: `项目目录：不能超过 ${PROJECT_SHARED_DIR_MAX} 字（现在 ${values.sharedDir.trim().length} 字）` }
  }
  if (values.background.trim().length > PROJECT_BACKGROUND_MAX) {
    return { field: 'background', message: `项目背景：不能超过 ${PROJECT_BACKGROUND_MAX} 字（现在 ${values.background.trim().length} 字）` }
  }
  return null
}

/**
 * 拼 saveProject 入参。core 的 charter 不传就会被清空，这里把原值带上；
 * 愿景、约定、验收项不传时 core 沿用旧值，界面不再编辑它们，也不会弄丢。
 * 目录留空时不带这个键：新建走 core 的默认路径，编辑保留原值。
 */
export function buildSaveProjectInput(values: ProjectFormValues, editing: ProjectViewRow | null): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    name: values.name.trim(),
    charter: editing?.project.charter ?? '',
    ownerBotId: values.ownerBotId,
    memberBotIds: values.memberBotIds,
  }
  const sharedDir = values.sharedDir.trim()
  if (sharedDir !== '') raw.sharedDir = sharedDir
  if (editing !== null) raw.id = editing.project.id
  return raw
}

/** 背景改了才发 saveProjectContext；没改返回 null，不留一条「主人更新了背景」的假记录。 */
export function buildSaveBackgroundInput(projectId: string, values: ProjectFormValues, editing: ProjectViewRow | null): Record<string, unknown> | null {
  const background = values.background.trim()
  if (background === (editing?.background.text ?? '').trim()) return null
  return { projectId, background }
}
