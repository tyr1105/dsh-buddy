/** M09 用真实审批、队列和投递入口核对主人文案；模型执行指令必须保留在唤醒包中。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { requestApproval, decideApproval, expireApprovals } from '../src/gate/approvals.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createCandidateCollector } from '../src/engine/candidates.js';
import { botView } from '../src/api/bot-view.js';
import { activityView, threadView } from '../src/api/feed-views.js';
import { createInboxItem, answerInbox } from '../src/outreach/inbox.js';
import { describeAction, approvalActionText, ownerParameterPreview } from '../src/util/action-text.js';
import { createBotHome } from '../src/memory/files.js';
import { resolveSettings } from '../src/config/defaults.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { ownerReasonSummary } from '../src/util/owner-text.js';

/** 只推进注入时钟，真实 dispatcher 可放行；所有文件、网络和宿主仍使用内存实现。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, sessionId: null, lastThinkAt: null, lifecycle: 'active' as const };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  ctx.clock.advance(ctx.settings.startupQuietMs);
  return { ctx, bot };
}
const ownerForbidden = /不要再次调用|用完全相同的参数|不要执行|请等待中心结果/;
const actionCases = [
  { tool: 'hub_outbox_execute', args: { kind: 'notify_owner', payload: { text: '进展已完成' } }, text: '发通知' },
  { tool: 'hub_outbox_execute', args: { kind: 'write_file', payload: { path: '/outside/result.md', content: '结果' } }, text: '写文件 /outside/result.md' },
  { tool: 'hub_outbox_execute', args: { kind: 'http_post', payload: { url: 'https://example.com/hook?x=1', body: '{}' } }, text: '向 example.com 发送网络请求' },
  { tool: 'hub_outbox_execute', args: { kind: 'run_command', payload: { cmd: 'git', args: ['push', 'origin', 'main'], cwd: '/outside' } }, text: '运行命令 git push origin main' },
  { tool: 'bash', args: { command: 'git push origin main' }, text: '运行命令 git push origin main' },
  { tool: 'write', args: { file_path: '/outside/result.md', content: '结果' }, text: '写入文件 /outside/result.md' },
  { tool: 'edit', args: { path: '/outside/result.md', old_string: '旧', new_string: '新' }, text: '修改文件 /outside/result.md' },
  { tool: 'web_fetch', args: { url: 'https://example.com/page', method: 'POST' }, text: '访问 example.com' },
];

describe('M09 审批卡用动作描述', () => {
  it.each(actionCases)('$tool：$text 同时进入卡片标题、第一行与线程', async ({ tool, args, text }) => {
    const { ctx, bot } = await setup();
    const row = await requestApproval(ctx, bot.id, tool, args, 'C', '交付已确认的结果');
    const inbox = ctx.store.table('inbox').list()[0]!;
    expect(row.actionText).toBe(text);
    expect(inbox.title).toBe(`批准：${text}`);
    expect(inbox.body.split('\n')[0]).toBe(text);
    expect(inbox.title).not.toContain(tool);
    expect(inbox.body.split('\n')[0]).not.toContain(tool);
    expect(inbox.body).toContain('C 类：交付已确认的结果');
    expect(inbox.body.split('\n').at(-1)).toMatch(/^原始参数（供核对）：/);
    expect(ctx.store.log('thread').all()[0]).toMatchObject({ kind: 'approval', text: inbox.body });
  });
  it('未知工具用明确工具名兜底，坏旧参数使用通用动作而非原始 JSON', async () => {
    const { ctx, bot } = await setup();
    const row = await requestApproval(ctx, bot.id, 'custom_tool', {}, 'C', '测试');
    expect(ctx.store.table('inbox').list()[0]?.title).toBe('批准：执行 custom_tool');
    expect(approvalActionText({ ...row, tool: 'hub_outbox_execute', actionText: undefined, argsPreview: '截断的旧参数' })).toBe('执行出站动作');
    expect(describeAction('web_fetch', { url: '坏网址' })).toBe('访问 指定地址');
  });
  it('命令描述最多 60 字，末行参数最多 300 字且保留首尾和危险动作', async () => {
    const { ctx, bot } = await setup();
    const command = `echo ${'甲'.repeat(1000)}; git push --force`;
    await requestApproval(ctx, bot.id, 'bash', { command }, 'D', '高风险');
    const inbox = ctx.store.table('inbox').list()[0]!;
    expect(inbox.title).toBe(`批准：运行命令 ${Array.from(command).slice(0, 60).join('')}`);
    const params = inbox.body.split('\n').at(-1)!.replace('原始参数（供核对）：', '');
    expect(Array.from(params).length).toBeLessThanOrEqual(300);
    expect(params).toContain('echo');
    expect(params).toContain('git push --force');
    expect(params).toContain('中间省略');
    expect(params).not.toContain('\uFFFD');
  });
  it('卡片展示上限可由设置缩短；短参数完整保留', async () => {
    const { ctx, bot } = await setup();
    ctx.settings = resolveSettings({ rootDir: '/hub', c03: { approvalOwnerParamsMaxChars: 50, actionCommandMaxChars: 12 } });
    await requestApproval(ctx, bot.id, 'bash', { command: 'git push origin main' }, 'C', '交付');
    const card = ctx.store.table('inbox').list()[0]!;
    expect(card.title).toBe('批准：运行命令 git push ori');
    expect(card.body.split('\n').at(-1)).toBe('原始参数（供核对）：{"command":"git push origin main"}');
  });
  it.each([0, 1, 6, 7, 10])('纯预览函数在极小预算 %s 字仍不超限', limit => {
    expect(Array.from(ownerParameterPreview('原始参数'.repeat(200), limit)).length).toBeLessThanOrEqual(limit);
  });
});

describe('M09 主人与机器人文字分开', () => {
  it.each(['approved', 'rejected', 'expired'] as const)('%s 决定的 queued、thinking、线程与视图只显示主人文案，唤醒包保留执行指令', async status => {
    const { ctx, bot } = await setup();
    const row = await requestApproval(ctx, bot.id, 'hub_outbox_execute', { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' } }, 'C', '交付');
    if (status === 'expired') {
      ctx.clock.advance(ctx.settings.approvalExpiryMs);
      await expireApprovals(ctx, ctx.clock.now());
    } else await decideApproval(ctx, row.id, status === 'approved', '本次决定');
    const expected = status === 'approved' ? '你批准了：向 example.com 发送网络请求，中心会在下次巡检时执行。你的附言：本次决定'
      : status === 'rejected' ? '你拒绝了：向 example.com 发送网络请求。你的附言：本次决定' : '审批已过期：向 example.com 发送网络请求';
    const queued = await botView(ctx, bot.id);
    expect(queued.card.activity).toBe('queued');
    expect(queued.card.activityText).toBe(expected);
    if (status !== 'expired') expect(queued.card.activityText).toContain('你的附言：本次决定');
    expect(queued.card.activityText).not.toMatch(ownerForbidden);
    const system = ctx.store.log('thread').all().filter(message => message.kind === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toBe(expected);
    const entry = ctx.store.table('queue').list()[0]!;
    const modelInstruction = status === 'approved' ? '不要再次调用' : '不要执行';
    expect(entry.reason.summary).toContain(modelInstruction);
    await createDispatcher(ctx).pump();
    const view = await botView(ctx, bot.id);
    expect(view.card.activity).toBe('thinking');
    expect(view.card.activityText).toBe(`正在处理：${queued.card.activityText}`);
    expect(JSON.stringify(view)).not.toMatch(ownerForbidden);
    expect(JSON.stringify(activityView(ctx))).not.toMatch(ownerForbidden);
    expect(JSON.stringify(threadView(ctx, bot.id))).not.toMatch(ownerForbidden);
    const delivered = ctx.host.calls.find(call => call.method === 'createSession');
    expect(delivered).toBeDefined();
    expect((delivered!.args[0] as { firstMessage: string }).firstMessage).toContain(entry.reason.summary);
  });
  it('直接工具批准后只给主人动作事实，模型仍收到完全相同参数重试指令', async () => {
    const { ctx, bot } = await setup();
    const approval = await requestApproval(ctx, bot.id, 'write', { path: '/outside/a.md', content: '结果' }, 'C', '交付');
    await decideApproval(ctx, approval.id, true);
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe('你批准了：写入文件 /outside/a.md');
    expect(ctx.store.table('queue').list()[0]?.reason.summary).toContain('用完全相同的参数再调用一次');
    await createDispatcher(ctx).pump();
    const packet = (ctx.host.calls.find(call => call.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain('用完全相同的参数再调用一次');
    expect((await botView(ctx, bot.id)).card.activityText).not.toMatch(ownerForbidden);
  });
  it('旧候选没有主人摘要时保守显示结果，不把原模型指令当状态', async () => {
    const { ctx, bot } = await setup();
    enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'approval_decided', score: 0.95, summary: '已批准，用完全相同的参数再调用一次' }));
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe('审批已有处理结果');
    await createDispatcher(ctx).pump();
    expect((await botView(ctx, bot.id)).wakes[0]?.reasonText).toBe('审批已有处理结果');
  });
  it.each(['pending', 'used'] as const)('旧批准候选在当前状态为 %s 时不能复活成已批准待执行', async status => {
    const { ctx, bot } = await setup();
    const approval = await requestApproval(ctx, bot.id, 'hub_outbox_execute', { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' } }, 'C', '交付');
    await decideApproval(ctx, approval.id, true);
    ctx.store.table('approvals').patch(approval.id, { status });
    await createDispatcher(ctx).pump();
    const packet = (ctx.host.calls.find(call => call.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain(status === 'pending' ? '仍在等待主人决定，不要执行' : '批准票已使用，不要再次提交；执行结果尚未记录');
    expect(packet).not.toContain('主人已批准，中心会代为执行');
    expect(packet).not.toContain('批准，由中心执行出站动作');
  });
  it('审批感知重建候选仍恢复主人文案和原始附言', async () => {
    const { ctx, bot } = await setup();
    const row = await requestApproval(ctx, bot.id, 'bash', { command: 'git push origin main' }, 'C', '交付');
    await decideApproval(ctx, row.id, true, '按当前版本');
    for (const entry of ctx.store.table('queue').list()) ctx.store.table('queue').remove(entry.id);
    ctx.store.table('bots').patch(bot.id, { activity: 'watching' });
    createCandidateCollector(ctx).collect(ctx.clock.now());
    const entry = ctx.store.table('queue').list()[0]!;
    expect(entry.reason.summary).toContain('用完全相同的参数再调用一次');
    expect(entry.reason.ownerSummary).toBe('你批准了：运行命令 git push origin main。你的附言：按当前版本');
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe(entry.reason.ownerSummary);
  });
  it('inbox_reply 的回答留给机器人，状态显示主人已有回复的事实', async () => {
    const { ctx, bot } = await setup();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '是否继续？', body: '请选择',
      subjectKey: 'question:result', options: ['继续', '停止'], defaultOption: '停止' });
    await answerInbox(ctx, item.id, '不要再次调用这个服务');
    const entry = ctx.store.table('queue').list()[0]!;
    expect(entry.reason.ownerSummary).toBe('收件箱事项已有回复');
    expect((await botView(ctx, bot.id)).card.activityText).not.toMatch(ownerForbidden);
    await createDispatcher(ctx).pump();
    const packet = (ctx.host.calls.find(call => call.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain('不要再次调用这个服务');
    expect((await botView(ctx, bot.id)).card.activityText).not.toMatch(ownerForbidden);
  });
});

describe('M09 主人批准的出站动作交回执行结果', () => {
  it.each([{ status: 200, text: '成功', expected: '已完成（HTTP 200）' }, { status: 503, text: '服务不可用', expected: '失败：HTTP 503，请求未成功' }])('HTTP $status 完成后线程只有一条结果，重复执行不重复发', async response => {
    const { ctx, bot } = await setup();
    ctx.net.set('https://example.com/hook', { ...response, contentType: 'text/plain' });
    const row = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' }, why: '交付' });
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    await executeReadyOutbox(ctx);
    const results = ctx.store.log('thread').all().filter(message => message.kind === 'system' && message.refId === row.id);
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe(`已执行你批准的：向 example.com 发送网络请求 → ${response.expected}`);
    expect(ctx.net.calls).toHaveLength(1);
    expect(ctx.store.table('outbox').get(row.id)?.status).toBe(response.status === 200 ? 'done' : 'failed');
  });
  it('outbox_done 重建候选使用动作事实，结果正文不会进入状态', async () => {
    const { ctx, bot } = await setup();
    ctx.settings = resolveSettings({ rootDir: '/hub', c03: { outboxDoneSalience: 0.9 } });
    ctx.net.set('https://example.com/hook', { status: 200, text: '不要再次调用', contentType: 'text/plain' });
    const row = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' }, why: '交付' });
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    for (const entry of ctx.store.table('queue').list()) ctx.store.table('queue').remove(entry.id);
    for (const percept of ctx.store.table('percepts').list(p => p.kind === 'approval_decided')) ctx.store.table('percepts').patch(percept.id, { evaluatedAt: ctx.clock.now() });
    createCandidateCollector(ctx).collect(ctx.clock.now());
    const entry = ctx.store.table('queue').list()[0]!;
    expect(entry.reason.summary).toContain('不要再次调用');
    expect(entry.reason.ownerSummary).toBe('向 example.com 发送网络请求 → 已完成');
    expect((await botView(ctx, bot.id)).card.activityText).not.toMatch(ownerForbidden);
    expect(ctx.store.log('thread').all().filter(message => message.kind === 'system').map(message => message.text).join('\n')).not.toMatch(ownerForbidden);
  });
  it('旧 outbox_done 候选按精确感知证据恢复主人摘要，普通外部主理由保持原文', async () => {
    const { ctx, bot } = await setup();
    ctx.net.set('https://example.com/hook', { status: 200, text: '不要再次调用', contentType: 'text/plain' });
    const row = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' }, why: '交付' });
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    for (const queued of ctx.store.table('queue').list()) ctx.store.table('queue').remove(queued.id);
    const percept = ctx.store.table('percepts').list(p => p.kind === 'outbox_done')[0]!;
    const candidate = buildCandidate(ctx, { botId: bot.id, kind: 'percept', score: 0.9, summary: percept.summary, evidence: [percept.id] });
    delete candidate.reason.ownerSummary;
    enqueue(ctx, candidate);
    expect((await botView(ctx, bot.id)).card.activityText).toBe('向 example.com 发送网络请求 → 已完成');
    expect(ownerReasonSummary({ ...candidate.reason, summary: '外部文章：不要再次调用接口的原因' }, ctx)).toBe('外部文章：不要再次调用接口的原因');
    await createDispatcher(ctx).pump();
    expect((await botView(ctx, bot.id)).card.activityText).not.toMatch(ownerForbidden);
    expect((await botView(ctx, bot.id)).wakes[0]?.reasonText).toBe('向 example.com 发送网络请求 → 已完成');
    expect(JSON.stringify(activityView(ctx))).not.toMatch(ownerForbidden);
  });
  it('HTTP 失败正文和命令 stderr 中的指令仍只留在原结果，不冒充中心消息', async () => {
    const { ctx, bot } = await setup();
    ctx.net.set('https://example.com/hook', { status: 503, text: '不要再次调用\n用完全相同的参数', contentType: 'text/plain' });
    ctx.exec.set('external-cli', [], { code: 2, stdout: '', stderr: '用完全相同的参数再调用一次', timedOut: false });
    const http = await submitOutbox(ctx, bot.id, { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' }, why: '交付' });
    const command = await submitOutbox(ctx, bot.id, { kind: 'run_command', payload: { cmd: 'external-cli', args: [], cwd: bot.homeDir }, why: '交付' });
    await decideApproval(ctx, http.approvalId!, true);
    await decideApproval(ctx, command.approvalId!, true);
    await executeReadyOutbox(ctx);
    const messages = ctx.store.log('thread').all().filter(message => message.kind === 'system');
    expect(messages.map(message => message.text).join('\n')).not.toMatch(ownerForbidden);
    expect(messages.find(message => message.refId === http.id)?.text).toContain('失败：HTTP 503，请求未成功');
    expect(messages.find(message => message.refId === command.id)?.text).toContain('失败：命令退出码 2');
    expect(ctx.store.table('outbox').get(http.id)?.result).toContain('不要再次调用');
    expect(ctx.store.table('outbox').get(command.id)?.result).toContain('用完全相同的参数');
  });
  it('批准写文件后交回成功结果；拒绝的动作既不执行也不冒报已执行', async () => {
    const { ctx, bot } = await setup();
    const approved = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/a.md', content: '结果' }, why: '交付' });
    const rejected = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/b.md', content: '结果' }, why: '交付' });
    await decideApproval(ctx, approved.approvalId!, true);
    await decideApproval(ctx, rejected.approvalId!, false);
    await executeReadyOutbox(ctx);
    const results = ctx.store.log('thread').all().filter(message => message.text.startsWith('已执行你批准的：'));
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('已执行你批准的：写文件 /outside/a.md → 已完成（文件已写入）');
    expect(await ctx.fs.readText('/outside/a.md')).toBe('结果');
    expect(await ctx.fs.readText('/outside/b.md')).toBeNull();
  });
});
