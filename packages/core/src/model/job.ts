/**
 * 「一件事」模型（P74a）：约定固定之后要交付的一项工作，以及它的交回、核对、事件日志、审批补充。
 *
 * 为什么用新表而不是复用事务或约定（方案第 14 节裁定 1）：
 * - 事务只有六种状态且是严格对象，加状态或字段会让旧版本整条读不出；约定同样不能加字段。
 * - 一件事的轮次、证据、暂停信息都不属于约定本身，所以单独建 Job，一份约定至多对应一件事。
 *
 * 本文件只定义结构与校验，不读时钟、不读存储、不调用模型。
 * 全部数值上限来自 config/defaults.ts 的 JOB_DEFAULTS；字符数一律按完整字符计（[...s].length）。
 * 错误信息全部中文，并点出出错字段的路径（用 parseWithPaths，写成 items[2].evidence[0].summary）。
 */
import { z } from 'zod';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { count, nonempty, recordId, timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// 枚举与中文标签
// ---------------------------------------------------------------------------

/** 一件事的存储状态（八个）。界面的「对齐中」不存，由视图从「约定待确认、还没有这件事」推出。 */
export const JOB_STATES = ['ready', 'doing', 'checking', 'rework', 'awaiting_owner', 'blocked', 'done', 'stopped'] as const;
export const JobStateSchema = z.enum(JOB_STATES, { error: '状态必须是 ready、doing、checking、rework、awaiting_owner、blocked、done、stopped 之一' });
export type JobState = z.infer<typeof JobStateSchema>;

/** 受阻后可以回到的状态（blocked.resumeTo）。 */
export const JOB_RESUME_STATES = ['ready', 'doing', 'checking', 'rework'] as const;
export const JobResumeToSchema = z.enum(JOB_RESUME_STATES, { error: '受阻后回到的状态必须是 ready、doing、checking、rework 之一' });

export const JOB_BLOCK_KINDS = ['review_limit', 'executor', 'turn_cap', 'owner_hold', 'participant_off'] as const;
export const JobBlockKindSchema = z.enum(JOB_BLOCK_KINDS, { error: '受阻原因必须是 review_limit、executor、turn_cap、owner_hold、participant_off 之一' });
export type JobBlockKind = z.infer<typeof JobBlockKindSchema>;

/** 界面状态词；tone 决定颜色：run 进行中、you 在等你、ok 已收尾。 */
export const JOB_STATE_LABELS: Record<JobState, string> = {
  ready: '待开工', doing: '执行中', checking: '核对中', rework: '返工中',
  awaiting_owner: '待你验收', blocked: '受阻', done: '已完成', stopped: '已停止',
};
/** 「对齐中」不是存储状态：约定还在待确认、尚无这件事时由视图使用。 */
export const ALIGNING_LABEL = '对齐中';
export type JobStateTone = 'run' | 'you' | 'ok';
export const JOB_STATE_TONES: Record<JobState, JobStateTone> = {
  ready: 'run', doing: 'run', checking: 'run', rework: 'run',
  awaiting_owner: 'you', blocked: 'you', done: 'ok', stopped: 'ok',
};
/** 受阻原因的说明；{执行者}、{名字} 由 jobBlockLabel 替换。 */
export const JOB_BLOCK_LABELS: Record<JobBlockKind, string> = {
  review_limit: '核对三轮未通过', executor: '{执行者}无法继续', turn_cap: '回合用到上限',
  owner_hold: '你已暂停', participant_off: '{名字}已停用',
};
/** 把受阻原因写成一句话；name 是执行者或被停用者的名字，没有时留原样占位以免悄悄写错人。 */
export function jobBlockLabel(kind: JobBlockKind, name: string | null): string {
  const filled = name ?? '员工';
  return JOB_BLOCK_LABELS[kind].replace('{执行者}', filled).replace('{名字}', filled);
}

export const JOB_EVENT_KINDS = [
  'assigned', 'reassigned', 'asked', 'answered', 'forwarded', 'submitted', 'reviewed', 'delivered',
  'owner_accepted', 'owner_returned', 'escalated', 'option_chosen', 'turn_cap', 'cap_answered',
  'executor_blocked', 'paused', 'resumed', 'participant_off', 'launch_requested', 'launched',
  'launch_declined', 'stopped', 'trial_reported',
  // P74r18b：批准之后中心代为运行的发布命令失败（与 launch_declined「主人没有同意发布」分开）。
  'launch_failed',
] as const;
export const JobEventKindSchema = z.enum(JOB_EVENT_KINDS, { error: '事件类型不在允许的 24 种之内' });
export type JobEventKind = z.infer<typeof JobEventKindSchema>;

// ---------------------------------------------------------------------------
// 文字字段
// ---------------------------------------------------------------------------

/** 非空（去首尾空白后仍有内容）且不超过 max 个完整字符。 */
function line(max: number) {
  return nonempty
    .refine(value => value.trim().length > 0, '不能为空')
    .refine(value => [...value].length <= max, `不能超过 ${max} 字`);
}
const note = line(D.NOTE_MAX_CHARS);
/** 整数，可设下限；错误信息固定为中文。 */
const int = (min: number) => z.number({ error: '必须是整数' }).int('必须是整数').min(min, `不能小于 ${min}`);

// ---------------------------------------------------------------------------
// 一件事
// ---------------------------------------------------------------------------

export const JobBlockedSchema = z.strictObject({
  kind: JobBlockKindSchema,
  no: int(1).nullable(), // 关联的条目序号（如第几条一直过不了）；没有时为 null
  text: note, // 受阻的具体说明
  since: timestamp,
  resumeTo: JobResumeToSchema, // 解除受阻时回到哪个状态
  /**
   * P74r3（H2）：受阻原因是「执行者」、原本卡在核对环节（核对人没有动静），受阻期间约定固定了改写条目的新版本，
   * 解除后要回到返工中（resumeTo 改成了 rework），但卡住的仍是核对人：换核对人才能解除。为真时仍按「核对环节没有动静」处理。
   * 可省略：旧数据没有这个字段。
   */
  stalledAtReview: z.boolean().optional(),
  /**
   * P74r6：主人暂停（owner_hold）之前的受阻原因和条目信息。暂停一件已经受阻的事时记下，恢复时按它还原
   * （三轮不过、执行者做不下去恢复成原来的受阻，由总管处理）；回合上限等其余原因恢复时照旧回到受阻前的环节。可省略。
   */
  heldFrom: z.strictObject({ kind: JobBlockKindSchema, no: int(1).nullable(), text: note }).optional(),
});
/** B2：约定修改后，哪些部分继续、哪些暂停、暂停期间的退路。 */
export const JobPauseSchema = z.strictObject({
  versionNo: int(1),
  continuing: z.array(line(D.PAUSE_ITEM_MAX_CHARS)).max(D.PAUSE_ITEMS_MAX, `最多 ${D.PAUSE_ITEMS_MAX} 条`),
  // P74r12：中心列出的行内容最多 60 个字，加上栏名整行最多 100 个字；旧数据的行更短，照常能读。
  paused: z.array(line(D.PAUSE_LINE_MAX_CHARS)).max(D.PAUSE_ITEMS_MAX, `最多 ${D.PAUSE_ITEMS_MAX} 条`),
  // P74r12：暂停的总处数（放不下时最后一行是「另有 n 处」，显示的行数不等于总处数）；旧数据没有，见 pausedCount。
  pausedTotal: int(1).optional(),
  fallback: line(D.FALLBACK_MAX_CHARS).nullable(),
  /**
   * P74r2b：执行者已经把照常在做的部分做完，在等主人确认这一版（他的交回因等确认被拒，或交账结果写了 no_change、blocked、
   * needs_owner）。为真时不再续排、兜底巡检不叫人；确认或撤销时随暂停一起清掉。可省略：旧数据没有这个字段。
   */
  executorWaiting: z.boolean().optional(),
  /**
   * P74f-2：这一版写明「不再做」（stopsJob），主人确认后由中心停下这件事；确认前执行者照常做，所以两栏都是空的。
   * 可省略：旧数据没有这个字段。
   */
  stopsJob: z.boolean().optional(),
  /**
   * P74r2c：新版本里「交付时核对」的条目序号（新版本的序号）：由中心按条目原文对应，或总管在 deliveryItems 里指定，
   * 随新版本一起等主人确认，固定时才写进这件事，撤销时丢弃。可省略：旧数据没有这个字段，固定时按原文对应重新算。
   */
  deliveryItems: z.array(int(1)).optional(),
});
export type JobPause = z.infer<typeof JobPauseSchema>;
/**
 * 还没回答的那一问。text 是提问原文（P74r2a）：原来只在 asked 事件里，事件日志只在内存留 14 天，
 * 久了会读不到；放在这件事的记录上，总管的唤醒包、往来、改派时的作废说明都读这里。
 * 可空且可省略：升级前已存的数据没有这个字段，读不到时才回头找事件。长度沿用提问参数的上限。
 */
export const JobOpenAskSchema = z.strictObject({
  eventId: recordId('jev'), fromId: recordId('b'), at: timestamp,
  text: line(D.ASK_MAX_CHARS).nullable().optional(),
  /**
   * P74r2b：这一问在约定里推不出答案，总管已经出了约定的新版本请主人确认，这里记下是第几版。
   * 有值时提问保持未回答，但这件事此刻在等主人（不再等总管）；主人确认后由中心回答并清掉 openAsk，
   * 主人不确认、总管撤销时清掉这个字段（提问回到等总管）。可省略：旧数据没有这个字段。
   */
  agreementNo: int(1).nullable().optional(),
});
/** 当前要返工的条目：哪一条、哪里不符、改到什么程度算过。 */
export const JobUnmetSchema = z.strictObject({ no: int(1), problem: note, fixTo: note });
export type JobUnmet = z.infer<typeof JobUnmetSchema>;
/**
 * 发布状态。P74r18b 新增 failed：主人批准之后，中心代为运行的发布命令没有成功（发布没有成功，这一步还没结束，
 * 执行者会被叫醒改正命令重新提交，或交账写 blocked）。
 */
export const JOB_LAUNCH_STATES = ['none', 'preparing', 'approval', 'done', 'declined', 'failed'] as const;
export const JobLaunchSchema = z.strictObject({
  state: z.enum(JOB_LAUNCH_STATES, { error: '发布状态必须是 none、preparing、approval、done、declined、failed 之一' }),
  approvalId: nonempty.nullable(),
  link: nonempty.nullable(),
  /**
   * P74r7：发布状态是「暂不发布」（declined）时，是谁结束了发布这一步：owner 是主人自己点了暂不发布（拒绝发布审批），
   * hub 是中心结束的（回合上限、审批作废或过期、执行者已归档、执行者说做不下去、兜底巡检）。
   * 用来让进度行如实写「你暂不发布」或「没有发布」。可省略：旧数据没有这个字段，按主人点的处理。
   */
  endedBy: z.enum(['owner', 'hub']).optional(),
});

/**
 * P74f：交付记录。交付时核对的条目（按时交付才算符合）的结果，以及交付卡落在主题里的消息编号。
 * 放在这件事的记录上而不只写事件：事件日志在内存里只保留近 14 天，交付卡视图、验收后的回执要一直读得到。
 */
export const JobDeliverySchema = z.strictObject({
  stage: int(1),
  cardMessageId: nonempty.nullable(),
  /**
   * P74r4a：交付卡落楼的时间。打字验收要判断「主人这句话是否晚于交付卡」，改读这里，不到内存里的线程日志（只保留 14 天）里找卡。
   * 可省略：旧数据没有，读不到时才回头找线程日志。
   */
  cardAt: timestamp.nullable().optional(),
  checks: z.array(z.strictObject({ no: int(1), ok: z.boolean() })),
  /** P74f-2：交付卡的修订号。同一阶段重新交付（约定只删去条目、重排后）时加 1，只有最新一张可以验收。可省略：为 0。 */
  rev: int(0).optional(),
});
export type JobDelivery = z.infer<typeof JobDeliverySchema>;

/**
 * P74f-2：总管向主人说明「卡住了、有哪几个办法」的记录（escalate）。放在这件事的记录上而不只写事件：
 * 三轮不过卡要一直读得到，「同一阶段只说明一次」的判断也不能依赖只保留 14 天的事件日志。
 * no、noText：卡住的条目序号和当时的原文（约定改过之后序号会变，按原文对应）；change.text 为 null 表示删去这一条。
 */
export const JobEscalationOptionSchema = z.strictObject({
  title: line(D.OPTION_TITLE_MAX_CHARS),
  detail: line(D.OPTION_DETAIL_MAX_CHARS),
  change: z.strictObject({ no: int(1), text: nonempty.nullable() }).nullable(),
  followUp: z.boolean(),
});
export const JobEscalationSchema = z.strictObject({
  stage: int(1),
  /** 同一阶段第几次说明（第一次为 0）；执行者做不下去的情形阶段号不变，每次新的受阻可以再说明一次。可省略：为 0。 */
  rev: int(0).optional(),
  /** 说明时这次受阻开始的时间（blocked.since）：判断「同一次受阻」只说明一次。可省略：旧数据按阶段判断。 */
  blockedSince: timestamp.optional(),
  versionNo: int(1), // 说明时这件事按约定第几版做（卡片上「记为约定第 n+1 版」用）
  kind: z.enum(['review_limit', 'executor'], { error: '说明类型必须是 review_limit、executor 之一' }),
  stuckAt: note,
  no: int(1).nullable(),
  noText: nonempty.nullable(),
  options: z.array(JobEscalationOptionSchema).min(D.OPTIONS_MIN).max(D.OPTIONS_MAX),
  suggested: int(0),
  reason: line(D.ESCALATE_REASON_MAX_CHARS),
  tried: z.array(nonempty),
  at: timestamp,
  chosen: int(0).nullable(),
  chosenAt: timestamp.nullable(),
  /**
   * P74r4a：这次说明已失效的原因（约定在重新确认、或约定固定了新版本）。失效的说明不能再选办法，
   * 也不算「这一次受阻已经说明过」，总管可以重新说明。可省略：没有失效就没有这个字段。
   */
  invalid: z.enum(['reconfirming', 'updated', 'withdrawn', 'released', 'held', 'reassigned'], { error: '失效原因必须是 reconfirming、updated、withdrawn、released、held、reassigned 之一' }).optional(),
});
export type JobEscalation = z.infer<typeof JobEscalationSchema>;

/**
 * P74f（补充要求 3.1）：主人验收时指出不符的一次记录。第四块（技能库与记忆）在验收之后读它，
 * 所以落在这件事的记录上，不受事件日志只保留近 14 天的影响。
 */
export const JobOwnerReturnSchema = z.strictObject({
  stage: int(1), // 被指出不符的那个阶段（退回返工后这件事的阶段加 1）
  items: z.array(z.strictObject({ no: int(1), text: nonempty, problem: note, fixTo: note })).min(1),
  missed: note, // 核对为什么漏了、这次怎么补
  messageId: nonempty.nullable(), // 主人那句话的消息编号；取不到为 null
  at: timestamp,
});
export type JobOwnerReturn = z.infer<typeof JobOwnerReturnSchema>;

export const JobSchema = z.strictObject({
  id: recordId('job'),
  chiefId: recordId('b'),
  agreementId: recordId('agr'), // 唯一：一份约定至多一件事
  projectId: recordId('prj'),
  topicId: recordId('ptp'), // 取自约定
  folder: nonempty, // 主题文件夹，相对项目文件夹：'jobs/<jobId>'
  state: JobStateSchema,
  executorId: recordId('b'),
  reviewerId: recordId('b').nullable(), // null 表示总管自己核对
  dueAt: timestamp.nullable(),
  deliveryItems: z.array(int(1)), // 「交付时核对」的条目序号
  launchStep: z.boolean({ error: '必须是布尔值' }), // 约定里有「对外发布另行确认」时为真
  stage: int(1), // 核对阶段
  round: int(0), // 本阶段已交回几轮；上限在 superRefine 里判断
  blocked: JobBlockedSchema.nullable(),
  pause: JobPauseSchema.nullable(),
  openAsk: JobOpenAskSchema.nullable(), // 还没回答的那一问
  unmet: z.array(JobUnmetSchema), // 当前要返工的条目
  turnsUsed: count,
  turnCap: count,
  launch: JobLaunchSchema,
  inboxId: nonempty.nullable(), // 当前给主人的那一条（验收、三轮不过、回合上限三者之一）
  /**
   * P74r2b：这件事已经处理到约定第几版（派活时是当时的固定版本号；固定后的收尾状态步骤做完才更新）。
   * 启动整理和每次巡检发现约定最新的固定版本号更大，就补做收尾。可空：旧数据没有这个字段，没有就不补做。
   */
  handledVersionNo: int(1).nullable().optional(),
  /** P74f：最近一次交付的记录（交付时核对结果、交付卡消息）。可省略：旧数据和还没交付的事没有。 */
  delivery: JobDeliverySchema.nullable().optional(),
  /** P74f：主人验收时指出不符的全部记录（从旧到新）。可省略：没有指出过。 */
  ownerReturns: z.array(JobOwnerReturnSchema).optional(),
  /** P74f-2：最近一次向主人说明（三轮不过或做不下去）的记录；一个阶段只说明一次。可省略。 */
  escalation: JobEscalationSchema.nullable().optional(),
  /** P74f-2：更早的几次说明（再次说明时把上一次放进来，让旧的三轮不过卡仍显示主人当时选的办法）。可省略。 */
  escalationHistory: z.array(JobEscalationSchema).optional(),
  /**
   * P74r6：主人为三轮不过（或做不下去）选了不带改动的办法、总管照办法让这件事继续之后，记下主人选的办法（标题和做法）与它所在的阶段。
   * 执行者、核对人的唤醒包在这一阶段里写明「主人为这件事选的办法」。可省略：没有这回事时没有这个字段。
   */
  ownerChoice: z.strictObject({ stage: int(1), title: line(D.OPTION_TITLE_MAX_CHARS), detail: line(D.OPTION_DETAIL_MAX_CHARS) }).optional(),
  /**
   * P74f-2：主人选了带改动的办法、这件事回到核对中之后，核对人只需要给结论的条目序号（其余条目按沿用处理）。
   * 下一次提交核对结论时清掉。可省略：没有这回事时没有这个字段。
   */
  recheckNos: z.array(int(1)).optional(),
  /** P74f-2：「停住了」条目已经建过几条（事项键里的序号，不依赖事件日志）。可省略：旧数据为 0。 */
  stallNo: count.optional(),
  /** P74f：总管按约定回答了几个问题（回执用；不依赖只保留 14 天的事件日志）。可省略：旧数据为 0。 */
  answeredCount: count.optional(),
  /** P74f：已经给主人落过「第一件事做完了」试用反馈的员工 id（避免重复落）。可省略。 */
  trialReported: z.array(recordId('b')).optional(),
  /**
   * P74r4a：「打扰你」的累计数：每建一条与这件事或它的约定有关的「待你处理」条目加一。放在记录上，
   * 不去数收件箱（已关闭的条目 30 天后会被清掉）。可省略：旧数据没有，回执按收件箱里现有的条目数现算。
   */
  disturbCount: count.optional(),
  /**
   * P74r4a：验收通过时一次算好的回执五行（标签和值）。之后查看回执用存下的数字，不再现算。可省略：没验收，或旧数据。
   */
  // P74r11：标签「打扰你」「总管替你答掉的问题」改为「需要你处理」「总管代你答复的问题」；模式同时接受新旧两种写法（旧存档能读），
  // 新写入一律用新写法，视图遇到旧写法时换成新写法（见 job/receipt.ts 的 modernReceiptLabel）。
  receipt: z.array(z.strictObject({ label: z.enum(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '打扰你', '总管替你答掉的问题', '核对', '约定版本']), value: z.string() })).optional(),
  firstLockedAt: timestamp, // 约定第一次固定的时间
  assignedAt: timestamp,
  startedAt: timestamp.nullable(),
  deliveredAt: timestamp.nullable(),
  acceptedAt: timestamp.nullable(),
  stoppedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).superRefine((job, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  if ((job.state === 'blocked') !== (job.blocked !== null)) {
    bad(['blocked'], job.state === 'blocked' ? '受阻状态必须写明受阻原因' : '只有受阻状态才能有受阻原因');
  }
  if (job.reviewerId !== null && job.reviewerId === job.executorId) bad(['reviewerId'], '核对人不能是执行者本人');
  if (job.round > D.REVIEW_ROUNDS_MAX) bad(['round'], `核对轮数必须在 0 到 ${D.REVIEW_ROUNDS_MAX} 之间`);
  if (new Set(job.deliveryItems).size !== job.deliveryItems.length) bad(['deliveryItems'], '交付时核对的条目序号不能重复');
});
export type Job = z.infer<typeof JobSchema>;

// ---------------------------------------------------------------------------
// 交回与核对
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = ['file', 'image', 'test', 'link'] as const;
export const EVIDENCE_CHECK_STATUSES = ['ok', 'missing', 'empty', 'not_image', 'too_large', 'outside', 'unchecked'] as const;
/** 一项证据；check 是中心的机械检查结果，执行者不能自己写。 */
export const EvidenceSchema = z.strictObject({
  id: z.string({ error: '必须是文字' }).regex(/^ev[1-9][0-9]*$/, '证据编号必须是 ev1、ev2 这样的形式'),
  kind: z.enum(EVIDENCE_KINDS, { error: '证据类型必须是 file、image、test、link 之一' }),
  path: nonempty.nullable(), // file、image：主题文件夹内的相对路径
  url: nonempty.nullable(), // link
  summary: line(D.EVIDENCE_SUMMARY_MAX_CHARS),
  command: line(D.EVIDENCE_COMMAND_MAX_CHARS).nullable(), // test 可选：核对人复跑用的命令
  check: z.strictObject({ status: z.enum(EVIDENCE_CHECK_STATUSES, { error: '检查状态不在允许的取值之内' }), detail: z.string({ error: '必须是文字' }) }),
}).superRefine((evidence, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
  if ((evidence.kind === 'file' || evidence.kind === 'image') && evidence.path === null) bad('path', `${evidence.kind} 类型的证据必须写明文件路径`);
  if (evidence.kind === 'link' && evidence.url === null) bad('url', 'link 类型的证据必须写明链接');
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const JOB_SELF_CHECKS = ['met', 'not_met', 'at_delivery', 'carried'] as const;
export const JobSubmissionItemSchema = z.strictObject({
  no: int(1),
  text: nonempty, // 由中心从约定原样抄出，执行者不能改
  selfCheck: z.enum(JOB_SELF_CHECKS, { error: '自查结论必须是 met、not_met、at_delivery、carried 之一' }),
  note: note.nullable(),
  evidence: z.array(EvidenceSchema).max(D.EVIDENCE_PER_ITEM_MAX, `每条最多 ${D.EVIDENCE_PER_ITEM_MAX} 项证据`),
});
export const JobSubmissionSchema = z.strictObject({
  id: recordId('jsb'),
  jobId: recordId('job'),
  stage: int(1),
  round: int(1),
  executorId: recordId('b'),
  versionNo: int(1), // 按约定第几版交回
  changeNote: note, // 这一轮怎么做、改了什么
  items: z.array(JobSubmissionItemSchema).min(1, '至少要有 1 条'),
  deliverables: z.array(nonempty).max(D.DELIVERABLES_MAX, `产出物最多 ${D.DELIVERABLES_MAX} 条`),
  preview: nonempty.nullable(), // 主题文件夹内的 .html，或本机地址
  createdAt: timestamp,
  /**
   * P74r2c：这条记录是中心重排的（约定新版本只删去了条目，条目重新编号后追加的一条），值是重排自哪一次交回。
   * 它不是执行者的一次交回（统计交回次数时用 isCenterRemapped 排除）。可省略：执行者的交回没有这个字段。
   */
  remappedFrom: recordId('jsb').optional(),
}).superRefine((submission, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  const nos = new Set<number>();
  const evidenceIds = new Set<string>();
  submission.items.forEach((item, i) => {
    if (nos.has(item.no)) bad(['items', i, 'no'], `条目序号 ${item.no} 重复`);
    nos.add(item.no);
    item.evidence.forEach((evidence, e) => {
      if (evidenceIds.has(evidence.id)) bad(['items', i, 'evidence', e, 'id'], `证据编号「${evidence.id}」在这次交回里重复`);
      evidenceIds.add(evidence.id);
    });
  });
});
export type JobSubmission = z.infer<typeof JobSubmissionSchema>;

export const JOB_VERDICTS =['met', 'unmet', 'at_delivery', 'carried'] as const;
export const JobReviewItemSchema = z.strictObject({
  no: int(1),
  verdict: z.enum(JOB_VERDICTS, { error: '核对结论必须是 met、unmet、at_delivery、carried 之一' }),
  note: note.nullable(),
  fixTo: note.nullable(), // 判不符时写改到什么程度算过
  rechecked: z.boolean({ error: '必须是布尔值' }),
});
export const JobReviewSchema = z.strictObject({
  id: recordId('jrv'),
  jobId: recordId('job'),
  stage: int(1),
  round: int(1),
  submissionId: recordId('jsb'),
  reviewerId: recordId('b'), // 总管核对时写总管 id
  items: z.array(JobReviewItemSchema).min(1, '至少要有 1 条'),
  carriedNote: line(D.CARRIED_NOTE_MAX_CHARS).nullable(), // 沿用上一轮结论的理由
  spotChecked: z.array(int(1)), // 抽查了哪几条沿用的条目
  createdAt: timestamp,
  /**
   * P74r4a：这份核对记录是中心按新编号重排出来的（约定只删去条目、或选办法直接交付时，把通过的那次核对换成新编号追加一份），
   * 不是核对人做的一轮。回执、试用反馈数「核对几轮」时只排除它。可省略：核对人的核对没有这个字段。
   */
  byCenter: z.boolean().optional(),
}).superRefine((review, ctx) => {
  const nos = new Set<number>();
  review.items.forEach((item, i) => {
    if (nos.has(item.no)) ctx.addIssue({ code: 'custom', message: `条目序号 ${item.no} 重复`, path: ['items', i, 'no'] });
    nos.add(item.no);
  });
});
export type JobReview = z.infer<typeof JobReviewSchema>;

// ---------------------------------------------------------------------------
// 事件日志与审批补充
// ---------------------------------------------------------------------------

/** 一件事里发生过的每个动作；data 是小对象，序列化后不超过 2 KB。 */
export const JobEventSchema = z.strictObject({
  id: recordId('jev'),
  jobId: recordId('job'),
  at: timestamp,
  actor: nonempty, // 'owner'、'hub' 或员工 id
  kind: JobEventKindSchema,
  to: z.array(nonempty), // 接收者：员工 id、'owner' 或 'hub'
  refId: nonempty.nullable(),
  data: z.record(z.string(), z.unknown()),
}).superRefine((event, ctx) => {
  const bytes = Buffer.byteLength(JSON.stringify(event.data), 'utf8');
  if (bytes > D.EVENT_DATA_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: `事件附带内容太长：${bytes} 字节，上限 ${D.EVENT_DATA_MAX_BYTES} 字节`, path: ['data'] });
  }
});
export type JobEvent = z.infer<typeof JobEventSchema>;

const launchNote = line(D.LAUNCH_NOTE_MAX_CHARS).nullable();
/** 一张审批单的三行补充（费用、能否撤回、批准之后），键为审批单 id；null 界面显示「未说明」。 */
export const ApprovalNoteSchema = z.strictObject({
  id: recordId('ap'),
  cost: launchNote,
  undo: launchNote,
  after: launchNote,
  // P74g：这张审批单属于哪件事（执行者在一件事的执行链回合里申请的）；不属于一件事的审批为 null。
  // 可省略：P74a 已写入的旧行没有这一项，按 null 处理。
  jobId: recordId('job').nullable().optional(),
  /**
   * P81r1（S6）：这张发布审批建单时，约定里保存的发布位置（绝对路径）。
   * 运行前核对比较它和约定里现在的位置，不再比对提示句的文字；旧存档没有这一项，按「不放开」处理。
   */
  launchLocalDir: nonempty.optional(),
  /**
   * P85（W9）：写文件审批建单时，要写入的位置解析到的真实落点（绝对路径）。
   * 批准之后执行之前重新解析并比较，不相等就不写。旧存档、不是写文件的审批没有这一项，照旧执行。
   */
  writeRealPath: nonempty.optional(),
  createdAt: timestamp,
});
export type ApprovalNote = z.infer<typeof ApprovalNoteSchema>;
