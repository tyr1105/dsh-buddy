/**
 * 改派的第一段：全部校验，一条都不写（P74b 建，P74r1、P74r2a 扩充）。
 *
 * 改派（hub_job_manage 的 reassign）可以换执行者（executor）、换核对人（reviewer），两项至少写一项，可以同时写。
 * 原则：返回「已改派」「已把核对人换成……」时，这件事要么真的能继续（该叫醒的人已入队），要么如实说明还不能继续。
 * 所以凡是「换了也没用」的情形，在写任何东西之前拒绝，并告诉总管真正该换谁：
 * - 回合已用到上限、主人选了先停下、核对三轮不过：拒绝，要等主人的答复；
 * - 执行者做不下去（卡在执行环节）：只能换执行者；
 * - 核对环节没有动静（核对人一直没提交结论）：只能换核对人，换执行者解决不了；
 * - 有人停用：停用的是谁就要换谁；两位都停用时允许先换其中一位，另一位仍停用，这件事保持受阻。
 *
 * 本文件只读存储，写入在 reassign.ts。
 */
import type { HubContext } from '../engine/context.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import type { Bot } from '../model/bot.js';
import { JOB_STATE_LABELS, type Job } from '../model/job.js';
import { wakeOfToolContext } from '../peer/common.js';
import { dispatchBlockFor } from '../project/agreement-gate.js';
import type { ToolContext } from '../tools/types.js';
import { assertFilled, resolveExecutor, resolveReviewer, type JobManageArgs } from './assign.js';
import { isOnDutyNow } from './chain.js';
import { suspendedParticipantOfWake } from './suspended.js';
import { chosenWhileBlocked } from './review-limit-exit.js';
import { isJobClosed } from './store.js';
import { reviewStalled } from './version-stage.js';

/** 换执行者允许的状态。 */
const EXECUTOR_STATES: readonly Job['state'][] = ['ready', 'doing', 'rework', 'blocked'];
/** 换核对人允许的状态（受阻的事另按原因判断）。 */
const REVIEWER_STATES: readonly Job['state'][] = ['ready', 'doing', 'rework', 'checking', 'blocked'];

/** 核对环节没有动静时，只写 executor 的拒绝文字。 */
export const REVIEW_STALLED_REASSIGN_TEXT = '这件事卡在核对环节，换执行者解决不了。要换核对人，写 reviewer；写「总管」表示由你自己核对。';

/** 改派的计划：校验通过后，写入只用这里的对象，不再回头查。 */
export interface ReassignPlan {
  chief: Bot;
  job: Job;
  title: string;
  /** 这次要换的新执行者；不换为 null。 */
  newExecutor: Bot | null;
  /** 这次是否换核对人；newReviewer 为 null 且 reviewerChanged 为真，表示改由总管自己核对。 */
  reviewerChanged: boolean;
  newReviewer: Bot | null;
  /** 改完之后的执行者、核对人（null 表示总管自己核对）。 */
  executorId: string;
  reviewerId: string | null;
  /** 改完之后仍不在岗的人（两位都停用、只换了一位时非空）。 */
  stillOff: Bot[];
  /** 随改派作废的提问：提问人不再是这件事的执行者或核对人。 */
  voidedAsk: { by: 'executor' | 'reviewer'; asker: Bot | null; eventId: string; text: string } | null;
}

/** 某位员工此刻是否停用（核对人为空表示总管自己核对，不算）。 */
function isOff(ctx: HubContext, botId: string | null): boolean {
  return botId !== null && !isOnDutyNow(ctx, botId);
}

/** id 对应的名字，找不到时用 fallback。 */
function nameOf(ctx: HubContext, botId: string | null, fallback: string): string {
  return botId === null ? '总管' : ctx.store.table('bots').get(botId)?.name ?? fallback;
}

/** 状态本身不允许时的拒绝文字（不看受阻原因）。 */
function stateRefusal(job: Job, wantExecutor: boolean): string | null {
  const label = JOB_STATE_LABELS[job.state];
  if (wantExecutor) {
    return EXECUTOR_STATES.includes(job.state) ? null : `这件事当前是「${label}」，只有待开工、执行中、返工中、受阻时才能改派`;
  }
  return REVIEWER_STATES.includes(job.state) ? null : `这件事当前是「${label}」，只有待开工、执行中、返工中、核对中、受阻时才能换核对人`;
}

/**
 * 回合用尽、受阻原因等「换了也没用」的情形（P74r1 R3，P74r2a 扩充）。能改返回 null；不能返回给总管看的原因。
 * wantExecutor、wantReviewer 是这次要换谁。
 */
function blockRefusal(ctx: HubContext, job: Job, wantExecutor: boolean, wantReviewer: boolean): string | null {
  const capText = `这件事的回合已经用到上限（${job.turnCap} 个），要等主人对回合上限的答复（再给回合或暂停）之后才能改派。`;
  if (job.turnsUsed >= job.turnCap) return capText;
  if (job.state !== 'blocked' || job.blocked === null) return null;
  const executorName = nameOf(ctx, job.executorId, '执行者');
  switch (job.blocked.kind) {
    case 'turn_cap': return capText;
    case 'owner_hold': return '主人已暂停，这件事暂时不再往下做，不能改派。';
    case 'review_limit':
      // P74f-2：主人已经在三轮不过卡上选了办法（选的是不带改动的办法，这件事仍受阻）：照办法换人就可以改派了。
      // P74r6：判断改用 chosenWhileBlocked（说明是这一次受阻的，主人已选）。
      return chosenWhileBlocked(job) !== null ? null : '这件事核对三轮仍未通过，要等主人选定办法之后才能改派。';
    case 'executor':
      if (reviewStalled(job)) {
        // 核对环节没有动静：核对人才是要换的人。
        if (wantExecutor && !wantReviewer) return REVIEW_STALLED_REASSIGN_TEXT;
        if (wantExecutor && wantReviewer) return '这件事卡在核对环节，换执行者解决不了。这次只写 reviewer 换核对人；写「总管」表示由你自己核对。';
        return null;
      }
      // 执行环节：执行者做不下去，换核对人解决不了。
      return wantExecutor ? null : `这件事停住是因为${executorName}做不下去，换核对人解决不了。要换执行者，写 executor。`;
    case 'participant_off': {
      const executorOff = isOff(ctx, job.executorId);
      const reviewerOff = isOff(ctx, job.reviewerId);
      // 只有一位停用时，必须换的就是他；两位都停用时允许先换其中一位。
      if (reviewerOff && !executorOff && !wantReviewer) {
        return `这件事停住是因为${nameOf(ctx, job.reviewerId, '核对人')}已停用，换执行者解决不了。要换核对人，写 reviewer；写「总管」表示由你自己核对。`;
      }
      if (executorOff && !reviewerOff && !wantExecutor) {
        return `这件事停住是因为${executorName}已停用，换核对人解决不了。要换执行者，写 executor。`;
      }
      return null;
    }
  }
}

/** 全部校验，不写任何东西。 */
export function planReassign(ctx: HubContext, tc: ToolContext, args: JobManageArgs): ReassignPlan {
  // P74r1（R4）：除了主人发话、确认、回答叫醒的回合，总管在这件事自己的执行链唤醒里（因为执行者做不下去等被叫醒）也可以改派。
  const chief = ctx.store.table('bots').get(tc.botId);
  if (!chief || chief.role !== 'chief') throw new Error('只有总管能改派');
  const wake = wakeOfToolContext(ctx, tc);
  assertFilled(args, ['jobId']);
  if (args.executor === undefined && args.reviewer === undefined) {
    throw new Error('缺少必填项：executor、reviewer（mode 为 reassign 时至少写一个：换执行者写 executor，换核对人写 reviewer）');
  }
  if (!wake || (wake.ownerInitiated !== true && wake.jobId !== args.jobId)) throw new Error('改派只能在主人发话、确认或回答叫醒的回合里进行');
  // 这件事：存在、是你的。报错列出你手上的事。
  const job = ctx.store.table('jobs').get(args.jobId!);
  if (!job || job.chiefId !== chief.id) {
    const mine = ctx.store.table('jobs').list(row => row.chiefId === chief.id && !isJobClosed(row));
    const listed = mine.length === 0 ? '你现在没有在办的事'
      : `你手上的事：${mine.map(row => `「${ctx.store.table('agreements').get(row.agreementId)?.title ?? '未命名'}」（jobId 为 ${row.id}）`).join('、')}`;
    throw new Error(`jobId：没有你名下的这件事。${listed}`);
  }
  const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
  const wantExecutor = args.executor !== undefined;
  const wantReviewer = args.reviewer !== undefined;
  const wrongState = stateRefusal(job, wantExecutor);
  if (wrongState !== null) throw new Error(wrongState);
  const gate = dispatchBlockFor(ctx, chief.id, job.agreementId);
  if (gate !== null) throw new Error(gate);
  // P74r17（疑点一）：这个回合是因某位参与者被停用而叫醒总管的，而这位参与者已经恢复在岗、这件事已经接着做时，
  // 要换的正是他的位置就不需要换了：拒绝，不撤掉因恢复而给他排的候选。只在认得出是停用唤醒时这样拒绝，别的情形下的换人不受影响。
  const reinstated = wake ? suspendedParticipantOfWake(ctx, wake, job) : null;
  if (reinstated !== null && isOnDutyNow(ctx, reinstated.id)
    && ((reinstated.id === job.executorId && wantExecutor) || (reinstated.id === job.reviewerId && wantReviewer))
    && !(job.state === 'blocked' && job.blocked?.kind === 'participant_off' && isOff(ctx, reinstated.id))) {
    throw new Error(`${reinstated.name}已恢复在岗，这件事已接着做，不需要换人。`);
  }
  // 返回「已改派」就必须保证这件事能继续或如实说明还不能继续，所以「换了也没用」的情形在写任何东西之前拒绝。
  const refusal = blockRefusal(ctx, job, wantExecutor, wantReviewer);
  if (refusal !== null) throw new Error(refusal);

  // 新执行者、新核对人（解析规则与派活时完全相同：复用 assign.ts 的两个函数）。
  let newExecutor: Bot | null = null;
  if (wantExecutor) {
    newExecutor = resolveExecutor(ctx, chief, args.executor!);
    if (newExecutor.id === job.executorId) throw new Error(`executor：「${title}」本来就是${newExecutor.name}在做`);
  }
  const executorBot = newExecutor ?? ctx.store.table('bots').get(job.executorId);
  if (!executorBot) throw new Error('这件事的执行者找不到了，不能改派');
  let newReviewer: Bot | null = null;
  if (wantReviewer) {
    newReviewer = resolveReviewer(ctx, chief, args.reviewer, executorBot);
    if ((newReviewer?.id ?? null) === job.reviewerId) throw new Error(`核对人已经是${newReviewer?.name ?? '总管'}`);
  }
  const reviewerId = wantReviewer ? newReviewer?.id ?? null : job.reviewerId;
  if (newExecutor !== null && newExecutor.id === reviewerId) throw new Error('executor：新执行者不能是这件事的核对人');

  // 项目：未归档，成员席位够用。
  const project = ctx.store.table('projects').get(job.projectId);
  if (!project || project.archivedAt !== null) throw new Error(`「${title}」所在的项目已归档，不能改派`);
  const joining = [newExecutor?.id, newReviewer?.id].filter((id): id is string => id !== undefined && !project.memberBotIds.includes(id));
  if (project.memberBotIds.length + new Set(joining).size > V2_DEFAULTS.PROJECT_MEMBER_MAX) {
    const who = newExecutor !== null && wantReviewer ? '新执行者和新核对人' : newExecutor !== null ? '新执行者' : '新核对人';
    throw new Error(`项目成员已满（上限 ${V2_DEFAULTS.PROJECT_MEMBER_MAX} 位），不能再加入${who}`);
  }

  // 改完之后仍不在岗的人；以及随改派作废的提问（提问人不再是执行者或核对人）。
  const stillOff = [executorBot.id, reviewerId].filter((id): id is string => id !== null && isOff(ctx, id))
    .map(id => ctx.store.table('bots').get(id)).filter((bot): bot is Bot => bot !== null);
  let voidedAsk: ReassignPlan['voidedAsk'] = null;
  const ask = job.openAsk;
  if (ask !== null && ask.fromId !== executorBot.id && ask.fromId !== reviewerId) {
    const asked = ctx.store.log('jobEvents').all().find(event => event.id === ask.eventId);
    const fromEvent = typeof asked?.data.text === 'string' ? asked.data.text : '';
    voidedAsk = {
      by: ask.fromId === job.executorId ? 'executor' : 'reviewer',
      asker: ctx.store.table('bots').get(ask.fromId), eventId: ask.eventId,
      // 提问原文优先读这件事的记录（P74r2a），没有才回头找事件。
      text: ask.text ?? (fromEvent === '' ? '（问题原文没有留在记录里）' : fromEvent),
    };
  }
  return { chief, job, title, newExecutor, reviewerChanged: wantReviewer, newReviewer, executorId: executorBot.id, reviewerId, stillOff, voidedAsk };
}
