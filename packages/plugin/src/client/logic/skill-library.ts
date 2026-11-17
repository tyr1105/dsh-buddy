/**
 * 技能库一栏与技能详情的界面规则（P75j）：纯函数与固定文字，组件只管画。
 *
 * 为什么单独成文件：版本、来源、对比结论、刻度文字等「给主人看的句子」全部由 core 生成，界面原样显示，
 * 这里不拼任何一句、也不按原因写分支；只剩几件界面自己的事——刻度每一道的样式类名、
 * 列表里每一条技能的页面元素编号（返回列表时把焦点还给刚才那一条要靠它找）、确认框的文字、
 * 以及技能详情要用的三个入口（读详情、回退、放回）的接口形状，方便测试时换成替身。
 */
import type { CommandResult, SkillDetailView, SkillTicksView } from '../../shared/views.js'
import { api } from '../api.js'

/** 技能详情要用的三个入口。组件只认这个形状，测试换成替身，真页面用下面的 defaultSkillApi。 */
export interface SkillApi {
  /** 取一条技能的详情。 */
  detail(skillId: string): Promise<SkillDetailView>
  /** 回退到某一版。 */
  rollback(skillId: string, versionNo: number): Promise<CommandResult>
  /** 把收起的技能放回。 */
  restore(skillId: string): Promise<CommandResult>
}

/** 真页面用的入口：直接调宿主接口（api.ts）。 */
export const defaultSkillApi: SkillApi = {
  detail: skillId => api.skillDetail(skillId),
  rollback: (skillId, versionNo) => api.rollbackSkill({ skillId, versionNo }),
  restore: skillId => api.restoreSkill({ skillId }),
}

/** 「自己积累」一组里一条都没有时的固定说法（core 的组说明只写条数，空状态由界面写）。 */
export const NO_SELF_SKILL_TEXT = '暂无。员工做完的事经过复盘和核对之后，会写入这里。'

/** 命令失败又没带原因时的兜底说法（三段式：现象、动作、建议）。 */
export const SKILL_COMMAND_FALLBACK_ERROR = '操作没有成功。请重试；仍失败请确认 DSH 是否已关闭。'

/**
 * P75r7（B9）：技能详情打开时，窗口层兜底的 Esc 要不要把详情关回列表。
 * 只在焦点落在页面最外层（body，或没有任何元素持焦）或侧栏之内时处理；
 * 宽屏下侧栏与对话并排，焦点在对话输入框或别的弹出菜单里按 Esc 属于它们自己，不关详情。
 * 参数只用到「是不是同一个节点」和侧栏的 contains，测试可以用假节点。
 */
export function shouldCloseSkillDetailOnEscape(active: unknown, body: unknown, panel: { contains(node: never): boolean } | null): boolean {
  if (active === null || active === undefined || active === body) return true
  return panel !== null && panel.contains(active as never)
}

/** 列表里一条技能的页面元素编号：从详情返回时，按它找到刚才那一条并把焦点还回去。 */
export function skillRowDomId(skillId: string): string {
  return `ah-skill-row-${skillId}`
}

/**
 * 刻度每一道的样式类名：长短一档一个类名；整理合并（main）用强调色；
 * 新刻的一道（fresh）多一个动画类名，动画本身写在样式表里，系统要求减少动态效果时样式表把动画关掉。
 */
export function tickClassName(tick: SkillTicksView['ticks'][number]): string {
  const base = `ah-skill-tick ah-skill-tick-${tick.length}`
  return tick.fresh ? `${base} ah-skill-tick-fresh` : base
}

/** 刻度整条线的可访问名：不让读屏逐道朗读，只说共几道。 */
export function skillTicksLabel(ticks: SkillTicksView): string {
  return `技能刻度：${ticks.ticks.length} 道`
}

/** P75r7（B5）：历史版本一行的文字：开头「第 {n} 版」，后面接一个全角空格再接核心给的文字。 */
export function versionLineText(no: number, text: string): string {
  return `第 ${no} 版　${text}`
}

/** P75r7（B5）：「回退到这一版」按钮的可达名称：包含按钮上的可见文字（语音控制说出按钮上的字能点中），再注明是第几版。 */
export function rollbackLabelOf(no: number): string {
  return `回退到这一版（第 ${no} 版）`
}

/** 确认框的两种内容。 */
export interface SkillConfirmText { title: string; text: string; confirmText: string }

/** 「回退到这一版」的确认框文字。 */
export function rollbackConfirmText(skillTitle: string, versionNo: number): SkillConfirmText {
  return { title: '回退技能', text: `把「${skillTitle}」回退到第 ${versionNo} 版？被替换的版本仍保留，可以再回到它。`, confirmText: '回退' }
}

/** 「放回」的确认框文字。 */
export function restoreConfirmText(skillTitle: string): SkillConfirmText {
  return { title: '放回技能', text: `把「${skillTitle}」放回员工每次读取的技能目录？`, confirmText: '放回' }
}
