/**
 * F06 客户端验收契约：词表与 core 一致，分类答案保留原意经过统一收件箱入口。
 * 普通问题不被误标成验收，历史卡片缺少新字段时仍可以按原方式作答。
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_CHECK_LABELS as CORE_ARTIFACTS, RESULT_VERDICT_LABELS as CORE_VERDICTS } from '@agent-hub/core'
import { ARTIFACT_CHECK_LABELS, RESULT_VERDICT_LABELS } from '../src/shared/result-check-labels.js'
import { cardSubmission, type CardPayload } from '../src/client/logic/cards.js'

const card: CardPayload = { inboxId: 'i_1', approvalId: null, goalId: 'g_1', type: 'question', status: 'open',
  title: '结果请验收', body: '完成标准与中心实查', options: ['通过', '未通过'], defaultOption: '未通过', answer: null, expiresText: null }

describe('F06 验收卡', () => {
  it('中文词表与 core 一致（mismatch 例外：界面按系统型写「不符预期」，提交时映射回 core 协议值）', () => {
    expect(ARTIFACT_CHECK_LABELS).toEqual(CORE_ARTIFACTS)
    // 除 mismatch 外逐项相同，避免「没做」「做错」在两侧被解释成不同结论。
    const { mismatch: _coreMismatch, ...coreRest } = CORE_VERDICTS
    const { mismatch: _uiMismatch, ...uiRest } = RESULT_VERDICT_LABELS
    expect(uiRest).toEqual(coreRest)
    expect(RESULT_VERDICT_LABELS.mismatch).toBe('不符预期')
    expect(CORE_VERDICTS.mismatch).toBe('不是你要的')
  })
  it.each(['没做', '做错', '不是你要的'])('失败类型 %s 原样交回队友', answer => {
    expect(cardSubmission(card, answer)).toEqual({ name: 'answerInbox', input: { id: 'i_1', answer } })
  })
  it('旧卡片没有新字段时仍走原有回答入口', () => {
    const { goalId: _, ...legacy } = card
    expect(cardSubmission(legacy, '未通过')).toEqual({ name: 'answerInbox', input: { id: 'i_1', answer: '未通过' } })
  })
})
