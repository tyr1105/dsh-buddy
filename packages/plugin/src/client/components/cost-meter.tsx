/**
 * 每日用量表：日期和数字由 core 提供，界面只选择日期。
 * 来源不明和未结账都直说；保持真实零值，不把缺数据当作免费。
 */
import { useState, type ReactNode } from 'react'
import type { CostTotals, CostView } from '../../shared/views.js'
import { formatTokenCount, formatTokenTitle } from '../../shared/token-format.js'

/**
 * P80：token 数量显示成 K、M、B、T 单位的短写法；估算基数可能有小数，先向上取整再换算。
 * 要核对确切数字时，鼠标悬停在数字上显示完整数字（带千位分隔符，见 title）。
 */
const number = (value: number): string => formatTokenCount(Math.ceil(value))
/** 悬停用的完整数字：`{带千位分隔符的完整数字} token`。 */
const fullTitle = (value: number): string => formatTokenTitle(Math.ceil(value))
/** 来源一栏的一句话；full 为真时写完整数字（给悬停用），否则写换算后的写法。 */
const sources = (row: CostTotals, full = false): string => {
  const show = full ? (value: number): string => Math.ceil(value).toLocaleString('en-US') : number
  return [
    `宿主 ${show(row.hostTokens)}`,
    `估算 ${show(row.estimatedTokens)}`,
    row.unknownMeasurements > 0 ? `来源不明 ${row.unknownMeasurements} 笔（记账值）${show(row.unknownTokens)}` : '',
  ].filter(Boolean).join(' · ')
}

export function CostMeter(props: { costs: CostView | undefined }): ReactNode {
  const [selected, setSelected] = useState<string | null>(null)
  const costs = props.costs
  if (!costs?.days.length) return <section className="ah-cost-meter" aria-label="每日用量">
    <h3>每日用量</h3><p className="ah-right-kv">尚未读到成本记录，请刷新；旧版中心可能尚未提供此数据。</p>
  </section>
  // 跨日刷新后旧选择若已过保留窗则回今天，不能出现没有对应数据的空表。
  const day = costs.days.find(row => row.date === selected) ?? costs.days[0]!
  return <section className="ah-cost-meter" aria-label="每日用量">
    <h3>每日用量</h3>
    <div className="ah-cost-days" aria-label="用量日期">
      {costs.days.map((row, index) => <button key={row.date} type="button"
        className="ah-btn ah-btn-ghost" aria-pressed={row.date === day.date}
        onClick={() => { try { setSelected(row.date) } catch { /* 单个选择异常不影响宿主。 */ } }}>
        {index === 0 ? '今天' : row.date.slice(5)}
      </button>)}
    </div>
    <p className="ah-right-kv">{day.date} · {costs.timezone} · 按结账日统计，包含主人发起。</p>
    <p className="ah-cost-summary" role="status">
      已结账 {day.total.turns} 回合 · 记账 <span title={fullTitle(day.total.tokens)}>{number(day.total.tokens)}</span> token
      {day.total.pending > 0 ? ` · ${day.total.pending} 回合尚未结账` : ''}
    </p>
    <div className="ah-cost-table-wrap">
      <table className="ah-cost-table">
        <caption className="ah-sr-only">各员工当日已结账用量</caption>
        <thead><tr><th scope="col">员工</th><th scope="col">回合</th><th scope="col">计量 token</th><th scope="col">记账 token</th></tr></thead>
        <tbody>{day.bots.map(row => <tr key={row.botId}>
          <th scope="row">{row.name}{row.archived ? <small>已归档或档案不在</small> : null}</th>
          <td>{row.turns}<small>主人发起 {row.ownerTurns}{row.unknownOwnerTurns ? ` · 发起者不明 ${row.unknownOwnerTurns}` : ''}</small>
            {row.pending ? <small>{row.pending} 回合尚未结账</small> : null}</td>
          <td title={`${sources(row, true)} token`}>{sources(row)}</td><td title={fullTitle(row.tokens)}>{number(row.tokens)}</td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row">全队合计</th><td>{day.total.turns}</td><td title={`${sources(day.total, true)} token`}>{sources(day.total)}</td><td title={fullTitle(day.total.tokens)}>{number(day.total.tokens)}</td></tr></tfoot>
      </table>
    </div>
    {!day.bots.length ? <p className="ah-right-kv">这一天没有已保留的员工或账项。</p> : null}
    <p className="ah-right-kv">记账值含结账时的保护倍率，可能高于计量；旧记录来源不明。正在运行的回合结束后计入，表中只含已保留的记录。</p>
    {/* 「未分摊」是 core 给的真实口径，不能在界面写死——将来项目分摊上线后这行应自动消失。 */}
    {costs.projectStatus === 'unallocated'
      ? <p className="ah-right-kv">项目尚未配置，当前用量未分摊。主人在 DSH 独立会话的用量不在此表。</p>
      : null}
  </section>
}
