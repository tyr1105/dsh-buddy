/** M02 维护回归：直接检验存储、最终唤醒文本与宿主调用，覆盖审查发现的行为边界。 */
import { describe, expect, test } from 'vitest';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { botFixture, goalFixture, modelFixtures, id } from './model-fixtures.js';
import { AgendaItemSchema, DriveStateSchema } from '../src/model/index.js';
import { runTool } from '../src/tools/index.js';
import { processCommit } from '../src/commit/process.js';
import { checkTurnLimits } from '../src/turn/limits.js';
import { onTurnEvent, finishTurn } from '../src/turn/events.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { createTicket } from '../src/wake/ticket.js';
import { createHandoff } from '../src/peer/handoffs.js';
import { createInboxItem, answerInbox } from '../src/outreach/inbox.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { maybeSendDigest } from '../src/outreach/digest.js';
import { refreshBotFiles, verifyProtectedFiles } from '../src/memory/files.js';
import { renderMindFiles } from '../src/memory/render.js';
import { byteLength } from '../src/util/text.js';
import { CommitInputSchema } from '../src/commit/schema.js';
const hour = 3_600_000;
const day = 24 * hour;
const agendaInput = { kind: 'review', title: '核对价格', abandonWhen: '资料已撤销', priority: 2 };
const goalInput = { aspirationId: id('asp'), title: '核对资料', doneWhen: '来源可查看', period: 'week', why: '需要证据' };

describe('M02 C03 回合与交账', () => {
  test('已交账不再收口，十分钟缺 ended 正常结束且不重试', async () => {
    const { ctx, ticket, toolCtx, bot } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { steps: 30, steeredAt: ctx.clock.now() });
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(true);
    ctx.clock.advance(10 * 60_000 - 1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)?.endedAt).toBeNull();
    expect(ctx.host.calls.filter(c => ['steer', 'cancel'].includes(c.method))).toHaveLength(0);
    ctx.clock.advance(1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'committed', endedAt: ctx.clock.now() });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveErrors: 0, retryAt: null });
    expect(ctx.store.table('queue').count(q => q.reason.kind === 'retry')).toBe(0);
  });
  test.each(['teach', 'trial'] as const)('%s 主人发起仍为30步20分钟6万', async variant => {
    const { ctx, bot, entry, ticket } = await turnContext(variant);
    ctx.store.table('wakes').patch(ticket.id, { ownerInitiated: true, steps: 29 });
    await checkTurnLimits(ctx, ctx.clock.now()); expect(ctx.host.calls).toHaveLength(0);
    expect(await buildWakePacket(ctx, bot, entry, { ...ticket, ownerInitiated: true })).toContain('最多 30 步、20 分钟、约 60000 token');
    ctx.store.table('wakes').patch(ticket.id, { steps: 30 }); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls).toContainEqual({ method: 'steer', args: [bot.sessionId, '【中心通知】已到本轮上限，请立即调用 hub_commit 收口，未完成的部分写进议程。'] });
  });
  test('审批框超时确实cancel且按错误重排并移除旧候选', async () => {
    const { ctx, bot, ticket, entry } = await turnContext(); ctx.store.table('queue').put(entry);
    await onTurnEvent(ctx, { type: 'awaiting_approval', sessionId: bot.sessionId!, at: ctx.clock.now(), tool: 'write', summary: '等批准' });
    ctx.clock.advance(5 * 60_000); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls.filter(c => c.method === 'cancel')).toEqual([{ method: 'cancel', args: [bot.sessionId] }]);
    expect(ctx.store.table('bots').get(bot.id)?.consecutiveErrors).toBe(1);
    expect(ctx.store.table('bots').get(bot.id)?.retryAt).toBeGreaterThan(ctx.clock.now());
    expect(ctx.store.table('queue').count(q => q.reason.kind === 'retry')).toBe(1);
    expect(ctx.store.table('queue').get(entry.id)).toBeNull();
  });
  test('普通超时按错误处理，收口文案遵循规格，结束重算expectedBy', async () => {
    const { ctx, ticket, bot, entry } = await turnContext(); ctx.store.table('queue').put(entry);
    ctx.store.table('bots').patch(bot.id, { nextThinkAt: ctx.clock.now() + hour, expectedBy: 1 });
    ctx.store.table('wakes').patch(ticket.id, { steps: 30 }); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls[0]?.args[1]).toBe('【中心通知】已到本轮上限，请立即调用 hub_commit 收口，未完成的部分写进议程。');
    ctx.clock.advance(ctx.settings.closingGraceMs); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('bots').get(bot.id)?.consecutiveErrors).toBe(1);
    expect(ctx.store.table('bots').get(bot.id)?.expectedBy).not.toBe(1);
    expect(ctx.store.table('queue').get(entry.id)).toBeNull();
  });
  test('交账清除旧时间候选但保留新主人消息', async () => {
    const { ctx, toolCtx, entry } = await turnContext();
    ctx.store.table('queue').put(entry);
    ctx.store.table('queue').put({ ...entry, id: 'q_0000000002', reason: { ...entry.reason, kind: 'light_check' } });
    ctx.store.table('queue').put({ ...entry, id: 'q_0000000003', reason: { ...entry.reason, kind: 'owner_message' } });
    await processCommit(ctx, toolCtx, commitArgs());
    expect(ctx.store.table('queue').list().map(q => q.reason.kind)).toEqual(['owner_message']);
  });
  test('提问使用自己的主体，不继承next_think主体', async () => {
    const { ctx, toolCtx, ticket } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { subjectKey: 'src:system:next_think' });
    await processCommit(ctx, toolCtx, commitArgs({ ownerQuestion: { text: '选择路线', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '继续分析' } }));
    const question = ctx.store.table('inbox').list()[0]!;
    expect(question.subjectKey).toBe(`question:${question.id}`);
  });
  test.each([8, 9])('report importance=%i 的单推门槛', async importance => {
    const { ctx, toolCtx } = await turnContext();
    await processCommit(ctx, toolCtx, commitArgs({ report: '证据整理完成', importance }));
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(importance === 9 ? 1 : 0);
    if (importance === 9) expect(ctx.host.calls.find(c => c.method === 'notify')?.args[0]).toMatchObject({ level: 'P2' });
  });
  test.each(['progress', 'done'] as const)('%s只更新相关目标lastProgressAt并清受挫', async outcome => {
    const { ctx, toolCtx, bot } = await turnContext();
    ctx.store.table('goals').put({ ...goalFixture, lastProgressAt: ctx.clock.now() - day });
    ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002', lastProgressAt: ctx.clock.now() - day });
    ctx.store.table('drives').put({ ...DriveStateSchema.parse(modelFixtures.DriveState.valid), id: bot.id, botId: bot.id, frustration: 0.8 });
    await processCommit(ctx, toolCtx, commitArgs({ outcome, evidence: [goalFixture.id] }));
    expect(ctx.store.table('goals').get(goalFixture.id)?.lastProgressAt).toBe(ctx.clock.now());
    expect(ctx.store.table('goals').get('g_0000000002')?.lastProgressAt).toBe(ctx.clock.now() - day);
    expect(ctx.store.table('drives').get(bot.id)?.frustration).toBe(0);
  });
  test('blocked把受挫写入真实内驱快照', async () => {
    const { ctx, toolCtx, bot } = await turnContext();
    ctx.store.table('drives').put({ ...DriveStateSchema.parse(modelFixtures.DriveState.valid), id: bot.id, botId: bot.id, frustration: 0 });
    for (let n = 1; n < ctx.settings.c02.frustrationCount; n++) ctx.store.table('commits').put({ ...commitArgs({ outcome: 'blocked', blocker: '缺少数据' }), id: `c_${String(n).padStart(10, '0')}`, wakeId: `w_${String(n).padStart(10, '0')}`, botId: bot.id, createdAt: ctx.clock.now() - n });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'blocked', blocker: '缺少数据' }));
    expect(ctx.store.table('drives').get(bot.id)?.frustration).toBeGreaterThan(0);
  });
  test.each([1, 10])('交账完整上限正例 importance=%i', importance => {
    expect(CommitInputSchema.safeParse(commitArgs({ summary: '文'.repeat(500), nextThink: { mode: 'auto', reason: '理'.repeat(200) },
      importance, outcome: 'needs_owner', ownerQuestion: { text: '选择', options: ['甲', '乙', '丙', '丁'], defaultOption: '丁', whyNeeded: '需要选择' } })).success).toBe(true);
  });
});

describe('M02 C03 工具与议程', () => {
  test.each(['done', 'abandoned', 'done_pending_check'] as const)('不能修改%s目标', async status => {
    const { ctx, tc } = toolFixture(); ctx.store.table('goals').patch(id('g'), { status, createdBy: 'owner' });
    expect(await runTool(ctx, tc, 'hub_goal_upsert', { ...goalInput, id: id('g') })).toMatchObject({ ok: false, error: expect.stringContaining('不能修改') });
    expect(ctx.store.table('goals').get(id('g'))).toMatchObject({ status, createdBy: 'owner' });
  });
  test('正常修改目标保留原创建者', async () => {
    const { ctx, tc } = toolFixture(); ctx.store.table('goals').patch(id('g'), { createdBy: 'owner' });
    expect(await runTool(ctx, tc, 'hub_goal_upsert', { ...goalInput, id: id('g') })).toMatchObject({ ok: true });
    expect(ctx.store.table('goals').get(id('g'))?.createdBy).toBe('owner');
  });
  test.each(['hub_goal_upsert', 'hub_lesson_propose', 'hub_watch_propose'])('%s周额度用完如实说点子池', async name => {
    const { ctx, tc, bot } = toolFixture(); ctx.store.table('bots').patch(bot.id, { autonomy: 'L1' });
    for (let n = 0; n < 3; n++) createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: `提议${n}`, body: '细节', subjectKey: `proposal:${n}` });
    const args = name === 'hub_goal_upsert' ? goalInput : name === 'hub_watch_propose' ? { kind: 'http', target: 'https://example.test/new', why: '跟进' } : { text: '核实事实', scope: 'self', why: '避免误报' };
    expect(await runTool(ctx, tc, name, args)).toMatchObject({ ok: true, text: expect.stringContaining('本周提议额度已用完，已记进点子池') });
    expect(ctx.store.table('inbox').list().at(-1)).toMatchObject({ status: 'closed', answer: 'idea_pool' });
  });
  test.each(['hub_state_get', 'hub_commit', 'hub_lesson_propose', 'hub_reflect_commit', 'hub_routine_save'])('%s全部等级确实包括L0', async name => {
    const { ctx, tc, bot, wake, commitArgs: args } = toolFixture(); ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    if (name === 'hub_reflect_commit') ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    const input = name === 'hub_commit' ? args : name === 'hub_lesson_propose' ? { text: '先查来源', scope: 'self', why: '可复核' }
      : name === 'hub_routine_save' ? { name: '核查', whenToUse: '分析资料', steps: ['核对来源'] }
      : name === 'hub_reflect_commit' ? { summary: '复盘完成', lessons: [], watchChanges: [], routineUpdates: [] } : {};
    expect(await runTool(ctx, tc, name, input)).toMatchObject({ ok: true });
    if (name === 'hub_lesson_propose') expect(ctx.store.table('inbox').count(i => i.type === 'proposal')).toBe(1);
  });
  test('第31条未完成议程被拒', async () => {
    const { ctx, tc } = toolFixture(); const seed = ctx.store.table('agenda').get(id('a'))!;
    for (let n = 1; n < 30; n++) ctx.store.table('agenda').put({ ...seed, id: `a_${String(n + 1).padStart(10, '0')}` });
    expect(await runTool(ctx, tc, 'hub_agenda_upsert', agendaInput)).toMatchObject({ ok: false, error: expect.stringContaining('未完成议程') });
  });
  test.each(['new', 'inplace'] as const)('同回合%s复查交no_change才加倍', async mode => {
    const { ctx, tc, now, wake, bot } = toolFixture();
    ctx.store.table('agenda').patch(id('a'), { kind: 'review', title: agendaInput.title, createdAt: now - hour, dueAt: now });
    ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, evidence: [id('a')] } });
    if (mode === 'new') await runTool(ctx, tc, 'hub_agenda_close', { id: id('a'), status: 'done', note: '核对过' });
    const input = { ...agendaInput, ...(mode === 'inplace' ? { id: id('a') } : {}), dueAt: new Date(now + hour).toISOString() };
    expect(await runTool(ctx, tc, 'hub_agenda_upsert', input)).toMatchObject({ ok: true });
    expect(await processCommit(ctx, tc, commitArgs())).toMatchObject({ ok: true, text: expect.stringContaining('自动推后') });
    expect(ctx.store.table('agenda').list(a => a.botId === bot.id && a.status === 'open' && a.title === agendaInput.title)[0]?.dueAt).toBe(now + 2 * hour);
  });
  test('progress复查不加倍，下一次同标题用最近两个dueAt差值', async () => {
    const { ctx, tc, now, wake, bot } = toolFixture();
    ctx.store.table('agenda').patch(id('a'), { kind: 'review', title: agendaInput.title, createdAt: now - 10 * hour, dueAt: now });
    ctx.store.table('agenda').put({ ...ctx.store.table('agenda').get(id('a'))!, id: 'a_0000000002', status: 'done', dueAt: now - hour });
    ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, evidence: [id('a')] } });
    await runTool(ctx, tc, 'hub_agenda_upsert', { ...agendaInput, id: id('a'), dueAt: new Date(now + hour).toISOString() });
    await processCommit(ctx, tc, commitArgs({ outcome: 'progress' }));
    expect(ctx.store.table('agenda').get(id('a'))?.dueAt).toBe(now + hour);
    await finishTurn(ctx, wake.id, now, 'committed'); ctx.clock.advance(hour);
    const next = createTicket(ctx, { id: 'q_0000000009', botId: bot.id, variant: 'regular', reason: { ...wake.reason, evidence: [id('a')] }, priority: 60, urgent: false, ownerInitiated: false, subjectKey: 'agenda:review', notBefore: ctx.clock.now(), enqueuedAt: ctx.clock.now() }, bot.sessionId);
    await runTool(ctx, { ...tc, wakeId: next.id }, 'hub_agenda_upsert', { ...agendaInput, id: id('a'), dueAt: new Date(ctx.clock.now() + hour).toISOString() });
    await processCommit(ctx, { ...tc, wakeId: next.id }, commitArgs());
    expect(ctx.store.table('agenda').get(id('a'))?.dueAt).toBe(ctx.clock.now() + 2 * hour);
  });
});

describe('M02 C03 路由日报记忆与交接', () => {
  test.each(['@小李子 看看', '@小李子，看看', '@小李子'])('完整名字最长匹配 %s', text => {
    const { ctx, bot, peer } = toolFixture(); ctx.store.table('bots').patch(bot.id, { name: '小李' }); ctx.store.table('bots').patch(peer.id, { name: '小李子' });
    sendOwnerMessage(ctx, 'team', text);
    expect(ctx.store.table('queue').list().map(q => q.botId)).toEqual([peer.id]);
  });
  test('只点名暂停机器人时说明并投给在岗总管', () => {
    const { ctx, bot, peer } = toolFixture(); ctx.store.table('bots').patch(bot.id, { role: 'chief' }); ctx.store.table('bots').patch(peer.id, { lifecycle: 'paused' });
    sendOwnerMessage(ctx, 'team', `@${peer.name} 看看`);
    expect(ctx.store.table('queue').list().map(q => q.botId)).toEqual([bot.id]);
    expect(ctx.store.log('thread').all().some(m => m.kind === 'system' && m.text.includes('不在岗'))).toBe(true);
  });
  test.each([
    { digest: '23:30', quiet: { start: '23:00', end: '08:00' }, due: '2026-11-05T23:30:00+08:00', release: '2026-11-06T08:00:00+08:00' },
    { digest: '12:30', quiet: { start: '12:00', end: '13:00' }, due: '2026-11-05T12:30:00+08:00', release: '2026-11-05T13:00:00+08:00' },
  ])('日报 $digest 到点入线程，免打扰结束只补一次通知', async ({ digest, quiet, due, release }) => {
    const { ctx } = toolFixture(); ctx.settings.digestAt = digest; ctx.settings.quietHours = quiet;
    ctx.clock.set(Date.parse(due)); await maybeSendDigest(ctx, ctx.clock.now());
    expect(ctx.store.log('thread').all().filter(m => m.kind === 'digest')).toHaveLength(1);
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(0);
    ctx.clock.set(Date.parse(release) - 1); await maybeSendDigest(ctx, ctx.clock.now());
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(0);
    ctx.clock.advance(1); await maybeSendDigest(ctx, ctx.clock.now()); await maybeSendDigest(ctx, ctx.clock.now());
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(1);
    expect(ctx.store.log('thread').all().filter(m => m.kind === 'digest')).toHaveLength(1);
  });
  test('mind时间以当前渲染日为准，仅显示七天内关闭项并守8KB', async () => {
    const { ctx, bot, now } = toolFixture(); ctx.clock.advance(3 * day);
    ctx.store.table('agenda').patch(id('a'), { title: '今日事项', dueAt: ctx.clock.now(), updatedAt: now });
    const seed = ctx.store.table('agenda').get(id('a'))!;
    ctx.store.table('agenda').put({ ...seed, id: 'a_0000000002', title: '过旧事项', status: 'done', updatedAt: ctx.clock.now() - 7 * day - 1 });
    ctx.store.table('agenda').put({ ...seed, id: 'a_0000000003', title: '最近关闭', status: 'done', updatedAt: ctx.clock.now() - 7 * day });
    const text = renderMindFiles(ctx, bot)['mind/agenda.md']!;
    expect(text).toContain('今天 10:00'); expect(text).toContain('最近关闭'); expect(text).not.toContain('过旧事项');
    for (let n = 4; n < 300; n++) ctx.store.table('agenda').put({ ...seed, id: `a_${String(n).padStart(10, '0')}`, title: `长事项${n}${'文'.repeat(100)}` });
    expect(byteLength(renderMindFiles(ctx, bot)['mind/agenda.md']!)).toBeLessThanOrEqual(ctx.settings.botAgentsMaxBytes);
  });
  test('mind目标和关注同样过滤旧终态', () => {
    const { ctx, bot, now } = toolFixture(); ctx.store.table('goals').patch(id('g'), { title: '旧完成目标', status: 'done', updatedAt: now - 8 * day });
    ctx.store.table('watches').patch(id('wt'), { target: 'https://old.example.test', status: 'expired', updatedAt: now - 8 * day });
    const files = renderMindFiles(ctx, bot); expect(files['mind/goals.md']).not.toContain('旧完成目标'); expect(files['mind/watches.md']).not.toContain('old.example');
  });
  test('保护审计只写文件名哈希，快照可在跨日恢复旧正文', async () => {
    const { ctx, bot } = await turnContext(); const before = ctx.store.log('audit').all().filter(a => a.action === 'protected_files');
    await refreshBotFiles(ctx, bot.id);
    expect(ctx.store.log('audit').all().filter(a => a.action === 'protected_files')).toHaveLength(before.length);
    const detail = JSON.parse(before.at(-1)!.detail) as { files: Record<string, object> };
    for (const value of Object.values(detail.files)) expect(Object.keys(value)).toEqual(['hash']);
    const original = await ctx.fs.readText(`${bot.homeDir}/mind/agenda.md`);
    ctx.clock.advance(day); await ctx.fs.writeTextAtomic(`${bot.homeDir}/mind/agenda.md`, '被篡改');
    expect(await verifyProtectedFiles(ctx, bot.id)).toContain('mind/agenda.md');
    expect(await ctx.fs.readText(`${bot.homeDir}/mind/agenda.md`)).toBe(original);
  });
  test.each(['/outside/file', '/hub/bots/b_0000000001-other/file', '/hub/shared/../../etc/passwd'])('存在的越界文件仍不能交接 %s', async source => {
    const { ctx, bot, peer } = toolFixture(); await ctx.fs.writeTextAtomic(source, '外部存在文件');
    await expect(createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] })).rejects.toThrow('不能复制发起方家目录或 shared 之外');
    expect(ctx.store.table('handoffs').count()).toBe(0); expect(await ctx.fs.list('/hub/shared/handoffs')).toEqual([]);
  });
  test('家内源符号链接到外部拒绝，真实家内文件可交接', async () => {
    const { ctx, bot, peer } = toolFixture(); const source = `${bot.homeDir}/work/link`; await ctx.fs.writeTextAtomic(source, '文件');
    ctx.fs.realpath = async path => path === source ? '/outside/file' : path;
    await expect(createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] })).rejects.toThrow('符号链接目标');
    ctx.fs.realpath = async path => path;
    const handoff = await createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] });
    expect(await ctx.fs.readText(handoff.files[0]!)).toBe('文件');
  });
  test('交接目标目录符号链接越出shared拒绝', async () => {
    const { ctx, bot, peer } = toolFixture(); const source = `${bot.homeDir}/work/data`; await ctx.fs.writeTextAtomic(source, '文件');
    ctx.fs.realpath = async path => path.startsWith('/hub/shared/handoffs/') ? '/outside/handoff' : path;
    await expect(createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] })).rejects.toThrow('目标符号链接');
    expect(ctx.store.table('handoffs').count()).toBe(0);
  });
});

test.each(['teach', 'trial'] as const)('M02 %s 的时间和token边界也优先于主人额度', async variant => {
  for (const dimension of ['time', 'tokens'] as const) {
    const { ctx, ticket } = await turnContext(variant);
    ctx.store.table('wakes').patch(ticket.id, { ownerInitiated: true, tokens: dimension === 'tokens' ? 59_999 : 0 });
    if (dimension === 'time') ctx.clock.advance(20 * 60_000 - 1);
    await checkTurnLimits(ctx, ctx.clock.now()); expect(ctx.host.calls).toHaveLength(0);
    if (dimension === 'time') ctx.clock.advance(1); else ctx.store.table('wakes').patch(ticket.id, { tokens: 60_000 });
    await checkTurnLimits(ctx, ctx.clock.now()); expect(ctx.host.calls.filter(c => c.method === 'steer')).toHaveLength(1);
  }
});

test('M02 机器人改主人议程dueAt仍计自主预约十条上限', async () => {
  const { ctx, tc, now } = toolFixture(); const seed = ctx.store.table('agenda').get(id('a'))!;
  ctx.store.table('agenda').remove(seed.id);
  for (let n = 1; n <= 11; n++) ctx.store.table('agenda').put({ ...seed, id: `a_${String(n).padStart(10, '0')}`, source: 'owner', dueAt: null });
  for (let n = 1; n <= 10; n++) expect(await runTool(ctx, tc, 'hub_agenda_upsert', { ...agendaInput, kind: 'task', id: `a_${String(n).padStart(10, '0')}`, dueAt: new Date(now + hour).toISOString() })).toMatchObject({ ok: true });
  expect(await runTool(ctx, tc, 'hub_agenda_upsert', { ...agendaInput, kind: 'task', id: 'a_0000000011', dueAt: new Date(now + hour).toISOString() })).toMatchObject({ ok: false, error: expect.stringContaining('拼周期') });
});


test.each(['.env', 'secret.pem', 'id_rsa', 'credentials-local.yaml'])('M02 交接源%s即使在家内且真实存在仍拒绝敏感数据', async name => {
  const { ctx, bot, peer } = toolFixture(); const source = `${bot.homeDir}/work/${name}`;
  await ctx.fs.writeTextAtomic(source, '测试占位内容');
  await expect(createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] })).rejects.toThrow(/敏感/);
  expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
  expect(ctx.store.table('handoffs').count()).toBe(0);
});

test('M02交接工作数据比较规范真实目录，普通别名目录仍能复制', async () => {
  const { ctx, bot, peer } = toolFixture(); const source = `${bot.homeDir}/work/link`;
  await ctx.fs.writeTextAtomic(source, '测试占位内容');
  ctx.settings.workDataPaths = ['/alias/company'];
  ctx.fs.realpath = async name => name === source ? `${bot.homeDir}/work/company/data` : name === '/alias/company' ? `${bot.homeDir}/work/company` : name;
  await expect(createHandoff(ctx, bot.id, { to: peer.id, task: '核对', why: '复核', files: [source] })).rejects.toThrow('尚未授权读取工作数据');
  expect(ctx.store.table('handoffs').count()).toBe(0);
});


test.each(['approval', 'closing'] as const)('M02 %s 取消接口失败仍释放并发且按错误重排', async kind => {
  const { ctx, bot, ticket, entry } = await turnContext(); ctx.store.table('queue').put(entry);
  ctx.host.cancel = async () => { throw new Error('宿主取消暂不可用'); };
  ctx.store.table('wakes').patch(ticket.id, kind === 'approval' ? { awaitingApprovalAt: ctx.clock.now() } : { steeredAt: ctx.clock.now() });
  ctx.store.table('bots').patch(bot.id, { expectedBy: 1, nextThinkAt: ctx.clock.now() + 2 * hour });
  ctx.clock.advance(kind === 'approval' ? ctx.settings.c03.awaitingApprovalCancelMs : ctx.settings.closingGraceMs);
  await expect(checkTurnLimits(ctx, ctx.clock.now())).resolves.toBeUndefined();
  expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'timeout', endedAt: ctx.clock.now() });
  expect(ctx.store.table('bots').get(bot.id)?.consecutiveErrors).toBe(1);
  expect(ctx.store.table('bots').get(bot.id)?.retryAt).toBeGreaterThan(ctx.clock.now());
  expect(ctx.store.table('bots').get(bot.id)?.expectedBy).not.toBe(1);
  expect(ctx.store.table('queue').get(entry.id)).toBeNull(); expect(ctx.store.table('queue').count(q => q.reason.kind === 'retry')).toBe(1);
});
