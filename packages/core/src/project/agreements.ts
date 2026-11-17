/**
 * 约定服务（P72a）：查询、提交（新建、修订、固定后改动、撤下）、固定（状态转换）。
 *
 * 几条原则：
 * - 约定只能「根据主人的话」提交或修改：提交必须发生在主人的话叫醒的回合里，每一版都记下主人那句原话的 id，
 *   模型无法自己凭空改约定；同一句话对同一份约定最多出一版。
 *   P74r2b 的唯一例外：执行链回合里，总管为这件事一个没回答的提问对已固定的约定 revise，出新版本请主人确认
 *   （四个条件缺一不可，见 agreement-chain.ts）；这样的版本起因记为那条提问（askOrigin），不伪造主人消息，主人确认才固定。
 * - 全部校验在任何写入之前做完：失败时不写表、不建项目、不耗随机数（取 id 一律排在校验之后）。
 * - applyLock 是纯函数，只算出「固定后的约定」，写表、发消息、叫醒总管、处理待你处理条目由 P72c 负责。
 * - 本文件不注册工具、不往线程里写约定卡、不建收件箱条目（那是 P72b、P72c 的事）。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { posix } from 'node:path';
import { AGREEMENT_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import {
  AgreementContentSchema, AgreementSchema, launchOf, parseWithPaths,
  type Agreement, type AgreementContent, type AgreementVersion, type LockVia,
} from '../model/agreement.js';
import { LOCAL_DIR_REASONS, localDirRefusal } from './local-dir.js';
import type { ThreadMessage } from '../model/outreach.js';
import type { WakeTicket } from '../model/wake.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { isConfirmPhrase } from './agreement-confirm.js';
import { assertNoDispatchBeforeAgreement, assertNoMessageBeforeNewAgreement } from './agreement-dispatch-check.js';
import { withdrawAgreementInboxItems } from './agreement-inbox.js';
import {
  AgreementSubmitInputSchema, alignPendingKeys, applyChoices, assertRemovalsDeclared, computeAdoption, diffContent, findDroppedItems,
  assertAgreementBeforeLaunch, mergeContentInput, ownerWordProblems, resolveBasis, resolveLaunchLocalDir, type AgreementSubmitInput,
} from './agreement-content.js';
import { createAgreementHome } from './agreement-home.js';
import { writeAgreementTag } from './agreement-category.js';
import { pendingOwnerConfirmOf, TEAM_PENDING_AGREEMENT_ERROR } from '../team/owner-confirm.js';
import { activeJobOfAgreement, onReopenPending, onReopenWithdrawn, onAgreementLocked } from '../job/agreement-hooks.js';
import { estimateFor } from '../job/estimate.js';
import { buildPause, clipTo } from '../job/pause.js';
import { JOB_DEFAULTS } from '../config/defaults.js';
import { checkDeliveryItems, clip20, firstReordered, lostDeliveryItems, mapDeliveryItems, remapItems } from '../job/item-remap.js';
import { JobSchema, type Job, type JobPause } from '../model/job.js';
import { openAskText, putJob } from '../job/store.js';
import { followTopicTitle, versionTitleOf } from './agreement-title.js';
import {
  chainReviseAsk, CHAIN_ANSWERS_FALSE_TEXT, hasUnlinkedAsk, NOT_OWNER_TURN_TEXT, undeclaredAskText, type ChainAsk,
} from './agreement-chain.js';

/** B2 的三项只用于正在做的事重新确认约定时的报错（原文）。 */
const PAUSE_ONLY_TEXT = 'continuing、paused、fallback 只用于正在做的事重新确认约定';
/** P74r2c：传了 deliveryItems 时，报错里把这个参数名加进去（没传时文字不变）。 */
function pauseOnlyText(input: AgreementSubmitInput): string {
  if (input.stopsJob !== undefined) return 'stopsJob、continuing、paused、fallback、deliveryItems 只用于这份约定有进行中的事、重新请主人确认的时候（mode revise）';
  return input.deliveryItems === undefined ? PAUSE_ONLY_TEXT : 'continuing、paused、fallback、deliveryItems 只用于正在做的事重新确认约定';
}
/** 这次提交有没有带「正在做的事重新确认约定」才能用的参数。 */
function hasPauseParams(input: AgreementSubmitInput): boolean {
  return input.continuing !== undefined || input.paused !== undefined || input.fallback !== undefined || input.deliveryItems !== undefined
    || input.stopsJob !== undefined;
}
/** 正在做的事重新确认约定却没写两栏时的报错（原文）。 */
const PAUSE_REQUIRED_TEXT = '这件事正在做，请写明哪些照常在做（continuing）、哪些暂停（paused）';

/**
 * P81r1（第 3.2 节第 4 条、第 3.3 节）：提交约定时查一次磁盘（经注入的文件接口）。
 * - 上一级文件夹必须已经存在、并且是文件夹；不存在时拒绝，读不到（权限等错误）时同样拒绝，原因逐字；
 * - 发布位置已存在、并且里面至少有一个条目时，在发布一项里记下 localDirHasFiles（只在为真时保存）；
 *   读不到时按「有文件」处理（卡片上的提醒宁可多一句，也不漏掉主人已有的文件）。
 * 只在这一版提交里写了 localDir 时查；沿用上一版位置或这一版没有发布时不查，旧约定的行为不变。
 * 必须在任何写入之前调用。
 */
async function checkLaunchLocalDirOnDisk(ctx: HubContext, content: AgreementContent, input: AgreementSubmitInput): Promise<AgreementContent> {
  const launch = launchOf(content);
  if (launch === null || launch.localDir === undefined || input.launch?.localDir === undefined) return content;
  const parent = posix.dirname(launch.localDir);
  let parentStat: Awaited<ReturnType<HubContext['fs']['stat']>>;
  try { parentStat = await ctx.fs.stat(parent); }
  catch { throw new Error(localDirRefusal(LOCAL_DIR_REASONS.parentUnreadable)); }
  if (parentStat === null || !parentStat.isDir) throw new Error(localDirRefusal(LOCAL_DIR_REASONS.parentMissing));
  let hasFiles = false;
  try {
    const info = await ctx.fs.lstat(launch.localDir);
    if (info !== null) hasFiles = !info.isDir || (await ctx.fs.list(launch.localDir)).length > 0;
  } catch {
    // 读不到：按「有文件」处理。
    hasFiles = true;
  }
  return hasFiles ? { ...content, launch: { ...launch, localDirHasFiles: true } } : content;
}

export type SubmitKind = 'created' | 'revised' | 'reopened' | 'amended' | 'withdrawn';

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * P74e：该总管全部待确认的约定，按 updatedAt 从新到旧。包括执行中的事因 B2 重新确认的那些
 * （每件事最多一张，不同的事可以各有一张）。
 */
export function pendingAgreementsOf(ctx: HubContext, botId: string): Agreement[] {
  return ctx.store.table('agreements').list(row => row.botId === botId && row.state === 'pending').sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 该总管「还在对齐阶段」的那一份待确认约定：没有正在做的事的待确认约定里 updatedAt 最新的（与 P74e 之前的语义一致）。
 * 执行中的事重新确认的约定不算在这里；要看全部待确认的用 pendingAgreementsOf。
 */
export function pendingAgreementOf(ctx: HubContext, botId: string): Agreement | null {
  return pendingAgreementsOf(ctx, botId).find(row => activeJobOfAgreement(ctx, row.id) === null) ?? null;
}

/** 该主题上未撤下的约定（有多份时取 createdAt 最新的）。 */
export function agreementForTopic(ctx: HubContext, topicId: string): Agreement | null {
  const rows = ctx.store.table('agreements').list(row => row.topicId === topicId && row.state !== 'withdrawn');
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** 按 id 取一条主人发的线程消息；不是主人的消息一律当作没有。 */
function ownerThreadMessage(ctx: HubContext, id: string): ThreadMessage | null {
  return ctx.store.log('thread').recent(1, row => row.id === id && row.from === 'owner')[0] ?? null;
}

/**
 * P83：主人直接在提问卡上作答，与在对话里回他一句话等价。
 * 收件箱回答时中心以主人名义在线程里落一条 owner 的 reply（outreach/inbox.ts 的 applyAnswer，refId 是那条条目的编号）；
 * 这里按它找回那句主人的话，让「约定只能根据主人的话提交」这条规则认下提问卡上的回答。
 * 只认普通提问（事项键 question:）：审批结果、提议、告警各有自己的语义，学习选会话、验收、约定确认的条目
 * 也不表示主人对约定发了话；来自主题的提问回答时落的是中心旁白（不是主人消息），这里找不到，保持原来的结果（返回 null）。
 */
function ownerReplyToQuestion(ctx: HubContext, wake: WakeTicket): ThreadMessage | null {
  const found: ThreadMessage[] = [];
  for (const id of wake.reason.evidence) {
    const item = ctx.store.table('inbox').get(id);
    if (item === null || item.type !== 'question' || !item.subjectKey.startsWith('question:') || item.answer === null) continue;
    const reply = ctx.store.log('thread').recent(1, row => row.from === 'owner' && row.kind === 'reply' && row.refId === item.id)[0];
    if (reply) found.push(reply);
  }
  return found.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * 这一回合是哪句主人的话叫醒的：
 * - 主人直聊：取 from 为 owner、refId 等于唤醒单 id 的线程消息（events.ts 直聊落楼时就是这样记的）；
 * - 收件箱回答（inbox_reply）：主人回答了这位员工的提问卡，取回答时落的那条主人消息（P83，见 ownerReplyToQuestion）；
 * - 其他：只在理由是 owner_message 时找。证据里的 id 本身是主人线程消息的取它；是 owner_message 感知的，
 *   感知的 location 就是那条线程消息的 id（perception/sources.ts）；多条取 createdAt 最晚的；
 * - 其他情况（例如 next_think）返回 null。
 */
export function ownerMessageOfWake(ctx: HubContext, wake: WakeTicket): ThreadMessage | null {
  if (wake.ownerDirect === true) {
    return ctx.store.log('thread').recent(1, row => row.from === 'owner' && row.refId === wake.id)[0] ?? null;
  }
  if (wake.reason.kind === 'inbox_reply') return ownerReplyToQuestion(ctx, wake);
  if (wake.reason.kind !== 'owner_message') return null;
  const found: ThreadMessage[] = [];
  for (const id of wake.reason.evidence) {
    const direct = ownerThreadMessage(ctx, id);
    if (direct) { found.push(direct); continue; }
    const percept = ctx.store.table('percepts').get(id);
    if (percept && percept.kind === 'owner_message' && percept.location) {
      const viaPercept = ownerThreadMessage(ctx, percept.location);
      if (viaPercept) found.push(viaPercept);
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

/**
 * 提交结果。withdrawn 时没有新版本。
 * job（P74e）：这份约定有正在做的事、本次是重新请主人确认时给出：中心算好的两栏，以及执行者有没有被叫醒（工具据此如实回话）。
 */
/**
 * job.deliveryLost（P74r2c）：原来在交付时核对、这次没写 deliveryItems 而被改写的条目原文，工具据此在返回文字里提醒总管；不写入存储。
 */
export interface SubmitResult { agreement: Agreement; version: AgreementVersion | null; kind: SubmitKind; job?: { pause: JobPause; woken: boolean; deliveryLost: string[] } }

/** 去掉重复、保持顺序地把「必填」检查写在一处：缺了就报中文错误，点出是哪一项。 */
function requireField<T>(value: T | undefined, name: string, when: string): T {
  if (value === undefined) throw new Error(`${name}：${when}必须填写`);
  return value;
}

/** 约定当前状态下允许的 mode 说明，写进错误里让模型知道该怎么改。 */
function allowedModes(state: Agreement['state']): string {
  if (state === 'pending') return 'revise（修订）或 withdraw（撤下）';
  if (state === 'locked') return 'amend（小改动直接生效）或 revise（大改动重新请主人确认）';
  return '无（约定已撤下）';
}

/**
 * 总管提交约定：新建、修订、固定后改动、撤下。
 * 返回 { agreement, version, kind }；失败抛中文错误且没有任何写入。
 */
export async function submitAgreement(ctx: HubContext, botId: string, wake: WakeTicket, raw: unknown): Promise<SubmitResult> {
  // 1. 参数形状
  const input = parseInput(AgreementSubmitInputSchema, raw, 'hub_agreement_submit');
  // P74r14：约定各栏和本版改动说明会显示给主人，称呼写「你」，出现「主人」就拒绝。
  const addressed = ownerWordProblems(input);
  if (addressed.length > 0) throw new Error(addressed.join('；'));
  // 2. 身份
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.role !== 'chief') throw new Error('只有总管能提交约定');
  // 3. 回合：必须是主人的话叫醒的。
  // P74r2b：唯一的例外（范围很窄，四个条件缺一不可，见 chainReviseAsk）：执行链回合里，总管为这件事一个没回答的提问，
  // 对这件事的已固定约定用 revise 出新版本请主人确认。新版本不会自己生效，主人确认才固定，所以不违背「约定只能根据主人的话修改」。
  const message = ownerMessageOfWake(ctx, wake);
  const chain = message === null ? chainReviseAsk(ctx, bot.id, wake, input) : null;
  if (message === null && chain === null) throw new Error(NOT_OWNER_TURN_TEXT);
  /** 只有主人的话叫醒的回合才有的步骤用它取主人那句话；例外只放行 revise，不会走到这里。 */
  const ownerWords = (): ThreadMessage => {
    if (message === null) throw new Error(NOT_OWNER_TURN_TEXT);
    return message;
  };

  // 4. 找到约定并按「状态 + mode」分支
  let existing: Agreement | null = null;
  if (input.agreementId !== undefined) {
    existing = ctx.store.table('agreements').get(input.agreementId);
    if (!existing || existing.botId !== botId) throw new Error('agreementId：约定不存在或不是你的');
    if (input.projectId !== undefined) throw new Error('projectId：已经给了 agreementId，不能再指定项目');
  }
  // P73d：总管名下有组队卡在等主人确认时，不能新建约定，也不能修订或重新确认约定
  // （主人面前同一时刻只能有一张待确认的卡）；amend（直接生效、不请主人确认）和 withdraw 照常。判断集中在 pendingOwnerConfirmOf。
  // P74e：执行中的事因 B2 重新确认约定，不受这条限制（对它的重新确认每件事最多一张，由「同一件事一个入口」保证）。
  const refuseWhileTeamPending = (): void => {
    if (existing !== null && activeJobOfAgreement(ctx, existing.id) !== null) return;
    if (pendingOwnerConfirmOf(ctx, botId)?.kind === 'team') throw new Error(TEAM_PENDING_AGREEMENT_ERROR);
  };
  // P74e：continuing、paused、fallback 只用于正在做的事重新确认约定；新建、撤下、直接生效都不能带。
  const hasPauseInput = hasPauseParams(input);
  if (existing === null) {
    if (input.mode !== undefined && input.mode !== 'draft') {
      throw new Error('mode：没有 agreementId 时只能新建（mode 省略或 draft）；要修改或撤下已有约定请带上 agreementId');
    }
    if (hasPauseInput) throw new Error(pauseOnlyText(input));
    refuseWhileTeamPending();
    return createNew(ctx, bot.id, wake, ownerWords(), input);
  }
  if (existing.state === 'withdrawn') throw new Error(`约定「${existing.title}」已撤下`);
  const mode = input.mode;
  const stateLabel = existing.state === 'pending' ? '待主人确认' : '已固定';
  const refuse = () => new Error(`mode：约定「${existing!.title}」当前${stateLabel}，只能用 ${allowedModes(existing!.state)}`);
  if (existing.state === 'pending') {
    if (mode === 'withdraw') {
      if (hasPauseInput) throw new Error(pauseOnlyText(input));
      return withdraw(ctx, existing, wake, ownerWords(), input);
    }
    if (mode !== undefined && mode !== 'revise') throw refuse();
    refuseWhileTeamPending();
    return revise(ctx, existing, wake, ownerWords(), input, 'revised', null);
  }
  // locked
  if (mode === 'amend') {
    if (hasPauseInput) throw new Error(pauseOnlyText(input));
    return revise(ctx, existing, wake, ownerWords(), input, 'amended', null);
  }
  if (mode === 'revise') {
    refuseWhileTeamPending();
    // chain 不为空：执行链回合里为提问出新版本（message 为空），起因是那一条提问。
    return revise(ctx, existing, wake, message, input, 'reopened', chain);
  }
  // P72g A2：一份曾经固定过的约定，总管不能整份撤下；主人说不做了，走 revise 把范围写明并请主人确认。
  if (mode === 'withdraw') {
    throw new Error(`${refuse().message}。已固定过的约定不能直接撤下；主人说这件事不做了，请用 revise 把范围写明（例如把这次做的改小、写进「这次不做」），请主人重新确认`);
  }
  throw refuse();
}

/**
 * P72g A1：这句主人的话是不是「确认」：它是某个版本的确认消息，或整句就是确认口令。
 * 主人说「定了」只表示他同意眼前这一版，不能被拿来当作修改约定的指示。
 */
function isConfirmationMessage(existing: Agreement, message: ThreadMessage): boolean {
  return existing.versions.some(version => version.confirmMessageId === message.id) || isConfirmPhrase(message.text);
}

/**
 * 内容改动涉及哪几部分的中文名（amend 不允许动的部分）。
 * P74r13：对外发布（launch）也在其中：加上、改写、去掉对外发布都会改变「验收之后有没有发布这一步」，
 * 必须经主人在约定卡上确认（revise），不能由总管单方面直接生效。
 */
const AMEND_FORBIDDEN_SECTIONS: Record<string, string> = { pending: '待定项', scopeIn: '这次做', scopeOut: '这次不做', doneWhen: '怎样算做完', launch: '对外发布' };

/** 新建约定（第 1 版）。所有校验通过后才建项目和主题，再取约定 id。 */
async function createNew(
  ctx: HubContext, botId: string, wake: WakeTicket, message: ThreadMessage, input: AgreementSubmitInput,
): Promise<SubmitResult> {
  const title = requireField(input.title, 'title', '新建约定时');
  // 总管同时最多 PENDING_PER_CHIEF_MAX 份待确认约定。
  // P74e：只数「没有正在做的事」的待确认约定；执行中的事重新确认的那些不占这个名额。
  const pendings = ctx.store.table('agreements').list(row => row.botId === botId && row.state === 'pending' && activeJobOfAgreement(ctx, row.id) === null);
  if (pendings.length >= D.PENDING_PER_CHIEF_MAX) {
    throw new Error(`约定「${pendings[0]!.title}」还在等主人确认，先请主人确认或撤下，再提新的`);
  }
  // 合并（缺项报错）、对齐 key（新建没有上一版，无需对齐）、解析依据、整体校验。
  // P81：发布位置（launch.localDir）的校验在任何写入之前，不合格整份提交被拒。
  // P81r1：再查一次磁盘（上一级文件夹必须存在、已有文件时记下标记）。
  const merged = await checkLaunchLocalDirOnDisk(ctx, resolveLaunchLocalDir(ctx, mergeContentInput(null, input), input), input);
  // P74r10：「怎样算做完」不能写验收之后才发生的事（对外发布写在 launch 里）。
  // P74r18a：同时校验对外发布要去的位置不出现在「这次做」「怎样算做完」里；校验的是合并之后生效的内容。
  assertAgreementBeforeLaunch(merged);
  const content = parseWithPaths(AgreementContentSchema,
    { ...merged, decided: resolveBasis(ctx, botId, input.decided ?? [], input.projectId ?? null) }, '约定内容');
  // P72g A3（P74r1 恢复）：本回合已经用 hub_send 叫过员工动手，就不能再提交新约定（拒绝并在私聊落旁白）。
  assertNoMessageBeforeNewAgreement(ctx, botId, wake, title);
  // 约定标题长度已由参数层限制；建家（可能新建项目）一定排在全部校验之后。
  const chief = ctx.store.table('bots').get(botId)!;
  const { project, topic } = await createAgreementHome(ctx, chief, { title, summary: content.summary, projectId: input.projectId });

  const now = ctx.clock.now();
  const version = newVersion(1, 'pending', 'draft', message, wake, content, [], '', now);
  const agreement = AgreementSchema.parse({
    id: newId('agr', ctx.rng), botId, projectId: project.id, topicId: topic.id, originThread: botId, title,
    state: 'pending', versions: [version], inboxId: null, withdrawn: null, createdAt: now, updatedAt: now,
  });
  // P75b：新建一定写类别标签（没填按默认类别）；约定写入失败时不写标签，标签写入失败时撤回约定（见 commit）。
  return commit(ctx, agreement, version, 'created', { category: input.category, before: null });
}

/** 拼一个新版本；除传入的几项外都是初始值。 */
function newVersion(
  no: number, state: AgreementVersion['state'], source: AgreementVersion['source'], message: ThreadMessage | null, wake: WakeTicket,
  content: AgreementContent, changes: AgreementVersion['changes'], changeNote: string, now: number,
  askOrigin: AgreementVersion['askOrigin'] = null,
): AgreementVersion {
  // 起因是提问的版本没有主人的话（message 为空）：sourceMessageId、sourceThread 为空，起因记在 askOrigin 里，不伪造主人消息。
  return {
    no, state, source, sourceMessageId: message?.id ?? null, sourceThread: message?.thread ?? null, wakeId: wake.id,
    ...(askOrigin === null ? {} : { askOrigin }),
    content, changes, changeNote, cardMessageId: null, createdAt: now,
    lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null,
  };
}

/** 修订类：待确认时修订（revised）、固定后重新请主人确认（reopened）、固定后直接生效（amended）。 */
async function revise(
  ctx: HubContext, existing: Agreement, wake: WakeTicket, message: ThreadMessage | null, input: AgreementSubmitInput,
  kind: 'revised' | 'reopened' | 'amended', chain: ChainAsk | null,
): Promise<SubmitResult> {
  const changeNote = requireField(input.changeNote, 'changeNote', kind === 'amended' ? 'amend 时' : 'revise 时');
  // P72g A1：主人的确认不能用来修改约定（「定了」叫醒的回合里 amend 和 revise 一律拒绝）。
  if (message !== null && isConfirmationMessage(existing, message)) {
    throw new Error('主人的确认不能用来修改约定：这一回合是主人说「定了」（或点了确认）叫醒的，约定只能根据主人新说的修改意见来改');
  }
  // P72g A3，P74b 收窄：本回合已经对这份约定派过活，就不能再提交新版本（revise、重开）。
  // amend 不请主人确认、不拦工，不在此列；新建约定不可能先派活，不再检查。
  if (kind !== 'amended') assertNoDispatchBeforeAgreement(ctx, existing.botId, wake, existing);
  // P74e（B2）：这份约定有正在做的事、本次又是重新请主人确认：continuing、paused 必填；其余情况传了就拒绝。
  const job: Job | null = kind === 'amended' ? null : activeJobOfAgreement(ctx, existing.id);
  const hasPauseInput = hasPauseParams(input);
  if (job === null && hasPauseInput) throw new Error(pauseOnlyText(input));
  // P74f-2：stopsJob（这一版写明不再做，主人确认后由中心停下这件事）：不写两栏（确认前照常做，确认后整个停止）；
  // 执行链回合里不能用（停止只能根据主人的话）。
  const stops = input.stopsJob === true;
  if (stops && chain !== null) throw new Error('停止只能根据主人的话：执行链回合里不能用 stopsJob');
  if (stops && (input.continuing !== undefined || input.paused !== undefined || input.deliveryItems !== undefined)) {
    throw new Error('stopsJob 为 true 时不用写 continuing、paused、deliveryItems：主人确认后这件事整个停止');
  }
  if (job !== null && !stops && (input.continuing === undefined || input.paused === undefined)) throw new Error(PAUSE_REQUIRED_TEXT);
  // P74r3（H1）：这一版是不是在回答这件事没回答的提问。执行链回合（chain）一律是，写 false 拒绝；
  // 主人发起的回合里，这件事有未关联的提问时总管必须写明（true 关联、false 不关联）；其余情况传了忽略。
  // P76f：chain.ask 为空表示这一回合是主人选了「缩小范围」之后总管出新版本（没有提问可关联）：不关联提问，answersAsk 不管。
  const chainAsk = chain === null ? null : chain.ask;
  let linkAsk = chainAsk !== null;
  if (chainAsk !== null && input.answersAsk === false) throw new Error(CHAIN_ANSWERS_FALSE_TEXT);
  if (chain === null && job !== null && !stops && hasUnlinkedAsk(job)) {
    if (input.answersAsk === undefined) throw new Error(undeclaredAskText(ctx, job));
    linkAsk = input.answersAsk;
  }
  // 同一句主人的话只出一版；版本数上限。
  const used = message === null ? undefined : existing.versions.find(version => version.sourceMessageId === message.id);
  if (used) throw new Error(`主人的这句话已经记成第 ${used.no} 版了，同一句话只出一版`);
  // P74r2b：同一个提问也只出一版：主人没有采用（撤销了）之后，不能再拿同一个提问出新版本，只能按约定回答，或等主人的话再改。
  const askUsed = chainAsk === null ? undefined : existing.versions.find(version => version.askOrigin?.askEventId === chainAsk.eventId);
  if (askUsed) throw new Error(`这个提问已经出过约定第 ${askUsed.no} 版了，主人没有采用，不能再用同一个提问出新版本；能按约定回答的用 answer，要改约定请等主人的话`);
  if (existing.versions.length + 1 > D.VERSION_MAX) throw new Error(`这份约定已经有 ${existing.versions.length} 版，达到上限 ${D.VERSION_MAX}，不能再出新版`);

  const prevVersion = existing.versions[existing.versions.length - 1]!;
  const prev = prevVersion.content;
  // P74r16b：这一版的标题：写了就是改标题，没写沿用上一版的；只在和当前已固定的标题不同时才记（记在提交审计里，见 agreement-title.ts）。
  const effectiveTitle = input.title ?? versionTitleOf(ctx, existing, prevVersion.no);
  const versionTitle = effectiveTitle !== existing.title ? effectiveTitle : undefined;
  // P81：修订时同样先校验发布位置；P81r1：再查一次磁盘（与新建同一处、同一套拒绝原因）。
  const merged = await checkLaunchLocalDirOnDisk(ctx, resolveLaunchLocalDir(ctx, mergeContentInput(prev, input), input), input);
  // P74r10：修订时新写的「怎样算做完」同样不能含验收之后才发生的事。
  // P74r13：「发布后」「上线后」一类只在这一版约定写了对外发布时才拦（merged 里已含沿用的上一版对外发布）。
  // P74r18a：改为校验合并之后实际生效的内容（含沿用上一版的条目和发布方式），小改动同样校验；序号是生效内容里的序号。
  assertAgreementBeforeLaunch(merged);
  // 模型改了 key 时按问题原文兜底对齐；依据只在这次给了 decided 时重新解析，没给的沿用上一版（含已读出的出处原文）。
  const pending = alignPendingKeys(prev.pending, merged.pending);
  const decided = input.decided !== undefined ? resolveBasis(ctx, existing.botId, input.decided, existing.projectId) : merged.decided;
  // P72h H1：传了的列表段比上一版少了条目，必须在 removals 里写明是有意删除，否则整份拒绝（不产生版本）。
  // 没传的段整段沿用上一版，不会丢条目。
  assertRemovalsDeclared(findDroppedItems(prev, { ...merged, pending, decided }, {
    pending: input.pending !== undefined, decided: input.decided !== undefined,
    scopeIn: input.scopeIn !== undefined, scopeOut: input.scopeOut !== undefined, doneWhen: input.doneWhen !== undefined,
  }), input.removals);
  let content = parseWithPaths(AgreementContentSchema, { ...merged, pending, decided }, '约定内容');
  const changes = diffContent(prev, content);
  if (changes.length === 0) throw new Error('这一版和上一版没有任何不同');
  // P72g A1：amend 直接生效、不再请主人确认，所以只允许改一句话复述、草图和「我已定的」。
  // 待定项、这次做、这次不做、怎样算做完有任何改动，都会替主人做决定，必须走 revise 重新请主人确认。
  if (kind === 'amended') {
    const forbidden = [...new Set(changes.map(mark => AMEND_FORBIDDEN_SECTIONS[mark.section]).filter(name => name !== undefined))];
    if (forbidden.length > 0) {
      throw new Error(`amend 不能改「${forbidden.join('」「')}」：amend 直接生效，只能改一句话复述、草图和我已定的；这类改动请改用 revise，重新请主人确认`);
    }
  }

  const now = ctx.clock.now();
  let version: AgreementVersion;
  let versions: AgreementVersion[];
  if (kind === 'amended') {
    // 直接生效：沿用上一版同 key 且没改过的项的选择，新增或改过的项取建议。
    const choices: Record<string, string> = {};
    for (const item of content.pending) {
      const old = prev.pending.find(row => row.key === item.key);
      const unchanged = old !== undefined && old.question === item.question && old.suggested === item.suggested
        && old.reason === item.reason && JSON.stringify(old.options) === JSON.stringify(item.options);
      const before = prevVersion.choices?.[item.key];
      choices[item.key] = unchanged && before !== undefined && item.options.includes(before) ? before : item.suggested;
    }
    content = applyChoices(content, choices);
    version = {
      ...newVersion(existing.versions.length + 1, 'locked', 'owner_instruction', message, wake, content, changes, changeNote, now),
      lockedAt: now, lockedVia: 'amend', choices,
    };
    // 上一个已固定版改为已替换。
    versions = [...existing.versions.map(row => row.state === 'locked' ? { ...row, state: 'replaced' as const } : row), version];
  } else {
    // P74r2b：起因是提问的版本，来源记为 job_question，并带上那一条提问（提问人、原文、事件编号）。
    const askOrigin = chain === null || chainAsk === null ? null : {
      jobId: chain.job.id, askEventId: chainAsk.eventId, askerId: chainAsk.fromId,
      askerName: ctx.store.table('bots').get(chainAsk.fromId)?.name ?? '员工',
      text: openAskText(ctx, chain.job) ?? '（问题原文没有留在记录里）',
    };
    // P76f：「缩小范围」的新版本（chain 不为空而没有提问）来源记为 owner_reopen：起因是你选了缩小范围，没有主人的话可记。
    version = { ...newVersion(existing.versions.length + 1, 'pending',
      chainAsk !== null ? 'job_question' : kind === 'revised' ? 'owner_revision' : 'owner_reopen', message, wake, content, changes, changeNote, now, askOrigin),
    ...(stops ? { stopsJob: true } : {}) };
    // 待确认时修订：上一个待确认版作废；固定后重开：上一个已固定版保持不变，确认时才改为已替换。
    versions = [...existing.versions.map(row => row.state === 'pending' ? { ...row, state: 'superseded' as const } : row), version];
  }
  const agreement = AgreementSchema.parse({
    ...existing, versions, state: kind === 'amended' ? 'locked' : 'pending', updatedAt: now,
    // 直接生效的版本（amend）当场固定，标题随之生效；其余版本等主人确认固定时再改（finishLock）。
    ...(kind === 'amended' ? { title: effectiveTitle } : {}),
  });
  // P74e（B2）：这件事正在做：照常在做和暂停两栏由中心对比「正在执行的已固定版本」和新版本算出（job/pause.ts），
  // 碰到被改动涉及的条目的 continuing 整份拒绝；这里还没有写任何东西。
  if (job !== null) {
    const executing = existing.versions.find(row => row.state === 'locked') ?? prevVersion;
    // P74r2c：沿用下来的条目（原文没变的）相对顺序不得改变；新版本里「交付时核对」的条目随新版本一起等确认（存进暂停信息）。
    const remap = remapItems(executing.content.doneWhen, content.doneWhen);
    const moved = stops ? null : firstReordered(remap);
    if (moved !== null) {
      throw new Error(`「怎样算做完」已有条目的顺序不要调整：「${clip20(content.doneWhen[moved - 1]!)}」的位置变了。要改内容就改写这一条；要去掉就删去，并在 removals 里写明。`);
    }
    if (input.deliveryItems !== undefined) checkDeliveryItems(input.deliveryItems, content.doneWhen.length, content.doneWhen);
    // stopsJob：确认前照常做，两栏为空；退路可写（主人不确认时仍按原版本做）。
    const pause: JobPause = stops
      ? { versionNo: version.no, continuing: [], paused: [], fallback: input.fallback === undefined ? null : clipTo(input.fallback, JOB_DEFAULTS.FALLBACK_MAX_CHARS), stopsJob: true }
      : buildPause(version.no, executing.content, content, { continuing: input.continuing!, paused: input.paused!, fallback: input.fallback });
    // 写了 deliveryItems 就用它；没写就按条目原文把原来的交付时核对条目换成新序号，原文被改写或删去的不再算。
    const deliveryItems = input.deliveryItems !== undefined ? [...new Set(input.deliveryItems)].sort((a, b) => a - b) : mapDeliveryItems(job.deliveryItems, remap);
    // 没写 deliveryItems 时，被改写（不是在 removals 里声明删去）的交付时核对条目要提醒总管重新指定。
    const declared = input.removals ?? [];
    const deliveryLost = input.deliveryItems !== undefined ? []
      : lostDeliveryItems(job.deliveryItems, remap).map(no => executing.content.doneWhen[no - 1] ?? '').filter(text => text !== '' && !declared.includes(text));
    return commitWithPause(ctx, existing, agreement, version, kind, job, { ...pause, deliveryItems }, now, linkAsk, deliveryLost, input.category, versionTitle);
  }
  // P75b：修订和小改动直接生效时，填了类别就改、不填不动。
  // P74r16b：小改动直接生效时标题已随这一版写进约定，审计里不再另记；其余情形把这一版的新标题记在审计里。
  const result = commit(ctx, agreement, version, kind, { category: input.category, before: existing }, kind === 'amended' ? undefined : versionTitle);
  // P74e：主人亲口的小改动直接生效，这件事（如果有）重写主题文件、叫醒执行者；出错只记日志。
  if (kind === 'amended') {
    // P74r16b：标题随这一版生效时，主题的标题（主人没有自己改过的话）一并跟上。
    try { followTopicTitle(ctx, existing, existing.title, effectiveTitle, version.no); } catch (error) { ctx.logger.warn('主题标题没有跟上约定的新标题', { agreementId: agreement.id, error: String(error) }); }
    try { onAgreementLocked(ctx, agreement.id, version.no, 'amend'); } catch (error) { ctx.logger.warn('小改动生效后的后续没有做成', { agreementId: agreement.id, error: String(error) }); }
  }
  return result;
}

/**
 * P74e（B2）：新版本和这件事的「暂停」记录在同一个第一段里写，任何一步失败一起恢复（约定、这件事都回到原样）。
 * 写成功之后才做第二段：工作往来一句、给执行者排一次唤醒（出错只记日志，唤醒有没有排上如实交给工具回话）。
 */
function commitWithPause(
  ctx: HubContext, existing: Agreement, agreement: Agreement, version: AgreementVersion, kind: SubmitKind, job: Job, pause: JobPause, now: number,
  linkAsk = false, deliveryLost: string[] = [], category?: string, versionTitle?: string,
): SubmitResult {
  // P74r2b：新版本是为一个提问出的（linkAsk）：提问保持未回答，记下它已转成约定第几版；这件事此刻在等主人，不再等总管。
  const nextJob = JobSchema.parse({ ...job, pause, updatedAt: now,
    ...(linkAsk && job.openAsk !== null ? { openAsk: { ...job.openAsk, agreementNo: version.no } } : {}) });
  let result: SubmitResult;
  try {
    putJob(ctx, nextJob);
    result = commit(ctx, agreement, version, kind, { category, before: existing }, versionTitle);
  } catch (error) {
    // 恢复原样：约定写回旧的，这件事写回旧的。
    try { ctx.store.table('agreements').put(existing); } catch { /* 恢复出错只记日志，下面照常抛出原错误。 */ }
    try { putJob(ctx, job); } catch { /* 同上。 */ }
    throw error;
  }
  let woken = false;
  try { woken = onReopenPending(ctx, nextJob); } catch (error) { ctx.logger.warn('约定重新确认后的第二段没有做成', { agreementId: agreement.id, error: String(error) }); }
  return { ...result, job: { pause, woken, deliveryLost } };
}

/**
 * 撤下（只对待确认的约定）：
 * - 从没固定过的约定：变 withdrawn，最新版作废，不追加版本；
 * - 重开中的约定（P72g A2，已有固定版本、另有待确认的新版本）：只作废待确认的那一版，约定回到已固定状态，
 *   原固定版本一字不动，主题第一层照常显示它；总管不能借此把主人已固定的约定整份撤掉。
 * 同一句主人的话只用一次：这句话已经出过版本的，不能再拿来撤下；唯一例外是「取消刚刚在同一句话里发起的重开」。
 */
function withdraw(ctx: HubContext, existing: Agreement, wake: WakeTicket, message: ThreadMessage, input: AgreementSubmitInput): SubmitResult {
  const reason = requireField(input.reason, 'reason', 'withdraw 时');
  const latest = existing.versions[existing.versions.length - 1]!;
  const hadLocked = existing.versions.some(row => row.lockedAt !== null);
  // 主人的确认不能用来撤下约定。
  if (isConfirmationMessage(existing, message)) {
    throw new Error('主人的确认不能用来撤下约定：这一回合是主人说「定了」（或点了确认）叫醒的');
  }
  // 同一句话只用一次：它已经是某一版的来源时拒绝；取消「同一句话里刚发起的重开」例外（等于没改）。
  const used = existing.versions.find(row => row.sourceMessageId === message.id);
  const cancelsOwnReopen = hadLocked && used !== undefined && used.no === latest.no;
  if (used && !cancelsOwnReopen) throw new Error(`主人的这句话已经记成第 ${used.no} 版了，同一句话只出一版，不能再拿来撤下`);

  const now = ctx.clock.now();
  if (hadLocked) {
    // 重开中：作废待确认版本，约定回到已固定；待你处理里的确认条目随之撤回。
    const versions = existing.versions.map(row => row.state === 'pending' ? { ...row, state: 'superseded' as const } : row);
    const agreement = AgreementSchema.parse({ ...existing, versions, state: 'locked', inboxId: null, updatedAt: now });
    ctx.store.table('agreements').put(agreement);
    withdrawAgreementInboxItems(ctx, agreement.id, '已取消重新确认');
    // 主人已经看到过新版的卡时，私聊里留一句说明；没发过卡（同一回合内取消）就不用打扰主人。
    if (latest.cardMessageId !== null) {
      const kept = agreement.versions.find(row => row.state === 'locked');
      postThread(ctx, { thread: agreement.originThread, from: 'hub', kind: 'system', refId: agreement.id,
        text: `约定「${agreement.title}」的重新确认已取消，仍按已固定的第 ${kept?.no ?? '?'} 版执行。（原因：${reason}）` });
    }
    writeOutreachAudit(ctx, 'agreement_submit', { agreementId: agreement.id, no: latest.no, kind: 'reopen_cancelled' }, agreement.botId);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    ctx.emit(HUB_EVENT_SCOPES.thread, agreement.botId);
    // P74e：这份约定有正在做的事时，清掉暂停、工作往来一句、叫醒执行者（暂停的部分照原版本接着做）；出错只记日志。
    try { onReopenWithdrawn(ctx, agreement.id); } catch (error) { ctx.logger.warn('取消重新确认后的后续没有做成', { agreementId: agreement.id, error: String(error) }); }
    return { agreement, version: null, kind: 'withdrawn' };
  }
  const versions = existing.versions.map(row => row.state === 'pending' ? { ...row, state: 'superseded' as const } : row);
  const agreement = AgreementSchema.parse({
    ...existing, versions, state: 'withdrawn', updatedAt: now,
    withdrawn: { at: now, reason, wakeId: wake.id, noticeMessageId: null },
  });
  return commit(ctx, agreement, null, 'withdrawn');
}

/**
 * 写表、写审计、通知界面。所有校验都在调用之前完成。
 * tag（P75b）：带上时，约定写入成功之后接着写类别标签（两段式）；标签写入失败就把约定恢复成 before（新建时为 null，即删掉），
 * 再抛出原错误，这样不会出现「有约定、没标签」的半截状态。撤下约定不带 tag。
 * versionTitle（P74r16b）：这一版的标题和当前已固定的标题不同时带上，记在审计里（固定时据此改标题）。
 */
function commit(
  ctx: HubContext, agreement: Agreement, version: AgreementVersion | null, kind: SubmitKind,
  tag?: { category: string | undefined; before: Agreement | null }, versionTitle?: string,
): SubmitResult {
  ctx.store.table('agreements').put(agreement);
  if (tag !== undefined) {
    try {
      writeAgreementTag(ctx, agreement.id, tag.category, tag.before === null);
    } catch (error) {
      try {
        if (tag.before === null) ctx.store.table('agreements').remove(agreement.id);
        else ctx.store.table('agreements').put(tag.before);
      } catch (restoreError) { ctx.logger.error('类别没有写成，恢复约定时也出错', restoreError); }
      throw error;
    }
  }
  const no = version?.no ?? agreement.versions[agreement.versions.length - 1]!.no;
  // P74r16b：这一版的标题和当前已固定的标题不同时，记在审计里（固定时据此改标题，见 agreement-title.ts）；相同时和原来逐字一样。
  writeOutreachAudit(ctx, 'agreement_submit', { agreementId: agreement.id, no, kind, ...(versionTitle === undefined ? {} : { title: versionTitle }) }, agreement.botId);
  // P76e：提交了待确认的新版本（新建、修订、重新确认）：按规则算一项预计消耗（draft）存旁表，不调用模型；
  // 小改动直接生效（amended）的版本当场固定，由固定时的收尾（onAgreementLocked）按「这件事有没有」决定算不算。
  // P76r3（R5）：这份约定已有进行中的事时不写 draft——那一版还没有生效，按默认份额重算出的数字与这件事的
  // 已用、预算线都无关；约定卡改为显示当前生效的那一项预计（job/estimate.ts 的 displayEstimate）。
  // 出错只记日志，不影响约定已经写成功的状态。
  if (version !== null && kind !== 'amended' && activeJobOfAgreement(ctx, agreement.id) === null) {
    try { estimateFor(ctx, agreement.id, version.no, 'draft'); } catch (error) { ctx.logger.warn('预计消耗没有算成（提交新版本）', { agreementId: agreement.id, error: String(error) }); }
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.thread, agreement.botId);
  return { agreement, version, kind };
}

// ---------------------------------------------------------------------------
// 固定（纯函数）
// ---------------------------------------------------------------------------

/** applyLock 的入参。 */
export interface LockInput {
  version: number; // 主人看到的、要确认的版本号
  via: Exclude<LockVia, 'amend'>; // 按钮、文字、待你处理
  choices: Record<string, string> | null; // 主人的选择；没给的项取建议
  at: number; // 固定时间
  confirmMessageId: string | null; // 主人确认那句话（或确认记录）的 id
}

/**
 * 固定一份约定：返回新对象，不读存储、不写存储、不改入参。
 * 只有「最新版且仍待确认」的版本能被固定；旧版本号会被拒，并告诉主人最新是第几版。
 * 第一次固定时记录默契度（建议被原样采纳了几项）；之后的确认不再记。
 */
export function applyLock(agreement: Agreement, input: LockInput): Agreement {
  if (agreement.state === 'locked') throw new Error('约定已经固定');
  if (agreement.state === 'withdrawn') throw new Error('约定已撤下');
  const latest = agreement.versions[agreement.versions.length - 1]!;
  if (input.version !== latest.no || latest.state !== 'pending') {
    throw new Error(`这一版已被第 ${latest.no} 版取代，请在最新一版上确认`);
  }
  const content = applyChoices(latest.content, input.choices ?? {});
  const choices = Object.fromEntries(content.pending.map(item => [item.key, item.chosen as string]));
  // 此前没有任何版本被固定过，说明这是第一次确认。
  const firstTime = agreement.versions.every(version => version.lockedAt === null);
  const locked: AgreementVersion = {
    ...latest, state: 'locked', content, choices, lockedAt: input.at, lockedVia: input.via,
    confirmMessageId: input.confirmMessageId,
    adoption: firstTime ? computeAdoption(agreement.versions[0]!.content, content) : null,
  };
  const versions = agreement.versions.map(version => {
    if (version.no === latest.no) return locked;
    return version.state === 'locked' ? { ...version, state: 'replaced' as const } : version;
  });
  return AgreementSchema.parse({ ...agreement, versions, state: 'locked', updatedAt: input.at });
}
