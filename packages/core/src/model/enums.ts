/** 领域枚举集中声明：界面直接使用中文标签，校验与类型共用同一组值，避免不同模块各说各话。 */
import { z } from 'zod';

// 机器人在团队中的职责分工，决定默认节奏及总管协作能力。
export const ROLES = ['chief', 'researcher', 'executor', 'sentinel'] as const;
export const RoleSchema = z.enum(ROLES, { error: '请选择有效的Role值' });
export type Role = z.infer<typeof RoleSchema>;
export const ROLE_LABELS: Record<Role, string> = { 'chief': '总管', 'researcher': '调研', 'executor': '执行', 'sentinel': '盯守' };

// 办公室座位灯：只表达「这个队友此刻在跑、在等、在休息或不知道」，不参与任何调度判断。
export const OFFICE_LIGHTS = ['working', 'queued', 'waiting', 'blocked', 'resting', 'watching', 'offline', 'vacant', 'unknown'] as const;
export const OfficeLightSchema = z.enum(OFFICE_LIGHTS, { error: '请选择有效的办公室灯值' });
export type OfficeLight = z.infer<typeof OfficeLightSchema>;
export const OFFICE_LIGHT_LABELS: Record<OfficeLight, string> = {
  'working': '正在跑', 'queued': '排队等放行', 'waiting': '在等人', 'blocked': '受阻',
  'resting': '休息或复盘', 'watching': '盯着', 'offline': '不在岗', 'vacant': '空位', 'unknown': '未知',
};

// 主人授予的自主等级，动作闸用它判断允许、提议或审批。
export const AUTONOMIES = ['L0', 'L1', 'L2', 'L3'] as const;
export const AutonomySchema = z.enum(AUTONOMIES, { error: '请选择有效的Autonomy值' });
export type Autonomy = z.infer<typeof AutonomySchema>;
export const AUTONOMY_LABELS: Record<Autonomy, string> = { 'L0': '只观察', 'L1': '建议', 'L2': '执行', 'L3': '授权执行' };

// 机器人从草稿到退役的生命周期，决定能否参与调度。
export const LIFECYCLES = ['draft', 'probation', 'active', 'paused', 'quarantined', 'retired'] as const;
export const LifecycleSchema = z.enum(LIFECYCLES, { error: '请选择有效的Lifecycle值' });
export type Lifecycle = z.infer<typeof LifecycleSchema>;
export const LIFECYCLE_LABELS: Record<Lifecycle, string> = { 'draft': '草稿', 'probation': '试岗', 'active': '在岗', 'paused': '暂停', 'quarantined': '隔离', 'retired': '退役' };

// 在岗口径：试岗与正式在岗都算在队里，能接活、能读普通资料。取消编制后仍是派活与资料判定的唯一口径。
export const ON_TEAM_LIFECYCLES = ['probation', 'active'] as const;

// 机器人当前在做什么，用于线程状态和总览的即时展示。
export const ACTIVITIES = ['watching', 'queued', 'thinking', 'waiting_owner', 'waiting_peer', 'blocked', 'resting', 'reflecting', 'catching_up'] as const;
export const ActivitySchema = z.enum(ACTIVITIES, { error: '请选择有效的Activity值' });
export type Activity = z.infer<typeof ActivitySchema>;
export const ACTIVITY_LABELS: Record<Activity, string> = { 'watching': '盯着', 'queued': '排队', 'thinking': '思考', 'waiting_owner': '等主人', 'waiting_peer': '等同伴', 'blocked': '受阻', 'resting': '休息', 'reflecting': '复盘', 'catching_up': '补课' };

// 主人选择的工作节奏档，同时影响最短间隔和唤醒门槛。
export const PACE_PROFILES = ['active', 'normal', 'quiet'] as const;
export const PaceProfileSchema = z.enum(PACE_PROFILES, { error: '请选择有效的PaceProfile值' });
export type PaceProfile = z.infer<typeof PaceProfileSchema>;
export const PACE_PROFILE_LABELS: Record<PaceProfile, string> = { 'active': '积极', 'normal': '正常', 'quiet': '安静' };

// 队友的 MBTI 性格类型：只影响表达与做事倾向，不参与权限、审批、额度或唤醒门槛。
export const MBTI_TYPES = ['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP'] as const;
export const MbtiTypeSchema = z.enum(MBTI_TYPES, { error: '请选择有效的 MBTI 类型' });
export type MbtiType = z.infer<typeof MbtiTypeSchema>;
export const MBTI_TYPE_LABELS: Record<MbtiType, string> = {
  'INTJ': '建筑师', 'INTP': '逻辑学家', 'ENTJ': '指挥官', 'ENTP': '辩论家',
  'INFJ': '提倡者', 'INFP': '调停者', 'ENFJ': '主人公', 'ENFP': '竞选者',
  'ISTJ': '物流师', 'ISFJ': '守卫者', 'ESTJ': '总经理', 'ESFJ': '执政官',
  'ISTP': '鉴赏家', 'ISFP': '探险家', 'ESTP': '企业家', 'ESFP': '表演者',
};

// 本次值得叫醒机器人的具体理由，供调度、日志和唤醒包追溯。
export const WAKE_KINDS = ['percept', 'pile', 'agenda_due', 'drive', 'owner_message', 'peer_message', 'inbox_reply', 'approval_decided', 'next_think', 'light_check', 'reflection', 'catch_up', 'trial', 'teach', 'retry'] as const;
export const WakeKindSchema = z.enum(WAKE_KINDS, { error: '请选择有效的WakeKind值' });
export type WakeKind = z.infer<typeof WakeKindSchema>;
export const WAKE_KIND_LABELS: Record<WakeKind, string> = { 'percept': '感知', 'pile': '待处理堆', 'agenda_due': '议程到期', 'drive': '内驱', 'owner_message': '主人消息', 'peer_message': '同伴消息', 'inbox_reply': '收件箱回复', 'approval_decided': '审批结果', 'next_think': '下次思考', 'light_check': '轻复查', 'reflection': '复盘', 'catch_up': '补课', 'trial': '试跑', 'teach': '教学', 'retry': '重试' };

// 思考回合的工作模式，决定资源上限及允许执行的操作。
export const VARIANTS = ['regular', 'light_check', 'reflection', 'catch_up', 'trial', 'teach'] as const;
export const VariantSchema = z.enum(VARIANTS, { error: '请选择有效的Variant值' });
export type Variant = z.infer<typeof VariantSchema>;
export const VARIANT_LABELS: Record<Variant, string> = { 'regular': '常规', 'light_check': '轻复查', 'reflection': '复盘', 'catch_up': '补课', 'trial': '试跑', 'teach': '教学' };

// 机器人交账时声明的结果，驱动退避、进展和主人交互。
export const OUTCOMES = ['no_change', 'progress', 'done', 'blocked', 'needs_owner'] as const;
export const OutcomeSchema = z.enum(OUTCOMES, { error: '请选择有效的Outcome值' });
export type Outcome = z.infer<typeof OutcomeSchema>;
export const OUTCOME_LABELS: Record<Outcome, string> = { 'no_change': '无变化', 'progress': '有进展', 'done': '已完成', 'blocked': '受阻', 'needs_owner': '需要主人' };

// 下一次思考由机器人主动提出还是由中心安排，用于主动性核对。
export const NEXT_THINK_BY_VALUES = ['bot', 'hub'] as const;
export const NextThinkBySchema = z.enum(NEXT_THINK_BY_VALUES, { error: '请选择有效的NextThinkBy值' });
export type NextThinkBy = z.infer<typeof NextThinkBySchema>;
export const NEXT_THINK_BY_LABELS: Record<NextThinkBy, string> = { 'bot': '机器人', 'hub': '中心' };

// 下一次思考的触发方式，只约下一次，允许等待事件或交给中心决定。
export const NEXT_THINK_MODES = ['at', 'after', 'on_event', 'auto'] as const;
export const NextThinkModeSchema = z.enum(NEXT_THINK_MODES, { error: '请选择有效的NextThinkMode值' });
export type NextThinkMode = z.infer<typeof NextThinkModeSchema>;
export const NEXT_THINK_MODE_LABELS: Record<NextThinkMode, string> = { 'at': '指定时刻', 'after': '稍后', 'on_event': '等事件', 'auto': '自动' };

// 长期志向是否仍有效，归档志向不再承载新的活跃目标。
export const ASPIRATION_STATUSES = ['active', 'archived'] as const;
export const AspirationStatusSchema = z.enum(ASPIRATION_STATUSES, { error: '请选择有效的AspirationStatus值' });
export type AspirationStatus = z.infer<typeof AspirationStatusSchema>;
export const ASPIRATION_STATUS_LABELS: Record<AspirationStatus, string> = { 'active': '有效', 'archived': '归档' };

// 记录由主人还是机器人创建，用于区分授权来源和主动发起。
export const CREATED_BY_VALUES = ['owner', 'bot'] as const;
export const CreatedBySchema = z.enum(CREATED_BY_VALUES, { error: '请选择有效的CreatedBy值' });
export type CreatedBy = z.infer<typeof CreatedBySchema>;
export const CREATED_BY_LABELS: Record<CreatedBy, string> = { 'owner': '主人', 'bot': '机器人' };

// 目标的自然周期或一次性期限，决定耐心期和周期结束处理。
export const GOAL_PERIODS = ['day', 'week', 'month', 'one_off'] as const;
export const GoalPeriodSchema = z.enum(GOAL_PERIODS, { error: '请选择有效的GoalPeriod值' });
export type GoalPeriod = z.infer<typeof GoalPeriodSchema>;
export const GOAL_PERIOD_LABELS: Record<GoalPeriod, string> = { 'day': '日', 'week': '周', 'month': '月', 'one_off': '一次性' };

// 目标从提议到执行和验收的状态，完成待验收仍不等于已完成。
export const GOAL_STATUSES = ['active', 'done_pending_check', 'done', 'abandoned', 'blocked', 'proposed'] as const;
export const GoalStatusSchema = z.enum(GOAL_STATUSES, { error: '请选择有效的GoalStatus值' });
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = { 'active': '进行中', 'done_pending_check': '待验收', 'done': '完成', 'abandoned': '放弃', 'blocked': '受阻', 'proposed': '提议中' };

// 目标完成由规则自动判断还是由主人验收。
export const GOAL_VERIFICATIONS = ['rule', 'owner'] as const;
export const GoalVerificationSchema = z.enum(GOAL_VERIFICATIONS, { error: '请选择有效的GoalVerification值' });
export type GoalVerification = z.infer<typeof GoalVerificationSchema>;
export const GOAL_VERIFICATION_LABELS: Record<GoalVerification, string> = { 'rule': '规则判定', 'owner': '主人验收' };

// 议程要处理的是任务、跟进、条件触发、承诺还是复查。
export const AGENDA_KINDS = ['task', 'follow_up', 'conditional', 'commitment', 'review'] as const;
export const AgendaKindSchema = z.enum(AGENDA_KINDS, { error: '请选择有效的AgendaKind值' });
export type AgendaKind = z.infer<typeof AgendaKindSchema>;
export const AGENDA_KIND_LABELS: Record<AgendaKind, string> = { 'task': '任务', 'follow_up': '跟进', 'conditional': '条件', 'commitment': '承诺', 'review': '复查' };

// 议程来自主人、机器人、同伴或中心，保留事项的发起来源。
export const AGENDA_SOURCES = ['owner', 'bot', 'peer', 'hub'] as const;
export const AgendaSourceSchema = z.enum(AGENDA_SOURCES, { error: '请选择有效的AgendaSource值' });
export type AgendaSource = z.infer<typeof AgendaSourceSchema>;
export const AGENDA_SOURCE_LABELS: Record<AgendaSource, string> = { 'owner': '主人', 'bot': '机器人', 'peer': '同伴', 'hub': '中心' };

// 议程是否仍待处理；完成和放弃都不再参与到期唤醒。
export const AGENDA_STATUSES = ['open', 'done', 'dropped'] as const;
export const AgendaStatusSchema = z.enum(AGENDA_STATUSES, { error: '请选择有效的AgendaStatus值' });
export type AgendaStatus = z.infer<typeof AgendaStatusSchema>;
export const AGENDA_STATUS_LABELS: Record<AgendaStatus, string> = { 'open': '待办', 'done': '完成', 'dropped': '放弃' };

// 关注项使用哪种感知执行器，决定目标解释和轮询方式。
export const WATCH_KINDS = ['file', 'log', 'http', 'rss', 'script', 'session'] as const;
export const WatchKindSchema = z.enum(WATCH_KINDS, { error: '请选择有效的WatchKind值' });
export type WatchKind = z.infer<typeof WatchKindSchema>;
export const WATCH_KIND_LABELS: Record<WatchKind, string> = { 'file': '文件', 'log': '日志', 'http': '网页', 'rss': '订阅', 'script': '脚本', 'session': '会话' };

// 关注项的创建来源，影响默认相关度、期限和生效权限。
export const WATCH_CREATED_BY_VALUES = ['owner', 'bot', 'hub'] as const;
export const WatchCreatedBySchema = z.enum(WATCH_CREATED_BY_VALUES, { error: '请选择有效的WatchCreatedBy值' });
export type WatchCreatedBy = z.infer<typeof WatchCreatedBySchema>;
export const WATCH_CREATED_BY_LABELS: Record<WatchCreatedBy, string> = { 'owner': '主人', 'bot': '机器人', 'hub': '中心' };

// 关注项是否执行中、等待提议批准、已暂停或到期。
export const WATCH_STATUSES = ['active', 'proposed', 'paused', 'expired'] as const;
export const WatchStatusSchema = z.enum(WATCH_STATUSES, { error: '请选择有效的WatchStatus值' });
export type WatchStatus = z.infer<typeof WatchStatusSchema>;
export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = { 'active': '有效', 'proposed': '提议中', 'paused': '暂停', 'expired': '过期' };

// 感知事实的来源，用于统一评分及外部内容的信任边界。
export const PERCEPT_SOURCES = ['file', 'log', 'http', 'rss', 'script', 'session', 'owner', 'peer', 'inbox', 'system'] as const;
export const PerceptSourceSchema = z.enum(PERCEPT_SOURCES, { error: '请选择有效的PerceptSource值' });
export type PerceptSource = z.infer<typeof PerceptSourceSchema>;
export const PERCEPT_SOURCE_LABELS: Record<PerceptSource, string> = { 'file': '文件', 'log': '日志', 'http': '网页', 'rss': '订阅', 'script': '脚本', 'session': '会话', 'owner': '主人', 'peer': '同伴', 'inbox': '收件箱', 'system': '系统' };

// 感知按显著性分档，决定立即候选、累积入堆或只记日志。
export const PERCEPT_TIERS = ['urgent', 'candidate', 'pile', 'record'] as const;
export const PerceptTierSchema = z.enum(PERCEPT_TIERS, { error: '请选择有效的PerceptTier值' });
export type PerceptTier = z.infer<typeof PerceptTierSchema>;
export const PERCEPT_TIER_LABELS: Record<PerceptTier, string> = { 'urgent': '紧急', 'candidate': '候选', 'pile': '待处理', 'record': '记录' };

// 一次唤醒从投递到结束的处理状态，用于幂等和故障追踪。
export const WAKE_STATUSES = ['delivering', 'running', 'committed', 'no_commit', 'error', 'canceled', 'timeout'] as const;
export const WakeStatusSchema = z.enum(WAKE_STATUSES, { error: '请选择有效的WakeStatus值' });
export type WakeStatus = z.infer<typeof WakeStatusSchema>;
export const WAKE_STATUS_LABELS: Record<WakeStatus, string> = { 'delivering': '投递中', 'running': '运行中', 'committed': '已交账', 'no_commit': '未交账', 'error': '出错', 'canceled': '取消', 'timeout': '超时' };

// 交账中真实世界变化的可见范围，区分仅自己与对外影响。
export const VISIBILITIES = ['only_me', 'owner', 'others'] as const;
export const VisibilitySchema = z.enum(VISIBILITIES, { error: '请选择有效的Visibility值' });
export type Visibility = z.infer<typeof VisibilitySchema>;
export const VISIBILITY_LABELS: Record<Visibility, string> = { 'only_me': '仅自己', 'owner': '主人可见', 'others': '他人可见' };

// 交账证据的验证层级，不能把未验证的结果当成端到端成功。
export const VERIFICATION_LEVELS = ['program', 'agent', 'e2e', 'none'] as const;
export const VerificationLevelSchema = z.enum(VERIFICATION_LEVELS, { error: '请选择有效的VerificationLevel值' });
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;
export const VERIFICATION_LEVEL_LABELS: Record<VerificationLevel, string> = { 'program': '程序验证', 'agent': '机器人验证', 'e2e': '端到端验证', 'none': '未验证' };

// 线程消息的用途，界面据此区分聊天、报告和需要主人处理的消息。
export const THREAD_KINDS = ['chat', 'reply', 'report', 'question', 'approval', 'proposal', 'alert', 'digest', 'handoff', 'peer', 'system'] as const;
export const ThreadKindSchema = z.enum(THREAD_KINDS, { error: '请选择有效的ThreadKind值' });
export type ThreadKind = z.infer<typeof ThreadKindSchema>;
export const THREAD_KIND_LABELS: Record<ThreadKind, string> = { 'chat': '聊天', 'reply': '回复', 'report': '汇报', 'question': '提问', 'approval': '审批', 'proposal': '提议', 'alert': '告警', 'digest': '日报', 'handoff': '交接', 'peer': '同伴消息', 'system': '系统消息' };

// 收件箱只承载需要主人动手的提议、问题、审批或告警。
export const INBOX_TYPES = ['proposal', 'question', 'approval', 'alert'] as const;
export const InboxTypeSchema = z.enum(INBOX_TYPES, { error: '请选择有效的InboxType值' });
export type InboxType = z.infer<typeof InboxTypeSchema>;
export const INBOX_TYPE_LABELS: Record<InboxType, string> = { 'proposal': '提议', 'question': '提问', 'approval': '审批', 'alert': '告警' };

// 给主人事项的紧急程度；P0 可越过免打扰和单推预算。
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export const PrioritySchema = z.enum(PRIORITIES, { error: '请选择有效的Priority值' });
export type Priority = z.infer<typeof PrioritySchema>;
export const PRIORITY_LABELS: Record<Priority, string> = { 'P0': '紧急', 'P1': '重要', 'P2': '一般' };

// 主人事项的处理进度，决定是否继续等待回答或进入过期流程。
export const INBOX_STATUSES = ['open', 'answered', 'expired', 'withdrawn', 'closed'] as const;
export const InboxStatusSchema = z.enum(INBOX_STATUSES, { error: '请选择有效的InboxStatus值' });
export type InboxStatus = z.infer<typeof InboxStatusSchema>;
export const INBOX_STATUS_LABELS: Record<InboxStatus, string> = { 'open': '待处理', 'answered': '已回答', 'expired': '过期', 'withdrawn': '撤回', 'closed': '关闭' };

// 审批只覆盖对外动作 C 和高风险动作 D，内部动作不创建批准票。
export const APPROVAL_ACTION_CLASSES = ['C', 'D'] as const;
export const ApprovalActionClassSchema = z.enum(APPROVAL_ACTION_CLASSES, { error: '请选择有效的ApprovalActionClass值' });
export type ApprovalActionClass = z.infer<typeof ApprovalActionClassSchema>;
export const APPROVAL_ACTION_CLASS_LABELS: Record<ApprovalActionClass, string> = { 'C': '须审批动作', 'D': '高风险动作' };

// 一次批准票的生命周期，已使用、拒绝或过期均不可再次放行。
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'used'] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES, { error: '请选择有效的ApprovalStatus值' });
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = { 'pending': '待审批', 'approved': '批准', 'rejected': '拒绝', 'expired': '过期', 'used': '已使用' };

// 按影响范围与可逆性划分动作，和自主等级共同决定是否审批。
export const ACTION_CLASSES = ['A', 'B', 'C', 'D'] as const;
export const ActionClassSchema = z.enum(ACTION_CLASSES, { error: '请选择有效的ActionClass值' });
export type ActionClass = z.infer<typeof ActionClassSchema>;
export const ACTION_CLASS_LABELS: Record<ActionClass, string> = { 'A': '内部可撤销', 'B': '会持续生效的自我变更', 'C': '别人看得见或碰真实数据', 'D': '不可逆或高风险' };

// 中心代机器人执行的四种动作，分别接入通知、文件、网络和命令接口。
export const OUTBOX_KINDS = ['notify_owner', 'write_file', 'http_post', 'run_command'] as const;
export const OutboxKindSchema = z.enum(OUTBOX_KINDS, { error: '请选择有效的OutboxKind值' });
export type OutboxKind = z.infer<typeof OutboxKindSchema>;
export const OUTBOX_KIND_LABELS: Record<OutboxKind, string> = { 'notify_owner': '通知主人', 'write_file': '写文件', 'http_post': '网络提交', 'run_command': '运行命令' };

// 出站动作从等待审批到执行结束的状态，用于结果回传和防重放。
export const OUTBOX_STATUSES = ['pending_approval', 'ready', 'done', 'failed', 'rejected'] as const;
export const OutboxStatusSchema = z.enum(OUTBOX_STATUSES, { error: '请选择有效的OutboxStatus值' });
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;
export const OUTBOX_STATUS_LABELS: Record<OutboxStatus, string> = { 'pending_approval': '待审批', 'ready': '就绪', 'done': '完成', 'failed': '失败', 'rejected': '拒绝' };

// 同伴交接从发出、接收至完成或失效的状态。
export const HANDOFF_STATUSES = ['offered', 'accepted', 'done', 'declined', 'expired'] as const;
export const HandoffStatusSchema = z.enum(HANDOFF_STATUSES, { error: '请选择有效的HandoffStatus值' });
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
export const HANDOFF_STATUS_LABELS: Record<HandoffStatus, string> = { 'offered': '待接收', 'accepted': '已接收', 'done': '完成', 'declined': '拒绝', 'expired': '过期' };

// 规矩来自主人亲自要求或机器人复盘教训，决定审核和应用方式。
export const RULE_SOURCES = ['owner', 'lesson'] as const;
export const RuleSourceSchema = z.enum(RULE_SOURCES, { error: '请选择有效的RuleSource值' });
export type RuleSource = z.infer<typeof RuleSourceSchema>;
export const RULE_SOURCE_LABELS: Record<RuleSource, string> = { 'owner': '主人', 'lesson': '教训' };

// 规矩是否已生效、尚在提议或已归档，只有有效规矩进入身份文件。
export const RULE_STATUSES = ['active', 'proposed', 'archived'] as const;
export const RuleStatusSchema = z.enum(RULE_STATUSES, { error: '请选择有效的RuleStatus值' });
export type RuleStatus = z.infer<typeof RuleStatusSchema>;
export const RULE_STATUS_LABELS: Record<RuleStatus, string> = { 'active': '有效', 'proposed': '提议中', 'archived': '归档' };

// 用量产生于思考回合、上下文压缩或其他操作，便于独立记账。
export const LEDGER_KINDS = ['turn', 'compaction', 'other'] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS, { error: '请选择有效的LedgerKind值' });
export type LedgerKind = z.infer<typeof LedgerKindSchema>;
export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = { 'turn': '回合', 'compaction': '压缩', 'other': '其他' };

// 额度紧张程度，决定节奏减速、只放紧急事项或暂停等待恢复。
export const QUOTA_LIGHTS = ['green', 'yellow', 'orange', 'red'] as const;
export const QuotaLightSchema = z.enum(QUOTA_LIGHTS, { error: '请选择有效的QuotaLight值' });
export type QuotaLight = z.infer<typeof QuotaLightSchema>;
export const QUOTA_LIGHT_LABELS: Record<QuotaLight, string> = { 'green': '充足', 'yellow': '留意', 'orange': '紧张', 'red': '暂停' };

// 告警条件是否尚未恢复，恢复后关闭对应主人事项。
export const ALERT_STATUSES = ['open', 'closed'] as const;
export const AlertStatusSchema = z.enum(ALERT_STATUSES, { error: '请选择有效的AlertStatus值' });
export type AlertStatus = z.infer<typeof AlertStatusSchema>;
export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = { 'open': '未恢复', 'closed': '已恢复' };

// 区分宿主关闭和电脑睡眠，为恢复补课保留真实原因。
export const DOWNTIME_KINDS = ['host_down', 'sleep'] as const;
export const DowntimeKindSchema = z.enum(DOWNTIME_KINDS, { error: '请选择有效的DowntimeKind值' });
export type DowntimeKind = z.infer<typeof DowntimeKindSchema>;
export const DOWNTIME_KIND_LABELS: Record<DowntimeKind, string> = { 'host_down': '宿主关闭', 'sleep': '电脑睡眠' };

// 一次评估最终是唤醒、排队、入堆、仅记录还是被闸门拦截。
export const APPRAISAL_DECISIONS = ['woke', 'queued', 'pile', 'record_only', 'suppressed'] as const;
export const AppraisalDecisionSchema = z.enum(APPRAISAL_DECISIONS, { error: '请选择有效的AppraisalDecision值' });
export type AppraisalDecision = z.infer<typeof AppraisalDecisionSchema>;
export const APPRAISAL_DECISION_LABELS: Record<AppraisalDecision, string> = { 'woke': '已唤醒', 'queued': '已排队', 'pile': '入待处理堆', 'record_only': '仅记录', 'suppressed': '被拦截' };

// 解释有候选却没有唤醒的具体限制，界面据此展示为什么没醒。
export const SUPPRESSION_REASONS = ['paused', 'waiting_owner_same_subject', 'waiting_owner', 'cooldown', 'pace_min', 'daily_cap', 'bot_budget', 'quota', 'concurrency', 'dispatch_gap', 'startup_quiet', 'dedup', 'retry_backoff'] as const;
export const SuppressionReasonSchema = z.enum(SUPPRESSION_REASONS, { error: '请选择有效的SuppressionReason值' });
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;
// waiting_owner 与 waiting_owner_same_subject 的区别：前者是「还有别的事在等主人，先别自己找事做」，后者是同一事项已被明确丢弃。
export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = { 'paused': '已暂停', 'waiting_owner_same_subject': '同一事项等主人', 'waiting_owner': '等主人回复时暂停', 'cooldown': '冷却中', 'pace_min': '未到最短间隔', 'daily_cap': '每日上限', 'bot_budget': '机器人预算', 'quota': '额度保护', 'concurrency': '并发限制', 'dispatch_gap': '放行间隔', 'startup_quiet': '启动静默', 'dedup': '重复事件', 'retry_backoff': '错误退避' };

// 给主人单独推送所用的通道；none 表示关闭单推。
export const PUSH_CHANNELS = ['dsh', 'macos', 'none'] as const;
export const PushChannelSchema = z.enum(PUSH_CHANNELS, { error: '请选择有效的PushChannel值' });
export type PushChannel = z.infer<typeof PushChannelSchema>;
export const PUSH_CHANNEL_LABELS: Record<PushChannel, string> = { 'dsh': '桌面宿主', 'macos': '系统通知', 'none': '不推送' };

// 宿主回合事件的类型，驱动资源计量、结束处理及审批超时守卫。
export const TURN_EVENT_TYPES = ['started', 'step', 'tool_call', 'ended', 'error', 'awaiting_approval', 'owner_direct'] as const;
export const TurnEventTypeSchema = z.enum(TURN_EVENT_TYPES, { error: '请选择有效的TurnEventType值' });
export type TurnEventType = z.infer<typeof TurnEventTypeSchema>;
export const TURN_EVENT_TYPE_LABELS: Record<TurnEventType, string> = {
  'started': '开始', 'step': '步骤', 'tool_call': '工具调用', 'ended': '结束', 'error': '错误',
  'awaiting_approval': '等待审批', 'owner_direct': '主人直接输入',
};

// 其他宿主会话完成或出错的事件，是会话关注项的输入。
export const EXTERNAL_SESSION_EVENT_TYPES = ['finished', 'error'] as const;
export const ExternalSessionEventTypeSchema = z.enum(EXTERNAL_SESSION_EVENT_TYPES, { error: '请选择有效的ExternalSessionEventType值' });
export type ExternalSessionEventType = z.infer<typeof ExternalSessionEventTypeSchema>;
export const EXTERNAL_SESSION_EVENT_TYPE_LABELS: Record<ExternalSessionEventType, string> = { 'finished': '完成', 'error': '错误' };

// 议程优先级越小越紧急；与调度队列的分数优先级不是同一尺度。
export const AGENDA_PRIORITIES = [1, 2, 3, 4, 5] as const;
export const AGENDA_PRIORITY_LABELS = { 1: '最高', 2: '较高', 3: '普通', 4: '较低', 5: '最低' } as const;
export const AgendaPrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)], { error: '议程优先级必须为 1 到 5 的整数' });
export type AgendaPriority = z.infer<typeof AgendaPrioritySchema>;
