/**
 * 队友模式下的侧栏导航（P41 / P44）：挂在宿主侧栏根上，吃满整根侧栏。
 *
 * P44 起不再复用旧的「队友树 + 团队全景」两段式列表，而是三组导航
 * （办公室 → 队友 → 工作区）——与页面内降级列同一组件，保证两处 IA 一致。
 * 挂载点仍由 host-mount 统一创建（带 data-ah-space-own='team'）：
 * 队友模式常驻（收起态改由 compact 属性画图标列），对话模式不渲染。
 * 点击项先确保中心面板被选中，再切换视图/线程，主人在别的页面时也不会点空。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HubStore } from '../hub-state.js'
import { useStore, type Store } from '../store.js'
import type { HostSpaceState } from '../logic/host-mount.js'
import type { SpaceMode } from '../logic/space-capability.js'
import { openHubPanel } from '../logic/host-sidebar.js'
import { openNewTopic } from '../logic/topics.js'
import { sidebarSelectedThread } from '../logic/topic-draft.js'
import { watchHostNavigation } from '../logic/host-navigation.js'
import { TeamSidebarNav, type NewSessionInput } from './team-sidebar-nav.js'
import type { ArchiveCheckInfo } from './bot-archive-dialog.js'
import { BlockBoundary } from './ErrorBoundary.js'

export function TeamSidebar(props: {
  hub: HubStore
  clientCtx: unknown
  /** 侧栏里出现队友导航后，页面内不再画第二份列表。 */
  placement: Store<boolean>
  mode: Store<SpaceMode>
  space: Store<HostSpaceState>
}): ReactNode {
  const state = useStore(props.hub)
  const mode = useStore(props.mode)
  const space = useStore(props.space)
  const [error, setError] = useState<string | null>(null)
  const mount = space.kind === 'slot' ? space.team : null
  // 原生功能导航的分组折叠仍由这个组件维护（与旧 HostBotList 同一职责）。
  useEffect(() => watchHostNavigation(document), [])
  // 队友模式且侧栏真的挂上了，才隐藏页面内列表；收起态与降级时保留页面列表。
  useEffect(() => {
    try { props.placement.set(mount !== null && mode === 'team') }
    catch (error) { console.error('[agent-hub] 更新页面内列表可见性失败:', error) }
  }, [mount, mode, props.placement])
  if (!mount || !state.overview || mode !== 'team') return null

  /** 所有点击先确保中心面板被选中；失败时只在导航底部提示，不影响宿主。 */
  const navigate = (action: () => void): void => {
    try { setError(openHubPanel(props.clientCtx, action) ? null : '团队空间暂时打不开。点击上方「团队空间」重试；仍失败请检查 DSH 运行状态。') }
    catch { /* 不让点击回调影响宿主 */ }
  }

  /**
   * 新建会话（P63）：先确保中心面板被选中，再开主题并进去。
   * 返回中文错误给内联表单显示，不把异常抛给侧栏。
   */
  const createSession = async (input: NewSessionInput): Promise<string | null> => {
    const selected = openHubPanel(props.clientCtx, () => undefined)
    if (!selected) return '团队空间暂时打不开。点击上方「团队空间」重试；仍失败请检查 DSH 运行状态。'
    return openNewTopic(props.hub, input.projectId, input.text)
  }

  /** P48：归档前置校验；命令失败转成中文错误字符串，左栏据此弹拦截框。 */
  const checkArchive = async (botId: string): Promise<ArchiveCheckInfo | string> => {
    try {
      const result = await props.hub.command('archiveBotCheck', { botId })
      if (!result.ok) return result.error
      return result.data as ArchiveCheckInfo
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  /** 归档 / 恢复 / 删除共用：成功后刷新总览、项目与办公室；失败把中文错误交回弹窗。 */
  const runBotArchiveCommand = async (name: string, botId: string): Promise<string | null> => {
    try {
      const result = await props.hub.command(name, { botId })
      if (!result.ok) return result.error
      await Promise.all([props.hub.refreshOverview(), props.hub.refreshProject(), props.hub.refreshOffice()])
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  return createPortal(
    <BlockBoundary label="一级侧栏团队导航">
      <TeamSidebarNav
        overview={state.overview}
        project={state.project}
        view={state.view}
        // P60：草稿主题摆在中栏时左栏哪一行都不亮，免得像是在上一位队友那里说话。
        selectedThread={sidebarSelectedThread(state)}
        activeProjectId={state.view === 'project' ? state.activeProjectId : null}
        compact={space.kind === 'slot' ? space.compact : false}
        notice={error}
        onOpenOffice={() => navigate(() => { props.hub.setView('office'); void props.hub.refreshOffice() })}
        onSelectBot={id => navigate(() => props.hub.selectThread(id))}
        onOpenInbox={() => navigate(() => { props.hub.setView('inbox'); void props.hub.refreshInbox() })}
        onOpenSettings={() => navigate(() => { props.hub.setView('settings'); void props.hub.refreshSettings() })}
        onNewBot={() => navigate(() => props.hub.requestNewBot())}
        onNewProject={() => navigate(() => {
          // 工作区加号与项目页「＋ 新项目」同一个表单：先切到项目页，再发一次打开请求。
          props.hub.setView('project')
          void props.hub.refreshProject()
          props.hub.requestNewProject()
        })}
        onOpenProject={projectId => navigate(() => {
          // P1：带上被点的项目 id，项目页据此滚到对应卡片并高亮，不再落到默认项目。
          props.hub.requestProject(projectId)
          void props.hub.refreshProject()
        })}
        onOpenTopic={topicId => navigate(() => props.hub.selectThread(topicId))}
        onCreateSession={createSession}
        // P60：项目行加号先确保中心面板被选中，再进这个项目的草稿主题（空聊天，不发命令）。
        onOpenTopicDraft={projectId => navigate(() => props.hub.openTopicDraft(projectId))}
        onCheckArchive={checkArchive}
        onArchiveBot={botId => runBotArchiveCommand('archiveBot', botId)}
        onRestoreArchivedBot={botId => runBotArchiveCommand('restoreArchivedBot', botId)}
        onDeleteArchivedBot={botId => runBotArchiveCommand('deleteArchivedBot', botId)}
      />
    </BlockBoundary>,
    mount,
  )
}
