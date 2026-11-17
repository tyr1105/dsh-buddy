/**
 * 样例复盘数据（P75k，样例数据模式专用）：照设计稿场景 A（做完之后的复盘）与场景 B（技能更新的核对）造样例，
 * 让离线走查和测试能看到：主题里的「复盘」折叠组（组标题带「复盘」）、林舟的复盘卡与评审员的复盘卡、
 * 技能核对卡的三种状态（已写入、等待改写、改写后已写入）、改写卡、复盘小结。
 *
 * 做法（第一块的教训，与 fixture-job.ts、fixture-skill.ts 相同）：这个文件只写「记录」，视图一律由 core 的视图函数生成：
 * 在「一件事」样例的 core 环境（fixture-job.ts 的 seededContext：员工、约定、事、交回、核对都已种好）之上，
 * 再种进复盘记录（复盘、出处、技能、技能更新、同类任务记录）和主题里的线程消息，然后走 core 对外的 thread 视图
 * （createUiApi().thread）取回楼层与折叠分组，复盘卡与核对卡的内容也就由 core 的卡片函数生成。
 * 不手写任何视图字段：卡片上的出处一行、去向、底部一句、三项检查、改写说明都是 core 的写法，core 改了口径样例会跟着变。
 *
 * 与设计稿场景 A、B 的数据一致：林舟三条出处（评审意见第 1 轮退回第 3 条、你的纠正第 4 条、验收结果）、一条合并更新；
 * 评审员一条出处（你的纠正）、一条新建技能的更新，由总管核对（先判不符、改写、再通过）。
 * 样例文字不进文案登记表（见 docs/copy/strings.md「不登记」一条）；core 生成的句子登记在 RTR- 前缀下，
 * 携带处是 shared/fixture-retro-preview.ts（视图快照）。
 */
import { createUiApi } from '@agent-hub/core'
import type { ThreadView } from './views.js'
import {
  SAMPLE_CHIEF_ID, SAMPLE_EXECUTOR_ID, SAMPLE_JOB_ID, SAMPLE_REVIEWER_ID, SAMPLE_REVIEW_1_ID, SAMPLE_JOB_TIMEZONE, seededContext,
} from './fixture-job.js'

/** 复盘样例所在的主题与那一次复盘的固定编号。 */
export const SAMPLE_RETRO_TOPIC_ID = 'ptp_samprtr001'
export const SAMPLE_RETRO_RUN_ID = 'sr_samprtr001'
export const SAMPLE_RETRO_UPDATE_IDS = { form: 'su_samprtr001', checklist: 'su_samprtr002' } as const

/** 一个北京时间的时刻（样例都落在 11月17日 验收通过之后）。 */
const at = (time: string): number => Date.parse(`2026-11-17T${time}:00+08:00`)

/** 一条出处记录：默认字段加变化的几项。 */
function source(serial: string, botId: string, kind: 'review' | 'owner_correction' | 'acceptance', label: string, quote: string,
  refs: Record<string, unknown>, time: string) {
  return {
    id: `ss_samprtr${serial}`, botId, kind, label, quote, relayed: false, jobId: SAMPLE_JOB_ID, category: '表单页', refs, createdAt: at(time),
  }
}

const SOURCES = [
  // 林舟的三条：评审意见（第 1 轮退回第 3 条）、你的纠正（验收时指出第 4 条）、验收结果。
  source('001', SAMPLE_EXECUTOR_ID, 'review', '第 1 轮退回第 3 条', '提示文字是「手机号格式不正确」，与约定不一致。', { reviewId: SAMPLE_REVIEW_1_ID, itemNo: 3 }, '15:20'),
  source('002', SAMPLE_EXECUTOR_ID, 'owner_correction', '验收第 4 条', '我填了公司名，名单里那一列是空的。', { itemNo: 4 }, '15:20'),
  source('003', SAMPLE_EXECUTOR_ID, 'acceptance', '验收通过', '核对 2 轮，验收返工 1 次，共 14 个回合。', {}, '15:20'),
  // 评审员的一条：你的纠正——主人对评审员说的话（P75r7：原文改成主人说的话，去掉重复的「验收时指出第 4 条」）。
  source('004', SAMPLE_REVIEWER_ID, 'owner_correction', '验收第 4 条', '第 4 条你判了「符合」，可我填了公司名，名单里那一列是空的。', { itemNo: 4 }, '15:20'),
]

/** 一句技能：正文与出处编号。 */
const sentence = (text: string, sourceSerial: string) => ({ text, sourceIds: [`ss_samprtr${sourceSerial}`] })

const FORM_SENTENCES = [
  sentence('页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。', '001'),
  sentence('自测数据要覆盖选填项填写和不填两种情况。', '002'),
]
const CHECKLIST_SENTENCE = sentence('名单类条目，选填项填写与不填各提交一条，再核对名单。', '004')
/** 评审员第一次提交时多写了一句没有出处的颜色和位置（核对判不符，退回改写）。 */
const CHECKLIST_FIRST = sentence('名单类条目，选填项填写与不填各提交一条，再核对名单；统一用红色字，放在输入框正下方。', '004')

/** 一次核对：三项结论加说明；sentences 是当时核对的句子。 */
function check(checkerId: string, time: string, withinScope: 'met' | 'unmet', note: string | null, sentences: ReturnType<typeof sentence>[]) {
  return { at: at(time), checkerId, exists: 'met', consistent: 'met', withinScope, note, sentences }
}

const RUN = {
  id: SAMPLE_RETRO_RUN_ID, kind: 'retro', jobId: SAMPLE_JOB_ID, category: '表单页',
  participants: [
    { botId: SAMPLE_EXECUTOR_ID, role: 'executor', sourceIds: ['ss_samprtr001', 'ss_samprtr002', 'ss_samprtr003'], state: 'done', reason: null },
    { botId: SAMPLE_REVIEWER_ID, role: 'reviewer', sourceIds: ['ss_samprtr004'], state: 'done', reason: null },
  ],
  turnsUsed: 4, turnCap: 6, tokens: 0, summaryPostedAt: at('15:44'), createdAt: at('15:20'), endedAt: at('15:44'),
}

/** 林舟的技能（表单页做法，第 2 版是这次写入的）与评审员这次新建的技能（第 1 版）。 */
function skill(id: string, botId: string, title: string, whenToUse: string, dir: string, versionNo: number) {
  return {
    id, botId, title, whenToUse, supplements: null, dirName: `self-${dir}`, state: 'active', collapseReason: null, currentVersionNo: versionNo,
    categories: ['表单页'], lastUsedAt: null, legacy: null, collapsedAt: null, createdAt: at('15:20'), updatedAt: at('15:36'),
  }
}
const SKILLS = [
  skill('sk_samprtr001', SAMPLE_EXECUTOR_ID, '表单页做法', '做报名、预约这类带表单的页面时', 'retro001', 2),
  skill('sk_samprtr002', SAMPLE_REVIEWER_ID, '表单类交付核对', '核对带表单的页面时', 'retro002', 1),
]

/** 两条技能更新：林舟的合并成一次（评审员核对一次通过）；评审员的新建技能（总管核对，先判不符，改写后通过）。 */
const UPDATES = [
  {
    id: SAMPLE_RETRO_UPDATE_IDS.form, botId: SAMPLE_EXECUTOR_ID, runId: SAMPLE_RETRO_RUN_ID, kind: 'learn', skillId: 'sk_samprtr001', newSkill: null,
    mergeFromIds: [], sentences: FORM_SENTENCES, checkerId: SAMPLE_REVIEWER_ID, state: 'passed',
    checks: [check(SAMPLE_REVIEWER_ID, '15:32', 'met', null, FORM_SENTENCES)], rewrites: 0, versionNo: 2, createdAt: at('15:24'), updatedAt: at('15:32'),
  },
  {
    id: SAMPLE_RETRO_UPDATE_IDS.checklist, botId: SAMPLE_REVIEWER_ID, runId: SAMPLE_RETRO_RUN_ID, kind: 'learn', skillId: null,
    newSkill: { title: '表单类交付核对', whenToUse: '核对带表单的页面时', supplements: null },
    mergeFromIds: [], sentences: [CHECKLIST_SENTENCE], checkerId: SAMPLE_CHIEF_ID, state: 'passed',
    checks: [
      check(SAMPLE_CHIEF_ID, '15:36', 'unmet', '出处只要求提示文字与约定一致，没有提到颜色和位置。删去后半句可以写入；颜色和位置要等以后有出处时再记。', [CHECKLIST_FIRST]),
      check(SAMPLE_CHIEF_ID, '15:41', 'met', null, [CHECKLIST_SENTENCE]),
    ],
    rewrites: 1, versionNo: 1, createdAt: at('15:31'), updatedAt: at('15:41'),
  },
]

/** 同类任务记录（验收结果那一行「记为……第 1 次数据」用）。 */
const OUTCOME = {
  id: SAMPLE_JOB_ID, category: '表单页', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID, title: '活动报名页',
  rounds: 2, reworks: 1, turns: 14, seq: 1, acceptedAt: at('15:20'),
}

/** 主题里的线程消息：两条楼层（主人的话、总管的结论）、一组复盘往来（两张复盘卡、三张核对卡、一张改写卡、小结）。 */
const retroMessage = (serial: string, from: string, refId: string, time: string, text: string) =>
  ({ id: `m_samprtr${serial}`, thread: SAMPLE_RETRO_TOPIC_ID, from, kind: 'job_card', text, refId, createdAt: at(time), readAt: null })
const MESSAGES = [
  { id: 'm_samprtr001', thread: SAMPLE_RETRO_TOPIC_ID, from: 'owner', kind: 'chat', text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: at('09:00') - 6 * 86_400_000, readAt: at('09:00') },
  { id: 'm_samprtr002', thread: SAMPLE_RETRO_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '活动报名页已完成。有 3 条可学的出处，林舟、评审员各复盘一次。', refId: SAMPLE_JOB_ID, createdAt: at('15:20'), readAt: null },
  retroMessage('003', SAMPLE_EXECUTOR_ID, `retro:${SAMPLE_RETRO_RUN_ID}:${SAMPLE_EXECUTOR_ID}`, '15:24', '林舟　活动报名页'),
  retroMessage('005', SAMPLE_REVIEWER_ID, `retro:${SAMPLE_RETRO_RUN_ID}:${SAMPLE_REVIEWER_ID}`, '15:31', '评审员　活动报名页'),
  retroMessage('004', SAMPLE_REVIEWER_ID, `skillcheck:${SAMPLE_RETRO_UPDATE_IDS.form}#1`, '15:32', '技能更新　「表单页做法」第 2 版'),
  retroMessage('006', SAMPLE_CHIEF_ID, `skillcheck:${SAMPLE_RETRO_UPDATE_IDS.checklist}#1`, '15:36', '技能更新　「表单类交付核对」第 1 版'),
  retroMessage('007', SAMPLE_REVIEWER_ID, `retro:${SAMPLE_RETRO_RUN_ID}:${SAMPLE_REVIEWER_ID}:rewrite:${SAMPLE_RETRO_UPDATE_IDS.checklist}`, '15:38', '评审员　活动报名页（改写）'),
  retroMessage('008', SAMPLE_CHIEF_ID, `skillcheck:${SAMPLE_RETRO_UPDATE_IDS.checklist}#2`, '15:41', '技能更新　「表单类交付核对」第 1 版'),
  { id: 'm_samprtr009', thread: SAMPLE_RETRO_TOPIC_ID, from: 'hub', kind: 'work', text: '2 条技能更新核对通过，写入技能库。其中 1 条改写后通过。',
    refId: `retro-summary:${SAMPLE_RETRO_RUN_ID}`, createdAt: at('15:44'), readAt: null },
]

/** 在「一件事」样例环境上种进复盘记录，返回环境。 */
export function retroContext() {
  const ctx = seededContext()
  ctx.store.table('projectTopics').put({
    id: SAMPLE_RETRO_TOPIC_ID, projectId: 'prj_samplejob', title: '活动报名页（复盘）',
    createdAt: at('09:00') - 6 * 86_400_000, updatedAt: at('15:44'), lastMessageAt: at('15:44'), agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  for (const row of SOURCES) ctx.store.table('skillSources').put(row as never)
  for (const row of SKILLS) ctx.store.table('skills').put(row as never)
  ctx.store.table('skillRuns').put(RUN as never)
  for (const row of UPDATES) ctx.store.table('skillUpdates').put(row as never)
  ctx.store.table('jobOutcomes').put(OUTCOME as never)
  for (const row of MESSAGES) ctx.store.log('thread').append(row as never)
  return ctx
}

/** 复盘样例的主题线程视图：由 core 生成（折叠组带「复盘」标题，复盘卡与核对卡的内容都是 core 的写法）。 */
export function sampleRetroTopicThread(): ThreadView {
  return createUiApi(retroContext(), async () => {}).thread(SAMPLE_RETRO_TOPIC_ID) as unknown as ThreadView
}

/** 样例时区（与「一件事」样例一致）。 */
export const SAMPLE_RETRO_TIMEZONE = SAMPLE_JOB_TIMEZONE
