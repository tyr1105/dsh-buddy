/** 感知、内驱与调度的细分设置：约束集中在这里，具体默认值仍只在 defaults.ts 声明。 */
import { z } from 'zod';
import { count, positive, ratio } from './primitives.js';
const integer = positive.int('必须是正整数');
/** 校验感知、内驱与调度覆盖项，使引擎参数可控且可仿真。 */
export const EngineSettingsSchema = z.strictObject({
  noveltyWindowMs: positive, // 同一关注项的新颖度衰减窗口（毫秒）
  recentUrgencyMs: positive, // 近期事件紧迫度的时间界线（毫秒）
  middleUrgencyMs: positive, // 中期事件紧迫度的时间界线（毫秒）
  repeatedNovelty: ratio, // 窗口内重复关注项的新颖度
  defaultImportance: ratio, // 普通感知的默认重要度
  unmatchedFilterMultiplier: ratio, // 未命中过滤条件时相关度的倍率
  urgencyRecent: ratio, // 近期事件的紧迫度
  urgencyMiddle: ratio, // 中期事件的紧迫度
  urgencyOld: ratio, // 较早事件的紧迫度
  ownerSalience: ratio, // 主人消息的显著性
  replySalience: ratio, // 主人回复或审批决定的显著性
  peerSalienceMax: ratio, // 同伴消息显著性上限
  downtimeSalience: ratio, // 停机感知的显著性
  summaryMaxChars: integer.max(500, '感知摘要不能超过 500 字'), // 感知摘要的字符上限，不能超过 500
  watchValueMaxBytes: integer.max(4096, '关注项快照不能超过 4096 字节'), // 关注快照的 UTF-8 字节上限，不能超过 4 KB
  rssSeenLimit: integer, // 订阅去重时保留的条目标识数量
  httpLineHashLimit: integer.max(200, '网页最多保留 200 行哈希'), // 正文只保留有界哈希基线
  watchBaselineEntryLimit: integer.max(2000, '目录基线最多 2000 项'), // 超限降为数量比较
  watchFilterRegexMaxChars: integer.max(200, '过滤正则最多 200 字符'), // 创建时拒绝超长正则
  watchFilterMaxBytes: integer.max(65536, '过滤文本最多 64 KB'), // 匹配前限制外部正文
  deliveryTimeoutMs: positive, // 投递单未收到 started 的等待上限
  entryTimeoutMs: positive, // 串行入口、tick 与落盘五分钟过期释放
  pollConcurrency: integer.max(3, '轮询并发不能超过 3'), // 同时轮询关注项数量，最多 3
  watchFailureAlertCount: integer, // 连续失败达到多少次后告警
  httpSummaryLines: integer, // 网页变化摘要最多保留几行新增内容
  magnitudeItemCount: integer, // 新增条目数达到此值时变化幅度为 1
  scriptMagnitude: ratio, // 脚本输出变化的幅度
  stagnationBase: ratio, // 目标刚超过耐心期时的停滞内驱
  stagnationStep: ratio, // 每多一个耐心期增加的停滞内驱
  stagnationMax: ratio, // 停滞内驱的上限
  obligationSoonMs: positive, // 承诺临近到期的提前窗口（毫秒）
  obligationSoonScore: ratio, // 承诺临近到期时的内驱值
  obligationOverdueScore: ratio, // 承诺已经逾期时的内驱值
  waitingQuestionScore: ratio, // 主人提问等待过久时的内驱值
  frustrationCount: integer, // 连续受阻多少次触发挫败内驱
  frustrationScore: ratio, // 达到受阻门槛后的挫败内驱
  nextThinkScore: ratio, // 机器人预约下次思考到期的候选分
  lightCheckScore: ratio, // 最久间隔到期轻复查的候选分
  agendaSoonMs: positive, // 议程临近到期的提前窗口（毫秒）
  agendaOwnerDueScore: ratio, // 对主人承诺到期时的候选分
  agendaDueScore: ratio, // 普通议程到期时的候选分
  agendaSoonScore: ratio, // 议程即将到期时的候选分
  suppressionLogMs: positive, // 同一原因被拦截的评估日志合并窗口
  deadmanRetryScore: ratio, // 死人开关触发重试的候选分
  catchUpScore: ratio, // 停机补课的候选分
  salienceWeights: z.strictObject({
    relevance: ratio, // 相关度权重
    novelty: ratio, // 新颖度权重
    magnitude: ratio, // 变化幅度权重
    importance: ratio, // 重要度权重
    urgency: ratio, // 紧迫度权重
    anomaly: ratio, // 异常额外加分
  }), // 显著性公式各因素的权重
  priorities: z.strictObject({
    owner: count, // 主人消息的优先级
    reply: count, // 主人回复或审批结果的优先级
    obligation: count, // 承诺到期的优先级
    anomaly: count, // 异常感知的优先级
    scoreMultiplier: count, // 普通感知按思考分换算优先级的倍率
    drive: count, // 内驱候选的优先级
    nextThink: count, // 下次思考候选的优先级
    catchUp: count, // 补课候选的优先级
    lightCheck: count, // 轻复查候选的优先级
  }), // 调度队列中各类事项的优先级
});
