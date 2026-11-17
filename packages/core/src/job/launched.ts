/**
 * 执行者回报「已发布」（P74g，hub_job_work 的 launched）。
 *
 * 流程：主人批准发布审批之后，执行者执行发布，再用 launched 把发布后的地址告诉中心。
 * 中心先核对这件事确实在等发布结果，再记下地址，最后以总管的名义在总管私聊和主题里各落一句「已发布：地址」。
 *
 * 为什么要核对得这么严：这一句话主人会当成「已经上线」的事实。所以必须同时满足：
 * - 调用的是这件事的执行者（核对人、总管、别的员工都不行）；
 * - 这件事是已完成，发布状态是「等批准」，并且记下的那张发布审批单已经被主人批准（或批准后已被执行用掉）；
 *   审批还在等、被拒绝、过期的，都不能报「已发布」；
 * - 地址是 http:// 或 https:// 开头、有主机、没有空白和用户名密码（沿用证据检查里的网址规则）。
 * 三段式：先全部校验，再改状态（有备份，失败恢复），最后才说主人看得见的话（出错只记日志）。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { jobTitleOf } from './chain.js';
import { parseHttpUrl } from './evidence.js';
import { appendJobEvent, putJob } from './store.js';
import { locateJob, softly } from './work-common.js';

/** 不在等发布结果时的统一拒绝文字。 */
export const NOT_WAITING_LAUNCH_TEXT = '这件事现在不在等发布结果';

/** 地址的字数范围（任务卡：1 到 500 字）。 */
const LINK_MAX_CHARS = 500;

/** 记下发布地址。返回给模型的文字。 */
export async function runJobLaunched(ctx: HubContext, tc: ToolContext, args: { jobId: string; link?: string | undefined }): Promise<string> {
  const { bot, job } = locateJob(ctx, tc, args.jobId);
  // ---- 第一段：校验，一条都不写 ----
  if (bot.id !== job.executorId) throw new Error('只有这件事的执行者能回报发布结果');
  const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
  // P74r18b：发布命令已成功运行、已记为已发布但还没有网址：仍接受一次带网址的回报，只补记网址，不重复落「已发布」的话。
  const supplement = job.state === 'done' && job.launch.state === 'done' && job.launch.link === null && job.launchStep;
  if (job.state === 'done' && job.launch.state === 'failed') throw new Error('发布命令运行失败，不能回报已发布。可以重新提交发布审批。');
  if (job.state !== 'done' || (job.launch.state !== 'approval' && !supplement)) throw new Error(NOT_WAITING_LAUNCH_TEXT);
  // P74r6（N13）：只在发布命令已经运行并且成功之后接受（与发布用满回合时按事实说话的口径一致）：
  // 审批还没批准、已批准但命令还没运行、命令运行失败，各给一句写明事实的拒绝文字；被拒绝或已过期的审批仍按「不在等发布结果」处理。
  if (approval === null || approval.status === 'pending') throw new Error('发布审批还没有批准，不能回报已发布。');
  if (approval.status === 'approved') throw new Error('发布命令还没有运行，等它运行完再回报。');
  if (approval.status !== 'used') throw new Error(NOT_WAITING_LAUNCH_TEXT);
  const sent = ctx.store.table('outbox').list(row => row.approvalId === approval.id);
  if (!sent.some(row => row.status === 'done')) {
    if (sent.length > 0 && sent.every(row => row.status === 'failed')) throw new Error('发布命令运行失败，不能回报已发布。可以重新提交发布审批。');
    throw new Error('发布命令还没有运行，等它运行完再回报。');
  }
  if (args.link === undefined) throw new Error('缺少必填项：link（mode 为 launched 时要填写，写发布后的地址）');
  const link = args.link;
  if ([...link].length < 1 || [...link].length > LINK_MAX_CHARS) throw new Error(`link：长度要在 1 到 ${LINK_MAX_CHARS} 字之间`);
  if (parseHttpUrl(link) === null) throw new Error('link：只接受 http:// 或 https:// 开头、没有空白和用户名密码的地址');

  // ---- 第二段：写状态（有备份）----
  const now = ctx.clock.now();
  const next = JobSchema.parse({ ...job, launch: { ...job.launch, state: 'done', link }, updatedAt: now });
  try {
    putJob(ctx, next);
    appendJobEvent(ctx, { jobId: job.id, actor: bot.id, kind: 'launched', to: ['owner'], refId: job.launch.approvalId, data: { link } });
  } catch (error) {
    putJob(ctx, job);
    throw new Error(`没有记下发布地址，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_launched', { jobId: job.id }, bot.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);

  // 只补记网址的回报：「已发布」的话在命令成功时已经落过（job/launch-result.ts），这里不再落。
  if (supplement) return '已记下发布地址。';
  // ---- 第三段：以总管的名义在总管私聊和主题里各落一句（地址原样显示）----
  const text = `${jobTitleOf(ctx, job)}已发布：${link}`;
  softly(ctx, '总管私聊里的发布结果', () => { postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text }); });
  softly(ctx, '主题里的发布结果', () => { postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'reply', refId: job.id, text }); });
  return '已记下发布地址。';
}
