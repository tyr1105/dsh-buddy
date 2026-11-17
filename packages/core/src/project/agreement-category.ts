/**
 * 约定的类别（P75b，方案 7.1）：总管对齐时标注「这件事属于哪类工作」，存在旁表 agreementTags 里。
 *
 * 为什么放旁表：约定是 strictObject，加字段会让旧版本插件整条读不出；类别只用于「同类任务对比」和以后查先例，
 * 放旁表既不改约定结构，也不影响旧数据（没有标签的约定一律按默认类别「其他」读）。
 *
 * 本文件只做三件事：读类别（约定、事）、按规则写标签、生成给总管看的词表那一行。写表的时机由 agreements.ts 的 commit 决定。
 */
import { SKILL_DEFAULTS } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { AgreementTagSchema } from '../model/skill.js';
import { parseInput } from '../engine/validation.js';

/** 约定的类别；没有标签（旧数据、新建时没填且尚未写入）返回默认类别「其他」。 */
export function agreementCategory(ctx: HubContext, agreementId: string): string {
  return ctx.store.table('agreementTags').get(agreementId)?.category ?? SKILL_DEFAULTS.DEFAULT_CATEGORY;
}

/** 一件事的类别：经这件事的约定编号取；找不到这件事时返回默认类别。 */
export function jobCategory(ctx: HubContext, jobId: string): string {
  const job = ctx.store.table('jobs').get(jobId);
  return job === null ? SKILL_DEFAULTS.DEFAULT_CATEGORY : agreementCategory(ctx, job.agreementId);
}

/**
 * 写这份约定的类别标签。规则：新建时一定写一行（没填按默认类别）；修订时填了就改、不填不动。
 * category 是否属于词表已经由工具参数校验过，这里仍过一遍表的 schema，保证写进去的行合格。
 * 失败时抛出错误；写入前已校验，所以失败不会留下半行。
 */
export function writeAgreementTag(ctx: HubContext, agreementId: string, category: string | undefined, isNew: boolean): void {
  const wanted = isNew ? (category ?? SKILL_DEFAULTS.DEFAULT_CATEGORY) : category;
  if (wanted === undefined) return;
  const row = parseInput(AgreementTagSchema, { id: agreementId, category: wanted, setAt: ctx.clock.now() }, '约定类别');
  ctx.store.table('agreementTags').put(row);
}

/** 约定段末尾给总管看的类别词表那一行：总管填 category 时只能写这些。 */
export function categoryListLine(): string {
  return `类别（category 只能写这些）：${SKILL_DEFAULTS.CATEGORIES.join('、')}。`;
}
