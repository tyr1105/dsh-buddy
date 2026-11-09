/**
 * 宿主侧栏顶部的「对话 / 队友」双 Tab（P41）。
 *
 * 只在探测到空间位时渲染；没有空间位时整块不出现，由 P42 的页面内切换条接管。
 * 模式状态放在外部仓库，本组件不存模式，只把共享切换控件 portal 到侧栏顶部容器。
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HubStore } from '../hub-state.js'
import { useStore, type Store } from '../store.js'
import type { HostSpaceState } from '../logic/host-mount.js'
import type { SpaceMode } from '../logic/space-capability.js'
import { SpaceSwitch, type SpaceSwitchSource } from './space-switch.js'

export function HostModeSwitch(props: {
  hub: HubStore
  mode: Store<SpaceMode>
  space: Store<HostSpaceState>
  /** 由 index 统一处理：写模式、持久化、切换中栏页面。 */
  onChange: (mode: SpaceMode, source: SpaceSwitchSource) => void
}): ReactNode {
  const mode = useStore(props.mode)
  const space = useStore(props.space)
  const state = useStore(props.hub)
  if (space.kind !== 'slot') return null
  return createPortal(
    <SpaceSwitch
      mode={mode}
      onChange={props.onChange}
      compact={space.compact}
      // 红点放在「队友」上：待处理永远属于队友空间；对话侧不打扰。
      badge={state.overview?.inbox.total}
    />,
    space.switcher,
  )
}
