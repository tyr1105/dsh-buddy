/**
 * 项目主题聊天的界面规则（P60、P63）：认主题 id、从项目视图里找主题、把楼层分成「主题卡片 + 回复」、
 * 算出谁正在回复，以及「开一个新主题并进去」这一条流程。
 *
 * 为什么单独成文件：左栏、聊天页、项目页和新会话页都要用同一套判断。
 * 主题 id 就是线程 id，写成纯函数放一处，才不会有的地方认、有的地方不认。
 * 这里不存状态，只有 openNewTopic 会发命令，也是通过传进来的仓库发，方便测试。
 */
import type { BotCard, CommandResult, ProjectStatus, ProjectTopicView, ProjectView, ProjectViewRow, ThreadMessageView } from '../../shared/views.js'
import { mentionMembers, type MentionMember } from './mentions.js'

/** 主题 id 的前缀，由 core 的 newId('ptp') 生成。主题 id 同时就是线程 id。 */
const TOPIC_ID_PREFIX = 'ptp_'

/** 这个线程 id 是不是项目主题：只看前缀，不用等项目视图。 */
export function isTopicThreadId(threadId: string): boolean {
  return threadId.startsWith(TOPIC_ID_PREFIX)
}

/** 在项目视图里找到的一个主题，连同它所在的项目。 */
export interface FoundTopic {
  row: ProjectViewRow
  topic: ProjectTopicView
}

/** 从项目视图里找主题；视图还没到、或者形状不对时返回 null。 */
export function findTopic(view: ProjectView | null, topicId: string): FoundTopic | null {
  if (view === null || !Array.isArray(view.projects)) return null
  for (const row of view.projects) {
    const topic = row.topics?.find(item => item.id === topicId)
    if (topic !== undefined) return { row, topic }
  }
  return null
}

/** 楼层分好之后的样子：第一条是主题卡片，下面是回复，中间穿插中心的提示。 */
export interface TopicThreadModel {
  /** 主题卡片；更早的楼层还没加载时拿不到第一条，这时为 null。 */
  opening: ThreadMessageView | null
  /** 卡片之后的所有楼层，按时间先后，包含中心提示。 */
  floors: ThreadMessageView[]
  /** 回复数：只算人说的话，中心的提示不算。 */
  replyCount: number
  /** 「N 条回复」这一行的文案。 */
  countText: string
}

/**
 * 把一页消息分成主题卡片和回复。
 * 还有更早的消息没加载时，手里的第一条并不是主题原文，不能当卡片，
 * 数字也只是最近这一段，所以文案要说清楚。
 */
export function buildTopicThread(messages: readonly ThreadMessageView[], hasMore: boolean): TopicThreadModel {
  const first = messages[0]
  const opening = !hasMore && first !== undefined && first.from === 'owner' ? first : null
  const floors = opening === null ? [...messages] : messages.slice(1)
  const replyCount = floors.filter(message => message.from !== 'hub').length
  return {
    opening,
    floors,
    replyCount,
    countText: hasMore ? `最近 ${replyCount} 条回复，更早的在「更多」里` : `${replyCount} 条回复`,
  }
}

/** core 落「这轮讨论已到 N 次发言，等你下一句」时的原文形状；这句要比普通提示醒目。 */
const CAP_NOTE_PATTERN = /这轮讨论已到 \d+ 次发言/

/** 这条中心提示是不是「讨论到上限」：主人需要看见，否则会以为队友卡住了。 */
export function isTopicCapNote(message: Pick<ThreadMessageView, 'text'>): boolean {
  return CAP_NOTE_PATTERN.test(message.text)
}

/** 队友在主题里忙的时候，core 的活动句里带着主题名：「正在处理：回复主题「xx」」。名字截到 40 字。 */
const TOPIC_TITLE_IN_ACTIVITY_CHARS = 40

/** 按 core 的规则截主题名，拿去和活动句比对。 */
function titleInActivity(title: string): string {
  const chars = [...title]
  return chars.length <= TOPIC_TITLE_IN_ACTIVITY_CHARS ? title : `${chars.slice(0, TOPIC_TITLE_IN_ACTIVITY_CHARS).join('')}…`
}

/**
 * 这个主题里谁正在回复：项目成员里，正在跑或排着队、而且活动句说的就是这个主题的队友。
 * 同一位队友可能同时在忙别的事（私聊、别的主题），所以必须比对主题名，不能只看成员身份。
 */
export function topicReplyingNames(
  row: ProjectViewRow,
  title: string,
  bots: ReadonlyArray<Pick<BotCard, 'id' | 'name' | 'activity' | 'activityText'>>,
): string[] {
  const memberIds = new Set(row.members.map(member => member.botId))
  const marker = `主题「${titleInActivity(title)}」`
  return bots
    .filter(bot => memberIds.has(bot.id) && (bot.activity === 'thinking' || bot.activity === 'queued') && bot.activityText.includes(marker))
    .map(bot => bot.name)
}

/** 项目不在进行中时，主题里不能再说话，输入框换成这一句。 */
const TOPIC_READ_ONLY_TEXT: Readonly<Record<Exclude<ProjectStatus, 'active'>, string>> = {
  paused: '项目暂停中，恢复后才能接着讨论。',
  done: '项目已完成，这条会话只能看，不能再发言。',
  archived: '项目已归档，这条会话只能看，不能再发言。',
}

/** 负责人的显示名：项目上记着的负责人，没有就退回「负责人」三个字，占位句才读得通。 */
function ownerNameOf(row: ProjectViewRow): string {
  return row.ownerName ?? '负责人'
}

/** 聊天页要的主题信息。 */
export interface TopicPaneInfo {
  title: string
  projectName: string
  /** 输入框占位：默认发给谁、怎么点名。 */
  placeholder: string
  /** 项目不在进行中时的说明；有值就不显示输入框。 */
  readOnlyText: string | null
  /** 能 @ 的项目成员。 */
  members: MentionMember[]
  /** 正在回复的队友名字。 */
  replying: string[]
}

/** 项目视图还没到时的输入框占位：还不知道负责人是谁，只说能 @。草稿主题也用这一句。 */
export const TOPIC_PLACEHOLDER_FALLBACK = '说点什么，@ 可以点名…'

/**
 * 聊天页里「项目那一半」的信息：项目名、默认发给谁、能不能说话、能 @ 谁。
 * 真主题和草稿主题（还没发第一句的新会话，见 logic/topic-draft.ts）都用这一份，
 * 两边的占位文字、只读说明、@ 名单才不会各写一套慢慢走样。
 */
export function projectPaneBase(row: ProjectViewRow, bots: readonly BotCard[]): Omit<TopicPaneInfo, 'title' | 'replying'> {
  const status = row.project.status
  return {
    projectName: row.project.name,
    placeholder: `默认发给 ${ownerNameOf(row)}，@ 可以点名…`,
    readOnlyText: status === 'active' ? null : TOPIC_READ_ONLY_TEXT[status],
    // 主题里所有人都在同一条聊天，没有「正在对话的那一位」，所以不排除任何成员。
    members: mentionMembers(row, bots, ''),
  }
}

/** 项目视图还没到时的占位：先用线程标题把页面撑起来，到了再补全。 */
export function topicPaneInfo(found: FoundTopic | null, threadTitle: string | null, bots: readonly BotCard[]): TopicPaneInfo {
  if (found === null) {
    return { title: threadTitle ?? '项目会话', projectName: '', placeholder: TOPIC_PLACEHOLDER_FALLBACK, readOnlyText: null, members: [], replying: [] }
  }
  return {
    ...projectPaneBase(found.row, bots),
    title: found.topic.title,
    replying: topicReplyingNames(found.row, found.topic.title, bots),
  }
}

/** openNewTopic 只用得到仓库的这三样。 */
export interface TopicOpener {
  command(name: string, input: Record<string, unknown>): Promise<CommandResult>
  refreshProject(): Promise<void>
  selectThread(threadId: string): void
}

/**
 * 在项目里开一个主题并进去：成功返回 null，失败返回中文原因。
 * 先刷新项目视图再进：左栏马上能看到新主题，「主题还在不在」的核对也不会白跑一次。
 */
export async function openNewTopic(hub: TopicOpener, projectId: string, text: string): Promise<string | null> {
  try {
    const result = await hub.command('createProjectTopic', { projectId, text })
    if (!result.ok) return result.error
    const topicId = (result.data as { topicId?: unknown } | undefined)?.topicId
    if (typeof topicId !== 'string' || topicId === '') return '会话没有建成。请重试；仍失败请检查 DSH 运行状态。'
    await hub.refreshProject()
    hub.selectThread(topicId)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
