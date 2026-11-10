/**
 * 新会话页的工作区下拉（P57 后半段）：队友模式下替换官方选择器，多一组「项目」。
 *
 * 为什么整个替换而不是往官方菜单里加一行：官方菜单没有开放添加条目的位置，
 * 宿主只允许替换整个选择器（conversation.hero.workspace 插槽）。
 * 替换后要把官方的能力都接回来：列出工作区、悬停看路径、同名区分、添加工作区。
 * 只在队友模式注册（见 new-session-bridge），对话模式仍是官方原样；
 * 本组件崩溃时宿主会自动让回官方选择器，不会让主人选不了工作区。
 *
 * 选项目不经过宿主：不登记工作区、不切会话，只把选中的项目记到接线层的仓库里，
 * 输入框的标签和回车行为由接线层跟着变。选普通工作区才交给宿主的 onPick。
 *
 * 唯一碰宿主 DOM 的地方是工作区按钮上的文字：宿主不知道选了项目，按钮会一直显示
 * 原来的工作区名，所以选中项目时把文字换成项目名，取消时换回去。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HubStore } from './hub-state.js'
import { useStore, type Store } from './store.js'
import {
  activeProjects,
  buildPickerEntries,
  type HostWorkspaceRow,
  type PickerEntry,
} from './logic/new-session-project.js'
import { FolderIcon } from './components/sidebar-nav-parts.js'

/** 宿主工作区列表的快照（只声明用得到的字段）。 */
interface WorkspaceListSnapshot {
  items: readonly HostWorkspaceRow[]
}

/** 插槽传进来的属性：前五项是宿主新会话页给的，useWorkspaces 是标准属性。 */
export interface NewSessionPickerProps {
  open: boolean
  anchorRef?: { current: HTMLElement | null }
  selectedId?: string
  onPick: (workspaceId: string) => void
  onClose: () => void
  useWorkspaces: <T>(select: (state: WorkspaceListSnapshot) => T) => T
}

/** 需要外面配合的动作，由接线层传入；测试可以换成假的。 */
export interface NewSessionPickerDeps {
  hub: HubStore
  /** 选中的项目 id；null 表示没选。 */
  selection: Store<string | null>
  /** 官方「添加工作区」的后半段：把选好的文件夹登记成工作区。 */
  createWorkspace: (path: string) => Promise<{ workspaceId: string; title: string }>
  /** 弹系统选目录框；主人取消时返回 null。 */
  pickDirectory: () => Promise<string | null>
  defaultWorkspaceName: () => string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 选完项目直接能打字。找不到输入框也不影响选择，所以失败不报错。 */
function focusComposer(): void {
  try { document.querySelector<HTMLElement>('[data-composer-input="true"]')?.focus() }
  catch (failure) { console.error('[agent-hub] 新会话输入框取焦点失败:', failure) }
}

function CheckMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" className="ah-np-check">
      <path d="M3 8.5l3.2 3.2L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 工厂函数：组件身份在模块级稳定（宿主要求），依赖从闭包拿。 */
export function makeNewSessionWorkspacePicker(deps: NewSessionPickerDeps) {
  return function NewSessionWorkspacePicker(props: NewSessionPickerProps): ReactNode {
    const hubState = useStore(deps.hub)
    const selectedProjectId = useStore(deps.selection)
    const workspaces = props.useWorkspaces(state => state.items)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const projects = activeProjects(hubState.project)
    const selectedName = projects.find(project => project.id === selectedProjectId)?.name ?? null

    // 工作区按钮的文字跟着选中的项目变；效果结束时换回去，换回时宿主的文字还在就不用动。
    useEffect(() => {
      if (selectedName === null) return undefined
      try {
        const label = props.anchorRef?.current?.querySelector('span') ?? null
        if (label === null) return undefined
        const original = label.textContent
        label.textContent = selectedName
        return () => { if (label.textContent === selectedName) label.textContent = original }
      } catch (failure) {
        console.error('[agent-hub] 更新工作区按钮文字失败:', failure)
        return undefined
      }
    }, [selectedName])

    // 打开时：清掉上次的错误、把项目刷新一遍、把焦点放进菜单（键盘用户直接上下选），
    // 并监听点外面关闭。锚点按钮自己会切换开关，所以点它时不算「点外面」。
    useEffect(() => {
      if (!props.open) return undefined
      setError(null)
      try { void deps.hub.refreshProject() } catch (failure) { console.error('[agent-hub] 刷新项目失败:', failure) }
      try {
        const menu = menuRef.current
        const first = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        first?.focus()
      } catch (failure) { console.error('[agent-hub] 工作区下拉取焦点失败:', failure) }
      const onPointerDown = (event: PointerEvent): void => {
        try {
          const target = event.target instanceof Node ? event.target : null
          if (target === null || menuRef.current?.contains(target) || props.anchorRef?.current?.contains(target)) return
          props.onClose()
        } catch (failure) { console.error('[agent-hub] 关闭工作区下拉失败:', failure) }
      }
      const onEscape = (event: globalThis.KeyboardEvent): void => {
        try {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          props.onClose()
          props.anchorRef?.current?.focus()
        } catch (failure) { console.error('[agent-hub] 关闭工作区下拉失败:', failure) }
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onEscape, true)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onEscape, true)
      }
    }, [props.open])

    if (!props.open) return null

    /** 添加工作区：官方选择器的同款流程，失败留在菜单里显示原因。 */
    const addWorkspace = (): void => {
      if (busy) return
      setBusy(true)
      setError(null)
      void (async () => {
        const path = await deps.pickDirectory()
        if (path === null) return
        const workspace = await deps.createWorkspace(path)
        deps.selection.set(null)
        props.onPick(workspace.workspaceId)
      })()
        .catch((failure: unknown) => setError(`添加工作区失败。${messageOf(failure)}`))
        .finally(() => setBusy(false))
    }

    /**
     * 选项目：只记下来，不告诉宿主。
     * 选工作区：先清掉项目，再交给宿主切换，草稿由宿主带过去（标签由接线层摘掉）。
     */
    const choose = (entry: PickerEntry): void => {
      if (busy) return
      if (entry.projectId !== null) {
        deps.selection.set(entry.projectId)
        props.onClose()
        focusComposer()
        return
      }
      if (entry.workspaceId !== null) {
        deps.selection.set(null)
        props.onPick(entry.workspaceId)
      }
    }

    /** 方向键在可点的行之间移动；到头循环，和官方菜单手感一致。 */
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      const rows = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      if (rows.length === 0) return
      const at = rows.indexOf(document.activeElement as HTMLButtonElement)
      const move = (index: number): void => { event.preventDefault(); event.stopPropagation(); rows[index]?.focus() }
      if (event.key === 'ArrowDown') move(at < 0 ? 0 : (at + 1) % rows.length)
      else if (event.key === 'ArrowUp') move(at <= 0 ? rows.length - 1 : at - 1)
      else if (event.key === 'Home') move(0)
      else if (event.key === 'End') move(rows.length - 1)
      else if (event.key === 'Tab') props.onClose()
    }

    const entries = buildPickerEntries({
      projects,
      workspaces,
      selectedWorkspaceId: props.selectedId,
      selectedProjectId,
      defaultWorkspaceName: deps.defaultWorkspaceName(),
    })
    const renderRow = (entry: PickerEntry): ReactNode => (
      <button
        key={entry.key}
        type="button"
        role="menuitemradio"
        aria-checked={entry.selected}
        className="ah-np-item"
        title={entry.title}
        disabled={busy}
        onClick={() => choose(entry)}
      >
        <FolderIcon />
        <span className="ah-np-name">{entry.label}</span>
        {entry.suffix !== null ? <span className="ah-np-suffix">{entry.suffix}</span> : null}
        {entry.selected ? <CheckMark /> : null}
      </button>
    )

    // 下拉贴在工作区按钮正下方；窗口矮时限高、内部滚动，窗口窄时左移，都不跑出屏幕。
    const rect = props.anchorRef?.current?.getBoundingClientRect() ?? null
    const top = rect === null ? 120 : rect.bottom + 6
    const left = Math.max(16, Math.min(rect?.left ?? 120, window.innerWidth - 276))
    const style = { left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(160, Math.min(440, window.innerHeight - top - 16))}px` }

    return createPortal(
      <div className="ah-np-menu" role="menu" aria-label="选择项目或工作区" ref={menuRef} style={style} onKeyDown={onKeyDown}>
        {/* 小标题给眼睛看，读屏靠分组名：菜单里只允许放菜单项和分组。没有进行中的项目时整组不出现。 */}
        {entries.projects.length > 0 ? (
          <>
            <p className="ah-np-section" aria-hidden="true">项目</p>
            <div className="ah-np-group" role="group" aria-label="项目">{entries.projects.map(renderRow)}</div>
          </>
        ) : null}
        <p className="ah-np-section" aria-hidden="true">工作区</p>
        <div className="ah-np-group" role="group" aria-label="工作区">{entries.workspaces.map(renderRow)}</div>
        <div className="ah-np-divider" role="separator" />
        <button type="button" role="menuitem" className="ah-np-item" disabled={busy} onClick={addWorkspace}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
          <span className="ah-np-name">添加工作区…</span>
        </button>
        {busy ? <p className="ah-np-status" role="status">正在打开…</p> : null}
        {error !== null ? <p className="ah-np-error" role="alert">{error}</p> : null}
      </div>,
      document.body,
    )
  }
}
