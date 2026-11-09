/**
 * 新建队友的模板库界面（P52）：打开「新建队友」先看到这一屏。
 *
 * 按部门筛选模板卡，可以多选，底部一键添加；点卡片时下方显示这个角色的全部设定。
 * 不能选的卡片用 aria-disabled 而不是 disabled：点它仍能看设定，键盘也走得到，只是不会被选中。
 * 这个组件只管选择，创建、报错和关窗都由外层向导处理，选择规则全在 logic/bot-templates。
 * 三块内容对应弹窗的三行网格：头部固定、中间滚动、底部固定，卡片再多也看得到「添加」按钮。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BotCard, PresetSkillOption } from '../../shared/views.js'
import {
  BOT_TEMPLATE_GROUPS, TEMPLATE_BLOCK_LABELS, defaultDetailTemplate, liveBots, pickWholeGroup, templateBlock, templateById,
  templateDetailRows, templateDetailTitle, templateMeta, templatesInGroup, toggleTemplatePick,
  type BotTemplate, type BotTemplateGroupId,
} from '../logic/bot-templates.js'

export function BotTemplatePicker(props: {
  /** 完整名册：退役和归档的也要传，名字占用和人数上限都按它算。 */
  existingBots: readonly BotCard[]
  /** 技能中文名来自这里；清单没加载时详情里不显示技能那一行。 */
  presetSkillOptions: readonly PresetSkillOption[]
  submitting: boolean
  error: string | null
  onAdd: (templates: readonly BotTemplate[]) => void
  onCustom: () => void
  onClose: () => void
}): ReactNode {
  const [groupId, setGroupId] = useState<BotTemplateGroupId>(BOT_TEMPLATE_GROUPS[0]!.id)
  // 选择顺序就是添加顺序，第一位的对话会在添加后打开。
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [detail, setDetail] = useState<BotTemplate>(() => defaultDetailTemplate(BOT_TEMPLATE_GROUPS[0]!.id))
  const firstCardRef = useRef<HTMLButtonElement | null>(null)

  // 打开或从表单退回来时，把焦点放到第一张卡片：这一屏的主要动作就是选卡片。
  useEffect(() => { firstCardRef.current?.focus() }, [])

  const group = BOT_TEMPLATE_GROUPS.find(item => item.id === groupId)!
  const cards = templatesInGroup(groupId)
  const picked = pickedIds.flatMap(id => templateById(id) ?? [])
  // 按钮只在真能多选上一位时才可用，点了没反应比灰掉更让人困惑。
  const canPickGroup = pickWholeGroup(groupId, pickedIds, props.existingBots).length > pickedIds.length

  const selectGroup = (next: BotTemplateGroupId): void => {
    setGroupId(next)
    setDetail(defaultDetailTemplate(next))
  }

  /** 点卡片：详情总是跟过来；能选的才切换选中。 */
  const clickCard = (template: BotTemplate): void => {
    // 添加途中选择已经交出去了，这时再改选中只会让界面和实际结果对不上。
    if (props.submitting) return
    setDetail(template)
    setPickedIds(ids => toggleTemplatePick(ids, template, props.existingBots))
  }

  // 提示只给第一次用的人；已经有队友的人不需要被告知从哪开始。
  const firstTime = liveBots(props.existingBots).length === 0 && groupId === 'product'
  const summary = picked.length > 0
    ? `已选 ${picked.length} 位：${picked.map(template => template.name).join('、')}`
    : firstTime ? '第一次用，先选带「推荐」的两位：一个做事，一个挑毛病。' : ''

  return (
    <>
      {/* 弹窗是独立表面（背景已 inert 剪枝），标题从 h2 起，大纲不跳级（WCAG 1.3.1）。 */}
      <header className="ah-wizard-head">
        <h2>新建队友</h2>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose} disabled={props.submitting}>关闭</button>
      </header>

      <div className="ah-template-body">
        <p className="ah-template-lead">选几位，一键加进来。名字和设定之后都能改。</p>
        <div className="ah-template-tabs" role="group" aria-label="按部门看模板">
          {BOT_TEMPLATE_GROUPS.map(item => {
            const count = pickedIds.filter(id => templateById(id)?.group === item.id).length
            return (
              <button key={item.id} type="button" className="ah-btn" aria-pressed={item.id === groupId} onClick={() => selectGroup(item.id)}>
                {item.label}{count > 0 ? <span className="ah-template-count">已选 {count}</span> : null}
              </button>
            )
          })}
        </div>
        <div className="ah-template-bar">
          <span>{group.desc}</span>
          <button type="button" className="ah-btn ah-btn-ghost" disabled={!canPickGroup || props.submitting}
            onClick={() => setPickedIds(ids => pickWholeGroup(groupId, ids, props.existingBots))}>选上这一组</button>
        </div>

        <div className="ah-template-grid">
          {cards.map((template, index) => {
            const block = templateBlock(template, props.existingBots, pickedIds)
            const isPicked = pickedIds.includes(template.id)
            return (
              <button key={template.id} ref={index === 0 ? firstCardRef : undefined} type="button"
                aria-pressed={isPicked} aria-disabled={block !== null || undefined}
                className={`ah-wizard-role ah-template-card${isPicked ? ' ah-wizard-role-picked' : ''}${block !== null ? ' ah-wizard-role-disabled' : ''}`}
                onClick={() => clickCard(template)}>
                {isPicked ? <span className="ah-wizard-role-check" aria-hidden="true">已选</span> : null}
                <strong>{template.name}{template.recommended ? <em className="ah-template-recommend">推荐</em> : null}</strong>
                <span>{template.tagline}</span>
                <small className="ah-template-meta">{block !== null ? TEMPLATE_BLOCK_LABELS[block] : templateMeta(template)}</small>
              </button>
            )
          })}
        </div>

        <section className="ah-template-detail" aria-label={`${detail.name}的设定`}>
          <p className="ah-template-detail-title">{templateDetailTitle(detail)}</p>
          <dl className="ah-template-kv">
            {templateDetailRows(detail, props.presetSkillOptions).map((row, index) => (
              <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>
            ))}
          </dl>
        </section>
      </div>

      <div className="ah-template-foot">
        {/* 选中人数变化时读屏会念这一行；空内容也要留着节点，状态区必须先存在。 */}
        <p className="ah-template-summary" role="status">{summary}</p>
        <p className="ah-wizard-note">每位加入后先试跑一次，消耗模型额度。</p>
        {props.error !== null ? <p className="ah-settings-error" role="alert">{props.error}</p> : null}
        <footer className="ah-dialog-actions ah-template-actions">
          <button type="button" className="ah-btn" onClick={props.onCustom} disabled={props.submitting}>自己从头配置</button>
          <button type="button" className="ah-btn ah-btn-primary" disabled={picked.length === 0 || props.submitting} onClick={() => props.onAdd(picked)}>
            {props.submitting ? '添加中…' : picked.length > 0 ? `添加 ${picked.length} 位队友` : '添加队友'}
          </button>
        </footer>
      </div>
    </>
  )
}
