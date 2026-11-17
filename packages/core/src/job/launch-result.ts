/**
 * 发布命令的结果回到这件事上（P74r18b 第 2 节）。
 *
 * 为什么需要：主人批准发布命令之后，命令由中心（引擎）代为运行。以前命令失败时，只在执行者的私聊落一行带命令全文的话，
 * 这件事的发布状态、主题、总管私聊、进度行都没有变化，也没有人被叫醒，主人只会看到「你批准了发布」，以为成功了。
 * 现在命令运行完（成功或失败），由出站动作的收尾处调用本文件：
 * - 成功：发布状态记为已发布，主题和总管私聊以总管名义各落一句，叫醒执行者一次（有网址就补记，没有就收尾）；
 * - 失败：发布状态记为「发布没有成功」（failed），主题和总管私聊各落一句（不带命令、退出码、绝对路径），
 *   叫醒执行者一次（改正命令重新提交，或交账写 blocked）；
 * - 这张审批不是这件事在等的发布审批：什么都不做，交回调用方按普通出站动作处理。
 * 写法照 P74 一贯的三段：先改状态（写失败恢复），再落话，最后叫醒；落话和叫醒出错只记日志，不影响出站记录本身。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { LaunchWait } from '../api/job-views.js';
import type { HubContext } from '../engine/context.js';
import { HOST_SANDBOX_UNAVAILABLE } from '../io/interfaces.js';
import { launchOf } from '../model/agreement.js';
import { LOCAL_DIR_CHANGED_REASON } from '../project/local-dir.js';
import { JobSchema, type Job } from '../model/job.js';
import type { OutboxAction } from '../model/outreach.js';
import { postThread } from '../outreach/thread.js';
import { isOpenWake } from '../turn/session.js';
import { outboxErrorText } from '../util/outbox-text.js';
import { enqueueJobWake, jobTitleOf } from './chain.js';
import { lockedVersionOf } from './files.js';
import { noteJobOf } from './launch-approval.js';
import { appendJobEvent, putJob } from './store.js';

/** 成功之后叫执行者的唤醒原因（给模型看，逐字）。 */
export const LAUNCH_OK_WAKE_TEXT = '发布命令已成功运行，这件事已记为已发布。发布之后有可以访问的网址时，调用 hub_job_work，mode 写 launched，link 写网址；没有网址就直接交账收尾。';

/** P82：给主人看的那一句里，失败原因最多带多少字（全文留在出站记录里）。 */
const OWNER_REASON_MAX_CHARS = 120;

/** 失败之后叫执行者的唤醒原因（给模型看，逐字；error 是错误输出的前 200 字，已去掉换行）。 */
export function launchFailedWakeText(error: string): string {
  return `发布命令运行失败：${error}。是命令本身写错了，就改正后重新提交一次发布审批；是发布的位置中心写不进去，或别的你解决不了的原因，就交账写 blocked，说明原因。不要自己更换约定里写的发布位置。`;
}

/** 约定里写的发布方式（已固定那一版的对外发布一项）；取不到时为 null。 */
function launchHowOf(ctx: HubContext, job: Job): string | null {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  return agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.how ?? null;
}

/** 成功时主题和总管私聊里的那一句（逐字）：「{标题}」已发布：{发布方式}。 */
export function launchSucceededText(title: string, how: string | null): string {
  return how === null ? `「${title}」已发布。` : `「${title}」已发布：${how}。`;
}

/** P85：命令没有运行时，给主人看的固定原因（只有这四种；其余情形都归到最后一种）。 */
export const NOT_RUN_REASONS = ['找不到命令里的程序', '没有运行这条命令的权限', '命令的执行目录不在允许的范围内', '运行命令时出错',
  '命令用到的脚本在批准之后被改动', '现在的权限设置不允许运行这条命令'] as const;

/** 按出站记录里留着的异常原文，归到上面四种固定原因之一（原文本身不外传）。 */
function notRunReasonOf(row: Pick<OutboxAction, 'ownerFailureReason' | 'result'>): (typeof NOT_RUN_REASONS)[number] {
  const raw = `${row.result ?? ''}\n${row.ownerFailureReason ?? ''}`;
  // 复验 C3：这两种是中心自己的固定句（不含路径），原来会落到兜底说法。
  if (/脚本在批准后被改动/.test(raw)) return NOT_RUN_REASONS[4];
  if (/当前自主等级不允许/.test(raw)) return NOT_RUN_REASONS[5];
  if (/命令执行目录必须在家目录或共享目录内/.test(raw)) return NOT_RUN_REASONS[2];
  if (/ENOENT|not found|找不到/i.test(raw)) return NOT_RUN_REASONS[0];
  if (/EACCES|EPERM|Permission denied|Operation not permitted|权限/i.test(raw)) return NOT_RUN_REASONS[1];
  return NOT_RUN_REASONS[3];
}

/**
 * 失败时主题和总管私聊里的那一句（逐字；不带命令原文、退出码以外的路径也不带）。三种：
 * - 沙箱不可用、超时：沿用出站记录里存的固定说明；
 * - 错误输出里有「Operation not permitted」或「Permission denied」：写入被拒；
 * - 其他：发布命令运行出错，后面用括号带上中心确认的失败原因（P82：宿主原文要如实转述给主人，
 *   原来只写「发布命令运行出错」，真实模型把「执行目录不对」说成了别的原因）。
 * 先判固定说明：沙箱不可用的报错里也可能夹着「Operation not permitted」，不能当成写入被拒。
 */
export function launchFailedText(title: string, row: Pick<OutboxAction, 'ownerFailureReason' | 'result' | 'executionStarted'>): string {
  const reason = row.ownerFailureReason;
  if (reason === HOST_SANDBOX_UNAVAILABLE || reason === '命令超时') return `「${title}」没有发布成功：${reason}`;
  // P81：运行前重新核对时发现约定的发布位置现在指向别处，命令没有运行（固定说明，不带路径）。
  if (reason === LOCAL_DIR_CHANGED_REASON) return `「${title}」没有发布成功：${reason}`;
  // P85（W8）：命令根本没有运行（启动失败、取真实路径出错、执行目录不对等）：只写固定的几种原因，
  // 异常原文、绝对路径、命令名都不出现在这一句里（它们留在出站记录和给执行者的唤醒原因里）。
  if (row.executionStarted === false) return `「${title}」没有发布成功：发布命令没有运行（${notRunReasonOf(row)}）。`;
  if (/Operation not permitted|Permission denied/i.test(row.result ?? '')) return `「${title}」没有发布成功：要发布到的位置写不进去。`;
  // P82：宿主原文（ownerFailureReason 是中心确认的一句，不含命令输出和网络正文）带给主人；取前 120 字，避免长句占满线程。
  const detail = reason === undefined || reason.trim() === '' ? '' : `（${Array.from(reason.trim()).slice(0, OWNER_REASON_MAX_CHARS).join('')}）`;
  return `「${title}」没有发布成功：发布命令运行出错${detail}。`;
}

/** 这条出站动作的审批，是不是某件事正在等的发布审批；是就返回这件事，不是返回 null。 */
export function launchJobOfOutbox(ctx: HubContext, row: Pick<OutboxAction, 'approvalId'>): Job | null {
  if (row.approvalId === null || row.approvalId === undefined) return null;
  const job = noteJobOf(ctx, row.approvalId);
  if (job === null || job.state !== 'done' || job.launch.state !== 'approval' || job.launch.approvalId !== row.approvalId) return null;
  return job;
}

/** 在主题和总管私聊各以总管名义落同一句；出错只记日志。 */
function chiefSays(ctx: HubContext, job: Job, text: string): void {
  for (const thread of [job.topicId, job.chiefId]) {
    try { postThread(ctx, { thread, from: job.chiefId, kind: 'reply', refId: job.id, text }); }
    catch (error) { ctx.logger.warn('发布结果的话没有落下', { jobId: job.id, thread, error: String(error) }); }
  }
}

/**
 * 命令运行完之后的处理。row 已经是终点状态（done 或 failed）。
 * 返回 true：这是这件事的发布审批，已经处理（调用方不再在执行者私聊落那行结果、也不再按普通出站动作叫醒）；
 * 返回 false：与发布无关，调用方照普通出站动作处理。出错也返回 true（避免重复处理），只记日志。
 */
export function settleLaunchResult(ctx: HubContext, row: OutboxAction): boolean {
  const job = launchJobOfOutbox(ctx, row);
  if (job === null) return false;
  if (row.status !== 'done' && row.status !== 'failed') return false;
  try {
    const ok = row.status === 'done';
    const now = ctx.clock.now();
    // ---- 第一段：改发布状态（写失败恢复并抛出）----
    const next = JobSchema.parse({ ...job, launch: { ...job.launch, state: ok ? 'done' : 'failed' }, updatedAt: now });
    try {
      putJob(ctx, next);
      // 成功记 launched（没有网址），失败记 launch_failed（不能记 launch_declined：那是主人没有同意发布）。
      // P82：失败时把中心确认的失败原因（宿主原文）一并记进这件事的记录，账本上能查到为什么没发出去。
      appendJobEvent(ctx, ok
        ? { jobId: job.id, actor: 'hub', kind: 'launched', to: ['owner'], refId: row.approvalId, data: { link: null, reason: 'command_ok' } }
        : { jobId: job.id, actor: 'hub', kind: 'launch_failed', to: [job.executorId], refId: row.approvalId,
            data: { reason: 'command_failed', ...(row.ownerFailureReason ? { detail: Array.from(row.ownerFailureReason).slice(0, 200).join('') } : {}) } });
    } catch (error) {
      putJob(ctx, job);
      throw error;
    }
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
    // ---- 第二段：主题和总管私聊各落一句 ----
    const title = jobTitleOf(ctx, job);
    chiefSays(ctx, job, ok ? launchSucceededText(title, launchHowOf(ctx, job)) : launchFailedText(title, row));
    // ---- 第三段：叫执行者一次（带这件事的编号，计入发布这一步的回合上限）----
    const entry = enqueueJobWake(ctx, { job: next, botId: job.executorId, why: 'outbox_result', eventId: null,
      summary: ok ? LAUNCH_OK_WAKE_TEXT : launchFailedWakeText(outboxErrorText(row)),
      ownerSummary: ok ? '发布命令已成功运行' : '发布命令运行失败' });
    if (entry === null) ctx.logger.warn('发布命令有了结果，但执行者的唤醒没有排上', { jobId: job.id, ok });
  } catch (error) {
    ctx.logger.warn('发布命令的结果没有回到这件事上', { jobId: job.id, error: String(error) });
  }
  return true;
}

/**
 * 发布这一步此刻在等谁的两个事实（进度行用，只读）：
 * - 发布审批已批准、命令还没运行完：running 为真，「在等」写「中心运行发布命令」；
 * - 发布没有成功：执行者有带这件事的唤醒在排队或在跑，executorWaking 为真，「在等」写执行者，否则写「你」。
 */
export function launchWaitOf(ctx: HubContext, job: Job): LaunchWait {
  if (job.state !== 'done') return {};
  if (job.launch.state === 'approval') {
    const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
    if (approval === null || (approval.status !== 'approved' && approval.status !== 'used')) return {};
    const finished = ctx.store.table('outbox').count(row => row.approvalId === approval.id && ['done', 'failed', 'rejected'].includes(row.status)) > 0;
    return { running: !finished };
  }
  if (job.launch.state === 'failed') {
    const queued = ctx.store.table('queue').count(row => row.botId === job.executorId && row.jobId === job.id) > 0;
    const running = ctx.store.table('wakes').count(wake => wake.botId === job.executorId && wake.jobId === job.id && isOpenWake(wake)) > 0;
    return { executorWaking: queued || running };
  }
  return {};
}
