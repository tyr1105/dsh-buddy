/**
 * P74h 证据清单与截图缩略图的测试：
 * - 四种证据（截图、文件、测试、链接）的渲染；不符行的样式与「改到什么程度算过」块；机械检查一句。
 * - 截图：进入视口才请求；同一次页面只请求一次；错误显示；点开大图后 Esc 关闭、焦点回到缩略图。
 * 样例取自 fixture-job.ts（core 的纯函数生成），链接一条在测试里补（样例约定没有链接证据）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvidenceList, FileChip, ShotThumb } from '../src/client/components/EvidenceList.js'
import { closeFilePreview, filePreviewStore } from '../src/client/logic/file-preview.js'
import { clearShotCache, returnFocus } from '../src/client/logic/job.js'
import { SAMPLE_SHOT_REF, sampleEvidenceItems, sampleReviewPassCard, sampleReviewReturnCard, sampleSubmissionCard } from '../src/shared/fixture-job.js'
import type { EvidenceItemView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')
/** 等 Promise 链跑完（读取截图的 then 回调）。 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  clearShotCache()
})

describe('证据清单（P74h）', () => {
  it('四种证据都渲染：截图缩略图、文件小条（「文件」小标签加文件名）、测试一句（左边细线）、链接', () => {
    // 样例约定没有链接证据，测试里在第 2 条上补一条（构造输入，不是样例视图）。
    const items: EvidenceItemView[] = sampleEvidenceItems(sampleSubmissionCard).map(item => item.no === 2
      ? { ...item, evidence: [...item.evidence, { id: 'ev8', kind: 'link', label: 'example.com', path: null, url: 'https://example.com/preview', summary: '本机预览', checkText: null }] }
      : item)
    const tree = createHookHost().render(EvidenceList, { items, shotRef: SAMPLE_SHOT_REF })
    const text = textOf(tree)
    // 截图是缩略图组件（子组件不展开，检查传给它的证据说明）。
    const thumbs = findElements(tree, ShotThumb)
    expect(thumbs.map(thumb => (thumb.props.evidence as { summary: string }).summary)).toContain('手机　390 宽')
    // 文件小条（W12 起是可点的子组件，子组件不展开，检查传给它的证据和定位参数）。
    const chips = findElements(tree, FileChip)
    expect(chips.map(chip => (chip.props.evidence as { label: string }).label)).toContain('报名名单表格.numbers')
    expect(chips[0]!.props.shotRef).toEqual(SAMPLE_SHOT_REF)
    // 没有定位参数时文件小条仍是一行文字：小标签加文件名。
    expect(textOf(createHookHost().render(EvidenceList, { items, shotRef: null }))).toContain('文件报名名单表格.numbers')
    expect(text).toContain('依次提交 81 条，第 81 条显示「名额已满」；名单 80 行。') // 测试一句
    expect(text).toContain('链接example.com') // 链接：小标签加主机名
  })

  it('不符的行整行浅警示底色，写明问题，并单独一块「改到什么程度算过」', () => {
    const tree = createHookHost().render(EvidenceList, { items: sampleEvidenceItems(sampleReviewReturnCard), shotRef: SAMPLE_SHOT_REF })
    const rows = findElements(tree, 'li')
    expect(classOf(rows[2]!)).toBe('is-bad')
    expect(classOf(rows[1]!)).toBe('') // 其余行不带警示底色
    const fix = findElements(tree, 'div').find(node => classOf(node) === 'ah-ev-fix')!
    expect(textOf(fix)).toContain('改到什么程度算过')
    expect(textOf(fix)).toContain('提示文字与约定逐字一致：「请填写 11 位手机号」；提交按钮不可用。附一张截图。')
    expect(textOf(rows[2])).toContain('提示文字是「手机号格式不正确」，与约定不一致。')
    // 结论小章有文字：符合 / 不符，不靠颜色单独表达。
    expect(textOf(findElements(tree, 'span').find(node => classOf(node) === 'ah-ev-verdict is-bad'))).toBe('不符')
  })

  it('机械检查的结果一行小字（checkText）', () => {
    const tree = createHookHost().render(EvidenceList, { items: sampleEvidenceItems(sampleSubmissionCard), shotRef: SAMPLE_SHOT_REF })
    expect(textOf(tree)).toContain('文件存在，3.2 KB')
  })
})

/** 可控的 IntersectionObserver 替身：测试里手动「滚进视口」。 */
function fakeObserver() {
  const callbacks: Array<(records: Array<{ isIntersecting: boolean }>) => void> = []
  const Ctor = class {
    constructor(callback: (records: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(callback) }
    observe(): void { /* 挂上后不自动回调，等测试触发 */ }
    disconnect(): void { /* 不需要 */ }
  }
  return {
    Ctor,
    enterView: (): void => { for (const callback of callbacks) callback([{ isIntersecting: true }]) },
  }
}

const EVIDENCE = sampleEvidenceItems(sampleSubmissionCard)[0]!.evidence[0]!
const okReader = vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,AAA' } }))

describe('截图缩略图（P74h）', () => {
  it('进入视口前不请求；进入视口后按 (jobId, submissionId, evidenceId) 请求一次', async () => {
    const observer = fakeObserver()
    vi.stubGlobal('IntersectionObserver', observer.Ctor)
    const host = createHookHost()
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    expect(okReader).not.toHaveBeenCalled()
    observer.enterView()
    // 下一轮渲染的提交里发出请求；等 Promise 链跑完再渲染一轮，缩略图才出现。
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    expect(okReader).toHaveBeenCalledTimes(1)
    expect(okReader).toHaveBeenCalledWith({ ...SAMPLE_SHOT_REF, evidenceId: EVIDENCE.id })
    await flush()
    const img = findElements(host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader }), 'img')[0]!
    expect(img.props.src).toBe('data:image/png;base64,AAA')
  })

  it('同一次页面里同一张图只请求一次（另一个组件实例命中缓存）', async () => {
    const observer = fakeObserver()
    vi.stubGlobal('IntersectionObserver', observer.Ctor)
    const first = createHookHost()
    first.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    observer.enterView()
    first.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    await flush()
    first.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    const second = createHookHost()
    second.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    observer.enterView()
    second.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    await flush()
    expect(okReader).toHaveBeenCalledTimes(1)
    expect(findElements(second.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader }), 'img').length).toBe(1)
  })

  it('读取失败显示占位框加错误文字', async () => {
    const observer = fakeObserver()
    vi.stubGlobal('IntersectionObserver', observer.Ctor)
    const failing = vi.fn(async () => ({ ok: false as const, error: '这张截图不在主题文件夹里。' }))
    const host = createHookHost()
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: failing })
    observer.enterView()
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: failing })
    await flush()
    const tree = host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: failing })
    const placeholder = findElements(tree, 'span').find(node => classOf(node).startsWith('ah-shot-placeholder is-error'))!
    expect(textOf(placeholder)).toBe('这张截图不在主题文件夹里。')
  })

  it('点缩略图打开大图；Esc 关闭，焦点回到缩略图', async () => {
    const observer = fakeObserver()
    vi.stubGlobal('IntersectionObserver', observer.Ctor)
    const host = createHookHost()
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    observer.enterView()
    host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    await flush()
    const loaded = host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    ;(findElements(loaded, 'button').find(node => classOf(node).startsWith('ah-shot-btn'))!.props.onClick as () => void)()
    const withDialog = host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    const dialog = findElements(withDialog, 'div').find(node => node.props['aria-label'] === '证据大图')!
    expect(textOf(dialog)).toContain('关闭')
    ;(dialog.props.onKeyDown as (event: { key: string }) => void)({ key: 'Escape' })
    const closed = host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: okReader })
    expect(findElements(closed, 'div').some(node => node.props['aria-label'] === '证据大图')).toBe(false)
  })

  it('returnFocus 把焦点还给元素；元素没有 focus 方法时安静跳过', () => {
    const focus = vi.fn()
    returnFocus({ focus })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(() => returnFocus({})).not.toThrow()
    expect(() => returnFocus(null)).not.toThrow()
  })
})

describe('文件小条（W12）', () => {
  const FILE = sampleEvidenceItems(sampleSubmissionCard).flatMap(item => item.evidence).find(entry => entry.kind === 'file')!

  it('点文件名发「打开」，点旁边的按钮发「在访达中显示」，都带完整定位参数', async () => {
    const open = vi.fn(async () => ({ ok: true }))
    const host = createHookHost()
    const buttons = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open }), 'button')
    expect(buttons.length).toBe(2)
    expect(textOf(buttons[0])).toContain(FILE.label)
    ;(buttons[0]!.props.onClick as () => void)()
    await flush()
    const again = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open }), 'button')
    ;(again[1]!.props.onClick as () => void)()
    await flush()
    expect(open).toHaveBeenNthCalledWith(1, { ...SAMPLE_SHOT_REF, evidenceId: FILE.id, action: 'open' })
    expect(open).toHaveBeenNthCalledWith(2, { ...SAMPLE_SHOT_REF, evidenceId: FILE.id, action: 'reveal' })
  })

  it('打不开：下面一行写原因，带路径时显示路径方便复制；再点一次前先清掉', async () => {
    const open = vi.fn(async () => ({ ok: false, error: '没能自动打开，可以复制这个路径自己打开', path: '/x/交付/报告.md' }))
    const host = createHookHost()
    const first = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open }), 'button')
    ;(first[0]!.props.onClick as () => void)()
    await flush()
    const tree = host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open })
    const alert = findElements(tree, 'span').find(node => classOf(node) === 'ah-ev-file-error')!
    expect(textOf(alert)).toContain('没能自动打开')
    expect(textOf(findElements(alert, 'code')[0])).toBe('/x/交付/报告.md')
  })

  it('打开中两个按钮都不可点，不会重复发命令', () => {
    const open = vi.fn(() => new Promise<{ ok: boolean }>(() => { /* 一直不回 */ }))
    const host = createHookHost()
    const first = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open }), 'button')
    ;(first[0]!.props.onClick as () => void)()
    const buttons = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: FILE, open }), 'button')
    expect(buttons.every(button => button.props.disabled === true)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
  })

  const MD = { ...FILE, path: '交付/现状梳理与下一步建议.md', label: '现状梳理与下一步建议.md' }

  it('md 点文件名：按定位参数读出全文，交给页面右边的预览侧栏，不发「打开」；正在预览的文件名高亮', async () => {
    closeFilePreview()
    const open = vi.fn(async () => ({ ok: true }))
    const readText = vi.fn(async () => ({ ok: true, data: { text: '# 报告', format: 'markdown' as const, name: '现状梳理与下一步建议.md' } }))
    const host = createHookHost()
    const first = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: MD, open, readText }), 'button')
    ;(first[0]!.props.onClick as () => void)()
    expect(filePreviewStore.getSnapshot()).toMatchObject({ status: 'loading', name: MD.label })
    await flush()
    expect(readText).toHaveBeenCalledWith({ ...SAMPLE_SHOT_REF, evidenceId: MD.id })
    expect(open).not.toHaveBeenCalled()
    expect(filePreviewStore.getSnapshot()).toEqual({ ref: { ...SAMPLE_SHOT_REF, evidenceId: MD.id }, name: '现状梳理与下一步建议.md', status: 'ok', text: '# 报告', format: 'markdown' })
    const again = findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: MD, open, readText }), 'button')
    expect(classOf(again[0]!)).toContain('is-previewing')
    expect(again[0]!.props['aria-pressed']).toBe(true)
    closeFilePreview()
  })

  it('读不出来：原因写在侧栏里', async () => {
    closeFilePreview()
    const readText = vi.fn(async () => ({ ok: false, error: '这个文件超过 2 MB，请用「在访达中显示」打开' }))
    const host = createHookHost()
    ;(findElements(host.render(FileChip, { shotRef: SAMPLE_SHOT_REF, evidence: MD, readText }), 'button')[0]!.props.onClick as () => void)()
    await flush()
    expect(filePreviewStore.getSnapshot()).toMatchObject({ status: 'error', error: expect.stringContaining('超过 2 MB') })
    closeFilePreview()
  })
})
