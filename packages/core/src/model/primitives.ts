/** 通用字段约束：中文错误保留字段路径，领域记录不接触当前时钟或宿主环境。 */
import { z } from 'zod';

// 通用文字字段，允许空串的业务场景在此共享基础类型。
export const text = z.string({ error: '必须是文字' });
// 必须有正文的文字字段，避免缺少名称或理由仍被保存。
export const nonempty = text.min(1, '不能为空');
// 有限数字基础约束，拒绝 NaN 和无穷值。
export const finite = z.number({ error: '必须是有限数字' });
// 所有持久化时间统一使用整数 Unix 毫秒。
export const timestamp = finite.int('时间必须是整数毫秒');
// 不能为负的计量值，避免预算和数量出现反向含义。
export const nonnegative = finite.min(0, '不能小于 0');
// 非负整数计数，用于次数、步数和 token 数。
export const count = nonnegative.int('必须是非负整数');
// 严格大于零的时长或限额，避免无效轮询和资源限制。
export const positive = finite.positive('必须大于 0');
// 0–1 的分数或比例，保证规则计算使用相同尺度。
export const ratio = finite.min(0, '不能小于 0').max(1, '不能大于 1');
// 明确的布尔开关，不接受文字或数字代替权限状态。
export const bool = z.boolean({ error: '必须是布尔值' });
// 本地 HH:mm 时刻，用于免打扰、日报和每日期望。
export const clockTime = text.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '必须是有效的 HH:mm 时刻');
// YYYY-MM-DD 日期键，用于每日计数归属。
export const dateKey = text.regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD 日期');

// 记录 id 统一验证前缀与十位小写 base36，外部宿主的会话 id 保持原样。
export function recordId(prefix: string) {
  return text.regex(new RegExp(`^${prefix}_[a-z0-9]{10}$`), `必须是 ${prefix}_ 加 10 位小写字母或数字`);
}

// 字节上限按 UTF-8 而非字符数计算，避免中文正文占用超过存储和唤醒包预算。
export function byteText(maxBytes: number) {
  return text.refine(value => Buffer.byteLength(value, 'utf8') <= maxBytes, `UTF-8 内容不能超过 ${maxBytes} 字节`);
}

/** 校验显式模型选择；空值保留跟随宿主默认模型的语义。 */
export const ModelChoiceSchema = z.strictObject({
  provider: nonempty, // 宿主模型提供方标识
  model: nonempty, // 模型选择；空值表示跟随宿主默认模型
}).nullable();
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
