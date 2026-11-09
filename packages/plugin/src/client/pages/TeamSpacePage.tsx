/**
 * 团队空间页面骨架（P32）：标题、共享切换条、返回对话的路径。
 *
 * 两条命运：
 * - 有宿主空间位（P41）：中栏直接渲染完整的队友页，本页不参与；
 * - 无空间位（P42）：本页承载页面内「对话 / 队友」切换条。对话侧不回放原生列表，
 *   只说明原生界面保持原样并给出回去的按钮，避免出现第二份假的会话列表。
 *
 * 骨架阶段只做容器与空态；P33 起把队友主页放进来，P41/P42 决定它挂在哪。
 */
import type { ReactNode } from 'react'
import { SpaceSwitch, type SpaceSwitchSource } from '../components/space-switch.js'
import type { SpaceMode } from '../logic/space-capability.js'

export function TeamSpacePage(props: {
  mode: SpaceMode
  onModeChange: (mode: SpaceMode, source: SpaceSwitchSource) => void
  /** 回到 DSH 原生对话界面（降级页专用；有宿主空间位时由顶栏切换器负责）。 */
  onBackToChat: () => void
  compact?: boolean
  /** 队友侧内容；不传时显示骨架空态。 */
  children?: ReactNode
}): ReactNode {
  return (
    <section className="ah-page ah-team-space" data-plugin-page="agent-hub-team">
      <header className="ah-team-space-head">
        <div className="ah-team-space-title">
          <h1>团队空间</h1>
          <p>队友与对话为两个独立空间；此处仅显示队友侧。</p>
        </div>
        <div className="ah-team-space-actions">
          <SpaceSwitch mode={props.mode} onChange={props.onModeChange} compact={props.compact} />
          <button type="button" className="ah-btn ah-team-space-back" onClick={props.onBackToChat}>回到对话界面</button>
        </div>
      </header>
      <div className="ah-team-space-body">
        {props.mode === 'team' ? (
          props.children ?? (
            <div className="ah-team-space-empty">
              <h2>队友页即将展开</h2>
              <p>左侧切换到「队友」后显示队友、项目与工作会话。</p>
            </div>
          )
        ) : (
          <div className="ah-team-space-empty">
            <h2>对话界面保持原生</h2>
            <p>DSH 的会话、工作区与设置未复制到此处。点击上方「回到对话界面」继续。</p>
            <button type="button" className="ah-btn" onClick={props.onBackToChat}>回到对话界面</button>
          </div>
        )}
      </div>
    </section>
  )
}
