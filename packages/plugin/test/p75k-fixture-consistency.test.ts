/**
 * P75k 一致性测试（第一块的教训，与 P75j 同一做法）：样例必须由 core 的视图生成，并通过 core 导出的 schema；
 * 手写的样例与真实数据的约定不一致时，预览和测试都发现不了，所以补上这一层：
 * 1. 记忆页、线程里的「已记住」行、复盘主题的卡片都通过 core 导出的 schema（core 生成视图时自己也校验过一遍）；
 * 2. 与设计稿 D、E、A、B 的数据一致（规矩、先例、偏好、项目背景各自的条目，三种行，复盘组的卡片顺序）；
 * 3. fixture-memory.ts、fixture-retro.ts 的源码里没有手写的视图字段；
 * 4. 预览快照（fixture-memory-preview.ts、fixture-retro-preview.ts）与实时生成的视图逐字相同；
 * 5. 离线样例门面（FixtureHub）：记忆页、总览条数、总管线程里的行、五个命令都走 core 的界面接口真的改内存记录；
 * 6. 「教它技能」的界面已删除；三个技能类拦截原因在 core 里有中文文字。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JobCardViewSchema, MemoryNoteViewSchema, MemoryPageViewSchema, SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS } from '@agent-hub/core'
import { FixtureHub } from '../src/host/hub-facade.js'
import { createMemorySample, sampleMemoryPage, sampleMemoryThread, SAMPLE_MEMORY_IDS, SAMPLE_MEMORY_MESSAGE_IDS } from '../src/shared/fixture-memory.js'
import { previewMemoryNotes, previewMemoryPage } from '../src/shared/fixture-memory-preview.js'
import { sampleRetroTopicThread } from '../src/shared/fixture-retro.js'
import { previewRetroTopicThread } from '../src/shared/fixture-retro-preview.js'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')
const sample = createMemorySample()
const page = sampleMemoryPage(sample)
const memoryThread = sampleMemoryThread(sample)
const retroThread = sampleRetroTopicThread()

describe('样例视图由 core 生成并通过 core 的 schema', () => {
  it('记忆页、线程里的三条「已记住」类行、复盘主题里的全部卡片都通过 core 导出的 schema', () => {
    expect(() => MemoryPageViewSchema.parse(page)).not.toThrow()
    const notes = memoryThread.messages.flatMap(message => message.memoryNotes ?? [])
    expect(notes).toHaveLength(3)
    for (const note of notes) expect(() => MemoryNoteViewSchema.parse(note)).not.toThrow()
    const cards = retroThread.messages.flatMap(message => message.jobCard === undefined || message.jobCard === null ? [] : [message.jobCard])
    expect(cards.length).toBeGreaterThanOrEqual(6)
    for (const card of cards) expect(() => JobCardViewSchema.parse(card)).not.toThrow()
  })

  it('记忆页与设计稿 E 一致：四类条目、固定规则、被引用次数、原为、24 小时内删除的一条', () => {
    expect(page.title).toBe('关于你的记忆')
    expect(page.tabs.map(tab => [tab.key, tab.count])).toEqual([['all', 13], ['preference', 3], ['rule', 6], ['precedent', 2], ['background', 2]])
    const rule = page.groups.find(group => group.key === 'rule')!.entries
    expect(rule[0]).toMatchObject({ text: '页面提示文字以「请」字开头。', sourceLine: '你在总管私聊里说的，11月18日', scopeLine: '用于全部员工、全部项目', citedText: '被引用 2 次' })
    expect(rule[1]!.historyNote).toMatch(/^原为「汇报先给结论」。/)
    // 固定规则 4 条排在最后，不能更正或删除。
    const fixed = rule.filter(entry => entry.memoryId === null)
    expect(fixed).toHaveLength(4)
    expect(fixed.every(entry => !entry.actions.correct && !entry.actions.delete && entry.readonlyNote === '不能更正或删除')).toBe(true)
    const precedent = page.groups.find(group => group.key === 'precedent')!.entries
    expect(precedent[0]!.sourceLine).toBe('先例：活动报名页约定第 2 版，你于 11月11日 定了')
    const background = page.groups.find(group => group.key === 'background')!.entries
    expect(background[0]).toMatchObject({ text: 'AI 产品沙龙，11月20日 14:00，望京 SOHO T3 12 层，限 80 人', readonlyNote: '在项目页里修改' })
    expect(background.every(entry => entry.link !== null)).toBe(true)
    expect(page.deleted).toEqual([{ memoryId: SAMPLE_MEMORY_IDS.deleted, text: '已删除「回复里加表情」。', canUndo: true }])
  })

  it('三种行：已记住（规矩）、已更正、已删除；撤销之后 core 把这一行改成已撤销、不再可撤销', async () => {
    const byMessage = (id: string) => memoryThread.messages.find(message => message.id === id)!.memoryNotes!
    expect(byMessage(SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)[0]).toMatchObject({ action: 'noted', kindLabel: '规矩', state: 'active', canUndo: true })
    expect(byMessage(SAMPLE_MEMORY_MESSAGE_IDS.correctReply)[0]).toMatchObject({ action: 'corrected', text: '汇报先给结论，再说原因。', canUndo: true })
    expect(byMessage(SAMPLE_MEMORY_MESSAGE_IDS.forgetReply)[0]).toMatchObject({ action: 'deleted', text: '回复里加表情。', state: 'deleted', canUndo: true })
    const world = createMemorySample()
    expect((await world.api.undoMemory({ memoryId: SAMPLE_MEMORY_IDS.rulePlease })).ok).toBe(true)
    const after = sampleMemoryThread(world).messages.find(message => message.id === SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)!.memoryNotes![0]!
    expect(after).toMatchObject({ state: 'undone', canUndo: false })
  })

  it('复盘主题与设计稿 A、B 一致：折叠组带「复盘」，卡片顺序是复盘、复盘、核对、核对、改写、核对，最后是小结', () => {
    const fold = retroThread.floors!.items.find(item => item.kind === 'fold')!
    if (fold.kind !== 'fold') throw new Error('没有折叠组')
    expect(fold.label).toBe('复盘')
    expect(fold.count).toBe(7)
    expect(fold.participants).toEqual(['林舟', '评审员', '总管'])
    const order = fold.messages.map(entry => entry.message.refId!.split(':')[0]!.split('#')[0]!)
    expect(order).toEqual(['retro', 'retro', 'skillcheck', 'skillcheck', 'retro', 'skillcheck', 'retro-summary'])
    const retro = retroThread.messages.find(message => message.jobCard?.kind === 'retro')!.jobCard!
    if (retro.kind !== 'retro') throw new Error('不是复盘卡')
    expect(retro.countsText).toBe('出处 3 条　技能更新 1 条')
    expect(retro.rows.map(row => row.sourceKindText)).toEqual(['评审意见', '你的纠正', '验收结果'])
    const checks = retroThread.messages.flatMap(message => message.jobCard?.kind === 'skill_check' ? [message.jobCard.stateText] : [])
    expect(checks).toEqual(['已写入', '等待改写', '已写入'])
  })
})

describe('样例源码没有手写的视图字段，预览快照与实时视图逐字相同', () => {
  it('fixture-memory.ts、fixture-retro.ts 只写记录，不手写视图字段', () => {
    for (const file of ['shared/fixture-memory.ts', 'shared/fixture-retro.ts']) {
      const text = read(file).split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
      for (const field of ['sourceLine', 'quoteLine', 'scopeLine', 'historyNote', 'citedText', 'readonlyNote', 'countsText', 'stateText', 'basisLabel', 'canUndo']) {
        expect(text, `${file} 里不应手写 ${field}`).not.toContain(field)
      }
    }
  })

  it('快照与实时生成的视图逐字相同（core 改了视图，这里会报出来）', () => {
    expect(JSON.stringify(previewMemoryPage)).toBe(JSON.stringify(page))
    const live = Object.fromEntries(memoryThread.messages.filter(message => message.memoryNotes !== undefined).map(message => [message.id, message.memoryNotes]))
    expect(JSON.stringify(previewMemoryNotes)).toBe(JSON.stringify(live))
    expect(JSON.stringify(previewRetroTopicThread)).toBe(JSON.stringify(retroThread))
  })
})

describe('离线样例门面 FixtureHub 的记忆', () => {
  it('记忆页、总览条数、总管线程里的三行都来自样例记忆世界；条数与记忆页 total 一致', async () => {
    const hub = new FixtureHub()
    expect(JSON.stringify(await hub.memoryPage())).toBe(JSON.stringify(page))
    expect((await hub.overview()).memoryCount).toBe(page.total)
    const thread = await hub.thread('bot-zongguan', { limit: 100 })
    const notes = thread.messages.filter(message => message.memoryNotes !== undefined)
    expect(notes.map(message => message.memoryNotes![0]!.action)).toEqual(['noted', 'corrected', 'deleted'])
    expect(notes[0]!.thread).toBe('bot-zongguan')
    expect(notes[0]!.from).toBe('bot-zongguan')
  })

  it('五个命令真的改内存记录并发 memory、总管线程、总览三个事件；错误是中文', async () => {
    const hub = new FixtureHub()
    const events: string[] = []
    hub.subscribe(event => events.push(event.scope))
    expect((await hub.command('correctMemory', { memoryId: SAMPLE_MEMORY_IDS.prefShort, text: '汇报控制在两句话以内。' })).ok).toBe(true)
    expect(events).toEqual(['memory', 'thread', 'overview'])
    const entry = (await hub.memoryPage()).groups.flatMap(group => group.entries).find(row => row.memoryId === SAMPLE_MEMORY_IDS.prefShort)!
    expect(entry.text).toBe('汇报控制在两句话以内。')
    expect(entry.historyNote).toBe('原为「汇报控制在三句话以内」。')
    expect((await hub.command('deleteMemory', { memoryId: SAMPLE_MEMORY_IDS.prefShort })).ok).toBe(true)
    const afterDelete = await hub.memoryPage()
    expect(afterDelete.deleted.map(row => row.memoryId)).toContain(SAMPLE_MEMORY_IDS.prefShort)
    expect((await hub.overview()).memoryCount).toBe(page.total - 1)
    expect((await hub.command('undoDeleteMemory', { memoryId: SAMPLE_MEMORY_IDS.prefShort })).ok).toBe(true)
    expect((await hub.command('undoCorrectMemory', { memoryId: SAMPLE_MEMORY_IDS.prefShort })).ok).toBe(true)
    expect((await hub.command('undoMemory', { memoryId: SAMPLE_MEMORY_IDS.rulePlease })).ok).toBe(true)
    const rejected = await hub.command('undoMemory', { memoryId: SAMPLE_MEMORY_IDS.rulePlease })
    expect(rejected).toEqual({ ok: false, error: '这一条已经撤销或删除了' })
    expect(await hub.command('correctMemory', { memoryId: SAMPLE_MEMORY_IDS.prefTime })).toEqual({ ok: false, error: 'text：缺少这一项' })
    expect(await hub.command('chooseLearnSession', {})).toEqual({ ok: false, error: 'runId：缺少这一项' })
    expect((await hub.command('chooseLearnSession', { runId: 'sr_samplelearn', option: '周会记录整理' })).ok).toBe(true)
  })
})

/** 取 src 下全部文件的路径。 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('「教它技能」的界面已删除', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url))
  const sources = walk(root).map(path => ({ path: path.replace(root, ''), text: readFileSync(path, 'utf8') }))

  it('源码里不再有教学弹窗的组件名、onTeach 属性、最近会话的刷新、teachOpen 状态与 hub.command(teach)', () => {
    for (const word of ['TeachDialog', 'onTeach', 'refreshRecentSessions', 'teachOpen']) {
      expect(sources.filter(row => row.text.includes(word)).map(row => row.path), word).toEqual([])
    }
    // 宿主里保留的是 P75f 的停用说明（门面里的 teach 分支），界面不再发它。
    const clientCallers = sources.filter(row => row.path.startsWith('/client') && /command\(\s*'teach'/.test(row.text))
    expect(clientCallers).toEqual([])
  })

  it('线程「更多」菜单的源码里没有「教它技能」，只留打开工作会话、暂停或恢复等', () => {
    const thread = sources.find(row => row.path === '/client/components/ThreadPane.tsx')!.text
    expect(thread.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')).not.toContain('教它技能')
    expect(thread).toContain('打开工作会话')
  })
})

describe('拦截原因的中文文字', () => {
  it('core 的对照表里 20 个原因码都有中文文字，不出现英文代码（含新增的 skill_stale）', () => {
    expect(SUPPRESSION_REASONS).toHaveLength(20)
    for (const code of SUPPRESSION_REASONS) {
      const text = SUPPRESSION_REASON_LABELS[code]
      expect(text, code).toMatch(/[一-鿿]/)
      expect(text, code).not.toMatch(/[a-z]+_[a-z_]+/)
    }
    expect(SUPPRESSION_REASON_LABELS.skill_stale).toBe('这次记录里已没有这位员工要做的事，不再进行')
  })

  it('既有规则：界面不自己抄拦截原因的文字表（所以本卡没有在插件里补三项，差异写进 docs/questions.md）', () => {
    const client = walk(fileURLToPath(new URL('../src/client', import.meta.url))).map(path => readFileSync(path, 'utf8')).join('\n')
    expect(client).not.toMatch(/skill_cap|skill_daily_cap|skill_expired|skill_stale/)
  })
})
