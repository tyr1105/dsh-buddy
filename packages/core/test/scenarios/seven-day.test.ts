/** 场景 18 以固定随机种子跑满七天，把事件来源、预算和主动性指标一起验收。 */
import { expect, it } from 'vitest';
import { advance, createSimWorld, metrics } from '../../src/sim/runner.js';
import { isInQuietHours, localDateKey } from '../../src/util/time.js';
import type { PushAudit } from '../../src/outreach/push.js';
import { addGoal, addWatch, assertReasons, botIds, bots, complete, day, hour, minute, startAt } from './fixtures.js';

it('18：三个机器人完整七天，事件可复现且并发、预算、夜间通知和理由始终守界', async () => {
  const began = performance.now();
  const world = await createSimWorld({ bots: bots(3), startAt, seed: 20261105 });
  const dailyPeerCounts = new Map<string, number>();
  const initiated = new Set<string>();
  const runningSamples: number[] = [];
  const injected = { file: 0, http: 0, owner: 0, peer: 0 };
  const deadmanStates = new Map<string, unknown>();
  // 每次视图变化和每次 tick 都采样，捕捉“结束前已交账”阶段的并发占位。
  const sample = () => {
    runningSamples.push(world.store.table('wakes').count(w => w.endedAt === null && w.dispatchedAt !== null));
    for (const alert of world.store.table('alerts').list(a => a.code === 'deadman')) if (!deadmanStates.has(alert.id)) {
      deadmanStates.set(alert.id, { alert, bot: world.store.table('bots').get(alert.botId!),
        queue: world.store.table('queue').list(q => q.botId === alert.botId),
        pending: world.store.table('percepts').list(p => p.botId === alert.botId && p.tier === 'urgent' && !p.consumedByWake),
        appraisals: world.store.log('appraisals').recent(5, a => a.botId === alert.botId) });
    }
  };
  world.hub.subscribe(sample);
  for (const [index, botId] of botIds.entries()) {
    addGoal(world, botId);
    addWatch(world, { botId, kind: 'file', target: `${world.settings.rootDir}/shared/${botId}.txt` });
    addWatch(world, { botId, kind: 'http', target: `https://public.invalid/${botId}`, intervalMs: hour });
    addWatch(world, { botId, kind: 'log', target: `${world.settings.rootDir}/shared/${botId}.log`,
      expectation: { text: '每天应该有一份日志', everyMs: day, byLocalTime: null, weekdays: null, lastSatisfiedAt: null, lastMissedAt: null } });
    world.net.set(`https://public.invalid/${botId}`, { status: 200, text: '初始公开资料', contentType: 'text/plain' });
    await world.fs.writeTextAtomic(`${world.settings.rootDir}/shared/${botId}.txt`, '初始资料');
    world.host.registerBrain(botId, async input => {
      if (input.variant === 'reflection') return complete(input);
      const proposals = [];
      if (!initiated.has(botId)) {
        initiated.add(botId);
        expect(await input.call('hub_agenda_upsert', { kind: 'task', title: `${botId} 自主交叉核对`,
          priority: 3, abandonWhen: '资料源已撤回' })).toMatchObject({ ok: true });
        proposals.push({ title: `${botId} 增加交叉核验`, detail: '用独立公开来源核对结论', value: 0.8, confidence: 0.8 });
      }
      const peerKey = `${localDateKey(world.clock.now(), world.settings.timezone)}:${botId}`;
      const peerCount = dailyPeerCounts.get(peerKey) ?? 0;
      if (peerCount < 2 && world.rng.next() < 0.35) {
        dailyPeerCounts.set(peerKey, peerCount + 1);
        expect(await input.call('hub_send', { to: botIds[(index + 1) % botIds.length], text: `请交叉核对第 ${injected.peer} 份公开证据` })).toMatchObject({ ok: true });
        injected.peer++;
      }
      return complete(input, { outcome: 'progress', summary: '已核对本次资料，保留一个下一步', proposals,
        reply: input.packet.includes('主人对你说') ? '收到，已核对当前资料' : null,
        nextThink: { mode: 'after', afterMinutes: world.clock.now() < startAt + 2 * day ? 90 : 36 * 60,
          reason: '依据资料更新密度，留出足够积累时间后再检查一次' } });
    });
  }
  await advance(world, 7 * day, { beforeTick: async (w, index) => {
    sample();
    // 前两天频繁，后五天只在每天一个随机选择的来源留下新事实。
    const dense = index < 2 * 24 * 60;
    if (index % (dense ? 60 : 24 * 60) !== 0) return;
    const selected = botIds[Math.floor(w.rng.next() * botIds.length)]!;
    const version = `${index}-${Math.floor(w.rng.next() * 1_000_000)}`;
    if (w.rng.next() < 0.6) {
      await w.fs.writeTextAtomic(`${w.settings.rootDir}/shared/${selected}.txt`, `资料版本 ${version}\n${'新增可靠事实\n'.repeat(10)}`);
      injected.file++;
    }
    if (w.rng.next() < 0.7) {
      w.net.set(`https://public.invalid/${selected}`, { status: 200, text: `新版公开资料 ${version}`, contentType: 'text/plain' });
      injected.http++;
    }
    if (index % (12 * 60) === 0) {
      expect(await w.hub.api.sendMessage(selected, `请核对这次变化 ${version}`)).toMatchObject({ ok: true });
      await w.host.settle();
      injected.owner++;
    }
  } });
  sample();
  const report = metrics(world);
  const elapsedMs = performance.now() - began;
  expect(world.clock.now() - startAt).toBe(7 * day);
  expect(Math.max(...runningSamples)).toBeLessThanOrEqual(2);
  expect(world.host.maxRunning).toBeLessThanOrEqual(2);
  for (const bot of report.bots) {
    expect(bot.turns).toBeGreaterThanOrEqual(5);
    expect(bot.turns).toBeLessThanOrEqual(60);
    expect(bot.intervalCv).toBeGreaterThan(0.5);
    expect(bot.selfPacedRatio).toBeGreaterThanOrEqual(0.5);
    expect(bot.selfInitiated).toBeGreaterThanOrEqual(1);
    expect(Object.values(bot.turnsByDay).every(turns => turns <= world.settings.botDailyTurnBudget)).toBe(true);
  }
  // 再独立核对真实计量账本，避免指标函数遗漏回合时掩盖预算超限；主人主动发起按规格豁免。
  const accounted = new Map<string, number>();
  for (const row of world.store.log('ledger').all()) {
    if (row.kind !== 'turn' || (row.wakeId && world.store.table('wakes').get(row.wakeId)?.ownerInitiated)) continue;
    const key = `${row.who}:${localDateKey(row.at, world.settings.timezone)}`;
    accounted.set(key, (accounted.get(key) ?? 0) + 1);
  }
  expect([...accounted.values()].every(turns => turns <= world.settings.botDailyTurnBudget)).toBe(true);
  // 健康宿主不应被中心自己的预算/节奏闸误报掉线，更不能用 retry 绕过这些闸门。
  expect(world.store.table('alerts').list(a => a.code === 'deadman'), JSON.stringify([...deadmanStates.values()])).toEqual([]);
  expect(world.store.table('wakes').list(w => w.reason.kind === 'retry')).toEqual([]);
  expect(world.store.table('wakes').count(w => w.reason.kind === 'next_think')).toBeGreaterThan(0);
  const pushes = world.store.log('audit').all().filter(a => a.action === 'push')
    .map(a => ({ ...JSON.parse(a.detail) as PushAudit, at: a.at })).filter(a => a.result === 'sent');
  const notificationSources = { question: 0, approval: 0, alert: 0, digest: 0 };
  const globalPushes = new Map<string, number>();
  const botPushes = new Map<string, number>();
  for (const notification of world.host.notifications) {
    if (isInQuietHours(notification.at, world.settings.quietHours, world.settings.timezone)) expect(notification.level).toBe('P0');
    // 每一条实际通知必须能追到对应收件箱或日报，不能仅凭时段/数量把误报写进快照。
    if (notification.title.startsWith('团队日报 ')) {
      notificationSources.digest++;
      expect(world.store.log('thread').all().some(m => m.kind === 'digest' && m.text === notification.body)).toBe(true);
      continue;
    }
    const push = pushes.find(p => p.at === notification.at && p.title === notification.title && p.body === notification.body);
    expect(push).toBeDefined();
    const inbox = world.store.table('inbox').list(i => i.subjectKey === push!.subjectKey
      && i.title === notification.title)[0];
    expect(inbox).toBeDefined();
    expect(['question', 'approval', 'alert']).toContain(inbox!.type);
    notificationSources[inbox!.type as 'question' | 'approval' | 'alert']++;
    if (inbox!.type === 'alert') {
      // 告警卡会更新试运行期限；历史通知必须精确匹配当初的线程原件，而非后来的卡片正文。
      expect(world.store.log('thread').all().some(m => m.refId === inbox!.id && m.kind === 'alert' && m.text === notification.body)).toBe(true);
      const alert = world.store.table('alerts').get(inbox!.refId!);
      expect(alert).toBeDefined();
      expect(alert!.code).not.toBe('deadman');
      expect(alert!.level).toBe(notification.level);
      if (inbox!.status === 'open') expect(inbox!.body).toBe(alert!.text);
    } else expect(inbox!.body).toBe(notification.body);
    if (notification.level === 'P0') continue;
    const date = localDateKey(notification.at, world.settings.timezone);
    globalPushes.set(date, (globalPushes.get(date) ?? 0) + 1);
    const botDate = `${date}:${notification.botId}`;
    botPushes.set(botDate, (botPushes.get(botDate) ?? 0) + 1);
  }
  expect([...globalPushes.values()].every(count => count <= world.settings.dailyPushCap)).toBe(true);
  expect([...botPushes.values()].every(count => count <= world.settings.botDailyPushCap)).toBe(true);
  // M10：此固定场景有四轮额度故障；每次恢复后的再发生都必须重新推送，不能被24小时去重吞掉。
  const quotaEpisodes = new Set(world.store.table('alerts').list(a => a.code === 'quota').map(a => a.episodeId ?? a.id));
  expect(quotaEpisodes.size).toBe(4);
  for (const episodeId of quotaEpisodes) {
    const alertIds = new Set(world.store.table('alerts').list(a => (a.episodeId ?? a.id) === episodeId).map(a => a.id));
    const subjects = new Set(world.store.table('inbox').list(i => i.type === 'alert' && i.refId !== null && alertIds.has(i.refId)).map(i => i.subjectKey));
    const episodePushes = pushes.filter(p => subjects.has(p.subjectKey));
    expect(episodePushes).toHaveLength(1);
    expect(episodePushes[0]!.level).toBe('P0');
  }
  expect(notificationSources.digest).toBeGreaterThan(0);
  expect(Object.values(injected).every(count => count > 0)).toBe(true);
  expect(world.host.toolCalls.filter(call => !call.result.ok)).toEqual([]);
  expect(world.store.table('wakes').list(wake => wake.error !== null)).toEqual([]);
  expect(world.store.table('percepts').count(p => p.kind === 'expectation_missed')).toBeGreaterThanOrEqual(3);
  expect(world.store.table('percepts').count(p => p.source === 'file')).toBeGreaterThan(0);
  expect(world.store.table('percepts').count(p => p.source === 'http')).toBeGreaterThan(0);
  expect(world.store.table('percepts').count(p => p.source === 'peer')).toBeGreaterThan(0);
  assertReasons(world);
  const summary = { elapsedDays: report.elapsedMs / day, injected, maxRunning: report.maxRunning,
    bots: report.bots.map(bot => ({ botId: bot.botId, turns: bot.turns,
      intervalCv: Number(bot.intervalCv?.toFixed(4)), selfPacedRatio: Number(bot.selfPacedRatio?.toFixed(4)),
      selfInitiated: bot.selfInitiated, turnsByDay: bot.turnsByDay, reasons: bot.reasons })),
    pushes: report.pushes, notificationSources, reasons: report.reasons };
  expect(summary).toMatchSnapshot();
  expect(elapsedMs).toBeLessThan(15_000);
}, 15_000);
