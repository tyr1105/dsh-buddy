/**
 * W12 文件预览侧栏：仓库（只认最后一次打开、关闭、宽度夹紧）和侧栏本身（DSH 零件、退路、在访达中显示、Esc 关闭）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilePreviewBody, FilePreviewPane } from '../src/client/components/FilePreviewPane.js'
import { clampPreviewWidth, closeFilePreview, filePreviewStore, openFilePreview, type FilePreviewState } from '../src/client/logic/file-preview.js'
import { setPrimitivesLoaderForTest } from '../src/client/logic/dsh-primitives.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

const REF = { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1' }
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const byClass = (tree: unknown, tag: string, cls: string): StubElement[] =>
  findElements(tree, tag).filter(node => String(node.props.className ?? '').split(' ').includes(cls))

afterEach(() => { closeFilePreview(); setPrimitivesLoaderForTest(null) })

describe('预览仓库', () => {
  it('先显示读取中，读到后换成全文；读的过程中换了文件或关掉，旧结果作废', async () => {
    let release: (value: unknown) => void = () => {}
    const slow = vi.fn(() => new Promise(resolve => { release = resolve })) as never
    const pending = openFilePreview(REF, 'a.md', slow)
    expect(filePreviewStore.getSnapshot()).toMatchObject({ status: 'loading', name: 'a.md' })
    closeFilePreview()
    release({ ok: true, data: { text: 'x', format: 'markdown', name: 'a.md' } })
    await pending
    expect(filePreviewStore.getSnapshot()).toBeNull()
    await openFilePreview(REF, 'b.txt', async () => ({ ok: true, data: { text: 'hi', format: 'plain', name: 'b.txt' } }))
    expect(filePreviewStore.getSnapshot()).toMatchObject({ status: 'ok', text: 'hi', format: 'plain' })
    await openFilePreview(REF, 'c.md', async () => { throw new Error('断了') })
    expect(filePreviewStore.getSnapshot()).toMatchObject({ status: 'error', error: '断了' })
  })

  it('宽度夹在 320 像素和页面 70% 之间', () => {
    expect(clampPreviewWidth(100, 1000)).toBe(320)
    expect(clampPreviewWidth(900, 1000)).toBe(700)
    expect(clampPreviewWidth(450.4, 1000)).toBe(450)
    expect(clampPreviewWidth(500, 300)).toBe(320)
  })
})

describe('预览侧栏', () => {
  const ok: FilePreviewState = { ref: REF, name: '报告.md', status: 'ok', text: '# 报告', format: 'markdown' }

  it('没有预览时什么都不画', () => {
    expect(createHookHost().render(FilePreviewPane, {})).toBeNull()
  })

  it('有 DSH 零件：标题行有文件类型图标、文件名、在访达中显示、关闭；md 用 DSH 的 Markdown 渲染器', () => {
    const MarkdownText = () => null
    const FileTypeIcon = () => null
    const IconCloseOutlineRegular = () => null
    const IconFolderOpenOutlineRegular = () => null
    setPrimitivesLoaderForTest(() => ({ MarkdownText, Modal: () => null, FileTypeIcon, IconCloseOutlineRegular, IconFolderOpenOutlineRegular }))
    const tree = createHookHost().render(FilePreviewBody, { state: ok, reveal: vi.fn() })
    const aside = tree as unknown as StubElement
    expect(aside.type).toBe('aside')
    expect(aside.props['aria-label']).toBe('文件预览：报告.md')
    expect(findElements(tree, FileTypeIcon)[0]!.props).toMatchObject({ path: '报告.md' })
    expect(textOf(byClass(tree, 'span', 'ah-fp-name')[0])).toBe('报告.md')
    expect(findElements(tree, IconFolderOpenOutlineRegular).length).toBe(1)
    expect(findElements(tree, IconCloseOutlineRegular).length).toBe(1)
    expect(findElements(tree, MarkdownText)[0]!.props).toMatchObject({ text: '# 报告', labels: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' } })
  })

  it('取不到 DSH 零件：文字按钮，正文按原样显示；读取中、出错各一句', () => {
    setPrimitivesLoaderForTest(() => { throw new Error('unknown module') })
    const tree = createHookHost().render(FilePreviewBody, { state: ok, reveal: vi.fn() })
    expect(textOf(findElements(tree, 'pre')[0])).toBe('# 报告')
    expect(textOf(findElements(tree, 'button'))).toContain('在访达中显示')
    const loading = createHookHost().render(FilePreviewBody, { state: { ref: REF, name: 'a.md', status: 'loading' }, reveal: vi.fn() })
    expect(textOf(byClass(loading, 'p', 'ah-fp-status')[0])).toBe('正在打开…')
    const failed = createHookHost().render(FilePreviewBody, { state: { ref: REF, name: 'a.md', status: 'error', error: '这个文件是空的' }, reveal: vi.fn() })
    expect(byClass(failed, 'p', 'ah-fp-status')[0]!.props.role).toBe('alert')
  })

  it('在访达中显示带完整定位参数；失败时标题下面写原因', async () => {
    setPrimitivesLoaderForTest(() => null)
    const reveal = vi.fn(async () => ({ ok: false, error: '这个文件已不在主题文件夹里' }))
    const host = createHookHost()
    const buttons = findElements(host.render(FilePreviewBody, { state: ok, reveal }), 'button')
    ;(buttons[0]!.props.onClick as () => void)()
    await flush()
    expect(reveal).toHaveBeenCalledWith({ ...REF, action: 'reveal' })
    expect(textOf(byClass(host.render(FilePreviewBody, { state: ok, reveal }), 'p', 'ah-fp-changed')[0])).toContain('不在主题文件夹里')
  })

  it('关闭按钮和 Esc 都关掉预览', async () => {
    setPrimitivesLoaderForTest(() => null)
    await openFilePreview(REF, '报告.md', async () => ({ ok: true, data: { text: '# 报告', format: 'markdown', name: '报告.md' } }))
    const tree = createHookHost().render(FilePreviewBody, { state: filePreviewStore.getSnapshot()!, reveal: vi.fn() })
    ;(findElements(tree, 'button')[1]!.props.onClick as () => void)()
    expect(filePreviewStore.getSnapshot()).toBeNull()
    await openFilePreview(REF, '报告.md', async () => ({ ok: true, data: { text: '# 报告', format: 'markdown', name: '报告.md' } }))
    const again = createHookHost().render(FilePreviewBody, { state: filePreviewStore.getSnapshot()!, reveal: vi.fn() }) as unknown as StubElement
    ;(again.props.onKeyDown as (e: { key: string }) => void)({ key: 'Escape' })
    expect(filePreviewStore.getSnapshot()).toBeNull()
  })
})
