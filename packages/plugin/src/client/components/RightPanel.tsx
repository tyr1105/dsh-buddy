/**
 * 队友右侧边栏（P64）：对话页右边按需展开，默认收起。
 *
 * 主人的要求是「点进队友就是对话，其余按需看」，所以这里只回答几个问题：
 * 它现在是什么状态（在岗、停用、归档）、手上在办哪些事、总管的本窗口额度怎么分、
 * 性格四句话怎么做事、用的什么模型和今天的额度、它自己攒了哪些技能。
 * 配置和状态（停用、归档等）收进底部的「编辑员工」弹窗，见 TeammateEditDialog；
 * 弹窗由页面层的 TeammateEditHost 承载（P78：对话页「更多」里也能打开，不依赖本侧边栏是否展开）。
 * 窄屏时这里是盖在对话上的抽屉，键盘和读屏的模态行为由 useDrawerFocus 负责。
 *
 * P76j：栏的顺序是 状态、在办的事、（总管才有）本窗口额度、性格、模型与额度、技能库。
 * 「在办的事」读 core 的 activeJobsView（每件三行、消耗条、排序由 core 定），
 * 旧的项目任务排在后面、组标题「其他事务」；旧宿主没有这条路由时退回原来的工作会话列表。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { mbtiBehaviorLines } from '@agent-hub/core/team'
import type { ActiveJobsView, BotCard, BotView, CostView, Light, QuotaWindowView, SkillLibraryView } from '../../shared/views.js'
import { defaultSkillApi, shouldCloseSkillDetailOnEscape, skillRowDomId, type SkillApi } from '../logic/skill-library.js'
import { SkillDetail } from './SkillDetail.js'
import { SkillLibrarySection } from './SkillLibrarySection.js'
import { displayRoleLabel, isChiefEntry } from '../logic/agreement.js'
import { OTHER_WORK_TITLE, buildActiveWorkPanel, costBarWidth } from '../logic/active-jobs.js'
import {
  NO_ACTIVE_WORK_TEXT, modelQuotaLine, modelTierText, quotaTokens, teammateStatusLine,
  type BusyTone, type ModelTierInfo,
} from '../logic/teammate-panel.js'
import { toneClass } from '../logic/job.js'
import { formatTokenTitle } from '../../shared/token-format.js'
import type { WorkSession } from '../logic/work-session.js'
import { PersonalityLines } from './PersonalityLines.js'
import { Dot, Skeleton } from './Ui.js'
import { isDrawerMode, useDrawerFocus } from './use-drawer-focus.js'
import { WorkSessionRow } from './work-session-row.js'

/** 忙碌大类对应的圆点颜色：不上班和空闲都用灰点，文字负责说清差别。 */
const DOT_TONE: Readonly<Record<BusyTone, 'busy' | 'warn' | 'idle'>> = { busy: 'busy', waiting: 'warn', idle: 'idle', off: 'idle' }

/** 本窗口额度一栏的固定文字（登记在 docs/copy/strings.json，编号 QTA-）。 */
const QUOTA_TEXT = {
  title: '本窗口额度',
  barLabel: '员工已用、员工还可用、给你留出',
  /** P86：行名；后面接本窗口员工已用 token 的文字（由 core 视图给出，如「1.76M token」）。 */
  usedTokens: '已用 token',
} as const

/** 「查看全部记录」：底部入口，打开动态页（与命令面板同一个入口）。 */
const VIEW_ALL_ACTIVITY = '查看全部记录'

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
  /** P76j：这位队友的「在办的事」（core 视图）；null 表示旧宿主没有这条路由或还没读到，退回工作会话列表。 */
  activeJobs?: ActiveJobsView | null
  /** P76j：点一件事：进它所在的主题。 */
  onOpenJob?: (topicId: string) => void
  /** P76j：总管才有「本窗口额度」；其他员工或旧宿主不传。 */
  quotaWindow?: QuotaWindowView | null
  /** P76j：点「查看全部记录」：打开动态页。 */
  onOpenActivity?: () => void
  onCollapse: () => void
  /** 点底部「编辑员工」：弹窗在页面层（TeammateEditHost），与对话页「更多」里的入口共用同一个。 */
  onEdit: () => void
  /** P73f：标准档、轻档各对应哪个模型（由模型目录算出）；还没读到时不传，「模型与额度」写模型显示名。 */
  tiers?: ModelTierInfo | null
  /** P75j：技能库视图；null 表示还没取到（显示骨架）。旧调用方不传，按还没取到处理。 */
  skillLibrary?: SkillLibraryView | null
  /** P75j：技能库取失败的原因（没有旧数据时显示一句原因和「重试」）。 */
  skillLibraryError?: string | null
  onRetrySkillLibrary?: () => void
  /** P75j：技能详情的三个入口；不传时用宿主接口，测试传替身。 */
  skillApi?: SkillApi
}): ReactNode {
  const { panelRef } = useDrawerFocus()
  // P75j：打开的技能详情（null 表示显示列表）；返回列表时把焦点还给刚才点开的那一条。
  const [openSkillId, setOpenSkillId] = useState<string | null>(null)
  const lastOpenedSkill = useRef<string | null>(null)
  useEffect(() => {
    if (openSkillId !== null || lastOpenedSkill.current === null) return
    const id = lastOpenedSkill.current
    lastOpenedSkill.current = null
    try { document.getElementById(skillRowDomId(id))?.focus() } catch { /* 找不到元素时不影响返回 */ }
  }, [openSkillId])
  // 技能详情打开期间，焦点可能不在侧栏里（例如确认框关闭后焦点落在页面上），Esc 就到不了上面的处理。
  // 这时在 window 上兜底：没有确认框开着、按键没被别处处理时，Esc 同样回到列表。
  useEffect(() => {
    if (openSkillId === null || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onKey = (event: KeyboardEvent): void => {
      try {
        if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.ah-dialog-mask') !== null) return
        // P75r7（B9）：只在焦点落在页面最外层（body）或侧栏之内时处理。宽屏下侧栏与对话并排，
        // 焦点在对话输入框或别的弹出菜单里按 Esc 属于它们自己，不该把技能详情关掉。
        const active = document.activeElement
        if (!shouldCloseSkillDetailOnEscape(active, document.body, panelRef.current)) return
        setOpenSkillId(null)
      } catch { /* 不影响页面 */ }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSkillId])
  const openSkill = (skillId: string): void => { lastOpenedSkill.current = skillId; setOpenSkillId(skillId) }
  const card = props.card
  // P73f：「状态」一行读员工状态（在岗、停用、归档），在岗时后面接现有的忙碌文字。
  const status = teammateStatusLine(card)
  // 「模型与额度」：档位（或模型名）加今天的回合数和 token；档位判断在 modelTierText，逻辑在纯函数里。
  const detail = props.detail
  const modelLine = modelQuotaLine({
    tierText: detail === null ? '模型读取中' : modelTierText(detail.profile.model, detail.profile.modelText, props.tiers),
    costs: props.costs, botId: card.id, cardTokens: card.todayTokens,
  })
  // 悬停用的完整 token 数字，与上一行取同一个来源。
  const modelTokens = quotaTokens({ costs: props.costs, botId: card.id, cardTokens: card.todayTokens })
  // 「性格」：没有设置的旧员工写「性格　未设置」，不画四句话；详情还没拉到时整栏先不画，免得误报「未设置」。
  const mbti = detail?.profile.mbti ?? null
  const personalityLines = mbtiBehaviorLines(mbti)
  // P76j：「在办的事」：视图行在前、旧任务在后；两者都没有时显示空态，旧宿主退回工作会话列表。
  const panel = buildActiveWorkPanel(props.activeJobs ?? null, props.sessions)
  const quotaWindow = props.quotaWindow ?? null
  // P76n：总管的角色标签也是「总管」，与名字相同时不重复画「总管 总管」。
  const roleLabel = displayRoleLabel(card)

  const openRow = (session: WorkSession): void => {
    props.onOpenSession(session)
    // 抽屉盖着对话，不收起来主人就看不到跳转结果；宽屏是并排的，留着方便接着看下一件。
    if (isDrawerMode()) props.onCollapse()
  }
  const openJob = (topicId: string): void => {
    props.onOpenJob?.(topicId)
    if (isDrawerMode()) props.onCollapse()
  }

  return (
    <aside className="ah-right" aria-label={`${card.name} 的状态`} ref={panelRef} tabIndex={-1} onKeyDown={e => {
      // 弹窗已移到页面层（TeammateEditHost），Esc 不再经过这里，只管收起侧边栏。
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      // P75j：技能详情打开时，Esc 先回到技能库列表，不收起侧边栏。
      if (openSkillId !== null) setOpenSkillId(null)
      else props.onCollapse()
    }}>
      <div className="ah-right-head">
        <h2>{card.name}{roleLabel !== card.name ? <span className="ah-bot-row-role">{roleLabel}</span> : null}</h2>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onCollapse} aria-label="收起侧边栏">收起</button>
      </div>
      {openSkillId !== null ? (
        // P75j：技能详情在右侧栏内替换列表显示（窄屏抽屉里同样）；底部「编辑员工」此时不显示。
        <div className="ah-right-scroll">
          <SkillDetail key={openSkillId} skillId={openSkillId} api={props.skillApi ?? defaultSkillApi}
            reloadKey={props.skillLibrary ?? null} onBack={() => setOpenSkillId(null)} />
        </div>
      ) : (<>
      <div className="ah-right-scroll">
        {/* P72：总管的资料区多一行默契度（采纳的建议数 / 建议总数）；文字由 core 给，没有确认记录时不显示。 */}
        {card.rapport ? <p className="ah-right-kv ah-right-rapport">{card.rapport.text}</p> : null}
        <section className="ah-right-section" aria-label="状态">
          <h3>状态</h3>
          <p className="ah-right-busy"><Dot tone={DOT_TONE[status.tone]} label={status.text} /></p>
          {status.detail !== null ? <p className="ah-right-kv">{status.detail}</p> : null}
        </section>

        <section className="ah-right-section" aria-label="在办的事">
          <h3>{panel.headText}</h3>
          {panel.loading ? <Skeleton rows={2} />
            : panel.empty ? <p className="ah-right-kv">{NO_ACTIVE_WORK_TEXT}</p>
              : <>
                {panel.rows.map(row => {
                  const width = costBarWidth(row.costRatio)
                  return (
                    <button key={row.key} type="button" className={`ah-active-job${row.waitingOwner ? ' is-waiting' : ''}`}
                      onClick={() => openJob(row.topicId)}>
                      <span className="ah-active-job-head">
                        <span className="ah-active-job-title">{row.title}</span>
                        <span className={`ah-job-state ${toneClass(row.stateTone)}`}>{row.stateLabel}</span>
                      </span>
                      <span className="ah-active-job-wait">{row.waitText}</span>
                      <span className="ah-active-job-cost">
                        {width !== null ? <span className="ah-active-job-bar" aria-hidden="true"><span style={{ width }} /></span> : null}
                        <span>{row.costText}</span>
                      </span>
                    </button>
                  )
                })}
                {panel.showOtherTitle ? <p className="ah-work-group-name ah-active-job-other">{OTHER_WORK_TITLE}</p> : null}
                {panel.groups.map(group => (
                  <div key={group.projectId} className="ah-work-group">
                    <p className="ah-work-group-name">{group.projectName}</p>
                    {group.sessions.map((session: WorkSession) => (
                      <WorkSessionRow key={session.id} session={session} onOpen={openRow} />
                    ))}
                  </div>
                ))}
              </>}
          {panel.footerText !== null && props.onOpenActivity !== undefined ? (
            <button type="button" className="ah-btn ah-btn-ghost ah-active-job-footer" onClick={props.onOpenActivity}>{VIEW_ALL_ACTIVITY}</button>
          ) : null}
        </section>

        {/* P76j：总管才有「本窗口额度」：三段窗口条加两行文字；员工与旧宿主不画这一栏。 */}
        {quotaWindow !== null ? (
          <section className="ah-right-section" aria-label={QUOTA_TEXT.title}>
            <h3>{QUOTA_TEXT.title}{quotaWindow.resetText !== '' ? <span className="ah-right-count">{quotaWindow.resetText}</span> : null}</h3>
            <div className="ah-quota-bar" role="img" aria-label={QUOTA_TEXT.barLabel}>
              <span className="ah-quota-seg is-used" style={{ width: `${Math.round(quotaWindow.barParts.staffUsed * 100)}%` }} />
              <span className="ah-quota-seg is-left" style={{ width: `${Math.round(quotaWindow.barParts.staffLeft * 100)}%` }} />
              <span className="ah-quota-seg is-reserved" style={{ width: `${Math.round(quotaWindow.barParts.reserved * 100)}%` }} />
            </div>
            {/* P76j 补：三段各自不断行（420 宽时「给你留出三成」曾被拆成「给你留」「出三成」）；
                放不下时整段换到下一行，读起来仍是三句完整的话。 */}
            <p className="ah-quota-line ah-quota-parts">
              <span>{quotaWindow.staffUsedTurnsText}</span>
              <span>{quotaWindow.staffLeftTurnsText}</span>
              <span>{quotaWindow.reserveText}</span>
            </p>
            {/* P86：本窗口员工已用的 token 数量（与顶栏同一份视图的文字）；悬停显示完整数字。旧宿主的视图没有这一项时不画。 */}
            {quotaWindow.staffUsedTokensText !== undefined ? (
              <p className="ah-quota-line" title={quotaWindow.staffUsedTokens === undefined ? undefined : formatTokenTitle(quotaWindow.staffUsedTokens)}>
                {QUOTA_TEXT.usedTokens}　{quotaWindow.staffUsedTokensText}
              </p>
            ) : null}
            {quotaWindow.holdText !== null ?<p className="ah-quota-line">{quotaWindow.holdText}</p> : null}
          </section>
        ) : null}

        {detail !== null ? (
          <section className="ah-right-section" aria-label="性格">
            <h3>{mbti === null ? '性格　未设置' : `性格　${mbti}`}</h3>
            {personalityLines !== null ? <PersonalityLines lines={personalityLines} label={`性格 ${mbti} 的实际行为`} /> : null}
          </section>
        ) : null}

        <section className="ah-right-section" aria-label="模型与额度">
          <h3>模型与额度</h3>
          {/* P80：数字已换算成 K、M 等单位，鼠标悬停显示完整数字；读不到用量时没有数字，不加悬停。 */}
          <p title={modelTokens === null ? undefined : formatTokenTitle(modelTokens)}>{modelLine}</p>
        </section>

        {/* P75j：技能库一栏（自己积累、岗位技能、不常用三组，加刻度）；点一条自己积累或不常用的技能打开详情。 */}
        <SkillLibrarySection view={props.skillLibrary ?? null} error={props.skillLibraryError ?? null}
          onRetry={props.onRetrySkillLibrary ?? (() => undefined)} onOpen={openSkill} />
      </div>
      <div className="ah-right-actions">
        {/* 详情视图一选中队友就在拉，正常很快就到；这之前没有东西可以填进表单。 */}
        <button type="button" className="ah-btn" disabled={props.detail === null}
          onClick={props.onEdit}>编辑员工</button>
      </div>
      </>)}
    </aside>
  )
}
