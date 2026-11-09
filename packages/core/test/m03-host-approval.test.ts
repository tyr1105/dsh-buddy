/** M03 宿主审批回归：宿主权限失败明确告警，不发永远无法执行的批准票，也不误拦主人会话。 */
import { expect, test } from 'vitest';
import { turnContext } from './c03-turn-fixtures.js';
import { guardToolCall, onHostApprovalRequest } from '../src/gate/guard.js';
import { decideApproval } from '../src/gate/approvals.js';

test('普通会话由宿主决定；机器人重复遇到宿主审批只合并告警，不造审批或重试', async () => {
  const { ctx, bot } = await turnContext();
  expect(await onHostApprovalRequest(ctx, 'owner-session', 'write', '写文件')).toBe('pass');
  expect(ctx.store.table('alerts').count()).toBe(0);
  for (let index = 0; index < 3; index++) expect(await onHostApprovalRequest(ctx, bot.sessionId!, 'write', '写工作成果')).toBe('deny');
  expect(ctx.store.table('approvals').count()).toBe(0); expect(ctx.store.table('queue').count()).toBe(0);
  expect(ctx.store.table('alerts').list()).toHaveLength(1);
  expect(ctx.store.table('alerts').list()[0]).toMatchObject({ code: 'host_approval_blocked', level: 'P1', status: 'open', count: 3 });
  const cards = ctx.store.table('inbox').list(); expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ type: 'alert', status: 'open' });
  expect(cards[0]?.body).toContain('本次动作未执行'); expect(cards[0]?.body).toContain('检查 DSH 会话权限');
  expect(cards[0]?.body).not.toContain('用完全相同的参数再调用一次');
  expect(ctx.host.calls.filter(call => call.method === 'notify')).toHaveLength(1);
});

test('中心C类批准后遇到宿主沙箱拦截，不创建第二种票引发双闸循环', async () => {
  const { ctx, bot } = await turnContext('regular', { autonomy: 'L2' });
  const args = { path: '/public/deliverable.md', text: '工作成果' };
  expect((await guardToolCall(ctx, bot.sessionId!, 'write', args)).allow).toBe(false);
  const approval = ctx.store.table('approvals').list()[0]!;
  await decideApproval(ctx, approval.id, true);
  expect((await guardToolCall(ctx, bot.sessionId!, 'write', args)).allow).toBe(true);
  expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('used');
  const queueCount = ctx.store.table('queue').count();
  expect(await onHostApprovalRequest(ctx, bot.sessionId!, 'write', '写工作成果')).toBe('deny');
  expect(ctx.store.table('approvals').count()).toBe(1);
  expect(ctx.store.table('queue').count()).toBe(queueCount);
  expect(ctx.store.table('alerts').list()[0]?.code).toBe('host_approval_blocked');
});
