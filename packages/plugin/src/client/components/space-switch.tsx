/**
 * 对话 / 队友共享切换控件（P32）。
 *
 * 为什么是受控组件：宿主顶部切换器和无空间位时页面内的切换条必须长同一副样子、
 * 用同一份文案与键盘行为。模式状态由调用方（index 的 mode 仓库 / 页面）持有，
 * 组件自己不存状态，避免两处各记一份导致切完又弹回。
 *
 * 键盘：两个原生 button，Tab 可达、Enter/Space 可切换；箭头键不做自定义，
 * 免得和宿主全局快捷键打架。收起态只显示图标，文字仍作为无障碍名称。
 */
import type { ReactNode } from 'react'
import { SPACE_MODES, SPACE_MODE_LABELS, type SpaceMode } from '../logic/space-capability.js'

/** 切换来源：鼠标点击与键盘激活的后续焦点处理不同（P43）。 */
export type SpaceSwitchSource = 'pointer' | 'keyboard'

function SpaceModeIcon(props: { mode: SpaceMode }): ReactNode {
  if (props.mode === 'chat') {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v5A1.5 1.5 0 0 1 12.5 11H7l-3.5 2.5v-2.5H3.5A1.5 1.5 0 0 1 2 9.5z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="5.5" cy="5" r="2" />
      <path d="M2 12.2c0-2 1.6-3.2 3.5-3.2s3.5 1.2 3.5 3.2" />
      <circle cx="11" cy="6" r="1.6" />
      <path d="M10.6 9.2c1.8.1 3.4 1.2 3.4 3" />
    </svg>
  )
}

export function SpaceSwitch(props: {
  /** 当前空间，由调用方持有。 */
  mode: SpaceMode
  /** 请求切换；点击当前模式不回调，避免无意义的面板跳转。 */
  onChange: (mode: SpaceMode, source: SpaceSwitchSource) => void
  /** 宿主侧栏收起时的图标态：隐藏可见文字，保留下方 aria-label。 */
  compact?: boolean
  /** 待处理红点：收起态也不丢（P43）。0 或省略不渲染。 */
  badge?: number
  className?: string
}): ReactNode {
  return (
    <div
      className={`ah-space-switch${props.compact ? ' ah-space-switch-compact' : ''}${props.className ? ` ${props.className}` : ''}`}
      role="group"
      aria-label="切换对话或队友"
    >
      {SPACE_MODES.map(mode => {
        const active = props.mode === mode
        // WCAG 2.5.3：按钮名称必须包含可见文字。队友侧可见「队友 + 计数」，
        // 因此计数要进名称（语音用户念「队友」可命中，读屏也能听到待处理量）；
        // 徽章本身改作装饰，避免名称与可见文字不一致、也避免计数被读两遍。
        // 先把可选 badge 归一成数值常量，下游就不必再处理 undefined 收窄。
        const badgeCount = props.badge ?? 0
        const showBadge = mode === 'team' && badgeCount > 0
        const accessibleName = showBadge
          ? `${SPACE_MODE_LABELS[mode]}（${badgeCount} 件待处理）`
          : SPACE_MODE_LABELS[mode]
        return (
          <button
            key={mode}
            type="button"
            data-space-mode={mode}
            aria-pressed={active}
            aria-label={accessibleName}
            title={SPACE_MODE_LABELS[mode]}
            className="ah-space-switch-btn"
            onClick={event => {
              if (active) return
              // 键盘激活的 click.detail 为 0；据此决定切换后是否把焦点交给内容区。
              props.onChange(mode, event.detail === 0 ? 'keyboard' : 'pointer')
            }}
          >
            <SpaceModeIcon mode={mode} />
            <span className="ah-space-switch-label">{SPACE_MODE_LABELS[mode]}</span>
            {showBadge ? (
              <span className="ah-space-switch-badge" aria-hidden="true">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
