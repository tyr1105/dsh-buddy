/**
 * 办法的「选了会改什么」一行，以及「待你处理」条目正文的写法（P74r4a 第 1 条，对应第三次审查 K1）。
 *
 * 为什么放在 job/ 而不是 api/：这一行由中心生成，既要给三轮不过卡的视图用（api/job-escalation-views.ts），
 * 也要在总管向主人说明时校验、并写进「待你处理」条目的正文（job/escalate.ts）。主人点一个带改动的办法，中心就直接改约定，
 * 不再另请主人确认；所以主人在点之前必须在每一处入口都看得到同一行准确的改动说明，不能只靠模型写的标题。
 * 全部是纯函数。
 */
import type { JobEscalation } from '../model/job.js';

/** 「删去」一行里这一条原文最多显示的字数，超过截断加省略号。 */
export const CHANGE_LINE_TEXT_MAX = 60;

/** 办法里记下的改动。 */
export type OptionChangeRecord = JobEscalation['options'][number]['change'];

/**
 * 办法的「选了实际会改什么」一行（纯函数，中心按办法里记下的 change 字段生成，不由模型写）。
 * 与主人选办法时中心生成新版本用的是同一个字段（option.change，见 job/choose-option.ts）。
 * 办法不带改动返回 null；删去时取不到这一条的原文（记录里没有对应版本）就只写到「第 n 条」为止。
 */
export function changeLineOf(change: OptionChangeRecord, doneWhen: readonly string[] | null): string | null {
  if (change === null) return null;
  if (change.text !== null) return `选了会把「怎样算做完」第 ${change.no} 条改为：${change.text.trim()}`;
  const original = doneWhen?.[change.no - 1];
  if (original === undefined) return `选了会删去「怎样算做完」第 ${change.no} 条`;
  const chars = [...original];
  const shown = chars.length > CHANGE_LINE_TEXT_MAX ? `${chars.slice(0, CHANGE_LINE_TEXT_MAX).join('')}…` : original;
  return `选了会删去「怎样算做完」第 ${change.no} 条：${shown}`;
}

/**
 * 向主人说明时的校验：带改动的办法，中心必须生成得出 changeLine（序号在「怎样算做完」里），否则不能出卡。
 * 返回没有通过的说明（中文，一次列全）；全部通过返回空数组。办法不带改动的跳过。
 */
export function changeLineProblems(options: ReadonlyArray<{ change?: { no: number; text: string | null } | undefined }>, doneWhen: readonly string[]): string[] {
  const problems: string[] = [];
  options.forEach((option, index) => {
    if (option.change === undefined) return;
    const line = changeLineOf({ no: option.change.no, text: option.change.text }, doneWhen);
    if (line === null || option.change.no < 1 || option.change.no > doneWhen.length) {
      problems.push(`第 ${index + 1} 个办法：中心生成不出「选了会改什么」一行（「怎样算做完」一共 ${doneWhen.length} 条，没有第 ${option.change.no} 条）`);
    }
  });
  return problems;
}

/** 条目里一个办法的按钮文字：「{字母}　{标题}」（字母加全角空格，与 escalate.ts 的 optionLabel 同一写法）。 */
function labelOf(letter: string, title: string): string {
  return `${letter}　${title}`;
}

/**
 * 「待你处理」里这次说明的条目正文：先写卡在哪，之后逐个办法列出「{字母}　{标题}」，
 * 带改动的办法下一行是它的 changeLine 原文。主人不点进卡片，也能在条目里看到每个办法会改什么。
 */
export function escalationItemBody(stuckAt: string, options: ReadonlyArray<{ title: string; change: OptionChangeRecord }>, doneWhen: readonly string[], letters: readonly string[]): string {
  const rows = options.flatMap((option, index) => {
    const line = changeLineOf(option.change, doneWhen);
    return line === null ? [labelOf(letters[index]!, option.title)] : [labelOf(letters[index]!, option.title), line];
  });
  return [stuckAt, ...rows].join('\n');
}
