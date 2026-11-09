/**
 * 项目共享上下文（P39）的界面纯逻辑：把项目里的四段上下文翻成表单值、校验、拼命令入参，
 * 以及把留痕/建议/决策翻成人话。为什么单独成文件：project-form.ts 已承载项目与任务
 * 表单，上下文有自己的四段结构与条数上限，混进去会超过单文件 400 行上限。
 *
 * 边界纪律：四段能不能写、队友有没有权限、建议是否待审，最终都由 core 判定；
 * 这里只拦「必填没填、超长、条数超上限」这类不用查数据就能发现的错，
 * 文案与 core zod 的中文错误保持同一口径。
 */
import type { ProjectContext, ProjectViewRow } from '../../shared/views.js'

// ---------- 与 core 对齐的数值口径（客户端 bundle 不 import core 运行时，手工对齐） ----------

/** 背景上限（core ProjectContextSchema）。 */
export const CONTEXT_BACKGROUND_MAX = 2000
/** 约定上限（core ProjectContextSchema）。 */
export const CONTEXT_CONVENTIONS_MAX = 2000
/** 决策条数上限（core V2_DEFAULTS.PROJECT_CONTEXT_DECISION_MAX）。 */
export const CONTEXT_DECISION_MAX = 50
/** 单条决策正文上限（core ContextDecisionSchema）。 */
export const CONTEXT_DECISION_TEXT_MAX = 300
/** 术语条数上限（core V2_DEFAULTS.PROJECT_CONTEXT_GLOSSARY_MAX）。 */
export const CONTEXT_GLOSSARY_MAX = 50
/** 术语名称上限（core ContextGlossaryEntrySchema）。 */
export const CONTEXT_TERM_MAX = 60
/** 术语释义上限（core ContextGlossaryEntrySchema）。 */
export const CONTEXT_MEANING_MAX = 300

/** 一条决策的表单值：id 为 null 表示新增（core 会发 dc_ id 并记主人为来源）。 */
export interface DecisionDraft {
  id: string | null
  text: string
}

/** 一条术语的表单值。 */
export interface GlossaryDraft {
  term: string
  meaning: string
}

/** 上下文编辑表单当前值。 */
export interface ContextDraft {
  background: string
  conventions: string
  decisions: DecisionDraft[]
  glossary: GlossaryDraft[]
}

/** 从项目上下文生成表单值（决策保留 id，保存时 core 据此保留原来的时间与来源）。 */
export function contextDraftFrom(context: ProjectContext): ContextDraft {
  return {
    background: context.background,
    conventions: context.conventions,
    decisions: context.decisions.map(decision => ({ id: decision.id, text: decision.text })),
    glossary: context.glossary.map(entry => ({ term: entry.term, meaning: entry.meaning })),
  }
}

/** 四段是否全空：与 core isProjectContextEmpty 同口径，空上下文不显示完整卡片。 */
export function isContextEmpty(context: ProjectContext): boolean {
  return context.background.trim() === ''
    && context.conventions.trim() === ''
    && context.decisions.length === 0
    && context.glossary.length === 0
}

/** 约定按行拆要点：一行一条，空行忽略；没有换行时整段算一条。 */
export function conventionPoints(conventions: string): string[] {
  return conventions.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/**
 * 表单校验：一次只报第一条错（与项目表单同风格），顺序是背景、约定、决策、术语。
 * 决策与术语都必须填正文，避免出现只有 id 没有内容的空条目被 core 拒掉。
 */
export function validateContextDraft(draft: ContextDraft): string | null {
  const background = draft.background.trim()
  if (background.length > CONTEXT_BACKGROUND_MAX) {
    return `背景：不能超过 ${CONTEXT_BACKGROUND_MAX} 字（现在 ${background.length} 字）`
  }
  const conventions = draft.conventions.trim()
  if (conventions.length > CONTEXT_CONVENTIONS_MAX) {
    return `约定：不能超过 ${CONTEXT_CONVENTIONS_MAX} 字（现在 ${conventions.length} 字）`
  }
  if (draft.decisions.length > CONTEXT_DECISION_MAX) {
    return `已定决策：不能超过 ${CONTEXT_DECISION_MAX} 条（现在 ${draft.decisions.length} 条）`
  }
  for (let i = 0; i < draft.decisions.length; i++) {
    const text = draft.decisions[i]!.text.trim()
    if (text === '') return `已定决策第 ${i + 1} 条：内容不能为空；不想要这条就点「删除」`
    if (text.length > CONTEXT_DECISION_TEXT_MAX) {
      return `已定决策第 ${i + 1} 条：不能超过 ${CONTEXT_DECISION_TEXT_MAX} 字（现在 ${text.length} 字）`
    }
  }
  if (draft.glossary.length > CONTEXT_GLOSSARY_MAX) {
    return `术语表：不能超过 ${CONTEXT_GLOSSARY_MAX} 条（现在 ${draft.glossary.length} 条）`
  }
  for (let i = 0; i < draft.glossary.length; i++) {
    const entry = draft.glossary[i]!
    const term = entry.term.trim()
    const meaning = entry.meaning.trim()
    if (term === '') return `术语第 ${i + 1} 条：术语不能为空；不想要这条就点「删除」`
    if (term.length > CONTEXT_TERM_MAX) {
      return `术语第 ${i + 1} 条：术语不能超过 ${CONTEXT_TERM_MAX} 字（现在 ${term.length} 字）`
    }
    if (meaning === '') return `术语第 ${i + 1} 条：释义不能为空`
    if (meaning.length > CONTEXT_MEANING_MAX) {
      return `术语第 ${i + 1} 条：释义不能超过 ${CONTEXT_MEANING_MAX} 字（现在 ${meaning.length} 字）`
    }
  }
  return null
}

/**
 * 拼 saveProjectContext 入参：四段全量提交，空串/空数组就是「清空这一段」。
 * 已有决策只带 id 与正文，时间与来源由 core 保留；新决策不带 id。
 */
export function buildSaveProjectContextInput(projectId: string, draft: ContextDraft): Record<string, unknown> {
  return {
    projectId,
    background: draft.background.trim(),
    conventions: draft.conventions.trim(),
    decisions: draft.decisions.map(decision => decision.id === null
      ? { text: decision.text.trim() }
      : { id: decision.id, text: decision.text.trim() }),
    glossary: draft.glossary.map(entry => ({ term: entry.term.trim(), meaning: entry.meaning.trim() })),
  }
}

/** 上下文的一句话概况：显示在面板头部，让主人知道四段里有哪些内容。 */
export function contextBrief(context: ProjectContext): string {
  const parts: string[] = []
  if (context.background.trim() !== '') parts.push('背景')
  const conventions = conventionPoints(context.conventions).length
  if (conventions > 0) parts.push(`约定 ${conventions} 条`)
  if (context.decisions.length > 0) parts.push(`决策 ${context.decisions.length} 条`)
  if (context.glossary.length > 0) parts.push(`术语 ${context.glossary.length} 条`)
  return parts.length === 0 ? '还没配置' : parts.join(' · ')
}

/**
 * 决策来源的人话：owner 显示「主人」，队友 id 在项目成员里查名字；
 * 查不到显示「已删除的队友」，绝不把内部 id 露到正文（排障走 title）。
 */
export function decisionAuthor(by: string, row: ProjectViewRow): string {
  if (by === 'owner') return '主人'
  const member = row.members.find(item => item.botId === by)
  return member?.name ?? '已删除的队友'
}
