/**
 * P76j 总管面板与成本样例的「预览快照」（做法同 fixture-job-preview.ts）：
 * 浏览器预览拖不进整个 core（会带上 Node 半边），所以这里以逐字的视图快照给预览用；
 * 快照由 fixture-budget.ts 里 core 的视图函数生成，test/p76j-fixture-preview.test.ts 逐字比对两者，
 * 漂移时测试先失败——不要手改这个文件里的任何文字。
 */
import type { ActiveJobsView, JobProgressView, QuotaWindowView, ReceiptCardView, ThreadView, WeeklyUsageView } from '@agent-hub/core'

/** 预览用的样例（总管右栏三件事、本窗口额度、进度行消耗、约定卡预计、回执第六行与三个主题）。 */
export const PREVIEW_BUDGET = JSON.parse(`{"activeJobs":{"headText":"在办的事　3 件　共用 13 回合，2.03M token","rows":[{"key":"agr_budgettweet","topicId":"ptp_budgettweet","title":"活动推文","stateLabel":"对齐中","stateTone":"you","waitText":"在等：你　确认约定第 1 版　交付：待定","costText":"0 / 5 回合　0 token","costRatio":0,"waitingOwner":true},{"key":"job_budget0002","topicId":"ptp_budgetreport","title":"嘉宾介绍页","stateLabel":"受阻","stateTone":"you","waitText":"在等：你　决定预计消耗怎样处理　已等 6 小时　交付：待定","costText":"4 / 8 回合　630K token","costRatio":0.5,"waitingOwner":true},{"key":"job_budget0001","topicId":"ptp_budgetreport","title":"活动报名页","stateLabel":"核对中","stateTone":"run","waitText":"在等：评审员　第 1 轮，共 3 轮　交付：11月17日 18:00 前","costText":"9 / 14 回合　1.4M token","costRatio":0.6428571428571429,"waitingOwner":false}],"footerText":"查看全部记录"},"quota":{"state":"normal","light":"yellow","resetAt":1794906000000,"resetText":"17:00 重置","staffUsedTurnsText":"员工已用约 18 回合","staffLeftTurnsText":"员工还可用约 18 回合","staffUsedTokensText":"3.5M token","staffUsedTokens":3500000,"reserveText":"给你留出三成","holdText":null,"barParts":{"staffUsed":0.35,"staffLeft":0.35,"reserved":0.30000000000000004},"lightLabel":"额度过半","lightHint":"员工份额用过一半，员工自己发起的工作放慢节奏。","waitText":null},"progress":{"steps":[{"label":"对齐","state":"done"},{"label":"执行","state":"done"},{"label":"核对","state":"current"},{"label":"你验收","state":"todo"}],"stateLabel":"核对中","stateTone":"run","roundText":"第 1 轮，共 3 轮","waitingOn":"评审员","delayNote":null,"dueText":"11月17日 18:00 前","pausedText":null,"costLine":"消耗：9 / 14 回合，已用 1.4M token　对齐 1，执行 5，核对 2，返工 1","costTurns":[{"at":"11月17日 13:00","who":"林舟","step":"执行","tokens":"300K token"},{"at":"11月17日 13:20","who":"评审员","step":"核对","tokens":"进行中"}]},"estimate":{"title":"预计消耗","headline":"14 回合，约 2.02M 到 4.9M token。","lines":["对齐 1 回合（总管，已用）","执行 11 回合（林舟）","核对 1 回合（评审员，每轮 1 回合，最多 3 轮）","返工预留 1 回合（核对不通过时使用；未用到的不消耗）"],"basisLine":"首次估计：没有同类事的记录，按每一步的默认份额估计。","footer":"1 回合指一位员工被唤醒后连续工作一轮。用到 14 回合仍未做完时，我会先问你，不会自行超出。"},"receipt":{"kind":"receipt","title":"交付回执　报销页","rows":[{"label":"从「定了」到验收","value":"1 天 21 小时"},{"label":"需要你处理","value":"0 次"},{"label":"总管代你答复的问题","value":"0 个"},{"label":"核对","value":"无"},{"label":"约定版本","value":"第 1 版"},{"label":"消耗","value":"7 回合，预计 12；约 980K token"}]},"report":{"threadId":"ptp_budgetreport","title":"活动报名页","messages":[{"id":"m_budgetreport1","thread":"ptp_budgetreport","from":"owner","fromName":"主人","fromColor":null,"kind":"chat","text":"做一个活动报名页。","createdAt":1794726000000,"timeText":"11月15日 15:00","createdText":"11月15日 15:00","card":null}],"hasMore":false,"oldestId":"m_budgetreport1","agreement":{"current":{"agreementId":"agr_budgetreport","title":"活动报名页","projectId":"prj_budget","topicId":"ptp_budgetreport","topicTitle":"活动报名页","versionNo":1,"latestNo":1,"state":"locked","stateLabel":"已固定","agreementState":"locked","canConfirm":false,"supersededBy":null,"createdText":"11月15日 14:00","lockedAt":1794729600000,"lockedText":"11月15日 16:00","sourceLabel":"来源：你在总管私聊里的要求","originLine":null,"changeNote":"","stopLine":null,"removed":[],"removedUnlisted":0,"summary":{"text":"做一个活动报名页。","changed":false},"sketch":{"value":{"layout":"page","screens":[{"title":"报销页","blocks":[{"kind":"field","text":"金额","required":true},{"kind":"button","text":"提交"}]}]},"changed":false},"pending":[{"key":"receipt","index":1,"question":"提交后要不要显示回执编号？","options":["显示回执编号","只显示「已提交」"],"suggested":"显示回执编号","chosen":"显示回执编号","reason":"方便你核对。","changed":false,"added":false}],"decided":[{"text":"金额最多两位小数。","basisLabel":"依据：通行做法","changed":false}],"scopeIn":[{"text":"报销页","changed":false},{"text":"回执页","changed":false}],"scopeOut":[{"text":"对外发布","changed":false}],"doneWhen":[{"text":"提交后能看到回执。","changed":false},{"text":"11月18日 18:00 前交给你验收。","changed":false}],"launchLine":null,"launchChanged":false,"adoption":{"adopted":1,"total":1},"rapport":{"adopted":3,"total":3},"jobSplit":null,"estimate":{"title":"预计消耗","headline":"14 回合，约 2.02M 到 4.9M token。","lines":["对齐 1 回合（总管，已用）","执行 11 回合（林舟）","核对 1 回合（评审员，每轮 1 回合，最多 3 轮）","返工预留 1 回合（核对不通过时使用；未用到的不消耗）"],"basisLine":"首次估计：没有同类事的记录，按每一步的默认份额估计。","footer":"1 回合指一位员工被唤醒后连续工作一轮。用到 14 回合仍未做完时，我会先问你，不会自行超出。"}},"revisions":[{"no":1,"timeText":"11月15日 14:00","stateLabel":"已固定","text":"初稿","sourceLabel":"来源：你在总管私聊里的要求","locked":true}],"revisionCount":0},"progress":{"steps":[{"label":"对齐","state":"done"},{"label":"执行","state":"done"},{"label":"核对","state":"current"},{"label":"你验收","state":"todo"}],"stateLabel":"核对中","stateTone":"run","roundText":"第 1 轮，共 3 轮","waitingOn":"评审员","delayNote":null,"dueText":"11月17日 18:00 前","pausedText":null,"costLine":"消耗：9 / 14 回合，已用 1.4M token　对齐 1，执行 5，核对 2，返工 1","costTurns":[{"at":"11月17日 13:00","who":"林舟","step":"执行","tokens":"300K token"},{"at":"11月17日 13:20","who":"评审员","step":"核对","tokens":"进行中"}]},"floors":{"countText":"共 1 条记录","items":[{"kind":"floor","message":{"id":"m_budgetreport1","thread":"ptp_budgetreport","from":"owner","kind":"chat","text":"做一个活动报名页。","refId":null,"createdAt":1794726000000,"readAt":1794726000000}}]}},"receiptThread":{"threadId":"ptp_budgetreceipt","title":"报销页","messages":[{"id":"m_budgetreceipt","thread":"ptp_budgetreceipt","from":"hub","fromName":"Agent 中心","fromColor":null,"kind":"job_card","text":"交付回执　报销页","createdAt":1794891600000,"timeText":"今天 13:00","createdText":"今天 13:00","card":null,"jobCard":{"kind":"receipt","title":"交付回执　报销页","rows":[{"label":"从「定了」到验收","value":"1 天 21 小时"},{"label":"需要你处理","value":"0 次"},{"label":"总管代你答复的问题","value":"0 个"},{"label":"核对","value":"无"},{"label":"约定版本","value":"第 1 版"},{"label":"消耗","value":"7 回合，预计 12；约 980K token"}]}}],"hasMore":false,"oldestId":"m_budgetreceipt","agreement":{"current":{"agreementId":"agr_budgetreceipt","title":"报销页","projectId":"prj_budget","topicId":"ptp_budgetreceipt","topicTitle":"报销页","versionNo":1,"latestNo":1,"state":"locked","stateLabel":"已固定","agreementState":"locked","canConfirm":false,"supersededBy":null,"createdText":"11月15日 14:00","lockedAt":1794729600000,"lockedText":"11月15日 16:00","sourceLabel":"来源：你在总管私聊里的要求","originLine":null,"changeNote":"","stopLine":null,"removed":[],"removedUnlisted":0,"summary":{"text":"做一个报销页。","changed":false},"sketch":{"value":{"layout":"page","screens":[{"title":"报销页","blocks":[{"kind":"field","text":"金额","required":true},{"kind":"button","text":"提交"}]}]},"changed":false},"pending":[{"key":"receipt","index":1,"question":"提交后要不要显示回执编号？","options":["显示回执编号","只显示「已提交」"],"suggested":"显示回执编号","chosen":"显示回执编号","reason":"方便你核对。","changed":false,"added":false}],"decided":[{"text":"金额最多两位小数。","basisLabel":"依据：通行做法","changed":false}],"scopeIn":[{"text":"报销页","changed":false},{"text":"回执页","changed":false}],"scopeOut":[{"text":"对外发布","changed":false}],"doneWhen":[{"text":"提交后能看到回执。","changed":false},{"text":"11月18日 18:00 前交给你验收。","changed":false}],"launchLine":null,"launchChanged":false,"adoption":{"adopted":1,"total":1},"rapport":{"adopted":3,"total":3},"jobSplit":null,"estimate":{"title":"预计消耗","headline":"12 回合，约 1.7M 到 4.12M token。","lines":["对齐 1 回合（总管，已用）","执行 9 回合（林舟）","核对 1 回合（评审员，每轮 1 回合，最多 3 轮）","返工预留 1 回合（核对不通过时使用；未用到的不消耗）"],"basisLine":"首次估计：没有同类事的记录，按每一步的默认份额估计。","footer":"1 回合指一位员工被唤醒后连续工作一轮。用到 12 回合仍未做完时，我会先问你，不会自行超出。"}},"revisions":[{"no":1,"timeText":"11月15日 14:00","stateLabel":"已固定","text":"初稿","sourceLabel":"来源：你在总管私聊里的要求","locked":true}],"revisionCount":0},"progress":{"steps":[{"label":"对齐","state":"done"},{"label":"执行","state":"done"},{"label":"核对","state":"done"},{"label":"你验收","state":"done"}],"stateLabel":"已完成","stateTone":"ok","roundText":null,"waitingOn":null,"delayNote":null,"dueText":"11月17日 18:00 前","pausedText":null,"costLine":"消耗：6 / 12 回合，已用 980K token　对齐 1，执行 4，核对 1，发布 1","costTurns":[]},"floors":{"countText":"共 1 条记录","items":[{"kind":"floor","message":{"id":"m_budgetreceipt","thread":"ptp_budgetreceipt","from":"hub","kind":"job_card","text":"交付回执　报销页","refId":"receipt:job_budget0003","createdAt":1794891600000,"readAt":null}}]}},"tweetThread":{"threadId":"ptp_budgettweet","title":"活动推文","messages":[{"id":"m_budgetagr01","thread":"ptp_budgettweet","from":"hub","fromName":"Agent 中心","fromColor":null,"kind":"agreement","text":"活动推文：约定第 1 版","createdAt":1794894000000,"timeText":"今天 13:40","createdText":"今天 13:40","card":null,"agreement":{"agreementId":"agr_budgettweet","title":"活动推文","projectId":"prj_budget","topicId":"ptp_budgettweet","topicTitle":"活动推文","versionNo":1,"latestNo":1,"state":"pending","stateLabel":"待你确认","agreementState":"pending","canConfirm":true,"supersededBy":null,"createdText":"11月15日 14:00","lockedAt":null,"lockedText":null,"sourceLabel":"来源：你在总管私聊里的要求","originLine":null,"changeNote":"","stopLine":null,"removed":[],"removedUnlisted":0,"summary":{"text":"写三条活动推文。","changed":false},"sketch":{"value":{"layout":"page","screens":[{"title":"报销页","blocks":[{"kind":"field","text":"金额","required":true},{"kind":"button","text":"提交"}]}]},"changed":false},"pending":[{"key":"receipt","index":1,"question":"提交后要不要显示回执编号？","options":["显示回执编号","只显示「已提交」"],"suggested":"显示回执编号","chosen":"显示回执编号","reason":"方便你核对。","changed":false,"added":false}],"decided":[{"text":"金额最多两位小数。","basisLabel":"依据：通行做法","changed":false}],"scopeIn":[{"text":"报销页","changed":false},{"text":"回执页","changed":false}],"scopeOut":[{"text":"对外发布","changed":false}],"doneWhen":[{"text":"提交后能看到回执。","changed":false},{"text":"11月18日 18:00 前交给你验收。","changed":false}],"launchLine":null,"launchChanged":false,"adoption":null,"rapport":null,"jobSplit":null,"estimate":{"title":"预计消耗","headline":"5 回合，约 580K 到 1.39M token。","lines":["对齐 1 回合（总管，已用）","执行 2 回合（执行者）","核对 1 回合（核对人，每轮 1 回合，最多 3 轮）","返工预留 1 回合（核对不通过时使用；未用到的不消耗）"],"basisLine":"首次估计：没有同类事的记录，按每一步的默认份额估计。","footer":"1 回合指一位员工被唤醒后连续工作一轮。用到 5 回合仍未做完时，我会先问你，不会自行超出。"}}}],"hasMore":false,"oldestId":"m_budgetagr01","agreement":{"current":{"agreementId":"agr_budgettweet","title":"活动推文","projectId":"prj_budget","topicId":"ptp_budgettweet","topicTitle":"活动推文","versionNo":1,"latestNo":1,"state":"pending","stateLabel":"待你确认","agreementState":"pending","canConfirm":true,"supersededBy":null,"createdText":"11月15日 14:00","lockedAt":null,"lockedText":null,"sourceLabel":"来源：你在总管私聊里的要求","originLine":null,"changeNote":"","stopLine":null,"removed":[],"removedUnlisted":0,"summary":{"text":"写三条活动推文。","changed":false},"sketch":{"value":{"layout":"page","screens":[{"title":"报销页","blocks":[{"kind":"field","text":"金额","required":true},{"kind":"button","text":"提交"}]}]},"changed":false},"pending":[{"key":"receipt","index":1,"question":"提交后要不要显示回执编号？","options":["显示回执编号","只显示「已提交」"],"suggested":"显示回执编号","chosen":"显示回执编号","reason":"方便你核对。","changed":false,"added":false}],"decided":[{"text":"金额最多两位小数。","basisLabel":"依据：通行做法","changed":false}],"scopeIn":[{"text":"报销页","changed":false},{"text":"回执页","changed":false}],"scopeOut":[{"text":"对外发布","changed":false}],"doneWhen":[{"text":"提交后能看到回执。","changed":false},{"text":"11月18日 18:00 前交给你验收。","changed":false}],"launchLine":null,"launchChanged":false,"adoption":null,"rapport":null,"jobSplit":null,"estimate":{"title":"预计消耗","headline":"5 回合，约 580K 到 1.39M token。","lines":["对齐 1 回合（总管，已用）","执行 2 回合（执行者）","核对 1 回合（核对人，每轮 1 回合，最多 3 轮）","返工预留 1 回合（核对不通过时使用；未用到的不消耗）"],"basisLine":"首次估计：没有同类事的记录，按每一步的默认份额估计。","footer":"1 回合指一位员工被唤醒后连续工作一轮。用到 5 回合仍未做完时，我会先问你，不会自行超出。"}},"revisions":[{"no":1,"timeText":"11月15日 14:00","stateLabel":"待你确认","text":"初稿","sourceLabel":"来源：你在总管私聊里的要求","locked":false}],"revisionCount":0},"progress":{"steps":[{"label":"对齐","state":"current"},{"label":"执行","state":"todo"},{"label":"核对","state":"todo"},{"label":"你验收","state":"todo"}],"stateLabel":"对齐中","stateTone":"you","roundText":null,"waitingOn":"你","delayNote":null,"dueText":"未约定","pausedText":null,"costLine":"消耗：预计 5 回合，已用 0 回合（对齐）","costTurns":[]},"floors":{"countText":"共 1 条记录","items":[{"kind":"floor","message":{"id":"m_budgetagr01","thread":"ptp_budgettweet","from":"hub","kind":"agreement","text":"活动推文：约定第 1 版","refId":"agr_budgettweet","createdAt":1794894000000,"readAt":null}}]}}}`) as {activeJobs: ActiveJobsView
  quota: QuotaWindowView
  progress: JobProgressView
  estimate: NonNullable<import('@agent-hub/core').AgreementCardView['estimate']>
  receipt: ReceiptCardView
  report: ThreadView
  receiptThread: ThreadView
  tweetThread: ThreadView
}

/** 预览入口要用的三个主题（顺序与左栏主题列表一致）。 */
export const PREVIEW_BUDGET_THREADS: ThreadView[] = [PREVIEW_BUDGET.report, PREVIEW_BUDGET.receiptThread, PREVIEW_BUDGET.tweetThread]

/** 左栏总管那一行的快照（core 的 chiefJobLine 读同一份在办的事）。 */
export const PREVIEW_BUDGET_CHIEF_LINE = '3 件在办，2 件等你'

// ---- 以下是 P76k 并进来的预览快照（用量表、离开期间摘要、三种额度窗口） ----
// 同样由 fixture-budget.ts 里 core 的视图函数生成；test/p76k-fixture.test.ts 钉住它与实时视图逐字相同。

/** 用量表：core 的 weeklyUsageView 在空样例环境里的输出（固定三行，数字为 0）。 */
export const previewWeeklyUsage: WeeklyUsageView = {
  head: ['事', '回合', '预计', 'token'],
  rows: [
    { label: '员工自己发起', turns: '0', estimate: '不适用', tokens: '0' },
    { label: '复盘、学习与整理', turns: '0', estimate: '不适用', tokens: '0' },
    { label: '你发起的对话', turns: '0', estimate: '不适用', tokens: '0' },
  ],
}

/** 离开期间摘要（设计稿场景 F）：三件事、两条通知。 */
export const previewAwaySummary = {
  lines: [
    '你离开的 14 小时里（今天 02:30 到 今天 16:00）',
    '活动报名页（11月18日上线）：核对第 1 轮退回 1 条。用了 6 回合。',
    '周报自动汇总：已交付，在等你验收。用了 4 回合。',
    '报价单模板：仍在等你确认约定第 2 版。',
    '共用 10 回合，约 2.1M token。通知过你 2 次。',
  ],
  dismissText: '收起',
}

// ---- P76n：额度窗口样例按预览打开时的当前时刻生成 ----
// 窗口固定走过 2 小时（弧约四成），重置在 3 小时后；午休牌与挂钟小字的时刻跟着变。
// 这样样例不会像旧版那样把 resetAt 写死在 2026-11-13 19:00，预览打开时早已过期、弧画满一圈。
const HOUR_MS = 3_600_000
export const PREVIEW_QUOTA_NOW = Date.now()
const QUOTA_WINDOW_START = PREVIEW_QUOTA_NOW - 2 * HOUR_MS
const QUOTA_RESET_AT = QUOTA_WINDOW_START + 5 * HOUR_MS
const QUOTA_HOLD_UNTIL = PREVIEW_QUOTA_NOW + HOUR_MS

/** 与 core 的 quotaClockText 同一写法：同一日写 HH:mm，跨日写 M月D日 HH:mm。 */
function quotaClockOf(at: number, now: number): string {
  const partsOf = (ms: number): { year: number; month: number; day: number; hour: number; minute: number } => {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    const parts: Record<string, string> = {}
    for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) }
  }
  const target = partsOf(at)
  const today = partsOf(now)
  const clock = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`
  const sameDay = target.year === today.year && target.month === today.month && target.day === today.day
  return sameDay ? clock : `${target.month}月${target.day}日 ${clock}`
}
const RESET_CLOCK = quotaClockOf(QUOTA_RESET_AT, PREVIEW_QUOTA_NOW)
const HOLD_CLOCK = quotaClockOf(QUOTA_HOLD_UNTIL, PREVIEW_QUOTA_NOW)

/** 额度窗口：正常（绿）。 */
export const previewQuotaNormal: QuotaWindowView = {
  state: 'normal', light: 'green', resetAt: QUOTA_RESET_AT, resetText: `${RESET_CLOCK} 重置`,
  staffUsedTurnsText: '员工已用约 41 回合', staffLeftTurnsText: '员工还可用约 76 回合',
  // P86：本窗口员工已用 token（文字与原始数字），与 fixtureQuotaWindow 逐字一致。
  staffUsedTokensText: '2.45M token', staffUsedTokens: 2_450_000,
  reserveText: '给你留出三成', holdText: null,
  barParts: { staffUsed: 0.24499999999999997, staffLeft: 0.45499999999999996, reserved: 0.30000000000000004 },
  lightLabel: '额度充足', lightHint: '员工按正常节奏开工。', waitText: null,
}

/** 额度窗口：员工份额用完（红）。 */
export const previewQuotaStaffFull: QuotaWindowView = {
  state: 'staff_full', light: 'red', resetAt: QUOTA_RESET_AT, resetText: `${RESET_CLOCK} 重置`,
  staffUsedTurnsText: '员工已用约 117 回合', staffLeftTurnsText: '已到上限',
  staffUsedTokensText: '7M token', staffUsedTokens: 7_000_000,
  reserveText: '给你留出三成', holdText: null,
  barParts: { staffUsed: 0.7, staffLeft: 0, reserved: 0.30000000000000004 },
  lightLabel: '员工份额已用完', lightHint: `员工在 ${RESET_CLOCK} 前不开新回合；你发起的对话不受影响。`,
  waitText: `额度恢复，约 ${RESET_CLOCK} 继续`,
}

/** 额度窗口：你自己要用（owner_hold，绿）。 */
export const previewQuotaOwnerHold: QuotaWindowView = {
  state: 'owner_hold', light: 'green', resetAt: QUOTA_RESET_AT, resetText: `${RESET_CLOCK} 重置`,
  staffUsedTurnsText: '员工已用约 41 回合', staffLeftTurnsText: '员工还可用约 76 回合',
  staffUsedTokensText: '2.45M token', staffUsedTokens: 2_450_000,
  reserveText: '给你留出三成', holdText: `你要自己用到 ${HOLD_CLOCK}，员工不开新回合`,
  barParts: { staffUsed: 0.24499999999999997, staffLeft: 0.45499999999999996, reserved: 0.30000000000000004 },
  lightLabel: '额度充足', lightHint: `你要自己用到 ${HOLD_CLOCK}。员工按正常节奏开工。`,
  waitText: `额度恢复，约 ${HOLD_CLOCK} 继续`,
}
