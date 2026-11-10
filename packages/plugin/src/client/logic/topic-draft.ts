/**
 * 草稿主题：项目里「新开会话」先进一个空聊天，第一句发出去才真正建成（P60，2026-11-10）。
 *
 * 为什么这样做：主人要的是「直接创建一个会话，然后我在里面聊天」。原来点「新开会话」
 * 要先在一个小框里写一句诉求才能建成，多了一步，也不像聊天。现在和 DSH 原生的「新会话」一样：
 * - 点项目页「新开会话」或左栏项目行的 ＋，中栏马上是这个项目的一个空主题聊天，标题先叫「新会话」；
 * - 在里面发出第一句，才调用现有的 createProjectTopic 建主题（引擎不改，标题照旧取自第一句），
 *   建成后切到真正的主题，第一句出现在楼里；
 * - 没发就离开，什么都不留下：草稿只是前端仓库里的一个字段，引擎里没有空主题，左栏也不会多一行。
 *
 * 草稿不进本地记忆，刷新后就没了，这是可以接受的（和原生新会话一致）。
 * 这个文件只放纯函数和一个发送流程，状态本身在 hub-state 的 topicDraft 字段里。
 */
import type { BotCard, ProjectView, ThreadView } from '../../shared/views.js'
import { openNewTopic, projectPaneBase, TOPIC_PLACEHOLDER_FALLBACK, type TopicOpener, type TopicPaneInfo } from './topics.js'

/**
 * 一份草稿：开在哪个项目，以及这是第几次打开。
 * seq 每次打开都加一：同一个项目再点一次「新开会话」也是一张全新的空白聊天，
 * 上次没发出去、打了一半的字不会冒出来（「没发就离开，什么都不留下」）。
 */
export interface TopicDraft {
  projectId: string
  seq: number
}

/** 草稿聊天的标题：第一句发出去之前，还不知道它叫什么。 */
export const TOPIC_DRAFT_TITLE = '新会话'

/** 项目视图读到了、里面却没有这个项目（被删了）：草稿只能看，不让主人写完才知道发不出去。 */
export const TOPIC_DRAFT_PROJECT_GONE_TEXT = '这个项目已经不在了。回项目页看看。'

/**
 * 草稿聊天在界面里用的线程 id。它只给聊天组件当 key 和草稿文字的存放键，
 * 绝不拿去请求接口：前缀既不是主题的 ptp_，也不是任何队友 id。
 */
export function topicDraftThreadId(draft: TopicDraft): string {
  return `topic-draft:${draft.projectId}:${draft.seq}`
}

/** 草稿聊天的空线程：还没有任何楼层，也没有更早的消息。 */
export function emptyDraftThread(draft: TopicDraft): ThreadView {
  return { threadId: topicDraftThreadId(draft), title: TOPIC_DRAFT_TITLE, messages: [], hasMore: false, oldestId: null }
}

/**
 * 草稿聊天页要的信息：标题先写「新会话」，项目名、占位、能 @ 的成员和真主题同一份规则。
 * - 项目视图还没到：先用通用占位撑起来，到了再补全；
 * - 项目被删了：给一句只读说明，不显示输入框；
 * - 项目暂停、完成、归档：和真主题一样只读（入口本来就不给开，这里防的是开着草稿时状态变了）。
 */
export function topicDraftPaneInfo(view: ProjectView | null, projectId: string, bots: readonly BotCard[]): TopicPaneInfo {
  const loaded = view !== null && Array.isArray(view.projects)
  const row = loaded ? view.projects.find(item => item.project.id === projectId) ?? null : null
  if (row === null) {
    return {
      title: TOPIC_DRAFT_TITLE, projectName: '', placeholder: TOPIC_PLACEHOLDER_FALLBACK,
      readOnlyText: loaded ? TOPIC_DRAFT_PROJECT_GONE_TEXT : null, members: [], replying: [],
    }
  }
  // 还没人回复，「正在回复」永远为空：活动句里的主题名要等第一句发出去才有。
  return { ...projectPaneBase(row, bots), title: TOPIC_DRAFT_TITLE, replying: [] }
}

/**
 * 在草稿里发出第一句：建主题并切进去。
 * 成功时 openNewTopic 会刷新项目视图再选中新主题，仓库的 selectThread 顺手清掉草稿，页面无缝换成真主题。
 * 失败时抛出带中文原因的错误：聊天组件接住后把原因显示在输入框下面，草稿文字原样留着，主人可以直接重试。
 */
export async function sendDraftFirstMessage(hub: TopicOpener, projectId: string, text: string): Promise<void> {
  const problem = await openNewTopic(hub, projectId, text)
  if (problem !== null) throw new Error(problem)
}

/**
 * 左栏用的「当前选中线程」：草稿摆在中栏时返回空串，让左栏哪一行都不亮。
 * 否则主人正对着一张空白的新会话，左栏却还亮着上一位队友或上一条主题，看着像是在那边说话。
 */
export function sidebarSelectedThread(input: { view: string; selectedThread: string; topicDraft: TopicDraft | null }): string {
  return input.view === 'main' && input.topicDraft !== null ? '' : input.selectedThread
}
