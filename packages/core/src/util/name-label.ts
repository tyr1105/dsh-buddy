/**
 * 「名字（岗位）」的统一写法（P74r13 第 14 节）。
 *
 * 为什么需要：句子里常把员工的名字和岗位拼成「林舟（工程师）」。员工的名字与岗位名称相同时
 * （例如名字就叫「评审员」），原来会写成「评审员（评审员）」，读起来重复。所有拼这种写法的地方都经过这一个函数：
 * 没有岗位、或岗位与名字相同（去掉首尾空白后相等）时只写名字，不写括号。
 */

/** 岗位是不是和名字重复（去掉首尾空白后相等）。 */
export function sameAsName(name: string, label: string): boolean {
  return name.trim() === label.trim();
}

/** 「名字（岗位）」；没有岗位、或岗位与名字相同时只写名字。 */
export function withLabel(name: string, label: string | null | undefined): string {
  return label === null || label === undefined || label.trim() === '' || sameAsName(name, label) ? name : `${name}（${label}）`;
}
