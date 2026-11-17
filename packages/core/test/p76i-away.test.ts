/**
 * P76i 第 3.4 节：离开期间摘要（ownerSeen、dismissAwaySummary、buildAwaySummary、总管私聊视图的 awaySummary）。
 *
 * 夹具：场景 A 的几件事（见 p76i-fixtures.ts），按设计稿场景 F 的数据造事件和回合：
 *  - 活动报名页：第 1 轮核对退回第 3 条（1 条）后林舟已改好，在等第 2 轮核对，用了 3 回合；
 *  - 活动推文：写完第一稿仍在执行，用了 2 回合；
 *  - 嘉宾介绍页：这段时间没有回合、没有事件，仍在等你。
 * 时间：你上次打开是昨天 19:10，现在是今天 09:05（离开 14 小时）；假时钟直接设到目标时刻，不推进。
 * 本文件直接调用 ownerSeen 等函数（不经 UiApi 的调度后处理，免得它顺带推进别的事）；最后一组才走 UiApi 验证接线。
 */
import { describe, expect, it } from 'vitest';
import { buildAwaySummary, awayTimeText, sentenceOf, type AwayEvent, type AwayInput, type AwayJobInput } from '../src/api/away-views.js';
import { threadViewWithAway } from '../src/api/thread-away.js';
import { dismissAwaySummary, getPresence, ownerSeen } from '../src/outreach/presence.js';
import { DAY, HOUR, MINUTE, at, cloneAgreement, cloneJob, jobFix, logEvent, putUsage, sceneA, type JobFix } from './p76i-fixtures.js';

const TZ = 'Asia/Shanghai';
const T0 = at('2026-11-16T19:10:00'); // 昨天 19:10
const T1 = at('2026-11-17T09:05:00'); // 今天 09:05

const turn = (id: string, botId: string, startedAt: number, tokens: number) => ({ wakeId: `w_${id}`, step: 'exec' as const, botId, startedAt, endedAt: startedAt + 60_000, tokens });

/** 上次打开在 T0，现在是 T1：生成摘要，返回上报结果。 */
function leaveAndReturn(ctx: JobFix['ctx']): { generated: boolean } {
  ctx.clock.set(T0);
  ownerSeen(ctx);
  ctx.clock.set(T1);
  return ownerSeen(ctx);
}

/** 场景 F：三件事的数据。 */
async function sceneF() {
  const scene = await sceneA();
  const { ctx, fix, report, guest, tweet } = scene;
  ctx.store.table('agreements').remove(tweet.id); // 对齐中的约定不进摘要（只写事）；换成一件进行中的「活动推文」
  const reportAgreement = ctx.store.table('agreements').get(report.agreementId)!;
  const tweetAgreement = cloneAgreement(ctx, reportAgreement, 'tweetjob01', '活动推文');
  const tweetJob = cloneJob(ctx, report, 'tweetjob01', tweetAgreement, { state: 'doing', round: 0, reviewerId: null, dueAt: null });
  const engineer = fix.engineer.id;
  // 活动报名页：核对中，已经是第 2 轮在等核对；这段时间 3 个回合；事件：核对第 1 轮退回第 3 条，林舟交回。
  ctx.store.table('jobs').patch(report.id, { state: 'checking', round: 2 });
  putUsage(ctx, report, {}, [turn('rep0000001', engineer, at('2026-11-16T22:00:00'), 150_000), turn('rep0000002', engineer, at('2026-11-17T00:20:00'), 150_000),
    turn('rep0000003', engineer, at('2026-11-17T01:00:00'), 100_000)]);
  logEvent(ctx, { jobId: report.id, kind: 'reviewed', at: at('2026-11-17T00:30:00'), actor: fix.reviewer.id, to: [engineer], data: { stage: 1, round: 1, result: 'fail', unmet: [3] } });
  logEvent(ctx, { jobId: report.id, kind: 'submitted', at: at('2026-11-17T01:30:00'), actor: engineer, to: [fix.reviewer.id], data: { stage: 1, round: 2, versionNo: 1 } });
  // 活动推文：执行中，2 个回合，没有重要事件。
  putUsage(ctx, tweetJob, {}, [turn('twt0000001', engineer, at('2026-11-16T20:00:00'), 120_000), turn('twt0000002', engineer, at('2026-11-16T21:00:00'), 80_000)]);
  // 嘉宾介绍页：不动（没有回合、没有事件）；它的预算线条目还开着。
  ctx.store.table('jobUsage').patch(guest.id, { turns: [] });
  return { ...scene, tweetJob };
}

const SCENE_F_LINES = [
  '你离开的 14 小时里（昨天 19:10 到 今天 09:05）',
  '活动报名页：核对第 1 轮退回 1 条，林舟已改好，在等第 2 轮核对。用了 3 回合。',
  '活动推文：执行中，在等林舟。用了 2 回合。',
  '嘉宾介绍页：仍在等你决定预计消耗怎样处理。',
  '共用 5 回合，约 600K token。没有通知过你。',
];

describe('1 ownerSeen：什么时候生成', () => {
  it('lastSeenAt 为空：只记时间，不生成，发 presence 事件', async () => {
    const fix = await jobFix();
    fix.ctx.clock.set(T0);
    fix.ctx.events.length = 0;
    expect(ownerSeen(fix.ctx)).toEqual({ generated: false });
    expect(getPresence(fix.ctx)).toMatchObject({ id: 'owner', lastSeenAt: T0, away: null });
    expect(fix.ctx.events).toContainEqual({ scope: 'presence', botId: null });
  });

  it('7 小时 50 分：不生成，只更新时间；8 小时差 1 毫秒也不生成', async () => {
    const fix = await jobFix();
    fix.ctx.clock.set(T0);
    ownerSeen(fix.ctx);
    fix.ctx.clock.set(T0 + 7 * HOUR + 50 * MINUTE);
    expect(ownerSeen(fix.ctx)).toEqual({ generated: false });
    expect(getPresence(fix.ctx)).toMatchObject({ lastSeenAt: T0 + 7 * HOUR + 50 * MINUTE, away: null });
    // 从新的 lastSeenAt 起再差 1 毫秒到 8 小时：仍不生成。
    fix.ctx.clock.set(T0 + 7 * HOUR + 50 * MINUTE + 8 * HOUR - 1);
    expect(ownerSeen(fix.ctx)).toEqual({ generated: false });
  });

  it('正好 8 小时：生成；生成后 lastSeenAt 更新为现在；away 记下起止、回合数与 token，notified 为假、dismissedAt 为空', async () => {
    const { ctx } = await sceneF();
    expect(leaveAndReturn(ctx)).toEqual({ generated: true });
    expect(getPresence(ctx)).toMatchObject({ lastSeenAt: T1, away: { from: T0, to: T1, lines: SCENE_F_LINES, totalTurns: 5, totalTokens: 600_000, notified: false, dismissedAt: null } });
    // 边界：恰好 8 小时（>=）生成。
    const fix = await jobFix();
    fix.ctx.clock.set(T0);
    ownerSeen(fix.ctx);
    fix.ctx.clock.set(T0 + 8 * HOUR);
    expect(ownerSeen(fix.ctx)).toEqual({ generated: true });
  });
});

describe('2 摘要的文字（场景 F）', () => {
  it('首行、三类行、末行逐字；回合多的事排前（按最近一次动静），仍在等你的事排在有动静的事之后', async () => {
    const { ctx } = await sceneF();
    leaveAndReturn(ctx);
    expect(getPresence(ctx)!.away!.lines).toEqual(SCENE_F_LINES);
  });

  it('什么都没有：整个只有一行「这段时间没有变化。」（没有事、没有回合）', async () => {
    const fix = await jobFix();
    leaveAndReturn(fix.ctx);
    expect(getPresence(fix.ctx)!.away).toMatchObject({ lines: ['这段时间没有变化。'], totalTurns: 0, totalTokens: 0 });
  });

  it('反例：有一件事只是「仍在等你」也不是「没有变化」', async () => {
    const { ctx } = await sceneA();
    leaveAndReturn(ctx);
    expect(getPresence(ctx)!.away!.lines).not.toEqual(['这段时间没有变化。']);
    expect(getPresence(ctx)!.away!.lines).toContain('嘉宾介绍页：仍在等你决定预计消耗怎样处理。');
  });

  it('通知过 2 次的末句；0 次「没有通知过你。」；时间段之外和没发出的不算', async () => {
    const { ctx, fix } = await sceneF();
    const row = (n: number, sentAt: number | null, state: 'sent' | 'waiting') => ctx.store.table('pushQueue').put({ id: `pq_${String(n).padStart(10, '0')}`,
      category: 'agreement', title: `通知${n}`, body: '', subjectKey: `agreement:x:${n}`, botId: fix.chief.id, createdAt: T0, sendAfter: T0, state, sentAt, mergedInto: null });
    row(1, at('2026-11-16T22:00:00'), 'sent');
    row(2, at('2026-11-17T08:00:00'), 'sent');
    row(3, T0 - HOUR, 'sent'); // 离开之前发的
    row(4, null, 'waiting'); // 还没发
    leaveAndReturn(ctx);
    const lines = getPresence(ctx)!.away!.lines;
    expect(lines[lines.length - 1]).toBe('共用 5 回合，约 600K token。通知过你 2 次。');
  });

  it('给主人看的文字不含内部编号和英文（token、K、M 这样的单位除外）', async () => {
    const { ctx } = await sceneF();
    leaveAndReturn(ctx);
    for (const text of getPresence(ctx)!.away!.lines) {
      expect(text).not.toMatch(/job_|agr_|\bb_|ptp_/);
      expect(text.replace(/token/g, '').replace(/\d+(\.\d+)?[KMBT]/g, '')).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('3 总管私聊视图的 awaySummary', () => {
  it('有摘要：总管私聊带 { lines, dismissText: 收起 }；员工私聊、其他线程没有这个字段', async () => {
    const { ctx, fix, report } = await sceneF();
    expect('awaySummary' in threadViewWithAway(ctx, fix.chief.id)).toBe(false); // 生成之前没有
    leaveAndReturn(ctx);
    expect(threadViewWithAway(ctx, fix.chief.id).awaySummary).toEqual({ lines: SCENE_F_LINES, dismissText: '收起' });
    expect('awaySummary' in threadViewWithAway(ctx, fix.engineer.id)).toBe(false);
    expect('awaySummary' in threadViewWithAway(ctx, fix.reviewer.id)).toBe(false);
    expect('awaySummary' in threadViewWithAway(ctx, report.topicId)).toBe(false);
  });

  it('收起：写 dismissedAt，视图字段消失；再收起一次、没有摘要时收起都什么都不做', async () => {
    const { ctx, fix } = await sceneF();
    expect(dismissAwaySummary(ctx)).toBe(false); // 还没有任何记录
    leaveAndReturn(ctx);
    ctx.events.length = 0;
    ctx.clock.set(T1 + 5 * MINUTE);
    expect(dismissAwaySummary(ctx)).toBe(true);
    expect(getPresence(ctx)!.away!.dismissedAt).toBe(T1 + 5 * MINUTE);
    expect(ctx.events).toContainEqual({ scope: 'presence', botId: null });
    expect('awaySummary' in threadViewWithAway(ctx, fix.chief.id)).toBe(false);
    ctx.events.length = 0;
    expect(dismissAwaySummary(ctx)).toBe(false);
    expect(ctx.events).toEqual([]);
  });

  it('新的离开覆盖旧的：收起之后再离开 8 小时以上，新摘要出现（dismissedAt 清空），旧的被替换', async () => {
    const { ctx, fix, tweetJob } = await sceneF();
    leaveAndReturn(ctx);
    dismissAwaySummary(ctx);
    const first = getPresence(ctx)!.away!;
    // 再离开一天：这段时间只有活动推文有一个回合（11月17日 11:05），其余没有动静（嘉宾介绍页仍在等你）。
    const T2 = T1 + DAY;
    putUsage(ctx, tweetJob, {}, [turn('twt0000009', fix.engineer.id, T1 + 2 * HOUR, 90_000)]);
    ctx.clock.set(T2);
    expect(ownerSeen(ctx)).toEqual({ generated: true });
    const second = getPresence(ctx)!.away!;
    expect(second).toMatchObject({ from: T1, to: T2, dismissedAt: null, totalTurns: 1, totalTokens: 90_000 });
    expect(second.lines).toEqual([
      '你离开的 24 小时里（昨天 09:05 到 今天 09:05）',
      '活动推文：执行中，在等林舟。用了 1 回合。',
      '嘉宾介绍页：仍在等你决定预计消耗怎样处理。',
      '共用 1 回合，约 90K token。没有通知过你。',
    ]);
    expect(second.lines).not.toEqual(first.lines);
    expect(threadViewWithAway(ctx, fix.chief.id).awaySummary!.lines).toEqual(second.lines);
  });

  it('不到 8 小时再次上报：不覆盖已有的摘要（收起状态也保持）', async () => {
    const { ctx } = await sceneF();
    leaveAndReturn(ctx);
    dismissAwaySummary(ctx);
    const before = getPresence(ctx)!.away;
    ctx.clock.set(T1 + 30 * MINUTE);
    expect(ownerSeen(ctx)).toEqual({ generated: false });
    expect(getPresence(ctx)!.away).toEqual(before);
  });
});

/** 纯函数用的一件事（缺省：没有回合、没有事件、不在等你）。 */
const job = (patch: Partial<AwayJobInput> = {}): AwayJobInput => ({ title: '活动报名页', turns: 1, tokens: 1000, lastTurnAt: T0 + HOUR, events: [], stateLabel: '执行中',
  waitingOn: '林舟', waitingOwner: false, waitItem: null, hasOpenItem: false, noticeItem: null, waitedMs: 0, ...patch });
const ev = (kind: AwayEvent['kind'], atMs: number, actor: string, data: Record<string, unknown> = {}, to: string[] = []): AwayEvent => ({ kind, at: atMs, actor, to, data });
const NAMES = { b_0000000002: '林舟', b_0000000003: '评审甲' };
const sentence = (patch: Partial<AwayJobInput>) => sentenceOf(job(patch), NAMES);

describe('4 一句的对照表（纯函数）', () => {
  it('交付：已交付，在等你验收', () => {
    expect(sentence({ events: [ev('delivered', T0 + HOUR, 'hub')] })).toBe('已交付，在等你验收');
  });
  it('核对退回：「核对第 r 轮退回 k 条」；其后有交回再接「，{执行者}已改好，在等第 r+1 轮核对」；没有交回不接', () => {
    const fail = ev('reviewed', T0 + HOUR, 'b_0000000003', { round: 2, result: 'fail', unmet: [1, 4] });
    expect(sentence({ events: [fail] })).toBe('核对第 2 轮退回 2 条');
    expect(sentence({ events: [fail, ev('submitted', T0 + 2 * HOUR, 'b_0000000002', { round: 3 })] })).toBe('核对第 2 轮退回 2 条，林舟已改好，在等第 3 轮核对');
    // 反例：交回发生在退回之前，不算「已改好」。
    expect(sentence({ events: [ev('submitted', T0 + 30 * MINUTE, 'b_0000000002'), fail] })).toBe('核对第 2 轮退回 2 条');
  });
  it('第 3 轮仍不过（limit）：写退回的条数，不接「已改好」', () => {
    expect(sentence({ events: [ev('reviewed', T0 + HOUR, 'b_0000000003', { round: 3, result: 'limit', unmet: [2] }), ev('submitted', T0 + 2 * HOUR, 'b_0000000002')] }))
      .toBe('核对第 3 轮退回 1 条');
  });
  it('核对通过', () => {
    expect(sentence({ events: [ev('reviewed', T0 + HOUR, 'b_0000000003', { round: 1, result: 'pass', unmet: [] })] })).toBe('核对通过');
  });
  it('提问未回答：「{名字}问了 k 个问题，在等{回答的人}」，回答的人取当前在等谁（总管或你）；已回答：「……总管已回答」', () => {
    const asked = [ev('asked', T0 + HOUR, 'b_0000000002'), ev('asked', T0 + 2 * HOUR, 'b_0000000002')];
    expect(sentence({ events: asked, waitingOn: '总管' })).toBe('林舟问了 2 个问题，在等总管');
    expect(sentence({ events: asked, waitingOn: '你' })).toBe('林舟问了 2 个问题，在等你');
    expect(sentence({ events: [...asked, ev('answered', T0 + 3 * HOUR, 'b_0000000001', {}, ['b_0000000002'])] })).toBe('林舟问了 2 个问题，总管已回答');
  });
  it('验收通过：已完成', () => {
    expect(sentence({ events: [ev('owner_accepted', T0 + HOUR, 'owner')], stateLabel: '已完成', waitingOn: null })).toBe('已完成');
  });
  it('发布这一步：成功「已发布」；没有成功「发布没有成功」；主人暂不发布或中心结束「没有发布」', () => {
    expect(sentence({ events: [ev('owner_accepted', T0, 'owner'), ev('launched', T0 + HOUR, 'hub', { link: null, reason: 'command_ok' })] })).toBe('已发布');
    expect(sentence({ events: [ev('owner_accepted', T0, 'owner'), ev('launch_failed', T0 + HOUR, 'hub', { reason: 'command_failed' })] })).toBe('发布没有成功');
    expect(sentence({ events: [ev('owner_accepted', T0, 'owner'), ev('launch_declined', T0 + HOUR, 'owner', { status: 'rejected' })] })).toBe('没有发布');
    expect(sentence({ events: [ev('owner_accepted', T0, 'owner'), ev('launch_declined', T0 + HOUR, 'hub', {})] })).toBe('没有发布');
  });
  it('其余：没有重要事件，或最后一个重要事件是说明、受阻、回合上限、停止、参与者停用、你退回：「{状态词}，在等{谁}」；没有人在等只写状态词', () => {
    expect(sentence({})).toBe('执行中，在等林舟');
    expect(sentence({ events: [ev('assigned', T0, 'b_0000000001'), ev('forwarded', T0 + 1, 'b_0000000001'), ev('resumed', T0 + 2, 'hub')] })).toBe('执行中，在等林舟');
    for (const kind of ['escalated', 'executor_blocked', 'turn_cap', 'stopped', 'participant_off', 'owner_returned'] as const) {
      expect(sentence({ events: [ev('delivered', T0, 'hub'), ev(kind, T0 + HOUR, 'hub')], stateLabel: '受阻', waitingOn: '你' })).toBe('受阻，在等你');
    }
    expect(sentence({ events: [ev('stopped', T0, 'owner')], stateLabel: '已停止', waitingOn: null })).toBe('已停止');
  });
  it('最后一个重要事件才算：交付之后又核对通过，写「核对通过」；中性事件（交回、续排）不改变结论', () => {
    const events = [ev('delivered', T0, 'hub'), ev('reviewed', T0 + HOUR, 'b_0000000003', { round: 1, result: 'pass', unmet: [] }), ev('submitted', T0 + 2 * HOUR, 'b_0000000002')];
    expect(sentence({ events })).toBe('核对通过');
  });
});

describe('5 buildAwaySummary 与时间写法（纯函数）', () => {
  const input = (patch: Partial<AwayInput> = {}): AwayInput => ({ from: T0, to: T1, now: T1, timezone: TZ, names: NAMES, jobs: [], sentCount: 0, ...patch });

  it('时间写法：与 now 同一天写「今天」，前一天写「昨天」，更早写「M月D日」', () => {
    expect(awayTimeText(T1, T1, TZ)).toBe('今天 09:05');
    expect(awayTimeText(T0, T1, TZ)).toBe('昨天 19:10');
    expect(awayTimeText(at('2026-11-09T07:03:00'), T1, TZ)).toBe('11月9日 07:03');
    // 前天算「更早」。
    expect(awayTimeText(at('2026-11-15T23:59:00'), T1, TZ)).toBe('11月15日 23:59');
  });

  it('有回合的事一行「用了 n 回合」，仍在等你的事一行（不写「用了」），两类之间有序；末行合计只算有回合的事', () => {
    const summary = buildAwaySummary(input({ jobs: [
      job({ title: '甲', turns: 2, tokens: 50_000, lastTurnAt: T0 + HOUR }),
      job({ title: '乙', turns: 0, tokens: 0, lastTurnAt: null, waitingOwner: true, waitItem: '验收', waitedMs: 3 * HOUR }),
      job({ title: '丙', turns: 0, tokens: 0, lastTurnAt: null, waitingOwner: true, waitItem: '选一个办法', waitedMs: 5 * HOUR }),
      job({ title: '丁', turns: 4, tokens: 70_000, lastTurnAt: T0 + 5 * HOUR }),
    ] }));
    expect(summary.lines).toEqual([
      '你离开的 14 小时里（昨天 19:10 到 今天 09:05）',
      '丁：执行中，在等林舟。用了 4 回合。', // 最近一次动静晚的在前
      '甲：执行中，在等林舟。用了 2 回合。',
      '丙：仍在等你选一个办法。', // 等得久的在前
      '乙：仍在等你验收。',
      '共用 6 回合，约 120K token。没有通知过你。',
    ]);
    expect(summary).toMatchObject({ totalTurns: 6, totalTokens: 120_000 });
  });

  it('没有回合、没有事件、也不在等你的事不进摘要；全部是这样的事时整个只有「这段时间没有变化。」', () => {
    const summary = buildAwaySummary(input({ jobs: [job({ turns: 0, tokens: 0, lastTurnAt: null })] }));
    expect(summary.lines).toEqual(['这段时间没有变化。']);
  });

  it('只有事件没有回合的事（例如你验收）：写「用了 0 回合」', () => {
    const summary = buildAwaySummary(input({ jobs: [job({ turns: 0, tokens: 0, lastTurnAt: null, events: [ev('owner_accepted', T0 + HOUR, 'owner')], stateLabel: '已完成', waitingOn: null })] }));
    expect(summary.lines[1]).toBe('活动报名页：已完成。用了 0 回合。');
  });

  it('通知句：0 次、1 次、3 次', () => {
    const lastLine = (count: number) => buildAwaySummary(input({ sentCount: count, jobs: [job()] })).lines.pop();
    expect(lastLine(0)).toBe('共用 1 回合，约 1K token。没有通知过你。');
    expect(lastLine(1)).toBe('共用 1 回合，约 1K token。通知过你 1 次。');
    expect(lastLine(3)).toBe('共用 1 回合，约 1K token。通知过你 3 次。');
  });
});

describe('6 UiApi 命令接线', () => {
  it('ownerSeen、dismissAwaySummary 经 UiApi：返回结果；总管私聊（api.thread）带 awaySummary，收起后消失', async () => {
    const fix = await jobFix();
    fix.ctx.clock.set(T0);
    expect(await fix.hub.api.ownerSeen()).toEqual({ ok: true, data: { generated: false } });
    fix.ctx.clock.set(T1);
    expect(await fix.hub.api.ownerSeen()).toEqual({ ok: true, data: { generated: true } });
    expect(fix.hub.api.thread(fix.chief.id).awaySummary).toEqual({ lines: ['这段时间没有变化。'], dismissText: '收起' });
    expect('awaySummary' in fix.hub.api.thread(fix.engineer.id)).toBe(false);
    expect(await fix.hub.api.dismissAwaySummary()).toEqual({ ok: true, data: { dismissed: true } });
    expect('awaySummary' in fix.hub.api.thread(fix.chief.id)).toBe(false);
    expect(await fix.hub.api.dismissAwaySummary()).toEqual({ ok: true, data: { dismissed: false } });
  });

  it('activeJobs、weeklyUsage 经 UiApi：总管的在办的事、固定三行的用量表', async () => {
    const { fix } = await sceneA();
    expect(fix.hub.api.activeJobs(fix.chief.id).rows).toHaveLength(3);
    expect(fix.hub.api.weeklyUsage().rows.map(row => row.label)).toEqual(['员工自己发起', '复盘、学习与整理', '你发起的对话']);
  });
});
