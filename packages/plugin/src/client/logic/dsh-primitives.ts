/**
 * 借用 DSH 自带的界面零件（W12 验收后加）：Markdown 渲染器 MarkdownText、文件类型图标和关闭、文件夹图标（Modal 备用）。
 *
 * 为什么：主人希望 md 文件用 DSH 内置的查看效果来看，又不想跳到别的对话里。DSH 的客户端模块表
 * 公开了 @deepseek-ai/dsh-client-ui-primitives（和 react 一样由基座提供），我们在自己的页面里直接用它，
 * 不自己写 Markdown 渲染器。
 *
 * 只在用到时取一次；取不到（旧版 DSH、测试环境）返回 null，调用方退回纯文本显示。
 * 构建时这个模块名列在 build.mjs 的 external 里，运行时由插件工厂函数的 require 从模块表取。
 */
import type { ComponentType, ReactNode } from 'react'

/** DSH MarkdownText 的属性（只列我们用到的）。text 是不可信的 Markdown，DSH 自己会做安全处理。 */
export interface DshMarkdownTextProps {
  text: string
  labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string }
  variant?: 'body' | 'compact'
  omitHtml?: boolean
}

/** DSH Modal 的属性（只列我们用到的）。 */
export interface DshModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  closeLabel: string
  description?: ReactNode
  children?: ReactNode
  contentClassName?: string
}

/** DSH 的产品图标、文件类型图标（只列我们用到的属性）。 */
export interface DshIconProps { size?: number; className?: string }
export interface DshFileTypeIconProps extends DshIconProps { path: string }

export interface DshPrimitives {
  MarkdownText: ComponentType<DshMarkdownTextProps> | null
  Modal: ComponentType<DshModalProps> | null
  FileTypeIcon: ComponentType<DshFileTypeIconProps> | null
  IconClose: ComponentType<DshIconProps> | null
  IconFolderOpen: ComponentType<DshIconProps> | null
}

const MODULE_ID = '@deepseek-ai/dsh-client-ui-primitives'

let cached: DshPrimitives | null | undefined

/** 测试用：换掉取模块的办法，或者清掉缓存。 */
export function setPrimitivesLoaderForTest(loader: (() => unknown) | null): void {
  cached = undefined
  testLoader = loader
}
let testLoader: (() => unknown) | null = null

function loadModule(): unknown {
  if (testLoader !== null) return testLoader()
  // esbuild 打包后这里的 require 是 DSH 模块加载器交给插件工厂函数的那一个；ESM 测试环境里没有 require。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return typeof require === 'function' ? require(MODULE_ID) : null
}

/** 取 DSH 的界面零件；取不到返回 null。结果缓存，整页只取一次。 */
export function dshPrimitives(): DshPrimitives | null {
  if (cached !== undefined) return cached
  try {
    const mod = loadModule() as Record<string, unknown> | null
    const pick = (name: string): ComponentType<never> | null => {
      const value = mod?.[name]
      return typeof value === 'function' || (typeof value === 'object' && value !== null) ? value as ComponentType<never> : null
    }
    const MarkdownText = pick('MarkdownText') as DshPrimitives['MarkdownText']
    const Modal = pick('Modal') as DshPrimitives['Modal']
    const FileTypeIcon = pick('FileTypeIcon') as DshPrimitives['FileTypeIcon']
    const IconClose = pick('IconCloseOutlineRegular') as DshPrimitives['IconClose']
    const IconFolderOpen = pick('IconFolderOpenOutlineRegular') as DshPrimitives['IconFolderOpen']
    cached = MarkdownText === null && Modal === null ? null : { MarkdownText, Modal, FileTypeIcon, IconClose, IconFolderOpen }
  } catch (error) {
    try { console.warn('[agent-hub] 取不到 DSH 的界面零件，改用纯文本显示', String(error)) } catch { /* 日志出错不影响 */ }
    cached = null
  }
  return cached
}
