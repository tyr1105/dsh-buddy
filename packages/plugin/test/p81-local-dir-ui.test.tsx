/**
 * P81 第 2、3 节的插件测试：约定卡多出的一行、审批卡的提示句，各有渲染测试；样例对照核心的输出。
 *
 * 1 约定卡：有 localDirLine 时画在发布那一行之后（同一块里，样式照发布那一行），原文逐字；
 *   没有（null、缺省）时不画，旧约定的卡与以前完全一样；这一版改动（launchChanged）时两行同样标「本版改动」；
 * 2 审批卡：风险提示里带发布位置的那一句原样显示，没有位置的写法不变；
 * 3 样例与预览变体：核心生成的样例卡（sampleB2LocalDirCard）的一行、两句样例文字与 core 现在的输出逐字一致；
 *   预览变体（?job=b2&local=1、?job=launch&local=1）的文字与样例、core 一致，其余入口原样返回。
 * 核心的内部函数没有放进公开出口，所以测试按文件地址动态读 core 源文件对照（做法同 p74r20-launch-ui.test.tsx）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { ApprovalBlock } from '../src/client/components/ApprovalBlock.js'
import { approvalPartsOf } from '../src/client/logic/cards.js'
import {
  SAMPLE_LAUNCH_LOCAL_DIR, SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE, SAMPLE_LAUNCH_LOCAL_DIR_LINE, SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE,
  SAMPLE_LAUNCH_LOCAL_HOME, SAMPLE_LAUNCH_LOCAL_HOW, SAMPLE_LAUNCH_LOCAL_RISK_NOTE, SAMPLE_LAUNCH_OTHER_TEXTS, SAMPLE_LAUNCH_RISK_NOTE,
  sampleB2Card, sampleB2LocalDirCard, sampleB2LocalDirFilesCard, sampleLaunchThread,
} from '../src/shared/fixture-job.js'
import {
  previewB2Thread, previewLaunchThread, previewLocalDirCardsThread, previewLocalDirFilesLine, previewLocalDirLine, previewLocalDirPrevLine,
  previewLocalHow, previewLocalRiskNote, previewPlainRiskNote, previewJobTopicThread,
} from '../src/shared/fixture-job-preview.js'
import { withLocalDirVariant } from '../src/shared/preview-job-state.js'
import type { AgreementCardView } from '../src/shared/views.js'
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
const loadCore = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../core/src/${file}`, import.meta.url).href)

if (sampleB2Card === null || sampleB2LocalDirCard === null) throw new Error('缺 B2 样例约定卡')
const plain: AgreementCardView = sampleB2Card
const withDir: AgreementCardView = sampleB2LocalDirCard
const render = (card: AgreementCardView, expanded = true): StubElement =>
  createHookHost().render(AgreementCard, { card, onConfirm: async () => null, startExpanded: expanded }) as StubElement
/** 发布那一块（对外发布一行和本机文件夹一行同属一块）里的段落文字。 */
const launchBlockLines = (tree: StubElement): string[] => {
  const block = findElements(tree, 'div').find(node => classOf(node).includes('ah-agr-launch'))
  return block === undefined ? [] : findElements(block, 'p').filter(node => classOf(node).includes('ah-agr-one')).map(node => textOf(node))
}

describe('1 约定卡画出「发布到本机文件夹」那一行', () => {
  it('有这一行：紧跟在发布那一行之后、同一块里，原文逐字；前面没有图标；收起模式下同样显示', () => {
    expect(withDir.localDirLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_LINE)
    const lines = launchBlockLines(render(withDir))
    expect(lines).toEqual([`验收之后对外发布：${SAMPLE_LAUNCH_LOCAL_HOW}。发布前单独请你批准。`, SAMPLE_LAUNCH_LOCAL_DIR_LINE])
    expect(launchBlockLines(render(withDir, false))).toEqual(lines)
    const block = findElements(render(withDir), 'div').find(node => classOf(node).includes('ah-agr-launch'))!
    expect(findElements(block, 'svg')).toHaveLength(0)
    expect(findElements(block, 'span')).toHaveLength(0)
    // 位置在「怎样算做完」之后。
    const all = textOf(render(withDir))
    expect(all.indexOf(SAMPLE_LAUNCH_LOCAL_DIR_LINE)).toBeGreaterThan(all.indexOf(withDir.doneWhen.at(-1)!.text))
  })

  it('没有这一行（旧约定：样例 B2 原卡没有 localDirLine，或为 null）：只有发布那一行，与以前一样', () => {
    expect(plain.localDirLine ?? null).toBeNull()
    expect(launchBlockLines(render(plain))).toHaveLength(1)
    expect(launchBlockLines(render({ ...withDir, localDirLine: null }))).toHaveLength(1)
    const { localDirLine: _line, ...old } = withDir
    expect(launchBlockLines(render(old as AgreementCardView))).toHaveLength(1)
    expect(textOf(render(plain))).not.toContain('发布到本机文件夹')
  })

  it('这一版改了发布（launchChanged 为真）：两行都带「本版改动」的标记类，为假时都不带', () => {
    const marked = (card: AgreementCardView) => findElements(render(card), 'div').find(node => classOf(node).includes('ah-agr-launch'))!
    const classes = (card: AgreementCardView) => findElements(marked(card), 'p').map(node => classOf(node))
    expect(classes({ ...withDir, launchChanged: true }).every(cls => cls.includes('ah-agr-changed'))).toBe(true)
    expect(classes({ ...withDir, launchChanged: false }).some(cls => cls.includes('ah-agr-changed'))).toBe(false)
  })

  it('P81r1：已有文件夹那一句、以及「原来的位置」那一行，都在发布那一块里依次画出来', () => {
    if (sampleB2LocalDirFilesCard === null) throw new Error('缺 P81r1 样例约定卡')
    const files = sampleB2LocalDirFilesCard
    expect(files.localDirLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE)
    expect(files.localDirPrevLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE)
    const lines = launchBlockLines(render(files))
    expect(lines).toEqual([
      `验收之后对外发布：${SAMPLE_LAUNCH_LOCAL_HOW}。发布前单独请你批准。`,
      SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE,
      SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE,
    ])
    const block = findElements(render(files), 'div').find(node => classOf(node).includes('ah-agr-launch'))!
    const prev = findElements(block, 'p').find(node => textOf(node) === SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE)!
    expect(classOf(prev)).toContain('ah-agr-hint')
  })
})

describe('2 审批卡的提示句', () => {
  const renderRisk = (riskNote: string): string => {
    const parts = approvalPartsOf({ type: 'approval', approval: { actionText: '按约定对外发布：复制到桌面上的活动报名页文件夹', ownerReason: null, riskNote, argsPreview: '{}', argsFull: null, notes: null, onBehalfOf: null, launch: true, voided: false } } as never)!
    const risk = findElements(createHookHost().render(ApprovalBlock, { approval: parts, idBase: 'p81' }), 'p').filter(node => classOf(node) === 'ah-approval-risk')
    expect(risk).toHaveLength(1)
    return textOf(risk[0])
  }
  it('带发布位置的提示句原样显示，没有位置的写法也原样显示', () => {
    expect(renderRisk(SAMPLE_LAUNCH_LOCAL_RISK_NOTE)).toBe(SAMPLE_LAUNCH_LOCAL_RISK_NOTE)
    expect(renderRisk(SAMPLE_LAUNCH_RISK_NOTE)).toBe(SAMPLE_LAUNCH_RISK_NOTE)
    expect(SAMPLE_LAUNCH_LOCAL_RISK_NOTE).toContain('本机临时文件夹、~/Desktop/活动报名页；可以联网')
  })
})

describe('3 样例与预览变体对照核心的输出', () => {
  it('样例里的一行、两句文字与 core 现在的输出逐字一致；样例卡由 core 生成（显示路径以 ~ 开头）', async () => {
    const { hostCommandRiskNote } = await loadCore('gate/host-writable.ts')
    const { localDirLineOf } = await loadCore('api/agreement-views.ts')
    const { launchFailedText } = await loadCore('job/launch-result.ts')
    const { LOCAL_DIR_CHANGED_REASON } = await loadCore('project/local-dir.ts')
    expect(SAMPLE_LAUNCH_LOCAL_RISK_NOTE).toBe(hostCommandRiskNote('林舟', true, '~/Desktop/活动报名页'))
    expect(SAMPLE_LAUNCH_RISK_NOTE).toBe(hostCommandRiskNote('林舟', true))
    expect(SAMPLE_LAUNCH_LOCAL_DIR_LINE).toBe(localDirLineOf({ launch: { how: SAMPLE_LAUNCH_LOCAL_HOW, localDir: SAMPLE_LAUNCH_LOCAL_DIR } }, SAMPLE_LAUNCH_LOCAL_HOME))
    expect(SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE).toBe(localDirLineOf({ launch: { how: SAMPLE_LAUNCH_LOCAL_HOW, localDir: SAMPLE_LAUNCH_LOCAL_DIR, localDirHasFiles: true } }, SAMPLE_LAUNCH_LOCAL_HOME))
    expect(previewLocalDirFilesLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE)
    expect(previewLocalDirPrevLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE)
    expect(withDir.localDirLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_LINE)
    expect(SAMPLE_LAUNCH_OTHER_TEXTS.failedLocalDirChanged).toBe(launchFailedText('活动报名页', { ownerFailureReason: LOCAL_DIR_CHANGED_REASON, result: LOCAL_DIR_CHANGED_REASON }))
  })

  it('预览里的几句与样例逐字相同', () => {
    expect(previewLocalHow).toBe(SAMPLE_LAUNCH_LOCAL_HOW)
    expect(previewLocalDirLine).toBe(SAMPLE_LAUNCH_LOCAL_DIR_LINE)
    expect(previewLocalRiskNote).toBe(SAMPLE_LAUNCH_LOCAL_RISK_NOTE)
    expect(previewPlainRiskNote).toBe(SAMPLE_LAUNCH_RISK_NOTE)
  })

  it('b2 变体：约定卡的两行与 core 生成的样例卡逐字相同；原快照不被改动', () => {
    const before = JSON.stringify(previewB2Thread)
    const variant = withLocalDirVariant('b2', previewB2Thread)
    const card = variant.messages.at(-1)!.agreement!
    expect(card.launchLine).toBe(withDir.launchLine)
    expect(card.localDirLine).toBe(withDir.localDirLine)
    expect(JSON.stringify(previewB2Thread)).toBe(before)
    expect(previewB2Thread.messages.at(-1)!.agreement!.localDirLine ?? null).toBeNull()
  })

  it('launch 变体：发布审批卡的提示句换成带文件夹的写法，其余内容不变；其他入口原样返回', () => {
    const variant = withLocalDirVariant('launch', previewLaunchThread)
    // 只看命令类审批的提示句（写文件那类审批的提示句是另一句，不受影响）。
    const notes = variant.messages.flatMap(message => message.card?.approval?.riskNote ?? []).filter(note => note.startsWith('批准后这条命令只能写入'))
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every(note => note === SAMPLE_LAUNCH_LOCAL_RISK_NOTE)).toBe(true)
    // 与 P81 时的断言同一做法：把这一行的文字换回去，其余内容应当与快照逐字相同；
    // 本地位置变体只额外把那张发布审批卡改成「仍在等批准」（P81r1 第 3.8 节的预览修复），比较前一并改回。
    const restored = structuredClone(variant)
    const promoted = restored.messages.flatMap(message => message.card ?? []).find(item => item.approval?.launch === true)
    if (promoted !== undefined) { promoted.status = 'answered'; promoted.answer = '批准'; promoted.options = ['批准', '拒绝'] }
    expect(JSON.stringify(restored).split(SAMPLE_LAUNCH_LOCAL_RISK_NOTE).join(SAMPLE_LAUNCH_RISK_NOTE)).toBe(JSON.stringify(previewLaunchThread))
    expect(sampleLaunchThread.messages.some(message => message.card?.approval?.riskNote === SAMPLE_LAUNCH_RISK_NOTE)).toBe(true)
    expect(withLocalDirVariant('topic', previewJobTopicThread)).toBe(previewJobTopicThread)
  })

  it('P81r1：localdir 入口的两张约定卡带着「已有文件夹」和「原来的位置」，其余入口不受影响', () => {
    const thread = previewLocalDirCardsThread()
    const cards = thread.messages.flatMap(message => message.agreement ?? [])
    expect(cards).toHaveLength(2)
    expect(cards[0]!.localDirLine).toBe(previewLocalDirFilesLine)
    expect(cards[0]!.localDirPrevLine ?? null).toBeNull()
    expect(cards[1]!.localDirLine).toBe(previewLocalDirFilesLine)
    expect(cards[1]!.localDirPrevLine).toBe(previewLocalDirPrevLine)
    expect(withLocalDirVariant('localdir', thread)).toBe(thread)
  })
})

describe('4 预览入口的数据能画出这两种提示（P81r1 第 3.8 节）', () => {
  // 说明：测试用的 hook 宿主只执行传进来的这一个组件，子组件不展开（见 helpers/hook-host.ts 开头），
  // 所以这里把预览线程里的卡片取出来，直接渲染卡片本身。
  it('?job=launch&local=1：发布审批卡渲染出带发布位置的提示句', () => {
    const variant = withLocalDirVariant('launch', previewLaunchThread)
    const card = variant.messages.flatMap(message => message.card ?? []).find(item => item.approval?.launch === true)
    if (card === undefined) throw new Error('launch 预览里没有发布审批卡')
    // 同样只渲染卡片里的审批块本身（测试宿主不展开子组件）。
    const parts = approvalPartsOf(card)!
    const text = textOf(createHookHost().render(ApprovalBlock, { approval: parts, idBase: 'p81preview' }))
    expect(text).toContain('本机临时文件夹、~/Desktop/活动报名页；可以联网')
    expect(text).toContain('按约定对外发布')
  })
  it('?job=localdir：两张约定卡渲染出「已有文件夹」与「原来的位置」', () => {
    const cards = previewLocalDirCardsThread().messages.flatMap(message => message.agreement ?? [])
    expect(cards).toHaveLength(2)
    const textOfCard = (card: AgreementCardView): string => textOf(createHookHost().render(AgreementCard, { card, startExpanded: true }))
    expect(textOfCard(cards[0]!)).toContain(previewLocalDirFilesLine)
    expect(textOfCard(cards[1]!)).toContain(previewLocalDirFilesLine)
    expect(textOfCard(cards[1]!)).toContain(previewLocalDirPrevLine)
  })
})
