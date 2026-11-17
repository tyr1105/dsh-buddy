/**
 * 员工右侧栏的「技能库」一栏（P75j，设计稿场景 C）。
 *
 * 一栏分三组：自己积累（员工自己维护，每条可点开看详情）、岗位技能（预置，只读，不是按钮）、不常用（收起的，可点开、可放回）。
 * 顶部是标题、条数和最近更新日期，第二行是上次整理的日期，再下面是技能刻度（SkillTicks）。
 * 所有文字（条数、版本、「本周更新」小标、来源一句、「补充自……」、组说明、刻度文字）都由 core 生成，这里原样显示，
 * 不自己拼句子，也不按原因写分支；只有「自己积累」一组为空时那句空状态是界面写的。
 * 视图还没取到时显示骨架占位；取失败显示一句原因和「重试」。
 */
import type { ReactNode } from 'react'
import type { SkillLibraryView } from '../../shared/views.js'
import { NO_SELF_SKILL_TEXT, skillRowDomId } from '../logic/skill-library.js'
import { SkillTicks } from './SkillTicks.js'
import { RetryBox, Skeleton } from './Ui.js'

/** 视图里一组的类型（从 SkillLibraryView 取，保持与 core 同形）。 */
type Group = SkillLibraryView['groups'][number]

/** 自己积累与不常用里的一条：整行是按钮，点开详情。 */
function SkillRow(props: { item: Group['items'][number]; onOpen: (skillId: string) => void }): ReactNode {
  const { item } = props
  return (
    <button type="button" id={skillRowDomId(item.skillId)} className="ah-skill-row" onClick={() => props.onOpen(item.skillId)}>
      <span className="ah-skill-row-main">
        <span className="ah-skill-title">{item.title}</span>
        <span className="ah-right-kv">{item.versionText}</span>
        {item.badge !== null ? <span className="ah-tag ah-tag-entry">{item.badge}</span> : null}
      </span>
      <span className="ah-right-kv ah-skill-meta">{item.sourceText}</span>
      {item.supplementsText !== null ? <span className="ah-right-kv ah-skill-meta">{item.supplementsText}</span> : null}
    </button>
  )
}

/** 一组：组名与说明、技能行（岗位技能是只读的行，不是按钮）。 */
function SkillGroup(props: { group: Group; onOpen: (skillId: string) => void }): ReactNode {
  const { group } = props
  return (
    <div className="ah-skill-group">
      <p className="ah-skill-group-head"><b>{group.label}</b><span className="ah-right-kv">　{group.note}</span></p>
      {group.key === 'self' && group.items.length === 0 ? <p className="ah-right-kv">{NO_SELF_SKILL_TEXT}</p> : null}
      {group.items.map(item => <SkillRow key={item.skillId} item={item} onOpen={props.onOpen} />)}
      {group.roleItems.map(role => (
        <div key={role.title} className="ah-skill-row ah-skill-row-readonly">
          <span className="ah-skill-row-main"><span className="ah-skill-title">{role.title}</span></span>
          <span className="ah-right-kv ah-skill-meta">{role.note}</span>
        </div>
      ))}
    </div>
  )
}

export function SkillLibrarySection(props: {
  /** 技能库视图；null 表示还没取到。 */
  view: SkillLibraryView | null
  /** 取失败的原因（有旧数据时仍显示旧数据，不显示这个）。 */
  error: string | null
  onRetry: () => void
  onOpen: (skillId: string) => void
}): ReactNode {
  const { view } = props
  if (view === null) {
    return (
      <section className="ah-right-section" aria-label="技能库">
        <h3>技能库</h3>
        {props.error !== null ? <RetryBox message={props.error} onRetry={props.onRetry} /> : <Skeleton rows={3} />}
      </section>
    )
  }
  return (
    <section className="ah-right-section ah-skill-library" aria-label={view.title}>
      <h3>
        <span>{view.title}<span className="ah-right-count">　{view.countText}</span></span>
        {view.lastUpdatedText !== null ? <span className="ah-right-count">{view.lastUpdatedText}</span> : null}
      </h3>
      {view.lastTidyText !== null ? <p className="ah-right-kv">{view.lastTidyText}</p> : null}
      <SkillTicks ticks={view.ticks} />
      {view.groups.map(group => <SkillGroup key={group.key} group={group} onOpen={props.onOpen} />)}
    </section>
  )
}
