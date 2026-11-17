/**
 * P76j 的样例：设计稿场景 A 的「在办的事」、场景 B/E 上半的「本窗口额度」、进度行消耗、
 * 约定卡「预计消耗」、回执第六行「消耗」、预计消耗条目。
 *
 * 做法与 fixture-job.ts 一致（第一块的教训）：这里只写「记录」（员工、主题、约定、事、用量、预计、条目），
 * 视图一律由 core 的视图函数生成——activeJobsView、quotaWindowView、thread 视图里的 progress 与 agreement、
 * receiptCostValue——不手写任何视图字段。core 改了文字或字段，样例会跟着变。
 *
 * 一致性测试（test/p76j-fixture.test.ts）用 core 导出的 schema 校验这些样例。
 * 中心生成的固定句（本文件末尾的 BUDGET_COPY_LINES）在这里逐字列出，供文案登记表
 * （docs/copy/strings.json，编号前缀 BUD-、QTA-、STL-）在插件源码里找到锚点；
 * 同一条测试会拿样例视图与这些逐字常量比对，防止两边悄悄走样。
 *
 * P76k 的样例（合并时并进同一个文件）：设置页用量表、离开期间摘要、办公室三种额度状态
 * （正常、员工份额用完、你自己要用）。这几份同样只摆「记录」，视图一律调用 core：
 * - `weeklyUsageView`：用量表的表头与每一行；
 * - `buildAwaySummary`：离开期间摘要的每一行（场景 F 的数据）；
 * - `buildQuotaWindowView`：额度窗口状态、灯、恢复时刻（办公室的午休牌与窗口弧读它）。
 * 两份样例的时间基准各自独立：P76j 用 BUDGET_NOW（2026-11-17 14:00），
 * P76k 用 SAMPLE_BUDGET_NOW（2026-11-13 16:00，与 fixture-job 同一时刻）。
 */
import {
  BUDGET_DEFAULTS, buildAwaySummary, buildQuotaWindowView, chiefJobLine, createUiApi, quotaWindowView, resolveSettings, testing, weeklyUsageView,
  type ActiveJobsView, type Agreement, type AwayJobInput, type Job, type JobProgressView, type JobUsage, type QuotaPlan,
  type QuotaState, type QuotaWindowView, type ReceiptCardView, type Settings, type ThreadMessage, type ThreadView, type WeeklyUsageView,
} from '@agent-hub/core'

/** 样例时间基准：2026-11-17 14:00（北京时间）；样例里的时刻都从它推。 */
export const BUDGET_NOW = Date.parse('2026-11-17T14:00:00+08:00')
export const BUDGET_TIMEZONE = 'Asia/Shanghai'

export const BUDGET_CHIEF_ID = 'b_budgetchief'
export const BUDGET_EXECUTOR_ID = 'b_budgetlin'
export const BUDGET_REVIEWER_ID = 'b_budgetreview'

const REPORT_TOPIC = 'ptp_budgetreport'
const TWEET_TOPIC = 'ptp_budgettweet'
const RECEIPT_TOPIC = 'ptp_budgetreceipt'
const REPORT_AGREEMENT = 'agr_budgetreport'
const TWEET_AGREEMENT = 'agr_budgettweet'
const RECEIPT_AGREEMENT = 'agr_budgetreceipt'
const REPORT_JOB = 'job_budget0001'
const GUEST_JOB = 'job_budget0002'
const RECEIPT_JOB = 'job_budget0003'

const HOUR = 3_600_000

/** 一版约定的内容：与设计稿 A/B 同一份，只保留视图会读的字段。 */
function content(summary: string): Agreement['versions'][number]['content'] {
  return {
    summary,
    sketch: { layout: 'page', screens: [{ title: '报销页', blocks: [{ kind: 'field', text: '金额', required: true }, { kind: 'button', text: '提交' }] }] },
    pending: [{
      key: 'receipt', question: '提交后要不要显示回执编号？', options: ['显示回执编号', '只显示「已提交」'],
      suggested: '显示回执编号', reason: '方便你核对。', chosen: '显示回执编号',
    }],
    decided: [{ text: '金额最多两位小数。', basis: { kind: 'convention', ref: null, refText: null } }],
    scopeIn: ['报销页', '回执页'],
    scopeOut: ['对外发布'],
    doneWhen: ['提交后能看到回执。', '11月18日 18:00 前交给你验收。'],
  }
}

/** 一版约定；版本状态与锁定时刻由调用方给。 */
function version(no: number, state: 'pending' | 'locked', summary: string): Agreement['versions'][number] {
  return {
    no, state, source: 'draft', askOrigin: null, sourceMessageId: 'm_budget0001', sourceThread: BUDGET_CHIEF_ID,
    wakeId: null, content: content(summary), changes: [], changeNote: '', cardMessageId: `m_budgetagr0${no}`,
    createdAt: BUDGET_NOW - 48 * HOUR, lockedAt: state === 'locked' ? BUDGET_NOW - 46 * HOUR : null,
    lockedVia: state === 'locked' ? 'button' : null, confirmMessageId: null, choices: null,
    adoption: state === 'locked' ? { adopted: 1, total: 1 } : null,
  }
}

/** 一份约定；标题、主题、版本由调用方给。 */
function agreement(id: string, topicId: string, title: string, state: 'pending' | 'locked', summary: string): Agreement {
  const versions = [version(1, state, summary)]
  return {
    id, botId: BUDGET_CHIEF_ID, projectId: 'prj_budget', topicId, originThread: BUDGET_CHIEF_ID,
    title, state, inboxId: null, withdrawn: null, createdAt: BUDGET_NOW - 48 * HOUR,
    updatedAt: BUDGET_NOW - 46 * HOUR, versions,
  }
}

/** 一件事的记录；公共字段取这里，各件只改差别。 */
function job(id: string, agreementId: string, topicId: string, patch: Partial<Job>): Job {
  return {
    id, chiefId: BUDGET_CHIEF_ID, agreementId, projectId: 'prj_budget', topicId, folder: `jobs/${id}`,
    state: 'checking', executorId: BUDGET_EXECUTOR_ID, reviewerId: BUDGET_REVIEWER_ID,
    dueAt: Date.parse('2026-11-17T18:00:00+08:00'), deliveryItems: [1], launchStep: false,
    stage: 1, round: 1, blocked: null, pause: null, openAsk: null, unmet: [], turnsUsed: 9, turnCap: 13,
    launch: { state: 'none', approvalId: null, link: null }, inboxId: null,
    firstLockedAt: BUDGET_NOW - 46 * HOUR, assignedAt: BUDGET_NOW - 45 * HOUR, startedAt: BUDGET_NOW - 44 * HOUR,
    deliveredAt: null, acceptedAt: null, stoppedAt: null, createdAt: BUDGET_NOW - 45 * HOUR, updatedAt: BUDGET_NOW - HOUR,
    ...patch,
  }
}

/** 一步的用量：回合数与 token。 */
const step = (turns: number, tokens: number): { turns: number; tokens: number } => ({ turns, tokens })

/**
 * 按 core 的默认每回合 token 区间算一份预计：对齐那一步已经用掉的 4 万 token 照实计入，
 * 其余执行、核对、返工按默认区间的下限与上限算。样例不手写「100K 到 400K」这种
 * 与回合数无关的区间，否则会出现预计上限低于已用 token 的自相矛盾。
 */
function estimateTokens(total: number): { low: number; high: number } {
  const defaults = BUDGET_DEFAULTS.TOKENS_PER_TURN_DEFAULT
  const exec = Math.max(0, total - 3) // 对齐、核对、返工各 1 回合，其余是执行
  return {
    low: 40_000 + exec * defaults.exec[0] + defaults.review[0] + defaults.rework[0],
    high: 40_000 + exec * defaults.exec[1] + defaults.review[1] + defaults.rework[1],
  }
}

/** 一件事的用量行（与 core 的 JobUsage 同形；没写的步为 0）。 */
function usage(jobId: string, agreementId: string, steps: Partial<Record<keyof JobUsage['steps'], { turns: number; tokens: number }>>,
  turns: JobUsage['turns'] = [], extra: Partial<JobUsage> = {}): JobUsage {
  const zero = { turns: 0, tokens: 0 }
  return {
    id: jobId, agreementId, category: 'page',
    steps: { align: zero, exec: zero, review: zero, rework: zero, chief: zero, launch: zero, ...steps },
    turns, finalizedAt: null, updatedAt: BUDGET_NOW, ...extra,
  }
}

/** 造一份种好样例记录的 core 环境（假时钟定在 BUDGET_NOW；全部留在内存）。staffFull 为真时员工份额用完。 */
function seededContext(options: { staffFull?: boolean } = {}) {
  const ctx = testing.createTestContext({ clock: new testing.FakeClock(BUDGET_NOW) })
  for (const bot of [
    { id: BUDGET_CHIEF_ID, name: '总管', color: '#5b6b8c', role: 'chief' },
    { id: BUDGET_EXECUTOR_ID, name: '林舟', color: '#3f8f7a', role: 'executor' },
    { id: BUDGET_REVIEWER_ID, name: '评审员', color: '#b07a3a', role: 'researcher' },
  ]) ctx.store.table('bots').put(bot as never)
  for (const [id, title] of [[REPORT_TOPIC, '活动报名页'], [TWEET_TOPIC, '活动推文'], [RECEIPT_TOPIC, '报销页']] as const) {
    ctx.store.table('projectTopics').put({
      id, projectId: 'prj_budget', title, createdAt: BUDGET_NOW - 48 * HOUR, updatedAt: BUDGET_NOW,
      lastMessageAt: BUDGET_NOW, agentTurnsSinceOwner: 0, pendingBotIds: [],
    } as never)
  }
  const reportAgreement = agreement(REPORT_AGREEMENT, REPORT_TOPIC, '活动报名页', 'locked', '做一个活动报名页。')
  const tweetAgreement = agreement(TWEET_AGREEMENT, TWEET_TOPIC, '活动推文', 'pending', '写三条活动推文。')
  const receiptAgreement = agreement(RECEIPT_AGREEMENT, RECEIPT_TOPIC, '报销页', 'locked', '做一个报销页。')
  for (const row of [reportAgreement, tweetAgreement, receiptAgreement]) ctx.store.table('agreements').put(row)

  // 三件事（场景 A）：核对中 9 / 14；受阻在等你 4 / 8；推文还在对齐（没有这件事）。
  const report = job(REPORT_JOB, REPORT_AGREEMENT, REPORT_TOPIC, {})
  const guest = job(GUEST_JOB, REPORT_AGREEMENT, REPORT_TOPIC, {
    state: 'blocked', round: 0, turnsUsed: 4, turnCap: 8, dueAt: null, reviewerId: null,
    blocked: { kind: 'turn_cap', no: null, text: '回合用到预算线', since: BUDGET_NOW - 6 * HOUR, resumeTo: 'doing' },
    updatedAt: BUDGET_NOW - 6 * HOUR,
  })
  const receiptJob = job(RECEIPT_JOB, RECEIPT_AGREEMENT, RECEIPT_TOPIC, {
    state: 'done', turnsUsed: 7, turnCap: 12, deliveredAt: BUDGET_NOW - 2 * HOUR, acceptedAt: BUDGET_NOW - HOUR,
    launch: { state: 'none', approvalId: null, link: null },
    delivery: { stage: 1, cardMessageId: null, checks: [], rev: 0 },
  })
  // 受阻那件事挂在它自己的约定上：另起一份同标题的约定（同一主题，视图按约定标题显示）。
  const guestAgreement = agreement('agr_budgetguest', REPORT_TOPIC, '嘉宾介绍页', 'locked', '做一个嘉宾介绍页。')
  ctx.store.table('agreements').put(guestAgreement)
  ctx.store.table('jobs').put(report)
  ctx.store.table('jobs').put({ ...guest, agreementId: 'agr_budgetguest' })
  ctx.store.table('jobs').put(receiptJob)
  for (const row of [
    usage(REPORT_JOB, REPORT_AGREEMENT, { align: step(1, 40_000), exec: step(5, 1_000_000), review: step(2, 200_000), rework: step(1, 160_000) }, [
      { wakeId: 'w_budget0001', step: 'exec', botId: BUDGET_EXECUTOR_ID, startedAt: Date.parse('2026-11-17T13:00:00+08:00'), endedAt: Date.parse('2026-11-17T13:08:00+08:00'), tokens: 300_000 },
      { wakeId: 'w_budget0002', step: 'review', botId: BUDGET_REVIEWER_ID, startedAt: Date.parse('2026-11-17T13:20:00+08:00'), endedAt: null, tokens: 0 },
    ]),
    usage('job_budget0002', 'agr_budgetguest', { align: step(1, 30_000), exec: step(3, 600_000) }),
    usage(RECEIPT_JOB, RECEIPT_AGREEMENT, { align: step(1, 30_000), exec: step(4, 800_000), review: step(1, 100_000), launch: step(1, 50_000) }, [],
      // P76n：回执与进度行用同一份总量（7 回合、980K）；此前回执写 6/930K，少算了发布那一回合。
      { finalizedAt: BUDGET_NOW - HOUR, finalUsed: 7, finalTokens: 980_000 }),
  ]) ctx.store.table('jobUsage').put(row)
  const estimate = (agreementId: string, total: number, reason: 'lock' | 'draft') => {
    const tokens = estimateTokens(total)
    ctx.store.table('jobEstimates').put({
      id: agreementId,
      versions: [{ versionNo: 1, total, steps: { align: 1, exec: total - 3, review: 1, rework: 1, chief: 0 },
        tokenLow: tokens.low, tokenHigh: tokens.high, basis: 'default', historyCount: 0, reason, createdAt: BUDGET_NOW - 48 * HOUR }],
    })
  }
  estimate(REPORT_AGREEMENT, 14, 'lock')
  estimate('agr_budgetguest', 8, 'lock')
  estimate(TWEET_AGREEMENT, 5, 'draft')
  estimate(RECEIPT_AGREEMENT, 12, 'lock')
  // 受阻那件事开着的「将超出预计」条目：在等你，已等 6 小时（超过 1 小时才有 waitedText）。
  ctx.store.table('inbox').put({
    id: 'i_budgetcap1', botId: BUDGET_CHIEF_ID, type: 'question', title: '嘉宾介绍页：消耗将超出预计',
    body: '已用 4 回合，预计 8，估计共需 9 回合。\n多出来的部分：执行多用了 1 回合。\n追加：按原约定做完，多用 2 回合，约 320K 到 780K token。',
    options: ['追加 2 个回合', '缩小范围', '暂停'], defaultOption: null, priority: 'P1', status: 'open', answer: null,
    refId: null, subjectKey: 'job:job_budget0002:cap:8', pushed: false, createdAt: BUDGET_NOW - 6 * HOUR,
    expiresAt: null, answeredAt: null,
  } as never)
  // 主题里各有一条开场的话：主题页要有楼层，约定面板与进度行才画得出来（代码里空主题只显示欢迎语）。
  ctx.store.log('thread').append({
    id: 'm_budgetreport1', thread: REPORT_TOPIC, from: 'owner', kind: 'chat',
    text: '做一个活动报名页。', refId: null, createdAt: BUDGET_NOW - 47 * HOUR, readAt: BUDGET_NOW - 47 * HOUR,
  } as ThreadMessage)
  // 回执卡：线程里一条 job_card（refId 形状与真实数据一致），视图由 core 读出。
  ctx.store.log('thread').append({
    id: 'm_budgetreceipt', thread: RECEIPT_TOPIC, from: 'hub', kind: 'job_card',
    text: '交付回执　报销页', refId: `receipt:${RECEIPT_JOB}`, createdAt: BUDGET_NOW - HOUR, readAt: null,
  } as ThreadMessage)
  // 待确认的约定卡：线程里一条 agreement 消息（线程视图按 refId 挂上约定卡，含「预计消耗」一段）。
  ctx.store.log('thread').append({
    id: 'm_budgetagr01', thread: TWEET_TOPIC, from: 'hub', kind: 'agreement',
    text: '活动推文：约定第 1 版', refId: TWEET_AGREEMENT, createdAt: BUDGET_NOW - 20 * 60_000, readAt: null,
  } as ThreadMessage)
  // 额度窗口：容量 1000 万，员工份额七成；员工已用 3.5 成（正常）或七成（用完）。
  const capacity = 10_000_000
  const share = ctx.settings.botQuotaShare
  ctx.store.table('quotaWindows').put({
    id: 'quota', capacityTokens: capacity, capacitySource: 'initial', windowStartAt: BUDGET_NOW - 2 * HOUR,
    staffTokens: Math.round(capacity * share * (options.staffFull === true ? 1 : 0.5)), ownerTokens: 0,
    staffTurns: options.staffFull === true ? 40 : 20, ownerTurns: 0, exhausted: null, ownerHoldUntil: null,
    borrowJobIds: [], errors: [], updatedAt: BUDGET_NOW,
  })
  ctx.store.table('quota').put({
    id: 'quota', windowStartAt: BUDGET_NOW - 2 * HOUR, botTurns: 20, botTokens: 3_500_000, turnLimit: 40,
    tokenLimit: null, light: options.staffFull === true ? 'red' : 'yellow', redUntil: null, probeAllowed: false,
    lastError: null, lastErrorAt: null,
  })
  return ctx
}

/** 读一次视图的界面接口（不调用模型）。 */
function apiOf(ctx: ReturnType<typeof seededContext>) {
  return createUiApi(ctx, async () => {})
}

/** 总管右侧栏「在办的事」：场景 A 的三件。 */
export const sampleActiveJobsChief: ActiveJobsView = apiOf(seededContext()).activeJobs(BUDGET_CHIEF_ID)

/** 员工（林舟）右侧栏「在办的事」：只列他参与的事。 */
export const sampleActiveJobsExecutor: ActiveJobsView = apiOf(seededContext()).activeJobs(BUDGET_EXECUTOR_ID)

/** 本窗口额度：员工份额用了一半（正常状态）。 */
export const sampleQuotaWindow: QuotaWindowView = quotaWindowView(seededContext(), BUDGET_NOW)

/** 本窗口额度：员工份额用完（红灯）。 */
export const sampleQuotaWindowFull: QuotaWindowView = quotaWindowView(seededContext({ staffFull: true }), BUDGET_NOW)

/** 场景 A 那件事的进度行：第三行消耗与逐回合明细。 */
export const sampleJobProgressWithCost: JobProgressView = apiOf(seededContext()).thread(REPORT_TOPIC).progress!

/** 场景 A 那件事的约定卡（已固定）与「预计消耗」一段（没有预计时为 null）。 */
const reportCard = apiOf(seededContext()).thread(REPORT_TOPIC).agreement!.current

/** 约定卡「预计消耗」一段（由 core 生成；旧数据没有这一段）。 */
export const sampleEstimate = reportCard.estimate ?? null

/** 回执（第六行「消耗」由 core 追加）。 */
export const sampleReceiptWithCost: ReceiptCardView = apiOf(seededContext()).thread(RECEIPT_TOPIC).messages
  .find(message => message.jobCard?.kind === 'receipt')?.jobCard as ReceiptCardView

/** 场景 A 那件事的主题线程（进度行与约定卡预计都在里面；预览入口 ?job=budget 用）。 */
export const sampleBudgetThread: ThreadView = apiOf(seededContext()).thread(REPORT_TOPIC)

/** 回执所在的主题线程（预览里从主题列表点开看第六行）。 */
export const sampleBudgetReceiptThread: ThreadView = apiOf(seededContext()).thread(RECEIPT_TOPIC)

/** 活动推文的主题线程（待确认的约定卡，预计消耗一段的样子）。 */
export const sampleBudgetTweetThread: ThreadView = apiOf(seededContext()).thread(TWEET_TOPIC)

/** 本卡相关的视图（测试用：一次拿到全部）。 */
export const sampleBudgetViews = {
  activeJobsChief: sampleActiveJobsChief,
  activeJobsExecutor: sampleActiveJobsExecutor,
  quota: sampleQuotaWindow,
  quotaFull: sampleQuotaWindowFull,
  progress: sampleJobProgressWithCost,
  estimate: sampleEstimate,
  receipt: sampleReceiptWithCost,
  thread: apiOf(seededContext()).thread(TWEET_TOPIC) as ThreadView,
}

/**
 * 中心生成的固定句（逐字）：docs/copy/strings.json 里 P76 条目在插件源码里的锚点。
 * 这些句子都由 core 拼、界面原样显示（本卡不改写）；在这里逐字列出，一是让文案检查
 * 能在插件源码里找到它们，二是与 BUDGET_COPY_LINES 的样例一起被一致性测试读到。
 * 不在这里放编号：编号只活在文案登记表里，避免两处各记一套。
 */
export const P76_CORE_COPY: readonly string[] = [
  // BUD-：约定卡「预计消耗」、进度行与回执的消耗
  '预计消耗',
  '{} 回合，约 {} 到 {} token。',
  '{} 回合，约 {} token。',
  '对齐 {} 回合（总管，已用）',
  '执行 {} 回合（{}）',
  '核对 {} 回合（{}，每轮 {} 回合，最多 {} 轮）',
  '返工预留 {} 回合（核对不通过时使用；未用到的不消耗）',
  '总管预留 {} 回合（回答员工的问题）',
  '对外发布另计，最多 {} 回合。',
  '按 {} 件同类事的记录估计。',
  '首次估计：没有同类事的记录，按每一步的默认份额估计。',
  '1 回合指一位员工被唤醒后连续工作一轮。用到 {} 回合仍未做完时，我会先问你，不会自行超出。',
  '消耗：已用 {} 回合，{} token',
  '消耗：{} / {} 回合，已用 {} token　{}',
  '消耗：预计 {} 回合，已用 {} 回合（对齐）',
  '{} 回合，预计 {}；约 {} token',
  '{} 回合；约 {} token',
  // P87：「你发起的总管回合」一栏有回合时 core 追加的句子（回执末尾、进度行与在办的事里；前面的标点由 core 加）
  '；另有你发起的 {} 回合，约 {} token',
  '另有你发起的 {} 回合 {} token',
  '追加 {} 个回合',
  '缩小范围',
  '暂停',
  '已用 {} 回合　{} token',
  '{} / {} 回合　{} token',
  // QTA-：本窗口额度与顶栏
  '本窗口额度',
  '员工已用约 {} 回合',
  '员工还可用约 {} 回合',
  '已到上限',
  '给你留出{}',
  '{} 重置',
  '约 {} 恢复',
  '约 {} 恢复（估计）',
  '你要自己用到 {}，员工不开新回合',
  '员工已用、员工还可用、给你留出',
  '额度充足',
  '员工按正常节奏开工。',
  '额度过半',
  '员工份额用过一半，员工自己发起的工作放慢节奏。',
  '额度紧张',
  '员工份额用到八成，只有你交代的事和你发起的对话继续。',
  '员工份额已用完',
  '员工在 {} 前不开新回合；你发起的对话不受影响。',
  '额度已用完',
  '你要自己用到 {}。',
  // STL-：在办的事、停滞与提醒
  '在办的事　{} 件　共用 {} 回合，{} token',
  '现在没有在办的事',
  '在等：{}　{}　交付：{}',
  '待定',
  '确认约定第 {} 版',
  '{}　已等 {}',
  '{}没有进展',
  '额度恢复，约 {} 继续',
  '已等 {}',
  '{}还在等你{}，已等 {}。交付时间是 {}。',
  '已 {} 没有进展，停在{}这一步，在等{}。',
  '{}在{}这一步连续 {} 个回合没有新文件或新证据。',
  '已过交付时间（{}），现在{}，在等{}。',
  '{}：没有进展',
  '换{}接手',
  '再提醒一次',
  '之后 24 小时内，不会再因为{}没有进展通知你；有新进展之后重新计时。',
  // NAV-：左栏总管一句与「其他事务」
  '{} 件在办',
  '{} 件在办，{} 件等你',
  '其他事务',
  // NTF-：P76h 的通知合并（两段）
  '有 {} 件事等你处理',
  '另有 {} 件',
  // 用量表（P76i）
  '员工自己发起',
  '复盘、学习与整理',
  '你发起的对话',
  '不适用',
  // 离开期间摘要（P76i）
  '你离开的 {}里（{} 到 {}）',
  '{}：{}。用了 {} 回合。',
  '{}：仍在等你{}。',
  '共用 {} 回合，约 {} token。',
  '没有通知过你。',
  '通知过你 {} 次。',
  '这段时间没有变化。',
] as const

/** 左栏总管那一行的样例（core 的 chiefJobLine 读同一份在办的事）。 */
export const sampleBudgetChiefLine: string | null = chiefJobLine(sampleActiveJobsChief.rows)

/**
 * 中心生成、界面原样显示的固定句（逐字）：文案登记表里 BUD-、QTA-、STL- 三组的锚点。
 * 同一条测试用 sampleBudgetViews 生成的文字与这里比对，两边不会各说各话。
 */
export const BUDGET_COPY_LINES = {
  /** 右栏「在办的事」头部与空态。 */
  headText: '在办的事　3 件　共用 13 回合，2.03M token',
  emptyText: '现在没有在办的事',
  footer: '查看全部记录',
  /** 进度行第三行（有预计）。 */
  costLine: '消耗：9 / 14 回合，已用 1.4M token　对齐 1，执行 5，核对 2，返工 1',
  /** 回执第六行。 */
  receiptCost: '7 回合，预计 12；约 980K token',
  /** 本窗口额度（正常）。 */
  quotaUsed: '员工已用约 18 回合',
  quotaLeft: '员工还可用约 18 回合',
  reserve: '给你留出三成',
  /** 左栏总管一句（由 core 的 chiefJobLine 读同一份在办的事）。 */
  chiefLine: '3 件在办，2 件等你',
} as const

// ---- 以下是 P76k 并进来的样例（同一个文件，两份内容不重叠） ----

/** 一件事在这段时间里的一个事件：core 没有单独导出这个类型，从摘要输入的字段里取。 */
type AwayEvent = AwayJobInput['events'][number]

/** 样例基准时刻：2026-11-13 16:00（北京时间）；与 fixture-job 一致。 */
export const SAMPLE_BUDGET_NOW = Date.parse('2026-11-13T16:00:00+08:00')
export const SAMPLE_BUDGET_TIMEZONE = 'Asia/Shanghai'

/** 样例设置：core 的默认设置（份额七成、窗口 5 小时），个别项按样例需要覆盖。 */
function sampleSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...resolveSettings({}), timezone: SAMPLE_BUDGET_TIMEZONE, ...overrides }
}

/**
 * 最近 7 天的用量表样例：用 core 的测试环境（内存存储）跑一遍 `weeklyUsageView`。
 * 样例环境里没有记录，表里只有固定三行（回合 0、token 0）——这仍然是 core 生成的视图，
 * 不是手写的文字；真实数字由运行中的中心给出。
 */
export function fixtureWeeklyUsage(): WeeklyUsageView {
  try {
    const ctx = testing.createTestContext()
    return weeklyUsageView(ctx)
  } catch {
    // 样例环境异常时退回一份空表（表头仍按 core 的口径），预览不整页报错。
    return { head: ['事', '回合', '预计', 'token'], rows: [] }
  }
}

/** 这 8 小时里一件事的事件（只带摘要要用的字段）。 */
function awayEvent(kind: AwayEvent['kind'], at: number, actor: string, to: string[], data: Record<string, unknown> = {}): AwayEvent {
  return { kind, at, actor, to, data }
}

/**
 * 离开期间摘要样例（设计稿场景 F）：你昨天 20:00 离开，今天 09:30 回来。
 * 三件事：一件昨天交回后核对退回、执行者已改好；一件夜里做完在等你验收；
 * 一件这期间没有回合、但一直在等你确认约定。
 */
export function fixtureAwaySummary(): { lines: string[]; dismissText: string } {
  const now = SAMPLE_BUDGET_NOW
  const from = now - 13 * HOUR - 30 * 60 * 1000
  const jobA: AwayJobInput = {
    title: '活动报名页（11月18日上线）',
    turns: 6, tokens: 1_240_000, lastTurnAt: now - 2 * HOUR,
    events: [
      awayEvent('submitted', now - 5 * HOUR, '林舟', ['评审甲']),
      awayEvent('reviewed', now - 4 * HOUR, '评审甲', ['林舟'], { pass: false, round: 1, failed: 2 }),
      awayEvent('submitted', now - 2 * HOUR, '林舟', ['评审甲']),
    ],
    stateLabel: '核对中', waitingOn: '评审甲', waitingOwner: false, waitItem: null,
    hasOpenItem: false, noticeItem: null, waitedMs: 0,
  }
  const jobB: AwayJobInput = {
    title: '周报自动汇总',
    turns: 4, tokens: 860_000, lastTurnAt: now - 3 * HOUR,
    events: [awayEvent('delivered', now - 3 * HOUR, '阿遥', ['你'])],
    stateLabel: '待你验收', waitingOn: '你', waitingOwner: true, waitItem: '验收',
    hasOpenItem: false, noticeItem: null, waitedMs: 3 * HOUR,
  }
  const jobC: AwayJobInput = {
    title: '报价单模板',
    turns: 0, tokens: 0, lastTurnAt: null,
    events: [],
    stateLabel: '待确认约定', waitingOn: '你', waitingOwner: true, waitItem: '确认约定第 2 版',
    hasOpenItem: false, noticeItem: null, waitedMs: 9 * HOUR,
  }
  const summary = buildAwaySummary({
    from, to: now, now, timezone: SAMPLE_BUDGET_TIMEZONE,
    names: { b_linzhou: '林舟', b_yao: '阿遥' },
    jobs: [jobA, jobB, jobC],
    sentCount: 2,
  })
  return { lines: summary.lines, dismissText: '收起' }
}

/** 额度窗口样例的三种状态。 */
export type QuotaSampleKind = 'normal' | 'staff_full' | 'owner_hold'

/** 造一份额度窗口记录与额度单例：三种状态只改这几项，其余字段照真实形状补齐。 */
function quotaSample(kind: QuotaSampleKind, now: number): { plan: QuotaPlan; quota: QuotaState; settings: Settings; now: number } {
  const settings = sampleSettings()
  // 窗口已经走了 2 小时（弧约为四成）；员工份额按设置里的比例算。
  const windowStartAt = now - 2 * HOUR
  const staffLimit = settings.botQuotaShare * 10_000_000
  const staffTokens = kind === 'staff_full' ? Math.ceil(staffLimit) : Math.round(staffLimit * 0.35)
  const plan: QuotaPlan = {
    id: 'quota', capacityTokens: 10_000_000, capacitySource: 'initial', windowStartAt,
    staffTokens, ownerTokens: 400_000, staffTurns: kind === 'staff_full' ? 40 : 12, ownerTurns: 2,
    exhausted: null, ownerHoldUntil: kind === 'owner_hold' ? now + HOUR : null,
    borrowJobIds: [], errors: [], updatedAt: now,
  }
  const quota: QuotaState = {
    id: 'quota', windowStartAt, botTurns: 12, botTokens: staffTokens, turnLimit: 40, tokenLimit: null,
    light: kind === 'staff_full' ? 'red' : 'green',
    redUntil: kind === 'staff_full' ? windowStartAt + settings.quotaWindowMs : null,
    probeAllowed: false, lastError: null, lastErrorAt: null,
  }
  return { plan, quota, settings, now }
}

/** 办公室样例：正常（绿）、员工份额用完（红）、你自己要用（owner_hold）。now 默认用样例基准，预览传当前时刻。 */
export function fixtureQuotaWindow(kind: QuotaSampleKind, now: number = SAMPLE_BUDGET_NOW): QuotaWindowView {
  const sample = quotaSample(kind, now)
  return buildQuotaWindowView({
    plan: sample.plan, quota: sample.quota, hasWindow: true, settings: sample.settings,
    now: sample.now, tokensPerTurn: 60_000,
  })
}
