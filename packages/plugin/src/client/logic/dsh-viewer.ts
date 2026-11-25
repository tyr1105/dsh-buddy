/**
 * W12：在 DSH 自带的文件预览里看卡片上的文件。
 *
 * DSH 的文件预览（右侧边栏，md、代码、PDF、图片、Office 都能看）挂在一个会话上：只有某个会话的对话占着中栏时，
 * 侧栏服务 sidebarRight 才接受打开命令，而且读文件要经过那个会话。员工页占着中栏时打不开，所以做法是：
 * 1. 切回「对话」侧，用 uiWorkspace.openSession 打开交付这件事的员工的工作会话；
 * 2. 等侧栏服务报告这个会话已在屏幕上（mounted），用 openResource 在侧栏打开文件地址
 *    dsh-resource://file/session/<会话>/<绝对路径>（地址写法照 DSH 的 workspace-path 包）。
 * 任何一步不行就返回失败原因，由调用方退回「用默认应用打开」。
 */
import { openBotSessionWith } from './thread.js'

/** 界面入口登记的两样东西：插件的客户端上下文，以及切回「对话」侧的函数。 */
interface ViewerHost { ctx: unknown; toChat: () => void }

let host: ViewerHost | null = null

/** 界面入口 apply 时登记一次；返回撤销函数。 */
export function registerDshViewer(next: ViewerHost): () => void {
  host = next
  return () => { if (host === next) host = null }
}

/** 与 DSH 的 encodeSegment 一致：逐段 URI 编码，冒号保留（Windows 盘符）。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** 会话下的文件地址；绝对路径的前导斜杠保留，得到 session/<id>//Users/… 这样的写法。 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}`
}

/** 读侧栏服务的 mounted（可观察值，不同版本可能是 getSnapshot 或 get）。 */
function mountedSession(sidebar: any): string | undefined {
  try {
    const mounted = sidebar?.mounted
    if (typeof mounted?.getSnapshot === 'function') return mounted.getSnapshot()
    if (typeof mounted?.get === 'function') return mounted.get()
    return typeof mounted === 'string' ? mounted : undefined
  } catch {
    return undefined
  }
}

/** 等待用的小工具（可替换，测试里不真的等）。 */
export interface ViewerTiming { wait: (ms: number) => Promise<void>; attempts: number; stepMs: number }
const realTiming: ViewerTiming = { wait: ms => new Promise(resolve => setTimeout(resolve, ms)), attempts: 40, stepMs: 100 }

/** 在 DSH 的文件预览里打开；成功返回 null，否则返回一句原因（调用方据此退回默认应用）。 */
export async function viewInDsh(sessionId: string, path: string, timing: ViewerTiming = realTiming, given: ViewerHost | null = host): Promise<string | null> {
  if (given === null) return '界面还没准备好'
  const get = (given.ctx as { get?: (name: string) => any } | null)?.get
  const sidebar = typeof get === 'function' ? (() => { try { return get.call(given.ctx, 'sidebarRight') } catch { return undefined } })() : undefined
  if (typeof sidebar?.openResource !== 'function') return '这个版本的 DSH 没有文件预览'
  try { given.toChat() } catch { /* 切换失败也继续试 */ }
  const opened = openBotSessionWith(given.ctx, sessionId)
  if (opened !== 'opened') return '打不开员工的工作会话'
  const address = sessionFileAddress(sessionId, path)
  for (let i = 0; i < timing.attempts; i++) {
    if (mountedSession(sidebar) === sessionId) {
      try {
        sidebar.openResource(address, { destination: 'sidebar' })
        return null
      } catch { /* 会话的侧栏还没建好，稍后再试 */ }
    }
    await timing.wait(timing.stepMs)
  }
  return 'DSH 的文件预览没有响应'
}
