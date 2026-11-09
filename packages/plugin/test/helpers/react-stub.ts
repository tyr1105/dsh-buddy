/**
 * 测试用的 React 桩：界面仓库（hub-state → store）只用到 useSyncExternalStore 这一个
 * hook，而仓库层的测试不渲染组件。宿主在打包时才提供真正的 react，测试环境用这个桩
 * 让 import 不断（D05 第 12 条：hub-state 的 SSE 重连逻辑要能单测）。
 */
export const useSyncExternalStore = (): never => {
  throw new Error('测试桩：仓库层测试不渲染组件，不应调用 useSyncExternalStore')
}
const ReactStub = { useSyncExternalStore }
export default ReactStub
