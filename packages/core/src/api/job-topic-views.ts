/**
 * 把「一件事」的纯视图接到现有视图上（P74a）：读存储、整理输入，再交给 job-views.ts 的纯函数。
 *
 * 为什么和纯函数分开：纯函数只管「输入 → 文字」，可以逐种状态单测；
 * 这里只负责「从存储里取输入」，不做任何业务判断，也不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { ThreadMessage } from '../model/outreach.js';
import { agreementForTopic } from '../project/agreements.js';
import { eventsOf, jobOfAgreement } from '../job/store.js';
import { jobDelayNote } from '../job/delay.js';
import { displayEstimate, latestEstimate } from '../job/estimate.js';
import { alignmentOf, costLineOf, emptySteps } from '../job/usage.js';
import { chiefJobLine, projectJobRows, topicFloorsView } from './job-views.js';
import { cardRecipientsFor, cardTitleFor } from './job-card-views.js';
import type { JobProgressView, ProjectJobRow, TopicFloorsView } from './types.js';
import { memoryNotesIndex, type MemoryNoteView } from './memory-views.js';
import { currentVersionNo, nameTable, progressBaseOf } from './job-progress-base.js';
import { activeJobsView } from './active-jobs-views.js';

/** 主题的进度行：主题上没有约定（或约定已撤下）时为 null。delayNote 由 job/delay.ts 按闸门结果算出（P74c）。 */
export function jobProgressForTopic(ctx: HubContext, topicId: string): JobProgressView | null {
  const agreement = agreementForTopic(ctx, topicId);
  if (!agreement) return null;
  const job = jobOfAgreement(ctx, agreement.id);
  const names = nameTable(ctx);
  // P76i：输入整理（谁不在岗、发布这一步在等谁）挪到 job-progress-base.ts，与「在办的事」共用同一份。
  const view = progressBaseOf(ctx, agreement, job, job === null ? null : jobDelayNote(ctx, job, ctx.clock.now()));
  if (view === null) return null;
  // P76e：第三行「消耗」与逐回合明细。已有这件事：读它的用量行和约定当前预计；还没有（对齐中、已固定未派活）：
  // 用约定各版本的唤醒单现算对齐回合，预计取当前版本显示的那一项（待确认取 draft）。
  // P76r3（R6）：这件事已有时预计一律取 latestEstimate，与条目、私聊、用量表、总管唤醒包一致；
  // 对齐中还没有这件事、也就没有生效的预计，仍显示这一版的 draft。
  const version = agreement.versions.find(row => row.no === currentVersionNo(agreement))!;
  const estimate = job !== null ? latestEstimate(ctx, agreement.id) : displayEstimate(ctx, agreement, version);
  const usage = job !== null ? ctx.store.table('jobUsage').get(job.id)
    : { id: 'job_aligning', agreementId: agreement.id, category: '', steps: { ...emptySteps(), align: alignmentOf(ctx, agreement) }, turns: [], finalizedAt: null, updatedAt: 0 };
  // 没有用量行（旧数据、没记过账）时不带这两个键，既有的样例与预览快照（插件）逐字不变。
  // P87：「你发起的回合」一栏在自己的表里，已有这件事时读它（对齐中没有这件事，没有这一栏）。
  const cost = costLineOf(usage, estimate, names, ctx.settings.timezone, job === null, job === null ? null : ctx.store.table('jobOwnerTurns').get(job.id));
  return cost.costLine === null ? view : { ...view, ...cost };
}

/** 主题的楼层与往来折叠；messages 是该主题线程的全部消息（按时间升序）。 */
export function topicFloorsForTopic(ctx: HubContext, topicId: string, messages: ThreadMessage[], notes: Map<string, MemoryNoteView[]> = memoryNotesIndex(ctx)): TopicFloorsView {
  const agreement = agreementForTopic(ctx, topicId);
  const job = agreement ? jobOfAgreement(ctx, agreement.id) : null;
  const events: Record<string, { actor: string; to: string[] }> = {};
  if (job) for (const event of eventsOf(ctx, job.id)) events[event.id] = { actor: event.actor, to: event.to };
  // 交账 id 以 c_ 开头；只查线程里真正出现的那几条。
  const commitSenders: Record<string, string> = {};
  for (const message of messages) {
    if (message.kind === 'work' && message.refId?.startsWith('c_')) {
      const commit = ctx.store.table('commits').get(message.refId);
      if (commit) commitSenders[commit.id] = commit.botId;
    }
  }
  // P74d：折叠组里卡片消息的标题换成准确的函数（交回卡写「{执行者}交回第 n 轮」，核对卡取卡片标题）。
  return topicFloorsView({ messages, names: nameTable(ctx), events, commitSenders,
    chiefId: agreement?.botId ?? null, timezone: ctx.settings.timezone, cardTitleOf: cardTitleFor(ctx), cardRecipientsOf: cardRecipientsFor(ctx),
    memoryNotesOf: message => notes.get(message.id) });
}

/**
 * 总管员工行上的一句话；没有在办的事为 null。
 * P76i：输入改为「在办的事」的行（口径与右栏同一份：没收尾的事加待确认的约定），写「n 件在办」「n 件在办，m 件等你」。
 * 只要件数和「等你」的件数，不要每行的文字，所以不做额度闸门重放（textual: false），总览每次刷新才不会变重。
 */
export function chiefJobLineFor(ctx: HubContext, chiefId: string): string | null {
  return chiefJobLine(activeJobsView(ctx, chiefId, { textual: false }).rows);
}

/** 一个项目页里的「一件事」行。 */
export function jobRowsForProject(ctx: HubContext, projectId: string): ProjectJobRow[] {
  const rows = ctx.store.table('jobs').list(job => job.projectId === projectId).map(job => ({
    job, title: ctx.store.table('agreements').get(job.agreementId)?.title ?? '未命名',
    executorName: ctx.store.table('bots').get(job.executorId)?.name ?? '已删除的员工',
  }));
  return projectJobRows(rows, ctx.settings.timezone);
}
