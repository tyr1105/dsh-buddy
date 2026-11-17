/**
 * 「一件事」三个视图的 zod 结构（P74a）：进度行、主题楼层与往来折叠、项目页的一件事行。
 *
 * 为什么用 zod 定义、类型由它推出：插件的界面一致性测试要拿真实视图去校验字段，
 * 类型和校验共用同一份定义，才不会出现「类型改了、测试没跟上」。类型别名放在 api/types.ts。
 */
import { z } from 'zod';
import { ThreadMessageSchema } from '../model/outreach.js';
import { MemoryNoteViewSchema } from './memory-views.js';
// P75g：复盘卡（retro: 前缀的 job_card）也在卡片联合里；结构与纯函数在 skill-views.ts。
import { RetroCardViewSchema } from './skill-views.js';
// P75h：技能核对卡（skillcheck: 前缀的 job_card），结构与纯函数在 skill-check-card.ts。
import { SkillCheckCardViewSchema } from './skill-check-card.js';

/** 进度行的步骤：已完成、当前、停住、未到。 */
export const JobStepSchema = z.strictObject({
  label: z.enum(['对齐', '执行', '核对', '你验收', '发布']),
  state: z.enum(['done', 'current', 'stuck', 'todo']),
});

export const JobProgressViewSchema = z.strictObject({
  steps: z.array(JobStepSchema).min(4).max(5), // 无发布步骤时四步，有时五步
  stateLabel: z.string(),
  stateTone: z.enum(['run', 'you', 'ok']),
  roundText: z.string().nullable(), // 核对中、返工中才有
  waitingOn: z.string().nullable(),
  delayNote: z.string().nullable(),
  dueText: z.string(),
  pausedText: z.string().nullable(),
  // P76e：第三行「消耗」与展开后的逐回合明细（中心按记录算，不调用模型）。可省略：旧样例不带；没有记过账的事 costLine 为 null、明细为空。
  costLine: z.string().nullable().optional(),
  costTurns: z.array(z.strictObject({ at: z.string(), who: z.string(), step: z.string(), tokens: z.string() })).optional(),
});

/** 折叠组里的一条往来：消息本身加上「谁 → 谁」。 */
export const FoldedMessageSchema = z.strictObject({
  message: ThreadMessageSchema,
  fromName: z.string(),
  toNames: z.array(z.string()),
});

export const TopicFloorItemSchema = z.union([
  // P75c：楼层消息下面挂着「已记住」时带 memoryNotes；没有时不出现这个字段。
  z.strictObject({ kind: z.literal('floor'), message: ThreadMessageSchema, memoryNotes: z.array(MemoryNoteViewSchema).optional() }),
  z.strictObject({
    kind: z.literal('fold'),
    id: z.string(), // 组内第一条消息的 id，界面用它记住展开状态
    count: z.number().int().min(1),
    participants: z.array(z.string()),
    rangeText: z.string(),
    latest: z.string(),
    messages: z.array(FoldedMessageSchema),
    // P75g：折叠组里全是复盘类消息（复盘卡、核对卡、复盘小结）时组标题写「复盘」；其他组没有这个字段。
    label: z.literal('复盘').optional(),
  }),
]);

export const TopicFloorsViewSchema = z.strictObject({
  countText: z.string(),
  items: z.array(TopicFloorItemSchema),
});

export const ProjectJobRowSchema = z.strictObject({
  jobId: z.string(),
  topicId: z.string(),
  title: z.string(),
  executorName: z.string(),
  stateLabel: z.string(),
  stateTone: z.enum(['run', 'you', 'ok']),
  dueText: z.string(),
});

// ---------------------------------------------------------------------------
// P74d：交回卡与核对卡（工作往来里的卡片）。P74f 会往同一个联合里加交付卡、三轮不过卡、回执三种。
// ---------------------------------------------------------------------------

/** 一条证据在卡片上的样子：label 是显示用的短名，checkText 是中心机械检查的结果。 */
export const EvidenceViewSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['file', 'image', 'test', 'link']),
  label: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  summary: z.string(),
  checkText: z.string().nullable(),
});

/** 清单里的一条：每条对应约定「怎样算做完」的一条。交回、核对、交付三处共用这一种清单，只有结论一栏不同。 */
export const EvidenceItemViewSchema = z.strictObject({
  no: z.number().int().min(1),
  text: z.string(),
  verdict: z.strictObject({
    label: z.enum(['自查符合', '自查不符', '交付时核对', '沿用', '符合', '不符', '你判不符']),
    tone: z.enum(['ok', 'bad', 'na']),
  }),
  evidence: z.array(EvidenceViewSchema),
  note: z.string().nullable(), // 核对的问题、执行者的说明
  fixTo: z.string().nullable(), // 「改到什么程度算过」
  history: z.string().nullable(), // 交付卡用（P74f）
});

export const SubmissionCardViewSchema = z.strictObject({
  kind: z.literal('submission'),
  head: z.literal('交回'),
  title: z.string(),
  stateText: z.string(),
  intro: z.string(),
  items: z.array(EvidenceItemViewSchema),
  /** 读取证据截图要用的两个编号（只是数据，不进任何文字）；取不到为 null，界面据此不请求截图。 */
  evidenceJobId: z.string().nullable(),
  evidenceSubmissionId: z.string().nullable(),
});

export const ReviewCardViewSchema = z.strictObject({
  kind: z.literal('review'),
  head: z.literal('核对'),
  title: z.string(),
  stateText: z.string().nullable(), // 通过时写「已通过」
  roundText: z.string().nullable(), // 不通过时写「剩余 n 轮」
  items: z.array(EvidenceItemViewSchema),
  carriedText: z.string().nullable(),
  footer: z.string(),
  reviewerName: z.string(), // 总管核对时写「总管」
  evidenceJobId: z.string().nullable(), // 同交回卡：读取证据截图的编号；核对卡取它核对的那次交回
  evidenceSubmissionId: z.string().nullable(),
});

/**
 * P74f：交付卡。清单沿用 EvidenceItemView；stateText 三种之外，约定已被新版本取代时写「已失效」。
 * actions.hint 在可以验收时写「哪条不符合，直接写序号和问题。」；约定新版本在等确认时写「约定第 n 版在等你确认，确认后再验收。」。
 */
export const DeliveryCardViewSchema = z.strictObject({
  kind: z.literal('delivery'),
  head: z.literal('交付'),
  title: z.string(),
  stateText: z.string(),
  /**
   * P74r8：结构化状态，与 stateText 同一处算出、永远对应。awaiting 待你验收（可验收）；waiting_agreement 待你验收但约定有新版本在等确认（暂不可验收，
   * stateText 仍写「待你验收」）；accepted 已完成；returned 未通过；void 已失效（已重新交付、这件事已停止、约定已更新三种原因）。
   * void 时 actions.preview 与 actions.accept 都为假。界面按 phase 判断只读、着色、收起，不再按 stateText 的开头判断。
   */
  phase: z.enum(['awaiting', 'waiting_agreement', 'accepted', 'returned', 'void']),
  items: z.array(EvidenceItemViewSchema),
  returnedHint: z.string().nullable(),
  doneHint: z.string().nullable(),
  actions: z.strictObject({ accept: z.boolean(), preview: z.boolean(), hint: z.string().nullable() }),
  jobId: z.string(),
  /** 读取证据截图的编号：交付时用的那次交回（约定只删条目后重排过的取重排后的那一条）；取不到为 null。 */
  evidenceJobId: z.string().nullable(),
  evidenceSubmissionId: z.string().nullable(),
  stage: z.number().int().min(1),
  /**
   * P74f-2：同一阶段重新交付时（约定只删去条目、重排后）会有几张交付卡，revision 是这张卡的修订号（第一张为 0，之后每次加 1）；
   * 只有这件事最新的一张可以验收，更早的显示失效。可省略：旧的样例不带，按 0 处理。
   */
  revision: z.number().int().min(0).optional(),
});

/**
 * P74f-2：三轮不过卡（总管用 escalate 说明卡在哪、给出办法之后落在总管私聊里的卡）。
 * letter 是办法的字母（A、B、C）；chosen 是主人选的字母，没选为 null；点办法时界面用办法的序号（从 0 起，A 为 0）调用 chooseJobOption。
 */
export const EscalationCardViewSchema = z.strictObject({
  kind: z.literal('escalation'),
  head: z.literal('提问'),
  title: z.string(),
  stateText: z.string(), // 「等你决定」「你选了 B」
  stuckAt: z.string(),
  tried: z.array(z.string()),
  optionsTitle: z.string(),
  options: z.array(z.strictObject({ letter: z.string(), title: z.string(), detail: z.string(), suggested: z.boolean(),
    /** 选了这个办法实际会改什么（中心按办法里记下的改动生成）；办法不带改动为 null。 */
    changeLine: z.string().nullable() })),
  reasonHint: z.string(),
  jobId: z.string(),
  stage: z.number().int().min(1),
  chosen: z.string().nullable(),
  /** 同一阶段第几次说明（第一次为 0）；界面点办法时一并传给 chooseJobOption，对着旧卡选被拒。可省略：按 0 处理。 */
  revision: z.number().int().min(0).optional(),
  /**
   * P74r4a：办法现在能不能选。主人已选过、或这次说明因约定更新而失效（stateText 写明「已失效：约定在重新确认」
   * 「已失效：约定已更新」）时为 false，界面把办法画成不可点。可省略：旧的样例不带，按「没选过就能选」处理。
   */
  selectable: z.boolean().optional(),
});

/** P74f：交付回执。行的标签固定五种，值由中心按记录算出。 */
export const ReceiptCardViewSchema = z.strictObject({
  kind: z.literal('receipt'),
  title: z.string(),
  rows: z.array(z.strictObject({
    // P76e：第六行「消耗」只在视图里追加，不写进这件事的记录（记录里的回执仍只有前五行）。
    label: z.enum(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本', '消耗']),
    value: z.string(),
  })),
});

export const JobCardViewSchema = z.discriminatedUnion('kind', [SubmissionCardViewSchema, ReviewCardViewSchema, DeliveryCardViewSchema, EscalationCardViewSchema, ReceiptCardViewSchema, RetroCardViewSchema, SkillCheckCardViewSchema]);

/**
 * P74e（B2）：约定卡上的两栏。执行中的事重新确认约定时，新版本的卡片显示「不受影响，照常在做」「暂停，等你确认」两栏、
 * 交付时间不变的一行和不改的退路一行。两栏由中心按改动算出（job/pause.ts），不由模型自由填写。
 */
export const JobSplitViewSchema = z.strictObject({
  continuing: z.array(z.string()),
  paused: z.array(z.string()),
  dueText: z.string(), // 「交付时间不变：11月17日 18:00 前」；没有交付时间时只写「交付时间不变」
  fallback: z.string().nullable(),
});
