/**
 * 工具 hub_skill：在复盘、核对、改写、整理回合里提交、核对、改写技能更新，总管请主人选会话让员工学习
 * （P75g 的 propose，P75h 加 check、revise，P75i 加 teach、tidy）。
 *
 * 五个 mode：
 * - propose（P75g）：复盘或学习回合里提交技能更新；
 * - check（P75h）：核对人核对一条更新，三项都符合就写入技能库，不符就退回改写（最多一次；合并类更新不符直接放弃）；
 * - revise（P75h）：提交人按核对人的意见改写自己的更新；
 * - teach（P75i）：仅总管，主人发话叫醒的回合里请主人选一段会话，让某位员工学其中的做法；
 * - tidy（P75i）：每周整理回合里提交「合并重复」的结果。
 * 参数平铺、根节点不用联合类型；每个 mode 只认自己的字段，放错 mode 的字段直接报错（P74 写法）。
 * 身份与回合检查在服务层（skill/propose.ts、check.ts、revise.ts、learn.ts、tidy-submit.ts）。
 * 这个工具不在 tools/common.ts 的 reflectionWrites 名单里（名单里的工具在复盘回合一律拒绝），所以复盘类回合可以调用。
 */
import { z } from 'zod';
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { runPropose, type ProposeArgs } from '../skill/propose.js';
import { runCheck } from '../skill/check.js';
import { runRevise } from '../skill/revise.js';
import { runTeach } from '../skill/learn.js';
import { runTidy } from '../skill/tidy-submit.js';
import { defineTool } from './common.js';

/** 带长度范围的一段文字：去首尾空白，1 到 max 字（按完整字符计）。 */
function limited(max: number, label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= max, `${label}：不能超过 ${max} 字`);
}

/** 一句技能：文字加出处编号（propose 与 revise 共用）。 */
const SentenceSchema = z.strictObject({
  text: limited(D.SENTENCE_MAX_CHARS, 'text').describe(`一句做法，1 到 ${D.SENTENCE_MAX_CHARS} 字`),
  sources: z.array(z.string({ error: 'sources：必须是文字' }).min(1), { error: 'sources：必须是数组' }).min(1, '每句至少写一个出处')
    .describe('这句学自哪个出处：写唤醒包里给出的 src 编号，至少一个'),
});

const VerdictSchema = z.enum(['met', 'unmet'], { error: '必须是 met 或 unmet' });

/** 整理里的一项合并：被并入的技能名、保留的技能名、理由、合并后 into 的全部句子。 */
const MergeSchema = z.strictObject({
  from: limited(D.TITLE_MAX_CHARS, 'from').describe('被并入的技能的编号（唤醒包里括号前的 sk1 这样的编号）'),
  into: limited(D.TITLE_MAX_CHARS, 'into').describe('保留的技能的编号（唤醒包里括号前的 sk1 这样的编号）'),
  reason: limited(60, 'reason').describe('一句话说明为什么重复，不超过 60 字'),
  sentences: z.array(SentenceSchema, { error: 'sentences：必须是数组' })
    .min(1, 'sentences：至少 1 句').max(D.SENTENCES_MAX, `sentences：最多 ${D.SENTENCES_MAX} 句`)
    .describe('合并后 into 的全部句子；sources 只能用两条原技能里已有的出处编号'),
});

export const HubSkillInputSchema = z.strictObject({
  mode: z.enum(['propose', 'check', 'revise', 'teach', 'tidy'], { error: 'mode：必须是 propose（提交技能更新）、check（核对）、revise（改写）、teach（请主人选会话学习）、tidy（整理）之一' })
    .describe('propose 在复盘或学习回合里提交技能更新；check 核对一条技能更新；revise 按核对人的意见改写自己的更新；teach 请主人选一段会话让员工学习；tidy 每周整理时提交合并结果'),
  staff: limited(40, 'staff').optional().describe('mode 为 teach 时必填：要学习的员工的名字'),
  merges: z.array(MergeSchema, { error: 'merges：必须是数组' }).max(D.TIDY_MERGES_MAX, `merges：最多 ${D.TIDY_MERGES_MAX} 项`)
    .optional().describe('mode 为 tidy 时必填：要合并的每一项；没有可合并的传空数组'),
  updates: z.array(z.strictObject({
    skill: limited(D.TITLE_MAX_CHARS, 'skill').optional().describe('已有技能的编号（唤醒包里括号前的 sk1 这样的编号）；新建时不填'),
    title: limited(D.TITLE_MAX_CHARS, 'title').optional().describe('新建技能的名称，只能用中文、英文字母、数字、空格和「-」「·」「、」'),
    whenToUse: limited(D.WHEN_MAX_CHARS, 'whenToUse').optional().describe('新建技能的什么时候用，写成一行'),
    supplements: limited(D.TITLE_MAX_CHARS, 'supplements').optional().describe('补充自哪条岗位技能（写它的名字）'),
    sentences: z.array(SentenceSchema, { error: 'sentences：必须是数组' })
      .min(1, 'sentences：至少 1 句').max(D.SENTENCES_PER_UPDATE_MAX, `sentences：最多 ${D.SENTENCES_PER_UPDATE_MAX} 句`),
  }), { error: 'updates：必须是数组' }).max(D.UPDATES_PER_PROPOSE_MAX, `updates：最多 ${D.UPDATES_PER_PROPOSE_MAX} 项`)
    .optional().describe('mode 为 propose 时必填：要提交的技能更新；同一条技能的多处新增合并成一项；没有可写的就传空数组并写 note'),
  note: limited(Math.max(D.NOTE_MAX_CHARS, D.CHECK_NOTE_MAX_CHARS), 'note').optional()
    .describe('propose：没有可写的更新时写一句为什么；check：有 unmet 时必填，写哪一句不符、删去什么或改成什么就能写入；teach：写主人要学什么（不超过 100 字）；tidy：写一句发现，没有就写「没有发现相互矛盾的条目」'),
  updateId: limited(64, 'updateId').optional().describe('mode 为 check、revise 时必填：唤醒包里给出的更新编号'),
  consistent: VerdictSchema.optional().describe('mode 为 check 时必填：更新说的事，出处里说过（met 或 unmet）'),
  withinScope: VerdictSchema.optional().describe('mode 为 check 时必填：没有超出出处的范围（met 或 unmet）'),
  sentences: z.array(SentenceSchema, { error: 'sentences：必须是数组' })
    .min(1, 'sentences：至少 1 句').max(D.SENTENCES_PER_UPDATE_MAX, `sentences：最多 ${D.SENTENCES_PER_UPDATE_MAX} 句`)
    .optional().describe('mode 为 revise 时必填：改写后的全部句子，sources 只能用唤醒包里列出的 src 编号'),
});
type HubSkillInput = z.infer<typeof HubSkillInputSchema>;

/** 工具说明：propose 一句沿用 P75g 的原文，check、revise 各一句。 */
const DESCRIPTION = '在复盘、核对、改写回合里提交、核对、改写技能更新。mode propose：updates 每项写 skill（已有技能的编号，如 sk1）或 title 与 whenToUse（新建一条），sentences 每句写 text（不超过 80 字）与 sources（唤醒包里的 src 编号）；没有可写的就传空数组并写 note。mode check：updateId、consistent、withinScope 各写 met 或 unmet，有 unmet 时 note 必填。mode revise：updateId 加改写后的全部 sentences。只能在中心叫你复盘、核对、改写的回合里用。mode teach（仅总管）：staff 写员工名字，note 写主人要学什么；只在主人发话叫醒的回合里用。mode tidy：merges 每项写 from、into（技能编号，如 sk1）、reason、sentences，note 写一句发现；只在中心叫你整理技能库的回合里用。';

/** 每个 mode 只认自己的字段：放错 mode 的字段报错并点出是哪个字段、属于哪个 mode。 */
function misplaced(args: HubSkillInput): string[] {
  const own: Record<HubSkillInput['mode'], Array<keyof HubSkillInput>> = {
    propose: ['mode', 'updates', 'note'],
    check: ['mode', 'updateId', 'consistent', 'withinScope', 'note'],
    revise: ['mode', 'updateId', 'sentences'],
    teach: ['mode', 'staff', 'note'],
    tidy: ['mode', 'merges', 'note'],
  };
  const belongsTo: Record<string, string> = {
    updates: 'propose', note: 'propose、check', updateId: 'check、revise', consistent: 'check', withinScope: 'check', sentences: 'revise',
    staff: 'teach', merges: 'tidy',
  };
  // note 还被 teach、tidy 用：前面一段与原来逐字相同，括号里补上后加的两个 mode。
  const alsoUsedBy: Record<string, string> = { note: '（teach、tidy 也用这一项）' };
  const errors: string[] = [];
  for (const key of Object.keys(args) as Array<keyof HubSkillInput>) {
    if (args[key] === undefined || own[args.mode].includes(key)) continue;
    errors.push(`${key}：只在 mode 为 ${belongsTo[key] ?? '其他'} 时填写${alsoUsedBy[key] ?? ''}，mode ${args.mode} 不用这一项`);
  }
  return errors;
}

export const hubSkill = defineTool('hub_skill', DESCRIPTION, HubSkillInputSchema, 'L1', async (ctx, tc, args) => {
  const wrong = misplaced(args);
  if (wrong.length > 0) throw new Error(wrong.join('；'));
  if (args.mode === 'propose') {
    if (args.updates === undefined) throw new Error('updates：mode 为 propose 时必填（没有可写的更新时传空数组并写 note）');
    return { ok: true, text: await runPropose(ctx, tc, args as ProposeArgs) };
  }
  if (args.mode === 'check') {
    const missing: string[] = [];
    if (args.updateId === undefined) missing.push('updateId：mode 为 check 时必填');
    if (args.consistent === undefined) missing.push('consistent：mode 为 check 时必填，写 met 或 unmet');
    if (args.withinScope === undefined) missing.push('withinScope：mode 为 check 时必填，写 met 或 unmet');
    if (missing.length > 0) throw new Error(missing.join('；'));
    return { ok: true, text: await runCheck(ctx, tc, {
      updateId: args.updateId!, consistent: args.consistent!, withinScope: args.withinScope!, ...(args.note === undefined ? {} : { note: args.note }),
    }) };
  }
  if (args.mode === 'teach') {
    const missingTeach: string[] = [];
    if (args.staff === undefined) missingTeach.push('staff：mode 为 teach 时必填，写要学习的员工的名字');
    if (args.note === undefined) missingTeach.push('note：mode 为 teach 时必填，写主人要学什么');
    if (missingTeach.length > 0) throw new Error(missingTeach.join('；'));
    return { ok: true, text: await runTeach(ctx, tc, { staff: args.staff!, note: args.note! }) };
  }
  if (args.mode === 'tidy') {
    const missingTidy: string[] = [];
    if (args.merges === undefined) missingTidy.push('merges：mode 为 tidy 时必填（没有可合并的传空数组）');
    if (args.note === undefined) missingTidy.push('note：mode 为 tidy 时必填，写一句发现');
    if (missingTidy.length > 0) throw new Error(missingTidy.join('；'));
    return { ok: true, text: await runTidy(ctx, tc, { merges: args.merges!, note: args.note! }) };
  }
  const missing: string[] = [];
  if (args.updateId === undefined) missing.push('updateId：mode 为 revise 时必填');
  if (args.sentences === undefined) missing.push('sentences：mode 为 revise 时必填，写改写后的全部句子');
  if (missing.length > 0) throw new Error(missing.join('；'));
  return { ok: true, text: await runRevise(ctx, tc, { updateId: args.updateId!, sentences: args.sentences! }) };
});
