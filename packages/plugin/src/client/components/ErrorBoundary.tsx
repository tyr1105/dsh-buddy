/**
 * 块级错误边界：每个页面组件外包一层，渲染出错只在该块显示
 * 「这块没显示出来，刷新试试」，绝不让一个组件的异常拖垮整页
 * （任务卡约束；也避免控制台出现 slot entry crashed 后连累别的插槽）。
 */
import { Component, type ReactNode } from 'react'

interface BoundaryProps { label: string; children: ReactNode }
interface BoundaryState { failed: boolean }

export class BlockBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  /** 出错只记日志、不出插槽崩溃。 */
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[agent-hub] 界面块「${this.props.label}」渲染出错:`, error)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <div className="ah-empty" role="alert">界面加载失败。刷新页面重试；仍失败请检查 DSH 运行状态。</div>
    }
    return this.props.children
  }
}
