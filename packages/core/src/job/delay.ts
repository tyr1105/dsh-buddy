/**
 * 进度行的「延迟说明」（P74c，方案 7.4）：一件事的下一步被什么挡住了，用一句主人看得懂的话说出来。
 *
 * 为什么要有：执行链的候选可能被额度、鉴权、并发、重试退避这些全局保护拦住，拦住时不会有任何提示，
 * 主人只会看到「执行中」却迟迟没有动静。这一句让主人知道「不是坏了，是在等」，以及大概等到什么时候。
 *
 * 做法：取这件事排在队列里的第一条候选，用同一个纯函数 evaluateGates 重放一遍闸门（不写日志、不改任何状态），
 * 把拦截原因换成短句。额度用完不主动通知主人（与第五块一致），只写在这里。
 * 文字里不出现工具名、机器人 id、内部编号。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { buildSnapshot, evaluateGates } from '../scheduler/gates.js';
import { expectedActorOf } from './chain.js';
import { confirmWaitNo } from './confirm-wait.js';
import { listQueue } from '../scheduler/queue.js';
import { isOpenWake } from '../turn/session.js';
import { localParts } from '../util/time.js';
import { quotaWindowView } from '../api/quota-views.js';

const pad = (value: number): string => String(value).padStart(2, '0');

/** 「HH:mm」（按设置里的时区）。 */
function clockText(ctx: HubContext, at: number): string {
  const parts = localParts(at, ctx.settings.timezone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** 这件事的延迟说明；没有要说的（放行、或这件事不在进行中）为 null。 */
export function jobDelayNote(ctx: HubContext, job: Job, now: number): string | null {
  // 1. 只有进行中的事才有「延迟」。
  if (!['ready', 'doing', 'checking', 'rework'].includes(job.state)) return null;
  // P74r2b：在等主人确认约定的新版本：如实写出在等什么（不写「排队中」，没有人在排队）。
  const confirmNo = confirmWaitNo(job);
  if (confirmNo !== null) return `在等你确认约定第 ${confirmNo} 版`;
  // 3. 有员工正在跑这件事的回合：没有延迟。
  if (ctx.store.table('wakes').count(wake => wake.jobId === job.id && isOpenWake(wake)) > 0) return null;
  // 2. 排队里这件事的第一条候选（按优先级）。
  // P74r16b：「排队中」只在队列里确实有这个人、这件事的候选时才写：这件事此刻在等某个人（expectedActorOf）时只看他的候选；
  // 没有候选就没有人在排队，什么都不写（原来一条都没有也写「排队中」，员工被停用等情形下会写错）。
  const actor = expectedActorOf(job);
  const entry = listQueue(ctx).find(row => row.jobId === job.id && (actor === null || row.botId === actor));
  if (entry === undefined) return null;
  // 4. 重放闸门，把拦截原因换成短句。
  const snapshot = buildSnapshot(ctx, entry.botId, now, job.id);
  const verdict = evaluateGates(entry, snapshot, now, ctx.settings);
  if (verdict.pass) return null;
  switch (verdict.by) {
    case 'quota':
      if (snapshot.authBlocked) return '模型服务需要重新登录';
      // P76d：额度挡住时的文字读额度视图（与员工的活动文字、顶栏说的恢复时间一致）：「额度恢复，约 HH:mm 继续」。
      // 视图判断不是被挡住的状态（例如橙灯挡住的候选）时，按这次闸门给出的恢复时刻写同样的句式。
      return quotaWindowView(ctx, now).waitText
        ?? (verdict.until === null ? '额度用完' : `额度恢复，约 ${clockText(ctx, verdict.until)} 继续`);
    case 'concurrency':
      // P74r12：并发拦截有两种原因：这位员工自己有回合在跑（snapshot.running，闸门里的同员工互斥），照旧写「正在忙别的事」；
      // 否则是别人的回合占着全局的位置（同时只能跑有限个回合），这位员工只是在排队，不能说他在忙。
      return snapshot.running ? `${snapshot.bot?.name ?? '员工'}正在忙别的事` : '排队中，等正在进行的回合结束';
    case 'retry_backoff':
      return verdict.until === null ? '排队中' : `上次出错，约 ${clockText(ctx, verdict.until)} 重试`;
    case 'waiting_owner': case 'waiting_owner_same_subject':
      return '在等你回答';
    default:
      // 启动静默、全局放行间隔，以及其余情况：只说在排队。
      return '排队中';
  }
}
