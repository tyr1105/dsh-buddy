/**
 * 技能库模型（P75b，第四块）：员工「自己积累」的技能、技能的版本、每一句的出处、一次技能更新、一次复盘或整理的记录，
 * 以及两张旁表（同类任务记录、约定类别）。
 *
 * 为什么全部用新表、不改已有记录（方案 5.1）：已有的约定、事、员工等都是 strictObject，多一个字段旧版本插件就整条读不出；
 * 新表旧版本直接忽略，升级和回退都安全。
 *
 * 为什么出处原文要抄进表里：事件日志在内存里只保留 14 天，而技能的出处、版本、同类任务对比要在几个月之后仍然正确；
 * 出处原文由中心从记录里原样抄出，员工写不进。
 *
 * 本文件只定义结构与校验，不读时钟、不读存储、不调用模型。数值上限来自 config/defaults.ts 的 SKILL_DEFAULTS；
 * 字数一律按完整字符计（[...s].length）；错误信息全部中文，配合 parseWithPaths 会写明出错字段的路径。
 */
import { z } from 'zod';
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { count, nonempty, recordId, timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// 文字字段小工具
// ---------------------------------------------------------------------------

/**
 * 控制字符：C0（含换行、回车、制表符）、DEL 与 C1，再加 Unicode 的行分隔符和段分隔符。
 * 用字符串转义构造，源码里不放这两个特殊字符本身。
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/**
 * 非空（去首尾空白后仍有内容）、不超过 max 个完整字符，并且默认是单行文字：
 * 不接受换行符、回车符、制表符和其他控制字符（P75r3）。
 * 为什么：句子、标题、「什么时候用」会原样写进技能文件的正文，换行会在文件里另起一行，冒充标题或中心标记字样。
 * 出处原文、核对说明不进技能文件，可能本来就是多行的，传 singleLine = false 保持原来的规则。
 */
function line(max: number, singleLine = true) {
  const base = nonempty
    .refine(value => value.trim().length > 0, '不能为空')
    .refine(value => [...value].length <= max, `不能超过 ${max} 字`);
  return singleLine ? base.refine(value => !CONTROL_CHARS.test(value), '必须是单行文字，不能含换行、回车、制表符等控制字符') : base;
}
/** 整数，可设下限；错误信息固定为中文。 */
const int = (min: number) => z.number({ error: '必须是整数' }).int('必须是整数').min(min, `不能小于 ${min}`);
/** 一句技能：不超过 SENTENCE_MAX_CHARS 个字。 */
const sentenceText = line(D.SENTENCE_MAX_CHARS);
/** 一句技能引用的出处编号：至少 1 个（没有出处的句子不能写入）。 */
const sourceIdList = z.array(nonempty, { error: 'sourceIds：必须是出处编号的数组' }).min(1, '每一句至少要有 1 个出处');

// ---------------------------------------------------------------------------
// 技能与版本
// ---------------------------------------------------------------------------

/** 技能状态：在用（放进员工的技能目录）/ 收起（不放进目录，可放回）。 */
export const SKILL_STATES = ['active', 'collapsed'] as const;
export const SkillStateSchema = z.enum(SKILL_STATES, { error: '技能状态必须是 active、collapsed 之一' });
/** 收起的原因：久未用 / 来源不明（迁移来的）/ 被合并 / 升级迁移时在用名额放不下（P75r2）。 */
export const SKILL_COLLAPSE_REASONS = ['unused', 'unknown_source', 'merged', 'migrated'] as const;
export const SkillCollapseReasonSchema = z.enum(SKILL_COLLAPSE_REASONS, { error: '收起原因必须是 unused、unknown_source、merged、migrated 之一' });
/** 迁移来的旧经验的来源：套路 / 教训 / 原长期记忆文件。 */
export const SKILL_LEGACY_KINDS = ['routine', 'lesson', 'memory_md'] as const;

/** 一条自己积累的技能（每位员工的技能库里的一项）。 */
export const SkillSchema = z.strictObject({
  id: recordId('sk'),
  botId: recordId('b'),
  title: line(D.TITLE_MAX_CHARS), // 「表单页做法」
  whenToUse: line(D.WHEN_MAX_CHARS), // 什么时候用，写进技能文件的 description
  supplements: nonempty.nullable(), // 补充自哪条岗位技能（预置技能 id 或 DSH 技能名）；没有为 null
  // 家目录 .agents/skills/ 下的目录名，也是 DSH 里的技能名：self- 加 id 后 8 位
  dirName: z.string({ error: '必须是文字' }).regex(/^self-[a-z0-9]{8}$/, '必须是 self- 加 8 位小写字母或数字'),
  state: SkillStateSchema,
  collapseReason: SkillCollapseReasonSchema.nullable(),
  currentVersionNo: int(1),
  categories: z.array(nonempty), // 产生过出处的事的类别（去重）
  lastUsedAt: timestamp.nullable(), // 最近一次被加载；没有为 null
  legacy: z.strictObject({
    kind: z.enum(SKILL_LEGACY_KINDS, { error: '旧经验来源必须是 routine、lesson、memory_md 之一' }),
    refId: nonempty.nullable(),
  }).nullable(), // 迁移来的才有
  createdAt: timestamp,
  updatedAt: timestamp,
  collapsedAt: timestamp.nullable(),
  // P75r5c（审查 M3、L9）：最近一次从「不常用」放回在用的时间（主人在技能库里放回，或接到同类的事时自动放回）。
  // 每周整理判断「最近用到」时取它、最近一次被调用、当前版本建立时间三者里最晚的，所以放回的技能 30 天内不会再被收起。
  // 可省略：新表同版本扩展，旧技能没有这个字段。
  restoredAt: timestamp.nullable().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

/** 技能版本的产生方式：新建 / 新增句子 / 合并 / 迁移。 */
export const SKILL_CHANGES = ['create', 'add', 'merge', 'migrate'] as const;

/** 技能的一句话：正文、出处、第几版加入的。 */
export const SkillSentenceSchema = z.strictObject({
  text: sentenceText,
  sourceIds: sourceIdList,
  addedInNo: int(1),
});
export type SkillSentence = z.infer<typeof SkillSentenceSchema>;

/** 技能的一个版本；每次通过核对的修改生成一个，旧版本保留，可回退。 */
export const SkillVersionSchema = z.strictObject({
  id: recordId('skv'),
  skillId: recordId('sk'),
  no: int(1),
  sentences: z.array(SkillSentenceSchema, { error: 'sentences：必须是数组' })
    .min(1, '至少要有 1 句').max(D.SENTENCES_MAX, `最多 ${D.SENTENCES_MAX} 句`),
  change: z.enum(SKILL_CHANGES, { error: '版本产生方式必须是 create、add、merge、migrate 之一' }),
  updateId: recordId('su').nullable(), // 由哪次技能更新产生；迁移为 null
  basedOnNo: int(1).nullable(), // 在哪一版上改的（回退后再更新时不等于 no-1）
  checkedBy: nonempty.nullable(), // 核对人的员工 id，或 'hub'（迁移）
  createdAt: timestamp,
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

// ---------------------------------------------------------------------------
// 出处
// ---------------------------------------------------------------------------

/** 出处的四类加迁移用的「来源不明」：评审意见 / 你的纠正（验收）/ 验收结果 / 你的指示 / 迁移来的。 */
export const SOURCE_KINDS = ['review', 'owner_correction', 'acceptance', 'owner_instruction', 'unknown'] as const;

/** 一条出处：一句技能从哪里学来。原文由中心从记录里原样抄出，员工写不进。 */
export const SkillSourceSchema = z.strictObject({
  id: recordId('ss'),
  botId: recordId('b'), // 这条出处给谁学
  kind: z.enum(SOURCE_KINDS, { error: '出处类型必须是 review、owner_correction、acceptance、owner_instruction、unknown 之一' }),
  label: line(D.SOURCE_LABEL_MAX_CHARS), // 中心生成，给主人看
  quote: line(D.SOURCE_QUOTE_MAX_CHARS, false), // 原文：原样抄出，可能是多行，不限单行
  relayed: z.boolean({ error: '必须是布尔值' }), // 主人原话取不到、用了总管转述时为 true
  jobId: recordId('job').nullable(),
  category: nonempty.nullable(),
  refs: z.strictObject({
    reviewId: nonempty.optional(),
    itemNo: int(1).optional(),
    messageId: nonempty.optional(),
    sessionId: nonempty.optional(),
  }),
  createdAt: timestamp,
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

// ---------------------------------------------------------------------------
// 技能更新（待核对）
// ---------------------------------------------------------------------------

/** 一次技能核对三项里每一项的结论。 */
const CheckVerdict = z.enum(['met', 'unmet'], { error: '核对结论必须是 met、unmet 之一' });

/** 技能更新的状态：核对中 / 等待改写 / 已通过 / 已放弃。 */
export const SKILL_UPDATE_STATES = ['checking', 'rewrite', 'passed', 'abandoned'] as const;

/** 一次技能更新：对一条技能的新增、修改（新建也算）或合并，待核对人核对。 */
export const SkillUpdateSchema = z.strictObject({
  id: recordId('su'),
  botId: recordId('b'), // 提交人
  runId: recordId('sr'),
  kind: z.enum(['learn', 'merge'], { error: '更新类型必须是 learn、merge 之一' }),
  skillId: recordId('sk').nullable(), // null 表示新建
  newSkill: z.strictObject({
    title: line(D.TITLE_MAX_CHARS),
    whenToUse: line(D.WHEN_MAX_CHARS),
    supplements: nonempty.nullable(),
  }).nullable(),
  mergeFromIds: z.array(recordId('sk')), // merge 时被并入的技能
  // 只含本次新增的句子（merge 时是合并后的全文）
  sentences: z.array(z.strictObject({ text: sentenceText, sourceIds: sourceIdList }), { error: 'sentences：必须是数组' })
    .min(1, '至少要有 1 句').max(D.SENTENCES_MAX, `最多 ${D.SENTENCES_MAX} 句`),
  checkerId: recordId('b'),
  state: z.enum(SKILL_UPDATE_STATES, { error: '更新状态必须是 checking、rewrite、passed、abandoned 之一' }),
  checks: z.array(z.strictObject({
    at: timestamp,
    checkerId: recordId('b'),
    // 出处是否真实存在：中心判出处不存在时也写 unmet
    exists: CheckVerdict,
    consistent: CheckVerdict, // 更新说的事出处里说过
    withinScope: CheckVerdict, // 没有超出出处的范围
    note: line(D.CHECK_NOTE_MAX_CHARS, false).nullable(), // 核对说明不进技能文件，不限单行
    // P75h：这次核对时更新的句子（改写之后更新的句子会换成新的，核对卡要如实显示当时核对的是哪几句）。
    // 可省略：P75h 之前没有这个字段。
    sentences: z.array(z.strictObject({ text: sentenceText, sourceIds: sourceIdList })).optional(),
  })),
  rewrites: int(0).max(D.REWRITE_MAX, `最多改写 ${D.REWRITE_MAX} 次`),
  versionNo: int(1).nullable(), // 通过后写入的是第几版
  // P75h：放弃的原因（改写后仍不符、核对人没有核对、没有改写、写入失败时的错误原文等）；只留在记录里，
  // 可省略：新表同版本扩展，P75h 之前写下的更新没有这个字段，仍然读得出。
  abandonReason: z.string({ error: '必须是文字' }).nullable().optional(),
  // P75r5c（审查 M1）：合并类更新记下整理时被并入的技能（from）和保留的技能（into）当时的版本号。
  // 核对通过、写入之前比对：任何一条的当前版本已经不是当时那一版，这条合并放弃（整理之后技能有了新版本，不能用整理那一刻的句子整体覆盖）。
  // 可省略：新表同版本扩展，没有这个字段的旧更新不做这项比对。
  mergeBase: z.strictObject({ fromVersionNo: int(1), intoVersionNo: int(1) }).optional(),
  // P75r6（复验 N3）：合并类更新的两条原技能出处有重合、而且其中一侧没有独有的出处时记 true：
  // 中心无法按出处判断被并入的内容是否保留，核对段对这条合并多写一句请核对人逐句对照。可省略（旧更新、没有这种情形的更新没有它）。
  sharedSources: z.boolean().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).superRefine((update, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  if (update.kind === 'learn') {
    // 学习：skillId 为 null 就是新建，必须写明新技能的名称；否则是给已有技能新增，不能再带 newSkill。
    if (update.skillId === null && update.newSkill === null) bad(['newSkill'], '新建技能必须写明名称和什么时候用');
    if (update.skillId !== null && update.newSkill !== null) bad(['newSkill'], '给已有技能新增句子时不能再写新技能的信息');
  } else {
    // 合并：目标技能必须存在，且至少并入一条别的技能。
    if (update.skillId === null) bad(['skillId'], '合并必须写明合并到哪一条技能');
    if (update.mergeFromIds.length === 0) bad(['mergeFromIds'], '合并至少要并入 1 条技能');
  }
});
export type SkillUpdate = z.infer<typeof SkillUpdateSchema>;

// ---------------------------------------------------------------------------
// 一次复盘、学习、整理的记录
// ---------------------------------------------------------------------------

/** 参与者被跳过或放弃的原因码（P76 的停滞通知和消耗页读它，不靠事件日志）。 */
export const SKILL_RUN_REASONS = ['no_checker', 'owner_paused', 'archived', 'skill_cap', 'skill_expired', 'busy_all_day', 'no_update', 'no_change', 'no_slot', 'few_skills'] as const;
// P75r5c 新增两个：no_slot 是每周整理当天没有排上整理回合（额度灯、全队当天的上限、重试退避等），与 busy_all_day（当天一直有在办的事）分开记；
// few_skills 是上周有通过的更新、但在用的技能不到 TIDY_MIN_SKILLS 条，与 no_change（本周技能库没有变化）分开记。

/**
 * P75i：一次学习（主人指定会话）的记录，放在 SkillRun.learn 上。
 * sessions 是总管请主人选的几段最近会话；sessionId、digest 在主人选定之后才有；inboxId 是那条「待你处理」。
 * digest 是会话摘要原文，可能是多行文字，不限单行（只进唤醒包的不可信围栏和核对唤醒包，不进技能文件）。
 */
export const SkillRunLearnSchema = z.strictObject({
  learnerId: recordId('b'), // 学习的员工
  note: z.string({ error: '必须是文字' }).min(1, '主人要学什么不能为空'), // 主人要学什么（单行，teach 工具已校验）
  sessions: z.array(z.strictObject({ id: nonempty, title: z.string(), at: timestamp })), // 供选择的最近会话
  sessionId: nonempty.nullable(), // 主人选定的会话
  digest: z.string({ error: '必须是文字' }).nullable(), // 选定会话的摘要原文
  inboxId: recordId('i').nullable(), // 「待你处理」里的那条提问
  // P75r6（复验 N4）：主人选定会话的时刻。学习的 7 天过期从这个时刻算起（总管发起学习之后主人可能隔很多天才选会话）。
  // 可省略：没有这个时刻的旧记录仍按记录建立的时刻起算。
  chosenAt: timestamp.optional(),
});
export type SkillRunLearn = z.infer<typeof SkillRunLearnSchema>;

/** 一次复盘（retro）、学习（learn）或每周整理（tidy）的记录。 */
export const SkillRunSchema = z.strictObject({
  id: recordId('sr'),
  kind: z.enum(['retro', 'learn', 'tidy'], { error: '类型必须是 retro、learn、tidy 之一' }),
  jobId: recordId('job').nullable(),
  category: nonempty.nullable(),
  participants: z.array(z.strictObject({
    botId: recordId('b'),
    role: z.enum(['executor', 'reviewer', 'chief', 'checker'], { error: '角色必须是 executor、reviewer、chief、checker 之一' }),
    sourceIds: z.array(nonempty), // 给他的出处（唤醒包里写成 src1、src2……，对照存在这里）
    state: z.enum(['queued', 'running', 'done', 'skipped', 'expired', 'capped'], { error: '状态必须是 queued、running、done、skipped、expired、capped 之一' }),
    reason: z.enum(SKILL_RUN_REASONS, { error: '原因码不在允许的取值之内' }).nullable(),
    // P75i：这位参与者提交（propose、tidy）所在的唤醒编号。可省略（旧行没有）：有它时「这个回合提交过没有」直接比对编号，
    // 不再靠主题里的复盘卡判断（学习和整理的记录没有主题，不落复盘卡）。
    proposedWakeId: z.string({ error: '必须是文字' }).nullable().optional(),
  })),
  turnsUsed: count,
  turnCap: count,
  tokens: count,
  summaryPostedAt: timestamp.nullable(), // 复盘小结已落主题的时间
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
  // ---- P75i 新增（全部可省略：新表同版本扩展，旧行没有这些字段仍然读得出）----
  weekOf: z.string({ error: '必须是文字' }).regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD').nullable().optional(), // 整理：本周一的本地日期
  learn: SkillRunLearnSchema.nullable().optional(), // 学习的内容
  // 整理：按规则收起的技能（不调用模型）。days 只在 unused 时有值：多少天没用到。
  collapsed: z.array(z.strictObject({
    skillId: recordId('sk'), reason: z.enum(['unused', 'unknown_source'], { error: '收起原因必须是 unused、unknown_source 之一' }),
    days: z.number().int().min(0).nullable(),
  })).optional(),
  // 整理：员工提交的每项合并（updateId 对应一条 kind 为 merge 的更新）与理由。
  merges: z.array(z.strictObject({ updateId: recordId('su'), reason: z.string() })).optional(),
  tidyNote: z.string({ error: '必须是文字' }).nullable().optional(), // 整理：员工写的一句发现
  // 整理：按规则收起之后、员工开始整理时在用的技能条数（活动流里「{a} 条变为 {b} 条」的 a；b = a 减去核对通过的合并数）。
  // 任务卡第 3 节没有列这一项；技能条数会随时间变，事后现算会错，所以建记录时记下。
  activeAtStart: z.number({ error: '必须是整数' }).int().min(0).optional(),
});
export type SkillRun = z.infer<typeof SkillRunSchema>;

// ---------------------------------------------------------------------------
// 同类任务记录与约定类别（两张旁表）
// ---------------------------------------------------------------------------

/** 同类任务记录：每件验收通过的事一行，id 就是这件事的 id（幂等的键）。 */
export const JobOutcomeSchema = z.strictObject({
  id: recordId('job'),
  category: nonempty,
  executorId: recordId('b'),
  reviewerId: recordId('b').nullable(), // 总管自己核对时为 null
  title: nonempty,
  rounds: count, // 全部核对阶段的轮数之和
  reworks: count, // 验收返工次数（主人指出不符的次数）
  turns: count, // 执行链回合数
  seq: int(1), // 这位执行者这个类别的第几次
  acceptedAt: timestamp,
});
export type JobOutcome = z.infer<typeof JobOutcomeSchema>;

/** 约定的类别标签：id 就是约定的 id；放旁表，不改约定结构。 */
export const AgreementTagSchema = z.strictObject({
  id: recordId('agr'),
  category: nonempty,
  setAt: timestamp,
});
export type AgreementTag = z.infer<typeof AgreementTagSchema>;
