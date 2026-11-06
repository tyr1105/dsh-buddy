/** C03 找主人验收：验证路由、持久已读、过期默认、单推边界及不调用模型的日报。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { postThread, sendOwnerMessage, markRead, threadMessages } from '../src/outreach/thread.js';
import { createInboxItem, answerInbox, expireInbox, closeAlertItem } from '../src/outreach/inbox.js';
import { submitProposal } from '../src/outreach/proposals.js';
import { requestPush, pushesLeft } from '../src/outreach/push.js';
import { buildDigest, maybeSendDigest } from '../src/outreach/digest.js';
import { createBotHome, initRoot } from '../src/memory/files.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { PerceptSchema } from '../src/model/perception.js';
import { OutboxActionSchema } from '../src/model/outreach.js';
import { requestApproval } from '../src/gate/approvals.js';
import { botFixture, goalFixture, watchFixture, modelFixtures, id } from './model-fixtures.js';
import { CommitSchema, WakeTicketSchema } from '../src/model/wake.js';

const hour = 3_600_000;
const day = 24 * hour;
function context() {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
  return ctx;
}
function addBot(ctx: ReturnType<typeof context>, name = '专员', role: 'chief' | 'researcher' = 'researcher') {
  const bot = { ...botFixture, id: 'b_0000000002', name, role, homeDir: '/hub/bots/b_0000000002' };
  ctx.store.table('bots').put(bot); return bot;
}
function question(ctx: ReturnType<typeof context>, overrides = {}) {
  return createInboxItem(ctx, { botId: botFixture.id, type: 'question', title: '选哪个', body: '需要你决定', subjectKey: 'subject',
    options: ['继续', '停止'], defaultOption: '停止', ...overrides });
}
function push(ctx: ReturnType<typeof context>, subjectKey: string, botId: string | null = botFixture.id, level: 'P0' | 'P1' | 'P2' = 'P1') {
  return requestPush(ctx, { botId, level, title: '需要决定', body: '内容', subjectKey });
}

describe('线程与路由', () => {
  it('直投保留原话、主人感知与100优先级', () => {
    const ctx = context(); const message = sendOwnerMessage(ctx, botFixture.id, '请核对来源');
    expect(message.text).toBe('请核对来源');
    expect(ctx.store.table('percepts').list()[0]).toMatchObject({ source: 'owner', salience: 1, location: message.id });
    expect(ctx.store.table('queue').list()[0]).toMatchObject({ botId: botFixture.id, priority: 100, ownerInitiated: true });
  });
  it('team 多个@名字均投递，不默认分给总管', () => {
    const ctx = context(); const other = addBot(ctx, '总管', 'chief'); sendOwnerMessage(ctx, 'team', '@研究员 @总管 请核对');
    expect(ctx.store.table('queue').list().map(row => row.botId)).toEqual([botFixture.id, other.id]);
  });
  it('team 无点名优先总管', () => {
    const ctx = context(); const chief = addBot(ctx, '总管', 'chief'); sendOwnerMessage(ctx, 'team', '看看进度');
    expect(ctx.store.table('queue').list()[0]?.botId).toBe(chief.id);
  });
  it('无总管按最近提名路由并说明', () => {
    const ctx = context(); const other = addBot(ctx); postThread(ctx, { thread: 'team', from: 'owner', kind: 'chat', text: '专员最近做得怎样' });
    sendOwnerMessage(ctx, 'team', '继续做');
    expect(ctx.store.table('queue').list()[0]?.botId).toBe(other.id);
    expect(ctx.store.log('thread').all().some(row => row.kind === 'system' && row.text.includes('专员'))).toBe(true);
  });
  it('当前普通提名也是最近提名', () => {
    const ctx = context(); const other = addBot(ctx); sendOwnerMessage(ctx, 'team', '专员来看看');
    expect(ctx.store.table('queue').list()[0]?.botId).toBe(other.id);
  });
  it('无提名投第一个在岗者', () => {
    const ctx = context(); addBot(ctx); sendOwnerMessage(ctx, 'team', '开始工作');
    expect(ctx.store.table('queue').list()[0]?.botId).toBe(botFixture.id);
  });
  it('没有在岗者保留消息并说明', () => {
    const ctx = context(); ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'paused' }); sendOwnerMessage(ctx, 'team', '看看');
    expect(ctx.store.table('queue').count()).toBe(0); expect(ctx.store.log('thread').all().at(-1)?.text).toContain('没有在岗');
  });
  it('暂停机器人直投仍保存消息与候选供调度决定', () => {
    const ctx = context(); ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'paused' }); sendOwnerMessage(ctx, botFixture.id, '恢复后处理');
    expect(ctx.store.table('queue').count()).toBe(1);
  });
  it.each(['', '   '])('空消息 %j 拒绝', text => expect(() => sendOwnerMessage(context(), botFixture.id, text)).toThrow('text'));
  it('不存在的线程拒绝且不写日志', () => { const ctx = context(); expect(() => sendOwnerMessage(ctx, 'missing', '消息')).toThrow('不存在'); expect(ctx.store.log('thread').all()).toHaveLength(0); });
  it('markRead投影旧消息，新消息继续未读，重建运行态不丢失', async () => {
    const ctx = context(); postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '旧' }); await markRead(ctx, botFixture.id);
    ctx.clock.advance(1); postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '新' });
    expect(threadMessages({ ...ctx }, botFixture.id).map(row => row.readAt === null)).toEqual([false, true]);
  });
  it('已读不接受未来时刻', async () => { const ctx = context(); await expect(markRead(ctx, botFixture.id, ctx.clock.now() + 1)).rejects.toThrow('不能晚于'); });
  it('同毫秒标记之后的新消息仍未读', async () => {
    const ctx = context(); postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '旧' }); await markRead(ctx, botFixture.id);
    postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '新' }); expect(threadMessages(ctx, botFixture.id).map(row => row.readAt === null)).toEqual([false, true]);
  });
  it('重启只凭持久文件也能恢复已读，不依赖审计在内存', async () => {
    const ctx = context(); const message = postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '旧消息' }); await markRead(ctx, botFixture.id);
    const restarted = createTestContext({ fs: ctx.fs, clock: ctx.clock }); restarted.store.table('bots').put(botFixture); restarted.store.log('thread').append(message);
    await initRoot(restarted); expect(threadMessages(restarted, botFixture.id)[0]?.readAt).not.toBeNull(); expect(restarted.store.log('audit').all()).toHaveLength(0);
  });
  it('已读落盘失败不宣称成功', async () => {
    const ctx = context(); postThread(ctx, { thread: botFixture.id, from: 'hub', kind: 'system', text: '未读' }); ctx.fs.writeTextAtomic = async () => { throw new Error('磁盘故障'); };
    await expect(markRead(ctx, botFixture.id)).rejects.toThrow('磁盘故障'); expect(threadMessages(ctx, botFixture.id)[0]?.readAt).toBeNull(); expect(ctx.store.log('audit').all()).toHaveLength(0);
  });
});

describe('收件箱、提议与默认回答', () => {
  it('提问默认72小时过期', () => { const ctx = context(); expect(question(ctx).expiresAt).toBe(ctx.clock.now() + 72 * hour); });
  it.each([{ options: ['一个'] }, { defaultOption: '不存在' }, { options: ['1', '2', '3', '4', '5'], defaultOption: '1' }])('提问选项错误拒绝 %j', overrides => expect(() => question(context(), overrides)).toThrow());
  it('自由文本回答生成回复感知和90优先级', async () => {
    const ctx = context(); const item = question(ctx); await answerInbox(ctx, item.id, '改成另外的方案');
    expect(ctx.store.table('inbox').get(item.id)?.status).toBe('answered');
    expect(ctx.store.table('queue').list()[0]).toMatchObject({ priority: 90, subjectKey: 'subject', reason: { kind: 'inbox_reply' } });
  });
  it('重复回答拒绝', async () => { const ctx = context(); const item = question(ctx); await answerInbox(ctx, item.id, '继续'); await expect(answerInbox(ctx, item.id, '停止')).rejects.toThrow('已处理'); });
  it('并发作答只落实一个答案', async () => {
    const ctx = context(); const item = question(ctx); const result = await Promise.allSettled([answerInbox(ctx, item.id, '继续'), answerInbox(ctx, item.id, '停止')]);
    expect(result.map(row => row.status)).toEqual(['fulfilled', 'rejected']); expect(ctx.store.table('inbox').get(item.id)?.answer).toBe('继续');
  });
  it('24小时提醒只标记一次，未提前执行默认', async () => {
    const ctx = context(); const item = question(ctx); ctx.clock.advance(24 * hour); await expireInbox(ctx, ctx.clock.now()); await expireInbox(ctx, ctx.clock.now());
    expect(ctx.store.table('inbox').get(item.id)?.status).toBe('open');
    expect(ctx.store.log('audit').all().filter(row => row.action === 'question_reminder')).toHaveLength(1);
  });
  it('72小时执行默认并唤醒，只处理一次', async () => {
    const ctx = context(); const item = question(ctx); ctx.clock.advance(72 * hour); await expireInbox(ctx, ctx.clock.now()); await expireInbox(ctx, ctx.clock.now());
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'expired', answer: '停止' }); expect(ctx.store.table('percepts').count()).toBe(1);
  });
  it('七天提议撤回', async () => { const ctx = context(); const item = await submitProposal(ctx, botFixture.id, { title: '建议', detail: '内容', value: 1, confidence: 1 }); ctx.clock.advance(7 * day); await expireInbox(ctx, ctx.clock.now()); expect(ctx.store.table('inbox').get(item!.id)?.status).toBe('withdrawn'); });
  it('接受关注提议落实 active', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); ctx.store.table('watches').put({ ...watchFixture, status: 'proposed' });
    const item = await submitProposal(ctx, botFixture.id, { title: '加关注', detail: '说明', value: 1, confidence: 1, refId: watchFixture.id }); await answerInbox(ctx, item!.id, '接受');
    expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('active');
  });
  it('接受目标提议落实 active', async () => {
    const ctx = context(); ctx.store.table('goals').put({ ...goalFixture, status: 'proposed' }); const item = await submitProposal(ctx, botFixture.id, { title: '目标', detail: '说明', value: 1, confidence: 1, refId: goalFixture.id }); await answerInbox(ctx, item!.id, '接受');
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('active');
  });
  it('接受教训提议落实规则并写身份文件', async () => {
    const ctx = context(); ctx.store.table('rules').put({ id: id('ru'), scope: botFixture.id, text: '先验证', redLine: false, source: 'lesson', status: 'proposed', createdAt: ctx.clock.now() });
    const item = await submitProposal(ctx, botFixture.id, { title: '教训', detail: '说明', value: 1, confidence: 1, refId: id('ru') }); await answerInbox(ctx, item!.id, '接受');
    expect(ctx.store.table('rules').get(id('ru'))?.status).toBe('active'); expect(await ctx.fs.readText(`${botFixture.homeDir}/AGENTS.md`)).toContain('先验证');
  });
  it.each([['通过', 'done'], ['未通过', 'active']])('目标验收 %s → %s', async (answer, status) => {
    const ctx = context(); ctx.store.table('goals').put({ ...goalFixture, status: 'done_pending_check' }); const item = question(ctx, { refId: goalFixture.id }); await answerInbox(ctx, item.id, answer);
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe(status);
  });
  it('审批收件箱复用中心批准路径', async () => {
    const ctx = context(); const approval = await requestApproval(ctx, botFixture.id, 'write', { path: '/out' }, 'C', '交付文件');
    const item = ctx.store.table('inbox').list()[0]!; await answerInbox(ctx, item.id, '批准'); expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('approved');
  });
  it('过期审批点击批准仍保留expired和拒绝事实', async () => {
    const ctx = context(); const approval = await requestApproval(ctx, botFixture.id, 'write', { path: '/out' }, 'C', '交付文件');
    const item = ctx.store.table('inbox').list()[0]!; ctx.clock.advance(day); await answerInbox(ctx, item.id, '批准');
    expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('expired'); expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'expired', answer: '拒绝' });
  });
  it.each(['拒绝', '到期'] as const)('关注提议%s后释放关注数量', async mode => {
    const ctx = context(); ctx.store.table('watches').put({ ...watchFixture, status: 'proposed' });
    const item = await submitProposal(ctx, botFixture.id, { title: '关注', detail: '说明', value: 1, confidence: 1, refId: watchFixture.id });
    if (mode === '拒绝') await answerInbox(ctx, item!.id, '拒绝'); else { ctx.clock.advance(7 * day); await expireInbox(ctx, ctx.clock.now()); }
    expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('expired');
  });
  it.each(['拒绝', '到期'] as const)('目标提议%s后只归档proposed副本', async mode => {
    const ctx = context(); ctx.store.table('goals').put(goalFixture); ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002', status: 'proposed' });
    const item = await submitProposal(ctx, botFixture.id, { title: '目标', detail: '说明', value: 1, confidence: 1, refId: 'g_0000000002' });
    if (mode === '拒绝') await answerInbox(ctx, item!.id, '拒绝'); else { ctx.clock.advance(7 * day); await expireInbox(ctx, ctx.clock.now()); }
    expect(ctx.store.table('goals').get('g_0000000002')?.status).toBe('abandoned'); expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('active');
  });
  it.each(['拒绝', '到期'] as const)('教训提议%s后归档', async mode => {
    const ctx = context(); ctx.store.table('rules').put({ id: id('ru'), scope: botFixture.id, text: '先验证', redLine: false, source: 'lesson', status: 'proposed', createdAt: ctx.clock.now() });
    const item = await submitProposal(ctx, botFixture.id, { title: '教训', detail: '说明', value: 1, confidence: 1, refId: id('ru') });
    if (mode === '拒绝') await answerInbox(ctx, item!.id, '拒绝'); else { ctx.clock.advance(7 * day); await expireInbox(ctx, ctx.clock.now()); }
    expect(ctx.store.table('rules').get(id('ru'))?.status).toBe('archived');
  });
  it('提出关注后撤回工作数据权限，接受时再次拒绝', async () => {
    const ctx = context(); ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/company'] }); ctx.store.table('watches').put({ ...watchFixture, target: '/company/docs', status: 'proposed' });
    const item = await submitProposal(ctx, botFixture.id, { title: '工作关注', detail: '说明', value: 1, confidence: 1, refId: watchFixture.id });
    await expect(answerInbox(ctx, item!.id, '接受')).rejects.toThrow('未授权'); expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('proposed');
  });
  it.each(['expired', 'deadline'] as const)('关注提议%s不能被重新激活', async mode => {
    const ctx = context(); ctx.store.table('watches').put({ ...watchFixture, status: mode === 'expired' ? 'expired' : 'proposed', expiresAt: mode === 'deadline' ? ctx.clock.now() : null });
    const item = await submitProposal(ctx, botFixture.id, { title: '关注', detail: '说明', value: 1, confidence: 1, refId: watchFixture.id }); await expect(answerInbox(ctx, item!.id, '接受')).rejects.toThrow();
    expect(ctx.store.table('watches').get(watchFixture.id)?.status).not.toBe('active');
  });
  it('过期提问点击其他答案仍先落实默认', async () => {
    const ctx = context(); const item = question(ctx); ctx.clock.advance(72 * hour); await expect(answerInbox(ctx, item.id, '继续')).rejects.toThrow('默认回答');
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'expired', answer: '停止' });
  });
  it('关闭告警同步关闭底层告警', () => {
    const ctx = context(); ctx.store.table('alerts').put({ id: id('al'), botId: botFixture.id, code: 'fault', text: '故障', level: 'P1', count: 2, firstAt: ctx.clock.now(), lastAt: ctx.clock.now(), status: 'open' });
    const item = createInboxItem(ctx, { botId: botFixture.id, type: 'alert', title: '故障', body: '', subjectKey: 'fault', refId: id('al') }); closeAlertItem(ctx, item.id);
    expect(ctx.store.table('alerts').get(id('al'))?.status).toBe('closed'); expect(ctx.store.table('inbox').get(item.id)?.status).toBe('closed');
  });
  it.each([[0.59, 1], [1, 0.49]])('value=%s confidence=%s 只入点子池', async (value, confidence) => {
    const ctx = context(); const result = await submitProposal(ctx, botFixture.id, { title: '点子', detail: '说明', value, confidence }); expect(result).toMatchObject({ status: 'closed', answer: 'idea_pool' }); expect(ctx.store.log('thread').all()).toHaveLength(0);
  });
  it('门槛边界进入收件箱', async () => { const result = await submitProposal(context(), botFixture.id, { title: '点子', detail: '说明', value: 0.6, confidence: 0.5 }); expect(result?.status).toBe('open'); });
  it('L1 每周第四条进点子池', async () => { const ctx = context(); for (let n = 0; n < 3; n++) await submitProposal(ctx, botFixture.id, { title: `建议${n}`, detail: '说明', value: 1, confidence: 1 }); expect((await submitProposal(ctx, botFixture.id, { title: '第四条', detail: '说明', value: 1, confidence: 1 }))?.answer).toBe('idea_pool'); });
  it('未准入点子池的关注草稿不永久占关注配额', async () => {
    const ctx = context(); ctx.store.table('watches').put({ ...watchFixture, status: 'proposed' });
    const item = await submitProposal(ctx, botFixture.id, { title: '低价值关注', detail: '说明', value: 0.1, confidence: 1, refId: watchFixture.id });
    expect(item?.answer).toBe('idea_pool'); expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('expired');
  });
  it('L2 不受 L1 每周上限约束', async () => { const ctx = context(); ctx.store.table('bots').patch(botFixture.id, { autonomy: 'L2' }); for (let n = 0; n < 4; n++) expect((await submitProposal(ctx, botFixture.id, { title: `建议${n}`, detail: '说明', value: 1, confidence: 1 }))?.status).toBe('open'); });
  it('拒绝同标题30天内不再提，边界恢复', async () => {
    const ctx = context(); const input = { title: '相同标题', detail: '说明', value: 1, confidence: 1 }; const item = await submitProposal(ctx, botFixture.id, input); await answerInbox(ctx, item!.id, '拒绝');
    ctx.clock.advance(30 * day - 1); expect(await submitProposal(ctx, botFixture.id, input)).toBeNull(); ctx.clock.advance(1); expect((await submitProposal(ctx, botFixture.id, input))?.status).toBe('open');
  });
});

describe('单推注意力预算', () => {
  it.each([['22:59', 'sent'], ['23:00', 'deferred_quiet'], ['07:59', 'deferred_quiet'], ['08:00', 'sent']])('跨午夜 %s → %s', async (time, result) => {
    const ctx = context(); ctx.clock.set(Date.parse(`2026-11-05T${time}:00+08:00`)); expect(await push(ctx, 'subject')).toBe(result);
    expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(result === 'sent' ? 1 : 0);
  });
  it('每机器人第三条超预算', async () => { const ctx = context(); expect(await push(ctx, '1')).toBe('sent'); expect(await push(ctx, '2')).toBe('sent'); expect(await push(ctx, '3')).toBe('over_budget'); });
  it('全体第四条超预算', async () => { const ctx = context(); const other = addBot(ctx); await push(ctx, '1'); await push(ctx, '2'); await push(ctx, '3', other.id); expect(await push(ctx, '4', other.id)).toBe('over_budget'); });
  it('P0 忽略免打扰与预算但仍去重', async () => {
    const ctx = context(); ctx.clock.set(Date.parse('2026-11-05T23:00:00+08:00')); for (let n = 0; n < 4; n++) expect(await push(ctx, `${n}`, botFixture.id, 'P0')).toBe('sent');
    expect(pushesLeft(ctx, botFixture.id)).toBe(2); expect(await push(ctx, '0', botFixture.id, 'P0')).toBe('duplicate');
  });
  it('24小时同主题不重复，恰好24小时可再推', async () => {
    const ctx = context(); await push(ctx, 'same'); ctx.clock.advance(day - 1); expect(await push(ctx, 'same')).toBe('duplicate'); ctx.clock.advance(1); expect(await push(ctx, 'same')).toBe('sent');
  });
  it('被免打扰拦住不占去重，白天可以推送', async () => { const ctx = context(); ctx.clock.set(Date.parse('2026-11-05T07:00:00+08:00')); await push(ctx, 'same'); ctx.clock.advance(hour); expect(await push(ctx, 'same')).toBe('sent'); });
  it('并发推送也不能透支预算', async () => { const ctx = context(); const results = await Promise.all(['1', '2', '3', '4'].map(subject => push(ctx, subject))); expect(results).toEqual(['sent', 'sent', 'over_budget', 'over_budget']); });
  it('通知失败不计为sent，下一次可重试', async () => {
    const ctx = context(); const notify = ctx.host.notify.bind(ctx.host); ctx.host.notify = async () => { throw new Error('宿主失败'); };
    await expect(push(ctx, 'retry')).rejects.toThrow('宿主失败'); expect(pushesLeft(ctx, botFixture.id)).toBe(2); ctx.host.notify = notify; expect(await push(ctx, 'retry')).toBe('sent');
  });
});

describe('日报', () => {
  it('内容包括昨天理由、结果与三条最重要汇报', () => {
    const ctx = context(); const yesterday = ctx.clock.now() - day;
    const wake = WakeTicketSchema.parse(modelFixtures.WakeTicket.valid); ctx.store.table('wakes').put({ ...wake, startedAt: yesterday, dispatchedAt: yesterday });
    const commit = CommitSchema.parse(modelFixtures.Commit.valid);
    for (let n = 1; n <= 4; n++) ctx.store.table('commits').put({ ...commit, id: `c_000000000${n}`, report: `汇报${n}`, importance: n + 5, createdAt: yesterday });
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('昨天醒了 1 次'); expect(text).toContain('有进展 4 次'); expect(text).toContain('汇报4'); expect(text).not.toContain('汇报1');
  });
  it('出站notify_owner进入日报重点，与交账同文不重复', () => {
    const ctx = context(); const yesterday = ctx.clock.now() - day; const action = OutboxActionSchema.parse(modelFixtures.OutboxAction.valid);
    ctx.store.table('outbox').put({ ...action, kind: 'notify_owner', status: 'done', doneAt: yesterday, payload: { text: '已经核对完成', importance: 8 } });
    ctx.store.table('commits').put({ ...CommitSchema.parse(modelFixtures.Commit.valid), createdAt: yesterday, report: '已经核对完成', importance: 7 });
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('重点汇报：已经核对完成'); expect(text.match(/已经核对完成/g)).toHaveLength(1);
  });
  it('出站和交账汇报合并后只选最重要三条', () => {
    const ctx = context(); const yesterday = ctx.clock.now() - day; const action = OutboxActionSchema.parse(modelFixtures.OutboxAction.valid);
    for (let n = 1; n <= 4; n++) ctx.store.table('outbox').put({ ...action, id: `o_000000000${n}`, kind: 'notify_owner', status: 'done', doneAt: yesterday, payload: { text: `出站汇报${n}`, importance: n + 5 } });
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('出站汇报4'); expect(text).not.toContain('出站汇报1');
  });
  it('失败或今日出站汇报不混入昨日成绩', () => {
    const ctx = context(); const action = OutboxActionSchema.parse(modelFixtures.OutboxAction.valid);
    ctx.store.table('outbox').put({ ...action, kind: 'notify_owner', status: 'failed', doneAt: ctx.clock.now() - day, payload: { text: '失败汇报', importance: 9 } });
    ctx.store.table('outbox').put({ ...action, id: 'o_0000000002', kind: 'notify_owner', status: 'done', doneAt: ctx.clock.now(), payload: { text: '今日汇报', importance: 9 } });
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).not.toContain('失败汇报'); expect(text).not.toContain('今日汇报');
  });
  it('昨日直接生效的目标变更显示，提议和今日变更不冒充生效', () => {
    const ctx = context(); const audit = (suffix: string, detail: string, at: number) => ctx.store.log('audit').append({ id: `au_000000000${suffix}`, actor: botFixture.id, action: 'hub_goal_upsert', detail, at });
    audit('1', `${goalFixture.id} active 昨天新增目标`, ctx.clock.now() - day); audit('2', `${goalFixture.id} proposed 等待批准目标`, ctx.clock.now() - day); audit('3', `${goalFixture.id} active 今天修改目标`, ctx.clock.now());
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('目标变更：昨天新增目标'); expect(text).not.toContain('等待批准目标'); expect(text).not.toContain('今天修改目标');
  });
  it.each([true, false])('期望满足=%s 的日报事实', satisfied => {
    // 日报统计昨日事实，关注项必须在昨日的期限前就已经生效。
    const ctx = context(); const yesterday = ctx.clock.now() - day; ctx.store.table('watches').put({ ...watchFixture, createdAt: yesterday - day, expectation: { text: '日报', everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: satisfied ? yesterday : null, lastMissedAt: satisfied ? null : yesterday } });
    expect(buildDigest(ctx, ctx.clock.now())).toContain(satisfied ? '已出现' : '【未出现】');
  });
  it('今早新满足覆盖时间后，昨天满足审计仍正确显示已出现', () => {
    const ctx = context(); ctx.store.table('watches').put({ ...watchFixture, createdAt: ctx.clock.now() - 2 * day, expectation: { text: '日报', everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: ctx.clock.now(), lastMissedAt: null } });
    writeOutreachAudit(ctx, 'expectation_satisfied', { watchId: watchFixture.id }, 'hub', ctx.clock.now() - day);
    expect(buildDigest(ctx, ctx.clock.now())).toContain('已出现');
  });
  it('今早满足不能覆盖昨天落空事实', () => {
    const ctx = context(); ctx.store.table('watches').put({ ...watchFixture, createdAt: ctx.clock.now() - 2 * day, expectation: { text: '日报', everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: ctx.clock.now(), lastMissedAt: ctx.clock.now() } });
    ctx.store.table('percepts').put({ ...PerceptSchema.parse(modelFixtures.Percept.valid), kind: 'expectation_missed', createdAt: ctx.clock.now() - day });
    expect(buildDigest(ctx, ctx.clock.now())).toContain('【未出现】');
  });
  it('包含停机时长和被推迟的通知', async () => {
    const ctx = context(); ctx.store.table('downtime').put({ id: id('d'), from: ctx.clock.now() - 2 * hour, to: ctx.clock.now(), kind: 'sleep', handled: true });
    ctx.clock.set(Date.parse('2026-11-05T23:00:00+08:00')); await push(ctx, 'late'); const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('停机时长：2 小时'); expect(text).toContain('免打扰已推迟');
  });
  it('周日追加点子池与接受率，平日不显示', async () => {
    const ctx = context(); const item = await submitProposal(ctx, botFixture.id, { title: '建议', detail: '说明', value: 1, confidence: 1 }); await answerInbox(ctx, item!.id, '接受'); await submitProposal(ctx, botFixture.id, { title: '弱点子', detail: '说明', value: 0.1, confidence: 1 });
    expect(buildDigest(ctx, ctx.clock.now())).not.toContain('本周点子池'); ctx.clock.set(Date.parse('2026-11-08T10:00:00+08:00'));
    const text = buildDigest(ctx, ctx.clock.now()); expect(text).toContain('本周点子池'); expect(text).toContain('弱点子'); expect(text).toContain('100%（1/1）');
  });
  it('08:30 前不发，之后只发一次且不占单推预算', async () => {
    const ctx = context(); ctx.clock.set(Date.parse('2026-11-05T08:29:00+08:00')); expect(await maybeSendDigest(ctx, ctx.clock.now())).toBeNull(); ctx.clock.advance(60_000);
    expect(await maybeSendDigest(ctx, ctx.clock.now())).toContain('团队日报'); expect(await maybeSendDigest(ctx, ctx.clock.now())).toBeNull(); expect(pushesLeft(ctx, botFixture.id)).toBe(2); expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(1);
  });
  it('免打扰顺延到结束后', async () => {
    const ctx = context(); ctx.settings = resolveSettings({ rootDir: '/hub', digestAt: '07:30' }); ctx.clock.set(Date.parse('2026-11-05T07:30:00+08:00'));
    expect(await maybeSendDigest(ctx, ctx.clock.now())).toBeNull(); ctx.clock.advance(30 * 60_000); expect(await maybeSendDigest(ctx, ctx.clock.now())).toContain('团队日报');
  });
  it('24小时提问日报提醒只展示一次', async () => {
    const ctx = context(); question(ctx); ctx.clock.advance(day); expect(await maybeSendDigest(ctx, ctx.clock.now())).toContain('日报提醒'); ctx.clock.advance(day); expect(await maybeSendDigest(ctx, ctx.clock.now())).not.toContain('日报提醒');
  });
  it('并发日报只发一次', async () => { const ctx = context(); const result = await Promise.all([maybeSendDigest(ctx, ctx.clock.now()), maybeSendDigest(ctx, ctx.clock.now())]); expect(result.filter(Boolean)).toHaveLength(1); });
  it('通知失败后重试复用已有日报线程', async () => {
    const ctx = context(); const notify = ctx.host.notify.bind(ctx.host); ctx.host.notify = async () => { throw new Error('失败'); }; await expect(maybeSendDigest(ctx, ctx.clock.now())).rejects.toThrow(); ctx.host.notify = notify; await maybeSendDigest(ctx, ctx.clock.now()); expect(ctx.store.log('thread').all().filter(row => row.kind === 'digest')).toHaveLength(1);
  });
});

describe('告警同步', () => {
  function alert(ctx: ReturnType<typeof context>, level: 'P0' | 'P1' = 'P1') {
    ctx.store.table('alerts').put({ id: id('al'), botId: botFixture.id, code: 'fault', text: '故障正文', level, count: 2, firstAt: ctx.clock.now(), lastAt: ctx.clock.now(), status: 'open' });
  }
  it('开放告警建卡、线程并申请通知，重复同步不重复', async () => {
    const ctx = context(); alert(ctx); await syncAlertItems(ctx); await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list()[0]).toMatchObject({ type: 'alert', pushed: true }); expect(ctx.store.table('inbox').count()).toBe(1); expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(1);
  });
  it('安静时段普通告警留箱不推，P0例外', async () => {
    const ctx = context(); ctx.clock.set(Date.parse('2026-11-05T23:00:00+08:00')); alert(ctx); await syncAlertItems(ctx); expect(ctx.store.table('inbox').list()[0]?.pushed).toBe(false);
    const emergency = context(); emergency.clock.set(ctx.clock.now()); alert(emergency, 'P0'); await syncAlertItems(emergency); expect(emergency.store.table('inbox').list()[0]?.pushed).toBe(true);
  });
  it('恢复即关闭对应卡片', async () => { const ctx = context(); alert(ctx); await syncAlertItems(ctx); ctx.store.table('alerts').patch(id('al'), { status: 'closed' }); await syncAlertItems(ctx); expect(ctx.store.table('inbox').list()[0]?.status).toBe('closed'); });
  it('通知故障仍保留可处理的告警卡', async () => { const ctx = context(); alert(ctx); ctx.host.notify = async () => { throw new Error('不可用'); }; await syncAlertItems(ctx); expect(ctx.store.table('inbox').list()[0]?.status).toBe('open'); });
});
