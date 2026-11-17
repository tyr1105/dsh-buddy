/**
 * 发布这一步结束之后的两道收口（P74r15 第 1 节）。
 *
 * 为什么需要：「对外发布」这一步可以由几种原因结束（主人确认约定去掉了对外发布、主人拒绝了发布审批、
 * 回合用满上限、中心结束了执行者的回合）。如果结束的那一刻执行者的「准备发布」回合还在跑，
 * 它仍然能提交发布命令，总管私聊里就会冒出「在准备发布……这一步需要你批准」，主人刚确认了不发布，又被请求批准。
 * 所以发布这一步结束时要做两件事：
 * 1. 取消执行者正在跑的发布准备回合（cancelLaunchTurn）：照现有取消回合的做法（先让宿主取消，宿主取消成功才把回合记为超时结束），
 *    原因写「中心结束」，不算员工的故障，不触发重试；宿主取消抛错时不记结束（回合在宿主那边其实还在跑），
 *    回合保持打开，记一条警告，之后由现有的回合兜底（不出声的回合超时结束、卡住回合的取消）处理；
 * 2. 发布命令和需要审批的原生工具调用的入口再把一道关（launchEndedRefusal）：这件事已完成、却不在发布环节
 *    （发布这一步已经结束，或约定里本来没有发布这一步）时，执行者提交的需要审批的动作一律被拒，不建审批、不在总管私聊落话。
 *    这一道管两种情形：「取消生效之前的空档」，以及「宿主取消失败、回合仍开着」（回合开着，所以把关照常找得到这件事）。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { WakeTicket } from '../model/wake.js';
import { isOpenWake } from '../turn/session.js';
import { executingJobOf } from './launch-approval.js';
import { inLaunchPhase } from './launch-turns.js';

/** 发布这一步已经结束时，执行者提交发布命令被拒的文字（逐字固定，给模型看）。 */
export const LAUNCH_ENDED_REFUSAL_TEXT = '这件事的对外发布已经结束（或约定里没有对外发布），不再提交发布。';

/**
 * P74r17：员工自己的工具（命令工具等）要建审批时，发布这一步已经结束，被拒的文字（逐字固定，给模型看）。
 * 与上面那句的区别：这句不提「提交发布」，因为触发它的是原生工具调用，且告诉模型直接交账收尾。
 */
export const LAUNCH_ENDED_TOOL_REFUSAL_TEXT = '这件事已经完成，对外发布也已结束（或约定里没有对外发布），需要主人批准的动作不再提交。请直接交账收尾。';

/** 回合记录上的原因文字：写事实，不写「出错」，不会触发重试。 */
const LAUNCH_ENDED_WAKE_TEXT = '发布这一步已结束，中心结束本回合';

/**
 * 这件事的执行者在发布环节里正开着的回合：打开的唤醒、带这件事的 jobId、验收之后开始、还没有交账。
 * 已经交账的回合不取消（它正在正常收尾，取消会把已交账的回合改写成超时）。没有返回 null。
 */
function openLaunchTurnOf(ctx: HubContext, job: Pick<Job, 'id' | 'executorId' | 'acceptedAt'>): WakeTicket | null {
  const since = job.acceptedAt ?? 0;
  return ctx.store.table('wakes').list(row => row.botId === job.executorId && row.jobId === job.id && isOpenWake(row)
    && row.startedAt >= since && row.commitId === null)
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * 发布这一步结束了：执行者在这件事上有正在跑的发布准备回合就取消它。
 * 取消是异步的（要等宿主）：单独异步执行，不登记成界面命令要等的异步收尾（理由见函数里的注释）；出错只记日志，不影响发布这一步已经结束的事实。
 * 宿主取消成功才记回合结束；宿主取消抛错时回合保持打开（P74r17）。
 * noRetry：原因是中心结束，不按「出错」退避，也不排重试。
 */
export function cancelLaunchTurn(ctx: HubContext, job: Pick<Job, 'id' | 'executorId' | 'acceptedAt'>): void {
  try {
    const wake = openLaunchTurnOf(ctx, job);
    if (wake === null) return;
    const now = ctx.clock.now();
    // 不登记成「界面命令要等的异步收尾」：宿主取消可能很慢，主人点「定了」「拒绝」的命令不该为此多等；
    // 取消生效之前的空档由 launchEndedRefusal 把关。
    // P74r17：宿主取消抛错时不把回合记为结束：回合在宿主那边其实还在跑，记结束会让入口把关找不到「开着的唤醒」而不拦。
    // 此时回合保持打开（入口把关照常起作用），记一条警告，之后由现有的回合兜底（不出声的回合超时结束、卡住回合的取消）处理。
    void (async () => {
      if (wake.sessionId) {
        try {
          await ctx.host.cancel(wake.sessionId);
        } catch (error) {
          try { ctx.logger.warn('发布结束后宿主取消发布准备回合失败，回合保持打开', { jobId: job.id, wakeId: wake.id, error: String(error) }); } catch { /* 日志出错也不能抛出去。 */ }
          return;
        }
      }
      // P74r17（低-6）：准备记结束之前重新读一次这条唤醒：宿主取消等待期间已经交账或已经结束的，不改写。
      const latest = ctx.store.table('wakes').get(wake.id);
      if (latest === null || latest.commitId !== null || !isOpenWake(latest)) return;
      // 延迟加载 finishTurn：turn/events.ts 会牵出一大串模块，在文件开头引入会让 gate/outbox.ts 一类早期模块形成循环引用。
      const { finishTurn } = await import('../turn/events.js');
      await finishTurn(ctx, wake.id, now, 'timeout', LAUNCH_ENDED_WAKE_TEXT, { noRetry: true });
    })().catch(error => {
      try { ctx.logger.warn('发布结束后取消发布准备回合失败', { jobId: job.id, error: String(error) }); } catch { /* 日志出错也不能抛出去。 */ }
    });
  } catch (error) {
    ctx.logger.warn('发布结束后没有取消发布准备回合', { jobId: job.id, error: String(error) });
  }
}

/**
 * 发布命令入口的把关：这位员工此刻在做一件已完成的事（他是执行者），而这件事已经不在发布环节时，返回拒绝文字；否则返回 null。
 * 在发布环节里（已验收、发布这一步还没有结束）一切照旧。
 */
export function launchEndedRefusal(ctx: HubContext, botId: string): string | null {
  const job = executingJobOf(ctx, botId);
  if (job === null || job.state !== 'done' || inLaunchPhase(job)) return null;
  return LAUNCH_ENDED_REFUSAL_TEXT;
}
