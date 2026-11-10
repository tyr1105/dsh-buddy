/**
 * 队友右侧边栏（P64）：对话页右边按需展开，默认收起。
 *
 * 主人的要求是「点进队友就是对话，其余按需看」，所以这里只回答三个问题：
 * 它现在忙不忙、今天用了多少额度、手上还有哪些事。三块内容的文案规则在 logic/teammate-panel，
 * 数据全部来自总览和项目视图，打开侧边栏不额外发请求。
 * 配置和生命周期（暂停、退役等）收进底部的「编辑队友」弹窗，见 TeammateEditDialog。
 * 窄屏时这里是盖在对话上的抽屉，键盘和读屏的模态行为由 useDrawerFocus 负责。
 */
import { useState, type ReactNode } from 'react'
import type { BotCard, BotView, CommandResult, CostView, DshSkillOption, Light, PresetSkillOption } from '../../shared/views.js'
import { NO_ACTIVE_WORK_TEXT, activeWorkGroups, teammateBusy, teammateQuota, type BusyTone } from '../logic/teammate-panel.js'
import type { WorkSession } from '../logic/work-session.js'
import { Dot, Skeleton } from './Ui.js'
import { TeammateEditDialog } from './TeammateEditDialog.js'
import { useCommandRunner } from './use-command-runner.js'
import { isDrawerMode, useDrawerFocus } from './use-drawer-focus.js'
import { WorkSessionRow } from './work-session-row.js'

/** 忙碌大类对应的圆点颜色：不上班和空闲都用灰点，文字负责说清差别。 */
const DOT_TONE: Readonly<Record<BusyTone, 'busy' | 'warn' | 'idle'>> = { busy: 'busy', waiting: 'warn', idle: 'idle', off: 'idle' }

export function RightPanel(props: {
  /** 总览里的队友卡：忙碌状态和回合数都读它，打开侧边栏马上有内容。 */
  card: BotCard
  /** 队友详情：只有「编辑队友」要用；还没拉到时按钮先不可点。 */
  detail: BotView | null
  /** 全队额度灯：侧边栏不再显示（顶栏有），保留属性是为了不动调用方。 */
  light?: Light
  /** 成本视图：用来说主人今天发起了几回合；旧宿主没有时为 undefined。 */
  costs: CostView | undefined
  /** 这位队友的工作会话；null 表示项目视图还没拉到，不假装没有工作。 */
  sessions: readonly WorkSession[] | null
  onOpenSession: (session: WorkSession) => void
  onCollapse: () => void
  /** 完整名册：编辑表单查重名和总管名额用。 */
  roster: readonly BotCard[]
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  modelOptionsError?: string | null
  onRetrySettings?: () => void
  presetSkillOptions: readonly PresetSkillOption[]
  dshSkillOptions: readonly DshSkillOption[]
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  onRefresh: () => void
}): ReactNode {
  const runner = useCommandRunner(props.run)
  const { panelRef } = useDrawerFocus()
  const [editing, setEditing] = useState(false)
  const card = props.card
  const busy = teammateBusy(card)
  // 额度只显示 token：优先成本视图，读不到退回队友卡，逻辑在 teammateQuota。
  const quotaText = teammateQuota({ costs: props.costs, botId: card.id, cardTokens: card.todayTokens })
  const groups = props.sessions === null ? null : activeWorkGroups(props.sessions)
  const workCount = groups?.reduce((sum, group) => sum + group.sessions.length, 0) ?? 0

  const openRow = (session: WorkSession): void => {
    props.onOpenSession(session)
    // 抽屉盖着对话，不收起来主人就看不到跳转结果；宽屏是并排的，留着方便接着看下一件。
    if (isDrawerMode()) props.onCollapse()
  }

  return (
    <aside className="ah-right" aria-label={`${card.name} 的状态`} ref={panelRef} tabIndex={-1} onKeyDown={e => {
      if (e.key !== 'Escape' || runner.busy || editing) return
      e.preventDefault(); e.stopPropagation(); props.onCollapse()
    }}>
      {/* 弹窗开着时提示由弹窗自己显示；这里只管保存后弹窗已经关掉的情况。 */}
      {!editing && runner.success && runner.message ? <div className="ah-save-toast" role="status">{runner.message}</div> : null}
      <div className="ah-right-head">
        <h2>{card.name}<span className="ah-bot-row-role">{card.roleLabel}</span></h2>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onCollapse} aria-label="收起侧边栏">收起</button>
      </div>
      <div className="ah-right-scroll">
        <section className="ah-right-section" aria-label="忙碌状态">
          <h3>忙碌状态</h3>
          <p className="ah-right-busy"><Dot tone={DOT_TONE[busy.tone]} label={busy.label} /></p>
          {busy.detail !== null ? <p className="ah-right-kv">{busy.detail}</p> : null}
        </section>

        <section className="ah-right-section" aria-label="额度">
          <h3>额度</h3>
          <p>{quotaText}</p>
        </section>

        <section className="ah-right-section" aria-label="在办的事">
          <h3>在办的事{workCount > 0 ? <span className="ah-right-count">{workCount} 件</span> : null}</h3>
          {groups === null ? <Skeleton rows={2} />
            : groups.length === 0 ? <p className="ah-right-kv">{NO_ACTIVE_WORK_TEXT}</p>
              : groups.map(group => (
                <div key={group.projectId} className="ah-work-group">
                  <p className="ah-work-group-name">{group.projectName}</p>
                  {group.sessions.map(session => (
                    <WorkSessionRow key={session.id} session={session} onOpen={openRow} />
                  ))}
                </div>
              ))}
        </section>
      </div>
      <div className="ah-right-actions">
        {/* 详情视图一选中队友就在拉，正常很快就到；这之前没有东西可以填进表单。 */}
        <button type="button" className="ah-btn" disabled={props.detail === null}
          onClick={() => { runner.setMessage(null); setEditing(true) }}>编辑队友</button>
      </div>
      {editing && props.detail !== null ? (
        <TeammateEditDialog
          bot={props.detail}
          roster={props.roster}
          modelOptions={props.modelOptions}
          modelOptionsError={props.modelOptionsError}
          onRetrySettings={props.onRetrySettings}
          presetSkillOptions={props.presetSkillOptions}
          dshSkillOptions={props.dshSkillOptions}
          runner={runner}
          onRefresh={props.onRefresh}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </aside>
  )
}
