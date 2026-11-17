/**
 * P74i 样例一致性测试（第一类）：本卡新增的样例视图全部通过 core 导出的 schema 校验；
 * 交付卡条目与样例约定的「怎样算做完」逐字相同；回执数字与样例记录一致；
 * 预览快照与实时生成的视图逐字相同；项目页一件事行与侧栏一句话由 core 的纯函数生成。
 */
import { describe, expect, it } from 'vitest'
import { JobCardViewSchema, ProjectJobRowSchema, TASK_STATUS_LABELS } from '@agent-hub/core'
import {
  SAMPLE_DONE_WHEN, SAMPLE_RECEIPT_EXPECTED, sampleDeliveryAwaitingCard, sampleDeliveryDoneCard, sampleDeliveryExpiredCard,
  sampleDeliveryExtraCards, sampleDeliveryRedeliveredCard, sampleDeliveryReturnedCard, sampleDeliveryStoppedCard,
  sampleDeliveryStatesThread, sampleDeliveryTopicThread, sampleEscalationCard, sampleEscalationOldCard, sampleEvidenceItems,
  sampleJobInboxEntries, sampleJobTopicThread, sampleProjectJobRows, sampleReceiptCard, sampleStopCard, sampleStopInboxEntry,
  sampleStopThread,
} from '../src/shared/fixture-job.js'
import { fixtureProject } from '../src/shared/fixture-project.js'

describe('样例一致性（P74i）', () => {
  it('交付卡、三轮不过卡、回执全部通过 core 的卡片 schema 校验', () => {
    for (const card of [
      sampleDeliveryAwaitingCard, sampleDeliveryDoneCard, sampleDeliveryReturnedCard, sampleDeliveryExpiredCard,
      sampleDeliveryRedeliveredCard, sampleDeliveryStoppedCard, sampleEscalationCard, sampleEscalationOldCard, sampleReceiptCard,
    ]) {
      expect(() => JobCardViewSchema.parse(card)).not.toThrow()
    }
  })

  it('交付卡条目与样例约定的「怎样算做完」逐字相同；交回、核对、交付共用同一份清单口径', () => {
    // 待你验收与已完成：全部六条逐条列出。
    for (const card of [sampleDeliveryAwaitingCard, sampleDeliveryDoneCard]) {
      for (const item of sampleEvidenceItems(card)) {
        expect(item.text).toBe(SAMPLE_DONE_WHEN[item.no - 1])
      }
      expect(sampleEvidenceItems(card)).toHaveLength(6)
    }
    // 未通过：只列被指出的条目（第 4 条，结论小章「你判不符」）。
    const returned = sampleEvidenceItems(sampleDeliveryReturnedCard)
    expect(returned.map(item => item.no)).toEqual([4])
    expect(returned[0]!.verdict.label).toBe('你判不符')
  })

  it('回执的数字与样例记录一致（时长、打扰次数、答掉的问题、核对、约定版本）', () => {
    expect(sampleReceiptCard.kind).toBe('receipt')
    if (sampleReceiptCard.kind !== 'receipt') throw new Error('应是回执')
    const byLabel = new Map(sampleReceiptCard.rows.map(row => [row.label, row.value]))
    expect(byLabel.get('从「定了」到验收')).toBe(SAMPLE_RECEIPT_EXPECTED.fromLockedToAccept)
    // P74i-m4（第 0 步）：核心 P74r11 把回执标签改为「需要你处理」「总管代你答复的问题」。
    expect(byLabel.get('需要你处理')).toBe(SAMPLE_RECEIPT_EXPECTED.disturbed)
    expect(byLabel.get('总管代你答复的问题')).toBe(SAMPLE_RECEIPT_EXPECTED.answered)
    expect(byLabel.get('核对')).toBe(SAMPLE_RECEIPT_EXPECTED.review)
    expect(byLabel.get('约定版本')).toBe(SAMPLE_RECEIPT_EXPECTED.versionNo)
  })

  it('三轮不过卡：新卡等你决定、办法带「选了实际会改什么」；旧卡只读、状态是「你选了 B」', () => {
    if (sampleEscalationCard.kind !== 'escalation' || sampleEscalationOldCard.kind !== 'escalation') throw new Error('应是三轮不过卡')
    expect(sampleEscalationCard.title).toBe('林舟无法继续')
    expect(sampleEscalationCard.stateText).toBe('等你决定')
    expect(sampleEscalationCard.chosen).toBeNull()
    expect(sampleEscalationCard.options).toHaveLength(3)
    expect(sampleEscalationCard.options[0]!.suggested).toBe(true)
    // 第二个办法带「改为」，第三个办法带「删去」：changeLine 由中心按办法里记下的改动生成。
    expect(sampleEscalationCard.options[1]!.changeLine).toBe('选了会把「怎样算做完」第 3 条改为：手机号少填一位时，允许提交，由后台补全。')
    expect(sampleEscalationCard.options[2]!.changeLine).toContain('选了会删去「怎样算做完」第 3 条')
    expect(sampleEscalationOldCard.stateText).toBe('你选了 B')
    expect(sampleEscalationOldCard.chosen).toBe('B')
  })

  it('「待你处理」四类条目样例的选项与 core 建条目时写死的形状逐项一致（P74r5 之后的新说法）', () => {
    const [accept, escalate, cap, stall] = sampleJobInboxEntries
    expect(accept!.options).toEqual(['验收通过'])
    expect(escalate!.options.every(option => /^[A-Z]　/.test(option))).toBe(true)
    // P74r5：「先停下」改「暂停」、「再叫一次」改「再提醒一次」。
    expect(cap!.options).toEqual(['再给 8 个回合', '暂停'])
    expect(stall!.options).toEqual(['再提醒一次', '暂停'])
    expect(stall!.title).toBe('活动报名页：没有进展')
    expect(stall!.body).toBe('已等评审员处理 2 天，中心已提醒两次，仍没有进展。')
    // P74i-m1（第二次）：四类条目带 jobEntry；说明条目另带完整的说明卡视图（escalationCard）。
    expect(accept!.jobEntry).toEqual({ kind: 'accept', jobId: 'job_sample0004' })
    expect(escalate!.jobEntry).toEqual({ kind: 'escalate', jobId: 'job_sample0006' })
    expect(cap!.jobEntry).toEqual({ kind: 'cap', jobId: 'job_sample0006' })
    expect(stall!.jobEntry).toEqual({ kind: 'stall', jobId: 'job_sample0006' })
    expect(escalate!.escalationCard).not.toBeNull()
    // 四类都没有期限。
    for (const item of sampleJobInboxEntries) expect(item.expiresText).toBeNull()
  })

  it('预览快照携带的其余几张交付卡与实时生成的视图逐字相同；项目页一件事行通过 core 的 schema', async () => {
    const { previewDeliveryExtraCards, previewProjectJobRows, previewChiefJobLine } = await import('../src/shared/fixture-job-preview.js')
    expect(JSON.stringify(previewDeliveryExtraCards)).toBe(JSON.stringify(sampleDeliveryExtraCards))
    expect(previewProjectJobRows).toEqual(sampleProjectJobRows)
    expect(previewChiefJobLine).toBe('2 件在办')
    for (const row of previewProjectJobRows) expect(() => ProjectJobRowSchema.parse(row)).not.toThrow()
    // 排序：待你验收、受阻在前，已完成沉底。
    expect(previewProjectJobRows.map(row => row.stateLabel)).toEqual(['待你验收', '受阻', '已完成'])
  })

  it('P74i-m1（走查 S-5）：项目页三件事的标题各不相同，不只靠状态区分', () => {
    expect(new Set(sampleProjectJobRows.map(row => row.title)).size).toBe(3)
  })

  it('P74i-m1（走查 E-8）：三轮不过卡的「试过什么」不带「第 N 次交回」前缀，也没有双句号', () => {
    if (sampleEscalationOldCard.kind !== 'escalation') throw new Error('应是三轮不过卡')
    // 旧卡（核对三轮不过）的「试过什么」由 core 按轮拼接，最能看出样例交回说明的写法。
    for (const line of sampleEscalationOldCard.tried) {
      expect(line).not.toContain('次交回：')
      expect(line).not.toContain('。。')
      expect(line.startsWith('第 ')).toBe(true)
    }
    // 拼出来的样子：轮号 + 交回说明 + 核对说明，各只有一个句号。
    expect(sampleEscalationOldCard.tried[0]).toBe('第 1 轮：提示文字照约定写的。提示文字是「手机号格式不正确」，与约定不一致。')
  })

  it('P74i-m1（走查 D-12）：交付主题里约定面板、进度行、交付卡三者一致', () => {
    const delivery = sampleDeliveryTopicThread
    // 约定面板：第 4 版已固定（与交付卡标题里的「按约定第 4 版」一致）。
    expect(delivery.agreement!.current.versionNo).toBe(4)
    expect(delivery.agreement!.current.stateLabel).toBe('已固定')
    // 进度行：待你验收（「你验收」是当前一步，发布未到），不是已完成。
    expect(delivery.progress!.stateLabel).toBe('待你验收')
    expect(delivery.progress!.steps.map(step => `${step.label}:${step.state}`)).toEqual(
      ['对齐:done', '执行:done', '核对:done', '你验收:current', '发布:todo'])
    // 交付卡：待你验收、按约定第 4 版。
    expect(sampleDeliveryAwaitingCard.kind).toBe('delivery')
    if (sampleDeliveryAwaitingCard.kind !== 'delivery') throw new Error('应是交付卡')
    expect(sampleDeliveryAwaitingCard.stateText).toBe('待你验收')
    expect(sampleDeliveryAwaitingCard.title).toBe('活动报名页　按约定第 4 版')
  })

  it('P74i-m1（第 3 节第 1 条，走查 D-8）：交付各种状态的走查主题里六张卡都由 core 视图生成、通过 schema', () => {
    const cards = sampleDeliveryStatesThread.messages.filter(m => m.jobCard !== null && m.jobCard !== undefined).map(m => m.jobCard!)
    for (const card of cards) expect(card.kind).toBe('delivery')
    expect(cards.map(card => card.kind === 'delivery' ? card.stateText : '')).toEqual([
      '已完成　11月17日 18:05', '未通过：第 4 条', '已失效：约定已更新', '已失效：已重新交付', '已失效：这件事已停止', '待你验收',
    ])
    for (const card of cards) expect(() => JobCardViewSchema.parse(card)).not.toThrow()
    // 等约定确认那张：提示写「约定第 2 版在等你确认，确认后再验收。」，不能验收但能打开预览（三种返回之一）。
    const pending = cards.at(-1)!
    if (pending.kind !== 'delivery') throw new Error('应是交付卡')
    expect(pending.actions.accept).toBe(false)
    expect(pending.actions.hint).toBe('约定第 2 版在等你确认，确认后再验收。')
  })

  it('P74i-m1（第 3 节第 3 条，走查 I-6）：带停止标记的约定卡与它的待你处理条目', () => {
    expect(sampleStopCard).not.toBeNull()
    // 卡最上面的 stopLine 一行由 core 生成（stopsJob 换算；core 未把 STOP_LINE 导出给插件，按原文断言），不带两栏。
    expect(sampleStopCard!.stopLine).toBe('确认后这件事停止，已经做出来的东西保留在项目文件夹里。')
    expect(sampleStopCard!.jobSplit).toBeNull()
    expect(sampleStopCard!.canConfirm).toBe(true)
    // 待你处理里的那一条带同一个约定 id，说明那句由界面按 stopLine 换上（文字不在样例里写死）。
    expect(sampleStopInboxEntry.agreementId).toBe(sampleStopCard!.agreementId)
    expect(sampleStopThread.messages.at(-1)!.kind).toBe('agreement')
  })

  it('P74i-m1（走查 S-4）：样例项目旧事务的状态词来自核心的对照表', () => {
    expect(TASK_STATUS_LABELS).toEqual({
      todo: '待开工', doing: '执行中', blocked: '受阻',
      done_pending_check: '待你验收', accepted: '已完成', rejected: '返工中',
    })
    for (const row of fixtureProject.projects) {
      for (const task of row.tasks) expect(task.statusLabel).toBe(TASK_STATUS_LABELS[task.task.status])
    }
  })

  it('P74i-m1：新增样例的预览快照与实时生成的视图逐字相同（交付各种状态、停止标记、四类条目）', async () => {
    const { previewDeliveryStatesThread, previewJobInboxEntries, previewStopInboxEntry, previewStopThread } = await import('../src/shared/fixture-job-preview.js')
    expect(JSON.stringify(previewDeliveryStatesThread)).toBe(JSON.stringify(sampleDeliveryStatesThread))
    expect(JSON.stringify(previewStopThread)).toBe(JSON.stringify(sampleStopThread))
    expect(JSON.stringify(previewJobInboxEntries)).toBe(JSON.stringify(sampleJobInboxEntries))
    expect(JSON.stringify(previewStopInboxEntry)).toBe(JSON.stringify(sampleStopInboxEntry))
    // 既有入口（场景 A）的快照仍钉住，防止重新生成时漏掉。
    expect(() => JobCardViewSchema.parse(sampleJobTopicThread.messages.find(m => m.jobCard)?.jobCard)).not.toThrow()
  })
})
