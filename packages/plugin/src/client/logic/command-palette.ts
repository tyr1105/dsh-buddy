/**
 * 跳转面板的数据与检索逻辑（WCAG 2.4.5 多种查找方式）。
 *
 * 为什么单独放逻辑文件：面板要回答两个问题——「有哪些目的地」与「输入几个字后还剩哪些」。
 * 这两件事都是纯计算，不需要 React；拆出来后可以用普通单元测试锁住七个视图一个不少、
 * 搜索按中文与别名都能命中，组件只负责画和键盘事件。
 *
 * 与顶栏的关系：视图条目顺序与文案跟顶栏导航逐字一致（3.2.4 一致标识），
 * 但面板不是常驻导航——关闭后不渲染任何节点，不占布局。
 */
import type { PageView } from '../hub-state.js'

/** 面板里的视图条目：七个一级视图全部可达。 */
export interface CommandViewItem {
  kind: 'view'
  id: PageView
  label: string
  /** 搜索别名：主人可能用的旧名或口语（收件箱、看板、偏好等），不显示在按钮上。 */
  keywords: string[]
}

/** 面板里的动作条目：不切视图、直接做一件事。 */
export type CommandActionId = 'new-bot' | 'refresh'

export interface CommandActionItem {
  kind: 'action'
  id: CommandActionId
  label: string
  keywords: string[]
}

export type CommandItem = CommandViewItem | CommandActionItem

/**
 * 七个一级视图。顶栏的页面切换已删除（P61），动态页的常驻入口只剩这里。
 * 顺序和文案由静态契约测试固定，防止面板里出现和左栏不一样的叫法。
 */
export const COMMAND_VIEWS: ReadonlyArray<CommandViewItem> = [
  { kind: 'view', id: 'main', label: '队友', keywords: ['首页', '线程', '私聊'] },
  { kind: 'view', id: 'office', label: '办公室', keywords: ['像素', '工位', '轨迹'] },
  { kind: 'view', id: 'inbox', label: '待你处理', keywords: ['待办', '待处理', '收件箱', '审批'] },
  { kind: 'view', id: 'activity', label: '动态', keywords: ['活动', '活动流'] },
  { kind: 'view', id: 'resource', label: '资料', keywords: ['资源', '知识', '授权'] },
  { kind: 'view', id: 'project', label: '项目', keywords: ['看板', '任务'] },
  { kind: 'view', id: 'settings', label: '设置', keywords: ['偏好', '配置', '模型'] },
]

/** 常用动作：不换页也能做的事，保持短小，避免面板变成第二个设置页。 */
export const COMMAND_ACTIONS: ReadonlyArray<CommandActionItem> = [
  { kind: 'action', id: 'new-bot', label: '新建队友', keywords: ['新队友', '建队友', '创建'] },
  { kind: 'action', id: 'refresh', label: '刷新数据', keywords: ['刷新', '重载', '同步'] },
]

/** 面板完整清单：视图在前、动作在后，键盘上下移动按这个顺序走。 */
export const COMMAND_ITEMS: ReadonlyArray<CommandItem> = [...COMMAND_VIEWS, ...COMMAND_ACTIONS]

/** 搜索用的归一化：去首尾空白、转小写；中文不受影响。 */
function normalize(text: string): string {
  return text.trim().toLowerCase()
}

/**
 * 按查询词过滤。
 * - 空查询返回全部（打开面板先看到所有目的地）；
 * - 空格分隔多个词时要求每个词都命中（标签、别名或 id），避免输入越多结果越乱；
 * - 纯函数，不依赖 DOM，便于测试。
 */
export function filterCommands(query: string): CommandItem[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...COMMAND_ITEMS]
  return COMMAND_ITEMS.filter(item => {
    const haystack = [item.label, item.id, ...item.keywords].join(' ').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/**
 * 上下移动时的新下标：到顶回到底、到底回到顶；没有结果时返回 -1。
 * 键盘操作与鼠标悬停共用这一个函数，保证两条路径的高亮位置一致。
 */
export function stepActiveIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}

/** 给每一条结果一个稳定的 DOM id，供 aria-activedescendant 指向。 */
export function commandItemDomId(item: CommandItem): string {
  return `ah-cmdk-item-${item.kind}-${item.id}`
}
