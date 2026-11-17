/**
 * P74h 样例一致性测试：fixture-job.ts 生成的视图必须通过 core 导出的视图 schema 校验，
 * 证据清单的条目原文与样例约定的「怎样算做完」逐字相同，进度行的状态词只出现九个词之一。
 * 这是第一块教训的落地：样例与真实数据由同一批视图函数生成，才不会各说各话。
 */
import { describe, expect, it } from 'vitest'
import {
  JobCardViewSchema, JobProgressViewSchema, TopicFloorsViewSchema,
} from '@agent-hub/core'
import {
  SAMPLE_DONE_WHEN, sampleAskCard, sampleAskThread, sampleB2Card, sampleB2Thread, sampleEvidenceItems, sampleJobTopicThread,
  sampleReviewPassCard, sampleReviewReturnCard, sampleReviewTopicThread, sampleSubmissionCard,
} from '../src/shared/fixture-job.js'

/** 进度行的九个状态词（设计稿附表：「对齐中」由视图从约定状态推出，也是九个之一）。 */
const STATE_WORDS = ['对齐中', '待开工', '执行中', '核对中', '返工中', '待你验收', '受阻', '已完成', '已停止']

describe('样例一致性（P74h）', () => {
  it('主题线程的进度行与楼层分组通过 core 的视图 schema 校验', () => {
    expect(sampleJobTopicThread.progress).not.toBeNull()
    expect(() => JobProgressViewSchema.parse(sampleJobTopicThread.progress)).not.toThrow()
    expect(() => TopicFloorsViewSchema.parse(sampleJobTopicThread.floors)).not.toThrow()
  })

  it('三张卡片（交回、退回、通过）通过 core 的卡片 schema 校验', () => {
    for (const card of [sampleSubmissionCard, sampleReviewReturnCard, sampleReviewPassCard]) {
      expect(() => JobCardViewSchema.parse(card)).not.toThrow()
    }
  })

  it('证据清单的条目原文与样例约定的「怎样算做完」逐字相同', () => {
    for (const card of [sampleSubmissionCard, sampleReviewReturnCard, sampleReviewPassCard]) {
      for (const item of sampleEvidenceItems(card)) {
        expect(item.text).toBe(SAMPLE_DONE_WHEN[item.no - 1])
      }
    }
    // 三张卡片合起来覆盖全部六条：交回与退回逐条，通过卡只列本轮条目（第 3 条）。
    expect(sampleEvidenceItems(sampleSubmissionCard)).toHaveLength(6)
    expect(sampleEvidenceItems(sampleReviewReturnCard)).toHaveLength(6)
    expect(sampleEvidenceItems(sampleReviewPassCard).map(item => item.no)).toEqual([3])
  })

  it('进度行的状态词只出现九个词之一', () => {
    expect(STATE_WORDS).toContain(sampleJobTopicThread.progress!.stateLabel)
    // 样例停在核对中：五步（有发布步骤）、第 1 轮、在等评审员。
    expect(sampleJobTopicThread.progress!.steps.map(step => step.label)).toEqual(['对齐', '执行', '核对', '你验收', '发布'])
    expect(sampleJobTopicThread.progress!.roundText).toBe('第 1 轮，共 3 轮')
    expect(sampleJobTopicThread.progress!.waitingOn).toBe('评审员')
    expect(sampleJobTopicThread.progress!.dueText).toBe('11月17日 18:00 前')
  })

  it('B2 的约定卡带两栏、交付时间、退路；来源是主人的材料、没有起因一行（P74h-m1 改回）', () => {
    expect(sampleB2Card).not.toBeNull()
    expect(sampleB2Card!.jobSplit).toEqual({
      continuing: ['页面排版与活动信息', '手机号校验', '提交成功页', '报名名单表格'],
      paused: ['名额计数与「名额已满」'],
      dueText: '交付时间不变：11月17日 18:00 前',
      fallback: '如果「限 80 人」只是文案说法、页面不需要限制，回复「不限」，我保留第 3 版。',
    })
    // P74h-m1 第 5 处：B2 的第 4 版由主人发来的活动文案引起（你在总管私聊里的指示），没有起因一行。
    expect(sampleB2Card!.originLine).toBeNull()
    expect(sampleB2Card!.sourceLabel).toBe('来源：你在总管私聊里的指示')
    // 主题样例的当前版本是普通来源：没有起因一行（为 null 时卡片与原来一样）。
    expect(sampleJobTopicThread.agreement!.current.originLine).toBeNull()
  })

  it('提问样例（P74h-m1）的约定卡带「来源」「起因」两行，与总管那句话说的是同一件事', () => {
    expect(sampleAskCard).not.toBeNull()
    expect(sampleAskCard!.sourceLabel).toBe('来源：执行中的提问，约定里没有写')
    expect(sampleAskCard!.originLine).toBe('起因：林舟在做这件事时问「同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？」，约定里没有写。')
    // 私聊里总管那句话原样转述了提问，与卡上的来源和起因相符。
    expect(sampleAskThread.messages.some(message => message.text.includes('林舟在做这件事时问') && message.text.includes('约定里没有写'))).toBe(true)
    // 卡同样带两栏（重复提交的处理暂停，其余照常）。
    expect(sampleAskCard!.jobSplit!.paused).toEqual(['重复提交时名单覆盖'])
  })

  it('场景 C 的走查主题（P74h-m1）：两张交回卡与两张核对卡都排进工作往来折叠组', () => {
    const floors = sampleReviewTopicThread.floors!
    expect(floors.items.map(item => item.kind)).toEqual(['floor', 'floor', 'fold'])
    const fold = floors.items[2]!
    if (fold.kind !== 'fold') throw new Error('第三项应是折叠组')
    // P74i-m6（第 1 节第 1 条）：组里多了一条中心的工作往来（回合被中心结束的那一句），原来 6 条、现在 7 条。
    expect(fold.count).toBe(7)
    expect(fold.participants).toEqual(['林舟', '评审员'])
    // 四张卡片按时间顺序都在线程里，视图由 core 生成：交回、核对（不通过）、交回、核对（通过）。
    const cards = sampleReviewTopicThread.messages.filter(message => message.jobCard !== null && message.jobCard !== undefined).map(message => message.jobCard!)
    expect(cards.map(card => card.kind)).toEqual(['submission', 'review', 'submission', 'review'])
    const returnCard = cards[1]!
    const passCard = cards[3]!
    if (returnCard.kind !== 'review' || passCard.kind !== 'review') throw new Error('第 2、4 张应是核对卡')
    expect(returnCard.roundText).toBe('剩余 2 轮')
    expect(returnCard.title).toBe('第 1 轮　不通过：1 条不符')
    expect(passCard.stateText).toBe('已通过')
    expect(passCard.title).toBe('第 2 轮　通过：6 条均符合')
    // 两张交回卡与两张核对卡都进折叠组：组内消息数与卡片数对得上。
    expect(fold.messages.filter(entry => entry.message.kind === 'job_card')).toHaveLength(4)
  })

  it('楼层分组照设计稿：楼层与两组工作往来交替，总数行写清收起多少条', () => {
    const floors = sampleJobTopicThread.floors!
    expect(floors.countText).toBe('共 9 条记录：给你的 3 条，员工之间的往来 6 条（已收起）')
    expect(floors.items.map(item => item.kind)).toEqual(['floor', 'floor', 'fold', 'floor', 'fold'])
    const first = floors.items[2]!
    if (first.kind !== 'fold') throw new Error('第三项应是折叠组')
    expect(first.participants).toEqual(['林舟', '总管'])
    expect(first.count).toBe(4)
    expect(first.rangeText).toBe('11月11日至12日')
    expect(first.latest).toBe('总管按约定答复了林舟 1 个问题，不需要你处理。')
    const second = floors.items[4]!
    if (second.kind !== 'fold') throw new Error('最后一项应是折叠组')
    expect(second.latest).toBe('林舟交回第 1 轮，5 条附证据，1 条交付时核对；评审员正在核对。')
    expect(second.messages[0]!.fromName).toBe('林舟')
  })

  it('私聊样例的最后一条是待确认的约定卡，前一条是总管的说明', () => {
    expect(sampleB2Thread.messages).toHaveLength(4)
    const last = sampleB2Thread.messages.at(-1)!
    expect(last.kind).toBe('agreement')
    expect(last.agreement?.canConfirm).toBe(true)
  })

  it('预览快照与实时生成的视图逐字相同（预览不会悄悄用旧口径）', async () => {
    const { previewAskThread, previewB2Thread, previewDeliveryTopicThread, previewEscalationThread, previewJobTopicThread, previewReviewTopicThread } = await import('../src/shared/fixture-job-preview.js')
    expect(JSON.stringify(previewJobTopicThread)).toBe(JSON.stringify(sampleJobTopicThread))
    expect(JSON.stringify(previewB2Thread)).toBe(JSON.stringify(sampleB2Thread))
    expect(JSON.stringify(previewAskThread)).toBe(JSON.stringify(sampleAskThread))
    expect(JSON.stringify(previewReviewTopicThread)).toBe(JSON.stringify(sampleReviewTopicThread))
    // P74i 的两个新入口（场景 D 的交付与回执、场景 E 的三轮不过卡）同样钉住。
    const { sampleDeliveryTopicThread: delivery, sampleEscalationThread: escalation } = await import('../src/shared/fixture-job.js')
    expect(JSON.stringify(previewDeliveryTopicThread)).toBe(JSON.stringify(delivery))
    expect(JSON.stringify(previewEscalationThread)).toBe(JSON.stringify(escalation))
  })
})
