/**
 * 空间能力探测（P32）：判断宿主有没有「侧栏顶部一级空间位」。
 *
 * 为什么单独成文件：P27 定稿后分成两条路——有空间位走 P41（顶部「对话 / 队友」
 * 双 Tab、整根侧栏换队友导航），没有或结构漂移走 P42（功能导航里一行「团队空间」
 * 入口 + 页面内切换条）。两条路必须先由同一份只读探测决定，不能在组件里各判一次，
 * 否则会出现半套界面：顶部有 Tab、原生列表却还在，或者入口重复两遍。
 *
 * 纪律：
 * - 探测只读：不写宿主 DOM、不碰私有字段；
 * - 探针出错按降级处理，绝不把异常抛给宿主；
 * - 结果只有 slot / fallback 两种，降级形态不能对外说成宿主一级 Tab。
 */

/** 两个一级空间。文案由主人 2026-11-08 定稿为「对话 / 队友」。 */
export type SpaceMode = 'chat' | 'team'

/** 切换器里的固定顺序：对话在前，队友在后。 */
export const SPACE_MODES: readonly SpaceMode[] = ['chat', 'team']

/** 唯一文案来源：顶栏切换器、降级页面切换条和读屏名称都从这里取。 */
export const SPACE_MODE_LABELS: Record<SpaceMode, string> = { chat: '对话', team: '队友' }

/** 取另一个模式；只有两个值，所以等价于切换。 */
export function otherSpaceMode(mode: SpaceMode): SpaceMode {
  return mode === 'chat' ? 'team' : 'chat'
}

/** 宿主不可用时的原因，只用于排查与进度记录，不直接展示给主人。 */
export type SpaceFallbackReason = 'no-anchor' | 'probe-error'

/**
 * 探针：由宿主挂载层实现，返回可以放切换器的容器。
 * 为什么用接口而不是直接传 document：探测逻辑要能在测试里用假对象跑，
 * 不需要 jsdom；挂载层负责真正的 DOM 查询与异常兜底。
 */
export interface SpaceMountProbe {
  /** 找到侧栏顶部的挂载容器；找不到返回 null。 */
  findMount(): HTMLElement | null
}

/** 探测结果：slot=可以挂宿主顶部空间位；fallback=只能走页面内降级。 */
export type SpaceCapability =
  | { kind: 'slot'; mount: HTMLElement }
  | { kind: 'fallback'; reason: SpaceFallbackReason }

/**
 * 只读探测。探针缺失、返回 null 或抛错都按 fallback 处理：
 * 对主人来说最差也只是多一行入口，比整块界面不出现好。
 */
export function detectSpaceCapability(probe: SpaceMountProbe | null | undefined): SpaceCapability {
  if (!probe) return { kind: 'fallback', reason: 'no-anchor' }
  try {
    const mount = probe.findMount()
    if (!mount) return { kind: 'fallback', reason: 'no-anchor' }
    return { kind: 'slot', mount }
  } catch (error) {
    // 结构漂移只记一次警告，不抛给宿主；降级入口会兜住可用性。
    console.warn('[agent-hub] 探测宿主空间位失败，按降级处理:', error)
    return { kind: 'fallback', reason: 'probe-error' }
  }
}
