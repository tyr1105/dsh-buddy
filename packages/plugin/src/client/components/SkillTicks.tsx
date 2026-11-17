/**
 * 技能刻度（P75j，设计稿场景 H 提案一）：一根横线，每条通过核对的技能更新刻一道。
 *
 * 画法：上方一行「刻度　n 道　入职 d 天」，中间一根横线，线上每道一个竖刻（长短按出处：评审意见短、验收结果中、
 * 你的纠正长；整理合并用强调色），下方是图例和「最近一道」。这些文字都是 core 生成的，这里原样显示。
 * 竖刻按先后顺序等距排开（不按时间比例，免得同一天的几道叠在一起）。
 * 读屏：整条线只读一句「技能刻度：n 道」，每一道都是装饰，不单独聚焦。
 * 新刻的一道有一次刻入动画；系统要求减少动态效果时没有动画（样式见 workspace.css 里的 .ah-skill-tick-fresh）。
 */
import type { ReactNode } from 'react'
import type { SkillTicksView } from '../../shared/views.js'
import { skillTicksLabel, tickClassName } from '../logic/skill-library.js'

export function SkillTicks(props: { ticks: SkillTicksView }): ReactNode {
  const { ticks } = props
  return (
    <div className="ah-skill-ticks">
      <p className="ah-right-kv">{ticks.headText}</p>
      <div className="ah-skill-ticks-line" role="img" aria-label={skillTicksLabel(ticks)}>
        {ticks.ticks.map((tick, index) => (
          <span key={`${tick.at}-${index}`} className="ah-skill-tick-slot" aria-hidden="true">
            <span className={tickClassName(tick)} />
          </span>
        ))}
      </div>
      {/* 图例的每一项（「短：评审意见」一组）是一个整体，窄处只在项与项之间换行，项内不断行；文字仍是 core 给的那一句。 */}
      <p className="ah-right-kv ah-skill-ticks-legend">
        {ticks.legend.split('　').map(item => <span key={item} className="ah-skill-legend-item">{item}</span>)}
      </p>
      {ticks.lastText !== null ? <p className="ah-right-kv">{ticks.lastText}</p> : null}
    </div>
  )
}
