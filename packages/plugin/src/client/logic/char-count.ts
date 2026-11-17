/**
 * 输入框的字数提示（P74i-m5，第 5 节，走查 N-6，纯函数）。
 *
 * 为什么需要：「待你处理」里的输入框限制了字数（提议的附言 200 字，「要修改」「有不符」「都不合适」500 字），
 * 超出的字由输入框直接截掉，主人不知道自己的话被截短了。
 * 做法：已输入的字数达到上限的九成时，在输入框下面写「{已输入}/{上限} 字」；达到上限时写「已到 {上限} 字的上限」；
 * 不到九成不显示任何东西，不打扰平时的输入。
 *
 * 字数按字符串长度（length）算，与输入框 maxLength 的算法一致，所以「到上限」和输入框停止接收的时刻是同一刻。
 */

/** 附言的字数上限：提议的附言与审批附言（普通审批、发布审批）共用（P74i-m6 起审批附言也限 200 字）。 */
export const NOTE_CHAR_LIMIT = 200

/** 「要修改」「有不符」「都不合适」输入框的字数上限。 */
export const OBJECTION_CHAR_LIMIT = 500

/**
 * 给出字数提示；不需要提示（还不到上限的九成）时返回 null。
 * @param count 已输入的字数
 * @param limit 字数上限
 */
export function charCountHint(count: number, limit: number): string | null {
  // 九成线向上取整：200 字的九成是 180，所以 179 字不提示、180 字开始提示。
  if (count < Math.ceil(limit * 0.9)) return null
  if (count >= limit) return `已到 ${limit} 字的上限`
  return `${count}/${limit} 字`
}
