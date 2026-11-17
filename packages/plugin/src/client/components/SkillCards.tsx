/**
 * 主题「复盘」折叠组里的两种卡（P75k，设计稿场景 A、B）：复盘卡与技能核对卡。外框沿用「一件事」的卡片（JobCard 同一套样式）。
 *
 * 复盘卡：头「复盘」、标题、计数一行；每行是「出处种类小标、出处文字、箭头、目标与细节」；底部一句 footer。
 * 核对卡：头「核对」、标题、状态小章（已写入、未写入、等待改写）；「出处原文」块、「更新内容」块；
 * 三行检查与「符合」「不符」；有不符时核对人的说明；底部一句 footer（没有时不画）。
 * 全部文字来自 core 的卡片视图，界面原样显示；复盘不推送、不需要主人操作，所以这两种卡没有任何按钮。
 */
import type { ReactNode } from 'react'
import type { RetroCardView, SkillCheckCardView } from '../../shared/views.js'
import { SKILL_CARD_TEXT, stateChipClass, verdictClass } from '../logic/skill-cards.js'

/** 复盘卡。 */
export function RetroCard(props: { card: RetroCardView }): ReactNode {
  const { card } = props
  return (
    <div className="ah-card ah-card-agreement ah-card-job ah-card-retro" data-job-card={card.kind}>
      <div className="ah-card-head ah-job-head">
        <span className="ah-card-type">{card.head}</span>
        <span className="ah-card-title">{card.title}</span>
      </div>
      <p className="ah-job-intro">{card.countsText}</p>
      <ul className="ah-retro-rows">
        {card.rows.map((row, index) => (
          <li key={index} className="ah-retro-row">
            <span className="ah-retro-source">
              <span className="ah-retro-kind">{row.sourceKindText}</span>
              <span>{row.sourceText}</span>
            </span>
            <span className="ah-retro-arrow" aria-hidden="true">{SKILL_CARD_TEXT.arrow}</span>
            <span className="ah-retro-target">
              <strong>{row.target}</strong>
              {row.targetDetail !== null ? <span className="ah-retro-detail">{row.targetDetail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {card.footer !== null ? <p className="ah-job-footer">{card.footer}</p> : null}
    </div>
  )
}

/** 技能核对卡。 */
export function SkillCheckCard(props: { card: SkillCheckCardView }): ReactNode {
  const { card } = props
  return (
    <div className="ah-card ah-card-agreement ah-card-job ah-card-skillcheck" data-job-card={card.kind}>
      <div className="ah-card-head ah-job-head">
        <span className="ah-card-type">{card.head}</span>
        <span className="ah-card-title">{card.title}</span>
        <span className={`ah-job-state ${stateChipClass(card.stateText)}`}>{card.stateText}</span>
      </div>
      <div className="ah-skillcheck-blocks">
        <section className="ah-skillcheck-block" aria-label={SKILL_CARD_TEXT.sourceBlock}>
          <h4>{SKILL_CARD_TEXT.sourceBlock}</h4>
          <ul>
            {/* P75r7（C3）：种类小标与正文之间加一个全角空格，读屏不再把「评审意见」和正文连读成一句。 */}
            {card.sources.map((source, index) => (
              <li key={index}><span className="ah-retro-kind">{source.kindText}</span>{'　'}{source.text}</li>
            ))}
          </ul>
        </section>
        <section className="ah-skillcheck-block" aria-label={SKILL_CARD_TEXT.contentBlock}>
          <h4>{SKILL_CARD_TEXT.contentBlock}</h4>
          <ul>
            {card.content.map((text, index) => <li key={index}>{text}</li>)}
          </ul>
        </section>
      </div>
      <ul className="ah-skillcheck-checks" aria-label={SKILL_CARD_TEXT.checksLabel}>
        {card.checks.map(check => (
          <li key={check.label}>
            <span>{check.label}</span>
            <strong className={verdictClass(check.verdict)}>{check.verdict}</strong>
          </li>
        ))}
      </ul>
      {card.note !== null ? <p className="ah-skillcheck-note">{card.note}</p> : null}
      {card.footer !== null ? <p className="ah-job-footer">{card.footer}</p> : null}
    </div>
  )
}
