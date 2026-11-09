/** M07 打断后的动作边界：旧工作会话即使未真正停止，也不能因解绑身份而绕过工具与宿主审批守卫。 */
import { describe, expect, it, vi } from 'vitest';
import { turnContext } from './c03-turn-fixtures.js';
import { createUiApi } from '../src/api/index.js';
import { guardToolCall, guardToolCallSync, onHostApprovalRequest, onHostApprovalRequestSync } from '../src/gate/guard.js';
import { interruptWake } from '../src/turn/interrupt.js';

describe('M07 已打断会话保留拒绝身份', () => {
  it.each([
    ['read_file', { path: '/public/readme.md' }],
    ['write_file', { path: '/public/note.md', content: '不要执行' }],
    ['write_file', { path: '/hub/.hub/state/bots.json', content: '不要修改中心' }],
    ['hub_state_get', {}],
    ['hub_commit', {}],
  ])('取消失败后旧会话的 %s 仍拒绝，不累计故障或发审批', async (tool, args) => {
    const { ctx, bot, ticket } = await turnContext();
    vi.spyOn(ctx.host, 'cancel').mockRejectedValueOnce(new Error('宿主暂时没有响应'));
    const api = createUiApi(ctx, () => ctx.store.flush());
    expect(await api.interruptBot({ botId: bot.id })).toMatchObject({ ok: false, error: expect.stringContaining('已记录主人打断') });
    expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner', sessionId: bot.sessionId });
    expect(ctx.store.table('bots').get(bot.id)?.sessionId).toBeNull();

    // 同步宿主钩子与兼容异步入口都必须识别历史工作会话，不能当成主人普通会话。
    const defer = vi.fn();
    const decision = guardToolCallSync(ctx, bot.sessionId!, String(tool), args, defer);
    expect(decision).toEqual({ allow: false, message: '主人已打断本回合，无需再执行工具，请停止处理' });
    expect(await guardToolCall(ctx, bot.sessionId!, String(tool), args)).toEqual(decision);
    expect(onHostApprovalRequestSync(ctx, bot.sessionId!, String(tool), '迟到审批', defer)).toBe('deny');
    expect(await onHostApprovalRequest(ctx, bot.sessionId!, String(tool), '迟到审批')).toBe('deny');
    expect(defer).not.toHaveBeenCalled();
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('inbox').count()).toBe(0);
    expect(ctx.store.table('alerts').count()).toBe(0);
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: bot.lifecycle, violations: 0, consecutiveErrors: 0, consecutiveNoCommit: 0 });
  });

  it('cancel Promise 挂起的窗口立即拦旧会话，返回后拒绝身份仍保留', async () => {
    const { ctx, bot } = await turnContext();
    let cancelStarted!: () => void;
    let finishCancel!: () => void;
    const started = new Promise<void>(resolve => { cancelStarted = resolve; });
    const canceled = new Promise<void>(resolve => { finishCancel = resolve; });
    vi.spyOn(ctx.host, 'cancel').mockImplementation(() => { cancelStarted(); return canceled; });
    const api = createUiApi(ctx, () => ctx.store.flush());
    const pending = api.interruptBot({ botId: bot.id });
    await started;
    const defer = vi.fn();
    expect(guardToolCallSync(ctx, bot.sessionId!, 'write_file', { path: '/public/result.md', content: '禁止' }, defer).allow).toBe(false);
    expect(onHostApprovalRequestSync(ctx, bot.sessionId!, 'write_file', '迟到请求', defer)).toBe('deny');
    expect(defer).not.toHaveBeenCalled();
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(0);
    finishCancel();
    expect((await pending).ok).toBe(true);
    expect((await guardToolCall(ctx, bot.sessionId!, 'read_file', { path: '/public/readme.md' })).allow).toBe(false);
  });

  it('新工作会话继续按原权限检查，普通主人会话保持放行', async () => {
    const { ctx, bot, ticket } = await turnContext();
    interruptWake(ctx, ticket.id, ctx.clock.now());
    ctx.store.table('bots').patch(bot.id, { sessionId: 'new-work-session', sessionStartedAt: ctx.clock.now() });
    const defer = vi.fn();
    expect(guardToolCallSync(ctx, bot.sessionId!, 'read_file', { path: '/public/readme.md' }, defer).allow).toBe(false);
    expect(guardToolCallSync(ctx, 'new-work-session', 'read_file', { path: '/public/readme.md' }, defer)).toEqual({ allow: true });
    expect(guardToolCallSync(ctx, 'owner-session', 'write_file', { path: '/public/result.md', content: '主人自己处理' }, defer)).toEqual({ allow: true });
    expect(onHostApprovalRequestSync(ctx, 'owner-session', 'write_file', '主人请求', defer)).toBe('pass');
    expect(ctx.store.table('alerts').count()).toBe(0);
    expect(await onHostApprovalRequest(ctx, 'new-work-session', 'write_file', '新回合宿主权限请求')).toBe('deny');
    expect(ctx.store.table('alerts').list()).toEqual([expect.objectContaining({ code: 'host_approval_blocked', botId: bot.id })]);
    expect(ctx.store.table('approvals').count()).toBe(0);
  });

  it('迟到创建的会话身份补入已取消唤醒单后同样拒绝', async () => {
    const { ctx, ticket } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { sessionId: null, status: 'delivering', dispatchedAt: null });
    interruptWake(ctx, ticket.id, ctx.clock.now());
    // dispatcher 保存迟到的宿主返回身份；它没有被重新绑定成机器人当前会话。
    ctx.store.table('wakes').patch(ticket.id, { sessionId: 'late-created-session' });
    const defer = vi.fn();
    expect(guardToolCallSync(ctx, 'late-created-session', 'write_file', { path: '/public/note.md', content: '不能执行' }, defer).allow).toBe(false);
    expect(onHostApprovalRequestSync(ctx, 'late-created-session', 'write_file', '迟到审批', defer)).toBe('deny');
    expect(defer).not.toHaveBeenCalled();
    expect(ctx.store.table('approvals').count()).toBe(0);
  });
});
