/**
 * dsh-buddy 界面半边入口：注册中栏工作区、左栏入口、应用内提示与宿主空间挂载。
 *
 * P41 起，左栏不再只是「队友」功能行：
 * - 宿主侧栏结构可用时，在侧栏最顶部挂「对话 / 队友」双 Tab，队友模式整根侧栏换成
 *   队友导航（host-mount 统一负责 DOM），原生会话与工作区列表完全隐藏；
 * - 结构不可用时（P42），保留一行「团队空间」入口，进入后由页面内切换条切换。
 * 入口行在两种情况下都保留在 DOM 里当锚点，有双 Tab 时只做隐藏。
 *
 * 模式只有一份：mode 仓库；持久化与中栏页面选择都在 switchSpace 里完成。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import css from './styles.css'
import workspaceCss from './workspace.css'
import settingsCss from './settings.css'
import { createHubStore, connectEvents, type HubStore } from './hub-state.js'
import { createStore, useStore, type Store } from './store.js'
import { HubPage } from './pages/HubPage.js'
import { TeamSpacePage } from './pages/TeamSpacePage.js'
import { HostModeSwitch } from './components/mode-switch.js'
import { TeamSidebar } from './components/team-sidebar.js'
import { HubToastOverlay } from './components/HubToastOverlay.js'
import { applySpaceMode, fallbackSpace, watchHostSpace, type HostSpaceState } from './logic/host-mount.js'
import { readSpaceMode, readSurface, saveSpaceMode, saveSurface, targetPanel, type StorageAccess } from './logic/mode-nav.js'
import { focusAfterSwitch } from './logic/space-focus.js'
import type { SpaceMode } from './logic/space-capability.js'
import type { SpaceSwitchSource } from './components/space-switch.js'

export const inject = ['slots', 'locale']

/**
 * 中栏内容：有空间位时就是现有三栏工作区；没有空间位时包一层团队空间页面，
 * 页面内提供切换条，队友侧仍复用同一份工作区，不复制原生列表。
 */
function HubSurface(props: {
  hub: HubStore
  clientCtx: unknown
  placement: Store<boolean>
  mode: Store<SpaceMode>
  space: Store<HostSpaceState>
  /** 从提示点进来的收件箱目标；HubPage 消费后清空（P43）。 */
  inboxFocus: Store<string | null>
  onModeChange: (mode: SpaceMode, source: SpaceSwitchSource) => void
  onBackToChat: () => void
}): ReactNode {
  const sidebarInHost = useStore(props.placement)
  const mode = useStore(props.mode)
  const space = useStore(props.space)
  const page = <HubPage hub={props.hub} clientCtx={props.clientCtx} sidebarInHost={sidebarInHost} inboxFocus={props.inboxFocus} />
  if (space.kind === 'slot') return page
  return (
    <TeamSpacePage mode={mode} onModeChange={props.onModeChange} onBackToChat={props.onBackToChat}>
      {page}
    </TeamSpacePage>
  )
}

/** 入口图标：两三个人头的剪影（内联 SVG，currentColor 跟随主题）。 */
export function HubEntryIcon(props: { size?: number; active?: boolean }): ReactNode {
  const size = props.size ?? 16
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className="ah-entry-icon">
      <circle cx="5.5" cy="5" r="2.2" fill="currentColor" />
      <circle cx="10.8" cy="6.2" r="1.7" fill="currentColor" opacity="0.85" />
      <path d="M1.8 13.2c0-2.1 1.7-3.6 3.7-3.6s3.7 1.5 3.7 3.6z" fill="currentColor" />
      <path d="M9.9 13.2c0.2-1.7 1.2-2.9 2.7-2.9 1.2 0 2.2 0.8 2.5 2z" fill="currentColor" opacity="0.85" />
    </svg>
  )
}

/**
 * 入口行（P42）：宿主没有一级空间位时，点开这一行就是进入团队空间。
 *
 * 只认 active 从假变真的那一下：降级形态且当前还在对话侧时切到队友，
 * 让主人看到的是团队空间而不是「对话界面保持原生」的空态；
 * 有顶部双 Tab 时不碰模式，避免和顶部切换器抢同一个状态。
 * 从假变真而不是每次 active 变化都判断，是为了避开「点对话回原生」的瞬间。
 */
function HubEntryRow(props: {
  size?: number
  active?: boolean
  space: Store<HostSpaceState>
  mode: Store<SpaceMode>
  onEnterTeam: () => void
}): ReactNode {
  const wasActive = useRef(false)
  const active = props.active === true
  useEffect(() => {
    const justActivated = active && !wasActive.current
    wasActive.current = active
    if (!justActivated) return
    try {
      if (props.space.getSnapshot().kind === 'fallback' && props.mode.getSnapshot() === 'chat') props.onEnterTeam()
    } catch (error) {
      console.error('[agent-hub] 进入团队空间失败:', error)
    }
  }, [active])
  return HubEntryIcon({ size: props.size, active })
}

export function apply(ctx: any): void {
  // 1) 唯一的数据仓库 + 空间模式 + 挂载状态 + 提示要定位的收件箱项。
  const hub = createHubStore()
  const placement = createStore(false)
  const storage: StorageAccess = () => {
    try { return typeof localStorage === 'undefined' ? null : localStorage }
    catch { return null }
  }
  const mode = createStore<SpaceMode>(readSpaceMode(storage))
  const space = createStore<HostSpaceState>(fallbackSpace('no-anchor'))
  const inboxFocus = createStore<string | null>(null)
  // 刷新恢复上次表面（P43）：只回填内存状态，不发已读命令、不主动拉线程；
  // 线程数据仍由页面自己的刷新计划拉取。
  try {
    const saved = readSurface(storage)
    if (saved) hub.update(prev => ({ ...prev, view: saved.view, selectedThread: saved.threadId }))
  } catch (error) {
    console.error('[agent-hub] 恢复上次表面失败:', error)
  }

  /**
   * 键盘切换后的焦点归位（P43）：具体规则与重试放在 logic/space-focus，
   * 生产入口与隔离预览共用同一份实现；这里只负责在真实文档上调用并兜底。
   */
  const focusOnSwitch = (next: SpaceMode): void => {
    try {
      if (typeof document !== 'undefined') focusAfterSwitch(next, document)
    } catch (error) {
      console.error('[agent-hub] 焦点归位失败:', error)
    }
  }

  // 切换空间：写模式、持久化、切中栏页面、键盘来源再归位焦点。任何一步失败都不影响其余步骤。
  const switchSpace = (next: SpaceMode, source: SpaceSwitchSource): void => {
    try {
      if (mode.getSnapshot() !== next) {
        mode.set(next)
        saveSpaceMode(storage, next)
      }
      const layout = (ctx as { get?: (name: string) => { selectPanel?: (key: string | null) => void } } | null)?.get?.('layout')
      if (typeof layout?.selectPanel === 'function') layout.selectPanel(targetPanel(next))
    } catch (error) {
      console.error('[agent-hub] 切换空间失败:', error)
    }
    if (source === 'keyboard') focusOnSwitch(next)
  }
  const backToChat = (): void => switchSpace('chat', 'pointer')

  /** 提示点进来：先记下要聚焦的收件箱项，再切到队友侧并打开中心页（P43）。 */
  const openInboxFromToast = (inboxItemId: string): void => {
    try { inboxFocus.set(inboxItemId) } catch (error) { console.error('[agent-hub] 记录收件箱目标失败:', error) }
    switchSpace('team', 'pointer')
  }

  // 2) 样式：apply 里插入 <style data-plugin>，effect 返回移除函数。
  try {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-buddy'
      tag.textContent = `${css}\n${workspaceCss}\n${settingsCss}`
      document.head.appendChild(tag)
      return () => tag.remove()
    }, 'dsh-buddy: styles')
  } catch (error) {
    console.error('[agent-hub] 插入样式失败:', error)
  }

  // 3) 一条 SSE 连接：changed 事件驱动局部刷新；connection/reset 重拉全部。
  try {
    ctx.effect(() => {
      const close = connectEvents(hub)
      void hub.refreshAll()
      return close
    }, 'dsh-buddy: sse')
    ctx.on('connection/reset', () => { void hub.refreshAll() })
  } catch (error) {
    console.error('[agent-hub] 建立推送连接失败:', error)
  }

  // 4) 宿主空间挂载：侧栏顶部切换器与队友导航的 DOM 全部由 host-mount 维护。
  try {
    ctx.effect(() => {
      if (typeof document === 'undefined') return () => {}
      return watchHostSpace(document, {
        getMode: () => mode.getSnapshot(),
        onChange: state => space.set(state),
      })
    }, 'dsh-buddy: host-space')
  } catch (error) {
    console.error('[agent-hub] 启动一级空间挂载失败:', error)
  }

  // 5) 模式变化时把属性写到侧栏根；模式仓库的其它写入方（P43 恢复）也走这里。
  try {
    ctx.effect(() => mode.subscribe(() => {
      try { if (typeof document !== 'undefined') applySpaceMode(document, mode.getSnapshot()) }
      catch (error) { console.error('[agent-hub] 应用空间模式失败:', error) }
    }), 'dsh-buddy: space-mode')
  } catch (error) {
    console.error('[agent-hub] 监听空间模式失败:', error)
  }

  // 5b) 记住中栏表面（P43）：最近停在哪个视图、哪个线程，刷新后回到原处。
  // 只在值真的变化时写一次，避免每次推送都落盘；写入失败不影响本次使用。
  try {
    ctx.effect(() => {
      let last = ''
      const write = (): void => {
        try {
          const current = hub.getSnapshot()
          const key = `${current.view}\u0000${current.selectedThread}`
          if (key === last) return
          last = key
          saveSurface(storage, { view: current.view, threadId: current.selectedThread })
        } catch (error) {
          console.error('[agent-hub] 保存中栏表面失败:', error)
        }
      }
      write()
      return hub.subscribe(write)
    }, 'dsh-buddy: surface')
  } catch (error) {
    console.error('[agent-hub] 监听中栏表面失败:', error)
  }

  // 6) 中栏页面：有空间位直接渲染工作区，无空间位包一层团队空间页面。
  try {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'agent-hub' }, () => (
      <HubSurface
        hub={hub}
        clientCtx={ctx}
        placement={placement}
        mode={mode}
        space={space}
        inboxFocus={inboxFocus}
        onModeChange={switchSpace}
        onBackToChat={backToChat}
      />
    )))
  } catch (error) {
    console.error('[agent-hub] 注册 main 插槽失败:', error)
  }

  // 7) 左栏入口行：无空间位时是「团队空间」；有空间位时被隐藏但仍作为锚点保留。
  try {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: 'agent-hub', order: 15, label: '团队空间' },
      (props: { size?: number; active?: boolean }) => (
        <HubEntryRow
          {...(props ?? {})}
          space={space}
          mode={mode}
          onEnterTeam={() => switchSpace('team', 'pointer')}
        />
      ),
    ))
  } catch (error) {
    console.error('[agent-hub] 注册侧栏入口失败:', error)
  }

  // 8) 应用内提示（shell.overlay，list 插槽；照官方 toast 做法，verified-T5 Q4-2）。
  // 点击行为交给 openInboxFromToast：先记收件箱目标，再切队友侧打开中心页（P43）。
  try {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-buddy-toast', order: 100 },
      () => HubToastOverlay({ hub, onOpen: openInboxFromToast }),
    ))
  } catch (error) {
    console.error('[agent-hub] 注册应用内提示插槽失败:', error)
  }

  // 9) 宿主顶部双 Tab 与队友导航：只在有空间位时渲染，没有空间位时不出现。
  try {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-buddy-mode-switch', order: 88 },
      () => <HostModeSwitch hub={hub} mode={mode} space={space} onChange={switchSpace} />,
    ))
  } catch (error) {
    console.error('[agent-hub] 注册空间切换器失败:', error)
  }
  try {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-buddy-sidebar', order: 90 },
      () => <TeamSidebar hub={hub} clientCtx={ctx} placement={placement} mode={mode} space={space} />,
    ))
  } catch (error) {
    console.error('[agent-hub] 注册一级队友列表失败:', error)
  }
}
