/**
 * 跳转面板（WCAG 2.4.5 多种查找方式）。
 *
 * 为什么是命令面板而不是第二排导航：顶栏下面再铺一整行链接会和顶栏重复，视觉更吵，
 * 也没有真正解决「从任意页面快速到达另一个页面」。面板只在需要时出现，关闭后不渲染
 * 任何节点、不占任何布局；一个「跳转」按钮或 ⌘K / Ctrl+K 就能打开。
 *
 * 键盘契约：打开即聚焦搜索框；↑↓ 移动高亮；Enter 执行；Esc 关闭。
 * 鼠标与键盘共用同一份过滤结果与高亮下标，不会出现「看得见却点不到」。
 *
 * 模态语义（U01 第 42 轮）：面板与另外五个弹窗走同一套 useDialogFocus——Tab 困在
 * 面板内不外逃（旧实现 Tab 走过最后一条会落到宿主侧栏），背景打 inert 与 aria-modal
 * 名副其实，焦点逃出后 Esc 仍能关闭，关闭后焦点还给触发钮。HubPage 只在打开时挂载
 * 本组件，hook 在渲染期抓到的「上一个焦点主人」才是打开面板的那个按钮。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { PageView } from '../hub-state.js'
import {
  commandItemDomId, filterCommands, stepActiveIndex,
  type CommandActionId, type CommandItem,
} from '../logic/command-palette.js'
import { useDialogFocus } from './use-dialog-focus.js'

export function CommandPalette(props: {
  open: boolean
  onClose: () => void
  onNavigate: (view: PageView) => void
  onAction: (action: CommandActionId) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 与五个弹窗同一套：Tab 困守、Esc 关闭、背景 inert、关闭后焦点归还触发钮。
  const dialogRef = useDialogFocus(props.onClose, false)
  const items = useMemo(() => filterCommands(query), [query])

  // 每次打开都回到干净状态并把焦点交给搜索框；关闭后不保留任何可见节点。
  useEffect(() => {
    if (!props.open) return
    setQuery('')
    setActive(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [props.open])

  // 过滤结果变短时，把高亮收回有效范围，避免 Enter 落到不存在的条目。
  useEffect(() => {
    setActive(current => (current >= items.length ? Math.max(0, items.length - 1) : current))
  }, [items.length])

  if (!props.open) return null

  const run = (item: CommandItem | undefined): void => {
    if (!item) return
    props.onClose()
    if (item.kind === 'view') props.onNavigate(item.id)
    else props.onAction(item.id)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => stepActiveIndex(current, items.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => stepActiveIndex(current, items.length, -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(items[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose()
    }
  }

  const renderItem = (item: CommandItem): ReactNode => {
    const index = items.indexOf(item)
    const selected = index === active
    return (
      <button
        key={commandItemDomId(item)}
        id={commandItemDomId(item)}
        type="button"
        role="option"
        aria-selected={selected}
        className={`ah-cmdk-item${selected ? ' is-active' : ''}`}
        onMouseEnter={() => setActive(index)}
        onClick={() => run(item)}
      >
        <span className="ah-cmdk-item-label">{item.label}</span>
        <span className="ah-cmdk-item-kind">{item.kind === 'view' ? '页面' : '动作'}</span>
      </button>
    )
  }

  const viewItems = items.filter((item): item is CommandItem & { kind: 'view' } => item.kind === 'view')
  const actionItems = items.filter((item): item is CommandItem & { kind: 'action' } => item.kind === 'action')
  const activeItem = items[active]

  return (
    <div className="ah-cmdk-mask" onClick={event => {
      // 只有点在遮罩本身才关闭；点面板内部不关闭。
      // 用 click（指针抬起）而不是 pointerdown：按下后滑出遮罩再松手可取消关闭，
      // 与右栏抽屉遮罩口径一致（WCAG 2.5.2 指针取消）。
      if (event.target === event.currentTarget) props.onClose()
    }}>
      <div ref={dialogRef} className="ah-cmdk" role="dialog" aria-modal="true" aria-label="跳转">
        <input
          ref={inputRef}
          className="ah-cmdk-input"
          type="text"
          role="combobox"
          aria-label="搜索页面与动作"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="ah-cmdk-list"
          aria-activedescendant={activeItem ? commandItemDomId(activeItem) : undefined}
          placeholder="搜索页面或动作，回车跳转"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div id="ah-cmdk-list" role="listbox" aria-label="跳转结果" className="ah-cmdk-list">
          {viewItems.length > 0 ? (
            <div className="ah-cmdk-group" role="group" aria-label="页面">
              <p className="ah-cmdk-group-title">页面</p>
              {viewItems.map(renderItem)}
            </div>
          ) : null}
          {actionItems.length > 0 ? (
            <div className="ah-cmdk-group" role="group" aria-label="动作">
              <p className="ah-cmdk-group-title">动作</p>
              {actionItems.map(renderItem)}
            </div>
          ) : null}
          {items.length === 0 ? <p className="ah-cmdk-empty" role="status">暂无匹配页面或动作。请更换关键词。</p> : null}
        </div>
        <p className="ah-cmdk-hint">↑↓ 选择 · Enter 跳转 · Esc 关闭</p>
      </div>
    </div>
  )
}
