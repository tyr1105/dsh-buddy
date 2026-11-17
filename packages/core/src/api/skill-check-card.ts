/**
 * 技能核对卡（P75h 第 6 节）：主题折叠组里核对人核对一条技能更新之后落的卡片（job_card，refId 为 skillcheck:<updateId>#<第几次核对>）。
 *
 * 做什么：左边出处原文、右边更新内容、下面三项检查的结论；不符时写明核对人的说明；底部一句话交代这次核对之后怎样。
 * 为什么每次核对一张卡、按「第几次」取数：同一条更新改写后会再核对一次，两次的结论、当时核对的句子都不同，
 * 卡片要各自如实显示，不能让第一张卡显示改写之后的句子。当时核对的句子记在核对记录（checks[].sentences）里。
 *
 * 纯函数（buildSkillCheckCard）加读存储的一层（skillCheckCardView）；视图文字全部书面表达，不含内部编号和工具名。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { SkillSource, SkillUpdate } from '../model/index.js';
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { parseSkillCheckCardRef } from '../skill/card.js';
import { versionNoIfPassed } from '../skill/check-facts.js';

export const SKILL_CHECK_KIND_TEXTS = ['评审意见', '你的纠正', '你的指示', '验收结果'] as const;
export const SKILL_CHECK_LABELS = ['出处在记录里真实存在', '更新说的事，出处里说过', '没有超出出处的范围'] as const;

export interface SkillCheckCardView {
  kind: 'skill_check';
  head: '核对';
  title: string;
  stateText: '已写入' | '未写入' | '等待改写';
  sources: { kindText: (typeof SKILL_CHECK_KIND_TEXTS)[number]; text: string }[];
  content: string[];
  checks: { label: (typeof SKILL_CHECK_LABELS)[number]; verdict: '符合' | '不符' }[];
  note: string | null;
  footer: string | null;
}

export const SkillCheckCardViewSchema = z.strictObject({
  kind: z.literal('skill_check'),
  head: z.literal('核对'),
  title: z.string(),
  stateText: z.enum(['已写入', '未写入', '等待改写']),
  sources: z.array(z.strictObject({ kindText: z.enum(SKILL_CHECK_KIND_TEXTS), text: z.string() })),
  content: z.array(z.string()),
  checks: z.array(z.strictObject({ label: z.enum(SKILL_CHECK_LABELS), verdict: z.enum(['符合', '不符']) })),
  note: z.string().nullable(),
  footer: z.string().nullable(),
});

/** 纯函数的输入：全部由调用方显式给出。 */
export interface SkillCheckCardInput {
  /** 这条更新对应的技能名。 */
  skillTitle: string;
  update: SkillUpdate;
  /** 第几次核对（从 1 起，对应 update.checks[nth - 1]）。 */
  nth: number;
  /** 通过后写入的是第几版；未通过时为将要写入的版本号。 */
  versionNo: number;
  /** 出处 id → 出处（读不到的不放进来）。 */
  sources: Record<string, SkillSource>;
}

/** 出处种类给主人看的名字；来源不明（只有升级迁移来的技能才有，不会出现在更新里）不显示。 */
function kindTextOf(kind: SkillSource['kind']): SkillCheckCardView['sources'][number]['kindText'] | null {
  if (kind === 'review') return '评审意见';
  if (kind === 'owner_correction') return '你的纠正';
  if (kind === 'owner_instruction') return '你的指示';
  if (kind === 'acceptance') return '验收结果';
  return null;
}

/** 核对卡的纯函数（任务卡第 6 节）。nth 超出核对记录时抛错（调用方保证）。 */
export function buildSkillCheckCard(input: SkillCheckCardInput): SkillCheckCardView {
  const { update, nth } = input;
  const check = update.checks[nth - 1];
  if (check === undefined) throw new Error(`这条更新没有第 ${nth} 次核对`);
  const allMet = check.exists === 'met' && check.consistent === 'met' && check.withinScope === 'met';
  const isLast = nth === update.checks.length;
  // 状态：三项都符合时，写入成功就是「已写入」，写入失败（更新被放弃）是「未写入」；
  // 有不符时，这次核对之后又有一次核对说明当时是退回改写，最后一次核对则看更新有没有被放弃。
  const stateText: SkillCheckCardView['stateText'] = allMet
    ? (update.state === 'passed' ? '已写入' : '未写入')
    : (isLast && update.state === 'abandoned' ? '未写入' : '等待改写');
  // 当时核对的句子（没有记录的旧数据用更新现在的句子）。
  const sentences = check.sentences ?? update.sentences;
  // 出处：按句子引用的顺序、去重。
  const seen = new Set<string>();
  const sources: SkillCheckCardView['sources'] = [];
  for (const sentence of sentences) {
    for (const id of sentence.sourceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const source = input.sources[id];
      const kindText = source === undefined ? null : kindTextOf(source.kind);
      if (source !== undefined && kindText !== null) sources.push({ kindText, text: source.quote });
    }
  }
  const verdictOf = (value: 'met' | 'unmet'): '符合' | '不符' => value === 'met' ? '符合' : '不符';
  // 底部一句话：等待改写写规则；改写后通过、改写后仍不符（放弃）各一句；第一次就通过、其他原因放弃不写。
  let footer: string | null = null;
  if (stateText === '等待改写') footer = `一条更新最多改写一次，第二次仍不符就放弃，只留在记录里。`;
  else if (stateText === '已写入' && nth > D.REWRITE_MAX) footer = '改写后核对通过。';
  else if (stateText === '未写入' && !allMet && nth > D.REWRITE_MAX) footer = '改写后仍不符，已放弃，只留在记录里。';
  return {
    kind: 'skill_check', head: '核对',
    title: `技能更新　「${input.skillTitle}」第 ${input.versionNo} 版`,
    stateText, sources,
    content: sentences.map(row => row.text),
    checks: [
      { label: '出处在记录里真实存在', verdict: verdictOf(check.exists) },
      { label: '更新说的事，出处里说过', verdict: verdictOf(check.consistent) },
      { label: '没有超出出处的范围', verdict: verdictOf(check.withinScope) },
    ],
    note: allMet ? null : check.note,
    footer,
  };
}

/** 读存储版：按核对卡的 refId 取数并调纯函数；找不到更新或这次核对返回 null。 */
export function skillCheckCardView(ctx: HubContext, refId: string): SkillCheckCardView | null {
  const ref = parseSkillCheckCardRef(refId);
  if (ref === null) return null;
  const update = ctx.store.table('skillUpdates').get(ref.updateId);
  if (update === null || update.checks[ref.nth - 1] === undefined) return null;
  const check = update.checks[ref.nth - 1]!;
  const ids = new Set((check.sentences ?? update.sentences).flatMap(row => row.sourceIds));
  const sources: Record<string, SkillSource> = {};
  for (const id of ids) {
    const source = ctx.store.table('skillSources').get(id);
    if (source !== null) sources[id] = source;
  }
  const skillTitle = update.skillId === null
    ? update.newSkill?.title ?? '新技能'
    : ctx.store.table('skills').get(update.skillId)?.title ?? '技能';
  return SkillCheckCardViewSchema.parse(buildSkillCheckCard({ skillTitle, update, nth: ref.nth, versionNo: versionNoIfPassed(ctx, update), sources }));
}
