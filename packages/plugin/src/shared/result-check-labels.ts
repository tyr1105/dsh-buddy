/**
 * F06 客户端结果词表：浏览器只带标签，不导入 core 的 Node 运行时。
 * 单测与 core 词表逐项核对，避免“没做”和“做错”在两侧被解释成不同结论。
 */
export const ARTIFACT_CHECK_LABELS = {
  present: '文件存在且非空', missing: '文件不存在', empty: '文件为空',
  invalid: '不是普通文件', unchecked: '未能实查',
} as const
export const RESULT_VERDICT_LABELS = {
  passed: '验收通过', not_done: '没做', incorrect: '做错', mismatch: '不符预期',
  rejected: '未通过', expired: '未答复，按未通过处理',
} as const
