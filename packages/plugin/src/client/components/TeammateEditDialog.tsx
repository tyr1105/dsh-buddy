/**
 * 「编辑员工」弹窗（P64 起；P73f 改为三种状态）：右侧边栏底部唯一的入口。
 *
 * 最上面是「状态」单选组：在岗、停用、归档三选一，下面一行说明二者的区别（设计稿场景 D）。
 * 选择规则在 logic/lifecycle.ts：
 * - 从在岗选停用、从停用选在岗：立刻发 lifecycleAction（suspend、reinstate），和原来的暂停、恢复一样不走「保存」；
 * - 选归档：先在弹窗里出二次确认（先调 archiveBotCheck 看能不能归档，能就列出后果和将移出的项目），
 *   点「确认归档」才发 archive；归档后不能恢复为在岗。总管的「归档」不可选。
 * 中间是 P55 定下的八项表单，和新建员工用同一份字段（性格改为「类型　改为…」，执行类员工的自主节奏固定一行）；
 * 底部只有取消和保存。试岗、转正、解除隔离、退役这些旧按钮都去掉了。
 *
 * 外壳复用项目页的 DialogShell，遮罩、Tab 圈定、Esc 关闭都在里面，不另造一套。
 * 组件放在右侧边栏内部渲染：侧边栏按员工 id 重建，切换员工时弹窗和草稿跟着卸载，
 * A 的草稿和归档确认不会带到 B 身上。
 */
import { useState, type ReactNode } from 'react'
import type { BotCard, BotView, DshSkillOption, PresetSkillOption } from '../../shared/views.js'
import {
  SAVE_BLOCKED_BY_ARCHIVE_NOTE, STAFF_STATUS_HINT, STATUS_OK_TEXT, archiveConfirmLines, saveBlockedByArchive, staffStatusOptions, statusChangeAction,
  type ArchiveConfirmInfo, type StaffStatusOption,
} from '../logic/lifecycle.js'
import { hasLiveChief } from '../logic/bot-templates.js'
import { displayRoleLabel } from '../logic/agreement.js'
import { buildProfilePatch, configProblem, draftFromProfile, type BotConfigDraft } from '../logic/wizard.js'
import { BotConfigFields } from './bot-config-fields.js'
import { DialogShell } from './prj-dialog-shell.js'
import type { useCommandRunner } from './use-command-runner.js'

/** 归档二次确认的进度：检查中、有了检查结果（能或不能归档）。 */
type ArchiveStep = { phase: 'checking' } | { phase: 'ready'; info: ArchiveConfirmInfo }

/** 弹窗里新增的界面文字，登记在 docs/copy/strings.json（编号前缀 TEAM-）。 */
export const STATUS_FIELD_TEXT = {
  label: '状态',
  checking: '正在检查能不能归档…',
  confirm: '确认归档',
  cancel: '取消',
} as const

export function TeammateEditDialog(props: {
  bot: BotView
  /** 完整名册：查重名和判断总管名额都要用，判断时排除自己。 */
  roster: readonly BotCard[]
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** 模型目录读取失败的原因：下拉旁显示并给「重试」。 */
  modelOptionsError?: string | null
  onRetrySettings?: () => void
  presetSkillOptions: readonly PresetSkillOption[]
  dshSkillOptions: readonly DshSkillOption[]
  /** 命令执行器由侧边栏持有：弹窗保存后关闭，「已保存」的提示还要留在侧边栏上。 */
  runner: ReturnType<typeof useCommandRunner>
  /** 选归档前的检查（archiveBotCheck）：失败返回中文错误字符串，弹窗据此显示原因。 */
  onCheckArchive: (botId: string) => Promise<ArchiveConfirmInfo | string>
  onRefresh: () => void
  onClose: () => void
}): ReactNode {
  const b = props.bot
  const runner = props.runner
  // 打开时的快照：保存时和它比，只提交真正改过的字段，老队友的旧设置不会被顺手动到。
  const [initial] = useState<BotConfigDraft>(() => draftFromProfile(b.card, b.profile))
  const [draft, setDraft] = useState<BotConfigDraft>(initial)
  /** 点过保存才显示字段错误，刚打开时不要红字吓人。 */
  const [attempted, setAttempted] = useState(false)
  /** 归档二次确认；null 表示没在确认。 */
  const [archive, setArchive] = useState<ArchiveStep | null>(null)
  // 名字查重和总管名额都要排除自己：改名时不能和自己撞名。
  const otherBots = props.roster.filter(bot => bot.id !== b.card.id)
  const otherNames = otherBots.map(bot => bot.name)
  const options = staffStatusOptions(b.card.staffStatus, { chief: b.card.role === 'chief' })

  /** 命令成功后刷新详情和总览，状态选项才会跟着新状态变（比如「在岗」换成「停用」）。 */
  const doExec = async (name: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    const ok = await runner.exec(name, input, okText)
    if (ok) props.onRefresh()
    return ok
  }

  /** 点了状态选项：停用、恢复在岗直接发命令；归档先检查再出二次确认。 */
  const pickStatus = (option: StaffStatusOption): void => {
    const action = statusChangeAction(b.card.staffStatus, option.value)
    if (action === null || option.disabled || runner.busy) return
    if (action !== 'archive') {
      setArchive(null)
      void doExec('lifecycleAction', { botId: b.card.id, action }, STATUS_OK_TEXT[action])
      return
    }
    setArchive({ phase: 'checking' })
    void props.onCheckArchive(b.card.id).then(result => {
      // 检查命令本身失败（返回字符串）：当作「不能归档」，原因就是这句话。
      setArchive(typeof result === 'string' ? { phase: 'ready', info: { canArchive: false, reason: result } } : { phase: 'ready', info: result })
    }).catch((error: unknown) => {
      setArchive({ phase: 'ready', info: { canArchive: false, reason: error instanceof Error ? error.message : String(error) } })
    })
  }

  /** 点「确认归档」：成功后员工移入已归档区，弹窗也关掉。 */
  const confirmArchive = async (): Promise<void> => {
    if (archive === null || archive.phase !== 'ready' || !archive.info.canArchive) return
    const ok = await doExec('lifecycleAction', { botId: b.card.id, action: 'archive' }, STATUS_OK_TEXT.archive)
    setArchive(null)
    if (ok) props.onClose()
  }

  const save = async (): Promise<void> => {
    setAttempted(true)
    if (configProblem(draft, otherNames) !== null) return
    const patch = buildProfilePatch(draft, initial)
    // 什么都没改：不发命令，直接关，免得白白刷一条「已保存」。
    if (Object.keys(patch).length === 0) { props.onClose(); return }
    if (await doExec('updateBot', { botId: b.card.id, patch }, '已保存。下一步：下次唤醒生效。')) props.onClose()
  }

  const saveBlocked = saveBlockedByArchive(archive)
  const lines = archive !== null && archive.phase === 'ready' ? archiveConfirmLines(b.card.name, archive.info) : null

  return (
    <DialogShell
      title={`编辑员工：${b.card.name}（${displayRoleLabel(b.card)}）`}
      className="ah-teammate-edit"
      busy={runner.busy}
      onClose={props.onClose}
      error={!runner.success ? runner.message : null}
      footer={<>
        {/* 状态变更的结果提示（已停用、已恢复在岗）留在底部左侧，保存和取消靠右。 */}
        <div className="ah-teammate-life" role="group" aria-label="操作结果">
          {runner.success && runner.message ? <span className="ah-teammate-life-note" role="status">{runner.message}</span> : null}
        </div>
        <div className="ah-teammate-save">
          <button type="button" className="ah-btn" disabled={runner.busy} onClick={props.onClose}>取消</button>
          {/* P73r4：归档确认框出现期间保存不可用，旁边写明先做什么。 */}
          {saveBlocked ? <span className="ah-teammate-life-note" role="status">{SAVE_BLOCKED_BY_ARCHIVE_NOTE}</span> : null}
          <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy || saveBlocked} onClick={() => void save()}>保存</button>
        </div>
      </>}
    >
      <div className="ah-wizard-field ah-status-field">
        <span className="ah-wizard-label">{STATUS_FIELD_TEXT.label}</span>
        <div className="ah-choice-row" role="group" aria-label={STATUS_FIELD_TEXT.label}>
          {options.map(option => (
            <span key={option.value} className="ah-status-option">
              <button type="button" className="ah-choice" aria-pressed={option.selected} disabled={option.disabled || runner.busy}
                onClick={() => pickStatus(option)}>{option.label}</button>
              {option.note !== null ? <small className="ah-status-note">{option.note}</small> : null}
            </span>
          ))}
        </div>
        <p className="ah-right-kv">{STAFF_STATUS_HINT}</p>
        {archive !== null ? (
          <div className="ah-archive-confirm" role="group" aria-label="归档确认">
            {archive.phase === 'checking' ? <p className="ah-right-kv">{STATUS_FIELD_TEXT.checking}</p> : null}
            {lines !== null && lines.blocked !== null ? <p className="ah-settings-error" role="alert">{lines.blocked}</p> : null}
            {lines !== null && lines.main !== null ? <p>{lines.main}</p> : null}
            {lines !== null && lines.projects !== null ? <p className="ah-right-kv">{lines.projects}</p> : null}
            <div className="ah-archive-confirm-actions">
              <button type="button" className="ah-btn ah-btn-danger" disabled={runner.busy || archive.phase !== 'ready' || !archive.info.canArchive}
                onClick={() => void confirmArchive()}>{STATUS_FIELD_TEXT.confirm}</button>
              <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={() => setArchive(null)}>{STATUS_FIELD_TEXT.cancel}</button>
            </div>
          </div>
        ) : null}
      </div>
      <BotConfigFields draft={draft} onChange={partial => setDraft(prev => ({ ...prev, ...partial }))}
        modelOptions={props.modelOptions} modelOptionsError={props.modelOptionsError} onRetryModels={props.onRetrySettings}
        presetSkillOptions={props.presetSkillOptions} dshSkillOptions={props.dshSkillOptions}
        chiefTaken={hasLiveChief(otherBots)} disabled={runner.busy} autoFocusName
        problem={attempted ? configProblem(draft, otherNames) : null} />
    </DialogShell>
  )
}
