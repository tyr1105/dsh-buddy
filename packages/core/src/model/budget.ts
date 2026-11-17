/**
 * 一件事的消耗记录（P76b，第五块）：三张新表的结构。
 *
 * - jobUsage：一件事从对齐到验收用掉的回合与 token，按六步分别记，另有逐回合明细；
 * - jobEstimates：约定固定（或追加、缩小范围）时中心按规则算出的预计消耗，每个约定版本一项；
 * - jobNotices：停滞、提醒、预算提问的记号，保证「一次停滞只通知一次」「同一个预算线只问一次」。
 *
 * 为什么全部用新表、不改已有结构：Job、Agreement、Settings 都是 strictObject，多一个字段旧版本插件就整条读不出；
 * 新表旧版本直接忽略（只加载 TABLE_NAMES 里的表），升级和回退都安全。
 *
 * 本文件只定义结构与校验，不读时钟、不读存储；业务逻辑在 P76c 以后各卡里写。
 * 数值上限来自 config/defaults.ts 的 BUDGET_DEFAULTS。错误信息全部中文，配合 parseWithPaths 会写明出错字段的路径。
 */
import { z } from 'zod';
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import { bool, count, nonempty, recordId, timestamp } from './primitives.js';

/** 一件事的六个步骤：对齐、执行、核对、返工、总管（回答和说明）、发布。 */
export const USAGE_STEPS = ['align', 'exec', 'review', 'rework', 'chief', 'launch'] as const;
export const UsageStepSchema = z.enum(USAGE_STEPS, { error: '步骤必须是 align、exec、review、rework、chief、launch 之一' });
export type UsageStep = z.infer<typeof UsageStepSchema>;

/** 某一步已用的回合数与实测 token 数。 */
const StepUsageSchema = z.strictObject({ turns: count, tokens: count });

/** 一件事的用量（表 jobUsage，id 为 jobId）。 */
export const JobUsageSchema = z.strictObject({
  id: recordId('job'), // 这件事的 id
  agreementId: recordId('agr'), // 这件事依据的约定
  category: nonempty, // 同类记录的类别，验收时定稿
  // 六步各自的回合数与 token；合计不受 turns 明细条数上限影响
  steps: z.strictObject({
    align: StepUsageSchema, exec: StepUsageSchema, review: StepUsageSchema,
    rework: StepUsageSchema, chief: StepUsageSchema, launch: StepUsageSchema,
  }),
  // 逐回合明细，进度行展开时用；超过上限时丢最早的（steps 合计不受影响）
  turns: z.array(z.strictObject({
    wakeId: recordId('w'), // 唤醒单 id
    step: UsageStepSchema, // 这个回合属于哪一步
    botId: nonempty, // 做这个回合的员工
    startedAt: timestamp, // 回合开始时间
    endedAt: timestamp.nullable(), // 回合结束时间；还没结束为 null
    tokens: count, // 这个回合的实测 token
  }), { error: 'turns：必须是回合明细的数组' }).max(D.USAGE_TURNS_MAX, `turns：最多保留 ${D.USAGE_TURNS_MAX} 项`),
  finalizedAt: timestamp.nullable(), // 验收（或停止）时定稿，之后只读；未定稿为 null
  // P76e：定稿那一刻的合计（回合数、实测 token）。回执的「消耗」一行读它：验收之后发布这一步还会继续记回合，
  // 回执写的是验收时的数，不能随之变化；turns 明细超过上限会丢早期项，也不适合现算。
  // 可省略：P76e 之前没有这两项，旧行读得进来（先于 P76e 写下的行，回执一行按现有合计算）。
  finalUsed: count.optional(),
  finalTokens: count.optional(),
  updatedAt: timestamp,
});
export type JobUsage = z.infer<typeof JobUsageSchema>;

/**
 * P87：一件事上「你发起的回合」（表 jobOwnerTurns，id 为 jobId）。单列、不并入六步：六步、turnsUsed、预计、同类估计都不读它，
 * 只用于给你看的消耗文字。为什么是新表而不写进 jobUsage 的行：jobUsage 是 strictObject，装过新键的数据退回旧版本时，
 * 旧代码整行解析会失败（六步记账和定稿悄悄停止）；新表旧版本直接忽略（只加载 TABLE_NAMES 里的表）。
 * 一个你发起的回合，带这件事的 jobId 且由这件事的总管、执行者或核对人做，或由总管在这回合里对这件事成功调用了管理工具，就记在这里。
 */
export const JobOwnerTurnsSchema = z.strictObject({
  id: recordId('job'), // 这件事的 id
  total: StepUsageSchema, // 回合数与实测 token 合计（明细超过上限时合计不减）
  turns: z.array(z.strictObject({
    wakeId: recordId('w'), // 唤醒单 id；同一张唤醒单最多记在一件事上
    botId: nonempty, // 做这个回合的员工
    startedAt: timestamp, // 回合开始时间
    endedAt: timestamp.nullable(), // 记账时间；还没记账为 null
    tokens: count, // 这个回合的实测 token
  }), { error: 'turns：必须是回合明细的数组' }).max(D.OWNER_TURNS_MAX, `turns：最多保留 ${D.OWNER_TURNS_MAX} 项`),
  // 定稿那一刻的回合数与 token（回执读它，与 jobUsage 的 finalUsed、finalTokens 同理）；这一栏为 0 或还没定稿时没有。
  finalTurns: count.optional(),
  finalTokens: count.optional(),
  updatedAt: timestamp,
});
export type JobOwnerTurns = z.infer<typeof JobOwnerTurnsSchema>;

/** 预计消耗里的五步（发布另计，不在其中）。 */
const EstimateStepsSchema = z.strictObject({ align: count, exec: count, review: count, rework: count, chief: count });

/** 预计消耗的依据：默认份额，或同类记录。 */
export const ESTIMATE_BASES = ['default', 'history'] as const;
/** 这一项预计是怎么来的：首次固定、你追加、缩小范围后的新版、约定还在待确认时算的。 */
export const ESTIMATE_REASONS = ['lock', 'top_up', 'narrow', 'draft'] as const;

/** 一件事的预计消耗（表 jobEstimates，id 为 agreementId）；每个约定版本一项。 */
export const JobEstimateSchema = z.strictObject({
  id: recordId('agr'), // 约定 id
  versions: z.array(z.strictObject({
    versionNo: count.min(1, '约定版本号至少为 1'), // 约定第几版时算的
    total: count, // 预计回合总数（不含发布）
    steps: EstimateStepsSchema, // 按步骤拆开
    tokenLow: count, // 实测 token 区间下限
    tokenHigh: count, // 实测 token 区间上限
    basis: z.enum(ESTIMATE_BASES, { error: '依据必须是 default、history 之一' }), // history：同类记录不少于 HISTORY_MIN 件
    historyCount: count, // 用了几件同类记录
    // draft：约定还在待确认时算的那一项，固定时换成 lock
    reason: z.enum(ESTIMATE_REASONS, { error: '原因必须是 lock、top_up、narrow、draft 之一' }),
    createdAt: timestamp,
  }), { error: 'versions：必须是预计消耗的数组' }),
});
export type JobEstimate = z.infer<typeof JobEstimateSchema>;
/** 预计消耗里的一项（某个约定版本算出的那一份）。 */
export type EstimateVersion = JobEstimate['versions'][number];

/** 停滞的三种：停摆、空转、逾期。 */
export const STALL_KINDS = ['idle', 'spin', 'overdue'] as const;
export type StallKind = (typeof STALL_KINDS)[number];

/** 停滞与提醒的记号（表 jobNotices，id 为 jobId）。 */
export const JobNoticeSchema = z.strictObject({
  // 这件事的 id；P76g 起也认约定的 id（agr_ 开头）：约定确认条目在这份约定还没有事时，「在等你」的提醒记号写在这样的行里
  id: z.union([recordId('job'), recordId('agr')], { error: '必须是 job_ 或 agr_ 加 10 位小写字母或数字' }),
  lastProgressAt: timestamp, // 最近一次「记录」（有进展的事件）的时间
  rewakeAt: timestamp.nullable(), // 本次停摆已重新唤醒的时间；还没重新唤醒为 null
  stallNotifiedAt: timestamp.nullable(), // 最近一次停滞通知的时间
  stallKind: z.enum(STALL_KINDS, { error: '停滞种类必须是 idle、spin、overdue 之一' }).nullable(), // 最近一次停滞是哪种
  overdueNotifiedFor: timestamp.nullable(), // 已为哪个交付时间通知过逾期
  remindedItemIds: z.array(nonempty), // 已提醒过一次的「待你处理」条目
  budgetAskedCaps: z.array(count), // 已就哪几个预算线问过「将超出预计」
  holdAtCap: bool, // 你选了「暂停」：用到预算线时转「你已暂停」
  narrowRequestedAt: timestamp.nullable(), // 你选了「缩小范围」、总管的新版本还没确认的时间
  dueRiskNotifiedAt: timestamp.nullable(), // 额度会误了交付时间的通知时间
  updatedAt: timestamp,
});
export type JobNotice = z.infer<typeof JobNoticeSchema>;
