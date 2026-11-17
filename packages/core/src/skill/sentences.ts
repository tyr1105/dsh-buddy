/**
 * 技能更新里「句子」的共同校验（P75h 从 propose.ts 抽出）：提交（propose）与改写（revise）的句子规则完全相同，
 * 各写一份迟早改漏一份，所以收在这里，两处都调用同一个函数。
 *
 * 规则（与 P75g 的 propose 逐字一致，错误文字也不变）：
 * - 每项 1 到 SENTENCES_PER_UPDATE_MAX 句；
 * - 每句至少一个出处，出处只能写唤醒包给出的 src 编号（编号从 1 起，对照参与者的 sourceIds 顺序）；
 * - 每一句的出处不能只有验收结果（验收结果只作对比）；
 * - 每句 1 到 SENTENCE_MAX_CHARS 字。
 *
 * 全部错误一次列全（中文），调用方拿到错误数组后自己决定怎样汇总、是否抛出。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';

/** 工具入参里的一句：文字和它的出处编号。 */
export interface SentenceArg { text: string; sources: string[] }

/** 「src3」解成第 3 个出处的下标（从 0 起）；不是 src 加正整数、或超出出处条数，返回 null。 */
export function srcIndex(src: string, sourceCount: number): number | null {
  const number = Number(/^src(\d+)$/.exec(src)?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > sourceCount) return null;
  return number - 1;
}

/** 校验结果：count 为假时句子条数不合格（调用方通常跳过这一项的其余校验）。 */
export interface SentenceCheck { countOk: boolean; errors: string[] }

/**
 * 校验一项更新的句子。label 是错误文字里的前缀（propose 写「第 2 项」，revise 写「改写」）；
 * sourceIds 是这位员工这次记录里的出处编号表（src{k} 对应 sourceIds[k-1]）。
 */
export function validateSentences(ctx: HubContext, sourceIds: string[], sentences: SentenceArg[], label: string): SentenceCheck {
  const errors: string[] = [];
  if (sentences.length < 1 || sentences.length > D.SENTENCES_PER_UPDATE_MAX) {
    errors.push(`${label}：sentences 要 1 到 ${D.SENTENCES_PER_UPDATE_MAX} 句`);
    return { countOk: false, errors };
  }
  // src 编号只能是本次唤醒包给出的；每句至少一个。
  const okSources = sentences.every(sentence => sentence.sources.length >= 1
    && sentence.sources.every(src => srcIndex(src, sourceIds.length) !== null));
  if (!okSources) errors.push(`${label}：sources 只能写本次唤醒包里给出的 src 编号，每句至少一个`);
  // 每一句的出处不能只有验收结果（验收结果只作对比）：逐句判断，任何一句只引了验收结果就列出是第几句。
  sentences.forEach((sentence, sentenceIndex) => {
    const kinds = sentence.sources.map(src => {
      const index = srcIndex(src, sourceIds.length);
      return index === null ? null : ctx.store.table('skillSources').get(sourceIds[index]!)?.kind ?? null;
    }).filter((kind): kind is NonNullable<typeof kind> => kind !== null);
    if (kinds.length > 0 && kinds.every(kind => kind === 'acceptance')) {
      errors.push(`${label}第 ${sentenceIndex + 1} 句：出处不能只有验收结果（验收结果只作对比，要同时引用评审意见或你的纠正）`);
    }
  });
  for (const sentence of sentences) {
    const chars = [...sentence.text.trim()];
    if (chars.length < 1 || chars.length > D.SENTENCE_MAX_CHARS) errors.push(`${label}：每句 1 到 ${D.SENTENCE_MAX_CHARS} 字`);
  }
  return { countOk: true, errors };
}
