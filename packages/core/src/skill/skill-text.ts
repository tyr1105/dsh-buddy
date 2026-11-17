/**
 * 新建技能的名称与「什么时候用」的检查（P75r6 第 2 节第 4、5 条，复验 N2、N9）。
 *
 * 为什么要严：名称、「什么时候用」是模型写的，通过核对之后原样写进员工家目录里的技能文件（SKILL.md 头部的 description），
 * DSH 又把这段描述放进这位员工以后每个会话的提示里；它也在技能库、活动流里给主人看。所以：
 * - 名称只允许中文、英文字母、数字、空格和「-」「·」「、」，其他字符（引号、冒号、方括号、换行、各种符号）一律拒绝；
 *   不能写成「sk 加数字」的样子（会与技能编号混淆）；长度上限不变（SKILL_DEFAULTS.TITLE_MAX_CHARS）；
 * - 「什么时候用」必须是单行、不含控制字符；长度上限不变（SKILL_DEFAULTS.WHEN_MAX_CHARS）；
 * - 名称、「什么时候用」和句子写进技能库之前都查内部名称（工具名、记录编号），查到就拒绝（文字沿用 SKILL_OWNER_VISIBLE_REFUSAL）。
 * 拒绝文字给模型看，写清是哪一项不对。纯函数，不读存储。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { SKILL_OWNER_VISIBLE_REFUSAL, internalNameIn } from '../job/owner-text.js';
import { SKILL_REF_PATTERN } from './skill-ref.js';

/** 名称允许的字符：汉字、英文字母、数字、空格、「-」「·」「、」。 */
const TITLE_CHARS = /^[㐀-䶿一-鿿A-Za-z0-9 ·、-]+$/;

/** 控制字符（含换行、制表符、行分隔符）。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/** 名称有问题时返回给模型看的话（带前缀 label，例如「第 1 项」），没有问题返回 null。长度只在这里再核一遍，上限不变。 */
export function skillTitleProblem(title: string, label: string): string | null {
  const text = title.trim();
  if (text === '') return `${label}：title 不能为空`;
  if ([...text].length > D.TITLE_MAX_CHARS) return `${label}：title 不能超过 ${D.TITLE_MAX_CHARS} 字`;
  if (!TITLE_CHARS.test(text)) return `${label}：title「${text}」里有不允许的字符：名称只能用中文、英文字母、数字、空格和「-」「·」「、」`;
  if (SKILL_REF_PATTERN.test(text)) return `${label}：title 不能写成「sk 加数字」的样子（那是技能编号），请换一个名称`;
  return null;
}

/** 「什么时候用」有问题时返回给模型看的话，没有问题返回 null。 */
export function whenToUseProblem(text: string, label: string): string | null {
  const value = text.trim();
  if (value === '') return `${label}：whenToUse 不能为空`;
  if ([...value].length > D.WHEN_MAX_CHARS) return `${label}：whenToUse 不能超过 ${D.WHEN_MAX_CHARS} 字`;
  if (CONTROL_CHARS.test(value)) return `${label}：whenToUse 必须是单行文字，不能含换行、制表符等控制字符`;
  return null;
}

/** 这些文字里有内部名称吗：有就返回逐字固定的拒绝文字（给模型看），没有返回 null。 */
export function internalNameRefusal(texts: string[]): string | null {
  return texts.some(text => internalNameIn(text) !== null) ? SKILL_OWNER_VISIBLE_REFUSAL : null;
}
