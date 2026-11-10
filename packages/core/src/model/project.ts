/**
 * 项目容器模型（v2 计划 3.4，第四期 F08）：项目 Project 与项目任务 ProjectTask。
 *
 * 为什么独立于交账 Commit 建表（见 v2 计划 3.4）：
 * - Commit 是「一次唤醒的交账叙事」，只活 30 天；项目与任务要跨多次唤醒存在，还要被主人验收；
 * - 项目即工作区，成员与负责人直接引用队友 Bot id；主人决定取消编制后不再有席位这一层；
 * - 执行者说完成只到 done_pending_check，必须主人验收才 accepted，防止「说了就算」。
 *
 * 本卡纪律：只归档不删除；wakeIds/artifactIds 本卡只支持空数组与读取，
 * 由后续派活卡（F12）与产物卡的服务层维护，本模型不提供直接写入入口。
 * 本模型只定义结构与校验，不读时钟、不读文件、不碰宿主，全部逻辑可单测。
 */
import { z } from 'zod';
import { count, nonempty, recordId, text, timestamp } from './primitives.js';

/** 项目状态：进行中、已暂停、已完成、已归档。归档不删除任务与历史。 */
export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES, {
  error: '项目状态必须是 active、paused、done、archived 之一',
});
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档',
};

/** 验收项状态：待验收 / 已满足。勾选由主人在保存项目时维护，验收任务不强制勾完（保守默认）。 */
export const CRITERION_STATUSES = ['open', 'met'] as const;
export const CriterionStatusSchema = z.enum(CRITERION_STATUSES, {
  error: '验收项状态必须是 open 或 met',
});
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;
export const CRITERION_STATUS_LABELS: Record<CriterionStatus, string> = {
  open: '待验收', met: '已满足',
};

/**
 * 一条项目验收标准。
 * text：要满足什么；verify：怎么验证（一句话方法，允许空串）；status 由主人勾选。
 * id 用 ac_ 前缀，保存项目时对新增项生成；已有项保留 id，便于界面按 id 渲染勾选状态。
 */
export const AcceptanceCriterionSchema = z.strictObject({
  id: recordId('ac'), // 验收项 id，前缀 ac_
  text: nonempty.max(300, '验收标准不能超过 300 字'), // 验收口径正文
  verify: text.max(300, '验证方式不能超过 300 字'), // 验证方式，允许为空
  status: CriterionStatusSchema,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * 项目共享上下文的一条已定决策（P39）：
 * text 是决定本身，by 记「谁定的」（owner 或队友 id），at 是定下来的时间。
 * id 用于保留同一决策的身份，界面按 id 渲染、服务层按 id 判断是否已有项。
 */
export const ContextDecisionSchema = z.strictObject({
  id: recordId('dc'), // 决策 id，前缀 dc_
  text: nonempty.max(300, '决策内容不能超过 300 字'),
  by: text.max(100, '决策来源不能超过 100 字').default('owner'),
  at: timestamp,
});
export type ContextDecision = z.infer<typeof ContextDecisionSchema>;

/** 术语表一行：术语 + 一句人话解释；两者都必填，避免出现只有关键词的空条目。 */
export const ContextGlossaryEntrySchema = z.strictObject({
  term: nonempty.max(60, '术语不能超过 60 字'),
  meaning: nonempty.max(300, '术语释义不能超过 300 字'),
});
export type ContextGlossaryEntry = z.infer<typeof ContextGlossaryEntrySchema>;

/**
 * 项目共享上下文（P39）：背景、约定、已定决策、术语表四段。
 * 为什么固定四段：主人和队友要按同一套前提干活；结构固定才能渲染成同一份文件、
 * 算同一种摘要、做同一套留痕。四段全空即「未配置」，项目页不显示卡片、唤醒包不带这段。
 */
export const ProjectContextSchema = z.strictObject({
  background: text.max(2000, '项目背景不能超过 2000 字'),
  conventions: text.max(2000, '项目约定不能超过 2000 字'),
  decisions: z.array(ContextDecisionSchema),
  glossary: z.array(ContextGlossaryEntrySchema),
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

/** 四段全空的上下文等价于未配置；旧项目按这个默认值兼容，零迁移。 */
export function emptyProjectContext(): ProjectContext {
  return { background: '', conventions: '', decisions: [], glossary: [] };
}

/**
 * 上下文修改来源：主人直接编辑、队友建议被主人采纳，
 * 或项目负责人（P60）随项目推进直接更新背景，这一条不经主人采纳。
 */
export const PROJECT_CONTEXT_SOURCES = ['owner_edit', 'bot_proposal', 'owner_bot'] as const;
export const ProjectContextSourceSchema = z.enum(PROJECT_CONTEXT_SOURCES, {
  error: '上下文修改来源必须是 owner_edit、bot_proposal 或 owner_bot',
});
export type ProjectContextSource = z.infer<typeof ProjectContextSourceSchema>;
export const PROJECT_CONTEXT_SOURCE_LABELS: Record<ProjectContextSource, string> = {
  owner_edit: '主人编辑',
  bot_proposal: '采纳队友建议',
  owner_bot: '负责人更新',
};

/**
 * 一次上下文修改的留痕（P39）：谁改的、什么时候、改了什么（摘要）、内容哈希、来源。
 * 只存摘要与哈希，正文在项目 sharedDir 的固定文件里；账本不复制正文。
 * editorId 存 'owner' 或队友 id，界面按队友名册翻译成人话（查不到时只说「已删除的队友」）。
 */
export const ProjectContextRevisionSchema = z.strictObject({
  id: recordId('pcr'), // 修订 id，前缀 pcr_
  at: timestamp,
  editorId: text.max(100, '编辑者 id 不能超过 100 字'),
  editorKind: z.enum(['owner', 'bot'], { error: '编辑者类型必须是 owner 或 bot' }),
  summary: text.max(200, '修改摘要不能超过 200 字'),
  hash: text.regex(/^[0-9a-f]{64}$/, '内容哈希必须是 64 位小写十六进制'),
  source: ProjectContextSourceSchema,
});
export type ProjectContextRevision = z.infer<typeof ProjectContextRevisionSchema>;

/** 队友提交的上下文建议状态：待主人确认、已采纳、已驳回。 */
export const PROJECT_CONTEXT_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const ProjectContextProposalStatusSchema = z.enum(PROJECT_CONTEXT_PROPOSAL_STATUSES, {
  error: '上下文建议状态必须是 pending、approved 或 rejected',
});
export type ProjectContextProposalStatus = z.infer<typeof ProjectContextProposalStatusSchema>;

/**
 * 队友的「建议修改」：不改项目正文，只落一条待审记录；主人采纳后才写入上下文并留痕。
 * context 存完整四段（建议方没改的段沿用当前值），这样采纳时不需要再合并、也不会丢段。
 */
export const ProjectContextProposalSchema = z.strictObject({
  id: recordId('pcp'), // 建议 id，前缀 pcp_
  projectId: recordId('prj'),
  botId: recordId('b'),
  context: ProjectContextSchema,
  note: text.max(500, '建议说明不能超过 500 字'),
  status: ProjectContextProposalStatusSchema,
  createdAt: timestamp,
  decidedAt: timestamp.nullable(),
});
export type ProjectContextProposal = z.infer<typeof ProjectContextProposalSchema>;

/**
 * 一个项目。ownerBotId 可空（尚未指定负责人）；成员是队友 id 数组，项目就是工作区。
 * sharedDir 只存路径字符串，本模型不创建目录、不校验文件；路径边界（必须落在
 * rootDir/projects 子树内）由 project/service.ts 在保存时判断。
 */
export const ProjectSchema = z.strictObject({
  id: recordId('prj'), // 项目 id，前缀 prj_
  name: nonempty.max(120, '项目名称不能超过 120 字'), // 项目名
  charter: text.max(500, '项目一句话目标不能超过 500 字'), // 一句话目标，允许为空
  // P34 两层：愿景说明「这个项目为什么存在、最终要去哪」，约定说明「队友之间怎么配合」。
  // 两者都允许为空（旧项目按空值兼容），默认空串，不阻断保存与展示。
  vision: text.max(2000, '项目愿景不能超过 2000 字').default(''),
  conventions: text.max(2000, '项目约定不能超过 2000 字').default(''),
  status: ProjectStatusSchema,
  ownerBotId: recordId('b').nullable(), // 负责人队友；空表示尚未指定
  memberBotIds: z.array(recordId('b')), // 成员队友；去重与上限由服务层保证
  sharedDir: nonempty.max(1000, '项目目录不能超过 1000 字'), // 项目产物目录路径，只存字符串
  acceptanceCriteria: z.array(AcceptanceCriterionSchema), // 验收清单，上限由服务层保证
  // P39 项目共享上下文：四段正文 + 修改留痕。旧项目缺字段时按空上下文兼容，零迁移。
  context: ProjectContextSchema.default(() => emptyProjectContext()),
  contextRevisions: z.array(ProjectContextRevisionSchema).default([]),
  // P60：项目背景最近一次由谁、什么时候更新；旧项目没有这两项，读取时按「没更新过」处理。
  backgroundUpdatedAt: timestamp.nullable().optional(),
  backgroundUpdatedBy: text.max(100, '背景更新人不能超过 100 字').nullable().optional(), // 'owner' 或队友 id
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(), // 归档时间；软归档不删任务
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * 项目下的一个主题（P63）：一条会话一个主题，消息线性盖楼，不做楼中楼。
 *
 * 为什么单独建表：主题的楼层放在线程日志里（thread 字段写主题 id），这里只放「这条讨论走到哪了」：
 * - agentTurnsSinceOwner：主人上次说话后队友已经发言几次，到上限就停，防止队友互相叫醒停不下来；
 * - pendingBotIds：这一轮还在等谁开口，全部说完才回到 owner。
 */
export const ProjectTopicSchema = z.strictObject({
  id: recordId('ptp'), // 主题 id，前缀 ptp_；同时就是线程 id
  projectId: recordId('prj'), // 所属项目
  title: nonempty.max(120, '主题标题不能超过 120 字'), // 取首条消息第一行
  createdAt: timestamp,
  updatedAt: timestamp,
  lastMessageAt: timestamp, // 最后一条消息的时间，项目页按它排序
  agentTurnsSinceOwner: count, // 主人上次说话后队友的累计发言次数
  pendingBotIds: z.array(nonempty), // 这一轮还在等谁开口
});
export type ProjectTopic = z.infer<typeof ProjectTopicSchema>;

/**
 * 任务状态：执行者只能把任务推进到 done_pending_check（待主人验收），
 * 主人驳回后任务回到 doing（驳回理由落审计，见服务层）；accepted 是终态。
 * rejected 表示「最近一次结论是驳回」的瞬时结论值，服务层驳回后随即落 doing，本卡不持久化 rejected。
 */
export const TASK_STATUSES = [
  'todo', 'doing', 'blocked', 'done_pending_check', 'accepted', 'rejected',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES, {
  error: '任务状态必须是 todo、doing、blocked、done_pending_check、accepted、rejected 之一',
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '受阻',
  done_pending_check: '待验收',
  accepted: '已通过',
  rejected: '已驳回',
};

/**
 * 一个项目任务。assigneeBotId 为空表示待认领；指派对象必须是项目成员队友（服务层校验）。
 * wakeIds/artifactIds 记录本卡只读：先支持空数组持久化，派活与产物关联由后续卡的服务层追加。
 */
export const ProjectTaskSchema = z.strictObject({
  id: recordId('pt'), // 任务 id，前缀 pt_
  projectId: recordId('prj'), // 所属项目
  title: nonempty.max(120, '任务标题不能超过 120 字'),
  detail: text.max(2000, '任务说明不能超过 2000 字'), // 任务细节，允许为空
  assigneeBotId: recordId('b').nullable(), // 指派队友；空=待认领
  status: TaskStatusSchema,
  wakeIds: z.array(nonempty), // 推进过它的唤醒 id；本卡恒为空数组
  artifactIds: z.array(nonempty), // 关联产物 id；本卡恒为空数组
  // P63：这件事是从哪个主题聊出来的；可空，旧任务没有这一项时按空处理。
  topicId: recordId('ptp').nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  dueAt: timestamp.nullable(), // 截止时间；空表示不设
});
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;
