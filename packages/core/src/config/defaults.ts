/** 全部数值默认值与设置解析：时间统一毫秒，字节按 1024 进位，纯函数不读取系统环境。 */
import { validationMessage } from '../engine/validation.js';
import { SettingsSchema } from '../model/settings.js';
import type { Settings } from '../model/settings.js';
import type { Autonomy, Lifecycle, MbtiType, PaceProfile, Role, Variant } from '../model/enums.js';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KIB = 1024;
/** 纯时间计算的有界缓存容量，不参与业务结果。 */
export const TIME_CACHE_LIMIT = 2048;
/** C04 视图分页和统计窗口；这些显示边界不改变机器人业务预算。 */
export const C04_DEFAULTS = {
  VIEW_WAKE_LIMIT: 50, VIEW_APPRAISAL_LIMIT: 100, VIEW_PAGE_LIMIT: 50,
  VIEW_PAGE_MAX: 200, RECENT_SESSION_LIMIT: 50, STATS_WINDOW_MS: 7 * DAY,
} as const;
/** 仿真采用固定日期和种子；沉降上限只用于识别无限微任务。 */
export const SIM_DEFAULTS = {
  startAt: Date.parse('2026-11-05T10:00:00+08:00'), seed: 1,
  stepTokens: 0, maxSettlePasses: 10000,
} as const;
/** M01：超过软输出预算仍继续读取，累计达到此倍率才终止异常进程。 */
export const EXEC_OUTPUT_HARD_LIMIT_MULTIPLIER = 32;
/** F06：一次交账最多实查这些文件位置，避免执行者塞入无界列表拖住中心。 */
export const F06_DEFAULTS = { ARTIFACT_MAX: 20 } as const;
/** F10 观察历史的硬边界，主人设置可向下收窄，断点不占房间帧额度。 */
export const F10_DEFAULTS = { retentionMs: 7 * DAY, maxFramesPerDay: 2000, maxFrameBytes: 128 * KIB } as const;
/** F09 文本协议有硬边界；实际资源额度可由 Settings 向下收窄。 */
export const F09_DEFAULTS = {
  maxBytes: 64 * KIB, maxLocations: 20, maxVersionsPerBot: 1000, maxHandoffVersions: 5,
  retentionMs: 90 * DAY,
} as const;
/**
 * P38 公共知识库默认配置：纯可选、默认关闭，不预置任何地址或凭据。
 * maxBytes 是单条目实时读取上限（256 KiB），可在设置里于模型上下限内调整。
 */
export const P38_KNOWLEDGE_DEFAULTS = {
  enabled: false, endpoint: '', authRef: '', protocol: '', scope: '', readOnly: true as const,
  maxBytes: 256 * KIB,
};

/**
 * v2 第一期常量（与 docs/plan/v2-transformation.md 3.7 默认值表逐项一致）。
 * 为什么不放进 Settings：SettingsSchema 是 strictObject，加字段会让 v1 解析 v2 设置失败；
 * 这里都是代码常量，不做 UI 配置，等出现真实需要再提升并补测试。
 * 后续期常量先一并列出，第一期只用到账本相关项。
 */
export const V2_DEFAULTS = {
  LEDGER_RETENTION_MS: 90 * DAY, // 账本保留期
  LEDGER_BACKFILL_DAYS: 30, // 旧档回填窗口（天）
  LEDGER_EVIDENCE_MAX: 10, // 证据快照上限
  LEDGER_ACTION_MAX: 30, // 动作流水上限
  LEDGER_ROW_MAX_BYTES: 8 * KIB, // 单行硬上限
  LEDGER_DETAIL_MAX_CHARS: 160, // 单条动作/证据摘要上限
  LEDGER_LIST_DEFAULT_LIMIT: 20, // 列表默认条数
  SANDBOX_REQUIRED: true, // 沙箱不可用则拒绝宿主命令
  OFFICE_RECENT_LEDGER: 200, // 第三期办公室读取上限
  TIMELINE_MAX_FRAMES: 500, // 第五期倒带帧上限
  ORG_MAX_DEPARTMENTS: 8, // 第二期防误操作上限
  ORG_MAX_POSITIONS: 24, // 第二期防误操作上限
  RESOURCE_MAX_ACTIVE: 50, // F17：未归档资料防误操作上限（条）
  RESOURCE_GRANT_MAX: 200, // F17：授权总条数防误操作上限（条）
  RESOURCE_READ_MAX_BYTES: 64 * KIB, // F17：hub_resource_read 单次读取字节上限，超出截断并标明
  RESOURCE_NET_TIMEOUT_MS: 10 * SECOND, // F17：链接类型资料的网络读取超时
  // 第四期 F08 项目容器：均为防误操作上限，不做 UI 配置；取值依据见 docs/questions.md（V2-PH4-01）。
  PROJECT_MAX_ACTIVE: 50, // 未归档项目（active/paused/done）数量上限
  PROJECT_MEMBER_MAX: 20, // 单个项目成员席位上限
  PROJECT_TASK_MAX: 200, // 单个项目任务总数上限（含已通过，任务不物理删除）
  PROJECT_CRITERION_MAX: 20, // 单个项目验收项条数上限
  PROJECT_TASK_ARTIFACT_MAX: 20, // 单个任务关联产物条数上限（防误操作；见 docs/questions.md F08）
  // 第四期 F12 派活：唤醒包「项目任务」段的形状与大小，防止一次唤醒被任务清单撑爆。
  PROJECT_TASKS_PER_PACKET: 5, // 唤醒包最多携带的进行中/受阻任务条数
  PROJECT_TASKS_CRITERIA_MAX: 4, // 每条任务最多展示的项目验收项条数
  PROJECT_TASKS_DETAIL_MAX: 200, // 任务说明进入唤醒包的字数上限
  PROJECT_TASKS_ARTIFACTS_MAX: 3, // 每条任务最多展示的最近产物版本条数
  TASK_WAKE_IDS_MAX: 20, // 单个任务保留的唤醒关联 id 上限（超出丢最早的）
  // P39 项目共享上下文：正文、留痕与唤醒包摘要的边界；都是防撑爆常量，不做 UI 配置。
  PROJECT_CONTEXT_DECISION_MAX: 50, // 单个项目最多保存的已定决策条数
  PROJECT_CONTEXT_GLOSSARY_MAX: 50, // 单个项目术语表条数上限
  PROJECT_CONTEXT_REVISION_MAX: 50, // 留痕最多保留条数（超出丢最早的）
  PROJECT_CONTEXT_EXCERPT_MAX_BYTES: 1536, // 唤醒包摘要硬上限（卡片要求 ≤1.5KB）
  PROJECT_CONTEXT_EXCERPT_PROJECTS_MAX: 2, // 一次唤醒最多带两个项目的上下文
  PROJECT_CONTEXT_BACKGROUND_CHARS: 220, // 摘要里的背景只取一句
  PROJECT_CONTEXT_CONVENTIONS_MAX: 4, // 摘要最多取 4 条约定要点
  PROJECT_CONTEXT_CONVENTIONS_CHARS: 100, // 摘要单条约定字数上限
  PROJECT_CONTEXT_DECISIONS: 3, // 摘要取最近 3 条决策
  PROJECT_CONTEXT_DECISION_CHARS: 100, // 摘要单条决策字数上限
  PROJECT_CONTEXT_GLOSSARY_MAX_HITS: 6, // 摘要最多列 6 条命中的术语
  PROJECT_CONTEXT_GLOSSARY_CHARS: 120, // 摘要单条术语释义字数上限
  // P60/P63 项目主题聊天：标题、消息和唤醒包里楼层的边界；都是防撑爆常量，不做 UI 配置。
  TOPIC_TITLE_MAX_CHARS: 120, // 主题标题取首条消息第一行，最多这么多字
  TOPIC_MESSAGE_MAX_CHARS: 4000, // 主人在主题里一条消息的字数上限；长内容请放项目目录
  TOPIC_PREVIEW_CHARS: 60, // 项目页主题列表里最后一条消息的预览字数
  TOPIC_PACKET_FLOOR_MAX_CHARS: 400, // 唤醒包里单楼的字数上限（最新主人原话不受此限）
  TOPIC_PACKET_FLOORS_MAX_BYTES: 2400, // 唤醒包楼层段的总字节上限（最新主人原话不计入）
  TOPIC_PACKET_CONTEXT_MAX_BYTES: 1500, // 唤醒包里项目背景、成员、事务这一段的硬上限
  TOPIC_PACKET_BACKGROUND_CHARS: 300, // 项目背景进入唤醒包的字数上限
  TOPIC_PACKET_MEMBERS_MAX: 8, // 唤醒包最多列几位成员
  TOPIC_PACKET_BRIEF_CHARS: 40, // 员工说明进入唤醒包的字数上限
  TOPIC_PACKET_SKILLS_MAX: 4, // 每位成员最多列几个技能名
  TOPIC_PACKET_TASKS_MAX: 8, // 唤醒包最多列几条未结束的事务
  // 主题名写进唤醒摘要和队友活动句时最多这么多字；界面按同一长度认出「谁正在回复这个主题」，两边要一致。
  TOPIC_SUMMARY_TITLE_CHARS: 40,
  // P65：主人在「待你处理」里处理了来自主题的事项后，主题里那句旁白引用事项标题和主人回答的字数上限；
  // 完整内容仍在卡片上，旁白只要让读主题的人看懂前因后果。
  TOPIC_FOLLOWUP_TITLE_CHARS: 60,
  TOPIC_FOLLOWUP_ANSWER_CHARS: 200,
} as const;

// C02-MBTI：默认不替旧机器人猜性格；提示段落的字节上限保证唤醒包不被撑大。
export const MBTI_DEFAULTS = {
  DEFAULT_TYPE: null as MbtiType | null,
  PROMPT_MAX_BYTES: 480,
} as const;

/** F14：只增加普通自主行为的保守程度，不降低原门槛；未设置 MBTI 不应用。 */
export const F14_DEFAULTS = {
  introvertWakeOffset: 0.05, introvertProposalOffset: 0.10,
  introvertReportMaxChars: 160, extrovertReportMaxChars: 300,
} as const;

// C03：回合、工具和给主人看的内容边界；单位为毫秒、字节或条数。
export const C03_DEFAULTS = {
  approvalPreviewMaxBytes: KIB, outboxResultMaxBytes: 4 * KIB,
  approvalPreviewEdgeChars: 400,
  approvalOwnerParamsMaxChars: 300, actionCommandMaxChars: 60,
  maxCommandDepth: 4,
  reportPushImportance: 9, reportDigestImportance: 7, outboxDoneSalience: 0.5,
  botDueAgendaCap: 10, handoffExpiryMs: 7 * DAY, stateMaxBytes: 3 * KIB,
  reflectionWeekMinTurns: 3, reflectionHour: 20, reflectionDailyCap: 1,
  blockedChiefAfterMs: DAY, reviewBackoffMultiplier: 2, teachDigestMaxChars: 3000,
  teachDigestMaxBytes: 3 * KIB, digestReportLimit: 3, deferredReportMaxChars: 60, awaitingApprovalCancelMs: 5 * MINUTE,
  packetAgendaKeep: 10, packetEvidenceKeep: 5, packetPerceptChars: 80, packetAspirationChars: 60, reflectionHistoryMs: 7 * DAY, dayMs: DAY, weekMs: 7 * DAY,
  handoffAgendaPriority: 3, reflectCommitImportance: 5, syntheticCommitImportance: 1,
  committedEndGraceMs: 10 * MINUTE,
} as const;

// 第 6 节公式、执行器与任务卡细则；可由 Settings.c02 深度覆盖。
export const C02_DEFAULTS = {
  noveltyWindowMs: HOUR, recentUrgencyMs: 10 * MINUTE, middleUrgencyMs: HOUR,
  repeatedNovelty: 0.5, defaultImportance: 0.3, unmatchedFilterMultiplier: 0.5,
  urgencyRecent: 1, urgencyMiddle: 0.5, urgencyOld: 0.2,
  ownerSalience: 1, replySalience: 0.95, peerSalienceMax: 0.70, downtimeSalience: 0.5,
  summaryMaxChars: 500, watchValueMaxBytes: 4 * KIB, rssSeenLimit: 200,
  httpLineHashLimit: 200, watchBaselineEntryLimit: 2000, watchFilterRegexMaxChars: 200, watchFilterMaxBytes: 64 * KIB,
  deliveryTimeoutMs: 2 * MINUTE, entryTimeoutMs: 5 * MINUTE,
  pollConcurrency: 3, watchFailureAlertCount: 3, httpSummaryLines: 3, magnitudeItemCount: 5, scriptMagnitude: 0.6,
  stagnationBase: 0.65, stagnationStep: 0.10, stagnationMax: 0.90,
  obligationSoonMs: 2 * HOUR, obligationSoonScore: 0.80, obligationOverdueScore: 0.95,
  waitingQuestionScore: 0.75, frustrationCount: 3, frustrationScore: 0.80,
  nextThinkScore: 0.75, lightCheckScore: 0.65,
  agendaSoonMs: HOUR, agendaOwnerDueScore: 0.95, agendaDueScore: 0.85, agendaSoonScore: 0.70,
  suppressionLogMs: 10 * MINUTE, deadmanRetryScore: 0.75, catchUpScore: 0.50,
  salienceWeights: { relevance: 0.25, novelty: 0.20, magnitude: 0.20, importance: 0.20, urgency: 0.15, anomaly: 0.30 },
  priorities: { owner: 100, reply: 90, obligation: 80, anomaly: 70, scoreMultiplier: 60, drive: 50, nextThink: 40, catchUp: 30, lightCheck: 20 },
} as const;

export const DEFAULTS = {
  ROOT_DIR: '~/AgentHub', TIMEZONE: 'Asia/Shanghai',
  QUIET_HOURS: { start: '23:00', end: '08:00' }, DIGEST_AT: '08:30', PUSH_CHANNEL: 'macos',
  // 机器人上限，单位：个。
  MAX_BOTS: 6,
  // 机器人上限：总管最多，单位：个。
  MAX_CHIEFS: 1,
  // tick 周期，单位：毫秒。
  TICK_MS: 60 * SECOND,
  // tick 间隔超过此值记睡眠，单位：毫秒。
  SLEEP_GAP_MS: 10 * MINUTE,
  // 同时思考上限，单位：个。
  MAX_CONCURRENT_THINKS: 2,
  // 主人活跃时同时思考上限，单位：个。
  OWNER_ACTIVE_CONCURRENT_THINKS: 1,
  // 同时思考：主人活动保留窗口，单位：毫秒。
  OWNER_AWAY_AFTER_MS: 10 * MINUTE,
  // 放行间隔：单次最多放行，单位：个。
  DISPATCH_MAX_PER_PUMP: 1,
  // 放行间隔，单位：毫秒。
  DISPATCH_GAP_MS: 90 * SECOND,
  // 启动静默，单位：毫秒。
  STARTUP_QUIET_MS: 3 * MINUTE,
  // pace_min 各角色最短间隔，单位：毫秒。
  PACE_MIN_MS_BY_ROLE: { chief: 30 * MINUTE, researcher: 60 * MINUTE, executor: 30 * MINUTE, sentinel: 20 * MINUTE },
  // pace_min 各节奏档倍率，无单位。
  PACE_MULTIPLIER_BY_PROFILE: { active: 0.5, normal: 1, quiet: 2 },
  // 无变化退避：每次倍率，无单位。
  NO_CHANGE_BACKOFF_MULTIPLIER: 2,
  // 无变化退避：间隔封顶，单位：毫秒。
  NO_CHANGE_BACKOFF_MAX_MS: 24 * HOUR,
  // 无变化退避：感知复位阈值，单位：比例。
  NO_CHANGE_RESET_SALIENCE: 0.70,
  // pace_max：有在进行目标，单位：毫秒。
  PACE_MAX_ACTIVE_GOAL_MS: 48 * HOUR,
  // pace_max：无在进行目标，单位：毫秒。
  PACE_MAX_IDLE_MS: 7 * DAY,
  // 显著性分档：紧急阈值，单位：比例。
  SALIENCE_URGENT: 0.90,
  // 显著性分档：候选阈值，单位：比例。
  SALIENCE_CANDIDATE: 0.70,
  // 显著性分档：待处理阈值，单位：比例。
  SALIENCE_PILE: 0.40,
  // 待处理堆：显著性合计门槛，无单位。
  PILE_SALIENCE_SUM: 1.0,
  // 待处理堆：分数封顶，单位：比例。
  PILE_SCORE_MAX: 0.85,
  // 待处理堆：基础分，单位：比例。
  PILE_SCORE_BASE: 0.70,
  // 待处理堆：每额外一条加分，单位：比例。
  PILE_SCORE_PER_EXTRA: 0.05,
  // 待处理堆：基础条数，单位：条。
  PILE_BASE_COUNT: 2,
  // 门槛：基础值，单位：比例。
  THRESHOLD_BASE: 0.60,
  // 门槛：疲劳系数，无单位。
  THRESHOLD_FATIGUE_WEIGHT: 0.30,
  // 门槛：节奏档加减分，无单位。
  THRESHOLD_OFFSET_BY_PROFILE: { active: -0.10, normal: 0, quiet: 0.10 },
  // 去重与冷却：同指纹去重窗口，单位：毫秒。
  DEDUP_WINDOW_MS: 24 * HOUR,
  // 去重与冷却：同事项冷却窗口，单位：毫秒。
  SUBJECT_COOLDOWN_MS: 6 * HOUR,
  // 去重与冷却：文件变化去抖，单位：毫秒。
  FILE_DEBOUNCE_MS: 2 * MINUTE,
  // 每日思考上限：各自主等级，单位：回合。
  DAILY_THINK_CAP_BY_AUTONOMY: { L0: 2, L1: 6, L2: 10, L3: 12 },
  // 单机器人预算：每日回合，单位：回合。
  BOT_DAILY_TURN_BUDGET: 6,
  // 单机器人预算：每日 token，单位：token。
  BOT_DAILY_TOKEN_BUDGET: 250_000,
  // 单机器人预算：每窗口回合，单位：回合。
  BOT_WINDOW_TURN_BUDGET: 3,
  // 单机器人预算：试岗倍率，无单位。
  PROBATION_BUDGET_MULTIPLIER: 0.5,
  // 内驱触发：每日最多，单位：次。
  DRIVE_DAILY_CAP: 2,
  // 内驱触发：默认暂缓时长，单位：毫秒。
  DRIVE_SNOOZE_MS: 24 * HOUR,
  // 内驱触发：最大暂缓时长，单位：毫秒。
  DRIVE_SNOOZE_MAX_MS: 72 * HOUR,
  // 思考回合上限：各变体与主人，单位：步、毫秒、token。
  TURN_LIMITS_BY_VARIANT: { regular: { steps: 30, durationMs: 20 * MINUTE, tokens: 60_000 }, light_check: { steps: 5, durationMs: 5 * MINUTE, tokens: 15_000 }, reflection: { steps: 20, durationMs: 15 * MINUTE, tokens: 40_000 }, catch_up: { steps: 30, durationMs: 20 * MINUTE, tokens: 60_000 }, trial: { steps: 30, durationMs: 20 * MINUTE, tokens: 60_000 }, teach: { steps: 30, durationMs: 20 * MINUTE, tokens: 60_000 }, owner: { steps: 40, durationMs: 30 * MINUTE, tokens: 80_000 } },
  // 收口：提醒后等待时间，单位：毫秒。
  CLOSING_GRACE_MS: 3 * MINUTE,
  // 唤醒包：最大正文，单位：字节。
  WAKE_PACKET_MAX_BYTES: 6 * KIB,
  // P63 主题聊天：主人每说一句后队友最多连续发言几次，到上限由 owner 收尾；验收时可在设置里调。
  TOPIC_AGENT_TURNS_PER_OWNER_MESSAGE: 8,
  // 唤醒包：单个 AGENTS.md 上限，单位：字节。
  BOT_AGENTS_MAX_BYTES: 8 * KIB,
  // 唤醒包：全体守则上限，单位：字节。
  GLOBAL_RULES_MAX_BYTES: 3 * KIB,
  // 唤醒包：记忆摘要上限，单位：字节。
  MEMORY_SUMMARY_MAX_BYTES: 1.5 * KIB,
  // 关注项：每机器人最多，单位：条。
  MAX_WATCHES_PER_BOT: 20,
  // 关注项：http/rss 最短间隔，单位：毫秒。
  HTTP_MIN_INTERVAL_MS: 15 * MINUTE,
  // 关注项：http/rss 超时，单位：毫秒。
  HTTP_TIMEOUT_MS: 20 * SECOND,
  // 关注项：http/rss 最大读取，单位：字节。
  HTTP_MAX_BYTES: 512 * KIB,
  // 关注项：script 最短间隔，单位：毫秒。
  SCRIPT_MIN_INTERVAL_MS: 5 * MINUTE,
  // 关注项：script 超时，单位：毫秒。
  SCRIPT_TIMEOUT_MS: 30 * SECOND,
  // 关注项：script 最大输出，单位：字节。
  SCRIPT_MAX_OUTPUT_BYTES: 64 * KIB,
  // 关注项：机器人自建到期，单位：毫秒。
  BOT_WATCH_EXPIRY_MS: 30 * DAY,
  // 议程项：每机器人未完成最多，单位：条。
  MAX_OPEN_AGENDA_PER_BOT: 30,
  // 议程项：到期最远，单位：毫秒。
  AGENDA_MAX_FUTURE_MS: 30 * DAY,
  // 额度窗口：时长，单位：毫秒。
  QUOTA_WINDOW_MS: 5 * HOUR,
  // 额度窗口：机器人合计份额，单位：比例。
  BOT_QUOTA_SHARE: 0.70,
  // 额度窗口：初始回合上限，单位：回合。
  INITIAL_WINDOW_TURN_LIMIT: 8,
  // 额度窗口：校准回合下限，单位：回合。
  MIN_CALIBRATED_TURN_LIMIT: 2,
  // 额度窗口：报错点校准倍率，无单位。
  QUOTA_CALIBRATION_MULTIPLIER: 0.9,
  // 额度灯：黄色起点，单位：比例。
  QUOTA_YELLOW_RATIO: 0.5,
  // 额度灯：橙色起点，单位：比例。
  QUOTA_ORANGE_RATIO: 0.8,
  // 额度灯：用尽起点，单位：比例。
  QUOTA_RED_RATIO: 1,
  // 额度灯：黄色节奏倍率，无单位。
  QUOTA_YELLOW_PACE_MULTIPLIER: 2,
  // 额度灯：窗口重置后等待，单位：毫秒。
  QUOTA_RESET_GRACE_MS: 5 * MINUTE,
  // 额度灯：恢复探针数量，单位：回合。
  QUOTA_PROBE_TURNS: 1,
  // 计量：估计每 token 字节数，单位：字节/token。
  ESTIMATED_BYTES_PER_TOKEN: 3,
  // 计量：估计每步 token，单位：token/步。
  ESTIMATED_TOKENS_PER_STEP: 2000,
  // 计量：最终记账倍率，无单位。
  TOKEN_ACCOUNTING_MULTIPLIER: 1.2,
  // 打扰预算：每日全体单推，单位：条。
  DAILY_PUSH_CAP: 3,
  // 打扰预算：每日单机器人单推，单位：条。
  BOT_DAILY_PUSH_CAP: 2,
  // 过期：提问默认处理时长，单位：毫秒。
  QUESTION_EXPIRY_MS: 72 * HOUR,
  // 过期：提问日报提醒时长，单位：毫秒。
  QUESTION_REMINDER_MS: 24 * HOUR,
  // 过期：审批默认拒绝时长，单位：毫秒。
  APPROVAL_EXPIRY_MS: 24 * HOUR,
  // 过期：提议撤回时长，单位：毫秒。
  PROPOSAL_EXPIRY_MS: 7 * DAY,
  // 提议门槛：价值最低值，单位：比例。
  PROPOSAL_MIN_VALUE: 0.6,
  // 提议门槛：置信度最低值，单位：比例。
  PROPOSAL_MIN_CONFIDENCE: 0.5,
  // 提议门槛：L1 每周最多，单位：条。
  L1_WEEKLY_PROPOSAL_CAP: 3,
  // 提议门槛：同标题被拒冷却，单位：毫秒。
  REJECTED_PROPOSAL_COOLDOWN_MS: 30 * DAY,
  // 告警：连续出现次数，单位：次。
  ALERT_CONSECUTIVE_COUNT: 2,
  // 告警：同 code 合并窗口，单位：毫秒。
  ALERT_MERGE_WINDOW_MS: HOUR,
  // 错误重排：各次等待，单位：毫秒。
  RETRY_BACKOFF_MS: [2 * MINUTE, 10 * MINUTE, 30 * MINUTE, 2 * HOUR],
  // 错误重排：随机抖动幅度，单位：比例。
  RETRY_JITTER_RATIO: 0.2,
  // 错误重排：失败隔离次数，单位：次。
  RETRY_QUARANTINE_COUNT: 4,
  // 隔离触发：连续回合错误次数，单位：次。
  ERROR_QUARANTINE_COUNT: 3,
  // 隔离触发：越界尝试次数，单位：次。
  VIOLATION_QUARANTINE_COUNT: 3,
  // 隔离触发：连续未交账转复盘次数，单位：次。
  NO_COMMIT_REFLECTION_COUNT: 2,
  // 隔离触发：单日用量预算倍率，无单位。
  USAGE_QUARANTINE_MULTIPLIER: 3,
  // 会话轮换：最大会话年龄，单位：毫秒。
  SESSION_MAX_AGE_MS: 7 * DAY,
  // 会话轮换：最大上下文占比，单位：比例。
  SESSION_CONTEXT_RATIO: 0.5,
  // 心跳：写入间隔，单位：毫秒。
  HEARTBEAT_MS: 30 * SECOND,
  // 死人开关：应醒时刻宽限，单位：毫秒。
  DEADMAN_GRACE_MS: 30 * MINUTE,
  // 死人开关：回合无事件超时，单位：毫秒。
  TURN_IDLE_TIMEOUT_MS: 10 * MINUTE,
  // 死人开关：回合总时长超时，单位：毫秒。
  TURN_HARD_TIMEOUT_MS: 30 * MINUTE,
  // 补课：停机或睡眠最短时长，单位：毫秒。
  CATCH_UP_AFTER_MS: 30 * MINUTE,
  // 补课：每机器人最多回合，单位：回合。
  CATCH_UP_TURNS_PER_BOT: 1,
  // 补课：逐个放行间隔，单位：毫秒。
  CATCH_UP_DISPATCH_GAP_MS: 90 * SECOND,
  // 同伴：每对每方向每日最多消息，单位：条。
  PEER_DAILY_MESSAGES_PER_DIRECTION: 4,
  // 同伴：单条消息上限，单位：字节。
  PEER_MESSAGE_MAX_BYTES: 4 * KIB,
  // 同伴：未接收等待内驱时长，单位：毫秒。
  HANDOFF_WAITING_MS: 2 * HOUR,
  // 同伴：等待内驱值，单位：比例。
  HANDOFF_WAITING_DRIVE: 0.7,
  // 认领锁：默认有效时长，单位：毫秒。
  CLAIM_DEFAULT_MS: 2 * HOUR,
  // 认领锁：最大有效时长，单位：毫秒。
  CLAIM_MAX_MS: 24 * HOUR,
  // 认领锁：同一资源持有者数量，单位：个。
  CLAIM_MAX_HOLDERS: 1,
  // 试岗：完整时长，单位：毫秒。
  PROBATION_MS: 7 * DAY,
  // 试岗：可提前转正时长，单位：毫秒。
  PROBATION_EARLY_PROMOTION_MS: 3 * DAY,
  // 第 3 节目标：默认重要度，单位：比例。
  GOAL_IMPORTANCE: 0.6,
  // 第 3 节目标：各周期耐心期，单位：毫秒。
  GOAL_PATIENCE_MS_BY_PERIOD: { day: 12 * HOUR, week: 48 * HOUR, month: 5 * DAY, one_off: 72 * HOUR },
  // 第 3 节关注项：各创建者相关度，单位：比例。
  WATCH_RELEVANCE_BY_CREATOR: { owner: 0.8, bot: 0.6, hub: 0.5 },
  // 第 4 节保留期：按表与日志，单位：毫秒。
  RETENTION_MS_BY_COLLECTION: {
    artifactVersions: F09_DEFAULTS.retentionMs, artifactReviews: F09_DEFAULTS.retentionMs,
    artifactBatches: F09_DEFAULTS.retentionMs,
    officeFrames: F10_DEFAULTS.retentionMs,
    percepts: 14 * DAY, wakes: 30 * DAY, commits: 30 * DAY, inbox: 30 * DAY, approvals: 30 * DAY,
    outbox: 30 * DAY, appraisals: 14 * DAY, ledger: 30 * DAY, thread: 180 * DAY, audit: 90 * DAY,
  },
  // 第 4 节日志：内存及启动加载窗口，单位：毫秒。
  LOG_MEMORY_RETENTION_MS: 14 * DAY,
  // M01：损坏原件备份保留 30 天，既保留排查证据也避免无限占盘。
  BAD_BACKUP_RETENTION_MS: 30 * DAY,
  HEARTBEAT_PID: null, HOST_DOWN_AFTER_MS: 2 * MINUTE, DEADMAN_ALERT_COOLDOWN_MS: 6 * HOUR,
} as const;

// 完整默认设置由唯一默认表派生；深合并会复制结构，不允许一次调用污染下次调用。
const defaultSettings = {
  id: 'settings', rootDir: DEFAULTS.ROOT_DIR, timezone: DEFAULTS.TIMEZONE,
  quietHours: DEFAULTS.QUIET_HOURS, digestAt: DEFAULTS.DIGEST_AT,
  pushChannel: DEFAULTS.PUSH_CHANNEL, defaultModel: null, workDataPaths: [], l3Grants: [],
  c02: C02_DEFAULTS, c03: C03_DEFAULTS, heartbeatPid: DEFAULTS.HEARTBEAT_PID,
  artifacts: { maxBytes: F09_DEFAULTS.maxBytes, maxLocations: F09_DEFAULTS.maxLocations,
    maxVersionsPerBot: F09_DEFAULTS.maxVersionsPerBot, maxHandoffVersions: F09_DEFAULTS.maxHandoffVersions },
  officeReplay: { maxFramesPerDay: F10_DEFAULTS.maxFramesPerDay, maxFrameBytes: F10_DEFAULTS.maxFrameBytes },
  knowledgeBase: { ...P38_KNOWLEDGE_DEFAULTS },
  personality: F14_DEFAULTS,
  hostDownAfterMs: DEFAULTS.HOST_DOWN_AFTER_MS, deadmanAlertCooldownMs: DEFAULTS.DEADMAN_ALERT_COOLDOWN_MS,
  maxBots: DEFAULTS.MAX_BOTS,   maxChiefs: DEFAULTS.MAX_CHIEFS,   tickMs: DEFAULTS.TICK_MS,
  sleepGapMs: DEFAULTS.SLEEP_GAP_MS,   maxConcurrentThinks: DEFAULTS.MAX_CONCURRENT_THINKS,   ownerActiveConcurrentThinks: DEFAULTS.OWNER_ACTIVE_CONCURRENT_THINKS,
  ownerAwayAfterMs: DEFAULTS.OWNER_AWAY_AFTER_MS,   dispatchMaxPerPump: DEFAULTS.DISPATCH_MAX_PER_PUMP,   dispatchGapMs: DEFAULTS.DISPATCH_GAP_MS,
  startupQuietMs: DEFAULTS.STARTUP_QUIET_MS,   paceMinMsByRole: DEFAULTS.PACE_MIN_MS_BY_ROLE,   paceMultiplierByProfile: DEFAULTS.PACE_MULTIPLIER_BY_PROFILE,
  noChangeBackoffMultiplier: DEFAULTS.NO_CHANGE_BACKOFF_MULTIPLIER,   noChangeBackoffMaxMs: DEFAULTS.NO_CHANGE_BACKOFF_MAX_MS,   noChangeResetSalience: DEFAULTS.NO_CHANGE_RESET_SALIENCE,
  paceMaxActiveGoalMs: DEFAULTS.PACE_MAX_ACTIVE_GOAL_MS,   paceMaxIdleMs: DEFAULTS.PACE_MAX_IDLE_MS,   salienceUrgent: DEFAULTS.SALIENCE_URGENT,
  salienceCandidate: DEFAULTS.SALIENCE_CANDIDATE,   saliencePile: DEFAULTS.SALIENCE_PILE,   pileSalienceSum: DEFAULTS.PILE_SALIENCE_SUM,
  pileScoreMax: DEFAULTS.PILE_SCORE_MAX,   pileScoreBase: DEFAULTS.PILE_SCORE_BASE,   pileScorePerExtra: DEFAULTS.PILE_SCORE_PER_EXTRA,
  pileBaseCount: DEFAULTS.PILE_BASE_COUNT,   thresholdBase: DEFAULTS.THRESHOLD_BASE,   thresholdFatigueWeight: DEFAULTS.THRESHOLD_FATIGUE_WEIGHT,
  thresholdOffsetByProfile: DEFAULTS.THRESHOLD_OFFSET_BY_PROFILE,   dedupWindowMs: DEFAULTS.DEDUP_WINDOW_MS,   subjectCooldownMs: DEFAULTS.SUBJECT_COOLDOWN_MS,
  fileDebounceMs: DEFAULTS.FILE_DEBOUNCE_MS,   dailyThinkCapByAutonomy: DEFAULTS.DAILY_THINK_CAP_BY_AUTONOMY,   botDailyTurnBudget: DEFAULTS.BOT_DAILY_TURN_BUDGET,
  botDailyTokenBudget: DEFAULTS.BOT_DAILY_TOKEN_BUDGET,   botWindowTurnBudget: DEFAULTS.BOT_WINDOW_TURN_BUDGET,   probationBudgetMultiplier: DEFAULTS.PROBATION_BUDGET_MULTIPLIER,
  driveDailyCap: DEFAULTS.DRIVE_DAILY_CAP,   driveSnoozeMs: DEFAULTS.DRIVE_SNOOZE_MS,   driveSnoozeMaxMs: DEFAULTS.DRIVE_SNOOZE_MAX_MS,
  turnLimitsByVariant: DEFAULTS.TURN_LIMITS_BY_VARIANT,   closingGraceMs: DEFAULTS.CLOSING_GRACE_MS,   wakePacketMaxBytes: DEFAULTS.WAKE_PACKET_MAX_BYTES,
  topicAgentTurnsPerOwnerMessage: DEFAULTS.TOPIC_AGENT_TURNS_PER_OWNER_MESSAGE,
  botAgentsMaxBytes: DEFAULTS.BOT_AGENTS_MAX_BYTES,   globalRulesMaxBytes: DEFAULTS.GLOBAL_RULES_MAX_BYTES,   memorySummaryMaxBytes: DEFAULTS.MEMORY_SUMMARY_MAX_BYTES,
  maxWatchesPerBot: DEFAULTS.MAX_WATCHES_PER_BOT,   httpMinIntervalMs: DEFAULTS.HTTP_MIN_INTERVAL_MS,   httpTimeoutMs: DEFAULTS.HTTP_TIMEOUT_MS,
  httpMaxBytes: DEFAULTS.HTTP_MAX_BYTES,   scriptMinIntervalMs: DEFAULTS.SCRIPT_MIN_INTERVAL_MS,   scriptTimeoutMs: DEFAULTS.SCRIPT_TIMEOUT_MS,
  scriptMaxOutputBytes: DEFAULTS.SCRIPT_MAX_OUTPUT_BYTES,   botWatchExpiryMs: DEFAULTS.BOT_WATCH_EXPIRY_MS,   maxOpenAgendaPerBot: DEFAULTS.MAX_OPEN_AGENDA_PER_BOT,
  agendaMaxFutureMs: DEFAULTS.AGENDA_MAX_FUTURE_MS,   quotaWindowMs: DEFAULTS.QUOTA_WINDOW_MS,   botQuotaShare: DEFAULTS.BOT_QUOTA_SHARE,
  initialWindowTurnLimit: DEFAULTS.INITIAL_WINDOW_TURN_LIMIT,   minCalibratedTurnLimit: DEFAULTS.MIN_CALIBRATED_TURN_LIMIT,   quotaCalibrationMultiplier: DEFAULTS.QUOTA_CALIBRATION_MULTIPLIER,
  quotaYellowRatio: DEFAULTS.QUOTA_YELLOW_RATIO,   quotaOrangeRatio: DEFAULTS.QUOTA_ORANGE_RATIO,   quotaRedRatio: DEFAULTS.QUOTA_RED_RATIO,
  quotaYellowPaceMultiplier: DEFAULTS.QUOTA_YELLOW_PACE_MULTIPLIER,   quotaResetGraceMs: DEFAULTS.QUOTA_RESET_GRACE_MS,   quotaProbeTurns: DEFAULTS.QUOTA_PROBE_TURNS,
  estimatedBytesPerToken: DEFAULTS.ESTIMATED_BYTES_PER_TOKEN,   estimatedTokensPerStep: DEFAULTS.ESTIMATED_TOKENS_PER_STEP,   tokenAccountingMultiplier: DEFAULTS.TOKEN_ACCOUNTING_MULTIPLIER,
  dailyPushCap: DEFAULTS.DAILY_PUSH_CAP,   botDailyPushCap: DEFAULTS.BOT_DAILY_PUSH_CAP,   questionExpiryMs: DEFAULTS.QUESTION_EXPIRY_MS,
  questionReminderMs: DEFAULTS.QUESTION_REMINDER_MS,   approvalExpiryMs: DEFAULTS.APPROVAL_EXPIRY_MS,   proposalExpiryMs: DEFAULTS.PROPOSAL_EXPIRY_MS,
  proposalMinValue: DEFAULTS.PROPOSAL_MIN_VALUE,   proposalMinConfidence: DEFAULTS.PROPOSAL_MIN_CONFIDENCE,   l1WeeklyProposalCap: DEFAULTS.L1_WEEKLY_PROPOSAL_CAP,
  rejectedProposalCooldownMs: DEFAULTS.REJECTED_PROPOSAL_COOLDOWN_MS,   alertConsecutiveCount: DEFAULTS.ALERT_CONSECUTIVE_COUNT,   alertMergeWindowMs: DEFAULTS.ALERT_MERGE_WINDOW_MS,
  retryBackoffMs: DEFAULTS.RETRY_BACKOFF_MS,   retryJitterRatio: DEFAULTS.RETRY_JITTER_RATIO,   retryQuarantineCount: DEFAULTS.RETRY_QUARANTINE_COUNT,
  errorQuarantineCount: DEFAULTS.ERROR_QUARANTINE_COUNT,   violationQuarantineCount: DEFAULTS.VIOLATION_QUARANTINE_COUNT,   noCommitReflectionCount: DEFAULTS.NO_COMMIT_REFLECTION_COUNT,
  usageQuarantineMultiplier: DEFAULTS.USAGE_QUARANTINE_MULTIPLIER,   sessionMaxAgeMs: DEFAULTS.SESSION_MAX_AGE_MS,   sessionContextRatio: DEFAULTS.SESSION_CONTEXT_RATIO,
  heartbeatMs: DEFAULTS.HEARTBEAT_MS,   deadmanGraceMs: DEFAULTS.DEADMAN_GRACE_MS,   turnIdleTimeoutMs: DEFAULTS.TURN_IDLE_TIMEOUT_MS,
  turnHardTimeoutMs: DEFAULTS.TURN_HARD_TIMEOUT_MS,   catchUpAfterMs: DEFAULTS.CATCH_UP_AFTER_MS,   catchUpTurnsPerBot: DEFAULTS.CATCH_UP_TURNS_PER_BOT,
  catchUpDispatchGapMs: DEFAULTS.CATCH_UP_DISPATCH_GAP_MS,   peerDailyMessagesPerDirection: DEFAULTS.PEER_DAILY_MESSAGES_PER_DIRECTION,   peerMessageMaxBytes: DEFAULTS.PEER_MESSAGE_MAX_BYTES,
  handoffWaitingMs: DEFAULTS.HANDOFF_WAITING_MS,   handoffWaitingDrive: DEFAULTS.HANDOFF_WAITING_DRIVE,   claimDefaultMs: DEFAULTS.CLAIM_DEFAULT_MS,
  claimMaxMs: DEFAULTS.CLAIM_MAX_MS,   claimMaxHolders: DEFAULTS.CLAIM_MAX_HOLDERS,   probationMs: DEFAULTS.PROBATION_MS,
  probationEarlyPromotionMs: DEFAULTS.PROBATION_EARLY_PROMOTION_MS,   goalImportance: DEFAULTS.GOAL_IMPORTANCE,   goalPatienceMsByPeriod: DEFAULTS.GOAL_PATIENCE_MS_BY_PERIOD,
  watchRelevanceByCreator: DEFAULTS.WATCH_RELEVANCE_BY_CREATOR,   retentionMsByCollection: DEFAULTS.RETENTION_MS_BY_COLLECTION,   logMemoryRetentionMs: DEFAULTS.LOG_MEMORY_RETENTION_MS,
  badBackupRetentionMs: DEFAULTS.BAD_BACKUP_RETENTION_MS,
};

/** 只允许普通设置对象，避免数组或特殊对象参与深合并。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// 数组整体替换，对象逐层合并；禁止原型相关键，防止设置输入改变普通对象的行为。
function merge(base: unknown, override: unknown): unknown {
  if (override === undefined) return structuredClone(base);
  if (!isObject(base) || !isObject(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`设置字段 ${key} 不允许使用`);
    result[key] = merge(base[key], value);
  }
  return result;
}

/** 启动时逐层覆盖：默认值 < 存储设置 < 宿主明确传入值；嵌套设置也保留未覆盖字段。 */
export function resolveStartupSettings(persisted: unknown, host: unknown): Settings {
  return resolveSettings(merge(persisted ?? {}, host ?? {}));
}

/** 合并默认值并校验最终设置，统一返回可定位字段的中文错误。 */
export function resolveSettings(partial?: unknown): Settings {
  if (partial !== undefined && !isObject(partial)) throw new Error('设置必须是对象');
  const result = SettingsSchema.safeParse(merge(defaultSettings, partial));
  if (!result.success) {
    const messages = result.error.issues.map(issue => {
      const path = issue.path.join('.') || '设置';
      // Zod 的容器和未知键默认文案为英文；在此入口局部翻译，不改变宿主全局语言。
      if (issue.code === 'unrecognized_keys') return `${path}：不支持字段 ${issue.keys.join('、')}`;
      if (issue.code === 'invalid_type') {
        const expected = { string: '文字', number: '有限数字', boolean: '布尔值', array: '数组', object: '对象' };
        return `${path}：必须是${expected[issue.expected as keyof typeof expected] ?? '正确类型的值'}`;
      }
      if (issue.code === 'invalid_value') return `${path}：必须是允许的值（${issue.values.join('、')}）`;
      return `${path}：${validationMessage(issue)}`;
    });
    throw new Error(`设置无效：${messages.join('；')}`);
  }
  return result.data;
}

// 最短间隔只计算角色与节奏档；无变化退避和额度灯由后续调度模块按状态叠加。
export function paceMinMsFor(role: Role, paceProfile: PaceProfile, settings: Settings): number {
  // P55：建议风格沿用调研的最短间隔，所以旧的设置文件不需要补新键。
  return settings.paceMinMsByRole[role === 'advisor' ? 'researcher' : role] * settings.paceMultiplierByProfile[paceProfile];
}
/** 按是否存在目标选择最长沉默期，保证机器人不会无限休眠。 */
export function paceMaxMsFor(hasActiveGoal: boolean, settings: Settings): number {
  return hasActiveGoal ? settings.paceMaxActiveGoalMs : settings.paceMaxIdleMs;
}
/** 读取每日自主思考上限，试岗始终按 L1 控制。 */
export function dailyThinkCapFor(autonomy: Autonomy, lifecycle: Lifecycle, settings: Settings): number {
  return settings.dailyThinkCapByAutonomy[lifecycle === 'probation' ? 'L1' : autonomy];
}
// 试岗所有预算减半；回合数向下取整，宁少放行，不产生半个回合。
export function botBudgetFor(lifecycle: Lifecycle, settings: Settings) {
  const multiplier = lifecycle === 'probation' ? settings.probationBudgetMultiplier : 1;
  return {
    dailyTurns: Math.floor(settings.botDailyTurnBudget * multiplier),
    dailyTokens: Math.floor(settings.botDailyTokenBudget * multiplier),
    windowTurns: Math.floor(settings.botWindowTurnBudget * multiplier),
  };
}
/** 返回指定回合的独立上限副本，防止调用方修改全局设置。 */
export function turnLimitsFor(variant: Variant | 'owner', settings: Settings) {
  return { ...settings.turnLimitsByVariant[variant] };
}
/** 按疲劳和节奏计算思考门槛，拒绝越界疲劳值以免误放行。 */
export function thresholdFor(fatigue: number, paceProfile: PaceProfile, settings: Settings): number {
  if (!Number.isFinite(fatigue) || fatigue < 0 || fatigue > 1) throw new Error('疲劳必须是 0 到 1 之间的数字');
  return settings.thresholdBase + settings.thresholdFatigueWeight * fatigue + settings.thresholdOffsetByProfile[paceProfile];
}
