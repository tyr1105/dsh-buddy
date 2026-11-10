/**
 * 「编辑队友」弹窗（P64）：右侧边栏底部唯一的入口。
 *
 * 中间是 P55 定下的八项表单，和新建队友用同一份字段；底部放生命周期动作：
 * 暂停或恢复、转正、解除停用、退役。这些动作从旧右栏搬过来，规则没变：
 * 按当前状态显示哪些按钮由 logic/lifecycle.ts 决定，退役要再点一次「确认退役」。
 *
 * 外壳复用项目页的 DialogShell，遮罩、Tab 圈定、Esc 关闭都在里面，不另造一套。
 * 组件放在右侧边栏内部渲染：侧边栏按队友 id 重建，切换队友时弹窗和草稿跟着卸载，
 * A 的草稿和退役确认不会带到 B 身上。
 */
import { useState, type ReactNode } from 'react'
import type { BotCard, BotView, DshSkillOption, PresetSkillOption } from '../../shared/views.js'
import { lifecycleButtons } from '../logic/lifecycle.js'
import { hasLiveChief } from '../logic/bot-templates.js'
import { buildProfilePatch, configProblem, draftFromProfile, type BotConfigDraft } from '../logic/wizard.js'
import { BotConfigFields } from './bot-config-fields.js'
import { DialogShell } from './prj-dialog-shell.js'
import type { useCommandRunner } from './use-command-runner.js'

/** 各生命周期动作成功后的提示语。 */
const LIFECYCLE_OK_TEXT: Readonly<Record<'pause' | 'resume' | 'promote' | 'release_quarantine' | 'retire', string>> = {
  pause: '已暂停。变更记录保留，可恢复。',
  resume: '已恢复。下一步：待安排。',
  promote: '已转正。下一步：待安排。',
  release_quarantine: '已解除停用。下一步：待安排。',
  retire: '已退役。数据保留，可恢复。',
}

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
  const [confirmRetire, setConfirmRetire] = useState(false)
  // 名字查重和总管名额都要排除自己：改名时不能和自己撞名。
  const otherBots = props.roster.filter(bot => bot.id !== b.card.id)
  const otherNames = otherBots.map(bot => bot.name)

  /** 命令成功后刷新详情和总览，按钮才会跟着新状态变（比如「暂停」换成「恢复」）。 */
  const doExec = async (name: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    const ok = await runner.exec(name, input, okText)
    if (ok) props.onRefresh()
    return ok
  }

  const save = async (): Promise<void> => {
    setAttempted(true)
    if (configProblem(draft, otherNames) !== null) return
    const patch = buildProfilePatch(draft, initial)
    // 什么都没改：不发命令，直接关，免得白白刷一条「已保存」。
    if (Object.keys(patch).length === 0) { props.onClose(); return }
    if (await doExec('updateBot', { botId: b.card.id, patch }, '已保存。下一步：下次唤醒生效。')) props.onClose()
  }

  return (
    <DialogShell
      title={`编辑队友：${b.card.name}`}
      className="ah-teammate-edit"
      busy={runner.busy}
      onClose={props.onClose}
      error={!runner.success ? runner.message : null}
      footer={<>
        {/* 生命周期动作靠左、保存靠右：两类动作分开放，退役不会紧挨着保存被误点。 */}
        <div className="ah-teammate-life" role="group" aria-label="在岗状态">
          {lifecycleButtons(b.card.lifecycle).filter(button => button.action !== 'retire').map(button => (
            <button key={button.action} type="button" className="ah-btn" disabled={runner.busy}
              onClick={() => void doExec('lifecycleAction', { botId: b.card.id, action: button.action }, LIFECYCLE_OK_TEXT[button.action])}>{button.label}</button>
          ))}
          {b.card.lifecycle !== 'retired' ? (
            confirmRetire ? (
              <>
                <button type="button" className="ah-btn ah-btn-danger" disabled={runner.busy}
                  onClick={() => { void doExec('lifecycleAction', { botId: b.card.id, action: 'retire' }, LIFECYCLE_OK_TEXT.retire); setConfirmRetire(false) }}>确认退役</button>
                <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={() => setConfirmRetire(false)}>先不退役</button>
              </>
            ) : (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={() => setConfirmRetire(true)}>退役</button>
            )
          ) : null}
          {runner.success && runner.message ? <span className="ah-teammate-life-note" role="status">{runner.message}</span> : null}
        </div>
        <div className="ah-teammate-save">
          <button type="button" className="ah-btn" disabled={runner.busy} onClick={props.onClose}>取消</button>
          <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy} onClick={() => void save()}>保存</button>
        </div>
      </>}
    >
      <BotConfigFields draft={draft} onChange={partial => setDraft(prev => ({ ...prev, ...partial }))}
        modelOptions={props.modelOptions} modelOptionsError={props.modelOptionsError} onRetryModels={props.onRetrySettings}
        presetSkillOptions={props.presetSkillOptions} dshSkillOptions={props.dshSkillOptions}
        chiefTaken={hasLiveChief(otherBots)} disabled={runner.busy} autoFocusName
        problem={attempted ? configProblem(draft, otherNames) : null} />
    </DialogShell>
  )
}
