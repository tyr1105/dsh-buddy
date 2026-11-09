/**
 * dsh-buddy 界面半边入口：注册左栏「队友」入口与中栏三栏页面，建立唯一的
 * 数据仓库与一条 SSE 连接。样式在 apply 的 ctx.effect 里插入并返回移除函数
 * （官方作者规范：factory 无副作用，verified-T5 Q1-4）。
 * D03 新增：shell.overlay 上的 4 秒应用内提示（新 P0/P1 收件箱项，照 verified-T5
 * Q4-2 的官方样式，只用主题变量，可点击跳回收件箱）；左栏入口 label 用 thunk，
 * 有待处理收件箱时显示「队友 · N」。
 */
import type { ReactNode } from 'react'
import css from './styles.css'
import { createHubStore, connectEvents, type HubStore } from './hub-state.js'
import { useStore } from './store.js'
import { HubPage } from './pages/HubPage.js'
import { entryLabel } from './logic/feeds.js'

export const inject = ['slots', 'locale']

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
 * 应用内提示条（官方 toast 样式，verified-T5 Q4-2）：位置、圆角、底色、阴影全部
 * 主题变量；整层点击穿透，提示自己加 pointer-events:auto 才能点击跳转。
 */
function HubToastOverlay(props: { hub: HubStore; clientCtx: unknown }): ReactNode {
  const state = useStore(props.hub)
  if (state.toasts.length === 0) return null
  return (
    <div className="ah-toast-layer" role="status">
      {state.toasts.map(toast => (
        <div key={toast.id} className="ah-toast">
          <button type="button" className="ah-toast-btn"
            onClick={() => {
              props.hub.dismissToast(toast.id)
              props.hub.setView('inbox')
              void props.hub.refreshInbox()
              // 主人可能停在别的中栏页：先切回「队友」面板再看得到收件箱。
              try {
                const layout = (props.clientCtx as { get?: (name: string) => any } | null)?.get?.('layout')
                layout?.selectPanel?.('agent-hub')
              } catch { /* 打不开面板就算了，提示本身也已消失 */ }
            }}>
            {toast.text}
          </button>
        </div>
      ))}
    </div>
  )
}

export function apply(ctx: any): void {
  // 1) 唯一的数据仓库：页面所有数据都从它拿。
  const hub = createHubStore()

  // 2) 样式：apply 里插入 <style data-plugin>，effect 返回移除函数。
  try {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-buddy'
      tag.textContent = css
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

  // 4) 插槽注册：中栏页面（main，key agent-hub）+ 左栏入口（sidebar.panellist，label thunk 带计数）。
  try {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'agent-hub' }, () => HubPage({ hub, clientCtx: ctx })))
  } catch (error) {
    console.error('[agent-hub] 注册 main 插槽失败:', error)
  }
  try {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      // label 是 thunk：每次取值时从仓库读待处理收件箱数（入口行由宿主渲染）。
      { name: 'sidebar.panellist', id: 'agent-hub', order: 15, label: () => entryLabel(hub.getSnapshot().overview?.inbox.total ?? 0) },
      (props: { size?: number; active?: boolean }) => HubEntryIcon(props ?? {}),
    ))
  } catch (error) {
    console.error('[agent-hub] 注册侧栏入口失败:', error)
  }

  // 5) 应用内提示（shell.overlay，list 插槽；照官方 toast 做法，verified-T5 Q4-2）。
  try {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-buddy-toast', order: 100 },
      () => HubToastOverlay({ hub, clientCtx: ctx }),
    ))
  } catch (error) {
    console.error('[agent-hub] 注册应用内提示插槽失败:', error)
  }
}
