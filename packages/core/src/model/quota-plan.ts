/**
 * 额度窗口的估计与记录（P76b，第五块）：表 quotaWindows，只有一行，id 固定为 quota。
 *
 * DSH 的模型额度按 5 小时一个窗口计，主人自己用 DSH 也算在里面，中心看不到插件之外的用量，只能估计窗口容量：
 * 起步按 BUDGET_DEFAULTS.INITIAL_WINDOW_TOKENS，遇到额度报错后按当时插件看得到的用量校准。
 * 每次报错把正文前 300 字、恢复时间、当时插件用量写进 errors，供以后校准（被动记录，不影响判断）。
 *
 * 为什么新建一张表而不改已有的 QuotaState：QuotaState 是 strictObject，加字段会让旧版本读不出；
 * 原来的 quota 表照旧写，旧版本读得懂。本表只定义结构，判断逻辑在 P76d。
 */
import { z } from 'zod';
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import { bool, count, nonempty, text, timestamp } from './primitives.js';

/** 容量估计的来源：起步默认值，或额度报错后的校准值。 */
export const CAPACITY_SOURCES = ['initial', 'calibrated'] as const;

/** 报错正文最多保留的字数。 */
export const QUOTA_ERROR_TEXT_MAX = 300;

/** 额度窗口记录（表 quotaWindows，一行 id 为 quota）。 */
export const QuotaPlanSchema = z.strictObject({
  id: z.literal('quota', { error: '额度窗口记录的 id 必须为 quota' }),
  capacityTokens: count, // 窗口估计容量（实测 token）
  capacitySource: z.enum(CAPACITY_SOURCES, { error: '容量来源必须是 initial、calibrated 之一' }),
  windowStartAt: timestamp, // 本窗口起点（报错正文给出恢复时间时按它回推）
  staffTokens: count, // 本窗口员工发起回合的实测 token
  ownerTokens: count, // 本窗口你发起回合的实测 token
  staffTurns: count, // 本窗口员工发起的回合数
  ownerTurns: count, // 本窗口你发起的回合数
  // 真实额度报错：什么时候报的、恢复时间、恢复时间是否来自报错正文；没有报错为 null
  exhausted: z.strictObject({ at: timestamp, resetAt: timestamp, resetFromText: bool }).nullable(),
  ownerHoldUntil: timestamp.nullable(), // 「我接下来 n 小时要用」到什么时候；没有为 null
  borrowJobIds: z.array(nonempty), // 「用我的额度」放行的事，本窗口有效
  // 被动记录，供校准；最多 QUOTA_ERRORS_MAX 项，正文最多 300 字
  errors: z.array(z.strictObject({
    at: timestamp, // 报错时间
    text: text.refine(value => [...value].length <= QUOTA_ERROR_TEXT_MAX, `报错正文不能超过 ${QUOTA_ERROR_TEXT_MAX} 字`),
    resetAt: timestamp.nullable(), // 正文里解析出的恢复时间；取不到为 null
    pluginTokens: count, // 报错时本窗口内插件记下的实测 token 合计
  }), { error: 'errors：必须是报错记录的数组' }).max(D.QUOTA_ERRORS_MAX, `errors：最多保留 ${D.QUOTA_ERRORS_MAX} 项`),
  updatedAt: timestamp,
});
export type QuotaPlan = z.infer<typeof QuotaPlanSchema>;
