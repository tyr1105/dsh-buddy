/**
 * 交账里「已改好 / 已完成」这类完成声明的核对（P76q 第 2 条；P85 重做了证据口径和处理办法）。
 *
 * 为什么需要：真实模型验证里，总管回报「已改好：两个页面……的提示文字都不用感叹号」，
 * 实际只是通知了执行者，既没有文件变更，也没有检查结果或交付回执。主人会以为已经改好。
 * 这一条不靠改提示词：交账锁定之后、发给主人之前，把完成声明与可核对的证据对一遍，没有证据就在这段话末尾补一句如实的话。
 *
 * 三类证据（有一条就算）：
 * - 有检查结果：交账里的验证层级不是「未验证」；
 * - 有文件变更：交账写的位置是本地文件，而且那个文件在本回合被改过（URL、含变量的写法不算）；
 * - 有交付回执：回合属于某件事，而且这件事的交付或验收发生在这一回合期间（P85：不再看这位总管名下别的事；
 *   回合不属于某件事时没有这一类证据）。
 * 另有两类只用来放行对应的句子、不算上面三类（不整段放行）：
 * - 本回合中心工具已经办成的事（见 centralToolKindsOf），按分句放行；
 * - P88r1：这一句说的是这位总管名下最近验收完成的一件事（句子与它的标题有不短于 3 个字符的公共片段），按句放行。
 *   理由：验收记录就是中心的可查证据。总管在主人发起的私聊里如实说「签到页已经做完，你已验收」时，这一回合没有检查、文件变更
 *   和回执，不放行就会在一句对的话后面补「没有可以核对的结果」。已知边界：同一句里顺带说的另一件事（「签到页已验收，反馈页也做完了」）
 *   也随这一句放行，不再核对；别的句子里的完成说法照旧核对。名单为空时与没有这一类完全相同。
 *
 * 处理办法（P85）：动词名单只留指「交付物做成」的说法（改好、修好、修复、做好、做完、完成、上线）；
 * 发现没有证据的完成声明时，原话一字不改，在这段话的末尾另起一行补一句固定的话，一段话只补一次。
 * 不再在句子中间替换动词（原来会把中心已办成的事写成「还没有验证」，主语和语序也会错）。
 * 问句（「已经改好了吗」）、紧贴动词之前带否定的（「还没有改好了」）和单纯描述流程的话（「完成标准」）都不算声明。
 * 只对总管生效：执行者的交付由交回、核对和交付卡把关，不走这条文字核对（见进度记录与 docs/questions.md）。
 *
 * 本文件只用注入的文件接口与存储，不读时钟、不联网。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot, WakeTicket } from '../model/index.js';
import { isSensitive, within } from '../gate/paths.js';
import { JOB_DEFAULTS as D } from '../config/defaults.js';

/** 三类可核对的证据。 */
export interface CompletionEvidence {
  /** 有检查结果：交账里的验证层级不是 none。 */
  checked: boolean;
  /** 有文件变更：交账写的位置是一个本回合被改过的本地文件。 */
  fileChanged: boolean;
  /** 有交付回执：回合所属的这件事，在本回合期间交付或验收过。 */
  receipt: boolean;
}

/** 有一条证据就算可以正常说「已完成」。 */
export function hasCompletionEvidence(evidence: CompletionEvidence): boolean {
  return evidence.checked || evidence.fileChanged || evidence.receipt;
}

/** 没有证据的完成声明，在这段话末尾另起一行补的固定一句（给主人看，逐字）。 */
export const UNVERIFIED_CLAIM_NOTE = '（以上关于已经完成的说法，这一回合没有可以核对的结果。）';

/**
 * 本回合里成功办成事的中心工具种类（口径见 centralToolKindsOf）：
 * agreement 约定提交（含直接生效的小改动，改交付时间走这里）；memory 记忆的记住、删除、更正；job 派活与改派。
 */
export type CentralToolKind = 'agreement' | 'memory' | 'job';

/**
 * 每种中心工具办成的事，总管最常用哪些词来说：一句话里出现这些词，又有对应的工具本回合成功过，
 * 这一句里的完成说法就不算「没有证据」。按句判断而不是按整段放行：总管办成了约定提交，
 * 不等于它同一段话里「页面已改好」也有了证据。
 */
const CENTRAL_TOOL_WORDS: Readonly<Record<CentralToolKind, RegExp>> = {
  agreement: /约定|交付时间|交付日期|交付时限/,
  memory: /记忆|记住|记下|规矩|偏好/,
  job: /派|改派|交给|执行者|核对人|换人|负责人/,
};

/** 一条完成声明的写法：动词前面有「已 / 已经 / 都已 / 都已经」，或者动词后面带「了 / 啦」。 */
function claimPattern(verb: string): RegExp {
  return new RegExp(`(?:已经?|都已|都已经?)${verb}(?:了|啦)?|${verb}(?:了|啦)`, 'g');
}

/**
 * 只留指「交付物做成」的动词。按从长到短排列，避免「修改好」被「改好」先截掉一半。
 * 「更新、调整、删除、添加、发布」不在名单里（P85）：它们正是总管用中心工具办事之后最常说的话，不是交付物做成的说法。
 */
const CLAIM_PATTERNS: readonly RegExp[] = ['修改好', '改好', '修好', '修复', '完成', '做好', '做完', '上线', '解决', '处理好'].map(claimPattern);

/** 问句不当作声明：「已经改好了吗」「是否已完成」都可能是在问，不是在说。 */
function isQuestion(sentence: string): boolean {
  return /[?？]|吗|是否|有没有/.test(sentence);
}

/** 一句话里的分句边界：逗号、分号、顿号、冒号和各种句末标点。 */
const CLAUSE_BOUNDARY = /[，,；;、：:。！？!?\n]/;

/**
 * 否定只认紧贴在声明之前的写法（P85）：没有、没、未、尚未、还没、并未，与声明之间不隔标点。
 * 「没问题，已经修复了」里的「没」隔着逗号，不算否定；「还没有改好了」算。
 */
function isNegated(sentence: string, index: number): boolean {
  const before = sentence.slice(0, index);
  // 只看声明所在分句里、声明之前的那一段。
  let clauseStart = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(before[i]!)) { clauseStart = i + 1; break; }
  }
  return /(?:没有|没|未|尚未|还没有?|并未|并没有?)$/.test(before.slice(clauseStart));
}

/** 这一句里有没有完成声明；问句和紧贴动词之前带否定的不算。 */
function sentenceHasClaim(sentence: string): boolean {
  if (isQuestion(sentence)) return false;
  return CLAIM_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sentence)) !== null) {
      if (!isNegated(sentence, match.index)) return true;
    }
    return false;
  });
}

/** 按句切分（只按句末标点和换行），保留原来的标点和换行。 */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[。！？!?\n])/).filter(part => part !== '');
}

/** 这一句是否被本回合办成的中心工具放行：句子里出现对应种类的说法用词。 */
function exemptedByTools(sentence: string, kinds: ReadonlySet<CentralToolKind>): boolean {
  for (const kind of kinds) if (CENTRAL_TOOL_WORDS[kind].test(sentence)) return true;
  return false;
}

/** 去掉标点、符号和空白，只留文字（比较标题片段时用）。 */
function bare(text: string): string {
  return text.replace(/[\p{P}\p{S}\s]/gu, '');
}

/**
 * P88r1：这一句是否说的是一件「最近已验收完成」的事：去掉标点和空白之后，句子与某个标题有不短于
 * CLAIM_TITLE_MATCH_MIN_CHARS 个字符的公共连续片段。这件事有中心的验收记录可查，所以这一句里的完成说法不算没有证据。
 * 放行的单位是句（不是分句）：标题片段常在「签到页已经做完：」这一分句，其余分句不重复写标题。
 */
function exemptedByAccepted(sentence: string, acceptedTitles: readonly string[]): boolean {
  const min = D.CLAIM_TITLE_MATCH_MIN_CHARS;
  const plain = [...bare(sentence)];
  if (plain.length < min) return false;
  const whole = plain.join('');
  return acceptedTitles.some(title => {
    const chars = [...bare(title)];
    for (let start = 0; start + min <= chars.length; start += 1) {
      if (whole.includes(chars.slice(start, start + min).join(''))) return true;
    }
    return false;
  });
}

/**
 * 这段文字里有没有「没有证据的」完成声明（问句、否定句、被本回合办成的中心工具放行的句子、
 * 说的是最近已验收完成的事的句子不算）。acceptedTitles 可省略（省略等于名单为空，行为与 P88r1 之前完全相同）。
 */
export function hasCompletionClaim(text: string, toolKinds: ReadonlySet<CentralToolKind> = new Set(), acceptedTitles: readonly string[] = []): boolean {
  // 复验 C1：放行以分句为单位。问句整句不算；其余按逗号、分号等切成分句，
  // 一个含完成动词的分句只有它自己里面有对应用词才放行，别的分句里的词不能替它放行。
  // P88r1：已验收完成的事按「句」放行（与中心工具那一类并列）。
  return sentencesOf(text).some(sentence => !isQuestion(sentence) && !exemptedByAccepted(sentence, acceptedTitles)
    && sentence.split(/(?<=[，,；;、：:])/).some(clause => sentenceHasClaim(clause) && !exemptedByTools(clause, toolKinds)));
}

/**
 * 有没有证据的完成声明时，在这段话的末尾另起一行补固定的一句，原话一字不改；没有声明、或这一句已经补过，原样返回。
 * 一段话只补一次：同一段文字再处理一次不变。
 */
export function noteUnverifiedClaims(text: string, toolKinds: ReadonlySet<CentralToolKind> = new Set(), acceptedTitles: readonly string[] = []): string {
  if (text.includes(UNVERIFIED_CLAIM_NOTE) || !hasCompletionClaim(text, toolKinds, acceptedTitles)) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${UNVERIFIED_CLAIM_NOTE}`;
}

/**
 * 这件事在这一回合期间有没有新的交付或验收：交付时间或验收时间不早于回合开始。
 * 更早的交付、验收是别的回合的事，不能当作本回合这句话的凭据。
 */
function freshReceipt(job: { deliveredAt: number | null; acceptedAt: number | null }, since: number): boolean {
  return (job.deliveredAt !== null && job.deliveredAt >= since) || (job.acceptedAt !== null && job.acceptedAt >= since);
}

/**
 * 这次交账有没有交付回执（P85 起只认这一回合自己的）：
 * 回合不属于某件事时不认交付回执（总管私聊里的话和名下别的事无关）；
 * 回合属于某件事时，只认这件事在回合期间新产生的交付或验收。
 * 只看「有这件事的回执」，不把通知过队友、发过消息当成凭据。
 */
function receiptEvidence(ctx: HubContext, wake: Pick<WakeTicket, 'jobId' | 'startedAt'>): boolean {
  if (!wake.jobId) return false;
  const job = ctx.store.table('jobs').get(wake.jobId);
  return job !== null && freshReceipt(job, wake.startedAt);
}

/**
 * 交账写的位置里有没有一个本次回合动过的本地文件（修改时间不早于回合开始）。
 * 只认中心根目录（含队友文件夹、项目文件夹、共享目录）里的普通文件；URL、含变量的写法、敏感路径都不算。
 * 读不到（不存在、没有权限）就当这一项不成立，不抛错：核对不能反过来挡住交账。
 */
async function fileChangeEvidence(ctx: HubContext, bot: Bot, changes: ReadonlyArray<{ where: string }>, since: number): Promise<boolean> {
  const rootDir = ctx.settings.rootDir;
  for (const change of changes.slice(0, 20)) {
    const where = change.where.trim();
    if (where === '' || /^[a-z][a-z0-9+.-]*:/i.test(where) || /[$`*?\u0000]/.test(where)) continue;
    const path = posix.resolve(bot.homeDir, where);
    if (isSensitive(path) || !within(path, rootDir)) continue;
    try {
      const stat = await ctx.fs.stat(path);
      if (stat?.isFile === true && stat.mtimeMs >= since) return true;
    } catch { /* 读不到就当没有这一项证据 */ }
  }
  return false;
}

/** 按交账内容算出三类证据；由交账入口在保存之前调用。 */
export async function completionEvidenceFor(ctx: HubContext, bot: Bot, wake: Pick<WakeTicket, 'jobId' | 'startedAt'>,
  input: { worldChanges: ReadonlyArray<{ where: string }>; verification: { level: string } }): Promise<CompletionEvidence> {
  return {
    checked: input.verification.level !== 'none',
    fileChanged: await fileChangeEvidence(ctx, bot, input.worldChanges, wake.startedAt),
    receipt: receiptEvidence(ctx, wake),
  };
}

/**
 * 本回合里成功办成事的中心工具种类（P85 第 3.4 节第 1 点的口径）。
 * 记录办法：工具统一入口 defineTool 在 hub_agreement_submit、hub_memory、hub_job_manage（mode 为 assign 或 reassign）
 * 返回成功时，把种类记在 ctx.runtime.centralToolOk[唤醒单编号] 里；这里读出来，交账处理完就清掉。
 * 只记内存、不落盘：只有同一回合的交账会读它，重启后不恢复（多出的后果只是少放行一句，仍会补那句如实的话，不会漏核对）。
 */
export function centralToolKindsOf(ctx: HubContext, wakeId: string): ReadonlySet<CentralToolKind> {
  return ctx.runtime.centralToolOk?.get(wakeId) ?? new Set();
}

/** 交账处理完之后清掉这一回合的记录，避免内存里越积越多。 */
export function clearCentralToolKinds(ctx: HubContext, wakeId: string): void {
  ctx.runtime.centralToolOk?.delete(wakeId);
}

/** 工具成功时记一笔（由 defineTool 调用）。 */
export function recordCentralToolOk(ctx: HubContext, wakeId: string, kind: CentralToolKind): void {
  const map = (ctx.runtime.centralToolOk ??= new Map());
  const kinds = map.get(wakeId) ?? new Set<CentralToolKind>();
  kinds.add(kind);
  map.set(wakeId, kinds);
  // 长期没有交账的唤醒单不会自己清；只留最近的 200 条，防止内存无限增长。
  while (map.size > 200) map.delete(map.keys().next().value as string);
}
