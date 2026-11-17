/**
 * P72l 的测试：修复第一块两步真模型验证（P72k）发现的两处问题。
 * - L1：总管在主人发起的回合里派活（P74b 起用 hub_job_manage，原来的 hub_handoff 已移出工具清单）或 hub_send，收件员工越过「同一事项冷却」和「最短思考间隔」立即开工；
 *   其他同伴消息、其余闸门（暂停、并发等）一律照常。
 * - L2：因同伴交接或同伴消息排队的员工，给主人看的状态文字是短句，不含交接全文和议程编号；
 *   给模型看的唤醒包仍是完整交接摘要。
 * 为什么走真实 Hub：闸门、入队、唤醒包都挂在真实链路上，只有走链路才能测到接线。
 * 时间全部用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { callTool, chiefDrafts, ownerSays, setup, speak, type Fix } from './p72b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';

const MINUTE = 60_000;

/**
 * 总管提交约定、交账、主人说「定了」，总管被主人叫醒（回合开着）。
 * 然后把时钟推进 10 分钟（越过启动静默和全局放行间隔，只留下「最短思考间隔」这道闸），
 * 再把给定员工的上次思考时间设成 5 分钟前（比任何角色的最短间隔都近）。
 */
async function ownerTurnWithRecentThinker(fix: Fix, recent: Array<Fix['wang']>): Promise<void> {
  await chiefDrafts(fix);
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  fix.ctx.clock.advance(10 * MINUTE);
  for (const bot of recent) fix.ctx.store.table('bots').patch(bot.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
}

/** 某员工已经有的唤醒单数量。 */
const wakeCount = (fix: Fix, botId: string) => fix.ctx.store.table('wakes').count(row => row.botId === botId);
/** 某员工排在队列里的候选。 */
const queuedFor = (fix: Fix, botId: string) => fix.ctx.store.table('queue').list(row => row.botId === botId);
/** 推进一秒后跑一次调度。 */
async function pump(fix: Fix): Promise<void> {
  fix.ctx.clock.advance(1_000);
  await fix.hub.tick();
}

/** 对已固定的约定派活的参数（P74b：派活只有 hub_job_manage 一条路，原来的 hub_handoff 场景改用它）。 */
const assignArgs = (fix: Fix, executor: string) => ({
  mode: 'assign', agreementId: fix.ctx.store.table('agreements').list()[0]!.id, executor, dueAt: '2026-11-17 18:00', launchStep: false,
});

describe('L1 总管在主人发起的回合里派活，员工不用等最短思考间隔', () => {
  it('正例：员工 5 分钟前刚思考过，总管派活（hub_job_manage）给他，他的唤醒立即放行', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(fix, '小王'));
    expect(result.ok).toBe(true);
    await pump(fix);
    expect(wakeCount(fix, fix.wang.id)).toBe(1);
    expect(queuedFor(fix, fix.wang.id)).toHaveLength(0);
  });

  it('正例：hub_send 同理', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.li]);
    const result = await callTool(fix, fix.chief, 'hub_send', { to: '小李', text: '请开始做报价页' });
    expect(result.ok).toBe(true);
    await pump(fix);
    expect(wakeCount(fix, fix.li.id)).toBe(1);
  });

  it('反例：总管所在回合不是主人发起的，员工仍受最短思考间隔限制', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    // 把总管本回合的唤醒单改成非主人发起，其余条件不变。
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    // P74b：派活必须在主人发起的回合里，所以这条反例改用 hub_send（同样是总管指名发给员工，同样靠主人发起的标记越过最短思考间隔）。
    expect((await callTool(fix, fix.chief, 'hub_send', { to: '小王', text: '请做报价页' })).ok).toBe(true);
    expect(queuedFor(fix, fix.wang.id)[0]?.chiefDispatch).toBeUndefined();
    await pump(fix);
    expect(wakeCount(fix, fix.wang.id)).toBe(0);
    expect(queuedFor(fix, fix.wang.id)).toHaveLength(1);
  });

  it('反例：总管所在回合不是主人发起的，派活（hub_job_manage）直接被拒，没有任何候选', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(fix, '小王')))
      .toMatchObject({ ok: false, error: '派活只能在主人发话、确认或回答叫醒的回合里进行' });
    expect(queuedFor(fix, fix.wang.id)).toHaveLength(0);
  });

  // P74b：员工之间不再直接发消息（原来这里有一条「员工之间的 hub_handoff 仍受限制」，hub_handoff 已移出工具清单，随之删除）。
  it('员工之间的 hub_send 被拒绝，对方没有任何候选', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.li]);
    expect(await callTool(fix, fix.wang, 'hub_send', { to: '小李', text: '在吗' }))
      .toMatchObject({ ok: false, error: '员工之间不直接发消息。做完交回用 hub_job_work 的 submit；有问题问总管。' });
    await pump(fix);
    expect(wakeCount(fix, fix.li.id)).toBe(0);
    expect(queuedFor(fix, fix.li.id)).toHaveLength(0);
  });

  /** 一条直接构造的候选，用来在纯闸门层面核对「暂停」和「并发」两道闸不被豁免。 */
  const entryFor = (botId: string, chiefDispatch: boolean) => ({
    id: 'q_0000000001', botId, variant: 'regular' as const, priority: 0.5, urgent: false, ownerInitiated: false,
    subjectKey: 'peer:x', notBefore: 0, enqueuedAt: 0, ...(chiefDispatch ? { chiefDispatch: true } : {}),
    reason: { kind: 'peer_message' as const, score: 0.6, threshold: 0.3, summary: '交接', evidence: [] },
  });

  it('闸门层：没有标记时最短思考间隔拦住，有标记时放行；暂停和并发有标记也照常拦', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    // 先让总管的回合结束，避免全局并发数干扰。
    await speak(fix, fix.chief, '已安排', { outcome: 'progress' });
    const now = fix.ctx.clock.now();
    const snapshot = buildSnapshot(fix.ctx, fix.wang.id, now);
    expect(evaluateGates(entryFor(fix.wang.id, false), snapshot, now, fix.ctx.settings)).toMatchObject({ pass: false, by: 'pace_min' });
    expect(evaluateGates(entryFor(fix.wang.id, true), snapshot, now, fix.ctx.settings)).toEqual({ pass: true });
    const paused = { ...snapshot, bot: { ...snapshot.bot!, lifecycle: 'paused' as const } };
    expect(evaluateGates(entryFor(fix.wang.id, true), paused, now, fix.ctx.settings)).toMatchObject({ pass: false, by: 'paused' });
    const running = { ...snapshot, running: true };
    expect(evaluateGates(entryFor(fix.wang.id, true), running, now, fix.ctx.settings)).toMatchObject({ pass: false, by: 'concurrency' });
    const waiting = { ...snapshot, openOwnerAskCount: 1 };
    // P76r1 同步（第 4 节口径变化）：总管为主人派出的活（chiefDispatch）不再被员工开着的提问挡住（原来结论是 waiting_owner，现在放行）；
    // 反例：员工自己发起的同类候选（不带标记，改用议程到期的候选，免得被更靠前的节奏闸门拦下）仍被 waiting_owner 拦住。
    expect(evaluateGates(entryFor(fix.wang.id, true), waiting, now, fix.ctx.settings)).toEqual({ pass: true });
    const ownWork = { ...entryFor(fix.wang.id, false), reason: { ...entryFor(fix.wang.id, false).reason, kind: 'agenda_due' as const } };
    expect(evaluateGates(ownWork, waiting, now, fix.ctx.settings)).toMatchObject({ pass: false, by: 'waiting_owner' });
  });
});

describe('L2 同伴交接和消息排队时，给主人看的状态文字用短句', () => {
  // P74b：派活不再走交接，改用 hub_job_manage；给主人看的短句改为「总管交来一件事，等待开工」（任务卡 3.3 第 5 步），
  // 给模型看的摘要改为「总管交来一件事：约定标题」，不再有议程编号。
  it('派活入队后，员工的状态文字是短句，不含编号；候选里给模型看的摘要写明约定标题', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    // 让这次派活留在队列里（员工暂时不被放行）：给他设一个一小时后才能重试的退避时间。
    fix.ctx.store.table('bots').patch(fix.wang.id, { retryAt: fix.ctx.clock.now() + 60 * MINUTE });
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(fix, '小王'))).ok).toBe(true);
    const bot = fix.ctx.store.table('bots').get(fix.wang.id)!;
    expect(bot.activity).toBe('queued');
    expect(bot.activityText).toBe('总管交来一件事，等待开工');
    expect(bot.activityText).not.toMatch(/a_[0-9a-z]+|job_|agr_/);
    const reason = queuedFor(fix, fix.wang.id)[0]!.reason;
    expect(reason.ownerSummary).toBe('总管交来一件事，等待开工');
    expect(reason.summary).toBe('总管交来一件事：每日报价页');
  });

  it('同伴消息入队后，状态文字是「某某发来一条消息，等待处理」', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.li]);
    // P74b：员工之间不再直接发消息，发件人改为总管；总管所在回合不是主人发起的，消息才会留在队列里看排队时的状态（断言不变）。
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    await callTool(fix, fix.chief, 'hub_send', { to: '小李', text: '这是一段很长的内部说明' });
    const bot = fix.ctx.store.table('bots').get(fix.li.id)!;
    expect(bot.activityText).toBe('老大发来一条消息，等待处理');
    expect(queuedFor(fix, fix.li.id)[0]!.reason.summary).toContain('这是一段很长的内部说明');
  });

  it('放行后：唤醒账本里给主人看的一列是短句，唤醒包里有派活的摘要', async () => {
    const fix = await setup();
    await ownerTurnWithRecentThinker(fix, [fix.wang]);
    await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(fix, '小王'));
    await pump(fix);
    const ticket = fix.ctx.store.table('wakes').list(row => row.botId === fix.wang.id)[0]!;
    expect(ticket.reason.ownerSummary).toBe('总管交来一件事，等待开工');
    const packet = lastPacket(fix, fix.wang);
    expect(packet).toContain('总管交来一件事：每日报价页');
    // 状态栏此时是「正在处理：」加短句，不含编号。
    expect(fix.ctx.store.table('bots').get(fix.wang.id)!.activityText).not.toMatch(/a_[0-9a-z]+|job_|agr_/);
  });
});
