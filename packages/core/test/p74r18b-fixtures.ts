/**
 * P74r18b 测试的公共小工具（不是测试文件）。
 *
 * 为什么需要：P74r18b 起，主人在界面上点「批准」（api.decideApproval、answerInbox）之后，一条由中心代为执行的出站动作会立刻开始执行，
 * 不再等下一次巡检。以前有一批测试要构造「已批准、还没有执行」的中间状态（再改脚本、停止这件事、改派……看批准票会不会被作废），
 * 这个中间状态现在只在两种情形下存在：员工正在复盘、已暂停；或命令还没来得及开始。
 * 这些测试的目的（批准之后、执行之前发生变化会怎样）没变，所以构造方式改成「只记下批准的决定」（核心的 decideApproval，
 * 与界面入口的区别只是不触发立刻执行），执行仍由巡检里的 executeReadyOutbox（测试里的 tick）完成。
 */
import { decideApproval } from '../src/gate/approvals.js';
import type { HubContext } from '../src/engine/context.js';

/** 只记下「批准」的决定，不触发立刻执行；返回与界面命令同形的成功结果。 */
export async function approveWithoutRun(fix: { ctx: HubContext }, approvalId: string): Promise<{ ok: true }> {
  await decideApproval(fix.ctx, approvalId, true);
  return { ok: true };
}
