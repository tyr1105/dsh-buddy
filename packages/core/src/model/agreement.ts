/**
 * 约定模型（P72a）：总管在「开工前对齐」阶段和主人谈出来的一份约定。
 *
 * 为什么要有这个对象：
 * - 总管接到一件大事，不能一上来就派活；先把「要做什么、哪些事待主人拍板、做到什么算完」写成一份约定，
 *   主人确认（固定）之后才开工。约定就是这份对齐结果。
 * - 一份约定一条记录，版本内嵌在记录里（最多 20 版）：读一条记录就能渲染约定卡、修订记录。
 * - 每一版都能追到主人的一句原话（sourceMessageId），模型不能自己凭空改约定。
 *
 * 本文件只定义结构与校验：不读时钟、不读文件、不碰宿主，全部逻辑可单测。
 * 所有数值上限来自 config/defaults.ts 的 AGREEMENT_DEFAULTS。字符数一律按完整字符计（[...s].length）。
 * 错误信息全部中文，并点出出错字段的路径，例如「pending[2].suggested：建议项必须是选项之一」。
 */
import { z } from 'zod';
import { AGREEMENT_DEFAULTS as D } from '../config/defaults.js';
import { validationMessage } from '../engine/validation.js';
import { count, nonempty, recordId, text, timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// 枚举与中文标签
// ---------------------------------------------------------------------------

/** 约定状态：待主人确认 / 已固定 / 已撤下。 */
export const AGREEMENT_STATES = ['pending', 'locked', 'withdrawn'] as const;
export const AgreementStateSchema = z.enum(AGREEMENT_STATES, { error: '约定状态必须是 pending、locked、withdrawn 之一' });
export type AgreementState = z.infer<typeof AgreementStateSchema>;
export const AGREEMENT_STATE_LABELS: Record<AgreementState, string> = {
  pending: '待你确认', locked: '已固定', withdrawn: '已撤下',
};

/** 版本状态：待确认 / 确认前被新版取代 / 当前生效 / 曾经生效、已被新版替换。 */
export const VERSION_STATES = ['pending', 'superseded', 'locked', 'replaced'] as const;
export const VersionStateSchema = z.enum(VERSION_STATES, { error: '版本状态必须是 pending、superseded、locked、replaced 之一' });
export type VersionState = z.infer<typeof VersionStateSchema>;
export const VERSION_STATE_LABELS: Record<VersionState, string> = {
  pending: '待你确认', superseded: '已由新版取代', locked: '已固定', replaced: '已被新版替换',
};

/**
 * 版本来源：首次提交 / 待确认时主人提出修改 / 固定后主人的小改动直接生效 / 固定后改动大需重新确认 /
 * 执行中的提问在约定里推不出答案，总管出新版本请主人确认（P74r2b，job_question：起因是提问，不是主人的话）。
 */
export const VERSION_SOURCES = ['draft', 'owner_revision', 'owner_instruction', 'owner_reopen', 'job_question'] as const;
export const VersionSourceSchema = z.enum(VERSION_SOURCES, { error: '版本来源必须是 draft、owner_revision、owner_instruction、owner_reopen、job_question 之一' });
export type VersionSource = z.infer<typeof VersionSourceSchema>;

/** 固定的方式：按钮、文字「定了」、待你处理条目、固定后主人直接指示（amend）。 */
export const LOCK_VIAS = ['button', 'text', 'inbox', 'amend'] as const;
export const LockViaSchema = z.enum(LOCK_VIAS, { error: '固定方式必须是 button、text、inbox、amend 之一' });
export type LockVia = z.infer<typeof LockViaSchema>;

/** 已定事项的依据类型；source（有出处）由界面按出处拼文字，所以标签里留空。 */
export const BASIS_KINDS = ['source', 'convention', 'trial', 'judgement'] as const;
export const BasisKindSchema = z.enum(BASIS_KINDS, { error: '依据类型必须是 source、convention、trial、judgement 之一' });
export type BasisKind = z.infer<typeof BasisKindSchema>;
export const BASIS_KIND_LABELS: Record<BasisKind, string> = {
  source: '', convention: '通行做法', trial: '需要试过才知道', judgement: '我的判断',
};

// ---------------------------------------------------------------------------
// 文字字段：按完整字符数限长
// ---------------------------------------------------------------------------

/** 非空（去首尾空白后仍有内容）且不超过 max 个完整字符。 */
function line(max: number) {
  return nonempty
    .refine(value => value.trim().length > 0, '不能为空')
    .refine(value => [...value].length <= max, `不能超过 ${max} 字`);
}
/** 键名：小写字母开头，只含小写字母、数字、连字符，最长 16。 */
const keyText = text.regex(/^[a-z][a-z0-9-]{0,15}$/, '必须以小写字母开头，只含小写字母、数字、连字符，最长 16 位');

// ---------------------------------------------------------------------------
// 草图（平铺对象；各 layout 需要什么由 AgreementContentSchema 的 superRefine 判断）
// ---------------------------------------------------------------------------

export const SKETCH_LAYOUTS = ['page', 'flow', 'concept'] as const;
export const SKETCH_BLOCK_KINDS = ['title', 'text', 'field', 'button', 'image', 'list', 'table', 'note'] as const;

/** 草图里待定项序号标记：圆圈数字，1 起。上限 5 是待定项条数上限；是否超出当前项数由内容层判断。 */
const markSchema = z.number({ error: '必须是整数' }).int('必须是整数').min(1, '序号从 1 起').max(D.PENDING_MAX, `不能超过 ${D.PENDING_MAX}`)
  // P72j J3：真模型曾把圆圈「5」挂在与第 5 个待定项无关的节点上，所以把含义写进参数说明里。
  .describe('这个元素对应第几个待定项（从 1 起，1 表示 pending 的第一项）；与待定项无关的元素不要写');

/** 页面草图里的一个块；只有 table 才能带 rows。 */
export const SketchBlockSchema = z.strictObject({
  kind: z.enum(SKETCH_BLOCK_KINDS, { error: '块类型必须是 title、text、field、button、image、list、table、note 之一' }),
  text: line(D.SKETCH_TEXT_MAX_CHARS),
  required: z.boolean({ error: '必须是布尔值' }).optional(),
  mark: markSchema.optional(),
  rows: z.array(z.array(line(D.SKETCH_CELL_MAX_CHARS))
    .min(D.SKETCH_TABLE_COLS_MIN, `每行至少 ${D.SKETCH_TABLE_COLS_MIN} 格`)
    .max(D.SKETCH_TABLE_COLS_MAX, `每行最多 ${D.SKETCH_TABLE_COLS_MAX} 格`))
    .min(1, '表格至少 1 行').max(D.SKETCH_TABLE_ROWS_MAX, `表格最多 ${D.SKETCH_TABLE_ROWS_MAX} 行`).optional(),
});
export type SketchBlock = z.infer<typeof SketchBlockSchema>;

export const SketchScreenSchema = z.strictObject({
  title: line(D.SKETCH_SCREEN_TITLE_MAX_CHARS),
  blocks: z.array(SketchBlockSchema).max(D.SKETCH_BLOCKS_MAX, `每屏最多 ${D.SKETCH_BLOCKS_MAX} 个块`),
});
export const SketchStepSchema = z.strictObject({
  text: line(D.SKETCH_STEP_MAX_CHARS),
  actor: line(D.SKETCH_ACTOR_MAX_CHARS).optional(),
  note: line(D.SKETCH_NOTE_MAX_CHARS).optional(),
  mark: markSchema.optional(),
});
export const SketchNodeSchema = z.strictObject({
  id: keyText,
  text: line(D.SKETCH_NODE_MAX_CHARS),
  note: line(D.SKETCH_NOTE_MAX_CHARS).optional(),
  mark: markSchema.optional(),
});
export const SketchLinkSchema = z.strictObject({
  from: keyText,
  to: keyText,
  text: line(D.SKETCH_LINK_TEXT_MAX_CHARS).optional(),
});

/** 草图：layout 加三个可选数组。不用联合类型，因为工具参数的根节点不能是联合（见 tools/json-schema.ts）。 */
export const SketchSchema = z.strictObject({
  layout: z.enum(SKETCH_LAYOUTS, { error: 'layout 必须是 page、flow、concept 之一' }),
  screens: z.array(SketchScreenSchema).max(D.SKETCH_SCREENS_MAX, `最多 ${D.SKETCH_SCREENS_MAX} 屏`).optional(),
  steps: z.array(SketchStepSchema).max(D.SKETCH_STEPS_MAX, `最多 ${D.SKETCH_STEPS_MAX} 步`).optional(),
  nodes: z.array(SketchNodeSchema).max(D.SKETCH_NODES_MAX, `最多 ${D.SKETCH_NODES_MAX} 个节点`).optional(),
  links: z.array(SketchLinkSchema).max(D.SKETCH_LINKS_MAX, `最多 ${D.SKETCH_LINKS_MAX} 条连线`).optional(),
});
export type Sketch = z.infer<typeof SketchSchema>;

// ---------------------------------------------------------------------------
// 内容：待定项、已定项、范围、怎样算做完
// ---------------------------------------------------------------------------

/** 一个待主人定的事项：建议项必须在选项里；chosen 固定时才写，提交时恒为 null。 */
export const PendingItemSchema = z.strictObject({
  key: keyText,
  question: line(D.QUESTION_MAX_CHARS),
  options: z.array(line(D.OPTION_MAX_CHARS))
    .min(D.OPTIONS_MIN, `选项至少 ${D.OPTIONS_MIN} 个`).max(D.OPTIONS_MAX, `选项最多 ${D.OPTIONS_MAX} 个`),
  suggested: text,
  reason: line(D.REASON_MAX_CHARS),
  chosen: text.nullable(),
});
export type PendingItem = z.infer<typeof PendingItemSchema>;

/** 一条已定的事和它的依据：source 要有出处（出处原文 refText 由中心从存储里读出，模型写不进）。 */
export const DecidedItemSchema = z.strictObject({
  text: line(D.DECIDED_MAX_CHARS),
  basis: z.strictObject({ kind: BasisKindSchema, ref: text.nullable(), refText: text.nullable() }),
});
export type DecidedItem = z.infer<typeof DecidedItemSchema>;

/**
 * P74r9：验收之后要不要对外发布，写成约定的一项内容（主人确认的就是中心照办的）。
 * null 或没有这一项（旧数据）表示这件事不含对外发布；对象表示验收之后对外发布，how 写发布到哪里、用什么方式（一行字）。
 */
export const LaunchSchema = z.strictObject({
  how: line(D.LAUNCH_HOW_MAX_CHARS).refine(value => !/[\r\n]/.test(value), '必须写成一行'),
  // P81：发布到主人电脑上的哪个文件夹（已整理的绝对路径，由中心在提交约定时按 project/local-dir.ts 校验后保存）。
  // 可省略：旧约定没有这一项，行为不变；一份约定最多一个。
  localDir: z.string().min(1, '发布位置不能为空').refine(value => [...value].length <= 200, '发布位置不能超过 200 个字符').optional(),
  /**
   * P81r1（第 3.3 节）：提交约定时，发布位置已经存在、并且里面至少有一个条目。
   * 只在为真时保存；旧约定没有这一项。约定卡据此多一句「已有文件夹，发布命令可以修改和删除其中的文件」。
   */
  localDirHasFiles: z.boolean().optional(),
});
export type Launch = z.infer<typeof LaunchSchema>;

export const ChangeMarkSchema = z.strictObject({
  section: z.enum(['summary', 'sketch', 'pending', 'decided', 'scopeIn', 'scopeOut', 'doneWhen', 'launch'], { error: '改动区块不正确' }),
  kind: z.enum(['added', 'changed', 'removed'], { error: '改动类型必须是 added、changed、removed 之一' }),
  key: text.optional(),
  index: count.optional(),
  // P72h：removed 标记带上被删条目的原文（待定项写问题），界面据此写「删去：某某」；旧数据没有这一项。
  text: text.optional(),
});
export type ChangeMark = z.infer<typeof ChangeMarkSchema>;

/** 数组字段：先限条数，再限单条字数。 */
const lines = (min: number, max: number, itemMax: number, label: string) =>
  z.array(line(itemMax)).min(min, `${label}至少 ${min} 条`).max(max, `${label}最多 ${max} 条`);

/** 一版约定的内容；跨字段规则（草图与 layout 对应、标记不越界、依据的出处、字节上限）在 superRefine 里。 */
export const AgreementContentSchema = z.strictObject({
  summary: line(D.SUMMARY_MAX_CHARS),
  sketch: SketchSchema,
  pending: z.array(PendingItemSchema)
    .min(D.PENDING_MIN, `待你定的事项至少 ${D.PENDING_MIN} 项`).max(D.PENDING_MAX, `待你定的事项最多 ${D.PENDING_MAX} 项`),
  decided: z.array(DecidedItemSchema).max(D.DECIDED_MAX, `已定的事最多 ${D.DECIDED_MAX} 条`),
  scopeIn: lines(D.SCOPE_IN_MIN, D.SCOPE_IN_MAX, D.SCOPE_ITEM_MAX_CHARS, '范围内'),
  scopeOut: lines(0, D.SCOPE_OUT_MAX, D.SCOPE_ITEM_MAX_CHARS, '范围外'),
  doneWhen: lines(D.DONE_WHEN_MIN, D.DONE_WHEN_MAX, D.DONE_WHEN_MAX_CHARS, '怎样算做完'),
  // P74r9：对外发布这一项；旧数据没有这个字段，读取时按 null 处理（见 launchOf）。
  launch: LaunchSchema.nullable().optional(),
}).superRefine((content, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  const { sketch } = content;

  // 1. 草图：layout 决定必须有哪个数组、不得出现哪些数组。
  const forbid = (names: ('screens' | 'steps' | 'nodes' | 'links')[]) => {
    for (const name of names) if (sketch[name] !== undefined) bad(['sketch', name], `${sketch.layout} 草图不能带 ${name}`);
  };
  if (sketch.layout === 'page') {
    forbid(['steps', 'nodes', 'links']);
    const screens = sketch.screens;
    if (screens === undefined || screens.length < 1) bad(['sketch', 'screens'], 'page 草图必须有 1 到 3 屏');
    screens?.forEach((screen, i) => {
      if (screen.blocks.length < 1) bad(['sketch', 'screens', i, 'blocks'], '每屏至少 1 个块');
    });
  } else if (sketch.layout === 'flow') {
    forbid(['screens', 'nodes', 'links']);
    if (sketch.steps === undefined || sketch.steps.length < D.SKETCH_STEPS_MIN) {
      bad(['sketch', 'steps'], `flow 草图必须有 ${D.SKETCH_STEPS_MIN} 到 ${D.SKETCH_STEPS_MAX} 步`);
    }
  } else {
    forbid(['screens', 'steps']);
    const nodes = sketch.nodes;
    if (nodes === undefined || nodes.length < D.SKETCH_NODES_MIN) {
      bad(['sketch', 'nodes'], `concept 草图必须有 ${D.SKETCH_NODES_MIN} 到 ${D.SKETCH_NODES_MAX} 个节点`);
    }
    const ids = new Set<string>();
    nodes?.forEach((node, i) => {
      if (ids.has(node.id)) bad(['sketch', 'nodes', i, 'id'], `节点 id「${node.id}」重复`);
      ids.add(node.id);
    });
    sketch.links?.forEach((link, i) => {
      if (!ids.has(link.from)) bad(['sketch', 'links', i, 'from'], `连线起点「${link.from}」不是已有节点`);
      if (!ids.has(link.to)) bad(['sketch', 'links', i, 'to'], `连线终点「${link.to}」不是已有节点`);
    });
  }
  // 只有 table 块能带 rows。
  sketch.screens?.forEach((screen, s) => screen.blocks.forEach((block, b) => {
    if (block.kind !== 'table' && block.rows !== undefined) bad(['sketch', 'screens', s, 'blocks', b, 'rows'], '只有 table 块能带 rows');
  }));

  // 2. 草图里的序号标记不能超过待定项数。
  const marks: { mark: number | undefined; path: (string | number)[] }[] = [
    ...(sketch.screens ?? []).flatMap((screen, s) => screen.blocks.map((block, b) => ({ mark: block.mark, path: ['sketch', 'screens', s, 'blocks', b, 'mark'] }))),
    ...(sketch.steps ?? []).map((step, i) => ({ mark: step.mark, path: ['sketch', 'steps', i, 'mark'] })),
    ...(sketch.nodes ?? []).map((node, i) => ({ mark: node.mark, path: ['sketch', 'nodes', i, 'mark'] })),
  ];
  for (const { mark, path } of marks) {
    if (mark !== undefined && mark > content.pending.length) bad(path, `序号 ${mark} 超过了待你定的事项数（${content.pending.length} 项）`);
  }

  // 3. 待定项：key 不重复；选项去首尾空白后不重复；建议项与已选项必须在选项里。
  const keys = new Set<string>();
  content.pending.forEach((item, i) => {
    if (keys.has(item.key)) bad(['pending', i, 'key'], `key「${item.key}」重复`);
    keys.add(item.key);
    const trimmed = item.options.map(option => option.trim());
    if (new Set(trimmed).size !== trimmed.length) bad(['pending', i, 'options'], '选项去掉首尾空白后不能重复');
    if (!item.options.includes(item.suggested)) bad(['pending', i, 'suggested'], '建议项必须是选项之一');
    if (item.chosen !== null && !item.options.includes(item.chosen)) bad(['pending', i, 'chosen'], '已选项必须是选项之一');
  });

  // 4. 已定的事：source 必须有出处和出处原文，其他类型两者都必须为空。
  content.decided.forEach((item, i) => {
    const { kind, ref, refText } = item.basis;
    if (kind === 'source') {
      if (!ref || !refText) bad(['decided', i, 'basis'], 'source 类型的依据必须同时有出处和出处原文');
    } else if (ref !== null || refText !== null) {
      bad(['decided', i, 'basis'], `${kind} 类型的依据不能带出处`);
    }
  });

  // 6. 整份内容的 JSON 字节数上限（中文按 UTF-8 计），防止卡片和唤醒包被一版内容撑爆。
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (bytes > D.CONTENT_MAX_BYTES) bad([], `约定内容太长：${bytes} 字节，上限 ${D.CONTENT_MAX_BYTES} 字节，请精简`);
});
export type AgreementContent = z.infer<typeof AgreementContentSchema>;

/**
 * P74r10：去掉发布方式首尾的空白，并把末尾的句号、分号、逗号、顿号（全角和半角）反复去掉，直到末尾不是这些符号。
 * 为什么：总管写的 how 常以句号结尾，约定卡那一行会拼成「……目录。。发布前单独请你批准。」；中间的标点不动。
 */
export function stripTrailingPunctuation(how: string): string {
  let value = how.trim();
  for (;;) {
    const next = value.replace(/[。；，、.;,]+$/u, '').trim();
    if (next === value) return value;
    value = next;
  }
}

/**
 * P74r9：一版约定的对外发布项；没有这一项（旧数据）或为 null 都返回 null，全中心只用这一处读，不各写一套。
 * P74r10：读到的 how 一律先去掉末尾的标点（旧数据同样处理），所有拼句子的地方都不会出现重复的句号。
 */
export function launchOf(content: Pick<AgreementContent, 'launch'>): Launch | null {
  const launch = content.launch ?? null;
  return launch === null ? null : { ...launch, how: stripTrailingPunctuation(launch.how) };
}

// ---------------------------------------------------------------------------
// 版本与约定
// ---------------------------------------------------------------------------

/**
 * 起因是提问的版本（source 为 job_question）记下的提问：哪一件事、哪个提问事件、谁问的、原文。
 * 这样的版本没有主人的话作依据（sourceMessageId 为空），起因要能追到那一条提问，也要能和「主人发话后修订」区分开。
 */
export const VersionAskOriginSchema = z.strictObject({
  jobId: recordId('job'), askEventId: recordId('jev'), askerId: recordId('b'), askerName: nonempty, text: nonempty,
});
export type VersionAskOrigin = z.infer<typeof VersionAskOriginSchema>;

export const AgreementVersionSchema = z.strictObject({
  no: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '版本号从 1 起'),
  state: VersionStateSchema,
  source: VersionSourceSchema,
  askOrigin: VersionAskOriginSchema.nullable().optional(), // P74r2b：起因是提问时才有；旧数据没有这个字段
  stopsJob: z.boolean().optional(), // P74f-2：这一版写明「不再做」，主人确认后由中心停下这件事；旧数据没有这个字段
  sourceMessageId: recordId('m').nullable(), // 这一版依据的主人消息；主人在宿主会话里直聊时可能为 null
  sourceThread: nonempty.nullable(),
  wakeId: nonempty.nullable(), // 提交这一版的唤醒单
  content: AgreementContentSchema,
  changes: z.array(ChangeMarkSchema), // 中心对比上一版算出，不由模型填写
  changeNote: text.refine(value => [...value].length <= D.CHANGE_NOTE_MAX_CHARS, `不能超过 ${D.CHANGE_NOTE_MAX_CHARS} 字`),
  cardMessageId: nonempty.nullable(), // 已落楼的卡片消息 id（P72b/c 维护）
  createdAt: timestamp,
  lockedAt: timestamp.nullable(),
  lockedVia: LockViaSchema.nullable(),
  confirmMessageId: nonempty.nullable(),
  choices: z.record(text, text).nullable(), // 固定时 key → 最终选项
  adoption: z.strictObject({ adopted: count, total: count }).nullable(), // 只在第一次确认时记录
});
export type AgreementVersion = z.infer<typeof AgreementVersionSchema>;

export const AgreementSchema = z.strictObject({
  id: recordId('agr'),
  botId: recordId('b'), // 总管
  projectId: recordId('prj'),
  topicId: recordId('ptp'),
  originThread: nonempty, // 约定卡发在哪个线程（固定为总管私聊，即总管 id）
  title: line(D.TITLE_MAX_CHARS),
  state: AgreementStateSchema,
  versions: z.array(AgreementVersionSchema).min(1, '至少 1 个版本').max(D.VERSION_MAX, `最多 ${D.VERSION_MAX} 个版本`),
  inboxId: nonempty.nullable(), // 当前待确认的「待你处理」条目（P72c 维护）
  withdrawn: z.strictObject({
    at: timestamp, reason: text, wakeId: nonempty.nullable(), noticeMessageId: nonempty.nullable(),
  }).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).superRefine((agreement, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  const { versions } = agreement;
  // 版本号从 1 连续递增。
  versions.forEach((version, i) => {
    if (version.no !== i + 1) bad(['versions', i, 'no'], `版本号必须从 1 连续递增，这里应为 ${i + 1}`);
  });
  // 至多一个 pending 且只能是最新版；至多一个 locked。
  const pendingIdx = versions.flatMap((version, i) => version.state === 'pending' ? [i] : []);
  if (pendingIdx.length > 1) bad(['versions'], '待确认的版本最多只能有一个');
  if (pendingIdx.length === 1 && pendingIdx[0] !== versions.length - 1) bad(['versions'], '待确认的版本只能是最新版');
  const lockedCount = versions.filter(version => version.state === 'locked').length;
  if (lockedCount > 1) bad(['versions'], '已固定的版本最多只能有一个');
  // 状态与版本对应。
  const latest = versions[versions.length - 1];
  if (agreement.state === 'locked') {
    if (lockedCount !== 1) bad(['state'], '已固定的约定必须恰有一个已固定的版本');
    if (pendingIdx.length > 0) bad(['state'], '已固定的约定不能还有待确认的版本');
  }
  if (agreement.state === 'pending' && latest?.state !== 'pending') bad(['state'], '待确认的约定，最新版必须是待确认');
  if (agreement.state === 'withdrawn' && agreement.withdrawn === null) bad(['withdrawn'], '已撤下的约定必须记录撤下信息');
});
export type Agreement = z.infer<typeof AgreementSchema>;

// ---------------------------------------------------------------------------
// 带路径的校验入口
// ---------------------------------------------------------------------------

/** 把 zod 的路径写成 pending[2].suggested 这种人能读的样子。 */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : `${out === '' ? '' : '.'}${String(part)}`;
  return out;
}

/** 校验并抛中文错误，路径写成 pending[2].suggested；与 parseInput 同口径，只是路径格式更好读。 */
export function parseWithPaths<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(`${label}无效：${result.error.issues.map(issue => {
    const field = formatIssuePath(issue.path);
    return `${field === '' ? label : field}：${validationMessage(issue)}`;
  }).join('；')}`);
}
