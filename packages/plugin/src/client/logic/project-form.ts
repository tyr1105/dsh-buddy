/**
 * 项目页表单纯逻辑（V2-PH4-02）：项目/任务/驳回三类表单的数值口径、前置校验与命令
 * 入参拼装。为什么从 project-page.ts 拆出来：那页已有分区、任务分组、队友目录三组
 * 逻辑，再带上三类表单会超过单文件 400 行上限；表单都是「纯值进、入参出」的纯函数，
 * 独立成文件也更贴近 resource-page.ts 里「展示逻辑与表单逻辑同源」的用法。
 *
 * 边界纪律：能不能流转、队友是否存在、负责人是否成员（core 还会再查）、驳回理由在
 * 状态机上是否合法，最终都由 core 判定；前端只拦「空、超长、负责人没勾进成员、
 * 成员超上限」这类不用查数据就能发现的错，让错误就近显示在字段下方。
 */
import type { ProjectTaskView, ProjectViewRow } from '../../shared/views.js'

// ---------- 与 core 对齐的数值口径（客户端 bundle 不能 import core 运行时，手工对齐；
// core 改上限时这里的边界测试与类型检查会报出来） ----------

/** 项目名称上限（core SaveProjectSchema）。 */
export const PROJECT_NAME_MAX = 120
/** 项目一句话目标上限。 */
export const PROJECT_CHARTER_MAX = 500
/** 项目愿景上限（P34 两层：队友项目版本里的愿景，core 同口径 2000 字）。 */
export const PROJECT_VISION_MAX = 2000
/** 项目约定上限（P34 两层：队友之间怎么配合，core 同口径 2000 字）。 */
export const PROJECT_CONVENTIONS_MAX = 2000
/** 项目目录路径上限（core 只存字符串，不创建/校验物理目录）。 */
export const PROJECT_SHARED_DIR_MAX = 1000
/** 成员上限（core V2_DEFAULTS.PROJECT_MEMBER_MAX）。 */
export const PROJECT_MEMBER_MAX = 20
/** 验收项条数上限（core V2_DEFAULTS.PROJECT_CRITERION_MAX）。 */
export const PROJECT_CRITERION_MAX = 20
/** 验收标准正文上限（core CriterionInputSchema）。 */
export const PROJECT_CRITERION_TEXT_MAX = 300
/** 验证方式上限（core CriterionInputSchema，允许为空）。 */
export const PROJECT_CRITERION_VERIFY_MAX = 300
/** 任务标题上限。 */
export const TASK_TITLE_MAX = 120
/** 任务说明上限。 */
export const TASK_DETAIL_MAX = 2000
/** 驳回理由长度区间，与 core task-state 的 TASK_REJECT_REASON_MAX 一致。 */
export const TASK_REJECT_REASON_MAX = 500

// ---------- 项目表单 ----------

/** 一条验收项的表单值：id 为空表示新增项（core 会发 ac_ id 并从「待验收」开始）。 */
export interface CriterionFormValues {
  id: string | null
  text: string
  verify: string
  status: 'open' | 'met'
}

/** 项目表单当前值（ownerBotId 用空串表示「未指定」，拼命令时翻成 null）。 */
export interface ProjectFormValues {
  name: string
  charter: string
  vision: string
  conventions: string
  ownerBotId: string
  memberBotIds: string[]
  sharedDir: string
  acceptanceCriteria: CriterionFormValues[]
}

export type ProjectFormField =
  | 'name' | 'charter' | 'vision' | 'conventions' | 'members' | 'owner' | 'criteria' | 'sharedDir'

/** 表单校验失败：带上出错字段，对话框据此聚焦第一个出错控件。 */
export interface ProjectFormError {
  field: ProjectFormField
  message: string
}

/** 名称：trim 后非空且 ≤120 字。 */
export function validateProjectName(name: string): string | null {
  const value = name.trim()
  if (value === '') return '项目名称：不能为空'
  if (value.length > PROJECT_NAME_MAX) return `项目名称：不能超过 ${PROJECT_NAME_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 一句话目标：允许为空，≤500 字。 */
export function validateProjectCharter(charter: string): string | null {
  const value = charter.trim()
  if (value.length > PROJECT_CHARTER_MAX) return `项目一句话目标：不能超过 ${PROJECT_CHARTER_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 愿景：允许为空，≤2000 字；空值表示还没写，不阻断保存。 */
export function validateProjectVision(vision: string): string | null {
  const value = vision.trim()
  if (value.length > PROJECT_VISION_MAX) return `项目愿景：不能超过 ${PROJECT_VISION_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 约定：允许为空，≤2000 字；空值表示还没有约定，不阻断保存。 */
export function validateProjectConventions(conventions: string): string | null {
  const value = conventions.trim()
  if (value.length > PROJECT_CONVENTIONS_MAX) return `项目约定：不能超过 ${PROJECT_CONVENTIONS_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 项目目录：允许为空（core 给默认路径）；非空时 ≤1000 字。路径边界由 core 校验，物理目录创建随后续批次落地。 */
export function validateProjectSharedDir(sharedDir: string): string | null {
  const value = sharedDir.trim()
  if (value.length > PROJECT_SHARED_DIR_MAX) return `项目目录：不能超过 ${PROJECT_SHARED_DIR_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 验收项整表：条数上限，再逐条查「标准不能空、两栏不超 300 字」，一次只报第一条错。 */
export function validateProjectCriteria(criteria: readonly CriterionFormValues[]): string | null {
  if (criteria.length > PROJECT_CRITERION_MAX) {
    return `验收项：不能超过 ${PROJECT_CRITERION_MAX} 条（现在 ${criteria.length} 条）`
  }
  for (let i = 0; i < criteria.length; i++) {
    const item = criteria[i]!
    const text = item.text.trim()
    if (text === '') return `验收项第 ${i + 1} 条：验收标准不能为空；不想要这条就点「删除」`
    if (text.length > PROJECT_CRITERION_TEXT_MAX) {
      return `验收项第 ${i + 1} 条：验收标准不能超过 ${PROJECT_CRITERION_TEXT_MAX} 字（现在 ${text.length} 字）`
    }
    if (item.verify.trim().length > PROJECT_CRITERION_VERIFY_MAX) {
      return `验收项第 ${i + 1} 条：验证方式不能超过 ${PROJECT_CRITERION_VERIFY_MAX} 字（现在 ${item.verify.trim().length} 字）`
    }
  }
  return null
}

/** 整张项目表单：名称 → 目标 → 愿景 → 约定 → 成员数量 → 负责人是否成员 → 验收项 → 目录，一次只报第一个错。 */
export function validateProjectForm(values: ProjectFormValues): ProjectFormError | null {
  const nameError = validateProjectName(values.name)
  if (nameError) return { field: 'name', message: nameError }
  const charterError = validateProjectCharter(values.charter)
  if (charterError) return { field: 'charter', message: charterError }
  const visionError = validateProjectVision(values.vision)
  if (visionError) return { field: 'vision', message: visionError }
  const conventionsError = validateProjectConventions(values.conventions)
  if (conventionsError) return { field: 'conventions', message: conventionsError }
  if (values.memberBotIds.length > PROJECT_MEMBER_MAX) {
    return { field: 'members', message: `项目成员：不能超过 ${PROJECT_MEMBER_MAX} 个队友（现在选了 ${values.memberBotIds.length} 个）` }
  }
  if (values.ownerBotId !== '' && !values.memberBotIds.includes(values.ownerBotId)) {
    return { field: 'owner', message: '项目负责人：必须是成员之一；先在成员名单里勾选负责人' }
  }
  const criteriaError = validateProjectCriteria(values.acceptanceCriteria)
  if (criteriaError) return { field: 'criteria', message: criteriaError }
  const dirError = validateProjectSharedDir(values.sharedDir)
  if (dirError) return { field: 'sharedDir', message: dirError }
  return null
}

/** 编辑项目时的表单初值：失效成员不预选（保存即修名单），失效负责人回到「未指定」并由问题区提示。 */
export function initialProjectForm(row: ProjectViewRow | null): ProjectFormValues {
  if (row === null) {
    return {
      name: '', charter: '', vision: '', conventions: '',
      ownerBotId: '', memberBotIds: [], sharedDir: '', acceptanceCriteria: [],
    }
  }
  return {
    name: row.project.name,
    charter: row.project.charter,
    // 旧项目没有两栏时按空串回填；保存时原样提交，不会把缺失字段写成别的值。
    vision: row.layers.team.vision,
    conventions: row.layers.team.conventions,
    ownerBotId: row.ownerInvalid || row.ownerName === null ? '' : (row.ownerBotId ?? ''),
    memberBotIds: row.members.filter(m => !m.invalid).map(m => m.botId),
    sharedDir: row.project.sharedDir,
    // 验收项保留 id 与勾选状态：已有项提交回去才能原位更新，新增项 id 为空。
    acceptanceCriteria: row.criteria.map(c => ({ id: c.id, text: c.text, verify: c.verify, status: c.status })),
  }
}

/**
 * 拼 saveProject 入参（core strictObject，不能多键）：
 * - 名称/目标提交 trim 值；「未指定负责人」显式给 null；
 * - 目录留空时不带这个键（新建走 core 默认路径，编辑保留原值）；
 * - 验收项整表提交：已有项带 id 与勾选状态（core 原位更新），新增项不带 id（core 发 ac_ id 并从 open 开始）。
 */
export function buildSaveProjectInput(values: ProjectFormValues, editingId?: string | null): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    name: values.name.trim(),
    charter: values.charter.trim(),
    // P34：愿景与约定始终显式提交（空串=清空），避免「只改名」时意外保留旧文案。
    vision: values.vision.trim(),
    conventions: values.conventions.trim(),
    ownerBotId: values.ownerBotId === '' ? null : values.ownerBotId,
    memberBotIds: values.memberBotIds,
    acceptanceCriteria: values.acceptanceCriteria.map(item => {
      const criterion: Record<string, unknown> = { text: item.text.trim(), verify: item.verify.trim() }
      // 新增项不带 id/status：core 只认已有项的 id，新增项状态恒从 open 开始。
      if (item.id !== null) {
        criterion.id = item.id
        criterion.status = item.status
      }
      return criterion
    }),
  }
  const sharedDir = values.sharedDir.trim()
  if (sharedDir !== '') raw.sharedDir = sharedDir
  if (editingId) raw.id = editingId
  return raw
}

// ---------- 任务表单 ----------

/** 任务表单当前值（assigneeBotId 空串=待认领）。 */
export interface TaskFormValues {
  title: string
  detail: string
  assigneeBotId: string
}

export type TaskFormField = 'title' | 'detail'

/** 任务标题：trim 后非空且 ≤120 字。 */
export function validateTaskTitle(title: string): string | null {
  const value = title.trim()
  if (value === '') return '任务标题：不能为空'
  if (value.length > TASK_TITLE_MAX) return `任务标题：不能超过 ${TASK_TITLE_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 任务说明：允许为空，≤2000 字。 */
export function validateTaskDetail(detail: string): string | null {
  const value = detail.trim()
  if (value.length > TASK_DETAIL_MAX) return `任务说明：不能超过 ${TASK_DETAIL_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 整张任务表单：先标题后说明；指派人是否项目成员由 core 兜底（选项已只给成员队友）。 */
export function validateTaskForm(values: TaskFormValues): { field: TaskFormField; message: string } | null {
  const titleError = validateTaskTitle(values.title)
  if (titleError) return { field: 'title', message: titleError }
  const detailError = validateTaskDetail(values.detail)
  if (detailError) return { field: 'detail', message: detailError }
  return null
}

/** 编辑任务时的表单初值：失效指派回到「待认领」，由项目问题区点名，提交即修。 */
export function initialTaskForm(task: ProjectTaskView | null): TaskFormValues {
  if (task === null) return { title: '', detail: '', assigneeBotId: '' }
  return {
    title: task.task.title,
    detail: task.task.detail,
    assigneeBotId: task.assigneeInvalid ? '' : (task.assigneeBotId ?? ''),
  }
}

/** 拼 saveTask 入参：projectId 必填；待认领显式给 null；编辑带 id；不带 status（状态只许走流转命令）。 */
export function buildSaveTaskInput(projectId: string, values: TaskFormValues, editingId?: string | null): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    projectId,
    title: values.title.trim(),
    detail: values.detail.trim(),
    assigneeBotId: values.assigneeBotId === '' ? null : values.assigneeBotId,
  }
  if (editingId) raw.id = editingId
  return raw
}

// ---------- 驳回与 id 命令 ----------

/**
 * 驳回理由前置校验：trim 后必须 1–500 字，与 core 状态机口径一致。
 * 空与超长都给中文原因；提交失败时弹框不关、输入不丢。
 */
export function validateRejectReason(reason: string): string | null {
  const value = reason.trim()
  if (value.length === 0) return '驳回理由：不能为空（1–500 字，说清哪里不行、要怎么改）'
  if (value.length > TASK_REJECT_REASON_MAX) return `驳回理由：不能超过 ${TASK_REJECT_REASON_MAX} 字（现在 ${value.length} 字）`
  return null
}

/** 拼 rejectTask 入参：只有 id 与 trim 后的理由。 */
export function buildRejectTaskInput(taskId: string, reason: string): Record<string, unknown> {
  return { id: taskId, rejectReason: reason.trim() }
}

// ---------- 派活 / 恢复 / 催办 / 改派（V2-PH4-04，统一走 core dispatchTask） ----------

/** 派活留言长度上限，与 core DispatchTaskSchema 的 DISPATCH_NOTE_MAX 一致。 */
export const DISPATCH_NOTE_MAX = 500

/**
 * 派活队友前置校验：必须选一位队友。队友是否在岗、是否是项目成员、
 * 议程是否超限都由 core 判定——这里只拦「没选」这一种不用查数据就能发现的错。
 */
export function validateDispatchBot(botId: string): string | null {
  return botId.trim() === '' ? '派活队友：请选择一个队友' : null
}

/**
 * 派活留言前置校验：留言可选，trim 后为空等于不填；超过 500 字在按钮前拦住，
 * 与 core DispatchTaskSchema 的上限一致，不把超长字符串发过去等引擎报错。
 */
export function validateDispatchNote(note: string): string | null {
  if (note.trim().length > DISPATCH_NOTE_MAX) {
    return `派活留言：不能超过 ${DISPATCH_NOTE_MAX} 字（现在 ${note.trim().length} 字）`
  }
  return null
}

/**
 * 拼 dispatchTask 入参（core 是 strictObject，只能有这四个键）：
 * projectId/taskId/botId 必填；留言 trim 后为空就不带 note 键。
 */
export function buildDispatchTaskInput(
  projectId: string,
  taskId: string,
  botId: string,
  note: string,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { projectId, taskId, botId }
  const trimmed = note.trim()
  if (trimmed !== '') raw.note = trimmed
  return raw
}

// ---------- 关联产物（F08 尾巴） ----------

/**
 * 关联产物前置校验：必须选中一个版本。任务是否存在、产物是否可读、上限是否已满
 * 都由 core 判定——这里只拦「没选版本」这一种不用查数据就能发现的错。
 */
export function validateArtifactChoice(versionId: string): string | null {
  return versionId.trim() === '' ? '关联产物：请选择一个产物版本' : null
}

/** 拼 attachTaskArtifact 入参：任务 id + 固定版本 id（core 是 strictObject，不多带字段）。 */
export function buildAttachTaskArtifactInput(taskId: string, versionId: string): Record<string, unknown> {
  return { taskId, artifactId: versionId.trim() }
}

/** 只收 id 的命令统一入参（暂停/恢复/完成/归档/卡住/恢复/交账/验收通过）。 */
export function buildIdInput(id: string): Record<string, unknown> {
  return { id }
}
