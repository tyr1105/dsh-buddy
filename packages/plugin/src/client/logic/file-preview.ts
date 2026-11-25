/**
 * 文件预览侧栏的状态（W12 第三轮验收后改）：卡片上点 md，页面右边打开一栏显示全文，卡片还在左边看得见。
 *
 * 为什么放在模块里：文件小条在卡片深处，侧栏挂在页面最外层（.ah-body 的最后一栏），两头用同一个仓库连起来。
 * 同一时间只预览一个文件；再点另一个文件就换掉内容。读取失败时侧栏里写原因。
 */
import { createStore } from '../store.js'

/** 定位一份证据文件：哪件事、哪次交回、哪条证据。 */
export interface FilePreviewRef { jobId: string; submissionId: string; evidenceId: string }

export type FilePreviewState =
  | { ref: FilePreviewRef; name: string; status: 'loading' }
  | { ref: FilePreviewRef; name: string; status: 'ok'; text: string; format: 'markdown' | 'plain' }
  | { ref: FilePreviewRef; name: string; status: 'error'; error: string }

/** 读文本的函数形状：与 client/api.ts 的 readJobEvidenceText 一致。 */
export type FilePreviewReader = (input: FilePreviewRef) =>
  Promise<{ ok: boolean; error?: string; data?: { text: string; format: 'markdown' | 'plain'; name: string } }>

export const filePreviewStore = createStore<FilePreviewState | null>(null)

/** 打开一个文件的预览：先显示「读取中」，读到后换成全文；读不出来写原因。只认最后一次打开的文件。 */
export async function openFilePreview(ref: FilePreviewRef, name: string, read: FilePreviewReader): Promise<void> {
  const mine: FilePreviewState = { ref, name, status: 'loading' }
  filePreviewStore.set(mine)
  let next: FilePreviewState
  try {
    const result = await read(ref)
    next = result.ok && result.data !== undefined
      ? { ref, name: result.data.name || name, status: 'ok', text: result.data.text, format: result.data.format }
      : { ref, name, status: 'error', error: result.error ?? '没能读出这个文件' }
  } catch (error) {
    next = { ref, name, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
  // 读的过程中主人又点了别的文件或关掉了侧栏：这次的结果作废。
  if (filePreviewStore.getSnapshot() === mine) filePreviewStore.set(next)
}

export function closeFilePreview(): void {
  filePreviewStore.set(null)
}

/** 某个证据是不是正在预览（文件小条据此高亮）。 */
export function isPreviewing(state: FilePreviewState | null, ref: FilePreviewRef): boolean {
  return state !== null && state.ref.jobId === ref.jobId && state.ref.submissionId === ref.submissionId && state.ref.evidenceId === ref.evidenceId
}

/** 侧栏宽度：默认占页面 45%（与 DSH 右侧栏默认比例一致），拖动时夹在 320 像素和 70% 之间。 */
export const PREVIEW_DEFAULT_RATIO = 0.45
export const PREVIEW_MAX_RATIO = 0.7
export const PREVIEW_MIN_PX = 320

export function clampPreviewWidth(width: number, containerWidth: number): number {
  const max = Math.max(PREVIEW_MIN_PX, Math.floor(containerWidth * PREVIEW_MAX_RATIO))
  return Math.min(max, Math.max(PREVIEW_MIN_PX, Math.round(width)))
}
