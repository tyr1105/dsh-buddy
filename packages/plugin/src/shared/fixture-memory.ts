/**
 * 样例记忆数据（P75k，样例数据模式专用）：照设计稿场景 D（你的纠正被记住）与场景 E（关于你的记忆）造样例，
 * 让离线走查和测试能看到：总管回复下面的「已记住」「已更正」「已删除」三种行，记忆页的四类条目
 * （规矩、决定和先例、偏好、项目背景）、固定规则、被引用次数、最近一次更正的「原为」、24 小时内可撤销的已删除。
 *
 * 做法（第一块的教训，与 fixture-skill.ts、fixture-job.ts 相同）：这个文件只写「记录」（core 的记忆、约定、项目、线程消息），
 * 视图一律走 core 对外的 UiApi（createUiApi 的 memoryPage、thread）生成：这里用 core 的 testing 环境
 * （内存存储加假时钟）种进这些记录，再取回视图。不手写任何视图字段：出处一行、范围一行、「被引用」、「原为」
 * 与「已记住」行的文字都由 core 生成，core 改了口径，样例会跟着变。
 * 撤销、更正、删除、撤销删除、撤销更正五个命令同样走 core 的 UiApi（在内存环境里真的改记录），
 * 所以离线模式点按钮之后看到的是 core 算出的结果。
 *
 * 与设计稿的差别（已在进度记录里写明）：设计稿 E 的规矩一组只列 3 条（含 1 条固定规则），而 core 的固定规则有 4 条，
 * 所以样例的规矩一组是 2 条自己写下的加 4 条固定规则；其余三类的条数与设计稿一致。
 * 样例文字不进文案登记表（见 docs/copy/strings.md「不登记」一条）。
 */
import { createUiApi, testing } from '@agent-hub/core'
import type { UiApi } from '@agent-hub/core'
import { TOPIC_AGREEMENT } from './fixture-job.js'
import type { MemoryPageView, ThreadView } from './views.js'

/** 样例时刻：2026-11-19 10:00（北京时间，周四）。 */
export const SAMPLE_MEMORY_NOW = Date.parse('2026-11-19T10:00:00+08:00')

/** 样例员工的固定编号（前缀加 10 位小写字母或数字，与 core 的 recordId 规则一致）。 */
export const SAMPLE_MEMORY_CHIEF_ID = 'b_samplememch'
const EXECUTOR_ID = 'b_samplememlz'

/** 样例项目与主题的固定编号。 */
export const SAMPLE_MEMORY_PROJECT_ID = 'prj_samplemem1'
const PROJECT_2_ID = 'prj_samplemem2'
const TOPIC_ID = 'ptp_samplemem1'

/** 样例记忆的固定编号：命令和测试按它取。 */
export const SAMPLE_MEMORY_IDS = {
  rulePlease: 'mem_samplerul1', // 提示文字以「请」字开头：总管私聊里说的，下面挂着「已记住」，被两份约定引用
  ruleConclusion: 'mem_samplerul2', // 汇报先给结论：被更正过一次，下面挂着「已更正」
  precedent: 'mem_sampleprc1', // 先例：活动报名页约定第 2 版
  prefScreenshot: 'mem_samplepre1', // 交付时附截图：在活动报名页主题里说的，被一份约定引用
  prefShort: 'mem_samplepre2',
  prefTime: 'mem_samplepre3',
  deleted: 'mem_sampledel1', // 两小时前删掉的一条，下面挂着「已删除」，24 小时内可撤销
} as const

/** 一个北京时间的时刻。 */
const at = (text: string): number => Date.parse(`2026-${text}:00+08:00`)

/** 总管私聊里的消息编号（视图里「已记住」行挂在哪条回复下面按它对）。 */
export const SAMPLE_MEMORY_MESSAGE_IDS = {
  ownerRemember: 'm_samplemem01', ownerReply: 'm_samplemem02',
  ownerCorrect: 'm_samplemem03', correctReply: 'm_samplemem04',
  ownerForget: 'm_samplemem05', forgetReply: 'm_samplemem06',
  /** P75r7（C2）：总管私聊里那张已定事项带记忆出处的约定卡。 */
  cardAgreement: 'm_samplemem07',
} as const

const OWNER_REMEMBER_TEXT = '以后页面上的提示文字都用「请」字开头，别再写「手机号格式不正确」这种说法。'
const OWNER_CORRECT_TEXT = '把汇报先给结论那条改成：汇报先给结论，再说原因。'
const OWNER_FORGET_TEXT = '把「回复里加表情」那条删了。'
/** P75r7（C2）：总管私聊里那张约定卡的约定编号（放在消息表之前，消息表要用它做 refId）。 */
const CARD_AGREEMENT_ID = 'agr_samplemem03'

/** 一条记忆记录的默认字段；只写变化的几项。 */
function memory(id: string, kind: 'rule' | 'preference' | 'precedent', text: string, rest: Record<string, unknown>) {
  return {
    id, kind, text, example: null, redLine: false, scope: { staff: 'all', projects: 'all' },
    source: { kind: 'owner_words', messageIds: [], quote: text, threadId: SAMPLE_MEMORY_CHIEF_ID },
    category: null, status: 'active', history: [], noteWakeId: null, replyMessageId: null,
    createdAt: at('11-18T10:12'), updatedAt: at('11-18T10:12'), endedAt: null, ...rest,
  }
}

const MEMORIES = [
  memory(SAMPLE_MEMORY_IDS.rulePlease, 'rule', '页面提示文字以「请」字开头。', {
    example: '例如「请填写 11 位手机号」', noteWakeId: 'w_samplemem01', replyMessageId: SAMPLE_MEMORY_MESSAGE_IDS.ownerReply,
    source: { kind: 'owner_words', messageIds: [SAMPLE_MEMORY_MESSAGE_IDS.ownerRemember], quote: OWNER_REMEMBER_TEXT, threadId: SAMPLE_MEMORY_CHIEF_ID },
    createdAt: at('11-18T10:12'), updatedAt: at('11-18T10:12'),
  }),
  // 汇报先给结论：写下的是迁移来的旧规矩；11-18 在总管私聊里被更正过一次（旧说法进历史，下面挂着「已更正」）。
  memory(SAMPLE_MEMORY_IDS.ruleConclusion, 'rule', '汇报先给结论，再说原因。', {
    source: { kind: 'legacy_owner_rule', messageIds: [], quote: '汇报先给结论', threadId: null },
    history: [{
      text: '汇报先给结论', at: at('11-18T16:40'), by: 'chief', note: '你在总管私聊里更正', action: 'corrected', wakeId: 'w_samplemem02',
      replyMessageId: SAMPLE_MEMORY_MESSAGE_IDS.correctReply, threadId: SAMPLE_MEMORY_CHIEF_ID, undone: false,
      messageIds: [SAMPLE_MEMORY_MESSAGE_IDS.ownerCorrect], quote: OWNER_CORRECT_TEXT,
    }],
    createdAt: at('11-12T09:00'), updatedAt: at('11-18T16:40'),
  }),
  memory(SAMPLE_MEMORY_IDS.precedent, 'precedent', '报名、预约类名单存为本地表格，不接外部服务。', {
    source: { kind: 'agreement', messageIds: [], quote: '报名、预约类名单存为本地表格，不接外部服务。', threadId: null, agreementId: 'agr_samplejob1', versionNo: 2 },
    category: '表单页', createdAt: at('11-11T15:39'), updatedAt: at('11-11T15:39'),
  }),
  memory(SAMPLE_MEMORY_IDS.prefScreenshot, 'preference', '交付时附截图，不贴代码。', {
    source: { kind: 'owner_words', messageIds: [], quote: '交付的时候给我截图就行，别贴代码。', threadId: TOPIC_ID },
    createdAt: at('11-17T17:30'), updatedAt: at('11-17T17:30'),
  }),
  memory(SAMPLE_MEMORY_IDS.prefShort, 'preference', '汇报控制在三句话以内。', {
    createdAt: at('11-15T09:20'), updatedAt: at('11-15T09:20'),
    source: { kind: 'owner_words', messageIds: [], quote: '汇报控制在三句话以内。', threadId: SAMPLE_MEMORY_CHIEF_ID },
  }),
  memory(SAMPLE_MEMORY_IDS.prefTime, 'preference', '时间一律写成月日加时分。', {
    createdAt: at('11-14T14:05'), updatedAt: at('11-14T14:05'),
    source: { kind: 'owner_words', messageIds: [], quote: '时间一律写成月日加时分。', threadId: SAMPLE_MEMORY_CHIEF_ID },
  }),
  // 两小时前被删掉的一条：状态已删除，24 小时内可以撤销；线程里挂着「已删除」一行。
  memory(SAMPLE_MEMORY_IDS.deleted, 'preference', '回复里加表情。', {
    status: 'deleted', endedAt: SAMPLE_MEMORY_NOW - 2 * 3600_000, createdAt: at('11-16T11:00'), updatedAt: SAMPLE_MEMORY_NOW - 2 * 3600_000,
    source: { kind: 'owner_words', messageIds: [], quote: '回复里可以加表情。', threadId: SAMPLE_MEMORY_CHIEF_ID },
    history: [{
      text: '回复里加表情。', at: SAMPLE_MEMORY_NOW - 2 * 3600_000, by: 'chief', note: '你在总管私聊里要求删除', action: 'deleted', wakeId: 'w_samplemem03',
      replyMessageId: SAMPLE_MEMORY_MESSAGE_IDS.forgetReply, threadId: SAMPLE_MEMORY_CHIEF_ID, undone: false,
      messageIds: [SAMPLE_MEMORY_MESSAGE_IDS.ownerForget], quote: OWNER_FORGET_TEXT,
    }],
  }),
]

/** 总管私聊里的几条消息：三次对话，各带一行记忆变化。按时间先后排（P75r7 复核：约定卡在 11-17，排在最前）。 */
const MESSAGES = [
  // P75r7（C2）：一张已定事项带记忆出处的约定卡，由核心的约定卡视图生成（出处可点）。
  { id: SAMPLE_MEMORY_MESSAGE_IDS.cardAgreement, thread: SAMPLE_MEMORY_CHIEF_ID, from: SAMPLE_MEMORY_CHIEF_ID, kind: 'agreement',
    text: '约定「活动报名页」第 1 版', refId: CARD_AGREEMENT_ID, createdAt: at('11-17T17:35'), readAt: at('11-17T17:35') },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.ownerRemember, thread: SAMPLE_MEMORY_CHIEF_ID, from: 'owner', kind: 'chat', text: OWNER_REMEMBER_TEXT, refId: null, createdAt: at('11-18T10:12'), readAt: at('11-18T10:12') },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.ownerReply, thread: SAMPLE_MEMORY_CHIEF_ID, from: SAMPLE_MEMORY_CHIEF_ID, kind: 'reply',
    text: '已记住：以后所有员工写页面提示文字，都以「请」字开头，例如「请填写 11 位手机号」。适用于全部员工、全部项目。', refId: null, createdAt: at('11-18T10:12') + 30_000, readAt: null },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.ownerCorrect, thread: SAMPLE_MEMORY_CHIEF_ID, from: 'owner', kind: 'chat', text: OWNER_CORRECT_TEXT, refId: null, createdAt: at('11-18T16:40'), readAt: at('11-18T16:40') },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.correctReply, thread: SAMPLE_MEMORY_CHIEF_ID, from: SAMPLE_MEMORY_CHIEF_ID, kind: 'reply',
    text: '已更正：汇报先给结论，再说原因。', refId: null, createdAt: at('11-18T16:40') + 30_000, readAt: null },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.ownerForget, thread: SAMPLE_MEMORY_CHIEF_ID, from: 'owner', kind: 'chat', text: OWNER_FORGET_TEXT, refId: null,
    createdAt: SAMPLE_MEMORY_NOW - 2 * 3600_000, readAt: SAMPLE_MEMORY_NOW - 2 * 3600_000 },
  { id: SAMPLE_MEMORY_MESSAGE_IDS.forgetReply, thread: SAMPLE_MEMORY_CHIEF_ID, from: SAMPLE_MEMORY_CHIEF_ID, kind: 'reply',
    text: '已删除：回复里加表情。', refId: null, createdAt: SAMPLE_MEMORY_NOW - 2 * 3600_000 + 30_000, readAt: null },
]

/** 引用记忆的约定：照场景 A 的约定改两处（编号、已定事项里写明出处是哪条记忆），用来算出「被引用 n 次」。 */
function citingAgreement(id: string, memoryIds: string[]) {
  const first = TOPIC_AGREEMENT.versions.at(-1)!
  return {
    ...TOPIC_AGREEMENT, id, topicId: TOPIC_ID, versions: [{
      ...first, no: 1, content: {
        ...first.content,
        decided: memoryIds.map(memoryId => ({
          text: '提示文字按你的规矩写。', basis: { kind: 'source' as const, ref: memoryId, refText: '你的规矩' },
        })),
      },
    }],
  }
}

/**
 * P75r7（C2）：总管私聊里的一张已定事项带记忆出处的约定卡（已固定，出处可点，跳到记忆页那一条）。
 * 已定事项的出处指向「汇报控制在三句话以内」（偏好），由核心的约定卡视图生成 memoryId 与「出处：你的偏好（11月15日）」。
 * 这张卡同时被 memoryPage 算作一次引用，所以那条偏好的「被引用 1 次」也由核心数出来。
 */
function cardAgreement(): Record<string, unknown> {
  const first = TOPIC_AGREEMENT.versions.at(-1)!
  return {
    ...TOPIC_AGREEMENT, id: CARD_AGREEMENT_ID, topicId: TOPIC_ID, title: '活动报名页', state: 'locked',
    versions: [{
      ...first, no: 1, state: 'locked', changes: [], cardMessageId: SAMPLE_MEMORY_MESSAGE_IDS.cardAgreement,
      lockedAt: at('11-17T17:35'), lockedVia: 'button',
      content: {
        ...first.content,
        decided: [{
          text: '汇报控制在三句话以内。',
          basis: { kind: 'source' as const, ref: SAMPLE_MEMORY_IDS.prefShort, refText: '汇报控制在三句话以内。' },
        }],
      },
    }],
  }
}

/** 一份样例记忆世界：种好记录的 core 环境，加上取视图、发命令用的 UiApi。 */
export interface MemorySample {
  /** core 的界面接口（记忆页、线程视图与五个记忆命令都走它）。 */
  api: UiApi
  /** 总管的员工编号（私聊线程编号同它）。 */
  chiefId: string
  /** 命令执行之后需要通知界面时用（离线门面接事件）。 */
  readonly events: ReadonlyArray<{ scope: string; botId: string | null }>
}

/** 造一份样例记忆世界。 */
export function createMemorySample(): MemorySample {
  const ctx = testing.createTestContext({ clock: new testing.FakeClock(SAMPLE_MEMORY_NOW) })
  for (const bot of [
    { id: SAMPLE_MEMORY_CHIEF_ID, name: '总管', color: '#5b6b8c' },
    { id: EXECUTOR_ID, name: '林舟', color: '#3f8f7a' },
  ]) ctx.store.table('bots').put(bot as never)
  ctx.store.table('projectTopics').put({
    id: TOPIC_ID, projectId: SAMPLE_MEMORY_PROJECT_ID, title: '活动报名页（11月18日上线）',
    createdAt: at('11-11T15:31'), updatedAt: at('11-17T17:30'), lastMessageAt: at('11-17T17:30'), agentTurnsSinceOwner: 0, pendingBotIds: [],
  } as never)
  // 两个项目：项目背景一组按项目页现算，所以项目页要有背景；活动报名页另有一条决策（放在「决定和先例」里、先例之后）。
  const project = (id: string, name: string, background: string, decisions: Array<{ text: string; at: number }>) => ({
    id, name, charter: '', vision: '', conventions: '', status: 'active', ownerBotId: null, memberBotIds: [], sharedDir: `/样例/${id}`,
    acceptanceCriteria: [], context: { background, conventions: '', decisions, glossary: [] }, contextRevisions: [],
    backgroundUpdatedAt: at('11-13T10:00'), backgroundUpdatedBy: 'owner', createdAt: at('11-10T09:00'), updatedAt: at('11-13T10:00'), archivedAt: null,
  })
  ctx.store.table('projects').put(project(SAMPLE_MEMORY_PROJECT_ID, '活动报名页',
    'AI 产品沙龙，11月20日 14:00，望京 SOHO T3 12 层，限 80 人。来自你发的活动文案。', [{ text: '名单只保留最后一次提交。', at: at('11-12T10:00') }]) as never)
  ctx.store.table('projects').put(project(PROJECT_2_ID, '周报自动化', '每周五 17:00 前汇总团队周报，发到固定群里。', []) as never)
  // 引用记忆的两份约定（一份引用两条，一份引用一条），「被引用」次数由 core 数出来：请字规矩 2 次、附截图偏好 1 次。
  ctx.store.table('agreements').put(citingAgreement('agr_samplemem01', [SAMPLE_MEMORY_IDS.rulePlease, SAMPLE_MEMORY_IDS.prefScreenshot]) as never)
  ctx.store.table('agreements').put(citingAgreement('agr_samplemem02', [SAMPLE_MEMORY_IDS.rulePlease]) as never)
  // P75r7（C2）：总管私聊里那张出处可点的约定卡。
  ctx.store.table('agreements').put(cardAgreement() as never)
  ctx.store.table('agreements').put({ ...TOPIC_AGREEMENT, topicId: TOPIC_ID } as never)
  for (const row of MEMORIES) ctx.store.table('memories').put(row as never)
  for (const row of MESSAGES) ctx.store.log('thread').append(row as never)
  return { api: createUiApi(ctx, async () => undefined), chiefId: SAMPLE_MEMORY_CHIEF_ID, events: ctx.events }
}

/** 样例记忆页视图：由 core 的 memoryPage 生成。 */
export function sampleMemoryPage(sample: MemorySample = createMemorySample()): MemoryPageView {
  return sample.api.memoryPage()
}

/** 样例总管私聊线程（带「已记住」「已更正」「已删除」三行）：由 core 的 thread 视图生成。 */
export function sampleMemoryThread(sample: MemorySample = createMemorySample()): ThreadView {
  return sample.api.thread(sample.chiefId) as unknown as ThreadView
}
