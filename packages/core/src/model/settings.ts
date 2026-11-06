/** 设置的完整校验结构：字段和中文注释对应规格默认表，默认值仅由 config/defaults.ts 注入。 */
import { z } from 'zod';
import { PushChannelSchema } from './enums.js';
import { EngineSettingsSchema } from './engine-settings.js';
import { InteractionSettingsSchema } from './interaction-settings.js';
import { clockTime, count, finite, nonempty, nonnegative, positive, ratio, ModelChoiceSchema } from './primitives.js';

const integer = positive.int('必须是正整数');
const profilePositive = z.strictObject({
  active: positive, // 积极节奏档对应值
  normal: positive, // 正常节奏档对应值
  quiet: positive, // 安静节奏档对应值
});
/** 校验单回合资源上限，避免使用无效的时间或步数预算。 */
export const TurnLimitsSchema = z.strictObject({
  steps: integer, // 回合最多允许的步骤数
  durationMs: positive, // 回合最多运行多少毫秒
  tokens: integer, // 回合最多允许的 token 数
});
export type TurnLimits = z.infer<typeof TurnLimitsSchema>;
const turnLimitsByVariantSchema = z.strictObject({
  regular: TurnLimitsSchema, // 常规回合的限制
  light_check: TurnLimitsSchema, // 轻复查回合的限制
  reflection: TurnLimitsSchema, // 复盘回合的限制
  catch_up: TurnLimitsSchema, // 补课回合的限制
  trial: TurnLimitsSchema, // 试跑回合的限制
  teach: TurnLimitsSchema, // 教学回合的限制
  owner: TurnLimitsSchema, // 主人发起时的对应配置
});

// 仅检查时区名称，不读取当前时间；根目录的 ~ 交由宿主展开后再传给 FsIO。
const timezone = nonempty.refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, '必须是有效的 IANA 时区名称');
/** 校验完整设置及相互约束，默认数值统一由 defaults.ts 提供。 */
export const SettingsSchema = z.strictObject({
  id: z.literal('settings', { error: '设置单例 id 必须为 settings' }), // 固定为 settings 的设置单例标识
  rootDir: nonempty.refine(value => value.startsWith('/') || value.startsWith('~/'), '根目录必须是绝对路径或 ~/ 开头'), // 中心根目录，~ 由宿主展开
  timezone, // 界面与日界线使用的 IANA 时区
  quietHours: z.strictObject({
    start: clockTime, // 免打扰开始的本地时刻
    end: clockTime, // 免打扰结束的本地时刻
  }), // 第 5 节免打扰：本地 HH:mm，起止相同表示关闭。
  digestAt: clockTime, // 第 5 节日报：本地 HH:mm。
  pushChannel: PushChannelSchema, // 单推通道：宿主、系统通知或关闭
  defaultModel: ModelChoiceSchema, // 机器人默认模型；空值跟随宿主默认
  workDataPaths: z.array(nonempty).default([]), // 受工作数据权限保护的目录前缀
  l3Grants: z.array(nonempty).default([]), // 主人明确授予 L3 的动作子类
  c02: EngineSettingsSchema, // 感知、内驱和调度的细分参数
  c03: InteractionSettingsSchema, // 交账、出站和主人交互细分设置
  heartbeatPid: count.nullable(), // 由宿主提供的进程号，core 不读取宿主环境
  hostDownAfterMs: positive, // 距离最后心跳多长时间后判断宿主关闭
  deadmanAlertCooldownMs: positive, // 死人开关告警的冷却时长
  maxBots: integer, // 第 5 节机器人上限，单位：个。
  maxChiefs: integer, // 第 5 节机器人上限：总管最多，单位：个。
  tickMs: positive, // 第 5 节tick 周期，单位：毫秒。
  sleepGapMs: positive, // 第 5 节tick 间隔超过此值记睡眠，单位：毫秒。
  maxConcurrentThinks: integer, // 第 5 节同时思考上限，单位：个。
  ownerActiveConcurrentThinks: integer, // 第 5 节主人活跃时同时思考上限，单位：个。
  ownerAwayAfterMs: positive, // 第 5 节同时思考：主人活动保留窗口，单位：毫秒。
  dispatchMaxPerPump: integer, // 第 5 节放行间隔：单次最多放行，单位：个。
  dispatchGapMs: positive, // 第 5 节放行间隔，单位：毫秒。
  startupQuietMs: nonnegative, // 第 5 节启动静默，单位：毫秒。
  paceMinMsByRole: z.strictObject({
    chief: positive, // 总管角色对应的间隔
    researcher: positive, // 调研角色对应的间隔
    executor: positive, // 执行角色对应的间隔
    sentinel: positive, // 盯守角色对应的间隔
  }), // 第 5 节pace_min 各角色最短间隔，单位：毫秒。
  paceMultiplierByProfile: profilePositive, // 第 5 节pace_min 各节奏档倍率，无单位。
  noChangeBackoffMultiplier: positive, // 第 5 节无变化退避：每次倍率，无单位。
  noChangeBackoffMaxMs: positive, // 第 5 节无变化退避：间隔封顶，单位：毫秒。
  noChangeResetSalience: ratio, // 第 5 节无变化退避：感知复位阈值，单位：比例。
  paceMaxActiveGoalMs: positive, // 第 5 节pace_max：有在进行目标，单位：毫秒。
  paceMaxIdleMs: positive, // 第 5 节pace_max：无在进行目标，单位：毫秒。
  salienceUrgent: ratio, // 第 5 节显著性分档：紧急阈值，单位：比例。
  salienceCandidate: ratio, // 第 5 节显著性分档：候选阈值，单位：比例。
  saliencePile: ratio, // 第 5 节显著性分档：待处理阈值，单位：比例。
  pileSalienceSum: positive, // 第 5 节待处理堆：显著性合计门槛，无单位。
  pileScoreMax: ratio, // 第 5 节待处理堆：分数封顶，单位：比例。
  pileScoreBase: ratio, // 第 5 节待处理堆：基础分，单位：比例。
  pileScorePerExtra: ratio, // 第 5 节待处理堆：每额外一条加分，单位：比例。
  pileBaseCount: count, // 第 5 节待处理堆：基础条数，单位：条。
  thresholdBase: ratio, // 第 5 节门槛：基础值，单位：比例。
  thresholdFatigueWeight: ratio, // 第 5 节门槛：疲劳系数，无单位。
  thresholdOffsetByProfile: z.strictObject({
    active: finite, // 积极节奏档对应值
    normal: finite, // 正常节奏档对应值
    quiet: finite, // 安静节奏档对应值
  }), // 第 5 节门槛：节奏档加减分，无单位。
  dedupWindowMs: positive, // 第 5 节去重与冷却：同指纹去重窗口，单位：毫秒。
  subjectCooldownMs: nonnegative, // 第 5 节去重与冷却：同事项冷却窗口，单位：毫秒。
  fileDebounceMs: nonnegative, // 第 5 节去重与冷却：文件变化去抖，单位：毫秒。
  dailyThinkCapByAutonomy: z.strictObject({
    L0: count, // 只观察等级的每日回合数
    L1: count, // 建议等级的每日回合数
    L2: count, // 执行等级的每日回合数
    L3: count, // 授权执行等级的每日回合数
  }), // 第 5 节每日思考上限：各自主等级，单位：回合。
  botDailyTurnBudget: count, // 第 5 节单机器人预算：每日回合，单位：回合。
  botDailyTokenBudget: count, // 第 5 节单机器人预算：每日 token，单位：token。
  botWindowTurnBudget: count, // 第 5 节单机器人预算：每窗口回合，单位：回合。
  probationBudgetMultiplier: ratio, // 第 5 节单机器人预算：试岗倍率，无单位。
  driveDailyCap: count, // 第 5 节内驱触发：每日最多，单位：次。
  driveSnoozeMs: positive, // 第 5 节内驱触发：默认暂缓时长，单位：毫秒。
  driveSnoozeMaxMs: positive, // 第 5 节内驱触发：最大暂缓时长，单位：毫秒。
  turnLimitsByVariant: turnLimitsByVariantSchema, // 第 5 节思考回合上限：各变体与主人，单位：步、毫秒、token。
  closingGraceMs: positive, // 第 5 节收口：提醒后等待时间，单位：毫秒。
  wakePacketMaxBytes: integer, // 第 5 节唤醒包：最大正文，单位：字节。
  botAgentsMaxBytes: integer, // 第 5 节唤醒包：单个 AGENTS.md 上限，单位：字节。
  globalRulesMaxBytes: integer, // 第 5 节唤醒包：全体守则上限，单位：字节。
  memorySummaryMaxBytes: integer, // 第 5 节唤醒包：记忆摘要上限，单位：字节。
  maxWatchesPerBot: integer, // 第 5 节关注项：每机器人最多，单位：条。
  httpMinIntervalMs: positive, // 第 5 节关注项：http/rss 最短间隔，单位：毫秒。
  httpTimeoutMs: positive, // 第 5 节关注项：http/rss 超时，单位：毫秒。
  httpMaxBytes: integer, // 第 5 节关注项：http/rss 最大读取，单位：字节。
  scriptMinIntervalMs: positive, // 第 5 节关注项：script 最短间隔，单位：毫秒。
  scriptTimeoutMs: positive, // 第 5 节关注项：script 超时，单位：毫秒。
  scriptMaxOutputBytes: integer, // 第 5 节关注项：script 最大输出，单位：字节。
  botWatchExpiryMs: positive, // 第 5 节关注项：机器人自建到期，单位：毫秒。
  maxOpenAgendaPerBot: integer, // 第 5 节议程项：每机器人未完成最多，单位：条。
  agendaMaxFutureMs: positive, // 第 5 节议程项：到期最远，单位：毫秒。
  quotaWindowMs: positive, // 第 5 节额度窗口：时长，单位：毫秒。
  botQuotaShare: ratio, // 第 5 节额度窗口：机器人合计份额，单位：比例。
  initialWindowTurnLimit: integer, // 第 5 节额度窗口：初始回合上限，单位：回合。
  minCalibratedTurnLimit: integer, // 第 5 节额度窗口：校准回合下限，单位：回合。
  quotaCalibrationMultiplier: ratio, // 第 5 节额度窗口：报错点校准倍率，无单位。
  quotaYellowRatio: ratio, // 第 5 节额度灯：黄色起点，单位：比例。
  quotaOrangeRatio: ratio, // 第 5 节额度灯：橙色起点，单位：比例。
  quotaRedRatio: ratio, // 第 5 节额度灯：用尽起点，单位：比例。
  quotaYellowPaceMultiplier: positive, // 第 5 节额度灯：黄色节奏倍率，无单位。
  quotaResetGraceMs: nonnegative, // 第 5 节额度灯：窗口重置后等待，单位：毫秒。
  quotaProbeTurns: integer, // 第 5 节额度灯：恢复探针数量，单位：回合。
  estimatedBytesPerToken: positive, // 第 5 节计量：估计每 token 字节数，单位：字节/token。
  estimatedTokensPerStep: count, // 第 5 节计量：估计每步 token，单位：token/步。
  tokenAccountingMultiplier: positive, // 第 5 节计量：最终记账倍率，无单位。
  dailyPushCap: count, // 第 5 节打扰预算：每日全体单推，单位：条。
  botDailyPushCap: count, // 第 5 节打扰预算：每日单机器人单推，单位：条。
  questionExpiryMs: positive, // 第 5 节过期：提问默认处理时长，单位：毫秒。
  questionReminderMs: positive, // 第 5 节过期：提问日报提醒时长，单位：毫秒。
  approvalExpiryMs: positive, // 第 5 节过期：审批默认拒绝时长，单位：毫秒。
  proposalExpiryMs: positive, // 第 5 节过期：提议撤回时长，单位：毫秒。
  proposalMinValue: ratio, // 第 5 节提议门槛：价值最低值，单位：比例。
  proposalMinConfidence: ratio, // 第 5 节提议门槛：置信度最低值，单位：比例。
  l1WeeklyProposalCap: count, // 第 5 节提议门槛：L1 每周最多，单位：条。
  rejectedProposalCooldownMs: positive, // 第 5 节提议门槛：同标题被拒冷却，单位：毫秒。
  alertConsecutiveCount: integer, // 第 5 节告警：连续出现次数，单位：次。
  alertMergeWindowMs: positive, // 第 5 节告警：同 code 合并窗口，单位：毫秒。
  retryBackoffMs: z.array(positive).min(1, '重排等待至少配置一项'), // 第 5 节错误重排：各次等待，单位：毫秒。
  retryJitterRatio: ratio, // 第 5 节错误重排：随机抖动幅度，单位：比例。
  retryQuarantineCount: integer, // 第 5 节错误重排：失败隔离次数，单位：次。
  errorQuarantineCount: integer, // 第 5 节隔离触发：连续回合错误次数，单位：次。
  violationQuarantineCount: integer, // 第 5 节隔离触发：越界尝试次数，单位：次。
  noCommitReflectionCount: integer, // 第 5 节隔离触发：连续未交账转复盘次数，单位：次。
  usageQuarantineMultiplier: positive, // 第 5 节隔离触发：单日用量预算倍率，无单位。
  sessionMaxAgeMs: positive, // 第 5 节会话轮换：最大会话年龄，单位：毫秒。
  sessionContextRatio: ratio, // 第 5 节会话轮换：最大上下文占比，单位：比例。
  heartbeatMs: positive, // 第 5 节心跳：写入间隔，单位：毫秒。
  deadmanGraceMs: positive, // 第 5 节死人开关：应醒时刻宽限，单位：毫秒。
  turnIdleTimeoutMs: positive, // 第 5 节死人开关：回合无事件超时，单位：毫秒。
  turnHardTimeoutMs: positive, // 第 5 节死人开关：回合总时长超时，单位：毫秒。
  catchUpAfterMs: positive, // 第 5 节补课：停机或睡眠最短时长，单位：毫秒。
  catchUpTurnsPerBot: integer, // 第 5 节补课：每机器人最多回合，单位：回合。
  catchUpDispatchGapMs: positive, // 第 5 节补课：逐个放行间隔，单位：毫秒。
  peerDailyMessagesPerDirection: count, // 第 5 节同伴：每对每方向每日最多消息，单位：条。
  peerMessageMaxBytes: integer, // 第 5 节同伴：单条消息上限，单位：字节。
  handoffWaitingMs: positive, // 第 5 节同伴：未接收等待内驱时长，单位：毫秒。
  handoffWaitingDrive: ratio, // 第 5 节同伴：等待内驱值，单位：比例。
  claimDefaultMs: positive, // 第 5 节认领锁：默认有效时长，单位：毫秒。
  claimMaxMs: positive, // 第 5 节认领锁：最大有效时长，单位：毫秒。
  claimMaxHolders: z.literal(1, { error: '同一资源只能有一个认领者' }), // 第 5 节认领锁：同一资源持有者数量，单位：个。
  probationMs: positive, // 第 5 节试岗：完整时长，单位：毫秒。
  probationEarlyPromotionMs: positive, // 第 5 节试岗：可提前转正时长，单位：毫秒。
  goalImportance: ratio, // 第 5 节第 3 节目标：默认重要度，单位：比例。
  goalPatienceMsByPeriod: z.strictObject({
    day: positive, // 日目标的耐心期
    week: positive, // 周目标的耐心期
    month: positive, // 月目标的耐心期
    one_off: positive, // 一次性目标的耐心期
  }), // 第 5 节第 3 节目标：各周期耐心期，单位：毫秒。
  watchRelevanceByCreator: z.strictObject({
    owner: ratio, // 主人创建关注项的相关度
    bot: ratio, // 机器人自建关注项的相关度
    hub: ratio, // 中心默认关注项的相关度
  }), // 第 5 节第 3 节关注项：各创建者相关度，单位：比例。
  retentionMsByCollection: z.strictObject({
    percepts: positive, // 感知保留时长
    wakes: positive, // 唤醒单保留时长
    commits: positive, // 交账保留时长
    inbox: positive, // 已关闭收件箱项保留时长
    approvals: positive, // 已结束审批保留时长
    outbox: positive, // 已结束出站动作保留时长
    appraisals: positive, // 评估日志保留时长
    ledger: positive, // 用量日志保留时长
    thread: positive, // 对话线程日志保留时长
    audit: positive, // 审计日志保留时长
  }), // 第 5 节第 4 节保留期：按表与日志，单位：毫秒。
  badBackupRetentionMs: positive, // 坏记录备份保留时长（毫秒）；M01 默认 30 天，可覆盖
  logMemoryRetentionMs: positive, // 第 5 节第 4 节日志：内存及启动加载窗口，单位：毫秒。
}).superRefine((value, ctx) => {
  // 配置之间的大小关系先在入口拒绝，避免运行时出现倒置的门槛或时间窗口。
  const check = (ok: boolean, path: string, message: string) => {
    if (!ok) {
      ctx.addIssue({ code: 'custom', path: [path], message });
    }
  };
  check(value.saliencePile <= value.salienceCandidate && value.salienceCandidate <= value.salienceUrgent, 'salienceUrgent', '显著性阈值必须按待处理、候选、紧急递增');
  check(value.quotaYellowRatio < value.quotaOrangeRatio && value.quotaOrangeRatio <= value.quotaRedRatio, 'quotaOrangeRatio', '额度灯阈值必须按黄色、橙色、红色递增');
  check(value.claimDefaultMs <= value.claimMaxMs, 'claimDefaultMs', '默认认领时长不能超过最大时长');
  check(value.driveSnoozeMs <= value.driveSnoozeMaxMs, 'driveSnoozeMs', '默认内驱暂缓不能超过最大时长');
  check(value.probationEarlyPromotionMs <= value.probationMs, 'probationEarlyPromotionMs', '提前转正时长不能超过试岗期');
  check(value.maxChiefs <= value.maxBots, 'maxChiefs', '总管数量不能超过机器人总数');
});
export type Settings = z.infer<typeof SettingsSchema>;
