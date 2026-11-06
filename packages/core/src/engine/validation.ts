/** 内部可调用入口统一翻译 zod 错误，保留字段路径，避免用户只看到英文容器报错。 */
import type { z } from 'zod';
import englishLocale from 'zod/v4/locales/en.js';
// 只用于辨认默认英文模板，不改变宿主或其他模块的全局语言配置。
const defaultEnglishMessage = englishLocale().localeError;
/** 保留 schema 主动提供的中文说明，其余错误按代码翻译，不透传英文默认消息。 */
export function validationMessage(issue: z.core.$ZodIssue): string {
  // 默认模板也可能包含中文键名、枚举值或正则；先比较模板，不能仅凭汉字判断为定制文案。
  if (/[\u3400-\u9fff]/.test(issue.message) && issue.message !== defaultEnglishMessage({ ...issue, input: undefined })) return issue.message;
  switch (issue.code) {
    case 'invalid_type': return '类型不正确';
    case 'invalid_value': return '不是允许的值';
    case 'invalid_union': return '不是允许的取值或类型';
    case 'unrecognized_keys': return `不支持字段 ${issue.keys.join('、')}`;
    case 'too_small': return `${issue.inclusive ? '至少为' : '必须大于'} ${String(issue.minimum)}`;
    case 'too_big': return `不能${issue.inclusive ? '超过' : '大于或等于'} ${String(issue.maximum)}`;
    case 'invalid_format': return '格式不正确';
    case 'not_multiple_of': return `必须是 ${String(issue.divisor)} 的整数倍`;
    case 'invalid_key': return '字段名称或键不符合要求';
    case 'invalid_element': return '集合中的内容不符合要求';
    default: return '内容不符合要求';
  }
}
/** 统一校验入口并翻译字段错误，避免把底层英文异常直接交给主人。 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(`${label}无效：${result.error.issues.map(issue => {
    const field = issue.path.join('.') || label;
    const message = validationMessage(issue);
    return `${field}：${message}`;
  }).join('；')}`);
}
