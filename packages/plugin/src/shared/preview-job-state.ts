/**
 * 预览「按入口准备样例状态」（P74i-m2 第 1 节）：把 scripts/dev/ui-preview.tsx 里
 * ?job= 十个入口各自要做的状态准备（选线程、员工名单里的总管、项目挂主题与「一件事」行、
 * 「待你处理」加条目并同步计数）整理成纯函数，不启动服务、不碰 window/location/document，
 * 因此可以被 vitest 直接引用——此前这段逻辑只在预览脚本里，出了「先用后赋值」这类错
 * （复走查 R-1，页面直接白屏）四条验收命令都发现不了，现在每个入口都有测试守着。
 *
 * P74i-m2（复走查 R-4）：私聊样例（b2/ask/escalation/stop/approval/escalation-states）
 * 的线程是样例总管的私聊，进入时必须让界面把它当总管入口——员工名单里保留且只保留
 * 这一位总管（此前名单里已有 bot-zongguan 时样例总管进不了名单，顶部状态行看不到）。
 * P74i-m2（走查 S-5）：?job=delivery 的项目页里，同一张事务清单既有「一件事」的新行、
 * 也有旧事务行，便于比对两种行的列对齐。
 */
import type { HubState } from '../client/hub-state.js'
import type { InboxItemView, ThreadView } from './views.js'
import { fixtureOverview, fixtureInbox, fixtureActivity, fixtureSettings, fixtureBots, fixtureThreads } from './fixtures.js'
import { fixtureOffice } from './fixture-office.js'
import { fixtureResource } from './fixture-resource.js'
import { fixtureProject, fixtureTopicThreads } from './fixture-project.js'
import {
  previewLocalDirLine, previewLocalHow, previewLocalRiskNote, previewPlainRiskNote, previewLocalDirCardsThread,
  previewApprovalInboxEntries, previewApprovalThread, previewAskThread, previewB2InboxEntry, previewB2Thread,
  previewChiefStallInboxEntry, previewChosenEscalationInboxEntry, previewNoTopicAcceptInboxEntry, previewProposalInboxEntry,
  previewDeliveryStatesThread, previewDeliveryTopicThread, previewEscalationStatesThread, previewEscalationThread,
  previewJobInboxEntries, previewPartialTopicThread, previewProjectJobRows, previewChiefJobLine,
  previewReviewTopicThread, previewStopInboxEntry, previewStopThread,
  previewSuspendedAlertInboxEntry, previewSuspendedWaitThread, previewSuspendedYouThread,
  previewLaunchThread, previewLaunchRunningThread, previewLaunchFailedThread, previewLaunchDoneThread, previewLaunchGiveUpThread,
} from './fixture-job-preview.js'
import { previewRetroTopicThread } from './fixture-retro-preview.js'

/**
 * 十三个预览入口（地址参数 ?job= 的取值），与 ui-preview 的地址解析一一对应。
 * P75k 新增 retro（主题里的「复盘」折叠组）；P74r20 新增 launch（发布这一步各种结果）；P81r1 新增 localdir（已有文件夹、原来的位置两种约定卡）。
 */
export const PREVIEW_JOB_ENTRIES = [
  'topic', 'b2', 'ask', 'review', 'delivery', 'escalation', 'delivery-states', 'stop', 'approval', 'escalation-states', 'retro', 'launch', 'localdir',
] as const
export type PreviewJobEntry = typeof PREVIEW_JOB_ENTRIES[number]

/**
 * P81：带发布位置（本机文件夹）的预览变体：地址里加 &local=1 时，b2 入口那张待确认的约定卡多一行「发布到本机文件夹：…」，
 * launch 入口里发布审批卡的风险提示多出这个文件夹。快照本身不变；变体的文字与 core 的输出由测试逐字对照
 * （test/p81-local-dir-ui.test.tsx：约定卡与 fixture-job.ts 里 core 生成的 sampleB2LocalDirCard 相同，提示句与 core 的 hostCommandRiskNote 相同）。
 * 其他入口原样返回。纯函数，不改入参。
 */
export function withLocalDirVariant(entry: PreviewJobEntry, thread: ThreadView): ThreadView {
  if (entry === 'launch') {
    const variant = JSON.parse(JSON.stringify(thread).split(previewPlainRiskNote).join(previewLocalRiskNote)) as ThreadView
    // P81r1 第 3.8 节排查结论：样例里唯一带发布位置的那张发布审批卡已经是「已批准」，
    // ApprovalBlock 在已答复的卡上只画结果行、不画风险提示，所以页面上找不到带位置的那一句。
    // 这个预览变体只用于看提示句：把那张卡改成仍在等批准（预览专用，不改快照本身）。
    const card = variant.messages.flatMap(message => message.card ?? []).find(item => item.approval?.launch === true)
    if (card !== undefined) {
      card.status = 'open'
      card.answer = null
      card.options = ['批准', '拒绝']
    }
    return variant
  }
  if (entry !== 'b2') return thread
  const copy = structuredClone(thread)
  const card = copy.messages.at(-1)?.agreement
  if (card === undefined || card === null) return copy
  card.launchLine = `验收之后对外发布：${previewLocalHow}。发布前单独请你批准。`
  card.localDirLine = previewLocalDirLine
  return copy
}

/** 一个入口对应的样例线程（快照由 core 的视图函数生成，一致性测试钉住）。 */
export function previewJobThreadOf(entry: PreviewJobEntry): ThreadView {
  const thread = entry === 'b2' ? previewB2Thread
    : entry === 'ask' ? previewAskThread
    : entry === 'review' ? previewReviewTopicThread
    : entry === 'delivery' ? previewDeliveryTopicThread
    : entry === 'escalation' ? previewEscalationThread
    : entry === 'delivery-states' ? previewDeliveryStatesThread
    : entry === 'stop' ? previewStopThread
    : entry === 'approval' ? previewApprovalThread
    : entry === 'escalation-states' ? previewEscalationStatesThread
    // P75k：?job=retro 是主题里的「复盘」折叠组（复盘卡、核对卡、改写卡、小结；快照由 core 的视图函数生成）。
    : entry === 'retro' ? previewRetroTopicThread
    : entry === 'launch' ? previewLaunchThread
    : entry === 'localdir' ? previewLocalDirCardsThread()
    // P74i-m3（第 8 节第 3 条）：?job=topic 用「只加载最新一页」的线程，走查能看到「更早的 n 条还没有加载」
    // 与折叠组里的同类提示；完整那一版（previewJobTopicThread）仍由一致性测试钉住。
    : previewPartialTopicThread
  return structuredClone(thread)
}

/**
 * P74i-m7（第 2 节第 2 条）：入口里随附的另一个主题线程（不新增入口）。进度行「在等」的两种写法需要各有一件事，
 * 而四个主题入口各自的主题上已经有一件事，所以随附的主题放进同一个入口的项目下，从左栏主题列表点进去看：
 * review 随附「执行者被停用、总管在岗」（在等：周岚（已停用）），delivery-states 随附「总管也被停用」（在等：你）。
 */
export function previewJobExtraThreadsOf(entry: PreviewJobEntry): ThreadView[] {
  if (entry === 'review') return [structuredClone(previewSuspendedWaitThread)]
  if (entry === 'delivery-states') return [structuredClone(previewSuspendedYouThread)]
  // P74r20：发布这一步各种结果的四个主题（运行中、没有成功、已发布、执行者无法改正），主线程是总管私聊。
  if (entry === 'launch') return [previewLaunchRunningThread, previewLaunchFailedThread, previewLaunchDoneThread, previewLaunchGiveUpThread].map(item => structuredClone(item))
  return []
}

/** 预览的初始仓库状态：与 ui-preview 里 createStore 的初值同一份（不含浏览器相关的部分）。 */export function basePreviewState(): HubState {
  return {
    overview: structuredClone(fixtureOverview), inbox: structuredClone(fixtureInbox), activity: structuredClone(fixtureActivity),
    office: structuredClone(fixtureOffice), resource: structuredClone(fixtureResource), project: structuredClone(fixtureProject),
    settings: structuredClone(fixtureSettings), weeklyUsage: null, weeklyUsageError: null, bots: structuredClone(fixtureBots),
    // P63：主题聊天的线程和私聊放在同一张表里，线程 id 就是主题 id。
    threads: Object.fromEntries(structuredClone([...fixtureThreads, ...fixtureTopicThreads]).map(t => [t.threadId, t])),
    // P75k：记忆页由预览服务（离线门面）回答，初始没有；教它技能的最近会话列表已随弹窗删除。
    memoryPage: null, memoryError: null, memoryFocusId: null, connectionDown: false, downReason: null,
    downMessage: null, settingsError: null, activityError: null, view: 'main', selectedThread: 'bot-tanlu', selectionExitSeq: 0, newBotRequest: 0, newProjectRequest: 0, activeProjectId: null, topicDraft: null, toasts: [],
    ledgers: {}, ledgerErrors: {}, skillLibraries: {}, skillLibraryErrors: {}, activeJobs: {}, activeJobsError: null,
  }
}

/** 几个快照导出是「单条或数组」两种形状（core 的 inbox 视图返回数组、个别样例是单条），统一成数组。 */
function asInboxItems(value: InboxItemView | InboxItemView[]): InboxItemView[] {
  return Array.isArray(value) ? value : [value]
}

/**
 * 把一个 ?job= 入口的样例状态并进仓库：选线程、员工名单的总管、项目挂主题与「一件事」行、
 * 「待你处理」加条目（含计数同步）。纯函数：不改入参，返回新状态；now 用于新增主题行的时间。
 * 与 ui-preview 原来的三段 store.update 完全等价（同一次更新做完，顺序不变）。
 */
export function applyPreviewJobEntry(state: HubState, entry: PreviewJobEntry, now: number, options: { localDir?: boolean } = {}): HubState {
  // P81：options.localDir 为真（地址里带 &local=1）时用带发布位置的变体；默认与以前完全一致。
  const thread = options.localDir === true ? withLocalDirVariant(entry, previewJobThreadOf(entry)) : previewJobThreadOf(entry)
  // 随附的主题线程（只有 review、delivery-states 有）：进仓库、进项目的主题列表，但不改选中的线程。
  const extraThreads = previewJobExtraThreadsOf(entry)
  // 员工名单：私聊样例的线程是样例总管的私聊，名单里保留且只保留这一位总管（R-4）。
  // 主题样例（ptp_ 开头）不动名单。照第一位员工的卡造一张在岗总管卡（id 就是线程 id，界面对话区找得到它）。
  const chiefThread = thread.threadId.startsWith('ptp_') === false
  let overview = state.overview
  if (overview !== null && chiefThread) {
    const others = overview.bots.filter(bot => !(bot.role === 'chief' && bot.id !== thread.threadId))
    const template = overview.bots[0]
    if (template !== undefined) {
      const already = others.some(bot => bot.id === thread.threadId)
      const chiefCard = { ...structuredClone(template), id: thread.threadId, name: thread.title, color: '#5b6b8c',
        initials: '总', role: 'chief' as const, roleLabel: '总管',
        unread: 1, waitingOwner: true, lastActiveText: '刚刚' }
      overview = { ...overview, bots: already ? others : [...others, chiefCard] }
    }
  }
  // 主题只挂在一个项目名下：交付样例挂「活动报名页」项目（与它的「一件事」行同项目，S-6）；
  // P75r7（C3）：复盘样例的主题标题是「活动报名页（复盘）」，也挂到「活动报名页」项目，标题与所属项目对上；
  // 其余主题样例挂在左栏第一个项目（P74h-m1：不再每个项目都出现）。
  const attachProjectId = entry === 'delivery' || entry === 'retro' ? 'prj_signup' : null
  let project = state.project
  // P74r20：主线程是总管私聊、但带随附主题的入口（launch）也要把随附的主题挂进项目，主线程自己不是主题所以不挂。
  if ((thread.threadId.startsWith('ptp_') || extraThreads.length > 0) && project !== null) {
    project = { ...project, projects: project.projects.map(row => {
      const attach = attachProjectId !== null ? row.project.id === attachProjectId : project!.projects.indexOf(row) === 0
      if (!attach) return row
      // 选中的主题在最前，随附的主题紧随其后；已经在列表里的不重复加。
      const added = [...(thread.threadId.startsWith('ptp_') ? [thread] : []), ...extraThreads]
        .filter(item => !row.topics.some(topic => topic.id === item.threadId))
        .map(item => ({ id: item.threadId, title: item.title, lastMessageAt: now, lastMessageText: '刚刚', unread: 0, lastMessagePreview: '', lastMessageFrom: '总管' }))
      return added.length > 0 ? { ...row, topics: [...added, ...row.topics] } : row
    }) }
  }
  // 交付与三轮不过的样例同时带出侧栏与项目页：总管那一行写「2 件在办」，
  // 「活动报名页」项目的事务清单前排三件事（快照由 core 的 chiefJobLine / projectJobRows 生成）。
  // P74i-m2（S-5）：同一张清单里再补一条旧事务行，新旧两种行并排，便于比对列对齐。
  if ((entry === 'delivery' || entry === 'escalation') && overview !== null && project !== null) {
    overview = { ...overview, bots: overview.bots.map(bot => bot.role === 'chief' ? { ...bot, chiefJobLine: structuredClone(previewChiefJobLine) } : bot) }
    project = { ...project, projects: project.projects.map(row => {
      if (row.project.id !== 'prj_signup') return row
      const withJobs = { ...row, jobRows: structuredClone(previewProjectJobRows) }
      if (row.tasks.length > 0) return withJobs
      const templateRow = project!.projects.find(item => item.project.id === 'prj_weekly')
      const templateTask = templateRow?.tasks.find(item => item.task.status === 'doing') ?? templateRow?.tasks[0]
      if (templateTask === undefined) return withJobs
      const oldTask = structuredClone(templateTask)
      oldTask.task = { ...oldTask.task, id: 'pt_preview_signup_old', projectId: row.project.id, title: '往期名单导出' }
      Object.assign(oldTask, { title: '往期名单导出', topicId: null })
      return {
        ...withJobs,
        tasks: [oldTask],
        taskCounts: { ...withJobs.taskCounts, doing: withJobs.taskCounts.doing + 1, total: withJobs.taskCounts.total + 1 },
        progress: withJobs.taskCounts.accepted / (withJobs.taskCounts.total + 1),
      }
    }) }
  }
  // 「待你处理」加条目并同步左栏与顶部的计数（走查 D-13）：
  // b2 带两栏的约定条目、delivery 一件事的四类条目、stop 带停止标记的约定条目、
  // approval 普通与发布审批各一条（已作废的只在私聊里）。
  let inbox = state.inbox
  // P74i-m5（第 7 节第 2 条）：三种以前看不到的条目各放进一个已有入口，不新增入口——
  // escalation-states：已经选过办法的说明卡条目（没有「都不合适」）；
  // delivery：没有主题编号的验收条目（没有「有不符」）；
  // approval：按钮是「接受」「不做」的提议。
  const inboxEntries = entry === 'b2' || entry === 'delivery' || entry === 'stop' || entry === 'approval' || entry === 'escalation-states'
    ? entry === 'approval' ? [...asInboxItems(structuredClone(previewApprovalInboxEntries) as InboxItemView | InboxItemView[]), structuredClone(previewProposalInboxEntry)]
      // P74i-m4（第 5 节第 3 条）：B2 的约定确认条目由核心的 inbox 视图函数生成（快照 previewB2InboxEntry），
      // 带主题编号、约定编号与版本号、两栏标记，与真实数据同一个形状；原先这里是手写的视图对象。
      : entry === 'b2' ? asInboxItems(structuredClone(previewB2InboxEntry))
        : entry === 'stop' ? asInboxItems(structuredClone(previewStopInboxEntry) as InboxItemView | InboxItemView[])
          // P74i-m6（第 1 节第 2 条）：escalation-states 另加一条「没有进展」条目（总管自己核对的回合被中心结束两次）。
          // P74i-m7（第 1、2 节）：再加一条员工被中心停用的告警（带「恢复在岗」）。
          : entry === 'escalation-states' ? [structuredClone(previewChosenEscalationInboxEntry), structuredClone(previewChiefStallInboxEntry), structuredClone(previewSuspendedAlertInboxEntry)]
            : [...asInboxItems(structuredClone(previewJobInboxEntries)), structuredClone(previewNoTopicAcceptInboxEntry)]
    : null
  if (inboxEntries !== null && inbox !== null) {
    // P74i-m5（第 7 节第 1 条）：一份约定同一时间只会有一条等确认的条目。新加进来的条目带约定编号时，
    // 基础样例里原有的约定确认条目（「活动报名页」第 2 版）不再保留，只留新加进来的这一条（?job=b2 原来同时出现第 2 版与第 4 版）。
    const addsAgreementEntry = inboxEntries.some(item => typeof item.agreementId === 'string' && item.agreementId !== '')
    const kept = addsAgreementEntry
      ? inbox.items.filter(item => typeof item.agreementId !== 'string' || item.agreementId === '')
      : inbox.items
    const items = [...kept, ...inboxEntries]
    inbox = { ...inbox, items }
    if (overview !== null) overview = { ...overview, inbox: { ...overview.inbox, total: items.length } }
  }
  return {
    ...state, overview, project, inbox,
    threads: { ...state.threads, ...Object.fromEntries(extraThreads.map(item => [item.threadId, item])), [thread.threadId]: thread },
    selectedThread: thread.threadId, view: 'main',
  }
}
