/**
 * 空间模式与中栏表面（P41 建文件，P43 补「上次表面」）。
 *
 * 为什么单独成文件：模式既被宿主顶部切换器读，也被降级页面里的切换条读，
 * 还要在刷新后恢复；中栏上次停在哪个页面、哪个队友线程同样要跨刷新记住。
 * 把「读写哪个键、切到某模式该选哪一页、表面怎么校验」收在一处，
 * 避免切换器与页面各记一份状态。
 *
 * 失败口径：隐私模式、配额不足、存储被禁用或旧值损坏时一律退回默认
 * （对话模式、主视图、团队线程），只影响下次打开时的记忆，不影响本次切换。
 */
import type { PageView } from '../hub-state.js'
import type { SpaceMode } from './space-capability.js'

/** 独立存储键：不与看板折叠、激活页等键混用，升级时互不牵连。 */
export const spaceModeStorageKey = 'dsh-buddy:space-mode:v1'
/** 中栏表面单独一个键：模式和表面互不影响，坏掉一个不拖累另一个。 */
export const spaceSurfaceStorageKey = 'dsh-buddy:surface:v1'

type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>
export type StorageAccess = () => LocalStorage | null

/** 只认本功能写入的 team；其余（空、旧值、损坏值）都按对话处理。 */
export function readSpaceMode(storage: StorageAccess): SpaceMode {
  try { return storage()?.getItem(spaceModeStorageKey) === 'team' ? 'team' : 'chat' }
  catch { return 'chat' }
}

/** 写入失败只影响下次打开，不阻止本次切换。 */
export function saveSpaceMode(storage: StorageAccess, mode: SpaceMode): void {
  try { storage()?.setItem(spaceModeStorageKey, mode) }
  catch { /* 隐私模式或配额不足时继续使用内存状态 */ }
}

/**
 * 切到该模式时中栏应该选中哪一页：
 * - 队友：中心页（main 插槽的 agent-hub）；
 * - 对话：null 表示回到会话界面（手册 8.7），且不换当前会话。
 */
export function targetPanel(mode: SpaceMode): 'agent-hub' | null {
  return mode === 'team' ? 'agent-hub' : null
}

/** 中栏的「表面」：哪个视图、选中了哪个线程；只存恢复页面所需的最小信息。 */
export interface SpaceSurface {
  view: PageView
  threadId: string
}

/** 视图白名单：存储里的值必须完全命中，避免旧版本或手改数据把页面弄成空白。 */
const PAGE_VIEWS: readonly PageView[] = ['main', 'office', 'resource', 'project', 'inbox', 'activity', 'settings']

/** 读取上次表面；格式不对、视图不认识或线程为空都返回 null（按默认表面处理）。 */
export function readSurface(storage: StorageAccess): SpaceSurface | null {
  try {
    const raw = storage()?.getItem(spaceSurfaceStorageKey)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { view, threadId } = parsed as { view?: unknown; threadId?: unknown }
    if (typeof view !== 'string' || !PAGE_VIEWS.includes(view as PageView)) return null
    if (typeof threadId !== 'string' || threadId.trim() === '') return null
    return { view: view as PageView, threadId }
  } catch {
    return null
  }
}

/** 写入上次表面；失败只影响下次打开的落点。 */
export function saveSurface(storage: StorageAccess, surface: SpaceSurface): void {
  try { storage()?.setItem(spaceSurfaceStorageKey, JSON.stringify(surface)) }
  catch { /* 隐私模式或配额不足时继续使用内存状态 */ }
}
