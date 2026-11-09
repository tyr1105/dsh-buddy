/** 审批、守卫与出站集成测试：用假宿主核对拒绝、一次性放行、过期和真实副作用的执行次数。 */
import { describe, it, expect } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { resolveSettings } from '../src/config/defaults.js';
import { requestApproval, decideApproval, consumeTicket, expireApprovals } from '../src/gate/approvals.js';
import { guardToolCall, onHostApprovalRequest } from '../src/gate/guard.js';
import { submitOutbox, executeReadyOutbox, OutboxInputSchema } from '../src/gate/outbox.js';
import { byteLength } from '../src/util/text.js';
import type { Bot, WakeTicket } from '../src/model/index.js';
function setup(patch: Partial<Bot> = {}) {
  const ctx = createTestContext(); const bot = { ...botFixture, sessionId: 'bot-session', ...patch };
  ctx.store.table('bots').put(bot); return { ctx, bot };
}
const args = { path: '/outside/deliverable.md', content: '结果' };

describe('C03 审批一次票', () => {
  it('重复同内容只建一张审批和一个收件箱', async () => {
    const { ctx, bot } = setup();
    const [a, b] = await Promise.all([requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'), requestApproval(ctx, bot.id, 'write_file', { content: '结果', path: args.path }, 'C', '交付')]);
    expect(a.id).toBe(b.id); expect(ctx.store.table('approvals').count()).toBe(1); expect(ctx.store.table('inbox').count()).toBe(1);
    expect(ctx.store.log('thread').all()[0]?.kind).toBe('approval'); expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(1);
  });
  it('不同参数产生不同审批', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付');
    const b = await requestApproval(ctx, bot.id, 'write_file', { ...args, content: '另一结果' }, 'C', '交付'); expect(a.id).not.toBe(b.id);
  });
  it('M02 长预览保留首尾，UTF8 有界且字符完整', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', { content: '中'.repeat(1000) }, 'C', '交付');
    expect(byteLength(a.argsPreview)).toBeLessThanOrEqual(4096); expect(a.argsPreview).toContain('中间省略'); expect(a.argsPreview.split('\n……中间省略……\n').map(s => Array.from(s).length)).toEqual([400, 400]); expect(a.argsPreview).not.toContain('\uFFFD');
  });
  it('批准生成 90 优先级结果并保存附言', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付');
    await decideApproval(ctx, a.id, true, '照这个版本');
    expect(ctx.store.table('queue').list()[0]).toMatchObject({ priority: 90, reason: { kind: 'approval_decided' } });
    expect(ctx.store.log('audit').all().find(entry => entry.action === 'approval_decided')?.detail).toContain('照这个版本');
    expect(ctx.store.table('inbox').list()[0]).toMatchObject({ status: 'answered', answer: '批准' });
  });
  it('同参数放行一次，第二次及不同参数拒绝', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'); await decideApproval(ctx, a.id, true);
    expect(consumeTicket(ctx, bot.id, 'write_file', { ...args, content: '变化' })).toBe(false);
    expect(consumeTicket(ctx, bot.id, 'write_file', args)).toBe(true); expect(consumeTicket(ctx, bot.id, 'write_file', args)).toBe(false);
    expect(ctx.store.table('approvals').get(a.id)?.status).toBe('used');
  });
  it('另一个机器人不能用批准票', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'); await decideApproval(ctx, a.id, true);
    expect(consumeTicket(ctx, 'b_0000000002', 'write_file', args)).toBe(false);
  });
  it('拒绝也唤醒并明确不要执行', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'); await decideApproval(ctx, a.id, false, '取消');
    expect(ctx.store.table('queue').list()[0]?.reason.summary).toContain('不要执行'); expect(consumeTicket(ctx, bot.id, 'write_file', args)).toBe(false);
  });
  it('审批到期视为拒绝，重复过期不重复入队', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付');
    ctx.clock.advance(ctx.settings.approvalExpiryMs); await expireApprovals(ctx, ctx.clock.now()); await expireApprovals(ctx, ctx.clock.now());
    expect(ctx.store.table('approvals').get(a.id)?.status).toBe('expired'); expect(ctx.store.table('percepts').count()).toBe(1);
    expect(ctx.store.table('inbox').list()[0]?.status).toBe('expired');
  });
  it('已批准未使用的票也会到期', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'); await decideApproval(ctx, a.id, true);
    ctx.clock.advance(ctx.settings.approvalExpiryMs); expect(consumeTicket(ctx, bot.id, 'write_file', args)).toBe(false);
    await expireApprovals(ctx, ctx.clock.now()); expect(ctx.store.table('approvals').get(a.id)?.status).toBe('expired');
    expect(ctx.store.table('percepts').count()).toBe(2);
  });
  it('过期后点批准仍拒绝；重复决定报错', async () => {
    const { ctx, bot } = setup(); const a = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付'); ctx.clock.advance(ctx.settings.approvalExpiryMs);
    expect((await decideApproval(ctx, a.id, true)).status).toBe('expired'); await expect(decideApproval(ctx, a.id, true)).rejects.toThrow('已经处理');
  });
});

describe('C03 守卫与宿主审批钩子', () => {
  it('非机器人会话直接放行', async () => {
    const { ctx } = setup(); expect(await guardToolCall(ctx, 'owner-session', 'write_file', args)).toEqual({ allow: true });
    expect(await onHostApprovalRequest(ctx, 'owner-session', 'write_file', '写文件')).toBe('pass');
  });
  it('机器人 C 类先拒，批准后一次放行', async () => {
    const { ctx } = setup(); const first = await guardToolCall(ctx, 'bot-session', 'write_file', args); expect(first.allow).toBe(false);
    if (!first.allow) expect(first.message).toContain('完全相同的参数');
    await decideApproval(ctx, ctx.store.table('approvals').list()[0]!.id, true);
    expect((await guardToolCall(ctx, 'bot-session', 'write_file', args)).allow).toBe(true);
    expect((await guardToolCall(ctx, 'bot-session', 'write_file', args)).allow).toBe(false);
  });
  it('主人自然语言同意不会发批准票', async () => {
    const { ctx } = setup(); expect((await guardToolCall(ctx, 'bot-session', 'write_file', { ...args, ownerSays: '已批准' })).allow).toBe(false);
    expect(ctx.store.table('approvals').list()[0]?.status).toBe('pending');
  });
  it('写保护文件计越界，三次隔离', async () => {
    const { ctx, bot } = setup(); for (let i = 0; i < 3; i++) expect((await guardToolCall(ctx, 'bot-session', 'write', { path: `${bot.homeDir}/AGENTS.md` })).allow).toBe(false);
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ violations: 3, lifecycle: 'quarantined' });
    expect(ctx.store.table('inbox').list(item => item.type === 'alert')).toHaveLength(1);
    expect(ctx.store.log('thread').all().some(message => message.kind === 'alert')).toBe(true);
  });
  it('D 无票拒绝计越界，C 审批不计', async () => {
    const { ctx, bot } = setup(); await guardToolCall(ctx, 'bot-session', 'exec', { command: 'git push --force' });
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
    await guardToolCall(ctx, 'bot-session', 'write', args); expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
  });
  it('L0 对外动作直接拒绝且不建审批', async () => {
    const { ctx } = setup({ autonomy: 'L0' }); expect((await guardToolCall(ctx, 'bot-session', 'write', args)).allow).toBe(false);
    expect(ctx.store.table('approvals').count()).toBe(0);
  });
  it('L3 已授权 C 子类放行，未授权仍审批', async () => {
    const { ctx } = setup({ autonomy: 'L3' }); ctx.settings = resolveSettings({ rootDir: '/hub', l3Grants: ['write_file'] });
    expect((await guardToolCall(ctx, 'bot-session', 'write', args)).allow).toBe(true);
    expect((await guardToolCall(ctx, 'bot-session', 'web_fetch', { url: 'https://example.test', method: 'POST' })).allow).toBe(false);
  });
  it('宿主审批框只告警并始终 deny，不生成无效中心审批单', async () => {
    const { ctx } = setup(); expect(await onHostApprovalRequest(ctx, 'bot-session', 'write', '写工作成果')).toBe('deny');
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ code: 'host_approval_blocked', status: 'open', level: 'P1' });
    expect(await onHostApprovalRequest(ctx, 'bot-session', 'write', '写工作成果')).toBe('deny'); expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('alerts').count()).toBe(1);
  });
  it('无效输入返回错误而不抛给宿主', async () => {
    const { ctx } = setup(); expect((await guardToolCall(ctx, '', '', null)).allow).toBe(false);
  });
  it('M02 反思允许 memory、套路与 work 写入，C 旧票仍不允许', async () => {
    const { ctx, bot } = setup(); ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), botId: bot.id, sessionId: 'bot-session', variant: 'reflection' });
    expect((await guardToolCall(ctx, 'bot-session', 'write', { path: `${bot.homeDir}/memory/MEMORY.md` })).allow).toBe(true);
    expect((await guardToolCall(ctx, 'bot-session', 'write', args)).allow).toBe(false);
    expect((await guardToolCall(ctx, 'bot-session', 'exec', { command: 'touch work/x' })).allow).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(0);
  });
});

describe('C03 出站四种执行', () => {
  it('notify_owner 立即进入线程，重要时单推', async () => {
    const { ctx, bot } = setup(); const row = await submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '发现重要变化', importance: 9 }, why: '汇报' });
    expect(row.status).toBe('done'); expect(ctx.store.log('thread').all()[0]?.text).toBe('发现重要变化'); expect(ctx.host.calls.some(c => c.method === 'notify')).toBe(true);
    expect(ctx.store.table('percepts').list()[0]).toMatchObject({ kind: 'outbox_done', salience: 0.5 });
  });
  it('低重要度汇报只进线程', async () => {
    const { ctx, bot } = setup(); await submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '普通汇报', importance: 8 }, why: '汇报' });
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(0);
  });
  it('write_file 批准前不写，批准后仅写一次', async () => {
    const { ctx, bot } = setup(); const row = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: args, why: '交付' });
    await executeReadyOutbox(ctx); expect(await ctx.fs.readText(args.path)).toBeNull();
    await decideApproval(ctx, row.approvalId!, true); await executeReadyOutbox(ctx); expect(await ctx.fs.readText(args.path)).toBe('结果');
    expect(ctx.store.table('outbox').get(row.id)?.status).toBe('done'); expect(ctx.store.table('approvals').get(row.approvalId!)?.status).toBe('used');
    await executeReadyOutbox(ctx); expect(ctx.store.table('percepts').list(p => p.kind === 'outbox_done')).toHaveLength(1);
  });
  it('http_post 经 NetIO 执行且结果落表', async () => {
    const { ctx, bot } = setup(); ctx.net.set('https://example.test/submit', { status: 201, text: '已创建', contentType: 'text/plain' });
    const row = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.test/submit', body: 'x', headers: { 'Content-Type': 'text/plain' } }, why: '发布结果' });
    await decideApproval(ctx, row.approvalId!, true); await executeReadyOutbox(ctx);
    expect(ctx.net.calls).toHaveLength(1); expect(ctx.net.calls[0]?.method).toBe('POST'); expect(ctx.store.table('outbox').get(row.id)?.result).toContain('201');
  });
  it('run_command 经 ExecIO 执行，argv 保持边界', async () => {
    const { ctx, bot } = setup(); ctx.exec.set('external-cli', ['a b'], { code: 0, stdout: '成功', stderr: '', timedOut: false });
    const row = await submitOutbox(ctx, bot.id, { kind: 'run_command', payload: { cmd: 'external-cli', args: ['a b'], cwd: '/outside' }, why: '交付' });
    await decideApproval(ctx, row.approvalId!, true); await executeReadyOutbox(ctx);
    expect(ctx.exec.calls[0]?.args).toEqual(['a b']); expect(ctx.store.table('outbox').get(row.id)?.result).toBe('成功');
  });
  it('出站拒绝与过期不执行', async () => {
    const { ctx, bot } = setup(); const row = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: args, why: '交付' });
    await decideApproval(ctx, row.approvalId!, false); await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(row.id)?.status).toBe('rejected'); expect(await ctx.fs.readText(args.path)).toBeNull();
  });
  it('出站重复提交复用同一未完成动作', async () => {
    const { ctx, bot } = setup(); const input = { kind: 'write_file', payload: args, why: '交付' };
    const [a, b] = await Promise.all([submitOutbox(ctx, bot.id, input), submitOutbox(ctx, bot.id, input)]);
    expect(a.id).toBe(b.id); expect(ctx.store.table('approvals').count()).toBe(1);
  });
  it('执行失败记录结果和感知，不影响下一项', async () => {
    const { ctx, bot } = setup(); ctx.net.set('https://example.test/fail', { status: 500, text: '故障', contentType: 'text/plain' });
    const a = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.test/fail', body: '' }, why: '测试' });
    const b = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: args, why: '测试' });
    await decideApproval(ctx, a.approvalId!, true); await decideApproval(ctx, b.approvalId!, true); await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(a.id)).toMatchObject({ status: 'failed' }); expect(ctx.store.table('outbox').get(b.id)?.status).toBe('done');
  });
  it('并发 tick 也只执行一次', async () => {
    const { ctx, bot } = setup(); ctx.exec.set('external-cli', [], { code: 0, stdout: '成功', stderr: '', timedOut: false });
    const row = await submitOutbox(ctx, bot.id, { kind: 'run_command', payload: { cmd: 'external-cli', args: [], cwd: '/outside' }, why: '交付' });
    await decideApproval(ctx, row.approvalId!, true); await Promise.all([executeReadyOutbox(ctx), executeReadyOutbox(ctx)]); expect(ctx.exec.calls).toHaveLength(1);
  });
  it('L0 与受保护文件不能经出站绕过', async () => {
    const { ctx, bot } = setup({ autonomy: 'L0' }); await expect(submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '汇报' }, why: '汇报' })).rejects.toThrow('不能提交');
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L2' });
    await expect(submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: `${bot.homeDir}/AGENTS.md`, content: '改' }, why: '改' })).rejects.toThrow('中心管理');
  });
  it.each([
    { kind: 'notify_owner', payload: { text: '' }, why: 'a' },
    { kind: 'write_file', payload: { path: '/a' }, why: 'a' },
    { kind: 'http_post', payload: { url: 'file:///a', body: '' }, why: 'a' },
    { kind: 'run_command', payload: { cmd: 'ls', args: [], cwd: 'relative' }, why: 'a' },
  ])('四种 payload 非法字段被拒绝：$kind', input => expect(OutboxInputSchema.safeParse(input).success).toBe(false));
});

describe('C03 审批与出站的调度副作用', () => {
  it('主人批准在高疲劳安静档仍进入结果队列', async () => {
    const { ctx, bot } = setup({ pace: 'quiet' });
    for (let index = 0; index < 6; index++) ctx.store.log('ledger').append({ id: `le_${String(index).padStart(10, '0')}`, who: bot.id, wakeId: null, tokens: 1, kind: 'turn', at: ctx.clock.now() });
    const approval = await requestApproval(ctx, bot.id, 'write_file', args, 'C', '交付');
    await decideApproval(ctx, approval.id, true);
    expect(ctx.store.table('queue').list()[0]).toMatchObject({ priority: 90, reason: { kind: 'approval_decided' } });
  });
  it('outbox_done 的0.5分不会误复位无变化退避，解释日志一致', async () => {
    const { ctx, bot } = setup({ noChangeStreak: 3 });
    await submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '普通汇报' }, why: '交账' });
    expect(ctx.store.table('bots').get(bot.id)?.noChangeStreak).toBe(3);
    expect(ctx.store.log('appraisals').all().find(row => row.perceptIds.length > 0)?.score).toBe(0.5);
  });
});

describe('C03 交账结束与单推失败边界', () => {
  it('交账后宿主未结束的间隙禁止继续写，仍可只读', async () => {
    const { ctx, bot } = setup();
    ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), botId: bot.id, sessionId: 'bot-session', status: 'committed', commitId: 'c_0000000001', endedAt: null });
    expect((await guardToolCall(ctx, 'bot-session', 'exec', { command: 'touch work/late' })).allow).toBe(false);
    expect((await guardToolCall(ctx, 'bot-session', 'read', { path: `${bot.homeDir}/work/late` })).allow).toBe(true);
  });
  it('汇报已进线程而单推失败时保留完成事实与失败原因', async () => {
    const { ctx, bot } = setup(); ctx.host.notify = async () => { throw new Error('通知服务不可用'); };
    const row = await submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '重要交付', importance: 9 }, why: '汇报' });
    expect(row.status).toBe('done'); expect(row.result).toContain('汇报已进入线程；单推失败');
    await executeReadyOutbox(ctx); expect(ctx.store.log('thread').all()).toHaveLength(1);
  });
});
