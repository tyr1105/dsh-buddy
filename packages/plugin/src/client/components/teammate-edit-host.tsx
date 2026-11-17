/**
 * 「编辑员工」弹窗的承载层（P78）。
 *
 * 为什么单独做一层：编辑员工有两个入口——对话页右上角「更多」菜单里的第一项，
 * 和右侧栏底部的按钮。右侧栏默认收起，弹窗如果放在右侧栏里，从「更多」点就打不开。
 * 所以弹窗和它用到的命令执行器放在这一层，由页面（HubPage）持有「当前正在编辑哪位员工」，
 * 两个入口只负责把这个状态置位，打开的是同一个弹窗，没有第二套。
 *
 * 保存后弹窗关闭，「已保存」之类的提示由本层继续显示（原来由右侧栏显示）。
 */
import type { ReactNode } from 'react'
import type { BotCard, BotView, CommandResult, DshSkillOption, PresetSkillOption } from '../../shared/views.js'
import type { ArchiveConfirmInfo } from '../logic/lifecycle.js'
import { TeammateEditDialog } from './TeammateEditDialog.js'
import { useCommandRunner } from './use-command-runner.js'

export function TeammateEditHost(props: {
  /** 是否打开：由页面按「正在编辑的员工 id 等于当前选中员工」算出。 */
  open: boolean
  /** 员工详情：还没拉到时不画弹窗（打开状态保留，详情到了就会出现）。 */
  detail: BotView | null
  /** 完整名册：编辑表单查重名和总管名额用。 */
  roster: readonly BotCard[]
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  modelOptionsError?: string | null
  onRetrySettings?: () => void
  presetSkillOptions: readonly PresetSkillOption[]
  dshSkillOptions: readonly DshSkillOption[]
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  onRefresh: () => void
  onClose: () => void
}): ReactNode {
  const runner = useCommandRunner(props.run)
  const detail = props.detail
  const showDialog = props.open && detail !== null

  /** 弹窗里「选归档」前的检查：命令失败转成中文错误字符串，弹窗据此显示原因。 */
  const checkArchive = async (botId: string): Promise<ArchiveConfirmInfo | string> => {
    try {
      const result = await props.run('archiveBotCheck', { botId })
      return result.ok ? result.data as ArchiveConfirmInfo : result.error
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <>
      {/* 弹窗开着时提示由弹窗自己显示；这里只管保存后弹窗已经关掉的情况。 */}
      {!showDialog && runner.success && runner.message ? <div className="ah-save-toast" role="status">{runner.message}</div> : null}
      {showDialog ? (
        <TeammateEditDialog
          bot={detail}
          roster={props.roster}
          modelOptions={props.modelOptions}
          modelOptionsError={props.modelOptionsError}
          onRetrySettings={props.onRetrySettings}
          presetSkillOptions={props.presetSkillOptions}
          dshSkillOptions={props.dshSkillOptions}
          runner={runner}
          onCheckArchive={checkArchive}
          onRefresh={props.onRefresh}
          onClose={props.onClose}
        />
      ) : null}
    </>
  )
}
