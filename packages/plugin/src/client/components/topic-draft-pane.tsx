/**
 * 草稿主题的中栏（P60，2026-11-10）：项目里「新开会话」后看到的那张空聊天。
 *
 * 为什么不另画一个页面：草稿和真主题长得应该一模一样（标题、项目名、@ 成员、占位文字、
 * 输入框和发送失败的提示），所以直接复用 ThreadPane 的主题模式，只换三样：
 * - 线程是空的，楼层区换成一句「怎么开始」的说明；
 * - 输入框一挂载就拿到光标，点完入口就能打字；
 * - 「发送」不是往已有线程里发，而是带着第一句去建主题（规则在 logic/topic-draft.ts）。
 * 发送失败时 ThreadPane 会把中文原因显示在输入框下面，草稿文字保留，和平时发消息失败一样。
 */
import type { ReactNode } from 'react'
import type { BotCard, ProjectView } from '../../shared/views.js'
import { emptyDraftThread, topicDraftPaneInfo, type TopicDraft } from '../logic/topic-draft.js'
import type { CardActions } from './Cards.js'
import { ThreadPane } from './ThreadPane.js'

/** 草稿里没有卡片，卡片操作永远不会被调用；给一个空实现满足 ThreadPane 的参数。 */
const NO_CARD_ACTIONS: CardActions = { onPick: async () => null }

/** 草稿里没有「更多」菜单、没有横幅，这些回调都不会被触发。 */
const noop = (): void => undefined

export function TopicDraftPane(props: {
  draft: TopicDraft
  /** 项目视图：取项目名、负责人、成员和项目状态；还没到时先用通用占位。 */
  project: ProjectView | null
  bots: readonly BotCard[]
  /** 发出第一句：成功时父层会切进新主题；失败时抛出带中文原因的错误。 */
  onSendFirst: (projectId: string, text: string) => Promise<void>
}): ReactNode {
  const thread = emptyDraftThread(props.draft)
  const info = topicDraftPaneInfo(props.project, props.draft.projectId, props.bots)
  // 只读（项目暂停、完成、归档或已被删）时不放「怎么开始」，ThreadPane 会在底部换成只读说明。
  const intro = info.readOnlyText !== null ? undefined : (
    <div className="ah-thread-welcome">
      <h3>这条会话做什么？</h3>
      <p>直接说第一句。发出去会话就建好了，这句也是它的标题。</p>
    </div>
  )
  return (
    <ThreadPane
      threadId={thread.threadId}
      thread={thread}
      loading={false}
      intro={intro}
      header={{ name: info.title, roleLabel: null, activityText: null, nextThinkText: null, lifecycle: null, thinking: false }}
      inputPlaceholderName={info.title}
      banner={null}
      onBannerDismiss={noop}
      onLoadEarlier={noop}
      onSend={text => props.onSendFirst(props.draft.projectId, text)}
      actions={NO_CARD_ACTIONS}
      busyInboxId={null}
      onRetry={noop}
      error={null}
      onTeach={noop}
      onOpenSession={noop}
      onTogglePause={noop}
      onInterrupt={noop}
      topic={info}
      autoFocus
    />
  )
}
