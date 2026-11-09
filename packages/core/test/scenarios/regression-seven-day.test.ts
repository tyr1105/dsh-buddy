/**
 * E05 回归与七天仿真：用固定种子跑到七天，检查行为没有退化。
 *
 * 为什么单独成文件：
 * - 场景 18 关注三个机器人一起跑时的预算、并发与推送；这里补一条更小的「回归闸门」，
 *   一次只跑一个机器人，但把最近几期新增的账本、办公室投影和收件箱放在同一条时间线上交叉核对。
 * - 只断言事实与不变量，不做精确到每条日志的断言；精确行为变化用快照呈现，
 *   这样正常的文案调整不会随便失败，真正的节奏/数量退化会立刻在快照差异里暴露。
 * - 同一份世界构建函数也用于「同种子重放」测试，保证七天的结论不是偶然。
 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld, metrics, type SimWorld } from '../../src/sim/runner.js';
import type { Brain, BrainInput } from '../../src/sim/sim-host.js';
import { isInQuietHours, localDateKey } from '../../src/util/time.js';
import { addGoal, addWatch, assertReasons, bots, complete, day, hour, minute, startAt } from './fixtures.js';

const botId = 'b_0000000001';
const seed = 20261107;

/** 每次跑七天都用同一个大脑：奇数轮按时间再想，偶数轮等事件，第一轮留一条提议。 */
function regressionBrain(): Brain {
  let turns = 0;
  return async (input: BrainInput) => {
    turns += 1;
    if (input.variant === 'reflection') return complete(input);
    return complete(input, {
      outcome: 'progress',
      summary: `第 ${turns} 次核对完成`,
      worldChanges: [{ what: '更新核对记录', whoCanSee: 'owner', where: 'work/notes.md' }],
      nextThink: turns % 4 === 0
        ? { mode: 'auto', reason: '等下一次资料变化' }
        : { mode: 'after', afterMinutes: 8 * 60, reason: '八小时后再核对一次资料变化' },
      proposals: turns === 1
        ? [{ title: '增加交叉核验', detail: '用独立公开来源核对结论', value: 0.8, confidence: 0.8 }]
        : [],
    });
  };
}

/** 构建回归世界：一个机器人、一个文件关注项、一个目标，以及固定节奏的世界变化。 */
async function buildWorld(): Promise<SimWorld> {
  const world = await createSimWorld({ bots: bots(1), startAt, seed });
  addGoal(world, botId);
  addWatch(world, { botId, kind: 'file', target: `${world.settings.rootDir}/shared/${botId}.txt` });
  world.host.registerBrain(botId, regressionBrain());
  return world;
}

/** 在固定时刻注入变化：每 12 小时换一次资料，第二天中午让主人直聊一次。 */
async function inject(world: SimWorld, index: number): Promise<void> {
  if (index % (12 * 60) === 0) {
    await world.fs.writeTextAtomic(
      `${world.settings.rootDir}/shared/${botId}.txt`,
      `资料版本 ${index / (12 * 60)}\n${'新增可靠事实\n'.repeat(10)}`,
    );
  }
  if (index === 24 * 60) {
    expect(await world.hub.api.sendMessage(botId, '请核对第二天中午这次变化')).toMatchObject({ ok: true });
    await world.host.settle();
  }
}

/** 把键值对压成稳定顺序的普通对象，快照里不会因为表遍历顺序变化而漂移。 */
function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of [...values].sort()) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/** 七天跑完后的行为指纹；只保留可读、可对比的摘要。 */
function fingerprint(world: SimWorld) {
  const report = metrics(world);
  const bot = report.bots[0]!;
  const ledgers = world.store.table('wakeLedger').list();
  const wakes = world.store.table('wakes').list();
  return {
    days: report.elapsedMs / day,
    turns: bot.turns,
    turnsByDay: bot.turnsByDay,
    intervalCv: bot.intervalCv === null ? null : Number(bot.intervalCv.toFixed(4)),
    selfPacedRatio: bot.selfPacedRatio === null ? null : Number(bot.selfPacedRatio.toFixed(4)),
    selfInitiated: bot.selfInitiated,
    reasons: bot.reasons,
    pushes: report.pushes,
    notifications: report.notifications,
    digests: report.digests,
    maxRunning: report.maxRunning,
    wakes: {
      total: wakes.length,
      error: wakes.filter(wake => wake.status === 'error').length,
      retry: wakes.filter(wake => wake.reason.kind === 'retry').length,
      ownerInitiated: wakes.filter(wake => wake.ownerInitiated).length,
    },
    ledger: {
      total: ledgers.length,
      complete: ledgers.filter(entry => entry.completeness === 'full').length,
      partial: ledgers.filter(entry => entry.completeness === 'partial').length,
      actions: counts(ledgers.flatMap(entry => entry.actions.items.map(action => action.kind))),
    },
    inbox: counts(world.store.table('inbox').list().map(item => `${item.type}/${item.status}`)),
    alerts: counts(world.store.table('alerts').list().map(alert => alert.code)),
  };
}

describe('E05 回归与七天仿真', () => {
  it('七天行为指纹稳定，账本、办公室与收件箱始终对得上', async () => {
    const began = performance.now();
    const world = await buildWorld();
    await advance(world, 7 * day, { beforeTick: async (current, index) => { await inject(current, index); } });
    const report = metrics(world);
    const bot = report.bots[0]!;
    const elapsedMs = performance.now() - began;

    // 节奏与预算：能醒、醒得不多、不靠固定钟点。
    expect(world.clock.now() - startAt).toBe(7 * day);
    expect(bot.turns).toBeGreaterThanOrEqual(7);
    expect(bot.turns).toBeLessThanOrEqual(7 * world.settings.botDailyTurnBudget);
    expect(Object.values(bot.turnsByDay).every(turns => turns <= world.settings.botDailyTurnBudget)).toBe(true);
    expect(bot.intervalCv).toBeGreaterThan(0.3);
    expect(bot.selfPacedRatio).toBeGreaterThanOrEqual(0.5);
    expect(bot.selfInitiated).toBeGreaterThanOrEqual(1);
    expect(report.maxRunning).toBeLessThanOrEqual(2);

    // 健康宿主不应出现掉线、重试或用错误回合硬撑。
    expect(world.store.table('alerts').list(alert => alert.code === 'deadman')).toEqual([]);
    expect(world.store.table('wakes').list(wake => wake.reason.kind === 'retry')).toEqual([]);
    expect(world.store.table('wakes').list(wake => wake.error !== null)).toEqual([]);
    expect(world.host.toolCalls.filter(call => !call.result.ok)).toEqual([]);
    for (const notification of world.host.notifications) {
      if (isInQuietHours(notification.at, world.settings.quietHours, world.settings.timezone)) {
        expect(notification.level).toBe('P0');
      }
    }
    assertReasons(world);

    // 账本：每条真实投递的唤醒都有且只有一份实时账本，封存后动作与触发理由齐全。
    const wakes = world.store.table('wakes').list(wake => wake.dispatchedAt !== null);
    const ledgers = world.store.table('wakeLedger').list();
    expect(ledgers).toHaveLength(wakes.length);
    expect(new Set(ledgers.map(entry => entry.wakeId)).size).toBe(ledgers.length);
    for (const entry of ledgers) {
      const wake = world.store.table('wakes').get(entry.wakeId);
      expect(wake).toBeDefined();
      expect(entry.botId).toBe(wake!.botId);
      expect(entry.source).toBe('live');
      expect(entry.sealedAt).not.toBeNull();
      expect(entry.trigger.summary.trim().length).toBeGreaterThan(0);
      expect(entry.decision).not.toBeNull();
      expect(entry.actions.items.length).toBeGreaterThan(0);
      for (const action of entry.actions.items) expect(action.name.trim().length).toBeGreaterThan(0);
    }

    // 只读视图必须直接返回视图对象，不能被命令包装成 {ok,data}；否则界面会读到 undefined。
    expect(world.hub.api.projectView().counts).toBeDefined();
    expect(Array.isArray(world.hub.api.resourceView().resources)).toBe(true);

    // 办公室投影：座位、门口、总信箱与健康数字都必须来自同一份未关闭收件箱事实。
    const office = world.hub.api.officeView();
    expect(office.seats).toHaveLength(1);
    const seat = office.seats[0]!;
    expect(seat.occupant.botId).toBe(botId);
    const openInbox = world.store.table('inbox').list(item => item.status === 'open');
    const ownInbox = openInbox.filter(item => item.botId === botId).sort((a, b) => b.createdAt - a.createdAt);
    expect(seat.door.count).toBe(ownInbox.length);
    expect(seat.door.items.map(item => item.inboxId)).toEqual(ownInbox.map(item => item.id));
    const teamInbox = openInbox.filter(item => item.botId === null).sort((a, b) => b.createdAt - a.createdAt);
    expect(office.doorway.count).toBe(teamInbox.length);
    expect(office.doorway.items.map(item => item.inboxId)).toEqual(teamInbox.map(item => item.id));
    expect(office.health.openAlerts).toBe(world.store.table('alerts').count(alert => alert.status === 'open'));
    const deskEntry = [...ledgers]
      .sort((a, b) => b.openedAt - a.openedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .find(entry => entry.sealedAt !== null && (entry.decision?.summary?.trim() || entry.result.worldChanges[0]?.what?.trim()));
    if (deskEntry) {
      expect(seat.desk.refKind).toBe('wake');
      expect(seat.desk.refId).toBe(deskEntry.wakeId);
      expect(seat.desk.title).toBe(deskEntry.decision?.summary?.trim() || deskEntry.result.worldChanges[0]?.what?.trim());
    } else {
      expect(seat.desk.kind).toBe('none');
    }

    // 快照只锁行为指纹；真正的文案/结构变化会在 diff 里逐项出现。
    expect(fingerprint(world)).toMatchSnapshot();
    expect(elapsedMs).toBeLessThan(15_000);
  }, 15_000);

  it('同一随机种子重复两天，账本与审计记录完全一致', async () => {
    async function run(): Promise<SimWorld> {
      const world = await buildWorld();
      await advance(world, 2 * day, { beforeTick: async (current, index) => { await inject(current, index); } });
      return world;
    }
    const first = await run();
    const second = await run();
    expect(fingerprint(first)).toEqual(fingerprint(second));
    expect(first.store.log('audit').all()).toEqual(second.store.log('audit').all());
    expect(first.store.table('wakeLedger').list()).toEqual(second.store.table('wakeLedger').list());
  }, 15_000);
});
