/**
 * 约定卡里的草图（P72e）：总管提交的是结构化内容，这里只用 HTML 和 CSS 画出来，
 * 不是图片，也不引入任何图形库，所以颜色、字号都随 DSH 的主题。
 *
 * 三种版式（由 sketch.layout 决定）：
 * - page：页面线框。每屏一个竖向线框（手机比例，宽度跟着卡片走），屏标题在上；
 *   屏里的块按种类画：标题粗体一行、文字一行、输入框画成输入框的样子（必填加「*」）、
 *   按钮画成按钮的样子、图片画占位框、列表画项目符号、表格画小表格、说明画小字。
 *   屏与屏横排，窄屏时竖排（样式里用 flex-wrap 完成）。
 * - flow：流程。步骤从左到右排成方框，方框之间画箭头；窄屏从上到下。
 *   actor（谁来做）写在方框上方小字，note（补充）写在下方小字。
 * - concept：概念。节点排成方框网格（不做自动布局），连线不画线，
 *   而是在网格下面用列表写「A → B：文字」，保证窄屏也读得清。
 *
 * 任何元素带 mark（圆圈数字）时，旁边画一个圆圈数字，数字和卡片里「待你定」的序号一致，
 * 你一眼就能看出这个地方对应哪一件还没定的事。
 *
 * 为什么每个版式写成普通函数而不是子组件：这样整张草图是一棵连续的元素树，
 * 测试可以直接检查圆圈数字、屏数、步数，不用再逐层展开子组件。
 */
import type { ReactNode } from 'react'
import { AGR_TEXT, conceptLinkTexts, type AgreementSketchValue } from '../logic/agreement.js'

type SketchBlock = NonNullable<NonNullable<AgreementSketchValue['screens']>[number]>['blocks'][number]

/** 圆圈数字：对应卡片里「待你定」的第几项。 */
function pin(mark: number | undefined, key: string): ReactNode {
  return mark === undefined ? null : <span key={key} className="ah-agr-pin" aria-label={`对应待你定的第 ${mark} 项`}>{mark}</span>
}

/** 页面线框里的一个块。 */
function blockNode(block: SketchBlock, index: number): ReactNode {
  const key = `b${index}`
  const mark = pin(block.mark, `${key}-pin`)
  switch (block.kind) {
    case 'title':
      return <div key={key} className="ah-agr-wf-title">{block.text}{mark}</div>
    case 'text':
      return <div key={key} className="ah-agr-wf-text">{block.text}{mark}</div>
    case 'field':
      // 输入框外形：左边是字段名，必填加「*」，右边留给圆圈数字。
      return (
        <div key={key} className="ah-agr-wf-field">
          <span>{block.text}{block.required === true ? ' *' : ''}</span>{mark}
        </div>
      )
    case 'button':
      return <div key={key} className="ah-agr-wf-button">{block.text}{mark}</div>
    case 'image':
      return <div key={key} className="ah-agr-wf-image" role="img" aria-label={block.text}><span>{block.text}</span>{mark}</div>
    case 'list':
      return <ul key={key} className="ah-agr-wf-list"><li>{block.text}{mark}</li></ul>
    case 'table':
      return (
        <table key={key} className="ah-agr-wf-table">
          <caption>{block.text}{mark}</caption>
          <tbody>
            {(block.rows ?? []).map((row, r) => (
              <tr key={`r${r}`}>{row.map((cell, c) => (r === 0 ? <th key={`c${c}`}>{cell}</th> : <td key={`c${c}`}>{cell}</td>))}</tr>
            ))}
          </tbody>
        </table>
      )
    case 'note':
    default:
      return <div key={key} className="ah-agr-wf-note">{block.text}{mark}</div>
  }
}

/** page 版式：一排竖向线框。 */
function pageNode(sketch: AgreementSketchValue): ReactNode {
  const screens = sketch.screens ?? []
  return (
    <div className="ah-agr-screens" role="group" aria-label={AGR_TEXT.sketchScreens}>
      {screens.map((screen, i) => (
        <div key={`s${i}`} className="ah-agr-frame">
          <p className="ah-agr-frame-cap">{screen.title}</p>
          {screen.blocks.map(blockNode)}
        </div>
      ))}
    </div>
  )
}

/** flow 版式：方框加箭头，actor 在上、note 在下。 */
function flowNode(sketch: AgreementSketchValue): ReactNode {
  const steps = sketch.steps ?? []
  return (
    <ol className="ah-agr-flow" aria-label={AGR_TEXT.sketchFlow}>
      {steps.map((step, i) => (
        <li key={`f${i}`} className="ah-agr-flow-item">
          {step.actor !== undefined ? <span className="ah-agr-flow-actor">{step.actor}</span> : null}
          <span className="ah-agr-box">{step.text}{pin(step.mark, `f${i}-pin`)}</span>
          {step.note !== undefined ? <span className="ah-agr-flow-note">{step.note}</span> : null}
          {i < steps.length - 1 ? <span className="ah-agr-arrow" aria-hidden="true">→</span> : null}
        </li>
      ))}
    </ol>
  )
}

/** concept 版式：节点网格，连线写在下面的列表里。 */
function conceptNode(sketch: AgreementSketchValue): ReactNode {
  const nodes = sketch.nodes ?? []
  const links = conceptLinkTexts(sketch)
  return (
    <div className="ah-agr-concept" role="group" aria-label={AGR_TEXT.sketchConcept}>
      <ul className="ah-agr-nodes">
        {nodes.map(node => (
          <li key={node.id} className="ah-agr-box">
            <span>{node.text}{pin(node.mark, `n-${node.id}-pin`)}</span>
            {node.note !== undefined ? <span className="ah-agr-flow-note">{node.note}</span> : null}
          </li>
        ))}
      </ul>
      {links.length > 0 ? (
        <ul className="ah-agr-links" aria-label={AGR_TEXT.sketchLinks}>
          {links.map((text, i) => <li key={`l${i}`}>{text}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

/** 草图：changed 为真时整块加改动底色（本版改动处）。 */
export function AgreementSketch(props: { sketch: AgreementSketchValue; changed?: boolean }): ReactNode {
  const { sketch } = props
  const body = sketch.layout === 'page' ? pageNode(sketch) : sketch.layout === 'flow' ? flowNode(sketch) : conceptNode(sketch)
  return <div className={`ah-agr-sketch ah-agr-sketch-${sketch.layout}${props.changed === true ? ' ah-agr-changed' : ''}`}>{body}</div>
}
