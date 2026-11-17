/**
 * 关掉「编辑员工」弹窗之后，把键盘焦点还到哪里（P74i-m4，第 5 节第 2 条，纯函数）。
 *
 * 背景：弹窗自己的焦点管理（use-dialog-focus.ts）在关闭时把焦点还给「打开弹窗之前的焦点主人」。
 * 但编辑员工的入口（右栏底部按钮、对话页「更多」菜单里的一项）在点下去之后都会从页面上消失——
 * 右栏随抽屉一起收起、菜单随之关闭——弹窗记下的那个节点已经不在页面上，焦点无处可还，落到页面最外层，
 * 键盘用户要从页面开头重新按 Tab。
 *
 * 规则：
 * 1. 打开弹窗的那个按钮还在页面上，焦点回到它；
 * 2. 不在了，回到左栏里这位员工的那一行（行上带 data-bot-row 标记）；
 * 3. 都找不到就什么都不做（交给浏览器默认，不强行抢焦点）。
 * 取元素的方式由调用方传入，便于不依赖真实页面测试。
 */

/** 一个可以聚焦、并能判断是否还在页面上的元素。 */
export interface FocusableLike {
  isConnected: boolean
  focus: () => void
}

/** 左栏里员工那一行的选择器（行上的属性由 sidebar-teammates-group.tsx 写入）。 */
export function botRowSelector(botId: string): string {
  // 员工编号只含字母数字下划线连字符，仍转义引号与反斜杠，保证选择器不会被编号破坏。
  return `[data-bot-row="${botId.replace(/["\\]/g, '\\$&')}"]`
}

/**
 * 还焦点。
 * @param opener 打开弹窗时记下的触发元素（可能为空、可能已不在页面上）
 * @param botId 被编辑的员工编号
 * @param query 按选择器取元素
 * @returns 焦点回到了哪里：opener 是原按钮，row 是员工那一行，none 是没有地方可还
 */
export function restoreEditFocus(
  opener: FocusableLike | null,
  botId: string,
  query: (selector: string) => FocusableLike | null,
): 'opener' | 'row' | 'none' {
  try {
    if (opener !== null && opener.isConnected) { opener.focus(); return 'opener' }
    const row = query(botRowSelector(botId))
    if (row !== null && row.isConnected) { row.focus(); return 'row' }
  } catch { /* 焦点还不回去只影响键盘体验，不影响页面 */ }
  return 'none'
}
