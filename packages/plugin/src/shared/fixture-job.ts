/**
 * 样例「一件事」数据（P74h，样例数据模式专用）：照设计稿场景 A（核对中的主题）、
 * B1（展开的一组往来）、B2（约定卡两栏）、C（交回、第 1 轮退回、第 2 轮通过）造样例，
 * 让离线走查和测试能看到：进度行、工作往来折叠组、交回卡、核对卡、约定卡的两栏与起因一行。
 *
 * 做法（第一块的教训，任务卡第 6 节）：这个文件只写「记录」（core 的事、交回、核对、
 * 约定、线程消息、事件），视图一律由 core 的视图函数生成——这里用 core 的 testing 环境
 * （内存存储加假时钟）种进这些记录，再走 core 对外的 thread 视图（createUiApi().thread）
 * 取回约定面板（含 originLine、jobSplit）、进度行、楼层与折叠分组、卡片视图；
 * 交回卡与核对卡另用 core 导出的纯函数 buildSubmissionCard、buildReviewCard 生成。
 * 不手写任何视图字段：core 改了视图的字段或文字，样例会跟着变。
 * 另有一条一致性测试（test/p74h-fixture.test.ts）校验样例视图符合 core 的视图 schema。
 *
 * 样例文字里出现的中心固定句（往来提示、派活说明等）与 core 落话的原文逐字一致，
 * 登记在 docs/copy/strings.json（编号前缀 JOB-，location 写 core 文件路径）。
 *
 * P74h-m1 补充：提问样例（sampleAskThread，入口 ?job=ask）与场景 C 的走查主题
 * （sampleReviewTopicThread，入口 ?job=review，两张交回卡与两张核对卡完整进入折叠组）。
 */
import {
  createUiApi,
  buildDeliveryCard,
  buildEscalationCard,
  buildReceiptCard,
  buildReviewCard,
  buildSubmissionCard,
  chiefJobLine,
  projectJobRows,
  testing,
  type Agreement,
  type Job,
  type JobCardView,
  type JobEvent,
  type JobReview,
  type JobSubmission,
  type ThreadMessage,
  type ThreadView,
} from '@agent-hub/core'
import type { EvidenceItemView, InboxItemView } from './views.js'
import { isDrawableJobCard } from './job-card-kinds.js'

// ---------------------------------------------------------------------------
// 固定 id 与时间
// ---------------------------------------------------------------------------

/** 样例时间基准：2026-11-13 16:00（北京时间）；样例里的时刻都从它推。 */
export const SAMPLE_JOB_NOW = Date.parse('2026-11-13T16:00:00+08:00')
export const SAMPLE_JOB_TIMEZONE = 'Asia/Shanghai'

export const SAMPLE_CHIEF_ID = 'b_samplechief'
export const SAMPLE_EXECUTOR_ID = 'b_samplelinzhou'
export const SAMPLE_REVIEWER_ID = 'b_samplereview'
export const SAMPLE_JOB_TOPIC_ID = 'ptp_samplejob1'
export const SAMPLE_JOB_TOPIC_TITLE = '活动报名页（11月18日上线）'
export const SAMPLE_JOB_ID = 'job_sample0001'
export const SAMPLE_JOB_AGREEMENT_ID = 'agr_samplejob1'
export const SAMPLE_SUBMISSION_1_ID = 'jsb_sample001'
export const SAMPLE_SUBMISSION_2_ID = 'jsb_sample002'
export const SAMPLE_REVIEW_1_ID = 'jrv_sample001'
export const SAMPLE_REVIEW_2_ID = 'jrv_sample002'
/** B2 样例：执行中重新确认约定的那份约定与它的待确认版本（第 4 版）。 */
export const SAMPLE_B2_AGREEMENT_ID = 'agr_samplejob2'
export const SAMPLE_B2_CARD_MESSAGE_ID = 'm_sampleb2c1'
/** 提问样例（P74h-m1 第 5 处）：另一位样例总管（私聊线程的编号）、它的约定与待确认卡。
 *  场景 B2 的总管私聊和提问样例不能共用一个线程编号（thread 视图按编号取全部消息），
 *  所以另设一位名字同为「总管」的样例员工。 */
export const SAMPLE_ASK_CHIEF_ID = 'b_samplechief2'
export const SAMPLE_ASK_AGREEMENT_ID = 'agr_samplejob3'
export const SAMPLE_ASK_CARD_MESSAGE_ID = 'm_samplea2c1'
/** 场景 C 走查样例（P74h-m1 第 2 处）：独立主题线程，完整放两次交回与两次核对。 */
export const SAMPLE_REVIEW_TOPIC_ID = 'ptp_samplejob3'
/** P74i 场景 D：交付与回执的主题线程（待你验收的交付卡、已完成那件事的回执）。 */
export const SAMPLE_DELIVERY_TOPIC_ID = 'ptp_samplejob5'
export const SAMPLE_DELIVERY_JOB_ID = 'job_sample0004'
export const SAMPLE_DELIVERY_CARD_MESSAGE_ID = 'm_sampled001'
/** P74i 场景 G：已验收的那件事（回执落在同一个主题里）。 */
export const SAMPLE_RECEIPT_JOB_ID = 'job_sample0005'
export const SAMPLE_RECEIPT_CARD_MESSAGE_ID = 'm_sampleg001'
export const SAMPLE_RECEIPT_AGREEMENT_ID = 'agr_samplejob5'
/** P74i-m1（走查 D-12）：交付主题自己的约定（第 4 版已固定）——交付卡、进度行、约定面板三者一致。 */
export const SAMPLE_DELIVERY_AGREEMENT_ID = 'agr_samplejob7'
/** P74i-m1 第 3 节第 1 条：交付卡其余五种状态的走查主题（已完成、未通过、三种失效、等约定确认）。 */
export const SAMPLE_DELIVERY_STATES_TOPIC_ID = 'ptp_samplejob7'
/** P74i-m1 第 3 节第 3 条：带停止标记（stopLine）的约定所在的另一位样例总管。 */
export const SAMPLE_STOP_CHIEF_ID = 'b_samplechief4'
/** P74i-m1（第二次，第 3 节第 2 条）：审批卡样例所在的总管私聊（普通审批、发布审批、已作废的发布审批）。 */
export const SAMPLE_APPROVAL_CHIEF_ID = 'b_samplechief5'
/** P74i-m1（第二次，第 3 节第 4 条）：说明卡各种状态所在的总管私聊（五种失效、等你决定、你选了某一项）。 */
export const SAMPLE_ESC_STATES_CHIEF_ID = 'b_samplechief6'
export const SAMPLE_STOP_AGREEMENT_ID = 'agr_sample0107'
export const SAMPLE_STOP_CARD_MESSAGE_ID = 'm_samplest01'
/** P74i 场景 E：三轮不过卡所在的总管私聊（旧卡已选过办法、新卡等你决定）。 */
export const SAMPLE_ESC_CHIEF_ID = 'b_samplechief3'
export const SAMPLE_ESC_JOB_ID = 'job_sample0006'
export const SAMPLE_ESC_AGREEMENT_ID = 'agr_samplejob6'
export const SAMPLE_ESC_OLD_CARD_MESSAGE_ID = 'm_samplee001'
export const SAMPLE_ESC_NEW_CARD_MESSAGE_ID = 'm_samplee002'

/** 几个关键时刻（北京时间）：约定各版、派活、两次交回、两次核对。 */
const T = {
  v1: Date.parse('2026-11-11T15:31:00+08:00'),
  v4: Date.parse('2026-11-13T09:32:00+08:00'),
  v4Locked: Date.parse('2026-11-13T09:41:00+08:00'),
  assigned: Date.parse('2026-11-11T15:45:00+08:00'),
  started: Date.parse('2026-11-11T15:52:00+08:00'),
  ask: Date.parse('2026-11-12T15:10:00+08:00'),
  answer: Date.parse('2026-11-12T15:11:00+08:00'),
  submitted1: Date.parse('2026-11-16T11:20:00+08:00'),
  reviewed1: Date.parse('2026-11-16T13:05:00+08:00'),
  submitted2: Date.parse('2026-11-16T15:30:00+08:00'),
  reviewed2: Date.parse('2026-11-16T16:40:00+08:00'),
}

// ---------------------------------------------------------------------------
// 一、记录：员工、主题、约定、事、交回、核对、事件、消息
// ---------------------------------------------------------------------------

/** 样例员工：总管（六位：B2 的私聊、提问样例的私聊、三轮不过样例的私聊、停止标记样例的私聊、审批样例的私聊、说明卡状态样例的私聊各占一个线程编号）、林舟（工程师）、评审员（颜色沿用设计稿）。 */
const BOTS = [
  { id: SAMPLE_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_ASK_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_ESC_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_STOP_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_APPROVAL_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_ESC_STATES_CHIEF_ID, name: '总管', color: '#5b6b8c' },
  { id: SAMPLE_EXECUTOR_ID, name: '林舟', color: '#3f8f7a' },
  { id: SAMPLE_REVIEWER_ID, name: '评审员', color: '#b07a3a' },
]

/** 约定的「怎样算做完」六条（设计稿 C；交回、核对、交付的清单都从它逐条抄出）。 */
export const SAMPLE_DONE_WHEN = [
  '用手机和电脑分别打开页面，都能看到活动标题、时间地点和报名表，无需左右滑动。',
  '填写姓名和正确的手机号后提交，页面显示「报名成功」。',
  '手机号少填一位时，页面提示「请填写 11 位手机号」，无法提交。',
  '连续提交 3 条测试报名后，名单表格中恰好有 3 行，各列与表单一致，公司名可为空。',
  '11月17日（周二）18:00 前交给你验收。',
  '提交满 80 条后，第 81 次提交显示「名额已满」，名单保持 80 行。',
] as const

/** 一版约定的内容（各版共用同一份基础内容；第 4 版的人数按文案改为限 80 人）。 */
function content(limit80: boolean): Agreement['versions'][number]['content'] {
  return {
    summary: `11月18日（周三）前做好一个活动报名页：访客填写姓名、手机号和公司名（选填）并提交，${limit80 ? '限 80 人，满额后停止报名' : '人数不限'}，你拿到一份可导出的报名名单。`,
    sketch: {
      layout: 'page',
      screens: [{
        title: '报名页（手机上的样子）',
        blocks: [
          { kind: 'title', text: '活动标题' }, { kind: 'text', text: '活动时间和地点' },
          { kind: 'field', text: '姓名', required: true }, { kind: 'field', text: '手机号', required: true },
          { kind: 'field', text: '公司名（选填）' },
          { kind: 'button', text: limit80 ? '立即报名' : '提交报名' },
        ],
      }],
    },
    pending: [{
      key: 'limit', question: '是否限制报名人数？',
      options: limit80 ? ['限 80 人，满额后停止报名', '不限'] : ['不限', '限制人数，满额后停止报名'],
      suggested: limit80 ? '限 80 人，满额后停止报名' : '不限',
      reason: limit80 ? '你的活动文案写了「限 80 人，额满即止」。' : '你没有提到场地容量。',
      chosen: limit80 ? '限 80 人，满额后停止报名' : null,
    }],
    decided: [
      { text: '手机号按 11 位数字校验，格式不符时当场提示，不能提交。', basis: { kind: 'convention', ref: null, refText: null } },
      { text: '同一手机号重复提交时，只保留最后一次。', basis: { kind: 'convention', ref: null, refText: null } },
    ],
    scopeIn: ['报名页和提交成功页', '报名名单表格'],
    scopeOut: ['对外发布：做好后另行请你确认', '短信或邮件通知'],
    doneWhen: [...SAMPLE_DONE_WHEN],
  }
}

/** 场景 A 的约定：第 4 版已固定（前几版被取代或替换）。 */
export const TOPIC_AGREEMENT: Agreement = {
  id: SAMPLE_JOB_AGREEMENT_ID, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: SAMPLE_JOB_TOPIC_ID, originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4Locked,
  versions: [
    {
      no: 1, state: 'superseded', source: 'draft', askOrigin: null, sourceMessageId: 'm_sample0001', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr01',
      createdAt: T.v1, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: { adopted: 3, total: 4 },
    },
    {
      no: 2, state: 'replaced', source: 'owner_revision', askOrigin: null, sourceMessageId: 'm_sample0001', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '报名信息加入「公司名（选填）」，名单表格相应增加一列。其余不变。', cardMessageId: 'm_sampleagr02',
      createdAt: Date.parse('2026-11-11T15:37:00+08:00'), lockedAt: Date.parse('2026-11-11T15:39:00+08:00'), lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 3, state: 'replaced', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_sample0001', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '按钮文字改为「立即报名」。', cardMessageId: 'm_sampleagr03',
      createdAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedVia: 'amend', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 4, state: 'locked', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_sample0001', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(true), changes: [], changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。', cardMessageId: 'm_sampleagr04',
      createdAt: T.v4, lockedAt: T.v4Locked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
  ],
}

/** 场景 A 的事：核对中（第 1 轮），有发布步骤，交付 11月17日 18:00 前。 */
export const sampleJob: Job = {
  id: SAMPLE_JOB_ID, chiefId: SAMPLE_CHIEF_ID, agreementId: SAMPLE_JOB_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: SAMPLE_JOB_TOPIC_ID, folder: `jobs/${SAMPLE_JOB_ID}`,
  state: 'checking', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 1, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 6, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: T.submitted1,
}

/** 第 6 条（满 80 人）的测试证据与第 1 轮各条的证据（照设计稿 C）。 */
const OK = { status: 'ok', detail: '' } as const
const evidenceImage = (id: string, path: string, summary: string) =>
  ({ id, kind: 'image' as const, path, url: null, summary, command: null, check: OK })
const evidenceFile = (id: string, path: string, summary: string, detail: string) =>
  ({ id, kind: 'file' as const, path, url: null, summary, command: null, check: { status: 'ok' as const, detail } })
const evidenceTest = (id: string, summary: string) =>
  ({ id, kind: 'test' as const, path: null, url: null, summary, command: 'pnpm test signup', check: OK })

/** 第 1 轮交回（六条逐条附证据；第 5 条交付时核对）。 */
export const sampleSubmission1: JobSubmission = {
  id: SAMPLE_SUBMISSION_1_ID, jobId: SAMPLE_JOB_ID, stage: 1, round: 1, executorId: SAMPLE_EXECUTOR_ID, versionNo: 4,
  changeNote: '搭好报名页、提交成功页和名单表格，逐条自查过；名额部分按第 4 版做到 80 人停止。',
  items: [
    { no: 1, text: SAMPLE_DONE_WHEN[0]!, selfCheck: 'met', note: null, evidence: [
      evidenceImage('ev1', '证据/手机.png', '手机　390 宽'), evidenceImage('ev2', '证据/电脑.png', '电脑　1440 宽')] },
    { no: 2, text: SAMPLE_DONE_WHEN[1]!, selfCheck: 'met', note: null, evidence: [evidenceImage('ev3', '证据/提交后.png', '提交后')] },
    { no: 3, text: SAMPLE_DONE_WHEN[2]!, selfCheck: 'met', note: null, evidence: [evidenceImage('ev4', '证据/手机号提示.png', '输入 10 位')] },
    { no: 4, text: SAMPLE_DONE_WHEN[3]!, selfCheck: 'met', note: null, evidence: [
      evidenceFile('ev5', '交付/报名名单表格.numbers', '报名名单　3 行', '文件存在，3.2 KB')] },
    { no: 5, text: SAMPLE_DONE_WHEN[4]!, selfCheck: 'at_delivery', note: null, evidence: [] },
    { no: 6, text: SAMPLE_DONE_WHEN[5]!, selfCheck: 'met', note: null, evidence: [
      evidenceTest('ev6', '依次提交 81 条，第 81 条显示「名额已满」；名单 80 行。')] },
  ],
  deliverables: ['交付/报名页.html', '交付/提交成功页.html', '交付/报名名单表格.numbers'], preview: null, createdAt: T.submitted1,
}

/** 第 1 轮核对：第 3 条不符，退回（剩余 2 轮）。 */
export const sampleReview1: JobReview = {
  id: SAMPLE_REVIEW_1_ID, jobId: SAMPLE_JOB_ID, stage: 1, round: 1, submissionId: SAMPLE_SUBMISSION_1_ID, reviewerId: SAMPLE_REVIEWER_ID,
  items: [
    { no: 1, verdict: 'met', note: '两张截图均无横向滚动；我另用 375 宽度复查，同样符合。', fixTo: null, rechecked: true },
    { no: 2, verdict: 'met', note: null, fixTo: null, rechecked: false },
    { no: 3, verdict: 'unmet', note: '提示文字是「手机号格式不正确」，与约定不一致。无法提交这一半符合。', fixTo: '输入 10 位手机号时，提示文字与约定逐字一致：「请填写 11 位手机号」；提交按钮不可用。附一张截图。', rechecked: false },
    { no: 4, verdict: 'met', note: null, fixTo: null, rechecked: false },
    { no: 5, verdict: 'at_delivery', note: null, fixTo: null, rechecked: false },
    { no: 6, verdict: 'met', note: '我重跑了一次同样的测试，结果一致。', fixTo: null, rechecked: true },
  ],
  carriedNote: null, spotChecked: [], createdAt: T.reviewed1,
}

/** 第 2 轮交回：只改第 3 条，其余沿用上一轮。 */
export const sampleSubmission2: JobSubmission = {
  id: SAMPLE_SUBMISSION_2_ID, jobId: SAMPLE_JOB_ID, stage: 1, round: 2, executorId: SAMPLE_EXECUTOR_ID, versionNo: 4,
  changeNote: '把提示文字改成与约定逐字一致的「请填写 11 位手机号」，按钮在格式不对时不可用。',
  items: [
    { no: 1, text: SAMPLE_DONE_WHEN[0]!, selfCheck: 'carried', note: null, evidence: [] },
    { no: 2, text: SAMPLE_DONE_WHEN[1]!, selfCheck: 'carried', note: null, evidence: [] },
    { no: 3, text: SAMPLE_DONE_WHEN[2]!, selfCheck: 'met', note: null, evidence: [evidenceImage('ev7', '证据/手机号提示-第2轮.png', '输入 10 位')] },
    { no: 4, text: SAMPLE_DONE_WHEN[3]!, selfCheck: 'carried', note: null, evidence: [] },
    { no: 5, text: SAMPLE_DONE_WHEN[4]!, selfCheck: 'carried', note: null, evidence: [] },
    { no: 6, text: SAMPLE_DONE_WHEN[5]!, selfCheck: 'carried', note: null, evidence: [] },
  ],
  deliverables: ['交付/报名页.html'], preview: 'http://localhost:5173/', createdAt: T.submitted2,
}

/** 第 2 轮核对：通过（其余 5 条沿用第 1 轮结论，抽查了第 2 条）。 */
export const sampleReview2: JobReview = {
  id: SAMPLE_REVIEW_2_ID, jobId: SAMPLE_JOB_ID, stage: 1, round: 2, submissionId: SAMPLE_SUBMISSION_2_ID, reviewerId: SAMPLE_REVIEWER_ID,
  items: [
    { no: 1, verdict: 'carried', note: null, fixTo: null, rechecked: false },
    { no: 2, verdict: 'carried', note: null, fixTo: null, rechecked: true },
    { no: 3, verdict: 'met', note: '提示文字与约定逐字一致，按钮不可用。', fixTo: null, rechecked: false },
    { no: 4, verdict: 'carried', note: null, fixTo: null, rechecked: false },
    { no: 5, verdict: 'carried', note: null, fixTo: null, rechecked: false },
    { no: 6, verdict: 'carried', note: null, fixTo: null, rechecked: false },
  ],
  carriedNote: '本轮只改了提示文字，不影响它们', spotChecked: [2], createdAt: T.reviewed2,
}

/** 工作往来的事件（「谁 → 谁」按它写）：开工（说给自己记进度，没有接收者）、提问、回答、交回。 */
const EVENTS: JobEvent[] = [
  { id: 'jev_sample0001', jobId: SAMPLE_JOB_ID, at: T.started, actor: SAMPLE_EXECUTOR_ID, kind: 'assigned', to: [], refId: null, data: {} },
  { id: 'jev_sample0002', jobId: SAMPLE_JOB_ID, at: T.ask, actor: SAMPLE_EXECUTOR_ID, kind: 'asked', to: [SAMPLE_CHIEF_ID], refId: null, data: {} },
  { id: 'jev_sample0003', jobId: SAMPLE_JOB_ID, at: T.answer, actor: SAMPLE_CHIEF_ID, kind: 'answered', to: [SAMPLE_EXECUTOR_ID], refId: null, data: {} },
  { id: 'jev_sample0004', jobId: SAMPLE_JOB_ID, at: T.submitted1, actor: SAMPLE_EXECUTOR_ID, kind: 'submitted', to: [SAMPLE_REVIEWER_ID, SAMPLE_CHIEF_ID], refId: SAMPLE_SUBMISSION_1_ID, data: {} },
]

/** 主题线程的消息（场景 A：楼层与两组工作往来交替；文字与 core 落话的固定句逐字一致）。 */
const TOPIC_MESSAGES: ThreadMessage[] = [
  // 楼层：主人开场（主题原文）。
  { id: 'm_sample0001', thread: SAMPLE_JOB_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  // 楼层：派活后总管在主题里的那句话（core：job/assign.ts 的 assignedTopicText）。
  { id: 'm_sample0002', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '这件事由林舟（工程师）执行，评审员在交付前对照约定核对。我已把你的原话、草图和约定第 4 版作为文件交给林舟。',
    refId: SAMPLE_JOB_ID, createdAt: T.assigned, readAt: null },
  // 第一组工作往来（场景 B1 展开后的样子）：开工、提问、总管按约定回答、中心概括。
  { id: 'm_sample0003', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'work',
    text: '已读约定第 4 版和草图，开始做。预计 11月16日中午前交回。',
    refId: 'jev_sample0001', createdAt: T.started, readAt: null },
  { id: 'm_sample0004', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'work',
    text: '同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？约定写了名单只保留最后一次，但没写页面上显示什么。',
    refId: 'jev_sample0002', createdAt: T.ask, readAt: null },
  { id: 'm_sample0005', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'work',
    text: '照常接受，页面显示「报名成功」，名单里用这次提交覆盖上一次。\n依据：约定「我已定的」第 2 条（同一手机号重复提交时，只保留最后一次）和「怎样算做完」第 2 条（提交后显示「报名成功」）。\n这一点不改约定，不需要问主人。',
    refId: 'jev_sample0003', createdAt: T.answer, readAt: null },
  { id: 'm_sample0006', thread: SAMPLE_JOB_TOPIC_ID, from: 'hub', kind: 'work',
    text: '总管按约定答复了林舟 1 个问题，不需要你处理。',
    refId: 'jev_sample0003', createdAt: T.answer + 60_000, readAt: null },
  // 楼层：第 4 版固定后总管在主题里的那句话（core：job/agreement-hooks.ts）。
  { id: 'm_sample0007', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '约定第 4 版已按你的确认固定：人数改为「限 80 人，满额后停止报名」。林舟已继续做暂停的 1 处（见约定卡），交付时间不变。',
    refId: SAMPLE_JOB_ID, createdAt: T.v4Locked, readAt: null },
  // 第二组工作往来（场景 C）：第 1 轮交回卡加中心概括（评审员正在核对）。
  { id: 'm_sample0008', thread: SAMPLE_JOB_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'job_card',
    text: '活动报名页　第 1 轮',
    refId: `submission:${SAMPLE_SUBMISSION_1_ID}`, createdAt: T.submitted1, readAt: null },
  { id: 'm_sample0009', thread: SAMPLE_JOB_TOPIC_ID, from: 'hub', kind: 'work',
    text: '林舟交回第 1 轮，5 条附证据，1 条交付时核对；评审员正在核对。',
    refId: 'jev_sample0004', createdAt: T.submitted1 + 60_000, readAt: null },
]

/** 评审员手上一张进行中的核对唤醒单（进度行的延迟说明因此为空：正在核对不是被挡住）。 */
const OPEN_WAKE = {
  id: 'w_sample0001', botId: SAMPLE_REVIEWER_ID, sessionId: null, variant: 'regular' as const,
  reason: { kind: 'peer_message' as const, score: 0.5, threshold: 1, summary: '核对第 1 轮交回', evidence: [] },
  ownerInitiated: false, packetBytes: 4096, status: 'running' as const,
  startedAt: SAMPLE_JOB_NOW - 10 * 60_000, lastEventAt: SAMPLE_JOB_NOW - 10 * 60_000, endedAt: null,
  steps: 0, tokens: 0, steeredAt: null, commitId: null, error: null, jobId: SAMPLE_JOB_ID,
}

// ---------------------------------------------------------------------------
// 二、场景 B2：执行中重新确认约定（第 4 版待确认，起因是提问）
// ---------------------------------------------------------------------------

/** B2 的约定：第 4 版待确认，来源是主人发来的活动文案（没有起因一行，P74h-m1 改回）。 */
const B2_AGREEMENT: Agreement = {
  id: SAMPLE_B2_AGREEMENT_ID, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob2', originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'pending', inboxId: 'i_sampleb2in1', withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4,
  versions: [
    {
      no: 1, state: 'superseded', source: 'draft', askOrigin: null, sourceMessageId: 'm_sampleb201', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr11',
      createdAt: T.v1, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 2, state: 'replaced', source: 'owner_revision', askOrigin: null, sourceMessageId: 'm_sampleb201', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '报名信息加入「公司名（选填）」。', cardMessageId: 'm_sampleagr12',
      createdAt: Date.parse('2026-11-11T15:37:00+08:00'), lockedAt: Date.parse('2026-11-11T15:39:00+08:00'), lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 3, state: 'replaced', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_sampleb201', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '按钮文字改为「立即报名」。', cardMessageId: 'm_sampleagr13',
      createdAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedVia: 'amend', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      // 第 4 版：待确认。P74h-m1 第 5 处：B2 样例改回主人的材料（活动文案）引起的新版本——
      // 来源写你在总管私聊里的指示，askOrigin 为空（没有「起因」一行），与上方总管那句话相符。
      no: 4, state: 'pending', source: 'owner_instruction', askOrigin: null,
      sourceMessageId: 'm_sampleb201', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      // P74i-m2（第二次）：这一版写了对外发布（launch），约定卡「怎样算做完」之后多一行（core 的 launchLine 原样给出），
      // 并带「本版改动」标记；按 P74r9 的口径，对外发布不再写进 scopeOut（那里只留这次不做的事）。
      content: { ...content(true), scopeOut: ['短信或邮件通知'], launch: { how: '发到内网演示地址，把地址发给你' } },
      changes: [
        { section: 'summary', kind: 'changed' },
        { section: 'decided', kind: 'added', index: 3 },
        { section: 'doneWhen', kind: 'added', index: 6 },
        { section: 'launch', kind: 'added' },
      ],
      changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」；怎样算做完新增第 6 条；新增验收之后的对外发布。',
      cardMessageId: SAMPLE_B2_CARD_MESSAGE_ID,
      createdAt: T.v4, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
    },
  ],
}

/** B2 的事：执行中，第 4 版等你确认（暂停的部分在暂停记录里，两栏由 core 算出）。 */
export const sampleB2Job: Job = {
  id: 'job_sample0002', chiefId: SAMPLE_CHIEF_ID, agreementId: SAMPLE_B2_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob2', folder: 'jobs/job_sample0002',
  state: 'doing', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 0, blocked: null,
  pause: {
    versionNo: 4,
    continuing: ['页面排版与活动信息', '手机号校验', '提交成功页', '报名名单表格'],
    paused: ['名额计数与「名额已满」'],
    fallback: '如果「限 80 人」只是文案说法、页面不需要限制，回复「不限」，我保留第 3 版。',
  },
  openAsk: null,
  unmet: [], turnsUsed: 6, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: T.v4,
}

/** B2 的总管私聊：主人的文案、中心一句、总管的说明、待确认的约定卡（第 4 版）。 */
const B2_MESSAGES: ThreadMessage[] = [
  { id: 'm_sampleb201', thread: SAMPLE_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '活动文案：AI 产品沙龙，11月20日 14:00，望京 SOHO T3 12 层。限 80 人，额满即止。',
    refId: null, createdAt: Date.parse('2026-11-13T09:30:00+08:00'), readAt: null },
  { id: 'm_sampleb202', thread: SAMPLE_CHIEF_ID, from: 'hub', kind: 'system',
    text: '活动文案已存为主题文件「活动文案」，交给林舟。',
    refId: null, createdAt: Date.parse('2026-11-13T09:31:00+08:00'), readAt: null },
  { id: 'm_sampleb203', thread: SAMPLE_CHIEF_ID, from: SAMPLE_CHIEF_ID, kind: 'chat',
    text: '你的文案写了「限 80 人，额满即止」，与约定第 3 版的「人数不限」不一致。我按文案出了第 4 版，请确认；名额部分在你确认前暂停，其余照常在做。',
    refId: null, createdAt: T.v4, readAt: null },
  { id: SAMPLE_B2_CARD_MESSAGE_ID, thread: SAMPLE_CHIEF_ID, from: SAMPLE_CHIEF_ID, kind: 'agreement',
    text: '约定「活动报名页」第 4 版',
    refId: SAMPLE_B2_AGREEMENT_ID, createdAt: T.v4 + 60_000, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点五、提问样例（P74h-m1 第 5 处）：执行者提问引起的待确认版本（带「来源」「起因」两行）
// ---------------------------------------------------------------------------

/** 提问样例的约定内容：第 3 版为止「重复提交怎么处理」没有定；第 4 版按「照常接受、名单只保留最后一次」新增一条已定。 */
function askContent(dupRule: boolean): Agreement['versions'][number]['content'] {
  const base = content(false)
  return {
    ...base,
    decided: [
      { text: '手机号按 11 位数字校验，格式不符时当场提示，不能提交。', basis: { kind: 'convention', ref: null, refText: null } },
      ...(dupRule
        ? [{ text: '同一手机号重复提交时，页面照常显示「报名成功」，名单里只保留最后一次。', basis: { kind: 'convention', ref: null, refText: null } as const }]
        : []),
    ],
  }
}

/** 提问样例的约定：第 4 版待确认，起因是林舟的提问（约定里推不出答案），来源写「执行中的提问」。 */
const ASK_AGREEMENT: Agreement = {
  id: SAMPLE_ASK_AGREEMENT_ID, botId: SAMPLE_ASK_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob4', originThread: SAMPLE_ASK_CHIEF_ID,
  title: '活动报名页', state: 'pending', inboxId: 'i_samplea2in1', withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4,
  versions: [
    {
      no: 1, state: 'superseded', source: 'draft', askOrigin: null, sourceMessageId: 'm_samplea201', sourceThread: SAMPLE_ASK_CHIEF_ID, wakeId: null,
      content: askContent(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr21',
      createdAt: T.v1, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 2, state: 'replaced', source: 'owner_revision', askOrigin: null, sourceMessageId: 'm_samplea201', sourceThread: SAMPLE_ASK_CHIEF_ID, wakeId: null,
      content: askContent(false), changes: [], changeNote: '报名信息加入「公司名（选填）」。', cardMessageId: 'm_sampleagr22',
      createdAt: Date.parse('2026-11-11T15:37:00+08:00'), lockedAt: Date.parse('2026-11-11T15:39:00+08:00'), lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 3, state: 'replaced', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_samplea201', sourceThread: SAMPLE_ASK_CHIEF_ID, wakeId: null,
      content: askContent(false), changes: [], changeNote: '按钮文字改为「立即报名」。', cardMessageId: 'm_sampleagr23',
      createdAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedAt: Date.parse('2026-11-12T10:05:00+08:00'), lockedVia: 'amend', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      // 第 4 版：待确认；起因是林舟的提问（约定里推不出答案），来源写「执行中的提问」，卡片带「来源」「起因」两行。
      no: 4, state: 'pending', source: 'job_question',
      askOrigin: { jobId: 'job_sample0003', askEventId: 'jev_samplea201', askerId: SAMPLE_EXECUTOR_ID, askerName: '林舟',
        text: '同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？' },
      sourceMessageId: null, sourceThread: null, wakeId: null,
      content: askContent(true),
      changes: [{ section: 'decided', kind: 'added', index: 2 }],
      changeNote: '「我已定的」新增：同一手机号重复提交时，页面照常显示「报名成功」，名单里只保留最后一次。',
      cardMessageId: SAMPLE_ASK_CARD_MESSAGE_ID,
      createdAt: T.v4, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
    },
  ],
}

/** 提问样例的事：执行中，第 4 版等你确认（重复提交的处理暂停，其余照常）。 */
export const sampleAskJob: Job = {
  id: 'job_sample0003', chiefId: SAMPLE_ASK_CHIEF_ID, agreementId: SAMPLE_ASK_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob4', folder: 'jobs/job_sample0003',
  state: 'doing', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 0, blocked: null,
  pause: {
    versionNo: 4,
    continuing: ['页面排版与活动信息', '手机号校验', '提交成功页', '报名名单表格'],
    paused: ['重复提交时名单覆盖'],
    fallback: '如果重复提交应该直接拦下并提示，回复「拦下」，我保留第 3 版。',
  },
  openAsk: { eventId: 'jev_samplea201', fromId: SAMPLE_EXECUTOR_ID, at: T.ask, text: '同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？', agreementNo: 4 },
  unmet: [], turnsUsed: 6, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: T.v4,
}

/** 提问样例的总管私聊：主人的委托、总管转述提问并出新版本、待确认的约定卡（第 4 版，带两栏与「来源」「起因」）。 */
const ASK_MESSAGES: ThreadMessage[] = [
  { id: 'm_samplea201', thread: SAMPLE_ASK_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_samplea202', thread: SAMPLE_ASK_CHIEF_ID, from: SAMPLE_ASK_CHIEF_ID, kind: 'chat',
    text: '林舟在做这件事时问「同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？」，约定里没有写。我按「照常接受、名单只保留最后一次」出了第 4 版，请确认；重复提交的处理在你确认前暂停，其余照常在做。',
    refId: null, createdAt: T.v4, readAt: null },
  { id: SAMPLE_ASK_CARD_MESSAGE_ID, thread: SAMPLE_ASK_CHIEF_ID, from: SAMPLE_ASK_CHIEF_ID, kind: 'agreement',
    text: '约定「活动报名页」第 4 版',
    refId: SAMPLE_ASK_AGREEMENT_ID, createdAt: T.v4 + 60_000, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点六、场景 C 走查样例（P74h-m1 第 2 处）：独立主题，完整放第 1 轮交回、退回、第 2 轮交回、通过
// ---------------------------------------------------------------------------

/** 场景 C 的主题线程：两条楼层加一组工作往来（两张交回卡、两张核对卡都在折叠组里，展开可见）。 */
const REVIEW_TOPIC_MESSAGES: ThreadMessage[] = [
  // 楼层：主人开场（与场景 A 同一件事的原话）。
  { id: 'm_samplec001', thread: SAMPLE_REVIEW_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  // 楼层：派活后总管在主题里的那句话（core：job/assign.ts 的 assignedTopicText，与场景 A 逐字一致）。
  { id: 'm_samplec002', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '这件事由林舟（工程师）执行，评审员在交付前对照约定核对。我已把你的原话、草图和约定第 4 版作为文件交给林舟。',
    refId: SAMPLE_JOB_ID, createdAt: T.assigned, readAt: null },
  // 一组工作往来：开工、第 1 轮交回、中心概括、第 1 轮核对退回、第 2 轮交回、第 2 轮核对通过。
  { id: 'm_samplec003', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'work',
    text: '已读约定第 4 版和草图，开始做。预计 11月16日中午前交回。',
    refId: 'jev_sample0001', createdAt: T.started, readAt: null },
  // P74i-m6（第 1 节第 1 条）：回合被中心结束时落的工作往来（core：job/chain-turn-end.ts 的 chainEndFact 加「已告诉总管。」，逐字一致）。
  // 入口：?job=review 的工作往来折叠组（展开可见）。
  { id: 'm_samplec009', thread: SAMPLE_REVIEW_TOPIC_ID, from: 'hub', kind: 'work',
    text: '林舟的一个回合超过 60 分钟，中心已结束它。已告诉总管。',
    refId: 'jev_samplec901', createdAt: T.started + 3 * 3600_000, readAt: null },
  { id: 'm_samplec004', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'job_card',
    text: '活动报名页　第 1 轮',
    refId: `submission:${SAMPLE_SUBMISSION_1_ID}`, createdAt: T.submitted1, readAt: null },
  { id: 'm_samplec005', thread: SAMPLE_REVIEW_TOPIC_ID, from: 'hub', kind: 'work',
    text: '林舟交回第 1 轮，5 条附证据，1 条交付时核对；评审员正在核对。',
    refId: 'jev_sample0004', createdAt: T.submitted1 + 60_000, readAt: null },
  { id: 'm_samplec006', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_REVIEWER_ID, kind: 'job_card',
    text: '第 1 轮　不通过：1 条不符',
    refId: `review:${SAMPLE_REVIEW_1_ID}`, createdAt: T.reviewed1, readAt: null },
  { id: 'm_samplec007', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_EXECUTOR_ID, kind: 'job_card',
    text: '活动报名页　第 2 轮',
    refId: `submission:${SAMPLE_SUBMISSION_2_ID}`, createdAt: T.submitted2, readAt: null },
  { id: 'm_samplec008', thread: SAMPLE_REVIEW_TOPIC_ID, from: SAMPLE_REVIEWER_ID, kind: 'job_card',
    text: '第 2 轮　通过：6 条均符合',
    refId: `review:${SAMPLE_REVIEW_2_ID}`, createdAt: T.reviewed2, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点七、P74i 场景 D、E、G：交付（三种状态）、三轮不过（新卡与选过的旧卡）、回执
// ---------------------------------------------------------------------------

/** 场景 D 的关键时刻（北京时间）：交付、验收。 */
const TD = {
  delivered: Date.parse('2026-11-17T17:20:00+08:00'),
  accepted: Date.parse('2026-11-17T18:05:00+08:00'),
}

/** 场景 D 自己的两次交回与两次核对（不能借用场景 A 的记录：交回的 jobId 属于哪件事，证据编号就指向哪次交回）。 */
export const sampleDeliverySubmission1: JobSubmission = { ...sampleSubmission1, id: 'jsb_sample031', jobId: SAMPLE_DELIVERY_JOB_ID }
/**
 * P74i-m3（第 8 节第 1 条）：交付样例的第 2 轮交回里，第 3 条（手机号提示）除截图外再附一条链接证据，
 * 地址用 https://example.com/ 这类样例地址，让走查在 ?job=delivery 的交付卡里看得到「链接」证据的样子
 * （链接证据画成不可点的文字：主机名加完整地址）。其余条目不变。
 */
const DELIVERY_LINK_EVIDENCE = {
  id: 'ev8', kind: 'link' as const, path: null, url: 'https://example.com/signup/demo?step=phone-check',
  summary: '线上演示页（输入 10 位手机号的提示）', command: null,
  // 核心对链接证据的固定口径：中心不打开链接（job/evidence.ts），状态为未核验。
  check: { status: 'unchecked' as const, detail: '中心不打开链接，由核对人查看' },
}
export const sampleDeliverySubmission2: JobSubmission = {
  ...sampleSubmission2, id: 'jsb_sample032', jobId: SAMPLE_DELIVERY_JOB_ID,
  items: sampleSubmission2.items.map(item => item.no === 3 ? { ...item, evidence: [...item.evidence, DELIVERY_LINK_EVIDENCE] } : item),
}
export const sampleDeliveryReview1: JobReview = { ...sampleReview1, id: 'jrv_sample031', jobId: SAMPLE_DELIVERY_JOB_ID, submissionId: 'jsb_sample031' }
export const sampleDeliveryReview2: JobReview = { ...sampleReview2, id: 'jrv_sample032', jobId: SAMPLE_DELIVERY_JOB_ID, submissionId: 'jsb_sample032' }

/**
 * P74i-m1（走查 D-12）：交付主题自己的约定（第 4 版已固定）。
 * 此前交付卡挂在场景 A 的约定上、主题里的约定面板却取回执那条第 1 版约定，
 * 同一页上「第 1 版已固定／进度已完成」与「按约定第 4 版／待你验收」互相矛盾；
 * 现在交付卡、约定面板、进度行都从这一份约定（和它名下的交付卡这件事）推出，三者一致。
 */
const DELIVERY_AGREEMENT: Agreement = {
  id: SAMPLE_DELIVERY_AGREEMENT_ID, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: SAMPLE_DELIVERY_TOPIC_ID, originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4Locked,
  versions: [{
    no: 4, state: 'locked', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_sampled000', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
    content: content(true), changes: [], changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。',
    cardMessageId: 'm_sampleagr71',
    createdAt: T.v4, lockedAt: T.v4Locked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
}

/** 场景 D 的事：核对两轮通过后交付，待你验收。 */
export const sampleDeliveryJob: Job = {
  id: SAMPLE_DELIVERY_JOB_ID, chiefId: SAMPLE_CHIEF_ID, agreementId: SAMPLE_DELIVERY_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: SAMPLE_DELIVERY_TOPIC_ID, folder: `jobs/${SAMPLE_DELIVERY_JOB_ID}`,
  state: 'awaiting_owner', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 2, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 9, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: 'i_sampled1in1',
  delivery: { stage: 1, cardMessageId: SAMPLE_DELIVERY_CARD_MESSAGE_ID, checks: [{ no: 5, ok: true }], rev: 0 },
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: TD.delivered, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TD.delivered,
}

/** 场景 G 的事：已验收（回执按它的记录算出）。 */
export const sampleReceiptJob: Job = {
  id: SAMPLE_RECEIPT_JOB_ID, chiefId: SAMPLE_CHIEF_ID, agreementId: SAMPLE_RECEIPT_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: SAMPLE_DELIVERY_TOPIC_ID, folder: `jobs/${SAMPLE_RECEIPT_JOB_ID}`,
  state: 'done', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 1, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 8, turnCap: 16, answeredCount: 1,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  delivery: { stage: 1, cardMessageId: null, checks: [{ no: 5, ok: true }], rev: 0 },
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: Date.parse('2026-11-17T17:40:00+08:00'), acceptedAt: TD.accepted, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TD.accepted,
}

/**
 * 场景 G 的约定：第 4 版已固定。
 * P74i-m1（走查 D-12）：topicId 挪到未登记的主题编号上——回执那条消息仍在交付主题里，
 * 但交付主题的约定面板与进度行改由交付卡自己的那份约定（agr_samplejob7）推出，两者不再互相矛盾。
 * P74i-m2（走查 R-5）：回执的「约定版本」改为第 4 版——回执与同页交付卡（按约定第 4 版）
 * 写的是同一件事的同一版约定，同一页上两个版本号不再互相矛盾。
 */
const RECEIPT_AGREEMENT: Agreement = {
  id: SAMPLE_RECEIPT_AGREEMENT_ID, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob8', originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  versions: [{
    no: 4, state: 'locked', source: 'draft', askOrigin: null, sourceMessageId: 'm_sampleg000', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
    content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr51',
    createdAt: T.v1, lockedAt: Date.parse('2026-11-11T15:39:00+08:00'), lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
}

/** 场景 G 的交回与核对（一轮通过）：回执的「核对」一行按它写。 */
export const sampleReceiptSubmission: JobSubmission = {
  id: 'jsb_sample011', jobId: SAMPLE_RECEIPT_JOB_ID, stage: 1, round: 1, executorId: SAMPLE_EXECUTOR_ID, versionNo: 1,
  changeNote: '按约定做好报名页，逐条自查过。',
  items: SAMPLE_DONE_WHEN.map((text, index) => ({ no: index + 1, text, selfCheck: index === 4 ? 'at_delivery' as const : 'met' as const, note: null, evidence: [] })),
  deliverables: ['交付/报名页.html'], preview: null, createdAt: Date.parse('2026-11-17T17:40:00+08:00'),
}
export const sampleReceiptReview: JobReview = {
  id: 'jrv_sample011', jobId: SAMPLE_RECEIPT_JOB_ID, stage: 1, round: 1, submissionId: 'jsb_sample011', reviewerId: SAMPLE_REVIEWER_ID,
  items: SAMPLE_DONE_WHEN.map((_, index) => ({ no: index + 1, verdict: index === 4 ? 'at_delivery' as const : 'met' as const, note: null, fixTo: null, rechecked: false })),
  carriedNote: null, spotChecked: [], createdAt: Date.parse('2026-11-17T17:55:00+08:00'),
}

/** 场景 G 的「待你处理」里出现过的两条（约定确认、验收）：回执的「需要你处理」一行按它们数（含已答复的）。 */
const RECEIPT_INBOX = [
  { id: 'i_sampleg1in1', botId: SAMPLE_CHIEF_ID, type: 'question' as const, title: '约定「活动报名页」第 4 版', body: '请确认。',
    subjectKey: `agreement:${SAMPLE_RECEIPT_AGREEMENT_ID}:1`, options: ['按建议，定了'], defaultOption: null, priority: 'P1' as const,
    refId: null, status: 'answered' as const, answer: '按建议，定了', pushed: false,
    createdAt: T.v1, expiresAt: null, answeredAt: Date.parse('2026-11-11T15:39:00+08:00') },
  { id: 'i_sampleg2in1', botId: SAMPLE_CHIEF_ID, type: 'question' as const, title: '活动报名页：待你验收', body: '5 条全部符合。',
    subjectKey: `job:${SAMPLE_RECEIPT_JOB_ID}:accept:1`, options: ['验收通过'], defaultOption: null, priority: 'P1' as const,
    refId: SAMPLE_RECEIPT_JOB_ID, status: 'answered' as const, answer: '验收通过', pushed: false,
    createdAt: TD.delivered, expiresAt: null, answeredAt: TD.accepted },
]

/**
 * P74i-m4（第 5 节第 3 条）：B2 第 4 版约定在「待你处理」里的确认条目（原先 ?job=b2 用的是手写的视图对象，
 * 没有主题编号、标题与正文也不是核心的写法）。这里种成与核心 project/agreement-cards.ts 的 replaceInboxItem
 * 同样形状的记录（标题「约定第 n 版待你确认：…」、正文逐条「问题：建议」再加说明句、带主题编号、
 * 事项键 agreement:<约定>:<版本>），再由核心的 inbox 视图函数生成条目视图（sampleB2InboxEntry）。
 * 说明句不在正文里（P74r14），由界面按条目标记显示：B2 的事正在做，暂停的部分等确认（agreementJobSplit）。
 */
const B2_INBOX = {
  id: 'i_sampleb2in1', botId: SAMPLE_CHIEF_ID, type: 'question' as const, priority: 'P1' as const,
  title: '约定第 4 版待你确认：活动报名页',
  // P74i-m5（第 0 步）：核心 P74r14 起，正文只剩「问题：建议」各行（问题末尾的问号去掉，同 util/question-join.ts），
  // 不再带「不会自动按建议处理。……」这类说明句；说明句由界面按条目上的标记（agreementJobSplit）显示一次。
  body: B2_AGREEMENT.versions[3]!.content.pending
    .map(item => `${item.question.replace(/[？?][\s]*$/u, '').replace(/[\s]+$/u, '')}：${item.suggested}`)
    .join('\n'),
  options: ['按建议，定了'], defaultOption: null,
  refId: SAMPLE_B2_AGREEMENT_ID, subjectKey: `agreement:${SAMPLE_B2_AGREEMENT_ID}:4`, topicId: B2_AGREEMENT.topicId,
  status: 'open' as const, answer: null, pushed: false,
  createdAt: T.v4 + 60_000, expiresAt: null, answeredAt: null,
}

/** 场景 E 的事：核对三轮不过，在等主人选办法；旧卡主人选过 B，新说明（执行者无法继续）等你决定。 */
const ESC_OPTIONS = [
  { title: '换用第三方表单服务重做这一条', detail: '不改约定，用现成服务替代自己写的校验。', change: null, followUp: false },
  { title: '把这一条改为允许提交、后台补全', detail: '页面不再拦格式，名单由后台整理。', change: { no: 3, text: '手机号少填一位时，允许提交，由后台补全。' }, followUp: false },
  { title: '删去这一条', detail: '不做这条校验，约定里也不再要求。', change: { no: 3, text: null }, followUp: false },
]
export const sampleEscalationJob: Job = {
  id: SAMPLE_ESC_JOB_ID, chiefId: SAMPLE_ESC_CHIEF_ID, agreementId: SAMPLE_ESC_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob6', folder: `jobs/${SAMPLE_ESC_JOB_ID}`,
  state: 'blocked', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [], launchStep: false,
  stage: 1, round: 3,
  // P74i-m1（第二次，第 0 步）：核心并入 P74r4a-m1 之后，说明是不是「现在这一次受阻」的说明
  // 按事实判断（blocked 的 kind 与 since 都要对上）；新说明（执行者无法继续，kind executor、
  // blockedSince 11月17日 09:00）对应的受阻改为同一种、同一时刻，新卡才是有效的「等你决定」，
  // 否则视图按「不是这一次受阻的说明」写成「已失效：这件事已继续进行」。
  blocked: { kind: 'executor', no: 3, text: '按上次选的办法改过后，表单服务一直返回错误，无法继续。', since: Date.parse('2026-11-17T09:00:00+08:00'), resumeTo: 'rework' },
  pause: null,
  openAsk: null, unmet: [], turnsUsed: 12, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: 'i_samplee2in1',
  // 旧卡（第 1 次说明，主人选了 B）与新卡（第 2 次说明：执行者无法继续，等你决定）。
  escalationHistory: [{
    stage: 1, rev: 0, blockedSince: Date.parse('2026-11-16T16:40:00+08:00'), versionNo: 1, kind: 'review_limit',
    stuckAt: '第 3 条「请填写 11 位手机号」的提示文字核对三轮仍未通过，在等你选一个处理办法。',
    no: 3, noText: SAMPLE_DONE_WHEN[2]!,
    options: ESC_OPTIONS, suggested: 0, reason: '不改约定就能再试一次，成本最低。',
    tried: [], at: Date.parse('2026-11-16T17:00:00+08:00'), chosen: 1, chosenAt: Date.parse('2026-11-16T18:00:00+08:00'),
  }],
  escalation: {
    stage: 1, rev: 1, blockedSince: Date.parse('2026-11-17T09:00:00+08:00'), versionNo: 1, kind: 'executor',
    stuckAt: '按上次选的办法改过后，表单服务一直返回错误，两种写法都试过，仍然不行。',
    no: 3, noText: SAMPLE_DONE_WHEN[2]!,
    options: ESC_OPTIONS, suggested: 0, reason: '换一家服务商比再改约定更快。',
    tried: ['换成 B 方案后重做页面，第 1 天可用', '第 2 天起服务间歇性报错，页面打不开', '回退到自查时的写法，错误仍在'],
    at: Date.parse('2026-11-17T15:00:00+08:00'), chosen: null, chosenAt: null,
  },
  firstLockedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: Date.parse('2026-11-17T15:00:00+08:00'),
}

/** 场景 E 的约定：第 1 版固定（办法里的改动按它写「选了会改什么」）。 */
const ESC_AGREEMENT: Agreement = {
  id: SAMPLE_ESC_AGREEMENT_ID, botId: SAMPLE_ESC_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob6', originThread: SAMPLE_ESC_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: Date.parse('2026-11-11T15:39:00+08:00'),
  versions: [{
    no: 1, state: 'locked', source: 'draft', askOrigin: null, sourceMessageId: 'm_samplee000', sourceThread: SAMPLE_ESC_CHIEF_ID, wakeId: null,
    content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr61',
    createdAt: T.v1, lockedAt: Date.parse('2026-11-11T15:39:00+08:00'), lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
}

/** 场景 E 的三轮交回与核对（旧卡的「已尝试的办法」按它们逐轮写）。 */
const escSubmission = (id: string, round: number, note: string): JobSubmission => ({
  id, jobId: SAMPLE_ESC_JOB_ID, stage: 1, round, executorId: SAMPLE_EXECUTOR_ID, versionNo: 1,
  changeNote: note,
  items: [{ no: 3, text: SAMPLE_DONE_WHEN[2]!, selfCheck: 'met', note: null, evidence: [] }],
  deliverables: [], preview: null, createdAt: Date.parse(`2026-11-1${3 + round}T10:00:00+08:00`),
})
const escReview = (id: string, round: number, submissionId: string, note: string): JobReview => ({
  id, jobId: SAMPLE_ESC_JOB_ID, stage: 1, round, submissionId, reviewerId: SAMPLE_REVIEWER_ID,
  items: [{ no: 3, verdict: 'unmet', note, fixTo: null, rechecked: false }],
  carriedNote: null, spotChecked: [], createdAt: Date.parse(`2026-11-1${3 + round}T11:00:00+08:00`),
})
// P74i-m1（走查 E-8）：交回说明不再以「第 N 次交回：」开头（卡片行头已写「第 N 轮：」，
// core 拼接时会再加一次轮号），也不以句号结尾（core 在说明与核对说明之间统一补句号，避免「。。」）。
const ESC_SUBMISSIONS = [
  escSubmission('jsb_sample021', 1, '提示文字照约定写的'),
  escSubmission('jsb_sample022', 2, '换了校验的写法'),
  escSubmission('jsb_sample023', 3, '回到最初的写法并补了截图'),
]
const ESC_REVIEWS = [
  escReview('jrv_sample021', 1, 'jsb_sample021', '提示文字是「手机号格式不正确」，与约定不一致。'),
  escReview('jrv_sample022', 2, 'jsb_sample022', '按钮在格式不对时仍然可以点。'),
  escReview('jrv_sample023', 3, 'jsb_sample023', '两种问题都还在。'),
]

/** 场景 D 的主题线程：主人开场、总管派活那句话、交付卡、回执。 */
const DELIVERY_TOPIC_MESSAGES: ThreadMessage[] = [
  { id: 'm_sampled000', thread: SAMPLE_DELIVERY_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_sampled002', thread: SAMPLE_DELIVERY_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '这件事由林舟（工程师）执行，评审员在交付前对照约定核对。我已把你的原话、草图和约定第 4 版作为文件交给林舟。',
    refId: SAMPLE_DELIVERY_JOB_ID, createdAt: T.assigned, readAt: null },
  // P74i-m7（第 2 节第 3 条）：约定第 4 版固定、标题跟着新版本走时，中心在主题里落的那一句工作往来
  // （core：project/agreement-title.ts 的 topicTitleFollowText，逐字一致；from 为中心、kind 为 work、refId 为约定编号）。
  // 入口：?job=delivery 的工作往来折叠组（展开可见）。
  { id: 'm_sampled005', thread: SAMPLE_DELIVERY_TOPIC_ID, from: 'hub', kind: 'work',
    text: '主题的标题已随约定第 4 版改为「活动报名页（交付与验收）」。',
    refId: SAMPLE_DELIVERY_AGREEMENT_ID, createdAt: T.v4Locked + 60_000, readAt: null },
  { id: SAMPLE_DELIVERY_CARD_MESSAGE_ID, thread: SAMPLE_DELIVERY_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版',
    refId: `delivery:${SAMPLE_DELIVERY_JOB_ID}#1`, createdAt: TD.delivered, readAt: null },
  { id: SAMPLE_RECEIPT_CARD_MESSAGE_ID, thread: SAMPLE_DELIVERY_TOPIC_ID, from: 'hub', kind: 'job_card',
    text: '交付回执　活动报名页',
    refId: `receipt:${SAMPLE_RECEIPT_JOB_ID}`, createdAt: TD.accepted, readAt: null },
  // P74i-m6（第 1 节第 3 条）：新版本固定、去掉对外发布时，发布已经在执行或已经完成的两种主题旁白
  // （core：job/launch-removed.ts 的 launchRunningTopicText、launchDoneTopicText，逐字一致；真实数据里两句不会同时出现，
  // 这里为让走查看得到各放一条，版本号取不同的两版）。入口：?job=delivery 的工作往来折叠组（回执之后，展开可见）。
  { id: 'm_sampled003', thread: SAMPLE_DELIVERY_TOPIC_ID, from: 'hub', kind: 'work',
    text: '约定第 5 版去掉了对外发布，但这次发布已经在执行，没有中止。',
    refId: SAMPLE_DELIVERY_JOB_ID, createdAt: TD.accepted + 120_000, readAt: null },
  { id: 'm_sampled004', thread: SAMPLE_DELIVERY_TOPIC_ID, from: 'hub', kind: 'work',
    text: '约定第 6 版去掉了对外发布；这次发布在此之前已经完成。',
    refId: SAMPLE_DELIVERY_JOB_ID, createdAt: TD.accepted + 180_000, readAt: null },
]

/** 场景 E 的总管私聊：主人的委托、总管两次说明、旧卡（已选）与新卡（等你决定）。 */
const ESC_MESSAGES: ThreadMessage[] = [
  { id: 'm_samplee000', thread: SAMPLE_ESC_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_samplee003', thread: SAMPLE_ESC_CHIEF_ID, from: SAMPLE_ESC_CHIEF_ID, kind: 'chat',
    text: `「活动报名页」停在第 3 条（${SAMPLE_DONE_WHEN[2]!}），核对三轮仍未通过，在等你选一个处理办法。其余 5 条已通过核对。`,
    refId: null, createdAt: Date.parse('2026-11-16T17:00:00+08:00'), readAt: null },
  { id: SAMPLE_ESC_OLD_CARD_MESSAGE_ID, thread: SAMPLE_ESC_CHIEF_ID, from: SAMPLE_ESC_CHIEF_ID, kind: 'job_card',
    text: '第 3 条三轮未通过',
    refId: `escalation:${SAMPLE_ESC_JOB_ID}#1~0`, createdAt: Date.parse('2026-11-16T17:01:00+08:00'), readAt: null },
  { id: 'm_samplee004', thread: SAMPLE_ESC_CHIEF_ID, from: SAMPLE_ESC_CHIEF_ID, kind: 'chat',
    text: '按你选的办法修改之后，林舟仍然无法继续，需要你再选一次。',
    refId: null, createdAt: Date.parse('2026-11-17T15:00:00+08:00'), readAt: null },
  { id: SAMPLE_ESC_NEW_CARD_MESSAGE_ID, thread: SAMPLE_ESC_CHIEF_ID, from: SAMPLE_ESC_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续',
    refId: `escalation:${SAMPLE_ESC_JOB_ID}#1~1`, createdAt: Date.parse('2026-11-17T15:01:00+08:00'), readAt: null },
]

// ---------------------------------------------------------------------------
// 二点八、P74i-m1 第 3 节：交付卡其余五种状态的走查主题、带停止标记的约定样例
// ---------------------------------------------------------------------------

/**
 * P74i-m1 第 3 节第 1 条（走查 D-8）：交付卡的另外五种（已完成、未通过、三种失效）加上
 * 「约定新版本在等确认」的一张，各自作为独立的一件事种进同一个走查主题——
 * 每张卡的视图仍由 core 的视图函数按各自的记录算出（deliveryCardView），不手写视图字段。
 * 这六件事的约定 topicId 都指向未登记的主题编号，让这个走查主题不挂约定面板与进度行（它是一排状态的陈列，不是一件正在做的事）。
 */
const STATES_BASE_TIME = { firstLocked: Date.parse('2026-11-11T15:39:00+08:00') }

/** 一份已固定第 4 版的约定（六件事各一份，标题相同；id 不同是为了守住「一份约定至多一件事」）。 */
const statesAgreement = (id: string): Agreement => ({
  id, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4Locked,
  versions: [{
    no: 4, state: 'locked', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_sampleds00', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
    content: content(true), changes: [], changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。',
    cardMessageId: `m_sampleagr${id.slice(-3)}`,
    createdAt: T.v4, lockedAt: T.v4Locked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
})

/** 「约定新版本在等确认」那件事的约定：第 2 版待确认（交付卡的提示写「约定第 2 版在等你确认，确认后再验收。」）。 */
const STATES_PENDING_AGREEMENT: Agreement = {
  id: 'agr_sample0106', botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'pending', inboxId: 'i_sample0106n1', withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4,
  versions: [
    {
      no: 1, state: 'locked', source: 'draft', askOrigin: null, sourceMessageId: 'm_sampleds00', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr161',
      createdAt: T.v1, lockedAt: STATES_BASE_TIME.firstLocked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      no: 2, state: 'pending', source: 'owner_revision', askOrigin: null, sourceMessageId: 'm_sampleds00', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
      content: content(true), changes: [{ section: 'summary', kind: 'changed' }], changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。',
      cardMessageId: 'm_sampleagr162',
      createdAt: T.v4, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
    },
  ],
}

/** 每件事自己的两次交回与两次核对（复制场景 D 的记录、换成自己的编号；证据编号跟着交回走）。 */
const statesRecords = (jobId: string, suffix: string): { submissions: JobSubmission[]; reviews: JobReview[] } => ({
  submissions: [
    { ...sampleDeliverySubmission1, id: `jsb_sample${suffix}1`, jobId },
    { ...sampleDeliverySubmission2, id: `jsb_sample${suffix}2`, jobId },
  ],
  reviews: [
    { ...sampleDeliveryReview1, id: `jrv_sample${suffix}1`, jobId, submissionId: `jsb_sample${suffix}1` },
    { ...sampleDeliveryReview2, id: `jrv_sample${suffix}2`, jobId, submissionId: `jsb_sample${suffix}2` },
  ],
})

/** 一件「已交付」的事：六种状态只差 state 与几条收尾记录，其余字段一致。 */
const statesJob = (no: number, agreementId: string, extra: Partial<Job>): Job => ({
  id: `job_sample00${no}`, chiefId: SAMPLE_CHIEF_ID, agreementId,
  projectId: 'prj_samplejob', topicId: SAMPLE_DELIVERY_STATES_TOPIC_ID, folder: `jobs/job_sample00${no}`,
  state: 'awaiting_owner', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 2, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 9, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  delivery: { stage: 1, cardMessageId: `m_sampleds1${no}`, checks: [{ no: 5, ok: true }], rev: 0 },
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: TD.delivered, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TD.delivered,
  ...extra,
} as Job)

/** 六件事：已完成、未通过、约定已更新、已重新交付（更早的一张）、已停止、等约定确认。 */
export const sampleDeliveryStatesJobs: Job[] = [
  statesJob(11, 'agr_sample0101', { state: 'done', acceptedAt: TD.accepted, updatedAt: TD.accepted }),
  statesJob(12, 'agr_sample0102', {
    ownerReturns: [{ stage: 1, items: [{ no: 4, text: SAMPLE_DONE_WHEN[3]!, problem: '名单只有 2 行，少一行。', fixTo: '补一条测试报名后重新交付名单。' }],
      missed: '核对只看了截图，没有重新数行数。', messageId: null, at: TD.delivered + 3600_000 }],
  }),
  // 约定改过之后这件事进入第 2 阶段：第 1 阶段那张交付卡显示「已失效：约定已更新」。
  statesJob(13, 'agr_sample0103', { state: 'checking', stage: 2 }),
  // 同一阶段重新交付（最新一张修订号是 1）：更早那张（refId 里 ~0）显示「已失效：已重新交付」。
  statesJob(14, 'agr_sample0104', { delivery: { stage: 1, cardMessageId: 'm_sampleds14', checks: [{ no: 5, ok: true }], rev: 1 } }),
  statesJob(15, 'agr_sample0105', { state: 'stopped', stoppedAt: TD.delivered + 7200_000 }),
  statesJob(16, 'agr_sample0106', {}),
]

/** 六件事的记录（交回与核对），种进内存环境用。 */
export const sampleDeliveryStatesRecords = sampleDeliveryStatesJobs.map((job, index) => statesRecords(job.id, `10${index + 1}`))

/** 走查主题的消息：主人开场、总管派活那句话，然后六张交付卡（各自的事，各自的状态）。 */
const DELIVERY_STATES_MESSAGES: ThreadMessage[] = [
  { id: 'm_sampleds00', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_sampleds01', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'reply',
    text: '这件事由林舟（工程师）执行，评审员在交付前对照约定核对。我已把你的原话、草图和约定第 4 版作为文件交给林舟。',
    refId: sampleDeliveryStatesJobs[0]!.id, createdAt: T.assigned, readAt: null },
  { id: 'm_sampleds11', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0011#1', createdAt: TD.delivered, readAt: null },
  { id: 'm_sampleds12', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0012#1', createdAt: TD.delivered + 600_000, readAt: null },
  { id: 'm_sampleds13', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0013#1', createdAt: TD.delivered + 1200_000, readAt: null },
  { id: 'm_sampleds14', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0014#1~0', createdAt: TD.delivered + 1800_000, readAt: null },
  { id: 'm_sampleds15', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0015#1', createdAt: TD.delivered + 2400_000, readAt: null },
  { id: 'm_sampleds16', thread: SAMPLE_DELIVERY_STATES_TOPIC_ID, from: SAMPLE_CHIEF_ID, kind: 'job_card',
    text: '活动报名页　按约定第 4 版', refId: 'delivery:job_sample0016#1', createdAt: TD.delivered + 3000_000, readAt: null },
]

/**
 * P74i-m1 第 3 节第 3 条（走查 I-6）：带停止标记（stopLine）的待确认约定。
 * 主人让停下，总管出最后一版约定（第 2 版待确认、写明「确认后这件事停止」）；
 * 约定卡最上面多一行 stopLine、私聊状态行与「待你处理」条目的说明各换成停止那两句。
 */
const STOP_AGREEMENT: Agreement = {
  id: SAMPLE_STOP_AGREEMENT_ID, botId: SAMPLE_STOP_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', originThread: SAMPLE_STOP_CHIEF_ID,
  title: '活动报名页', state: 'pending', inboxId: 'i_samplest1in1', withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4,
  versions: [
    {
      no: 1, state: 'locked', source: 'draft', askOrigin: null, sourceMessageId: 'm_samplest00', sourceThread: SAMPLE_STOP_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '', cardMessageId: 'm_sampleagr171',
      createdAt: T.v1, lockedAt: STATES_BASE_TIME.firstLocked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
    },
    {
      // 第 2 版：待确认、写明这件事停止（stopsJob 由 core 换算成约定卡最上面的 stopLine 一行）。
      no: 2, state: 'pending', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_samplest00', sourceThread: SAMPLE_STOP_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '按你的指示这件事到此为止；确认后停止，已做出来的东西保留。',
      cardMessageId: SAMPLE_STOP_CARD_MESSAGE_ID,
      createdAt: T.v4, lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
      stopsJob: true,
    },
  ],
}

/** 停止样例的事：还在执行中（确认前照常在做），没有暂停记录（约定卡只有 stopLine 一行，不带两栏）。 */
export const sampleStopJob: Job = {
  id: 'job_sample0017', chiefId: SAMPLE_STOP_CHIEF_ID, agreementId: SAMPLE_STOP_AGREEMENT_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', folder: 'jobs/job_sample0017',
  state: 'doing', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 0, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 6, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: T.v4,
}

/** 停止样例的总管私聊：主人的话、总管的说明、待确认的约定卡（带 stopLine）。 */
const STOP_MESSAGES: ThreadMessage[] = [
  { id: 'm_samplest00', thread: SAMPLE_STOP_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '这个报名页不用继续做了，停了吧。名单和已经做出来的页面保留。',
    refId: null, createdAt: T.v4 - 120_000, readAt: null },
  { id: 'm_samplest02', thread: SAMPLE_STOP_CHIEF_ID, from: SAMPLE_STOP_CHIEF_ID, kind: 'chat',
    text: '收到。我出了最后一版约定，写明确认后这件事停止、已经做出来的东西保留在项目文件夹里。确认前林舟照常在做。',
    refId: null, createdAt: T.v4, readAt: null },
  { id: SAMPLE_STOP_CARD_MESSAGE_ID, thread: SAMPLE_STOP_CHIEF_ID, from: SAMPLE_STOP_CHIEF_ID, kind: 'agreement',
    text: '约定「活动报名页」第 2 版', refId: SAMPLE_STOP_AGREEMENT_ID, createdAt: T.v4 + 60_000, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点九、P74i-m1（第二次）第 3 节第 2 条：审批卡的三种样例
// ---------------------------------------------------------------------------

/**
 * 审批样例的关键时刻（北京时间）：普通审批提交、发布审批提交、发布审批作废。
 * 发布审批挂在已验收的 job_sample0019 上（createdAt 不早于验收时间，isLaunchApproval 才为真）。
 */
const TA = {
  accepted: Date.parse('2026-11-17T18:05:00+08:00'),
  normalApproval: Date.parse('2026-11-16T14:00:00+08:00'),
  launchApproval: Date.parse('2026-11-17T18:10:00+08:00'),
  voidedApproval: Date.parse('2026-11-17T18:20:00+08:00'),
  // P74i-m3（第 8 节第 2 条）：一张已过期的普通审批（主人 24 小时内没处理，过期视为拒绝；不是中心作废的）。
  expiredApproval: Date.parse('2026-11-15T09:00:00+08:00'),
}

/** 发布审批所属的事：已验收、约定里有发布这一步（launch 为真的判断只看 launchStep 与 acceptedAt）。 */
const APPROVAL_JOB: Job = {
  id: 'job_sample0019', chiefId: SAMPLE_APPROVAL_CHIEF_ID, agreementId: 'agr_sample0115',
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', folder: 'jobs/job_sample0019',
  state: 'done', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 2, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 9, turnCap: 16,
  launch: { state: 'approval', approvalId: 'ap_sample0002', link: null }, inboxId: null,
  delivery: { stage: 1, cardMessageId: null, checks: [{ no: 5, ok: true }], rev: 0 },
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: TD.delivered, acceptedAt: TA.accepted, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TA.accepted,
}

/** 发布审批那份约定：第 1 版已固定。 */
const APPROVAL_JOB_AGREEMENT: Agreement = {
  id: 'agr_sample0115', botId: SAMPLE_APPROVAL_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', originThread: SAMPLE_APPROVAL_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: STATES_BASE_TIME.firstLocked,
  versions: [{
    no: 1, state: 'locked', source: 'draft', askOrigin: null, sourceMessageId: 'm_sampleap000', sourceThread: SAMPLE_APPROVAL_CHIEF_ID, wakeId: null,
    // P74i-m5：约定写了对外发布（launch.how），发布审批的一句话按它拼（核心 launchApprovalSentence）。
    content: { ...content(false), launch: { how: '发到内网演示地址，把地址发给你' } }, changes: [], changeNote: '', cardMessageId: 'm_sampleagr90',
    createdAt: T.v1, lockedAt: STATES_BASE_TIME.firstLocked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
}

/** 审批记录的三条：普通的（挂在场景 A 那件事上，带三行说明与「由某某执行」）、发布审批、已作废的发布审批。 */
const HASH = 'a'.repeat(64)
const APPROVALS = [
  { // 普通审批：属于场景 A 的事（job_sample0001，未验收，launch 为假）；C 类，带三行说明。
    id: 'ap_sample0001', botId: SAMPLE_EXECUTOR_ID, actionClass: 'C' as const, tool: 'write',
    actionText: '把排查结论写进共享目录的交接文件', actionTextVersion: 3 as const,
    ownerReason: '把数据日报排查的阶段性结论写到共享目录，同伴复用',
    riskNote: '写入后共享目录里的同伴都能看到这份文件。',
    argsPreview: '{"path":"/projects/weekly-report/交接.md"}', contentHash: HASH,
    why: '同伴下次排查同样问题时不用从头再来', status: 'pending' as const,
    createdAt: TA.normalApproval, decidedAt: null, expiresAt: TA.normalApproval + 24 * 3600_000, usedAt: null, topicId: null,
  },
  { // 发布审批：job_sample0019 已验收、约定有发布这一步，createdAt 不早于验收时间，launch 为真。
    id: 'ap_sample0002', botId: SAMPLE_EXECUTOR_ID, actionClass: 'C' as const, tool: 'hub_outbox_execute',
    // P74i-m5（第 0 步）：核心 P74r13 起，发布审批的一句话固定为「按约定对外发布：{约定里的发布方式}」，
    // 风险提示是运行命令那一类的固定句（末句「不确定这条命令的作用时，请拒绝。」）。
    actionText: '按约定对外发布：发到内网演示地址，把地址发给你', actionTextVersion: 3 as const,
    ownerReason: '页面已按约定做完并验收，发布后你能拿到访问地址',
    // P74r20（第 2 节第 1 条）：换成核心 P74r18b 之后生成的句子（core 的 hostCommandRiskNote('林舟', true) 的输出；
    // 与下面 SAMPLE_LAUNCH_RISK_NOTE 同一句，那个常量定义在文件后部，这里不能提前引用，所以再写一遍，由测试对照核心输出）。
    riskNote: '批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。',
    argsPreview: '{"kind":"run_command","command":"publish.sh 活动报名页"}', contentHash: HASH,
    why: '约定写了对外发布另行确认，这一步需要你批准', status: 'pending' as const,
    createdAt: TA.launchApproval, decidedAt: null, expiresAt: TA.launchApproval + 24 * 3600_000, usedAt: null, topicId: null,
  },
  { // 已作废的审批（P74r9 之后的口径）：作废的是事情结束时还开着的普通审批，发布审批不会被作废（launch 为假）；
    // 这张是执行中提交、验收通过时还没人处理的写入申请，中心把它作废（状态「已过期」加 voided）。
    id: 'ap_sample0003', botId: SAMPLE_EXECUTOR_ID, actionClass: 'C' as const, tool: 'write',
    actionText: '把联调用的临时配置写进共享目录', actionTextVersion: 3 as const,
    ownerReason: '联调时需要同伴也能读到这份配置',
    riskNote: '写入后共享目录里的同伴都能看到这份文件。',
    argsPreview: '{"path":"/projects/weekly-report/联调配置.md"}', contentHash: HASH,
    why: '联调结束后不再需要，验收通过时这一步已无意义', status: 'expired' as const, voided: true,
    createdAt: TA.voidedApproval, decidedAt: null, expiresAt: TA.voidedApproval + 24 * 3600_000, usedAt: null, topicId: null,
  },
  { // P74i-m3（第 8 节第 2 条）：已过期的普通审批——到期没人处理，状态「已过期」，没有 voided 标记（与已作废区分）。
    id: 'ap_sample0004', botId: SAMPLE_EXECUTOR_ID, actionClass: 'C' as const, tool: 'write',
    actionText: '把测试截图归档到共享目录', actionTextVersion: 3 as const,
    ownerReason: '截图留档，之后复查时同伴能直接看到',
    riskNote: '写入后共享目录里的同伴都能看到这些截图。',
    argsPreview: '{"path":"/projects/weekly-report/截图归档/"}', contentHash: HASH,
    why: '同伴复查时不用再重新截图', status: 'expired' as const,
    createdAt: TA.expiredApproval, decidedAt: null, expiresAt: TA.expiredApproval + 24 * 3600_000, usedAt: null, topicId: null,
  },
]

/** 审批的三行说明（费用、能否撤回、批准之后；approvalNotes 旁表，core 的视图从这里取）。 */
const APPROVAL_NOTES = [
  { id: 'ap_sample0001', cost: '不花钱，约 1 分钟', undo: '可以删掉这份文件', after: '共享目录里多一份交接文件', jobId: SAMPLE_JOB_ID, createdAt: TA.normalApproval },
  { id: 'ap_sample0002', cost: '不花钱，约 2 分钟', undo: '发布后可以下线这个地址', after: '你拿到内网访问地址，能打开页面', jobId: 'job_sample0019', createdAt: TA.launchApproval },
  { id: 'ap_sample0003', cost: '不花钱，约 1 分钟', undo: '可以删掉这份文件', after: '共享目录里多一份联调配置', jobId: 'job_sample0019', createdAt: TA.voidedApproval },
  { id: 'ap_sample0004', cost: '不花钱，约 1 分钟', undo: '可以删掉这些截图', after: '共享目录里多一个截图归档文件夹', jobId: SAMPLE_JOB_ID, createdAt: TA.expiredApproval },
]

/** 审批的「待你处理」条目：普通与发布审批开着（进收件箱视图）；已作废的不开（只在对话里看到）。 */
const APPROVAL_INBOX = [
  { id: 'i_sampleap0001', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: '批准：把排查结论写进共享目录的交接文件',
    body: '把排查结论写进共享目录的交接文件\nC 类：同伴下次排查同样问题时不用从头再来\n原始参数（供核对）：{"path":"/projects/weekly-report/交接.md"}',
    options: [], defaultOption: null, priority: 'P1' as const,
    refId: 'ap_sample0001', subjectKey: 'approval:ap_sample0001', status: 'open' as const, answer: null, pushed: false,
    createdAt: TA.normalApproval, expiresAt: TA.normalApproval + 24 * 3600_000, answeredAt: null },
  { id: 'i_sampleap0002', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: '批准：按约定对外发布：发到内网演示地址，把地址发给你',
    body: '按约定对外发布：发到内网演示地址，把地址发给你\nC 类：约定写了对外发布另行确认，这一步需要你批准\n原始参数（供核对）：{"kind":"run_command","command":"publish.sh 活动报名页"}',
    options: [], defaultOption: null, priority: 'P1' as const,
    refId: 'ap_sample0002', subjectKey: 'approval:ap_sample0002', status: 'open' as const, answer: null, pushed: false,
    createdAt: TA.launchApproval, expiresAt: TA.launchApproval + 24 * 3600_000, answeredAt: null },
  // 已作废的：状态「已过期」（不是 open，不进收件箱视图），线程里那张卡由界面按 voided 写「已作废」。
  { id: 'i_sampleap0003', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: '批准：把联调用的临时配置写进共享目录',
    body: '把联调用的临时配置写进共享目录\nC 类：联调结束后不再需要，验收通过时这一步已无意义\n原始参数（供核对）：{"path":"/projects/weekly-report/联调配置.md"}',
    options: [], defaultOption: null, priority: 'P1' as const,
    refId: 'ap_sample0003', subjectKey: 'approval:ap_sample0003', status: 'expired' as const, answer: null, pushed: false,
    createdAt: TA.voidedApproval, expiresAt: TA.voidedApproval + 24 * 3600_000, answeredAt: null },
  // P74i-m3（第 8 节第 2 条）：已过期的普通审批（到期按默认处理：拒绝；不进收件箱视图，只在对话里看到）。
  { id: 'i_sampleap0004', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: '批准：把测试截图归档到共享目录',
    body: '把测试截图归档到共享目录\nC 类：同伴复查时不用再重新截图\n原始参数（供核对）：{"path":"/projects/weekly-report/截图归档/"}',
    options: [], defaultOption: null, priority: 'P1' as const,
    refId: 'ap_sample0004', subjectKey: 'approval:ap_sample0004', status: 'expired' as const, answer: '拒绝', pushed: false,
    createdAt: TA.expiredApproval, expiresAt: TA.expiredApproval + 24 * 3600_000, answeredAt: null },
]

/** 审批样例的总管私聊：主人开场、总管说明，然后三张审批卡（消息的 refId 是收件箱条目编号）。 */
const APPROVAL_MESSAGES: ThreadMessage[] = [
  { id: 'm_sampleap000', thread: SAMPLE_APPROVAL_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '报名页做完后发到内网演示地址给我看一眼。', refId: null, createdAt: T.v1, readAt: T.v1 },
  // P74i-m3（第 8 节第 2 条）：时间上早于其余几张，消息顺序与时间一致。
  { id: 'm_sampleap006', thread: SAMPLE_APPROVAL_CHIEF_ID, from: 'hub', kind: 'approval',
    text: '批准：把测试截图归档到共享目录', refId: 'i_sampleap0004', createdAt: TA.expiredApproval + 60_000, readAt: null },
  { id: 'm_sampleap001', thread: SAMPLE_APPROVAL_CHIEF_ID, from: SAMPLE_APPROVAL_CHIEF_ID, kind: 'chat',
    text: '林舟在做这件事时想往共享目录写一份交接文件，这一步需要你批准；页面验收后的发布我也会另外请你批准。',
    refId: null, createdAt: TA.normalApproval, readAt: null },
  { id: 'm_sampleap002', thread: SAMPLE_APPROVAL_CHIEF_ID, from: 'hub', kind: 'approval',
    text: '批准：把排查结论写进共享目录的交接文件', refId: 'i_sampleap0001', createdAt: TA.normalApproval + 60_000, readAt: null },
  { id: 'm_sampleap003', thread: SAMPLE_APPROVAL_CHIEF_ID, from: SAMPLE_APPROVAL_CHIEF_ID, kind: 'chat',
    text: '「活动报名页」已按约定验收。发布这一步需要你批准，批准后林舟把它发到内网演示地址。',
    refId: null, createdAt: TA.launchApproval, readAt: null },
  { id: 'm_sampleap004', thread: SAMPLE_APPROVAL_CHIEF_ID, from: 'hub', kind: 'approval',
    text: '批准：按约定对外发布：发到内网演示地址，把地址发给你', refId: 'i_sampleap0002', createdAt: TA.launchApproval + 60_000, readAt: null },
  { id: 'm_sampleap005', thread: SAMPLE_APPROVAL_CHIEF_ID, from: 'hub', kind: 'approval',
    text: '批准：把联调用的临时配置写进共享目录', refId: 'i_sampleap0003', createdAt: TA.voidedApproval + 60_000, readAt: null },
  // P74i-m6（第 1 节第 4 条）：发布准备的回合被中心结束时，总管私聊里落的那句话
  // （core：job/chain-turn-end.ts 的 launchTurnEndedText，逐字一致；真实数据里是总管自己发的 reply）。
  // 说的是另一件事（报名名单导出），与上面那件待批准发布的事互不相干。入口：?job=approval 的总管私聊。
  { id: 'm_sampleap007', thread: SAMPLE_APPROVAL_CHIEF_ID, from: SAMPLE_APPROVAL_CHIEF_ID, kind: 'reply',
    text: '林舟准备发布「报名名单导出」的回合超过 60 分钟，中心已结束它，这次没有发布。',
    refId: 'job_sample0033', createdAt: TA.voidedApproval + 120_000, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点九补、P74i-m6 第 2 节：进度行的两个状态小标签（发布这一步没有进行）
// ---------------------------------------------------------------------------

/**
 * 两件已验收、发布这一步没有进行的事（launch.state 为 declined）：
 * - job_sample0034：主人自己点了「暂不发布」（endedBy 为 owner），进度行状态小标签 `已完成（你暂不发布）`；
 *   入口：?job=review（挂在「活动报名页（交回与核对）」主题上，约定面板与进度行因此出现）；
 * - job_sample0035：中心结束了发布这一步（endedBy 为 hub，例如发布准备的回合被中心结束），
 *   进度行状态小标签 `已完成（没有发布）`；入口：?job=delivery-states（挂在「交付的各种状态」主题上）。
 * 小标签由核心的 jobProgressView 按这两个字段生成，界面原样显示（JobProgress.tsx），样例不手写视图字段。
 */
const declinedAgreement = (id: string, topicId: string): Agreement => ({
  id, botId: SAMPLE_CHIEF_ID,
  projectId: 'prj_samplejob', topicId, originThread: SAMPLE_CHIEF_ID,
  title: '活动报名页', state: 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: T.v4Locked,
  versions: [{
    no: 4, state: 'locked', source: 'owner_instruction', askOrigin: null, sourceMessageId: 'm_samplec001', sourceThread: SAMPLE_CHIEF_ID, wakeId: null,
    content: content(true), changes: [], changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。',
    cardMessageId: `m_sampleagr${id.slice(-3)}`,
    createdAt: T.v4, lockedAt: T.v4Locked, lockedVia: 'button', confirmMessageId: null, choices: null, adoption: null,
  }],
})
const declinedJob = (no: number, agreementId: string, topicId: string, endedBy: 'owner' | 'hub'): Job => ({
  id: `job_sample00${no}`, chiefId: SAMPLE_CHIEF_ID, agreementId,
  projectId: 'prj_samplejob', topicId, folder: `jobs/job_sample00${no}`,
  state: 'done', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [5], launchStep: true,
  stage: 1, round: 2, blocked: null, pause: null,
  openAsk: null, unmet: [], turnsUsed: 9, turnCap: 16,
  launch: { state: 'declined', approvalId: null, link: null, endedBy }, inboxId: null,
  delivery: { stage: 1, cardMessageId: null, checks: [{ no: 5, ok: true }], rev: 0 },
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: TD.delivered, acceptedAt: TD.accepted, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TD.accepted + 600_000,
})
const DECLINED_OWNER_AGREEMENT = declinedAgreement('agr_sample0118', SAMPLE_REVIEW_TOPIC_ID)
const DECLINED_HUB_AGREEMENT = declinedAgreement('agr_sample0119', SAMPLE_DELIVERY_STATES_TOPIC_ID)
export const sampleDeclinedByOwnerJob: Job = declinedJob(34, 'agr_sample0118', SAMPLE_REVIEW_TOPIC_ID, 'owner')
export const sampleDeclinedByHubJob: Job = declinedJob(35, 'agr_sample0119', SAMPLE_DELIVERY_STATES_TOPIC_ID, 'hub')

// ---------------------------------------------------------------------------
// 二点十、P74i-m1（第二次）第 3 节第 4 条：说明卡各种状态的样例
// ---------------------------------------------------------------------------

/** 说明卡状态样例的时刻（北京时间）：各次受阻与说明。 */
const TS = {
  blocked1: Date.parse('2026-11-16T09:00:00+08:00'),
  esc1: Date.parse('2026-11-16T10:00:00+08:00'),
  blocked2: Date.parse('2026-11-17T09:00:00+08:00'),
  esc2: Date.parse('2026-11-17T10:00:00+08:00'),
}

/** 状态样例的办法（与场景 E 同一批，改动由 core 的 changeLineOf 按 doneWhen 写出「选了会……」）。 */
const escStateEscalation = (extra: Partial<NonNullable<Job['escalation']>>): NonNullable<Job['escalation']> => ({
  stage: 1, rev: 0, blockedSince: TS.blocked2, versionNo: 1, kind: 'executor',
  stuckAt: '按约定写好之后，页面在手机上打不开，试了几种写法都不行。',
  no: null, noText: null,
  options: ESC_OPTIONS, suggested: 0, reason: '不改约定就能再试一次，成本最低。',
  tried: ['照约定把报名页写好，电脑上能打开', '手机上打开是空白，换了一种排版写法仍不行'],
  at: TS.esc2, chosen: null, chosenAt: null,
  ...extra,
})

/** 状态样例的事：默认受阻中（executor、与说明同一时刻），各状态只改需要改的字段。 */
const escStateJob = (no: number, agreementId: string, extra: Partial<Job>): Job => ({
  id: `job_sample00${no}`, chiefId: SAMPLE_ESC_STATES_CHIEF_ID, agreementId,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', folder: `jobs/job_sample00${no}`,
  state: 'blocked', executorId: SAMPLE_EXECUTOR_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [], launchStep: false,
  stage: 1, round: 1, blocked: { kind: 'executor', no: null, text: '页面在手机上打不开。', since: TS.blocked2, resumeTo: 'rework' },
  pause: null, openAsk: null, unmet: [], turnsUsed: 8, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  escalation: escStateEscalation({}),
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: TS.esc2,
  ...extra,
} as Job)

/** 一份已固定第 1 版的约定；「约定在重新确认」那份另给第 2 版待确认、「约定已更新」那份固定到第 2 版。 */
const escStateAgreement = (id: string, pendingOrLocked?: 'pending' | 'locked2'): Agreement => ({
  id, botId: SAMPLE_ESC_STATES_CHIEF_ID,
  projectId: 'prj_samplejob', topicId: 'ptp_samplejob9', originThread: SAMPLE_ESC_STATES_CHIEF_ID,
  title: '活动报名页', state: pendingOrLocked === 'pending' ? 'pending' : 'locked', inboxId: null, withdrawn: null,
  createdAt: T.v1, updatedAt: TS.esc2,
  versions: [
    {
      no: 1, state: pendingOrLocked === undefined ? 'locked' : 'replaced', source: 'draft', askOrigin: null,
      sourceMessageId: 'm_samplees000', sourceThread: SAMPLE_ESC_STATES_CHIEF_ID, wakeId: null,
      content: content(false), changes: [], changeNote: '', cardMessageId: `m_sampleagr${id.slice(-3)}`,
      createdAt: T.v1, lockedAt: pendingOrLocked === undefined ? STATES_BASE_TIME.firstLocked : null, lockedVia: pendingOrLocked === undefined ? 'button' : null, confirmMessageId: null, choices: null, adoption: null,
    },
    ...(pendingOrLocked === undefined ? [] : [{
      no: 2, state: pendingOrLocked === 'pending' ? 'pending' as const : 'locked' as const, source: 'owner_instruction' as const, askOrigin: null,
      sourceMessageId: 'm_samplees000', sourceThread: SAMPLE_ESC_STATES_CHIEF_ID, wakeId: null,
      content: content(true), changes: [{ section: 'summary' as const, kind: 'changed' as const }],
      changeNote: '人数由「不限」改为「限 80 人，满额后停止报名」。',
      cardMessageId: `m_sampleagr${id.slice(-3)}b`,
      createdAt: TS.esc1, lockedAt: pendingOrLocked === 'pending' ? null : TS.esc2, lockedVia: pendingOrLocked === 'pending' ? null : 'button' as const, confirmMessageId: null, choices: null, adoption: null,
    }]),
  ],
})

/**
 * 七件事各一种状态（卡视图由 core 按记录算出，失效的判断在 job/escalation-expiry.ts）：
 * 0018 约定在重新确认（pending 第 2 版）、0020 约定已更新（固定到第 2 版）、0021 约定修改已撤销（记 withdrawn）、
 * 0022 这件事已继续进行（不再受阻）、0023 这件事已停止、0024 等你决定（有效）、0025 你选了 A（选过）。
 */
export const sampleEscalationStatesJobs: Job[] = [
  escStateJob(18, 'agr_sample0110', {}),
  escStateJob(20, 'agr_sample0111', {}),
  escStateJob(21, 'agr_sample0112', { escalation: escStateEscalation({ invalid: 'withdrawn' }) }),
  escStateJob(22, 'agr_sample0113', { state: 'doing', blocked: null, round: 0 }),
  escStateJob(23, 'agr_sample0114', { state: 'stopped', stoppedAt: TS.esc2 + 3600_000 }),
  escStateJob(24, 'agr_sample0116', {}),
  escStateJob(25, 'agr_sample0117', { escalation: escStateEscalation({ chosen: 0, chosenAt: TS.esc2 + 1800_000 }) }),
]

/** 状态样例的约定（每件事一份）。 */
export const sampleEscalationStatesAgreements: Agreement[] = [
  escStateAgreement('agr_sample0110', 'pending'),
  escStateAgreement('agr_sample0111', 'locked2'),
  escStateAgreement('agr_sample0112'),
  escStateAgreement('agr_sample0113'),
  escStateAgreement('agr_sample0114'),
  escStateAgreement('agr_sample0116'),
  escStateAgreement('agr_sample0117'),
]

/** 说明卡状态样例的总管私聊：主人开场、总管说明，然后七张三轮不过卡（各一种状态）。 */
const ESC_STATES_MESSAGES: ThreadMessage[] = [
  { id: 'm_samplees000', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。', refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_samplees001', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'chat',
    text: '这几张是同一类卡的各种状态：还在等决定的、你选过的、以及因为约定变了或事情有了变化而失效的。',
    refId: null, createdAt: TS.esc2, readAt: null },
  { id: 'm_samplees002', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0024#1', createdAt: TS.esc2 + 60_000, readAt: null },
  { id: 'm_samplees003', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0025#1', createdAt: TS.esc2 + 120_000, readAt: null },
  { id: 'm_samplees004', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0018#1', createdAt: TS.esc2 + 180_000, readAt: null },
  { id: 'm_samplees005', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0020#1', createdAt: TS.esc2 + 240_000, readAt: null },
  { id: 'm_samplees006', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0021#1', createdAt: TS.esc2 + 300_000, readAt: null },
  { id: 'm_samplees007', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0022#1', createdAt: TS.esc2 + 360_000, readAt: null },
  { id: 'm_samplees008', thread: SAMPLE_ESC_STATES_CHIEF_ID, from: SAMPLE_ESC_STATES_CHIEF_ID, kind: 'job_card',
    text: '林舟无法继续', refId: 'escalation:job_sample0023#1', createdAt: TS.esc2 + 420_000, readAt: null },
]

// ---------------------------------------------------------------------------
// 二点十一、P74i-m7（第 2 节第 2 条）：员工被中心停用之后，进度行「在等」的两种写法
// ---------------------------------------------------------------------------

/**
 * 被中心停用的样例员工（周岚，生命周期 quarantined）与两位总管：一位在岗（lifecycle 为 active）、一位同样被停用。
 * 进度行的「在等谁」由 core 的 jobProgressView 按「谁此刻不在岗」写出（isOnDutyNow 看 lifecycle），
 * 样例不手写视图字段，只种记录：
 * - job_sample0037（主题 ptp_samplejob10）：执行者周岚被停用、总管在岗，进度行 `在等：周岚（已停用）`；
 * - job_sample0038（主题 ptp_samplejob11）：执行者周岚被停用、总管也被停用，只能等主人，进度行 `在等：你`。
 * 入口：两个主题挂在已有入口的项目下，从左栏主题列表点进去看（?job=review 里的「周岚已停用」那一个、
 * ?job=delivery-states 里的「总管也已停用」那一个），不新增入口，见 applyPreviewJobEntry。
 * 其余样例员工没有 lifecycle，一律视为不在岗，但只有受阻原因为 participant_off 的事才用到「不在岗」，不影响别的样例。
 */
export const SAMPLE_SUSPENDED_BOT_ID = 'b_samplesusp1'
export const SAMPLE_SUSPENDED_WAIT_TOPIC_ID = 'ptp_samplejob10'
export const SAMPLE_SUSPENDED_YOU_TOPIC_ID = 'ptp_samplejob11'
const SUSPENDED_BOTS = [
  { id: SAMPLE_SUSPENDED_BOT_ID, name: '周岚', color: '#8a5a5a', lifecycle: 'quarantined' },
  { id: 'b_samplechiefon', name: '总管', color: '#5b6b8c', lifecycle: 'active' },
  { id: 'b_samplechiefoff', name: '总管', color: '#5b6b8c', lifecycle: 'quarantined' },
]
/** 周岚被停用的时刻（北京时间）。 */
const T_SUSPENDED = Date.parse('2026-11-13T14:30:00+08:00')
const suspendedAgreement = (id: string, topicId: string, chiefId: string): Agreement => ({
  ...declinedAgreement(id, topicId), botId: chiefId, originThread: chiefId,
})
const suspendedJob = (no: number, agreementId: string, topicId: string, chiefId: string): Job => ({
  id: `job_sample00${no}`, chiefId, agreementId,
  projectId: 'prj_samplejob', topicId, folder: `jobs/job_sample00${no}`,
  state: 'blocked', executorId: SAMPLE_SUSPENDED_BOT_ID, reviewerId: SAMPLE_REVIEWER_ID,
  dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [], launchStep: false,
  stage: 1, round: 0,
  // 与 core job/participants.ts 的 blockJobsOfSuspended 同形：受阻原因 participant_off，文字「{名字}已停用」。
  blocked: { kind: 'participant_off', no: null, text: '周岚已停用', since: T_SUSPENDED, resumeTo: 'doing' },
  pause: null, openAsk: null, unmet: [], turnsUsed: 4, turnCap: 16,
  launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
  firstLockedAt: STATES_BASE_TIME.firstLocked,
  assignedAt: T.assigned, startedAt: T.started, deliveredAt: null, acceptedAt: null, stoppedAt: null,
  createdAt: T.assigned, updatedAt: T_SUSPENDED,
})
const SUSPENDED_AGREEMENTS: Agreement[] = [
  suspendedAgreement('agr_sample0120', SAMPLE_SUSPENDED_WAIT_TOPIC_ID, 'b_samplechiefon'),
  suspendedAgreement('agr_sample0121', SAMPLE_SUSPENDED_YOU_TOPIC_ID, 'b_samplechiefoff'),
]
const SUSPENDED_JOBS: Job[] = [
  suspendedJob(37, 'agr_sample0120', SAMPLE_SUSPENDED_WAIT_TOPIC_ID, 'b_samplechiefon'),
  suspendedJob(38, 'agr_sample0121', SAMPLE_SUSPENDED_YOU_TOPIC_ID, 'b_samplechiefoff'),
]
/** 两个主题各一条主人开场的话（线程不为空；约定卡的消息没有种，与其他样例同做法）。 */
const SUSPENDED_MESSAGES: ThreadMessage[] = [
  { id: 'm_samplesp001', thread: SAMPLE_SUSPENDED_WAIT_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
  { id: 'm_samplesp002', thread: SAMPLE_SUSPENDED_YOU_TOPIC_ID, from: 'owner', kind: 'chat',
    text: '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。',
    refId: null, createdAt: T.v1, readAt: T.v1 },
]

// ---------------------------------------------------------------------------
// 二点十一、P74r20 第 2 节：发布这一步各种结果的样例
// ---------------------------------------------------------------------------

/**
 * 发布这一步的五种状态各一份（前三张修复卡 P74r18a、P74r18b、P74r19 之后才有的状态）：
 * 1 已批准、中心正在运行发布命令（job_sample0040，进度行「在等」写「中心运行发布命令」）；
 * 2 发布没有成功（job_sample0041，进度行「已完成（发布没有成功）」，主题与总管私聊各一句「没有发布成功：……」）；
 * 3 发布成功（job_sample0042，主题与总管私聊各一句「已发布：……」）；
 * 4 被取代而作废的发布审批（总管私聊里 ap_sample0010：执行者提交了新的发布命令，旧的作废，卡上写原因）；
 * 5 发布结束时作废的普通审批（总管私聊里 ap_sample0015：这件事的发布已结束）。
 * 另加第 6 种：发布没有成功之后执行者说做不了（job_sample0043，总管私聊落固定的一句，主题里「这件事没有发布。」）。
 * 入口：?job=launch（总管私聊是主线程，四个主题挂在左栏的主题列表里，点进去看进度行）。
 *
 * 做法与本文件其他样例相同：只写「记录」，视图一律由 core 的视图函数生成；
 * 记录里给主人看的句子与 core 现在的输出逐字一致（core 没有把生成函数放进公开出口，所以这里写死，
 * 由 test/p74r20-launch-fixture.test.ts 对照 core 的函数逐字检查）：
 * - 审批卡风险提示：core 的 gate/host-writable.ts hostCommandRiskNote；
 * - 成功、失败的两句：core 的 job/launch-result.ts launchSucceededText、launchFailedText；
 * - 失败之后做不了的固定句：core 的 job/launch-blocked.ts launchFailedBlockedText；
 * - 作废原因：core 的 job/void-job-approvals.ts VOID_LAUNCH_REPLACED_TEXT、VOID_JOB_LAUNCH_ENDED_TEXT。
 */
export const SAMPLE_LAUNCH_CHIEF_ID = 'b_samplechief7'
export const SAMPLE_LAUNCH_RUNNING_TOPIC_ID = 'ptp_samplejob12'
export const SAMPLE_LAUNCH_FAILED_TOPIC_ID = 'ptp_samplejob13'
export const SAMPLE_LAUNCH_DONE_TOPIC_ID = 'ptp_samplejob14'
export const SAMPLE_LAUNCH_GIVEUP_TOPIC_ID = 'ptp_samplejob15'

/** 约定里写的发布方式（成功那一句里逐字出现）。 */
export const SAMPLE_LAUNCH_HOW = '发到内网演示地址，把地址发给你'
/** 审批卡的风险提示：core 的 hostCommandRiskNote('林舟', true) 的输出。 */
export const SAMPLE_LAUNCH_RISK_NOTE = '批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。'
/**
 * P81：约定里写了发布位置（本机文件夹）时的两句样例（core 生成的句子，测试对照 core 的输出）：
 * 约定卡上发布那一行之后的「发布到本机文件夹：{显示路径}」，和审批卡风险提示里多出这个文件夹的那一句。
 */
export const SAMPLE_LAUNCH_LOCAL_HOME = '/Users/sample'
export const SAMPLE_LAUNCH_LOCAL_DIR = '/Users/sample/Desktop/活动报名页'
export const SAMPLE_LAUNCH_LOCAL_HOW = '复制到桌面上的活动报名页文件夹'
export const SAMPLE_LAUNCH_LOCAL_DIR_LINE = '发布到本机文件夹：~/Desktop/活动报名页'
/** P81r1：发布位置已存在、里面有文件时的那一行，以及改了位置时的「原来的位置」那一行（样例数据携带）。 */
export const SAMPLE_LAUNCH_LOCAL_DIR_FILES_LINE = '发布到本机文件夹：~/Desktop/活动报名页（已有文件夹，发布命令可以修改和删除其中的文件）'
export const SAMPLE_LAUNCH_LOCAL_DIR_PREV_LINE = '原来的位置：~/Desktop/旧版活动报名页'
/** 「原来的位置」那一行里用到的旧路径（样例数据携带）。 */
export const SAMPLE_LAUNCH_LOCAL_DIR_OLD = `${SAMPLE_LAUNCH_LOCAL_HOME}/Desktop/旧版活动报名页`
export const SAMPLE_LAUNCH_LOCAL_RISK_NOTE = '批准后这条命令只能写入：林舟的文件夹、共享文件夹、项目文件夹、本机临时文件夹、~/Desktop/活动报名页；可以联网。不确定这条命令的作用时，请拒绝。'
/** 总管私聊与主题里的几句（逐字，见上）。 */
export const SAMPLE_LAUNCH_FAILED_TEXT = '「会员定价页」没有发布成功：要发布到的位置写不进去。'
export const SAMPLE_LAUNCH_DONE_TEXT = `「报名名单导出」已发布：${SAMPLE_LAUNCH_HOW}。`
export const SAMPLE_LAUNCH_GIVEUP_FAILED_TEXT = '「活动海报页」没有发布成功：要发布到的位置写不进去。'
export const SAMPLE_LAUNCH_GIVEUP_TEXT = '活动海报页没有发布：发布命令没有运行成功，林舟无法改正。要换一个发布位置或方式时告诉我，我再安排。'
/** 作废原因（审批卡答复栏里写的话）。 */
export const SAMPLE_LAUNCH_REPLACED_REASON = '执行者提交了新的发布命令'
export const SAMPLE_LAUNCH_ENDED_REASON = '这件事的发布已结束'
/**
 * 发布这一步的其他几句给主人看的话（core 现在的输出，逐字）。样例里没有单独的状态要显示它们，
 * 放在这里是为了让 docs/copy/strings.json 的登记有样例原文可对照（check-strings 只认源码里存在的原文），
 * 并由 test/p74r20-launch-ui.test.tsx 对照 core 的函数逐字检查：
 * - failedOther：发布命令运行出错（core 的 launchFailedText 的第三种）；
 * - locationBlocked：发布命令还没运行、执行者说发布位置写不进去时，总管私聊的固定句（core 的 launchLocationBlockedText，P74r19）；
 * - ownerDeclined：主人点「暂不发布」之后主题里落的一句（core 的 LAUNCH_TOPIC_OWNER_DECLINED_TEXT）；
 * - voidedDelivered：执行者交回核对时作废他自己提交的普通审批，卡片答复栏里的原因（core 的 VOID_JOB_DELIVERED_TEXT）。
 */
export const SAMPLE_LAUNCH_OTHER_TEXTS = {
  failedOther: '「活动报名页」没有发布成功：发布命令运行出错（命令退出码 2）。',
  // P81 同步（第 4 节）：core 的固定句改了，样例里的文字跟着改（测试对照 core 的输出）。
  locationBlocked: '活动报名页没有发布：约定里没有写明发布到你电脑上的哪个文件夹，员工写不进去。做好的成果在项目文件夹里。告诉我具体的文件夹（例如桌面上的一个文件夹），我再安排。',
  ownerDeclined: '你选择了暂不发布。',
  voidedDelivered: '这件事已交回核对，这条审批不再需要，已作废',
  // P74r20 补做：失败原因是沙箱不可用、命令超时时的两句（core 的 launchFailedText 沿用出站记录里的固定说明）。
  failedSandbox: '「活动报名页」没有发布成功：沙箱不可用，宿主命令不运行',
  failedTimeout: '「活动报名页」没有发布成功：命令超时',
  // P81：运行前重新核对时发现约定的发布位置现在指向别处（core 的 launchFailedText 的固定说明，不带路径）。
  failedLocalDirChanged: '「活动报名页」没有发布成功：约定的发布位置现在指向别处，没有运行发布命令。',
} as const
/**
 * P74r20 补做：审批卡标题里各类命令的说法（core 的 gate/outward-commands.ts 的 outwardSentence 的输出）。
 * 前五句是命令在对照表里查得到专门说法时只写说法、不附命令名（P74r18a 第 4 节）；后五句是发布上线那张表，括号里是工具名（样例取 vercel、gh、twine、docker、npm）。
 */
export const SAMPLE_APPROVAL_TITLE_SENTENCES = [
  '发消息', '读写剪贴板', '用默认应用打开文件或网址', '结束其他进程', '关机或重启这台电脑',
  '把网站或服务部署到线上（vercel）', '操作代码托管平台上的仓库、合并请求或发布（gh）', '把软件包发布到公共仓库（twine）',
  '推送镜像或登录镜像仓库（docker）', '操作软件包仓库上的账号或权限（npm）',
] as const

/** 几个时刻（北京时间）：验收、旧审批、新审批、批准、发布结束。 */
const TL = {
  accepted: Date.parse('2026-11-18T10:00:00+08:00'),
  oldApproval: Date.parse('2026-11-18T10:05:00+08:00'),
  newApproval: Date.parse('2026-11-18T10:12:00+08:00'),
  approved: Date.parse('2026-11-18T10:14:00+08:00'),
  finished: Date.parse('2026-11-18T10:15:00+08:00'),
}

/** 四件事：编号、约定、主题、标题、发布状态。 */
const LAUNCH_ROWS = [
  { no: 40, agreementId: 'agr_sample0130', topicId: SAMPLE_LAUNCH_RUNNING_TOPIC_ID, title: '活动报名页', topicTitle: '活动报名页（发布命令运行中）',
    launch: { state: 'approval' as const, approvalId: 'ap_sample0011', link: null } },
  { no: 41, agreementId: 'agr_sample0131', topicId: SAMPLE_LAUNCH_FAILED_TOPIC_ID, title: '会员定价页', topicTitle: '会员定价页（发布没有成功）',
    launch: { state: 'failed' as const, approvalId: 'ap_sample0012', link: null } },
  { no: 42, agreementId: 'agr_sample0132', topicId: SAMPLE_LAUNCH_DONE_TOPIC_ID, title: '报名名单导出', topicTitle: '报名名单导出（已发布）',
    launch: { state: 'done' as const, approvalId: 'ap_sample0013', link: null } },
  { no: 43, agreementId: 'agr_sample0133', topicId: SAMPLE_LAUNCH_GIVEUP_TOPIC_ID, title: '活动海报页', topicTitle: '活动海报页（执行者无法改正）',
    launch: { state: 'declined' as const, approvalId: 'ap_sample0014', link: null, endedBy: 'hub' as const } },
]

/** 这四件事的约定：第 1 版已固定，写了对外发布（发布方式取 SAMPLE_LAUNCH_HOW）。 */
const LAUNCH_AGREEMENTS: Agreement[] = LAUNCH_ROWS.map(row => {
  const base = declinedAgreement(row.agreementId, row.topicId)
  return { ...base, botId: SAMPLE_LAUNCH_CHIEF_ID, originThread: SAMPLE_LAUNCH_CHIEF_ID, title: row.title,
    versions: base.versions.map(version => ({ ...version, content: { ...content(true), launch: { how: SAMPLE_LAUNCH_HOW } } })) }
})
/** 这四件事：都已验收，发布这一步各在不同的状态。 */
const LAUNCH_JOBS: Job[] = LAUNCH_ROWS.map(row => ({
  ...declinedJob(row.no, row.agreementId, row.topicId, 'hub'), chiefId: SAMPLE_LAUNCH_CHIEF_ID,
  acceptedAt: TL.accepted, updatedAt: TL.finished, launch: row.launch as Job['launch'],
}))

/** 审批记录：旧发布审批（作废）、新发布审批（已批准、命令在运行）、三张已用掉的、发布结束时作废的普通审批。 */
const LAUNCH_APPROVAL_BASE = { botId: SAMPLE_EXECUTOR_ID, actionClass: 'C' as const, actionTextVersion: 3 as const, contentHash: HASH, topicId: null }
// 一条 600 个字符左右的发布命令（P74r20 补做：审批卡展开「查看原始命令」要能看到全文）。命令本身存在出站记录里（LAUNCH_OUTBOX），
// 核心的审批卡视图据此给出 argsFull（全文）；argsPreview 仍由核心截到 300 字。键按字母顺序写，与核心的稳定序列化一致。
const LAUNCH_SRC = '/Users/example/AgentHub/projects/prj_samplejob/jobs/job_sample0040/交付'
const LAUNCH_COMMAND_TEXT = `mkdir -p /tmp/p74r20-site && ${['index.html', 'assets/style.css', 'assets/app.js', 'assets/logo.png']
  .map(file => `cp '${LAUNCH_SRC}/${file}' /tmp/p74r20-site/${file.split('/').pop()}`).join(' && ')}`
const LAUNCH_PAYLOAD = { args: ['-c', LAUNCH_COMMAND_TEXT], cmd: 'bash', cwd: '/Users/example/AgentHub/bots/b_samplelinzhou' }
const LAUNCH_COMMAND_PREVIEW = JSON.stringify({ commandFiles: [], kind: 'run_command', payload: LAUNCH_PAYLOAD })
/** 新发布审批（ap_sample0011）对应的出站记录：命令全文在这里（已批准，命令还没运行完）。 */
const LAUNCH_OUTBOX = {
  id: 'o_launch0011', botId: SAMPLE_EXECUTOR_ID, kind: 'run_command' as const, payload: LAUNCH_PAYLOAD, why: '按约定发布已验收的活动报名页',
  actionClass: 'C' as const, approvalId: 'ap_sample0011', status: 'ready' as const, result: null, createdAt: TL.newApproval, doneAt: null,
}
const LAUNCH_APPROVALS = [
  { ...LAUNCH_APPROVAL_BASE, id: 'ap_sample0010', tool: 'hub_outbox_execute',
    actionText: `按约定对外发布：${SAMPLE_LAUNCH_HOW}`, ownerReason: '页面已按约定做完并验收，发布后你能拿到访问地址',
    riskNote: SAMPLE_LAUNCH_RISK_NOTE, argsPreview: '{"kind":"run_command","payload":{"args":["-c","cp index.html /tmp/p74r20-site/"],"cmd":"bash"}}',
    why: '约定写了对外发布另行确认，这一步需要你批准', status: 'expired' as const, voided: true,
    createdAt: TL.oldApproval, decidedAt: TL.newApproval, expiresAt: TL.oldApproval + 24 * 3600_000, usedAt: null },
  { ...LAUNCH_APPROVAL_BASE, id: 'ap_sample0011', tool: 'hub_outbox_execute',
    actionText: `按约定对外发布：${SAMPLE_LAUNCH_HOW}`, ownerReason: '页面已按约定做完并验收，发布后你能拿到访问地址',
    riskNote: SAMPLE_LAUNCH_RISK_NOTE, argsPreview: LAUNCH_COMMAND_PREVIEW,
    why: '约定写了对外发布另行确认，这一步需要你批准', status: 'approved' as const,
    createdAt: TL.newApproval, decidedAt: TL.approved, expiresAt: TL.newApproval + 24 * 3600_000, usedAt: null },
  ...[['ap_sample0012', 41], ['ap_sample0013', 42], ['ap_sample0014', 43]].map(([id, no]) => ({ ...LAUNCH_APPROVAL_BASE, id: id as string, tool: 'hub_outbox_execute',
    actionText: `按约定对外发布：${SAMPLE_LAUNCH_HOW}`, ownerReason: '页面已按约定做完并验收', riskNote: SAMPLE_LAUNCH_RISK_NOTE,
    argsPreview: `{"kind":"run_command","payload":{"args":["-c","cp index.html /tmp/p74r20-site/"],"cmd":"bash"},"job":${no}}`,
    why: '约定写了对外发布另行确认，这一步需要你批准', status: 'used' as const,
    createdAt: TL.newApproval, decidedAt: TL.approved, expiresAt: TL.newApproval + 24 * 3600_000, usedAt: TL.approved + 1000 })),
  { ...LAUNCH_APPROVAL_BASE, id: 'ap_sample0015', tool: 'write',
    actionText: '把发布记录写进共享目录', ownerReason: '发布记录留档，同伴之后能直接看到',
    riskNote: '写入后共享目录里的同伴都能看到这份文件。', argsPreview: '{"path":"/projects/weekly-report/发布记录.md"}',
    why: '发布记录留档', status: 'expired' as const, voided: true,
    createdAt: TL.approved, decidedAt: TL.finished, expiresAt: TL.approved + 24 * 3600_000, usedAt: null },
]
/** 三行说明旁表：旧、新发布审批属于 job_sample0040；作废的普通审批属于 job_sample0042。 */
const LAUNCH_APPROVAL_NOTES = [
  { id: 'ap_sample0010', cost: '不花钱，约 2 分钟', undo: '发布后可以下线这个地址', after: '你拿到内网访问地址，能打开页面', jobId: 'job_sample0040', createdAt: TL.oldApproval },
  { id: 'ap_sample0011', cost: '不花钱，约 2 分钟', undo: '发布后可以下线这个地址', after: '你拿到内网访问地址，能打开页面', jobId: 'job_sample0040', createdAt: TL.newApproval },
  { id: 'ap_sample0015', cost: '不花钱，约 1 分钟', undo: '可以删掉这份文件', after: '共享目录里多一份发布记录', jobId: 'job_sample0042', createdAt: TL.approved },
]
/** 总管私聊里三张审批卡对应的条目：作废的（撤回，答复栏写原因）、已批准的（已答复）、作废的普通审批（撤回，答复栏写原因）。 */
const LAUNCH_INBOX = [
  { id: 'i_samplelc0010', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: `批准：按约定对外发布：${SAMPLE_LAUNCH_HOW}`,
    body: `按约定对外发布：${SAMPLE_LAUNCH_HOW}\nC 类：约定写了对外发布另行确认，这一步需要你批准`,
    options: [], defaultOption: null, priority: 'P1' as const, refId: 'ap_sample0010', subjectKey: 'approval:ap_sample0010',
    status: 'withdrawn' as const, answer: SAMPLE_LAUNCH_REPLACED_REASON, pushed: false,
    createdAt: TL.oldApproval, expiresAt: TL.oldApproval + 24 * 3600_000, answeredAt: TL.newApproval },
  { id: 'i_samplelc0011', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: `批准：按约定对外发布：${SAMPLE_LAUNCH_HOW}`,
    body: `按约定对外发布：${SAMPLE_LAUNCH_HOW}\nC 类：约定写了对外发布另行确认，这一步需要你批准`,
    options: [], defaultOption: null, priority: 'P1' as const, refId: 'ap_sample0011', subjectKey: 'approval:ap_sample0011',
    status: 'answered' as const, answer: '批准', pushed: false,
    createdAt: TL.newApproval, expiresAt: TL.newApproval + 24 * 3600_000, answeredAt: TL.approved },
  { id: 'i_samplelc0015', botId: SAMPLE_EXECUTOR_ID, type: 'approval' as const, title: '批准：把发布记录写进共享目录',
    body: '把发布记录写进共享目录\nC 类：发布记录留档',
    options: [], defaultOption: null, priority: 'P1' as const, refId: 'ap_sample0015', subjectKey: 'approval:ap_sample0015',
    status: 'withdrawn' as const, answer: SAMPLE_LAUNCH_ENDED_REASON, pushed: false,
    createdAt: TL.approved, expiresAt: TL.approved + 24 * 3600_000, answeredAt: TL.finished },
]

/** 样例里的一条消息（总管私聊或主题）；字段缺省值集中在这里。 */
const launchMessage = (id: string, thread: string, from: string, kind: ThreadMessage['kind'], text: string, createdAt: number, refId: string | null = null): ThreadMessage =>
  ({ id, thread, from, kind, text, refId, createdAt, readAt: null })
const OWNER_OPENER = '下周三要上线一个活动报名页。访客填姓名、手机号报名，我拿到一份能导出的名单。'
const LAUNCH_APPROVE_NOTE = `你批准了发布：按约定对外发布：${SAMPLE_LAUNCH_HOW}`
/** 总管私聊：开场、总管说明、三张审批卡、批准旁白，以及三件事收尾的几句话。 */
const LAUNCH_MESSAGES: ThreadMessage[] = [
  // 消息编号要符合核心的格式 m_ 加 10 位小写字母或数字：总管私聊 m_launchc001 起，主题里 m_launch4000 起。
  launchMessage('m_launchc001', SAMPLE_LAUNCH_CHIEF_ID, 'owner', 'chat', '几件做完的事验收之后，都发到内网演示地址给我看一眼。', T.v1),
  launchMessage('m_launchc002', SAMPLE_LAUNCH_CHIEF_ID, SAMPLE_LAUNCH_CHIEF_ID, 'chat', '活动报名页已验收，下一步是对外发布，需要你批准；批准前不会发布。', TL.accepted),
  launchMessage('m_launchc003', SAMPLE_LAUNCH_CHIEF_ID, 'hub', 'approval', '批准：按约定对外发布：' + SAMPLE_LAUNCH_HOW, TL.oldApproval + 60_000, 'i_samplelc0010'),
  launchMessage('m_launchc004', SAMPLE_LAUNCH_CHIEF_ID, 'hub', 'approval', '批准：按约定对外发布：' + SAMPLE_LAUNCH_HOW, TL.newApproval + 60_000, 'i_samplelc0011'),
  launchMessage('m_launchc005', SAMPLE_LAUNCH_CHIEF_ID, 'hub', 'system', LAUNCH_APPROVE_NOTE, TL.approved, 'job_sample0040'),
  launchMessage('m_launchc006', SAMPLE_LAUNCH_CHIEF_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_FAILED_TEXT, TL.finished, 'job_sample0041'),
  launchMessage('m_launchc007', SAMPLE_LAUNCH_CHIEF_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_DONE_TEXT, TL.finished + 60_000, 'job_sample0042'),
  launchMessage('m_launchc008', SAMPLE_LAUNCH_CHIEF_ID, 'hub', 'approval', '批准：把发布记录写进共享目录', TL.finished + 120_000, 'i_samplelc0015'),
  launchMessage('m_launchc009', SAMPLE_LAUNCH_CHIEF_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_GIVEUP_FAILED_TEXT, TL.finished + 180_000, 'job_sample0043'),
  launchMessage('m_launchc010', SAMPLE_LAUNCH_CHIEF_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_GIVEUP_TEXT, TL.finished + 240_000, 'job_sample0043'),
]
/** 四个主题里的话：主人开场；运行中的主题有批准旁白，失败、成功、做不了的主题各有总管的那一句，做不了的另有中心旁白。 */
const LAUNCH_TOPIC_MESSAGES: ThreadMessage[] = [
  ...LAUNCH_ROWS.map(row => launchMessage(`m_launch4${row.no - 40}00`, row.topicId, 'owner', 'chat', OWNER_OPENER, T.v1)),
  launchMessage('m_launch4001', SAMPLE_LAUNCH_RUNNING_TOPIC_ID, 'hub', 'system', LAUNCH_APPROVE_NOTE, TL.approved, 'job_sample0040'),
  launchMessage('m_launch4101', SAMPLE_LAUNCH_FAILED_TOPIC_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_FAILED_TEXT, TL.finished, 'job_sample0041'),
  launchMessage('m_launch4201', SAMPLE_LAUNCH_DONE_TOPIC_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_DONE_TEXT, TL.finished + 60_000, 'job_sample0042'),
  launchMessage('m_launch4301', SAMPLE_LAUNCH_GIVEUP_TOPIC_ID, SAMPLE_LAUNCH_CHIEF_ID, 'reply', SAMPLE_LAUNCH_GIVEUP_FAILED_TEXT, TL.finished + 180_000, 'job_sample0043'),
  launchMessage('m_launch4302', SAMPLE_LAUNCH_GIVEUP_TOPIC_ID, 'hub', 'system', '这件事没有发布。', TL.finished + 240_000, 'job_sample0043'),
]

// ---------------------------------------------------------------------------
// 三、种进 core 的内存环境，用 core 的视图函数取回样例视图
// ---------------------------------------------------------------------------

/** 造一份种好样例记录的 core 环境（假时钟定在 SAMPLE_JOB_NOW，全部留在内存）。 */
/** 种好全部「一件事」样例记录的 core 环境（P75k 起导出：复盘样例在它之上再加复盘记录，见 fixture-retro.ts）。 */
export function seededContext() {
  const ctx = testing.createTestContext({ clock: new testing.FakeClock(SAMPLE_JOB_NOW) })
  for (const bot of BOTS) ctx.store.table('bots').put(bot as never)
  ctx.store.table('projectTopics').put({
    id: SAMPLE_JOB_TOPIC_ID, projectId: 'prj_samplejob', title: SAMPLE_JOB_TOPIC_TITLE,
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.submitted1 + 60_000,
    agentTurnsSinceOwner: 2, pendingBotIds: [SAMPLE_REVIEWER_ID],
  } as never)
  ctx.store.table('projectTopics').put({
    id: 'ptp_samplejob2', projectId: 'prj_samplejob', title: SAMPLE_JOB_TOPIC_TITLE,
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.v4, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  // P74h-m1 第 2 处：场景 C 的走查主题（同一件事的交回与核对记录，独立主题避免与场景 A 的状态自相矛盾）。
  ctx.store.table('projectTopics').put({
    id: SAMPLE_REVIEW_TOPIC_ID, projectId: 'prj_samplejob', title: '活动报名页（交回与核对）',
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.reviewed2, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  // P74h-m1 第 5 处：提问样例的总管私聊对应的主题登记（约定挂在它名下，视图取标题用）。
  ctx.store.table('projectTopics').put({
    id: 'ptp_samplejob4', projectId: 'prj_samplejob', title: SAMPLE_JOB_TOPIC_TITLE,
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.v4, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  // P74i：场景 D 的主题（交付卡与回执）、场景 E 的主题登记（约定取标题用）。
  ctx.store.table('projectTopics').put({
    id: SAMPLE_DELIVERY_TOPIC_ID, projectId: 'prj_samplejob', title: '活动报名页（交付与验收）',
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: TD.accepted, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  ctx.store.table('projectTopics').put({
    id: 'ptp_samplejob6', projectId: 'prj_samplejob', title: SAMPLE_JOB_TOPIC_TITLE,
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.v4, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  // P74i-m1：交付各种状态的走查主题（六张交付卡都在这个主题的线程里）。
  ctx.store.table('projectTopics').put({
    id: SAMPLE_DELIVERY_STATES_TOPIC_ID, projectId: 'prj_samplejob', title: '活动报名页（交付的各种状态）',
    createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: TD.delivered + 3000_000, agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  ctx.store.table('agreements').put(TOPIC_AGREEMENT)
  ctx.store.table('agreements').put(B2_AGREEMENT)
  ctx.store.table('agreements').put(ASK_AGREEMENT)
  ctx.store.table('agreements').put(RECEIPT_AGREEMENT)
  ctx.store.table('agreements').put(ESC_AGREEMENT)
  // P74i-m1：交付主题自己的约定（D-12）、六种状态的交付样例、带停止标记的约定样例。
  ctx.store.table('agreements').put(DELIVERY_AGREEMENT)
  for (const id of ['agr_sample0101', 'agr_sample0102', 'agr_sample0103', 'agr_sample0104', 'agr_sample0105']) ctx.store.table('agreements').put(statesAgreement(id))
  ctx.store.table('agreements').put(STATES_PENDING_AGREEMENT)
  ctx.store.table('agreements').put(STOP_AGREEMENT)
  // P74i-m1（第二次）：审批样例与说明卡状态样例的约定。
  ctx.store.table('agreements').put(APPROVAL_JOB_AGREEMENT)
  for (const agreement of sampleEscalationStatesAgreements) ctx.store.table('agreements').put(agreement)
  // P74i-m6（第 2 节）：发布这一步没有进行的两件事（你暂不发布、没有发布）的约定。
  ctx.store.table('agreements').put(DECLINED_OWNER_AGREEMENT)
  ctx.store.table('agreements').put(DECLINED_HUB_AGREEMENT)
  // P74i-m7（第 2 节第 2 条）：被中心停用的员工、两位总管，以及两件因此受阻的事（主题、约定、事、开场的话）。
  for (const bot of SUSPENDED_BOTS) ctx.store.table('bots').put(bot as never)
  for (const [topicId, title] of [[SAMPLE_SUSPENDED_WAIT_TOPIC_ID, '活动报名页（员工已停用）'], [SAMPLE_SUSPENDED_YOU_TOPIC_ID, '活动报名页（总管也已停用）']] as const) {
    ctx.store.table('projectTopics').put({
      id: topicId, projectId: 'prj_samplejob', title,
      createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: T.v1, agentTurnsSinceOwner: 0, pendingBotIds: [],
    } as never)
  }
  for (const agreement of SUSPENDED_AGREEMENTS) ctx.store.table('agreements').put(agreement)
  for (const job of SUSPENDED_JOBS) ctx.store.table('jobs').put(job)
  for (const message of SUSPENDED_MESSAGES) ctx.store.log('thread').append(message)
  ctx.store.table('jobs').put(sampleJob)
  ctx.store.table('jobs').put(sampleB2Job)
  ctx.store.table('jobs').put(sampleAskJob)
  ctx.store.table('jobs').put(sampleDeliveryJob)
  ctx.store.table('jobs').put(sampleReceiptJob)
  ctx.store.table('jobs').put(sampleEscalationJob)
  for (const job of sampleDeliveryStatesJobs) ctx.store.table('jobs').put(job)
  ctx.store.table('jobs').put(sampleStopJob)
  // P74i-m1（第二次）：审批样例的事（发布审批挂在它名下）与说明卡状态的七件事。
  ctx.store.table('jobs').put(APPROVAL_JOB)
  for (const job of sampleEscalationStatesJobs) ctx.store.table('jobs').put(job)
  // P74i-m6（第 2 节）：发布这一步没有进行的两件事。
  ctx.store.table('jobs').put(sampleDeclinedByOwnerJob)
  ctx.store.table('jobs').put(sampleDeclinedByHubJob)
  ctx.store.table('jobSubmissions').put(sampleSubmission1)
  ctx.store.table('jobSubmissions').put(sampleSubmission2)
  ctx.store.table('jobSubmissions').put(sampleDeliverySubmission1)
  ctx.store.table('jobSubmissions').put(sampleDeliverySubmission2)
  ctx.store.table('jobSubmissions').put(sampleReceiptSubmission)
  for (const row of ESC_SUBMISSIONS) ctx.store.table('jobSubmissions').put(row)
  ctx.store.table('jobReviews').put(sampleReview1)
  ctx.store.table('jobReviews').put(sampleReview2)
  ctx.store.table('jobReviews').put(sampleDeliveryReview1)
  ctx.store.table('jobReviews').put(sampleDeliveryReview2)
  ctx.store.table('jobReviews').put(sampleReceiptReview)
  for (const row of ESC_REVIEWS) ctx.store.table('jobReviews').put(row)
  for (const record of sampleDeliveryStatesRecords) {
    for (const submission of record.submissions) ctx.store.table('jobSubmissions').put(submission)
    for (const review of record.reviews) ctx.store.table('jobReviews').put(review)
  }
  for (const row of RECEIPT_INBOX) ctx.store.table('inbox').put(row as never)
  // P74i-m4（第 5 节第 3 条）：B2 第 4 版约定的确认条目（不属于任何一件事，不进回执的计数）。
  ctx.store.table('inbox').put(B2_INBOX as never)
  // P74i-m1（第二次）：审批记录、三行说明旁表与审批的「待你处理」条目。
  for (const row of APPROVALS) ctx.store.table('approvals').put(row as never)
  for (const row of APPROVAL_NOTES) ctx.store.table('approvalNotes').put(row as never)
  for (const row of APPROVAL_INBOX) ctx.store.table('inbox').put(row as never)
  ctx.store.table('wakes').put(OPEN_WAKE as never)
  for (const event of EVENTS) ctx.store.log('jobEvents').append(event)
  for (const message of TOPIC_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of B2_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of ASK_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of REVIEW_TOPIC_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of DELIVERY_TOPIC_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of ESC_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of DELIVERY_STATES_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of STOP_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of APPROVAL_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of ESC_STATES_MESSAGES) ctx.store.log('thread').append(message)
  // P74r20（第 2 节）：发布这一步各种结果的样例——总管、四个主题、四份约定、四件事、审批与它的旁表和条目、两处的消息。
  ctx.store.table('bots').put({ id: SAMPLE_LAUNCH_CHIEF_ID, name: '总管', color: '#5b6b8c' } as never)
  for (const row of LAUNCH_ROWS) {
    ctx.store.table('projectTopics').put({
      id: row.topicId, projectId: 'prj_samplejob', title: row.topicTitle,
      createdAt: T.v1, updatedAt: SAMPLE_JOB_NOW, lastMessageAt: TL.finished, agentTurnsSinceOwner: 0, pendingBotIds: [],
    } as never)
  }
  for (const agreement of LAUNCH_AGREEMENTS) ctx.store.table('agreements').put(agreement)
  for (const job of LAUNCH_JOBS) ctx.store.table('jobs').put(job)
  for (const row of LAUNCH_APPROVALS) ctx.store.table('approvals').put(row as never)
  ctx.store.table('outbox').put(LAUNCH_OUTBOX as never)
  for (const row of LAUNCH_APPROVAL_NOTES) ctx.store.table('approvalNotes').put(row as never)
  for (const row of LAUNCH_INBOX) ctx.store.table('inbox').put(row as never)
  for (const message of LAUNCH_MESSAGES) ctx.store.log('thread').append(message)
  for (const message of LAUNCH_TOPIC_MESSAGES) ctx.store.log('thread').append(message)
  return ctx
}

/** 场景 A 的主题线程视图（约定面板、进度行、楼层与折叠分组都由 core 算出）。 */
export const sampleJobTopicThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_JOB_TOPIC_ID)

/**
 * P74i-m3（第 8 节第 3 条）：场景 A 只加载最新一页（6 条）的样子——线程只带最后 6 条消息，
 * 楼层与折叠组仍按主题的全部 9 条算（core 的 thread 视图本来就是这样）。所以：
 * 楼层列表最上面写「更早的 2 条记录还没有加载。」加「加载更早」入口，第一组工作往来
 * （4 条里已加载 3 条）展开后末尾写「这一组里更早的 1 条还没有加载。」，汇总一句写「已加载 6 条记录：……」。
 * 与 sampleJobTopicThread 是同一个主题、同一份记录，只是分页不同；用于预览入口 ?job=topic。
 */
export const samplePartialTopicThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_JOB_TOPIC_ID, { limit: 6 })

/** 场景 B2 的总管私聊（最后一张是待确认的约定卡：两栏、交付时间、退路；P74h-m1 起没有起因一行）。 */
export const sampleB2Thread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_CHIEF_ID)

/** B2 那张待确认的约定卡视图（AgreementCard 直接画它）。 */
export const sampleB2Card = sampleB2Thread.messages.at(-1)?.agreement ?? null

/**
 * P81：B2 那张约定卡带发布位置（localDir）的样子：同一份样例数据，只把最后一版的对外发布改成带本机文件夹，
 * 并给样例上下文设置主人主目录（显示路径以 ~ 开头），其余视图一律由 core 生成。预览入口 ?job=b2&local=1 用它的结果。
 */
export const sampleB2LocalDirCard = (() => {
  const ctx = seededContext()
  ;(ctx as { ownerHome?: string }).ownerHome = SAMPLE_LAUNCH_LOCAL_HOME
  const agreement = ctx.store.table('agreements').get(SAMPLE_B2_AGREEMENT_ID)
  if (agreement === null) return null
  const last = agreement.versions.length - 1
  ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map((version, index) => index === last
    ? { ...version, content: { ...version.content, launch: { how: SAMPLE_LAUNCH_LOCAL_HOW, localDir: SAMPLE_LAUNCH_LOCAL_DIR } } } : version) })
  return createUiApi(ctx, async () => {}).thread(SAMPLE_CHIEF_ID).messages.at(-1)?.agreement ?? null
})()

/**
 * P81r1：同一张约定卡，发布位置已存在并有文件（localDirHasFiles），且这一版换了位置（带 localDirPrevLine）。
 * 与 sampleB2LocalDirCard 同一做法，视图由 core 生成；预览入口 ?job=localdir 用它的结果。
 */
export const sampleB2LocalDirFilesCard = (() => {
  const ctx = seededContext()
  ;(ctx as { ownerHome?: string }).ownerHome = SAMPLE_LAUNCH_LOCAL_HOME
  const agreement = ctx.store.table('agreements').get(SAMPLE_B2_AGREEMENT_ID)
  if (agreement === null) return null
  const last = agreement.versions.length - 1
  ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map((version, index) => {
    const launch = index === last
      ? { how: SAMPLE_LAUNCH_LOCAL_HOW, localDir: SAMPLE_LAUNCH_LOCAL_DIR, localDirHasFiles: true }
      : { how: SAMPLE_LAUNCH_LOCAL_HOW, localDir: SAMPLE_LAUNCH_LOCAL_DIR_OLD }
    return { ...version, content: { ...version.content, launch } }
  }) })
  return createUiApi(ctx, async () => {}).thread(SAMPLE_CHIEF_ID).messages.at(-1)?.agreement ?? null
})()

/** 提问样例的总管私聊（P74h-m1 第 5 处）：最后一张待确认卡带「来源」「起因」两行与两栏。 */
export const sampleAskThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_ASK_CHIEF_ID)

/** 提问样例那张待确认的约定卡视图。 */
export const sampleAskCard = sampleAskThread.messages.at(-1)?.agreement ?? null

/** 场景 C 的走查主题（P74h-m1 第 2 处）：两张交回卡、两张核对卡都由 core 的线程视图排进工作往来折叠组。 */
export const sampleReviewTopicThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_REVIEW_TOPIC_ID)

// ---------------------------------------------------------------------------
// 四、场景 C 的三张卡片（core 的纯函数生成）
// ---------------------------------------------------------------------------

/** 交回卡（第 1 轮）。 */
export const sampleSubmissionCard: JobCardView = buildSubmissionCard({ submission: sampleSubmission1, agreementTitle: '活动报名页' })
/** 核对卡（第 1 轮：不通过，退回第 3 条）。 */
export const sampleReviewReturnCard: JobCardView = buildReviewCard({
  review: sampleReview1, submission: sampleSubmission1, previousRound: null,
  names: { [SAMPLE_EXECUTOR_ID]: '林舟', [SAMPLE_REVIEWER_ID]: '评审员' }, chiefId: SAMPLE_CHIEF_ID,
})
/** 核对卡（第 2 轮：通过，其余沿用第 1 轮结论）。 */
export const sampleReviewPassCard: JobCardView = buildReviewCard({
  review: sampleReview2, submission: sampleSubmission2, previousRound: 1,
  names: { [SAMPLE_EXECUTOR_ID]: '林舟', [SAMPLE_REVIEWER_ID]: '评审员' }, chiefId: SAMPLE_CHIEF_ID,
})

/** 三张卡片共用的截图定位参数（界面读截图时发给命令；样例里给假实现用）。 */
export const SAMPLE_SHOT_REF = { jobId: SAMPLE_JOB_ID, submissionId: SAMPLE_SUBMISSION_1_ID }

/** 一份清单条目（供 EvidenceList 的测试与预览按需取用）。交回、核对、交付有清单；三轮不过卡与回执没有。 */
export function sampleEvidenceItems(card: JobCardView): EvidenceItemView[] {
  // 只有白名单内且带清单的种类返回条目；复盘卡等其余种类（P75k 才画）一律返回空。
  if (!isDrawableJobCard(card)) return []
  if (card.kind === 'escalation' || card.kind === 'receipt' || card.kind === 'retro' || card.kind === 'skill_check') return []
  return card.items
}

// ---------------------------------------------------------------------------
// 五、P74i 场景 D、E、G 的视图（core 的视图函数与纯函数生成）
// ---------------------------------------------------------------------------

/** 交付卡与回执的主题线程（待你验收的交付卡、已验收那件事的回执）。 */
export const sampleDeliveryTopicThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_DELIVERY_TOPIC_ID)

/** 三轮不过卡的总管私聊（旧卡已选过 B，新卡等你决定）。 */
export const sampleEscalationThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_ESC_CHIEF_ID)

/** 主题里的交付卡（待你验收）。 */
export const sampleDeliveryAwaitingCard: JobCardView = sampleDeliveryTopicThread.messages
  .find(message => message.id === SAMPLE_DELIVERY_CARD_MESSAGE_ID)?.jobCard
  ?? buildDeliveryCard({
    jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'awaiting_owner', currentStage: 1, revision: 0, latestRevision: 0,
    agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
    checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: null, ownerReturn: null, pendingVersionNo: null,
    hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
  })

/** 已完成的交付卡（收起为一行结论加「展开证据」）。 */
export const sampleDeliveryDoneCard: JobCardView = buildDeliveryCard({
  jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'done', currentStage: 1, revision: 0, latestRevision: 0,
  agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
  checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: TD.accepted, ownerReturn: null, pendingVersionNo: null,
  hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
})

/** 未通过的交付卡（只列被指出的条目，结论小章「你判不符」）。 */
export const sampleDeliveryReturnedCard: JobCardView = buildDeliveryCard({
  jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'awaiting_owner', currentStage: 1, revision: 0, latestRevision: 0,
  agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
  checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: null,
  ownerReturn: { stage: 1, items: [{ no: 4, text: SAMPLE_DONE_WHEN[3]!, problem: '名单只有 2 行，少一行。', fixTo: '补一条测试报名后重新交付名单。' }],
    missed: '核对只看了截图，没有重新数行数。', messageId: null, at: TD.delivered + 3600_000 },
  pendingVersionNo: null, hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
})

/** 已失效的交付卡（约定已更新；只读，没有任何按钮）。 */
export const sampleDeliveryExpiredCard: JobCardView = buildDeliveryCard({
  jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'checking', currentStage: 2, revision: 0, latestRevision: 0,
  agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
  checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: null, ownerReturn: null, pendingVersionNo: null,
  hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
})

/** 已失效的交付卡（同一阶段重新交付之后，更早的一张）。 */
export const sampleDeliveryRedeliveredCard: JobCardView = buildDeliveryCard({
  jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'awaiting_owner', currentStage: 1, revision: 0, latestRevision: 1,
  agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
  checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: null, ownerReturn: null, pendingVersionNo: null,
  hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
})

/** 已失效的交付卡（这件事已停止）。 */
export const sampleDeliveryStoppedCard: JobCardView = buildDeliveryCard({
  jobId: SAMPLE_DELIVERY_JOB_ID, stage: 1, jobState: 'stopped', currentStage: 1, revision: 0, latestRevision: 0,
  agreementTitle: '活动报名页', versionNo: 4, reviews: [sampleDeliveryReview1, sampleDeliveryReview2], submissions: [sampleDeliverySubmission1, sampleDeliverySubmission2],
  checks: [{ no: 5, ok: true }], deliveredAt: TD.delivered, acceptedAt: null, ownerReturn: null, pendingVersionNo: null,
  hasPreview: true, timezone: SAMPLE_JOB_TIMEZONE,
})

/** 交付卡的其余几张（已完成、未通过、三种失效）：不进线程，供测试与预览快照携带其文字。 */
export const sampleDeliveryExtraCards: JobCardView[] = [
  sampleDeliveryDoneCard, sampleDeliveryReturnedCard, sampleDeliveryExpiredCard, sampleDeliveryRedeliveredCard, sampleDeliveryStoppedCard,
]

/** 主题里的回执（数字由 core 按记录算出）。 */
export const sampleReceiptCard: JobCardView = sampleDeliveryTopicThread.messages
  .find(message => message.id === SAMPLE_RECEIPT_CARD_MESSAGE_ID)?.jobCard
  ?? buildReceiptCard('活动报名页', [])

/**
 * B2 第 4 版约定在「待你处理」里的确认条目视图（P74i-m4，第 5 节第 3 条）：
 * 由核心的 inbox 视图函数从上面种入的记录生成，带约定编号、版本号、两栏标记（agreementJobSplit）和主题编号，
 * 与真实数据同一个形状；不再是手写的视图对象。
 */
export const sampleB2InboxEntry: InboxItemView = createUiApi(seededContext(), async () => {}).inbox().items
  .find(item => item.agreementId === SAMPLE_B2_AGREEMENT_ID)!

/** 私聊里等你决定的三轮不过卡（新说明：执行者无法继续）。 */
export const sampleEscalationCard: JobCardView = sampleEscalationThread.messages
  .find(message => message.id === SAMPLE_ESC_NEW_CARD_MESSAGE_ID)?.jobCard
  ?? buildEscalationCard({ jobId: SAMPLE_ESC_JOB_ID, escalation: sampleEscalationJob.escalation!, executorName: '林舟', reviews: [], submissions: [], doneWhen: [...SAMPLE_DONE_WHEN] })

/** 主人选过办法的旧三轮不过卡（只读，状态文字「你选了 B」）。 */
export const sampleEscalationOldCard: JobCardView = sampleEscalationThread.messages
  .find(message => message.id === SAMPLE_ESC_OLD_CARD_MESSAGE_ID)?.jobCard
  ?? buildEscalationCard({ jobId: SAMPLE_ESC_JOB_ID, escalation: sampleEscalationJob.escalationHistory![0]!, executorName: '林舟', reviews: [], submissions: [], doneWhen: [...SAMPLE_DONE_WHEN] })

/** 回执数字的期望值（与样例记录逐项对应：时长、需要你处理的次数、总管代你答复的问题、核对、约定版本；P74i-m2 走查 R-5 起约定版本为第 4 版）。 */
export const SAMPLE_RECEIPT_EXPECTED = {
  fromLockedToAccept: '6 天 2 小时',
  disturbed: '2 次',
  answered: '1 个',
  review: '1 轮，一次通过',
  versionNo: '第 4 版',
}

/**
 * 项目页「一件事」的样例行（core 的 projectJobRows 按状态排序算出；预览快照携带）。
 * P74i-m1（走查 S-5）：三件事的标题各不相同——同一张清单里能看出是哪件事，不只靠状态区分。
 */
export const sampleProjectJobRows = projectJobRows([
  { job: sampleDeliveryJob, title: '活动报名页' },
  { job: sampleReceiptJob, title: '上一期活动报名页' },
  { job: sampleEscalationJob, title: '报名页手机号校验修复' },
].map(row => ({ ...row, executorName: '林舟' })), SAMPLE_JOB_TIMEZONE)

/**
 * 侧栏总管那一行的样例（core 的 chiefJobLine：多件事在办写「n 件在办」；预览快照携带）。
 * P76j：改传新版的行（只要「这一行现在是不是在等你」），不再传旧的 { job, title }；
 * 样例里两件都不在等你，所以仍然写「2 件在办」（预览与既有断言不变）。
 */
export const sampleChiefJobLine = chiefJobLine([
  { waitingOwner: false },
  { waitingOwner: false },
])

/** 「待你处理」里一件事的四类条目样例（P74i）：标题、正文、选项与 core 建条目时写死的文字逐字一致，
 *  供预览与测试用（不种进内存环境，不影响回执的「需要你处理」计数）。
 *  P74i-m1（第二次）：条目带 jobEntry；说明条目另带 escalationCard（完整卡片视图）。 */
export const sampleJobInboxEntries: InboxItemView[] = [
  { // 验收（job:<id>:accept:<阶段>）
    id: 'i_sampleview1', botId: SAMPLE_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
    priority: 'P1' as const, topicId: SAMPLE_DELIVERY_TOPIC_ID, topicTitle: '活动报名页（交付与验收）', approvalId: null,
    title: '活动报名页：待你验收',
    body: '6 条「怎样算做完」全部符合，已逐条核对。哪条不符合，在对话里写序号和问题。',
    options: ['验收通过'], defaultOption: null,
    createdAt: TD.delivered, createdText: '11月17日 17:20', expiresText: null,
    jobEntry: { kind: 'accept', jobId: SAMPLE_DELIVERY_JOB_ID },
  },
  { // 向主人说明（三轮不过的办法）。P74i-m1（第二次，任务卡 1.1）：条目带完整的说明卡视图
    // （escalationCard，与总管私聊里那张新卡同一份数据），界面用同一个组件画，不再显示只有标题的小按钮。
    id: 'i_sampleview2', botId: SAMPLE_ESC_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
    priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
    title: '活动报名页：第 3 条三轮未通过',
    body: '第 3 条「请填写 11 位手机号」的提示文字核对三轮仍未通过，在等你选一个处理办法。',
    options: ['A　换用第三方表单服务重做这一条', 'B　把这一条改为允许提交、后台补全', 'C　删去这一条'],
    defaultOption: null, createdAt: Date.parse('2026-11-16T17:00:00+08:00'), createdText: '11月16日 17:00', expiresText: null,
    jobEntry: { kind: 'escalate', jobId: SAMPLE_ESC_JOB_ID },
    escalationCard: sampleEscalationCard.kind === 'escalation' ? sampleEscalationCard : null,
  },
  { // 回合上限（job:<id>:cap:<上限>）；P74r5：第二个按钮由「先停下」改为「暂停」。
    id: 'i_sampleview3', botId: SAMPLE_ESC_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
    priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
    title: '活动报名页：回合用到上限',
    body: '已用 16 个回合。继续做最多再用 8 个回合。',
    options: ['再给 8 个回合', '暂停'], defaultOption: null,
    createdAt: Date.parse('2026-11-17T10:00:00+08:00'), createdText: '11月17日 10:00', expiresText: null,
    jobEntry: { kind: 'cap', jobId: SAMPLE_ESC_JOB_ID },
  },
  { // 没有进展（job:<id>:stall:<序号>）；P74r5：「停住了」改「没有进展」、正文与按钮同步新说法。
    id: 'i_sampleview4', botId: SAMPLE_ESC_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
    priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
    title: '活动报名页：没有进展',
    body: '已等评审员处理 2 天，中心已提醒两次，仍没有进展。',
    options: ['再提醒一次', '暂停'], defaultOption: null,
    createdAt: Date.parse('2026-11-17T11:00:00+08:00'), createdText: '11月17日 11:00', expiresText: null,
    jobEntry: { kind: 'stall', jobId: SAMPLE_ESC_JOB_ID },
  },
]

// ---------------------------------------------------------------------------
// 六、P74i-m1 新增样例的视图（同样由 core 的视图函数生成）
// ---------------------------------------------------------------------------

/** 交付各种状态的走查主题（六张交付卡：已完成、未通过、三种失效、等约定确认）。 */
export const sampleDeliveryStatesThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_DELIVERY_STATES_TOPIC_ID)

/** 带停止标记的总管私聊（最后一张是待确认的约定卡，卡上带 stopLine 一行）。 */
export const sampleStopThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_STOP_CHIEF_ID)

/** 停止样例那张待确认的约定卡（stopLine 不为 null；AgreementCard 画在最上面那一行）。 */
export const sampleStopCard = sampleStopThread.messages.at(-1)?.agreement ?? null

/**
 * 停止样例在「待你处理」里的那一条（P74i-m1 第 3 节第 3 条，走查 I-6）：
 * 说明那一句（「不会自动按建议处理。你确认后这件事停止；确认前照常在做。」）由界面按
 * agreementStop 标记换上（P74r8 起标记由条目自己带，界面不再从线程里推断），文字不在这条样例里写死。
 */
export const sampleStopInboxEntry = {
  id: 'i_sampleview5', botId: SAMPLE_STOP_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
  priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '约定「活动报名页」第 2 版', body: '按你的指示这件事到此为止；确认后停止，已做出来的东西保留。请确认。',
  options: ['按建议，定了'], defaultOption: null,
  createdAt: T.v4, createdText: '今天 09:32', expiresText: null,
  agreementId: SAMPLE_STOP_AGREEMENT_ID, agreementVersion: 2,
  // P74r14：核心在约定确认条目的视图上带约定的标题（界面据此拼发给总管的前缀）。
  agreementTitle: '活动报名页',
  // P74r8：核心给的两个事实（这一版写明不再做；没有两栏）。
  agreementJobSplit: false, agreementStop: true,
}

// ---------------------------------------------------------------------------
// 七、P74i-m1（第二次）新增样例的视图（同样由 core 的视图函数生成）
// ---------------------------------------------------------------------------

/** 审批样例的总管私聊（三张审批卡：普通、发布、已作废的发布）。 */
export const sampleApprovalThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_APPROVAL_CHIEF_ID)

/**
 * 审批样例在「待你处理」里的条目（core 的 inbox 视图生成：普通与发布审批各一条，已作废的不在）。
 * 发布审批那条的 approval.launch 为真（按钮「批准发布」「暂不发布」由界面换上）。
 */
export const sampleApprovalInboxEntries = createUiApi(seededContext(), async () => {}).inbox().items
  .filter(item => item.type === 'approval')
  .map(item => ({ ...item, approvalId: item.approvalId }))

/** 说明卡各种状态的总管私聊（七张三轮不过卡：等你决定、你选了 A、五种失效）。 */
export const sampleEscalationStatesThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_ESC_STATES_CHIEF_ID)

/** 说明卡状态样例的七张卡（按线程里的顺序：等你决定、你选了 A、约定在重新确认、约定已更新、约定修改已撤销、这件事已继续进行、这件事已停止）。 */
export const sampleEscalationStatesCards: JobCardView[] = sampleEscalationStatesThread.messages
  .filter(message => message.jobCard !== null && message.jobCard !== undefined)
  .map(message => message.jobCard!)

// ---------------------------------------------------------------------------
// 八、P74i-m5（第 7 节第 2 条）：让走查看得到三种以前看不到的条目
// ---------------------------------------------------------------------------

/**
 * 已经选过办法的说明卡条目（卡上 chosen 不为空，没有「都不合适」按钮）。
 * 入口：?job=escalation-states 的「待你处理」页。
 * 卡片取说明卡状态样例里「你选了 A」那一张（与该入口总管私聊里的卡同一份数据）；
 * 真实数据里选过之后条目会随即消失，这条样例只用来在预览里看这种卡在条目里的样子。
 */
export const sampleChosenEscalationInboxEntry: InboxItemView = {
  id: 'i_sampleview6', botId: SAMPLE_ESC_STATES_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
  priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '活动报名页：第 3 条三轮未通过',
  body: '第 3 条「请填写 11 位手机号」的提示文字核对三轮仍未通过，在等你选一个处理办法。',
  options: ['A　换用第三方表单服务重做这一条', 'B　把这一条改为允许提交、后台补全', 'C　删去这一条'],
  defaultOption: null, createdAt: TS.esc2 + 120_000, createdText: '11月17日 10:02', expiresText: null,
  jobEntry: { kind: 'escalate', jobId: 'job_sample0025' },
  escalationCard: (() => {
    const card = sampleEscalationStatesCards.find(item => item.kind === 'escalation' && item.chosen !== null)
    return card !== undefined && card.kind === 'escalation' ? card : null
  })(),
}

/**
 * 没有主题编号的验收条目（topicId 为空，没有「有不符」按钮：没有地方可发）。
 * 入口：?job=delivery 的「待你处理」页，排在带主题的验收条目之后。
 * 事的编号单独取一个，点「验收通过」时只移走这一条，不影响带主题的那条。
 */
export const sampleNoTopicAcceptInboxEntry: InboxItemView = {
  id: 'i_sampleview7', botId: SAMPLE_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
  priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '报名名单导出：待你验收',
  body: '3 条「怎样算做完」全部符合，已逐条核对。哪条不符合，在对话里写序号和问题。',
  options: ['验收通过'], defaultOption: null,
  createdAt: TD.delivered - 3600_000, createdText: '11月17日 16:20', expiresText: null,
  jobEntry: { kind: 'accept', jobId: 'job_sample0033' },
}

/**
 * 按钮是「接受」「不做」的提议（核心真实的两个选项；基础样例里的提议第二个按钮写「先保持」，与核心不一致）。
 * 入口：?job=approval 的「待你处理」页，排在两条审批之后。
 */
export const sampleProposalInboxEntry: InboxItemView = {
  id: 'i_sampleview8', botId: SAMPLE_APPROVAL_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'proposal' as const, typeLabel: '提议',
  priority: 'P2' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '报名页上线后每天汇总一次报名人数',
  body: '建议报名页上线后，每天晚上 8 点把当天的报名人数汇总发给你，不再逐条通知。',
  options: ['接受', '不做'], defaultOption: '接受',
  createdAt: TA.launchApproval, createdText: '11月17日 18:10', expiresText: '11月18日 18:10 前未答复自动撤回',
}

// ---------------------------------------------------------------------------
// 九、P74i-m6（第 1 节第 2 条）：总管自己核对时核对回合被中心结束两次之后的「没有进展」条目
// ---------------------------------------------------------------------------

/**
 * 「待你处理」里的一条「没有进展」条目：总管自己核对，核对回合在这一轮里被中心结束了两次，
 * 中心不再自动叫醒总管（core：job/chain-turn-end.ts 的 settleChiefReview，正文逐字一致：
 * `{总管}的核对回合在第 {r} 轮里已被中心结束两次（最近一次：超过 60 分钟），中心不再自动叫醒{总管}。`）。
 * 标题与按钮同其他「没有进展」条目（`{标题}：没有进展`；「再提醒一次」「暂停」）。
 * 入口：?job=escalation-states 的「待你处理」页，排在已选过办法的说明卡条目之后。
 * 事的编号单独取一个，处理这一条不影响别的条目。
 */
export const sampleChiefStallInboxEntry: InboxItemView = {
  id: 'i_sampleview9', botId: SAMPLE_ESC_STATES_CHIEF_ID, botName: '总管', botColor: '#5b6b8c', type: 'question' as const, typeLabel: '提问',
  priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '报名名单导出：没有进展',
  body: '总管的核对回合在第 2 轮里已被中心结束两次（最近一次：超过 60 分钟），中心不再自动叫醒总管。',
  options: ['再提醒一次', '暂停'], defaultOption: null,
  createdAt: TS.esc2 + 3600_000, createdText: '11月17日 11:00', expiresText: null,
  jobEntry: { kind: 'stall', jobId: 'job_sample0036' },
}

// ---------------------------------------------------------------------------
// 十、P74i-m7（第 1、2 节）：员工被中心停用之后的告警条目与两个主题线程
// ---------------------------------------------------------------------------

/**
 * 「待你处理」里一条员工被中心停用的告警（core：outreach/alerts.ts 与 job/suspended.ts 的写法，逐字一致）：
 * - 标题 `{名字}已被停用`；
 * - 正文 `中心停用了{名字}：{原因}。` 接 `「{标题}」已停在{环节}，已告诉总管。`；
 *   原因是越界的动作累计达到次数时的写法 `越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）`；
 * - 带核心给的 reinstate 字段（员工此刻仍被中心停用时才有），所以界面画「知道了」「恢复在岗」两个按钮。
 * 入口：?job=escalation-states 的「待你处理」页，排在「没有进展」条目之后。
 * 字段照核心的条目视图（InboxItemView）写，与同类的 sampleChiefStallInboxEntry 一样手写，不造核心没有的字段。
 */
export const SAMPLE_SUSPENDED_ALERT_BODY = '中心停用了周岚：越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）。「活动报名页」已停在执行，已告诉总管。'
export const sampleSuspendedAlertInboxEntry: InboxItemView = {
  id: 'i_sampleview10', botId: SAMPLE_SUSPENDED_BOT_ID, botName: '周岚', botColor: '#8a5a5a', type: 'alert' as const, typeLabel: '告警',
  priority: 'P1' as const, topicId: null, topicTitle: null, approvalId: null,
  title: '周岚已被停用',
  body: SAMPLE_SUSPENDED_ALERT_BODY,
  options: ['知道了'], defaultOption: null,
  createdAt: T_SUSPENDED, createdText: '11月13日 14:30', expiresText: null,
  reinstate: { botId: SAMPLE_SUSPENDED_BOT_ID, botName: '周岚', answer: 'reinstate' as const },
}

/** 执行者被停用、总管在岗的主题（进度行 `在等：周岚（已停用）`）。 */
export const sampleSuspendedWaitThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_SUSPENDED_WAIT_TOPIC_ID)
/** 执行者与总管都被停用的主题（进度行 `在等：你`）。 */
export const sampleSuspendedYouThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_SUSPENDED_YOU_TOPIC_ID)

// ---------------------------------------------------------------------------
// 十一、P74r20（第 2 节）：发布这一步各种结果的样例视图（同样由 core 的视图函数生成）
// ---------------------------------------------------------------------------

/** 发布结果样例的总管私聊：作废的发布审批、已批准的发布审批、作废的普通审批三张卡，加三件事收尾的几句话。入口 ?job=launch。 */
export const sampleLaunchThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_LAUNCH_CHIEF_ID)
/** 已批准、中心正在运行发布命令的主题（进度行「在等：中心运行发布命令」）。 */
export const sampleLaunchRunningThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_LAUNCH_RUNNING_TOPIC_ID)
/** 发布没有成功的主题（进度行「已完成（发布没有成功）」，主题里有「没有发布成功：……」）。 */
export const sampleLaunchFailedThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_LAUNCH_FAILED_TOPIC_ID)
/** 发布成功的主题（主题里有「已发布：……」）。 */
export const sampleLaunchDoneThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_LAUNCH_DONE_TOPIC_ID)
/** 发布没有成功、执行者无法改正的主题（进度行「已完成（没有发布）」，主题里「这件事没有发布。」）。 */
export const sampleLaunchGiveUpThread: ThreadView = createUiApi(seededContext(), async () => {}).thread(SAMPLE_LAUNCH_GIVEUP_TOPIC_ID)
