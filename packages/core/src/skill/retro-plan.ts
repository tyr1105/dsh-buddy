/**
 * 验收后安排复盘（P75g 第 3 节）：afterJobAccepted 写完同类任务记录之后调用 planRetro。
 *
 * 做什么：按记录（不调用模型）判断要不要复盘、谁复盘、学哪些出处；出处原文当场抄进 skillSources 表
 * （事件日志只保留 14 天，出处要在几个月之后仍然正确）；建一行 skillRuns；主题里落一句中心提示；先排执行者的复盘唤醒。
 *
 * 顺序（方案 7.2）：先排执行者；执行者提交（propose）之后再排评审员（合并核对与复盘）；只有总管要复盘时直接排总管。
 * 一次通过且没有纠正：只有同类任务记录，主题里什么都不落。
 *
 * 两段式：表都写成功之后才落提示、排唤醒；排唤醒失败只记日志，由兜底（skill/run.ts 的 sweep）补排。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { isOwnerCorrection } from '../reflect/trigger.js';
import { botIsArchived, type Bot } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import { SkillRunSchema, SkillSourceSchema, type SkillRun, type SkillSource } from '../model/skill.js';
import type { JobReview } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { jobCategory } from '../project/agreement-category.js';
import { jobTitleOf } from '../job/chain.js';
import { realReviews } from '../job/receipt.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { retroSubjectKey } from './keys.js';
import { newId } from '../util/ids.js';

/** 出处行的中间表示：一条出处（还没写表），botIds 是「这条出处给谁学」。 */
export interface RetroSourceDraft {
  kind: 'review' | 'owner_correction' | 'acceptance';
  botIds: string[];
  label: string;
  quote: string;
  relayed: boolean;
  refs: { reviewId?: string; itemNo?: number; messageId?: string };
}

/** 主题里落的那句提示（逐字，任务卡第 3.3 节）。 */
export function retroHintText(n: number, names: string[]): string {
  return names.length === 1 ? `有 ${n} 条可学的出处，${names[0]}复盘一次。` : `有 ${n} 条可学的出处，${names.join('、')}各复盘一次。`;
}

/** 截到最多 max 个完整字符。 */
function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}`;
}

/** 纯函数的输入：全部由调用方显式给出（读存储的部分在本文件下方）。 */
export interface RetroSourcesInput {
  title: string;
  job: {
    executorId: string; reviewerId: string | null; chiefId: string;
    stage: number; assignedAt: number; acceptedAt: number;
    /** 主人验收时指出不符的记录（这件事记录上的 ownerReturns）。 */
    ownerReturns: Array<{ stage: number; at: number; messageId: string | null; items: Array<{ no: number; problem: string; fixTo: string }> }>;
  };
  /** 这件事的核对结论（已排除中心重排的），从旧到新。 */
  reviews: JobReview[];
  /** 这件事主题里的主人消息（从旧到新），只取派活到验收之间的由调用方过滤或全量给。 */
  topicOwnerMessages: Array<{ id: string; text: string; at: number }>;
  /** 消息 id → 主人原话原文（取不到时不放进来）。 */
  messageTexts: Record<string, string>;
  /** 验收结果出处用的数字（同类任务记录那一行）。 */
  outcome: { rounds: number; reworks: number; turns: number } | null;
}

/**
 * 出处（纯函数，任务卡第 3.1 节的表）：评审意见、你的纠正（验收）、你的纠正（主题里）、验收结果。
 * 全部按记录拼出，不调用模型；原文截到 SOURCE_QUOTE_MAX_CHARS，标签截到 SOURCE_LABEL_MAX_CHARS。
 */
export function collectRetroSources(input: RetroSourcesInput): RetroSourceDraft[] {
  const drafts: RetroSourceDraft[] = [];
  const { title, job } = input;
  // 1. 评审意见：全部核对结论里判了不符的条目，给执行者。
  for (const review of input.reviews) {
    for (const item of review.items) {
      if (item.verdict !== 'unmet') continue;
      const stageText = review.stage >= 2 ? `第 ${review.stage} 阶段第 ${review.round} 轮退回第 ${item.no} 条` : `第 ${review.round} 轮退回第 ${item.no} 条`;
      drafts.push({
        kind: 'review', botIds: [job.executorId],
        label: clip(`${title}${stageText}`, D.SOURCE_LABEL_MAX_CHARS),
        quote: clip(`${item.note ?? ''}${item.fixTo != null && item.fixTo !== '' ? `改到什么程度算过：${item.fixTo}` : ''}`, D.SOURCE_QUOTE_MAX_CHARS),
        relayed: false,
        refs: { reviewId: review.id, itemNo: item.no },
      });
    }
  }
  // 已作为「验收纠正」出处的主人消息不再重复算「主题里说的」。
  const acceptanceMessageIds = new Set<string>();
  // 2. 你的纠正（验收）：主人指出不符的每个条目，给执行者和漏判的核对人（漏判的核对人由调用方补进 botIds 的部分在这里算）。
  const missedCheckerByItem: string[] = [];
  for (const record of job.ownerReturns) {
    // 漏判的核对人：被指出的条目在「退回前的那个阶段的最后一次核对」里被判了符合或沿用，那次核对的核对人漏判。
    const lastOfStage = input.reviews.filter(row => row.stage === record.stage).sort((a, b) => b.round - a.round)[0] ?? null;
    for (const item of record.items) {
      const missed = lastOfStage !== null && lastOfStage.items.some(row => row.no === item.no && (row.verdict === 'met' || row.verdict === 'carried'))
        ? lastOfStage.reviewerId : null;
      if (missed !== null && !missedCheckerByItem.includes(missed)) missedCheckerByItem.push(missed);
      if (record.messageId !== null) acceptanceMessageIds.add(record.messageId);
      const original = record.messageId !== null ? input.messageTexts[record.messageId] : undefined;
      const relayed = original === undefined;
      drafts.push({
        kind: 'owner_correction', botIds: [job.executorId, ...(missed !== null ? [missed] : [])],
        label: clip(`${title}验收第 ${item.no} 条${relayed ? '（总管转述）' : ''}`, D.SOURCE_LABEL_MAX_CHARS),
        quote: clip(relayed ? item.problem : original!, D.SOURCE_QUOTE_MAX_CHARS),
        relayed,
        refs: { itemNo: item.no, ...(record.messageId !== null ? { messageId: record.messageId } : {}) },
      });
    }
  }
  // 3. 你的纠正（主题里）：派活到验收之间，主题里匹配纠正触发词的主人消息；不含已作为验收纠正出处的那几条。
  for (const message of input.topicOwnerMessages) {
    if (message.at < job.assignedAt || message.at > job.acceptedAt) continue;
    if (acceptanceMessageIds.has(message.id)) continue;
    if (!isOwnerCorrection(message.text)) continue;
    drafts.push({
      kind: 'owner_correction', botIds: [job.executorId],
      label: clip(`你在${title}主题里说的`, D.SOURCE_LABEL_MAX_CHARS),
      quote: clip(message.text, D.SOURCE_QUOTE_MAX_CHARS),
      relayed: false,
      refs: { messageId: message.id },
    });
  }
  // 4. 验收结果：只在执行者已有别的出处时附上，给执行者。
  const executorHasOther = drafts.some(row => row.botIds.includes(job.executorId) && row.kind !== 'acceptance');
  if (executorHasOther && input.outcome !== null) {
    drafts.push({
      kind: 'acceptance', botIds: [job.executorId],
      label: clip(`${title}验收结果`, D.SOURCE_LABEL_MAX_CHARS),
      quote: clip(`核对 ${input.outcome.rounds} 轮，验收返工 ${input.outcome.reworks} 次，共 ${input.outcome.turns} 个回合。`, D.SOURCE_QUOTE_MAX_CHARS),
      relayed: false, refs: {},
    });
  }
  return drafts;
}

/** 参与者此刻停用的原因码；在岗返回 null。 */
export function offDutyReason(bot: Bot | null): 'owner_paused' | 'archived' | null {
  if (bot === null) return 'archived';
  if (botIsArchived(bot)) return 'archived';
  if (!(ON_TEAM_LIFECYCLES as readonly string[]).includes(bot.lifecycle)) return 'owner_paused';
  return null;
}

/**
 * 参与者角色，按「他为什么在这次复盘里」定（P75r5b，审查 H2）：
 * 执行者、总管各是自己的角色；其余参与者在这里都是因为自己有出处（评审意见、漏判被主人指出）才进来的，
 * 一律按评审员的顺序处理（执行者结束之后排他的复盘），不管他此刻还是不是这件事的评审员。
 * 以前按「此刻的评审员」定：漏判的核对人在返工期间被换掉之后变成纯核对人，没有任何地方会叫醒他，复盘永远结束不了。
 * 纯核对人（role: checker，没有出处）只在 propose 排核对时由 arrangeNextSteps 加进名单。
 */
function roleOf(botId: string, job: { executorId: string; chiefId: string }): SkillRun['participants'][number]['role'] {
  if (botId === job.executorId) return 'executor';
  if (botId === job.chiefId) return 'chief';
  return 'reviewer';
}

/**
 * 安排一次复盘（幂等：这件事已有 kind 为 retro 的 skillRuns 行就返回）。
 * 表写成功之后才落提示、排唤醒；出错抛出中文错误（由 onJobAccepted 的调用方接住记日志，兜底补做）。
 */
export async function planRetro(ctx: HubContext, jobId: string): Promise<void> {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null || job.acceptedAt === null) return;
  // 幂等：以「这件事已有一行复盘记录」为键。
  if (ctx.store.table('skillRuns').count(row => row.kind === 'retro' && row.jobId === job.id) > 0) return;
  // 已停止的事不复盘。
  if (job.state === 'stopped') return;
  const title = jobTitleOf(ctx, job);
  const category = jobCategory(ctx, job.id);
  const outcome = ctx.store.table('jobOutcomes').get(job.id);
  const drafts = collectRetroSources({
    title,
    job: { executorId: job.executorId, reviewerId: job.reviewerId, chiefId: job.chiefId, stage: job.stage,
      assignedAt: job.assignedAt, acceptedAt: job.acceptedAt, ownerReturns: job.ownerReturns ?? [] },
    reviews: realReviews(ctx.store.table('jobReviews').list(row => row.jobId === job.id)),
    topicOwnerMessages: ctx.store.log('thread').all()
      .filter(row => row.thread === job.topicId && row.from === 'owner')
      .map(row => ({ id: row.id, text: row.text, at: row.createdAt })),
    messageTexts: Object.fromEntries(ctx.store.log('thread').all().filter(row => row.from === 'owner').map(row => [row.id, row.text])),
    outcome: outcome === null ? null : { rounds: outcome.rounds, reworks: outcome.reworks, turns: outcome.turns },
  });
  const noLearn = drafts.filter(row => row.kind !== 'acceptance');
  if (noLearn.length === 0) return; // 一次通过且没有纠正：不复盘，什么都不落。
  // 谁复盘：出处里出现过的执行者；漏判的核对人（collectRetroSources 已把它的 id 放进对应出处的 botIds）。
  const who = new Set<string>();
  for (const row of noLearn) for (const id of row.botIds) who.add(id);
  // 总管漏判、这件事没有评审员：总管记 skipped（no_checker），不排唤醒。
  const participants: SkillRun['participants'] = [];
  const sourcesToWrite: SkillSource[] = [];
  const now = ctx.clock.now();
  const runId = newId('sr', ctx.rng);
  for (const botId of who) {
    const bot = ctx.store.table('bots').get(botId);
    const sourceIds: string[] = [];
    for (const row of drafts) {
      if (!row.botIds.includes(botId)) continue;
      const source = parseInput(SkillSourceSchema, {
        id: newId('ss', ctx.rng), botId, kind: row.kind, label: row.label, quote: row.quote, relayed: row.relayed,
        jobId: job.id, category, refs: row.refs, createdAt: now,
      }, '技能出处');
      sourcesToWrite.push(source);
      sourceIds.push(source.id);
    }
    let state: SkillRun['participants'][number]['state'] = 'queued';
    let reason: SkillRun['participants'][number]['reason'] = null;
    const chiefMissedWithoutReviewer = botId === job.chiefId && job.reviewerId === null;
    const off = offDutyReason(bot);
    if (chiefMissedWithoutReviewer) { state = 'skipped'; reason = 'no_checker'; }
    else if (off !== null) { state = 'skipped'; reason = off; }
    participants.push({ botId, role: roleOf(botId, job), sourceIds, state, reason });
  }
  if (participants.length === 0) return; // 没有任何要复盘的参与者：不建记录。
  const run = parseInput(SkillRunSchema, {
    id: runId, kind: 'retro', jobId: job.id, category, participants,
    turnsUsed: 0, turnCap: D.RETRO_TURN_CAP, tokens: 0, summaryPostedAt: null, createdAt: now, endedAt: null,
  }, '复盘记录');
  // 第一段：表。出处先写、记录后写；记录写失败时把已写的出处删掉（半份数据不留，下次重来）。
  const written: string[] = [];
  try {
    for (const source of sourcesToWrite) { ctx.store.table('skillSources').put(source); written.push(source.id); }
    ctx.store.table('skillRuns').put(run);
  } catch (error) {
    for (const id of written) ctx.store.table('skillSources').remove(id);
    throw error;
  }

  // 第二段（表都写成功之后）：主题里落中心提示，再排第一位参与者的复盘唤醒。这一段出错一律只记日志，
  // 不回头撤表：参与者掉队由兜底（skill/run.ts 的 sweepSkillRuns）补排。
  const active = participants.filter(row => row.state !== 'skipped');
  const names = active.map(row => ctx.store.table('bots').get(row.botId)?.name ?? '员工');
  // 参与者全部 skipped 时没有人复盘，提示没有意义（「各复盘一次」前面没有名字），不落。
  if (names.length > 0) {
    softlyPost(ctx, '复盘提示', () => {
      postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'system', refId: job.id, text: retroHintText(noLearn.length, names) });
    });
  }
  // 排唤醒的顺序：执行者先；执行者 skipped 时直接给评审员（没有评审员或评审员也 skipped 时给总管）排。
  // 评审员本来就不先排（等执行者提交之后由 propose 排）。总管不等执行者：总管自己漏判的复盘与执行者的复盘互不依赖，
  // 由兜底在下一个 tick 排（总管只有在要复盘时才是参与者）。
  const executorRow = participants.find(row => row.role === 'executor');
  const first = executorRow !== undefined && executorRow.state !== 'skipped' ? executorRow
    : active.find(row => row.role === 'reviewer') ?? active.find(row => row.role === 'chief') ?? null;
  if (first !== null) {
    try {
      const wake = enqueueSkillWorkUndoable(ctx, { runId, botId: first.botId, key: retroSubjectKey(runId, first.botId), title });
      if (wake.entry === null) {
        // 入队失败：此刻停用或归档的记 skipped 及原因（任务卡第 3.2 节同一口径）；不是这个原因的（例如感知被去重）
        // 保持 queued，由兜底补排。
        const off = offDutyReason(ctx.store.table('bots').get(first.botId));
        if (off !== null) patchParticipant(ctx, runId, first.botId, 'skipped', off);
        ctx.logger.warn('复盘唤醒没有排上', { runId, botId: first.botId });
      }
    } catch (error) {
      ctx.logger.warn('复盘唤醒排队出错，由兜底补排', { runId, botId: first.botId, error: String(error) });
    }
  }
}

/** 改一位参与者的状态（state 与原因码）；run 不存在或没有这位参与者时不做任何事。 */
export function patchParticipant(
  ctx: HubContext, runId: string, botId: string,
  state: SkillRun['participants'][number]['state'], reason: SkillRun['participants'][number]['reason'] = null,
): void {
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null) return;
  const row = run.participants.find(item => item.botId === botId);
  if (row === undefined || (row.state === state && row.reason === reason)) return;
  const participants = run.participants.map(item => item.botId === botId ? { ...item, state, reason } : item);
  ctx.store.table('skillRuns').put({ ...run, participants });
}

/** 出错只记日志的一小步（与 accept.ts 的 softly 同一写法；这里不引 job/work-common 以免反向依赖）。 */
function softlyPost(ctx: HubContext, what: string, work: () => void): void {
  try { work(); } catch (error) { ctx.logger.warn(`${what}失败`, { error: String(error) }); }
}
