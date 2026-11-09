/**
 * 宿主模块表提供 react-dom，插件运行时不打包它。
 * 项目只装了 React 类型，所以这里只声明实际使用的 portal 接口，无需新增依赖。
 */
declare module 'react-dom' {
  import type { Key, ReactNode, ReactPortal } from 'react'
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: Key | null): ReactPortal
}
