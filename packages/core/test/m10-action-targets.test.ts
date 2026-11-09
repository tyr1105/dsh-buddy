/** M10 真实守卫回归：审批描述必须展示闸门检查的目标，旧截断预览不能冒充参数缺失。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { gateContextFor, guardToolCall } from '../src/gate/guard.js';
import { classifyToolCall } from '../src/gate/classify.js';
import { approvalContentHash, approvalPreview, decideApproval, requestApproval } from '../src/gate/approvals.js';
import { approvalActionText, describeAction, ownerParameterPreview } from '../src/util/action-text.js';
import { stableStringify } from '../src/util/hash.js';
import { inboxView, threadView } from '../src/api/feed-views.js';

/** 每次创建独立会话，隔离审批票、推送和一次性执行的状态。 */
function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, lifecycle: 'active' as const, sessionId: 'm10-target-session' };
  ctx.store.table('bots').put(bot);
  return { ctx, bot };
}

describe('M10 审批与动作闸共用目标', () => {
  it.each(['write', 'edit'] as const)('%s 的长 path 诱饵不能隐藏 file_path，批准只对原参数生效', async tool => {
    const { ctx, bot } = setup();
    const args = { path: `${bot.homeDir}/work/${'notes-'.repeat(400)}a.md`, file_path: '/outside/plan.md', content: '正文'.repeat(400) };
    expect(classifyToolCall(tool, args, gateContextFor(ctx, bot)).cls).toBe('C');
    expect((await guardToolCall(ctx, bot.sessionId, tool, args)).allow).toBe(false);
    const card = ctx.store.table('inbox').list()[0]!;
    const action = `${tool === 'edit' ? '修改' : '写入'}文件 ${ownerParameterPreview(args.path, 300)}（另含 /outside/plan.md）（参数含多个目标）`;
    expect(card.title).toBe(`批准：${action}`);
    expect(card.body.split('\n')[0]).toBe(action);
    expect(card.body.split('\n').at(-1)).toContain('file_path:"/outside/plan.md"');
    expect(Array.from(card.body.split('\n').at(-1)!.replace('原始参数（供核对）：', '')).length).toBeLessThanOrEqual(300);
    await decideApproval(ctx, card.refId!, true);
    expect(await guardToolCall(ctx, bot.sessionId, tool, args)).toEqual({ allow: true });
    expect((await guardToolCall(ctx, bot.sessionId, tool, { ...args, file_path: '/outside/other.md' })).allow).toBe(false);
  });

  it('exec 的 cmd 与 script 矛盾时，标题首先展示闸门判定的 cmd 加 argv', async () => {
    const { ctx, bot } = setup();
    const args = { cmd: 'curl', args: ['-X', 'POST', 'https://example.com/upload'], script: 'ls', content: '正文'.repeat(400) };
    expect(classifyToolCall('exec', args, gateContextFor(ctx, bot))).toMatchObject({ cls: 'C', reason: '网络写请求需审批' });
    expect((await guardToolCall(ctx, bot.sessionId, 'exec', args)).allow).toBe(false);
    const card = ctx.store.table('inbox').list()[0]!;
    expect(card.title).toBe('批准：运行命令 curl -X POST https://example.com/upload（另含 ls）（参数含多个目标）');
    expect(card.body.split('\n')[0]).toBe('运行命令 curl -X POST https://example.com/upload（另含 ls）（参数含多个目标）');
    expect(card.body.split('\n').at(-1)).toContain('cmd:"curl"');
    expect(card.body.split('\n').at(-1)).toContain('script:"ls"');
  });

  it('同目标别名不制造矛盾；补丁全部文件与命令 command 优先级仍可核对', () => {
    expect(describeAction('write', { path: '/outside/a', file_path: '/outside/a' })).toBe('写入文件 /outside/a');
    expect(describeAction('bash', { command: 'git', cmd: 'git', args: ['push'] })).toBe('运行命令 git push');
    expect(describeAction('exec_command', { command: 'curl', cmd: 'ls', args: ['-X', 'POST', 'https://example.com'] }))
      .toBe('运行命令 curl -X POST https://example.com（另含 ls）（参数含多个目标）');
    expect(describeAction('apply_patch', { input: '*** Update File: /outside/a\n*** Add File: /outside/b' }))
      .toBe('修改文件 /outside/a（另含 /outside/b）（参数含多个目标）');
  });

  it('非法 argv 不被文案过滤成另一条命令；单命令摘要仍严格遵守 60 字上限', () => {
    const { ctx, bot } = setup();
    const args = { cmd: 'ls', args: ['-X', null, 'POST'] };
    expect(classifyToolCall('exec', args, gateContextFor(ctx, bot)).cls).toBe('A');
    expect(describeAction('exec', args)).toBe('运行命令 ls');
    const long = `curl ${'甲'.repeat(100)} -X POST`;
    expect(describeAction('exec', { command: long })).toBe(`运行命令 ${Array.from(long).slice(0, 60).join('')}`);
  });

  it('长正文与长命令的参数末行优先保留 URL、路径、命令首尾，短参数不变', () => {
    const args = { body: '正文'.repeat(1000), url: 'https://example.com/upload', path: '/outside/result.md', command: `echo ${'甲'.repeat(500)}; git push --force` };
    const preview = ownerParameterPreview(stableStringify(args), 300);
    expect(preview).toContain('url:"https://example.com/upload"');
    expect(preview).toContain('path:"/outside/result.md"');
    expect(preview).toContain('echo');
    expect(preview).toContain('git push --force');
    expect(Array.from(preview).length).toBeLessThanOrEqual(300);
    expect(ownerParameterPreview('{"command":"ls"}', 300)).toBe('{"command":"ls"}');
  });
});

describe('M10 旧审批截断文案', () => {
  it.each([
    ['bash', { command: `git push ${'origin '.repeat(400)}--force` }, '运行一条命令（完整参数见末行）'],
    ['write', { file_path: '/outside/report.md', content: '正文'.repeat(1000) }, '写入文件（路径见末行）'],
    ['edit', { file_path: '/outside/report.md', old_string: '正文'.repeat(1000), new_string: '新文' }, '修改文件（路径见末行）'],
  ] as const)('%s 真实截断旧单的决定与状态不谎称未提供参数', async (tool, args, expected) => {
    const { ctx, bot } = setup();
    const created = await requestApproval(ctx, bot.id, tool, args, 'C', '交付');
    expect(created.argsPreview).toContain('中间省略');
    const legacy = { ...created, actionText: undefined };
    ctx.store.table('approvals').put(legacy);
    expect(approvalActionText(legacy)).toBe(expected);
    await decideApproval(ctx, legacy.id, true);
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe(`你批准了：${expected}`);
    expect(ctx.store.log('thread').all().find(message => message.kind === 'system')?.text).toBe(`你批准了：${expected}`);
    expect(approvalActionText({ ...legacy, argsPreview: tool === 'bash' ? '{"command":"git push"}' : '{"file_path":"/outside/a"}' }))
      .toBe(tool === 'bash' ? '运行命令 git push' : `${tool === 'edit' ? '修改' : '写入'}文件 /outside/a`);
  });
});

describe('M10 存量审批文案升级', () => {
  /** 从原始诱饵卡片保留不可变线程，再恢复当时真实审批参数，模拟 M09 单字段摘要的存量快照。 */
  async function legacy(full: Record<string, unknown>, tool = 'write') {
    const { ctx, bot } = setup();
    const decoy = tool === 'write' ? { path: `${bot.homeDir}/work/notes.md` } : { command: 'ls' };
    const created = await requestApproval(ctx, bot.id, tool, decoy, 'C', '交付');
    const old = { ...created, actionTextVersion: undefined, contentHash: approvalContentHash(tool, full),
      argsPreview: approvalPreview(full, ctx.settings.c03.approvalPreviewMaxBytes, ctx.settings.c03.approvalPreviewEdgeChars) };
    ctx.store.table('approvals').put(old);
    return { ctx, bot, old, card: ctx.store.table('inbox').list()[0]! };
  }

  it('M09 已存 actionText 只含诱饵时，未重申请也从原参数重算卡片和线程且不写历史', async () => {
    const full = { path: `${botFixture.homeDir}/work/notes.md`, file_path: '/outside/plan.md', content: '正文' };
    const { ctx, bot, old, card } = await legacy(full);
    const expected = `写入文件 ${full.path}（另含 /outside/plan.md）（参数含多个目标）`;
    const rowsBefore = { approvals: ctx.store.table('approvals').list(), inbox: ctx.store.table('inbox').list(), thread: ctx.store.log('thread').all() };
    expect(approvalActionText(old)).toBe(expected);
    expect(inboxView(ctx).items[0]?.title).toBe(`批准：${expected}`);
    const displayed = threadView(ctx, bot.id).messages[0]!;
    expect(displayed.card?.title).toBe(`批准：${expected}`);
    expect(displayed.text.split('\n')[0]).toBe(expected);
    expect(displayed.card?.body.split('\n')[0]).toBe(expected);
    expect(ctx.store.table('approvals').list()).toEqual(rowsBefore.approvals);
    expect(ctx.store.table('inbox').list()).toEqual(rowsBefore.inbox);
    expect(ctx.store.log('thread').all()).toEqual(rowsBefore.thread);
    expect(ctx.store.table('inbox').get(card.id)?.title).toBe(`批准：写入文件 ${full.path}`);
  });

  it.each(['write', 'bash'] as const)('M09 %s 预览截断时忽略诱饵摘要，同哈希重申请用完整目标刷新但不重建重推', async tool => {
    const full = tool === 'write'
      ? { path: `${botFixture.homeDir}/work/notes.md`, file_path: '/outside/plan.md', content: '正文'.repeat(2000) }
      : { command: `curl -X POST https://example.com/upload ${'arg '.repeat(2000)}`, cmd: 'ls' };
    const { ctx, bot, old, card } = await legacy(full, tool);
    const fallback = tool === 'write' ? '写入文件（路径见末行）' : '运行一条命令（完整参数见末行）';
    expect(old.argsPreview).toContain('中间省略');
    expect(approvalActionText(old)).toBe(fallback);
    expect(inboxView(ctx).items[0]?.title).toBe(`批准：${fallback}`);
    expect(threadView(ctx, bot.id).messages[0]?.text.split('\n')[0]).toBe(fallback);
    const counts = { approval: ctx.store.table('approvals').count(), inbox: ctx.store.table('inbox').count(),
      thread: ctx.store.log('thread').all().length, notify: ctx.host.calls.filter(call => call.method === 'notify').length };
    const repeated = await requestApproval(ctx, bot.id, tool, full, 'C', '再次申请');
    const expected = describeAction(tool, full);
    expect(repeated).toMatchObject({ id: old.id, actionTextVersion: 2, actionText: expected, expiresAt: old.expiresAt, why: old.why });
    expect(approvalActionText(repeated)).toBe(expected);
    expect(ctx.store.table('inbox').get(card.id)?.title).toBe(`批准：${expected}`);
    expect(threadView(ctx, bot.id).messages[0]?.text.split('\n')[0]).toBe(expected);
    expect({ approval: ctx.store.table('approvals').count(), inbox: ctx.store.table('inbox').count(),
      thread: ctx.store.log('thread').all().length, notify: ctx.host.calls.filter(call => call.method === 'notify').length }).toEqual(counts);
    // 新版即使参数快照仍很长，也保留已按完整输入生成的动作，不再退回通用摘要。
    expect(approvalActionText({ ...repeated, argsPreview: '截断原参数' })).toBe(expected);
  });
});
