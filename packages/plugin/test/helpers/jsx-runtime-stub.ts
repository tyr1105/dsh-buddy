/**
 * 测试用的 JSX 运行时：把 <div className="x" /> 变成普通对象 { type, props, key }。
 *
 * 为什么需要：插件运行时的 react 由宿主提供，依赖里没有 react，测试环境又把 react 指到了桩。
 * 组件文件（.tsx）一 import 就要用 JSX 运行时，没有它就加载不了。
 * 这里不做真正的渲染，子组件也不会被执行，够测试检查「这一层组件返回了什么」就行。
 */
export const Fragment = Symbol.for('test.fragment')

export interface StubElement {
  type: unknown
  props: Record<string, unknown>
  key: unknown
}

/** 生产模式的 JSX 入口（单个子节点）。 */
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): StubElement {
  return { type, props, key }
}

/** 生产模式的 JSX 入口（多个子节点），形状和 jsx 一样。 */
export const jsxs = jsx

/** 开发模式的 JSX 入口：vitest 默认走这个，后面几个调试参数用不到。 */
export const jsxDEV = jsx

/** 在元素树里找某种类型的元素：组件被包在错误边界里也能找到（边界的 children 就在 props 上）。 */
export function findElements(node: unknown, type: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(child => findElements(child, type))
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [...(element.type === type ? [element] : []), ...findElements(element.props.children, type)]
}
