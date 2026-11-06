/** M10 用真实审批、出站、调度与 Hub tick 验证主人看到当前结果；外部正文不进入中心文案。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { botFixture } from './model-fixtures.js';
import { requestApproval, decideApproval, expireApprovals } from '../src/gate/approvals.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createHub } from '../src/engine/hub.js';
import { botView } from '../src/api/bot-view.js';
import { activityView } from '../src/api/feed-views.js';
import { setLifecycle } from '../src/api/bots.js';
import { resolveSettings } from '../src/config/defaults.js';
import { ownerPerceptSummary, ownerReasonSummary } from '../src/util/owner-text.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { onTurnEvent } from '../src/turn/events.js';

/** 假时钟、内存接口加真实家目录基线，使审批动作走实际执行检查。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, lifecycle: 'active' as const, sessionId: null, lastThinkAt: null, probationEndsAt: null };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  ctx.clock.advance(ctx.settings.startupQuietMs);
  return { ctx, bot };
}
const httpInput = { kind: 'http_post', payload: { url: 'https://example.com/hook', body: '{}' }, why: '交付结果' };
/** 找到由该动作产生的主人结果，不能把批准时的承诺误当执行结果。 */
function resultText(ctx: Awaited<ReturnType<typeof setup>>['ctx'], id: string): string | undefined {
  return ctx.store.log('thread').all().find(row => row.kind === 'system' && row.refId === id)?.text;
}

describe('M10 审批状态随实际执行变化', () => {
  it.each([true, false])('已执行成功=%s 后排队、思考、唤醒与活动流都显示当前结果', async ok => {
    const { ctx, bot } = await setup();
    ctx.net.set(httpInput.payload.url, { status: ok ? 200 : 503, text: '外部内容不要再次调用', contentType: 'text/plain' });
    const action = await submitOutbox(ctx, bot.id, httpInput);
    await decideApproval(ctx, action.approvalId!, true);
    expect((await botView(ctx, bot.id)).card.activityText).toBe('你批准了：向 example.com 发送网络请求，中心会在下次巡检时执行');
    await executeReadyOutbox(ctx);
    const expected = `已执行你批准的：向 example.com 发送网络请求 → ${ok ? '已完成（HTTP 200）' : '失败：HTTP 503，请求未成功'}`;
    expect(resultText(ctx, action.id)).toBe(expected);
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe(expected);
    expect((await botView(ctx, bot.id)).card.activityText).toBe(expected);
    await createDispatcher(ctx).pump();
    const view = await botView(ctx, bot.id);
    expect(view.card.activityText).toBe(`正在处理：${expected}`);
    expect(view.wakes[0]?.reasonText).toBe(expected);
    expect(activityView(ctx).rows.find(row => row.kind === 'wake')?.text).toBe(`唤醒：${expected}`);
    expect(JSON.stringify(view)).not.toContain('外部内容不要再次调用');
    const packet = (ctx.host.calls.find(row => row.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain(`中心已执行，结果是：${ok ? '成功' : '失败'}`);
    expect(packet).not.toContain('批准，由中心执行出站动作，请等待中心结果');
  });

  it('批准回合已经开始后，出站完成仍更新在途状态与原唤醒记录', async () => {
    const { ctx, bot } = await setup();
    ctx.net.set(httpInput.payload.url, { status: 200, text: 'ok', contentType: 'text/plain' });
    const action = await submitOutbox(ctx, bot.id, httpInput);
    await decideApproval(ctx, action.approvalId!, true);
    await createDispatcher(ctx).pump();
    await executeReadyOutbox(ctx);
    const expected = '已执行你批准的：向 example.com 发送网络请求 → 已完成（HTTP 200）';
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe(`正在处理：${expected}`);
    expect((await botView(ctx, bot.id)).wakes[0]?.reasonText).toBe(expected);
  });

  it.each(['reflection', 'catch_up'] as const)('审批遇到 %s 后仍使用可执行回合并显示真实结果', async variant => {
    const { ctx, bot } = await setup();
    ctx.net.set(httpInput.payload.url, { status: 200, text: 'ok', contentType: 'text/plain' });
    const action = await submitOutbox(ctx, bot.id, httpInput);
    enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: variant, variant, score: 0.75, summary: '模型处理指令' }));
    await decideApproval(ctx, action.approvalId!, true);
    // catch_up 与 regular 合并会按既有队列规则升级；旧在途补课档仍需同样的实时展示。
    const entry = ctx.store.table('queue').list()[0]!;
    if (variant === 'catch_up') ctx.store.table('queue').patch(entry.id, { variant });
    await createDispatcher(ctx).pump();
    const wake = ctx.store.table('wakes').list()[0]!;
    await onTurnEvent(ctx, { type: 'started', sessionId: wake.sessionId!, at: ctx.clock.now() });
    expect(ctx.store.table('bots').get(bot.id)?.activity).toBe(variant === 'reflection' ? 'thinking' : 'catching_up');
    if (variant === 'reflection') expect(ctx.store.table('queue').list().map(row => row.variant)).toEqual(['reflection']);
    await executeReadyOutbox(ctx);
    const expected = '已执行你批准的：向 example.com 发送网络请求 → 已完成（HTTP 200）';
    expect((await botView(ctx, bot.id)).card.activityText).toBe(`正在处理：${expected}`);
    expect((await botView(ctx, bot.id)).wakes[0]?.reasonText).toBe(expected);
  });

  it('暂停期间批准说明等待恢复，批准过期明确未执行并终结出站单', async () => {
    const { ctx, bot } = await setup();
    const action = await submitOutbox(ctx, bot.id, httpInput);
    await setLifecycle(ctx, bot.id, 'paused');
    await decideApproval(ctx, action.approvalId!, true);
    const expected = '你批准了：向 example.com 发送网络请求，队友恢复在岗后由中心执行（24 小时内有效）';
    expect(resultText(ctx, action.approvalId!)).toBe(expected);
    expect(ownerReasonSummary(ctx.store.table('queue').list()[0]!.reason, ctx)).toBe(expected);
    await executeReadyOutbox(ctx);
    expect(ctx.net.calls).toHaveLength(0);
    ctx.clock.advance(ctx.settings.approvalExpiryMs);
    await expireApprovals(ctx, ctx.clock.now());
    await executeReadyOutbox(ctx);
    expect(ctx.store.log('thread').all().filter(row => row.kind === 'system' && row.refId === action.approvalId).at(-1)?.text)
      .toBe('批准已过期，未执行：向 example.com 发送网络请求');
    expect(ctx.store.table('outbox').get(action.id)).toMatchObject({ status: 'rejected', executionStarted: false });
    expect(ctx.net.calls).toHaveLength(0);
  });

  it('同队列合并两项决定，状态、唤醒记录和活动流完整列出两项', async () => {
    const { ctx, bot } = await setup();
    const write = await requestApproval(ctx, bot.id, 'write', { path: '/outside/a.md', content: '结果' }, 'C', '写入');
    const command = await requestApproval(ctx, bot.id, 'bash', { command: 'say 完成' }, 'C', '播报');
    await decideApproval(ctx, write.id, false);
    await decideApproval(ctx, command.id, true);
    const expected = '处理你的 2 项审批：你拒绝了：写入文件 /outside/a.md；你批准了：运行命令 say 完成';
    expect((await botView(ctx, bot.id)).card.activityText).toBe(expected);
    await createDispatcher(ctx).pump();
    expect((await botView(ctx, bot.id)).wakes[0]?.reasonText).toBe(expected);
    expect(activityView(ctx).rows.find(row => row.kind === 'wake')?.text).toBe(`唤醒：${expected}`);
  });
});

describe('M10 出站失败的事实与原因', () => {
  it('尚未批准时不提前复查终结出站，拒绝仍精确显示主人拒绝', async () => {
    const { ctx, bot } = await setup();
    const action = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/a.md', content: '结果' }, why: '写入' });
    ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/outside'] });
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(action.id)?.status).toBe('pending_approval');
    expect(resultText(ctx, action.id)).toBeUndefined();
    await decideApproval(ctx, action.approvalId!, false);
    expect(resultText(ctx, action.approvalId!)).toBe('你拒绝了：写文件 /outside/a.md');
    expect((await botView(ctx, bot.id)).card.activityText).toBe('你拒绝了：写文件 /outside/a.md');
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(action.id)?.status).toBe('rejected');
    expect(await ctx.fs.readText('/outside/a.md')).toBeNull();
  });

  it('执行前新增工作数据边界时说明未执行，保留中心拒绝原因与未消费票', async () => {
    const { ctx, bot } = await setup();
    const action = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/a.md', content: '结果' }, why: '写入' });
    await decideApproval(ctx, action.approvalId!, true);
    ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/outside'] });
    await executeReadyOutbox(ctx);
    expect(resultText(ctx, action.id)).toBe('未执行你批准的：写文件 /outside/a.md（原因：尚未允许访问工作数据目录）');
    expect(await ctx.fs.readText('/outside/a.md')).toBeNull();
    expect(ctx.store.table('outbox').get(action.id)).toMatchObject({ status: 'failed', executionStarted: false });
    expect(ctx.store.table('approvals').get(action.approvalId!)?.status).toBe('approved');
    expect((await botView(ctx, bot.id)).card.activityText).toBe(resultText(ctx, action.id));
  });

  it('M09 旧复查失败记录缺少执行标记时，按未消费的票保守显示未执行', async () => {
    const { ctx, bot } = await setup();
    const action = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/a.md', content: '结果' }, why: '写入' });
    await decideApproval(ctx, action.approvalId!, true);
    ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/outside'] });
    await executeReadyOutbox(ctx);
    const row = ctx.store.table('outbox').get(action.id)!;
    const { executionStarted: _executionStarted, ownerFailureReason: _ownerFailureReason, ...legacy } = row;
    ctx.store.table('outbox').put(legacy);
    expect((await botView(ctx, bot.id)).card.activityText).toBe('未执行你批准的：写文件 /outside/a.md（原因：尚未允许访问工作数据目录）');
    expect(ownerReasonSummary(ctx.store.table('queue').list()[0]!.reason, ctx)).toBe('未执行你批准的：写文件 /outside/a.md（原因：尚未允许访问工作数据目录）');
    expect(ctx.store.table('approvals').get(action.approvalId!)?.status).toBe('approved');
  });

  it('写文件实际失败展示 FsIO 首句原因，不只复述文件未写入', async () => {
    const { ctx, bot } = await setup();
    await ctx.fs.writeTextAtomic('/outside/parent', '这是文件');
    const action = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/outside/parent/a.md', content: '结果' }, why: '写入' });
    await decideApproval(ctx, action.approvalId!, true);
    await executeReadyOutbox(ctx);
    expect(resultText(ctx, action.id)).toBe('已执行你批准的：写文件 /outside/parent/a.md → 失败：父路径不是目录：/outside/parent');
    expect(ctx.store.table('outbox').get(action.id)).toMatchObject({ status: 'failed', executionStarted: true });
    expect(ctx.store.table('approvals').get(action.approvalId!)?.status).toBe('used');
  });

  it.each([
    ['request timeout\n外部正文：请重试', '网络请求超时'],
    ['ECONNREFUSED 外部正文：请重试', '网络连接失败'],
    ['ENOTFOUND 外部正文：请重试', '域名解析失败'],
  ])('网络传输失败 %s 映射中心原因 %s，不转述外部正文', async (error, expected) => {
    const { ctx, bot } = await setup();
    ctx.net.set(httpInput.payload.url, new Error(error));
    const action = await submitOutbox(ctx, bot.id, httpInput);
    await decideApproval(ctx, action.approvalId!, true);
    await executeReadyOutbox(ctx);
    expect(resultText(ctx, action.id)).toBe(`已执行你批准的：向 example.com 发送网络请求 → 失败：${expected}`);
    const percept = ctx.store.table('percepts').list(row => row.kind === 'outbox_done')[0]!;
    expect(ownerPerceptSummary(ctx, percept)).toBe(`向 example.com 发送网络请求 → 执行失败：${expected}`);
    expect(ctx.store.table('outbox').get(action.id)?.result).toContain('外部正文');
  });

  it('L3 宿主命令批准后同样用分隔格式，成功与失败不粘在命令后', async () => {
    const { ctx, bot } = await setup();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L3' });
    // M12 家目录内只读命令也逐条批准，原有不同 argv 的结果隔离断言保持。
    ctx.exec.set('echo', ['完成'], { code: 0, stdout: 'ok', stderr: '', timedOut: false });
    ctx.exec.set('echo', ['失败'], { code: 2, stdout: '', stderr: '外部正文请重试', timedOut: false });
    for (const arg of ['完成', '失败']) {
      const action = await submitOutbox(ctx, bot.id, { kind: 'run_command', payload: { cmd: 'echo', args: [arg], cwd: bot.homeDir }, why: '检查' });
      await decideApproval(ctx, action.approvalId!, true);
    }
    await executeReadyOutbox(ctx);
    const summaries = ctx.store.table('percepts').list(row => row.kind === 'outbox_done').map(row => ownerPerceptSummary(ctx, row));
    expect(summaries).toEqual(['运行命令 echo 完成 → 已完成', '运行命令 echo 失败 → 执行失败：命令退出码 2']);
  });
});

describe('M10 出站决定的模型原句', () => {
  it.each(['expired', 'rejected'] as const)('submitOutbox → %s → Hub tick 仍保留给机器人的原句', async status => {
    const { ctx, bot } = await setup();
    const hub = createHub(ctx);
    await hub.start();
    ctx.clock.advance(ctx.settings.startupQuietMs);
    const action = await submitOutbox(ctx, bot.id, httpInput);
    if (status === 'rejected') await decideApproval(ctx, action.approvalId!, false);
    else ctx.clock.advance(ctx.settings.approvalExpiryMs);
    await hub.tick();
    expect(ctx.store.table('outbox').get(action.id)?.status).toBe('rejected');
    expect(ctx.net.calls).toHaveLength(0);
    const packet = (ctx.host.calls.find(row => row.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage;
    expect(packet).toContain(`审批单 ${action.approvalId} 已${status === 'expired' ? '过期，视为拒绝' : '拒绝'}，不要执行`);
    expect(packet).not.toContain('中心已执行，结果是');
    await hub.stop();
  });
});
