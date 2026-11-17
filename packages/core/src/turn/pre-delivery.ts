/**
 * 投递唤醒之前的技能目录核对（P75r3 第 1.5 节）。
 *
 * 为什么需要：技能目录的恢复原来只在回合结束时做，下面几种情形不经过它，
 * 被改写的技能内容会被员工的下一个回合直接读到：
 * - 主人打断的回合（打断只记终态，宿主随后的结束事件找不到在途唤醒，直接返回）；
 * - 宿主崩溃、回合超时；
 * - 一位员工经不透明的命令改写了另一位员工的技能目录（被改的那一位要等自己的回合结束才恢复，
 *   而他的下一个回合开头就会读到被改的内容）。
 * 所以每次真正投递给员工之前，先做一次与回合结束相同的核对。
 *
 * 约定：没有问题时不写任何文件、不发任何事件（核对本身只在内容不同、路径被换掉时才写）；
 * 出错照回合结束核对的做法处理（记审计、出告警），不阻止投递。
 */
import type { HubContext } from '../engine/context.js';
import { verifyManagedFiles } from '../memory/files.js';

/** 投递前核对这位员工的技能目录；任何异常都吞掉只记日志，投递照常进行。 */
export async function verifyBeforeDelivery(ctx: HubContext, botId: string): Promise<void> {
  try {
    await verifyManagedFiles(ctx, botId);
  } catch (error) {
    try { ctx.logger.warn('投递前技能目录核对失败，仍继续投递', { botId, error: String(error) }); } catch { /* 日志失败也不能阻止投递 */ }
  }
}
