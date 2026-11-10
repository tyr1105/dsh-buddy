/**
 * 「新建队友」的提交流程：createBot →（模板带头像色时）补存头像色 → 刷新总览。
 * 放在 logic 层而不是 HubPage：这些都是对 hub 命令的顺序编排，不含 React 状态，
 * hub 以最小接口注入，同样输入得到同样的调用序列，便于对形状断言。
 *
 * 关键取舍：颜色保存失败只记日志、不挡创建（core 已按执行风格给默认色）。
 * 只有创建本身失败才返回 { error }。队友建成即出现在办公室里。
 *
 * 文件后半段是模板库的批量添加（P52）：按选择顺序逐个走上面这套流程。
 */
import type { BotCard, CommandResult } from '../../shared/views.js'
import { buildTemplateInput, freeTemplateName, type BotTemplate } from './bot-templates.js'

/** 提交流程需要的最小 hub 能力（HubStore 的子集；logic 不反向依赖 React 页面）。 */
export interface WizardCreateHub {
  command: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  refreshOverview: () => Promise<unknown> | unknown
}

/** 创建结果：带着新队友 id 成功，或创建失败。 */
export type WizardCreateResult = { botId: string; warning?: string } | { error: string }

/** 从成功的命令结果里取新队友 id；core 没给 id 属于契约破坏，按创建失败如实说明。 */
function createdBotId(result: Extract<CommandResult, { ok: true }>): string | undefined {
  return (result.data as { id?: string } | undefined)?.id
}

/**
 * 建队友：
 * 1. createBot 失败 → 直接把中文原因交回表单；
 * 2. 模板带头像色时存一下，失败只记错误日志（不影响队友已建成的事实）；
 * 3. 成功后主动刷总览，保证主人立刻看到新队友。
 */
export async function createTeammate(
  hub: WizardCreateHub,
  input: Record<string, unknown>,
  color?: string,
): Promise<WizardCreateResult> {
  const created = await hub.command('createBot', input)
  if (!created.ok) return { error: created.error }
  const botId = createdBotId(created)
  if (botId === undefined) return { error: '创建成功但没有返回机器人 id' }

  if (color !== undefined) {
    const colored = await hub.command('updateBot', { botId, patch: { color } })
    if (!colored.ok) console.error('[agent-hub] 保存头像颜色失败:', colored.error)
  }

  await hub.refreshOverview()
  return { botId }
}

// ---------- 模板库批量添加（P52） ----------

/** 批量添加的结果：加上的、没加上的，以及不影响队友已建成的提醒。 */
export interface TemplateBatchResult {
  added: Array<{ botId: string; name: string }>
  failed: Array<{ name: string; error: string }>
  warnings: string[]
}

/** 把异常翻成一句话：网络断开时命令会直接抛错，也要落到「哪一位没加上」上。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 按选择顺序逐个添加。
 * 为什么一个一个来：core 的人数上限和总管校验按当时的名册计算，并行时结果不确定。
 * 为什么失败了还继续：已经建好的队友是事实，一位失败不应该拖累其他几位。
 * 名字被退役或归档的队友占用时自动加序号，所以 existingBots 要传完整名册。
 */
export async function addTeammatesFromTemplates(
  hub: WizardCreateHub,
  templates: readonly BotTemplate[],
  existingBots: readonly Pick<BotCard, 'name'>[],
): Promise<TemplateBatchResult> {
  const taken = existingBots.map(bot => bot.name)
  const result: TemplateBatchResult = { added: [], failed: [], warnings: [] }
  for (const template of templates) {
    const name = freeTemplateName(template.name, taken)
    try {
      const created = await createTeammate(hub, buildTemplateInput(template, name), template.color)
      if ('error' in created) { result.failed.push({ name, error: created.error }); continue }
      taken.push(name)
      result.added.push({ botId: created.botId, name })
    } catch (error) {
      console.error('[agent-hub] 从模板添加队友失败:', error)
      result.failed.push({ name, error: errorText(error) })
    }
  }
  return result
}

/** 全部没加上时显示在弹窗里的原因。 */
export function templateBatchError(result: TemplateBatchResult): string {
  return result.failed.map(failure => `「${failure.name}」没加上：${failure.error}`).join(' ')
}

/** 加上之后显示在线程顶部的提示；只加了一位且没有问题时不用额外说明。 */
export function templateBatchNotice(result: TemplateBatchResult): string | undefined {
  const parts: string[] = []
  if (result.added.length > 1) parts.push(`已添加 ${result.added.length} 位队友：${result.added.map(bot => bot.name).join('、')}。`)
  if (result.failed.length > 0) parts.push(templateBatchError(result))
  parts.push(...result.warnings)
  return parts.length > 0 ? parts.join(' ') : undefined
}
