/**
 * 样例项目容器视图（V2-PH4-02 样例数据模式专用）：给 FixtureHub 与离线走查提供一份
 * 与 fixtures.ts 三个样例队友（探路/巡检员/总管）一致的项目视图：
 * 一个进行中的富项目（含待办/进行中/受阻/待验收/已通过任务、失效成员与两条问题）、
 * 一个没有任务的空项目、一个暂停项目、一个仍有未验收任务的已完成项目、一个已归档项目。
 *
 * 为什么单独成文件：项目行内嵌成员/验收项/任务三层展开，混进 fixtures.ts 会淹没其他样例；
 * 形状严格照 core 的 ProjectView（api/project-views.ts），正式运行时由
 * /api/agent-hub/project 返回。这是静态样例，不追求像 projectView 那样自动拼标签与计数——
 * 中文标签、taskCounts、progress、counts 在本文件底部手工对齐（core 改口径时类型检查会报）。
 * 编制取消后负责人、成员与任务指派全部是队友 bot id，不再有席位这一层。
 */
import type {
  Project, ProjectContext, ProjectContextProposal, ProjectContextProposalView, ProjectContextRevision,
  ProjectContextRevisionView, ProjectCriterionView, ProjectIssueView, ProjectMemberView, ProjectTask,
  ProjectTaskArtifactView, ProjectTaskView, ProjectTaskWakeView, ProjectTopicView, ProjectView, ProjectViewRow, Role, TaskStatus,
  ThreadMessageView, ThreadView,
} from './views.js'

/** 样例基准时刻：与样例办公室/资料一致（2026-11-06 14:20 UTC），避免每次刷新漂移。 */
const NOW = Date.UTC(2026, 10, 6, 14, 20)
const MIN = 60_000
const DAY = 24 * 60 * MIN

/** 样例队友名字：与 fixtures.ts / fixture-office 保持一致。 */
const BOT_NAME: Readonly<Record<string, string>> = {
  'bot-tanlu': '探路',
  'bot-xunjian': '巡检员',
  'bot-zongguan': '总管',
}

/** 样例队友的执行风格：和 fixtures.ts 里的队友卡一致，项目页要显示。 */
const BOT_ROLE: Readonly<Record<string, { role: Role; roleLabel: string }>> = {
  'bot-tanlu': { role: 'researcher', roleLabel: '调研' },
  'bot-xunjian': { role: 'sentinel', roleLabel: '盯守' },
  'bot-zongguan': { role: 'chief', roleLabel: '总管' },
}

/** 项目状态中文标签（手工对齐 core PROJECT_STATUS_LABELS）。 */
const PROJECT_STATUS_LABEL: Record<Project['status'], string> = {
  active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档',
}
/** 任务状态中文标签（手工对齐 core TASK_STATUS_LABELS）。 */
const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办', doing: '进行中', blocked: '受阻',
  done_pending_check: '待验收', accepted: '已通过', rejected: '已驳回',
}
/** 验收项状态中文标签（手工对齐 core CRITERION_STATUS_LABELS）。 */
const CRITERION_STATUS_LABEL: Record<ProjectCriterionView['status'], string> = {
  open: '待验收', met: '已满足',
}

/** 造一条项目事实：样例只关心展示字段，时间戳显式给。 */
function project(input: {
  id: string
  name: string
  charter?: string
  vision?: string
  conventions?: string
  status: Project['status']
  ownerBotId?: string | null
  members?: string[]
  sharedDir?: string
  criteria?: Project['acceptanceCriteria']
  context?: ProjectContext
  contextRevisions?: ProjectContextRevision[]
  createdAt: number
  updatedAt?: number
  archivedAt?: number | null
}): Project {
  const createdAt = input.createdAt
  return {
    id: input.id,
    name: input.name,
    charter: input.charter ?? '',
    vision: input.vision ?? '',
    conventions: input.conventions ?? '',
    status: input.status,
    ownerBotId: input.ownerBotId ?? null,
    memberBotIds: input.members ?? [],
    sharedDir: input.sharedDir ?? `/Users/demo/AgentHub/projects/${input.id}/`,
    acceptanceCriteria: input.criteria ?? [],
    context: input.context ?? { background: '', conventions: '', decisions: [], glossary: [] },
    contextRevisions: input.contextRevisions ?? [],
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    archivedAt: input.archivedAt ?? null,
  }
}

/** 项目两层只读投影：与 core projectView 同口径（原始版本只读、共用同一目录）。 */
function layersOf(p: Project): ProjectViewRow['layers'] {
  return {
    original: { readOnly: true, workspaceDir: p.sharedDir },
    team: {
      readOnly: false,
      vision: p.vision,
      conventions: p.conventions,
      memberCount: p.memberBotIds.length,
      sharedDir: p.sharedDir,
      criterionCount: p.acceptanceCriteria.length,
    },
  }
}

/**
 * 项目共享上下文的视图字段（P39）：四段原样、空态、正文文件路径、留痕与待审建议。
 * 空态判断与 core isProjectContextEmpty 同口径：四段全空即不显示卡片。
 */
function contextOf(
  p: Project,
  extras: { revisions?: ProjectContextRevisionView[]; proposals?: ProjectContextProposalView[] } = {},
): Pick<ProjectViewRow, 'context' | 'contextEmpty' | 'contextFilePath' | 'contextRevisions' | 'contextProposals'> {
  const context = p.context
  return {
    context,
    contextEmpty: context.background.trim() === '' && context.conventions.trim() === ''
      && context.decisions.length === 0 && context.glossary.length === 0,
    contextFilePath: `${p.sharedDir}context.md`,
    contextRevisions: extras.revisions ?? [],
    contextProposals: extras.proposals ?? [],
  }
}

/** 造一条验收项事实。 */
function criterion(input: { id: string; text: string; verify?: string; status?: 'open' | 'met' }): Project['acceptanceCriteria'][number] {
  return { id: input.id, text: input.text, verify: input.verify ?? '', status: input.status ?? 'open' }
}

/** 造一条任务事实：wakeIds 与任务行链接保持一致；artifactIds 本卡只读，恒为空数组；dueAt 不设。 */
function task(input: {
  id: string
  projectId: string
  title: string
  detail?: string
  assigneeBotId?: string | null
  status: TaskStatus
  wakeIds?: string[]
  createdAt: number
  updatedAt?: number
}): ProjectTask {
  const createdAt = input.createdAt
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    detail: input.detail ?? '',
    assigneeBotId: input.assigneeBotId ?? null,
    status: input.status,
    wakeIds: input.wakeIds ?? [],
    artifactIds: [],
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    dueAt: null,
  }
}

/** 造一条任务关联唤醒的链接视图（样例：账本在、队友已删除、查不到三种形态）。 */
function wake(input: {
  wakeId: string
  botId: string | null
  botName: string | null
  ledgerId: string | null
  variantLabel?: string | null
  statusLabel?: string | null
  triggerLabel?: string | null
  summary?: string | null
  openedAt?: number | null
  openedText?: string | null
}): ProjectTaskWakeView {
  return {
    wakeId: input.wakeId,
    botId: input.botId,
    botName: input.botName,
    ledgerId: input.ledgerId,
    variantLabel: input.variantLabel ?? null,
    statusLabel: input.statusLabel ?? null,
    triggerLabel: input.triggerLabel ?? null,
    summary: input.summary ?? null,
    openedAt: input.openedAt ?? null,
    openedText: input.openedText ?? null,
  }
}

/** 成员队友展开行：有效队友给名字；失效队友（已删除/退役）name 为 null 并标 invalid。 */
function member(botId: string, isOwner = false): ProjectMemberView {
  const name = BOT_NAME[botId] ?? null
  const style = BOT_ROLE[botId] ?? null
  return { botId, name, invalid: name === null, role: style?.role ?? null, roleLabel: style?.roleLabel ?? null, isOwner }
}

/** P60/P63 新项目页用的三块：背景、路径、主题。背景有内容的样例写明谁更新的，空的项目不编造。 */
function pageOf(p: Project, topics: ProjectTopicView[] = []): Pick<ProjectViewRow, 'background' | 'path' | 'topics'> {
  const hasText = p.context.background.trim() !== ''
  return {
    background: {
      text: p.context.background,
      updatedBy: hasText ? 'bot-tanlu' : null,
      updatedByName: hasText ? '探路' : null,
      updatedAt: hasText ? NOW - 2 * 60 * MIN : null,
      updatedText: hasText ? '今天 12:20' : null,
    },
    path: { workspaceDir: p.sharedDir, sharedDir: p.sharedDir },
    topics,
  }
}

// ---------- P63 主题聊天的样例楼层 ----------

/** 样例楼层的发言人：名字和头像色跟 fixtures.ts 的队友一致。 */
const FLOOR_SENDER: Readonly<Record<string, { fromName: string; fromColor: string | null }>> = {
  owner: { fromName: '主人', fromColor: null },
  hub: { fromName: 'Agent 中心', fromColor: null },
  'bot-tanlu': { fromName: '探路', fromColor: 'var(--dsw-alias-success)' },
  'bot-xunjian': { fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)' },
  'bot-gone': { fromName: '已删除的队友', fromColor: null },
}

/** 造一层楼：样例只关心谁说的、说了什么、几点说的。 */
function floor(thread: string, index: number, from: string, kind: ThreadMessageView['kind'], text: string, minutesAgo: number): ThreadMessageView {
  const sender = FLOOR_SENDER[from]!
  return { id: `${thread}_m${index}`, thread, from, ...sender, kind, text, createdAt: NOW - minutesAgo * MIN, timeText: `${minutesAgo} 分钟前`, card: null }
}

const TOPIC_PRICE = 'ptp_weekly_price'
const TOPIC_SOURCES = 'ptp_weekly_sources'

/** 两条样例主题：一条讨论还在进行，一条已经到上限等主人。 */
export const fixtureTopicThreads: ThreadView[] = [
  {
    threadId: TOPIC_PRICE, title: '这周周报先把价格变化列出来', hasMore: false, oldestId: `${TOPIC_PRICE}_m1`,
    messages: [
      floor(TOPIC_PRICE, 1, 'owner', 'chat', '这周周报先把价格变化列出来\n五家都要有，抓不到的单独写一节。', 42),
      floor(TOPIC_PRICE, 2, 'bot-tanlu', 'reply', '收到。价格这块我来抓。@巡检员 帮我看下两家需要登录的站点还能不能进。', 40),
      floor(TOPIC_PRICE, 3, 'bot-xunjian', 'reply', '看了，A 站登录态过期了，B 站正常。我先把 A 站记成受阻。', 36),
      floor(TOPIC_PRICE, 4, 'hub', 'system', '点名的 老周（现在不在岗）这次没有叫醒。', 35),
      floor(TOPIC_PRICE, 5, 'bot-tanlu', 'reply', '好。A 站先用公开价格页，缺的部分周报里单独写「缺漏」。今天下午出初稿。', 30),
    ],
  },
  {
    threadId: TOPIC_SOURCES, title: '信源要不要加上公众号', hasMore: false, oldestId: `${TOPIC_SOURCES}_m1`,
    messages: [
      floor(TOPIC_SOURCES, 1, 'owner', 'chat', '信源要不要加上公众号？你们讨论一下给我结论。', 25),
      floor(TOPIC_SOURCES, 2, 'bot-tanlu', 'reply', '我倾向加，竞品的促销大多先发公众号。@巡检员 抓取上有风险吗？', 24),
      floor(TOPIC_SOURCES, 3, 'bot-xunjian', 'reply', '有风险，公众号没有稳定的公开入口，容易断。可以先手工收，一周看一次。', 22),
      floor(TOPIC_SOURCES, 4, 'bot-gone', 'reply', '（这位队友已经不在了，历史发言还留着。）', 21),
      floor(TOPIC_SOURCES, 5, 'bot-tanlu', 'report', '结论：先加两家核心竞品的公众号，手工收，一周一次；稳定了再考虑自动。', 20),
      floor(TOPIC_SOURCES, 6, 'hub', 'system', '这轮讨论已到 8 次发言，等你下一句', 20),
    ],
  },
]

/** 主题列表的一行：预览取最后一条，未读数显式给，走查时能看到未读点。 */
function topicRow(thread: ThreadView, unread: number): ProjectTopicView {
  const last = thread.messages.at(-1)!
  return {
    id: thread.threadId, title: thread.title, lastMessageAt: last.createdAt, lastMessageText: last.timeText, unread,
    lastMessagePreview: last.text.slice(0, 60), lastMessageFrom: last.fromName,
  }
}

/** 产物结论中文标签（手工对齐 core ARTIFACT_VERDICT_LABELS）。 */
const VERDICT_LABEL: Record<NonNullable<ProjectTaskArtifactView['reviewVerdict']>, string> = {
  passed: '通过', not_done: '没做', incorrect: '做错', mismatch: '不是你要的',
}

/** 造一条已关联产物的视图行（固定版本，样例只关心展示字段）。 */
function artifact(input: {
  versionId: string
  artifactId: string
  number: number
  title: string
  createdAt: number
  createdText: string
  reviewVerdict?: ProjectTaskArtifactView['reviewVerdict']
  isLatest?: boolean
}): ProjectTaskArtifactView {
  const verdict = input.reviewVerdict ?? null
  return {
    versionId: input.versionId,
    artifactId: input.artifactId,
    number: input.number,
    title: input.title,
    bytes: 2048,
    createdAt: input.createdAt,
    createdText: input.createdText,
    sha256: 'a'.repeat(64),
    reviewVerdict: verdict,
    reviewLabel: verdict === null ? null : VERDICT_LABEL[verdict],
    isLatest: input.isLatest ?? true,
  }
}

/** 任务展开行：中文状态标签、指派队友与失效标记、关联唤醒链接、产物面板与验收提醒。 */
function taskRow(
  t: ProjectTask,
  wakes: ProjectTaskWakeView[] = [],
  artifacts: ProjectTaskArtifactView[] = [],
  hints: string[] = [],
  topicId: string | null = null,
): ProjectTaskView {
  const assigneeBotId = t.assigneeBotId
  const assigneeBotName = assigneeBotId === null ? null : BOT_NAME[assigneeBotId] ?? null
  return {
    task: t,
    title: t.title,
    assigneeName: assigneeBotName,
    topicId,
    statusLabel: TASK_STATUS_LABEL[t.status],
    assigneeBotId,
    assigneeBotName,
    // 与 core 口径一致：指派了但查不到队友（或已退役）才算失效。
    assigneeInvalid: assigneeBotId !== null && assigneeBotName === null,
    artifactCount: artifacts.length,
    wakes,
    artifacts,
    acceptance: { hints },
  }
}

/** 验收项展开行：补中文状态标签。 */
function criterionRow(c: Project['acceptanceCriteria'][number]): ProjectCriterionView {
  return { id: c.id, text: c.text, verify: c.verify, status: c.status, statusLabel: CRITERION_STATUS_LABEL[c.status] }
}

// ---------- 项目一：进行中的富项目（含全部关键任务状态与两条队友问题） ----------

const prjWeekly = project({
  id: 'prj_weekly',
  name: '竞品周报自动化',
  charter: '每周五自动汇总竞品变化，初稿交主人验收后再发出。',
  vision: '把竞品监控从每周手工翻网页，变成一份周五早上就能看的可信周报。',
  conventions: '只引用能打开原文的公开信息；涉及时效的结论先标记，等主人确认再对外发出。',
  status: 'active',
  ownerBotId: 'bot-tanlu',
  members: ['bot-tanlu', 'bot-xunjian', 'bot-gone'],
  sharedDir: '/Users/demo/AgentHub/projects/prj_weekly/',
  criteria: [
    criterion({ id: 'ac_weekly_1', text: '五家目标竞品全覆盖', verify: '核对信源清单', status: 'met' }),
    criterion({ id: 'ac_weekly_2', text: '变化按产品、价格、渠道分类' }),
    criterion({ id: 'ac_weekly_3', text: '每条结论都能打开原文链接', verify: '抽检两条' }),
  ],
  // P39：进行中的富项目带一份非空共享上下文，用来展示项目页卡片、留痕与唤醒包摘要素材。
  context: {
    background: '竞品动态现在靠人工每周翻官网与公众号，容易漏；先把五家核心竞品的公开变化自动收齐，周五出周报。',
    conventions: '只引用能打开原文的公开信息\n对外发出前先交主人验收\n价格变化必须标注抓取时间',
    decisions: [
      { id: 'dc_weekly_1', text: '先覆盖五家核心竞品，其余按需再扩', by: 'owner', at: NOW - 16 * DAY },
      { id: 'dc_weekly_2', text: '周报固定周五 09:00 前出初稿', by: 'bot-xunjian', at: NOW - 9 * DAY },
    ],
    glossary: [
      { term: '竞品快照', meaning: '同一站点同一天的公开页面存档，用于对比前后变化' },
      { term: '信源', meaning: '一条可打开原文的公开链接，含抓取时间与出处' },
    ],
  },
  contextRevisions: [
    {
      id: 'pcr_weekly_1', editorId: 'owner', editorKind: 'owner',
      summary: '修改：背景、约定、决策 +2、术语 +2', hash: 'a'.repeat(64), source: 'owner_edit', at: NOW - 16 * DAY,
    },
    {
      id: 'pcr_weekly_2', editorId: 'bot-xunjian', editorKind: 'bot',
      summary: '修改：决策 +1', hash: 'b'.repeat(64), source: 'bot_proposal', at: NOW - 9 * DAY,
    },
  ],
  createdAt: NOW - 20 * DAY,
  updatedAt: NOW - 2 * MIN,
})

// 任务创建时间故意按状态分组错开：视图行已按 core sortTasksForView 的分组顺序手工排好。
// 样例唤醒覆盖两种链接形态：可下钻（探路的两次唤醒）与队友已删除（禁用并说明）。
const wakeWk2 = wake({
  wakeId: 'wk2', botId: 'bot-tanlu', botName: '探路', ledgerId: 'wl_gc_wk2',
  variantLabel: '常规', statusLabel: '运行中', triggerLabel: '感知',
  summary: '任务日志：依赖服务今天又超时了 1 次', openedAt: NOW - 18 * MIN, openedText: '今天 14:02',
})
const wakeWk1 = wake({
  wakeId: 'wk1', botId: 'bot-tanlu', botName: '探路', ledgerId: 'wl_gc_wk1',
  variantLabel: '常规', statusLabel: '已交账', triggerLabel: '议程到期',
  summary: '承诺快到期：排查结论还剩 2 小时', openedAt: NOW - 6 * 60 * MIN, openedText: '今天 08:20',
})
const wakeRetired = wake({
  wakeId: 'wk_retired', botId: 'bot-retired', botName: null, ledgerId: 'wl_retired',
  variantLabel: '常规', statusLabel: '已交账', triggerLabel: '感知',
  summary: '已退役队友当时的一次唤醒', openedAt: NOW - 9 * DAY, openedText: '10月28日 14:20',
})

// 样例产物：待验收的周报挂两版（v1 是更早的通过版本，v2 最新且未单独验收）；
// 已通过的任务挂一版已通过的产物，用来展示「验收通过」后的样子。
const artWeeklyV2 = artifact({
  versionId: 'av_weekly_2', artifactId: 'art_weekly', number: 2, title: '第 45 周周报初稿',
  createdAt: NOW - 10 * MIN, createdText: '今天 14:10',
})
const artWeeklyV1 = artifact({
  versionId: 'av_weekly_1', artifactId: 'art_weekly', number: 1, title: '第 45 周周报初稿',
  createdAt: NOW - 3 * DAY, createdText: '11月3日 14:20', reviewVerdict: 'passed', isLatest: false,
})
const artDedupV3 = artifact({
  versionId: 'av_dedup_3', artifactId: 'art_dedup', number: 3, title: '信源去重规则说明',
  createdAt: NOW - 17 * DAY, createdText: '10月20日 14:20', reviewVerdict: 'passed',
})

const tWeekly6 = task({ id: 'pt_weekly_6', projectId: 'prj_weekly', title: '确定信源去重规则', assigneeBotId: 'bot-tanlu', status: 'accepted', createdAt: NOW - 18 * DAY, detail: '同一条发布不重复计数。' })
const tWeekly2 = task({ id: 'pt_weekly_2', projectId: 'prj_weekly', title: '抓取本周竞品动态', assigneeBotId: 'bot-tanlu', status: 'doing', wakeIds: ['wk2'], createdAt: NOW - 12 * DAY, detail: '按产品、价格、渠道三类归档。' })
const tWeekly4 = task({ id: 'pt_weekly_4', projectId: 'prj_weekly', title: '整理历史发布记录格式', assigneeBotId: 'bot-gone', status: 'doing', wakeIds: ['wk_retired'], createdAt: NOW - 10 * DAY, detail: '旧表字段不统一，需要先映射。' })
const tWeekly3 = task({ id: 'pt_weekly_3', projectId: 'prj_weekly', title: '目标站点登录态失效', assigneeBotId: 'bot-xunjian', status: 'blocked', createdAt: NOW - 3 * DAY, detail: '等主人更新只读账号。' })
const tWeekly1 = task({ id: 'pt_weekly_1', projectId: 'prj_weekly', title: '补齐两家新信源的登录方式', status: 'todo', createdAt: NOW - 1 * DAY })
const tWeekly5 = task({ id: 'pt_weekly_5', projectId: 'prj_weekly', title: '产出第 45 周周报初稿', assigneeBotId: 'bot-tanlu', status: 'done_pending_check', wakeIds: ['wk1'], createdAt: NOW - 30 * MIN, detail: '已按分类整理，等主人验收。' })

const weeklyIssues: ProjectIssueView[] = [
  // 顺序手工对齐 core collectProjectIssues：先成员问题，再任务指派问题。
  // 文案与 core 一致：正文只说人话，失效队友的 id 只放进 subjectBotId（界面放到悬停 title）。
  {
    level: 'warning', code: 'member_bot_invalid', subjectBotId: 'bot-gone',
    text: '项目「竞品周报自动化」有一名成员已删除或退役，请调整成员名单',
  },
  {
    level: 'error', code: 'task_assignee_invalid', subjectBotId: 'bot-gone',
    text: '任务「整理历史发布记录格式」指派的队友已删除或退役',
  },
]

// P39 留痕视图：与 core contextRevisionViews 同口径（时间倒序、人话编辑者/来源、哈希前 8 位）。
// 时间文案按样例基准时刻手工写，避免走本地时区函数导致每次刷新漂移。
const weeklyRevisionViews: ProjectContextRevisionView[] = [...prjWeekly.contextRevisions]
  .sort((a, b) => b.at - a.at)
  .map(revision => ({
    revision,
    editorName: revision.editorKind === 'owner' ? '主人' : (BOT_NAME[revision.editorId] ?? '已删除的队友'),
    editorKindLabel: revision.editorKind === 'owner' ? '主人' : '队友',
    sourceLabel: revision.source === 'owner_edit' ? '主人编辑' : '采纳队友建议',
    timeText: revision.at === NOW - 9 * DAY ? '10月28日 14:20' : '10月21日 14:20',
    hashShort: revision.hash.slice(0, 8),
  }))

// P39 待审建议：巡检员想补一条「抓取缺漏」的约定、把「信源」释义写细；主人还没处理。
const weeklyProposal: ProjectContextProposalView = {
  proposal: {
    id: 'pcp_weekly_1',
    projectId: 'prj_weekly',
    botId: 'bot-xunjian',
    context: {
      ...prjWeekly.context,
      conventions: `${prjWeekly.context.conventions}\n抓取失败的条目单独列「缺漏」一节`,
      glossary: [
        { term: '竞品快照', meaning: '同一站点同一天的公开页面存档，用于对比前后变化' },
        { term: '信源', meaning: '一条可打开原文的公开链接，含抓取时间、出处与抓取方式' },
      ],
    },
    note: '这周有两次抓取失败没写进周报，建议约定里明确「缺漏」一节，并把信源的出处要求写细。',
    status: 'pending',
    createdAt: NOW - 30 * MIN,
    decidedAt: null,
  },
  botName: '巡检员',
  botInvalid: false,
  createdText: '今天 13:50',
  summary: '修改：约定、术语内容',
}

const rowWeekly: ProjectViewRow = {
  project: prjWeekly,
  statusLabel: PROJECT_STATUS_LABEL.active,
  ownerBotId: 'bot-tanlu',
  ownerName: '探路',
  ownerInvalid: false,
  members: [member('bot-tanlu', true), member('bot-xunjian'), member('bot-gone')],
  criteria: prjWeekly.acceptanceCriteria.map(criterionRow),
  // 与 core TASK_SORT_GROUP 一致：doing/blocked 在前，todo/待验收居中，已通过沉底。
  // pt_weekly_2 是进行中有承接人的任务，让催办/改派入口在样例里可见；
  // pt_weekly_4 指派给失效队友，两条派活入口都不出现。
  tasks: [
    taskRow(tWeekly2, [wakeWk2], [], [], TOPIC_PRICE),
    taskRow(tWeekly4, [wakeRetired]),
    taskRow(tWeekly3),
    taskRow(tWeekly1),
    taskRow(tWeekly5, [wakeWk1], [artWeeklyV2, artWeeklyV1],
      ['最新产物 v2 还没有单独验收；验收通过会一并记为通过。']),
    taskRow(tWeekly6, [], [artDedupV3]),
  ],
  taskCounts: { todo: 1, doing: 2, blocked: 1, done_pending_check: 1, accepted: 1, rejected: 0, total: 6 },
  progress: 1 / 6,
  issues: weeklyIssues,
  layers: layersOf(prjWeekly),
  ...contextOf(prjWeekly, { revisions: weeklyRevisionViews, proposals: [weeklyProposal] }),
  ...pageOf(prjWeekly, [topicRow(fixtureTopicThreads[1]!, 2), topicRow(fixtureTopicThreads[0]!, 0)]),
}

// ---------- 项目二：进行中的空项目（没有负责人、成员、验收项与任务） ----------

const prjEmpty = project({
  id: 'prj_empty',
  name: '立项调研（暂未派活）',
  charter: '',
  status: 'active',
  createdAt: NOW - 1 * DAY,
  updatedAt: NOW - 1 * DAY,
})

const rowEmpty: ProjectViewRow = {
  project: prjEmpty,
  statusLabel: PROJECT_STATUS_LABEL.active,
  ownerBotId: null,
  ownerName: null,
  ownerInvalid: false,
  members: [],
  criteria: [],
  tasks: [],
  taskCounts: { todo: 0, doing: 0, blocked: 0, done_pending_check: 0, accepted: 0, rejected: 0, total: 0 },
  progress: 0,
  issues: [],
  layers: layersOf(prjEmpty),
  // 空项目保持空上下文：验证「四段全空即不显示卡片」。
  ...contextOf(prjEmpty),
  ...pageOf(prjEmpty),
}

// ---------- 项目三：暂停项目（一个已通过任务，无问题） ----------

const prjMigrate = project({
  id: 'prj_migrate',
  name: '旧版数据迁移',
  charter: '把 v1 值班记录迁到新格式，等信源改造排期。',
  status: 'paused',
  ownerBotId: 'bot-xunjian',
  members: ['bot-xunjian'],
  createdAt: NOW - 15 * DAY,
  updatedAt: NOW - 5 * DAY,
})
const tMigrate1 = task({ id: 'pt_migrate_1', projectId: 'prj_migrate', title: '盘点旧记录字段', assigneeBotId: 'bot-xunjian', status: 'accepted', createdAt: NOW - 14 * DAY })

const rowMigrate: ProjectViewRow = {
  project: prjMigrate,
  statusLabel: PROJECT_STATUS_LABEL.paused,
  ownerBotId: 'bot-xunjian',
  ownerName: '巡检员',
  ownerInvalid: false,
  members: [member('bot-xunjian', true)],
  criteria: [],
  tasks: [taskRow(tMigrate1)],
  taskCounts: { todo: 0, doing: 0, blocked: 0, done_pending_check: 0, accepted: 1, rejected: 0, total: 1 },
  progress: 1,
  issues: [],
  layers: layersOf(prjMigrate),
  ...contextOf(prjMigrate),
  ...pageOf(prjMigrate),
}

// ---------- 项目四：已完成但还有任务没验收（core 会给 warning） ----------

const prjOnboard = project({
  id: 'prj_onboard',
  name: '新队友入职流程',
  charter: '新队友上岗第一天要走完的固定动作。',
  status: 'done',
  ownerBotId: 'bot-zongguan',
  members: ['bot-zongguan', 'bot-tanlu'],
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW - 4 * DAY,
})
const tOnboard1 = task({ id: 'pt_onboard_1', projectId: 'prj_onboard', title: '写出入职清单', assigneeBotId: 'bot-zongguan', status: 'accepted', createdAt: NOW - 28 * DAY })
const tOnboard2 = task({ id: 'pt_onboard_2', projectId: 'prj_onboard', title: '第一次试跑走查', assigneeBotId: 'bot-tanlu', status: 'todo', createdAt: NOW - 6 * DAY, detail: '试岗结束后补做。' })

const rowOnboard: ProjectViewRow = {
  project: prjOnboard,
  statusLabel: PROJECT_STATUS_LABEL.done,
  ownerBotId: 'bot-zongguan',
  ownerName: '总管',
  ownerInvalid: false,
  members: [member('bot-zongguan'), member('bot-tanlu')],
  criteria: [],
  tasks: [taskRow(tOnboard2), taskRow(tOnboard1)],
  taskCounts: { todo: 1, doing: 0, blocked: 0, done_pending_check: 0, accepted: 1, rejected: 0, total: 2 },
  progress: 1 / 2,
  issues: [
    {
      level: 'warning', code: 'done_with_open_tasks',
      text: '项目已标记完成，但仍有 1 个任务未通过验收：「第一次试跑走查」',
    },
  ],
  layers: layersOf(prjOnboard),
  ...contextOf(prjOnboard),
  ...pageOf(prjOnboard),
}

// ---------- 项目五：已归档项目（沉底、不报问题，任务只读陈列） ----------

const prjOld = project({
  id: 'prj_old',
  name: 'v1 值班机器人上线',
  charter: '第一代值班流程，已被周报自动化取代。',
  status: 'archived',
  ownerBotId: null,
  members: [],
  createdAt: NOW - 90 * DAY,
  updatedAt: NOW - 60 * DAY,
  archivedAt: NOW - 60 * DAY,
})
const tOld1 = task({ id: 'pt_old_1', projectId: 'prj_old', title: '7×24 值班跑通', status: 'accepted', createdAt: NOW - 88 * DAY })

const rowOld: ProjectViewRow = {
  project: prjOld,
  statusLabel: PROJECT_STATUS_LABEL.archived,
  ownerBotId: null,
  ownerName: null,
  ownerInvalid: false,
  members: [],
  criteria: [],
  tasks: [taskRow(tOld1)],
  taskCounts: { todo: 0, doing: 0, blocked: 0, done_pending_check: 0, accepted: 1, rejected: 0, total: 1 },
  progress: 1,
  // 归档项目是历史陈列：core 的 collectProjectIssues 对归档项目直接返回空列表。
  issues: [],
  layers: layersOf(prjOld),
  ...contextOf(prjOld),
  ...pageOf(prjOld),
}

/**
 * 样例项目全貌：4 个未归档（进行中 2、暂停 1、完成 1）+ 1 个归档；
 * 任务合计 10 条，其中 1 条待主人验收。
 */
export const fixtureProject: ProjectView = {
  asOf: NOW,
  // 非归档在前（按创建时间）、归档沉底，与 core sortProjectsForView 的顺序一致。
  projects: [rowWeekly, rowEmpty, rowMigrate, rowOnboard, rowOld],
  counts: {
    active: 2,
    paused: 1,
    done: 1,
    archived: 1,
    total: 5,
    tasksTotal: 10,
    tasksPendingCheck: 1,
  },
}
