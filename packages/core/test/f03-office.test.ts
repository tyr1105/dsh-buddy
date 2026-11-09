/**
 * F03 办公室 v0：纯投影与服务层测试。
 * 主人已取消编制：座位就是「每个在岗队友一把椅子」，按上岗先后摆放。
 * 覆盖房间、门口计数、未知状态、性能与截断，并逐项检查 ref 完整性：
 * 每个承载状态的节点都要能指向真实对象，防止办公室被做成装饰。
 */
import { describe, expect, it } from 'vitest';
import type { Bot, InboxItem, WakeLedgerEntry } from '../src/model/index.js';
import { officeLightFor, projectOffice, type ProjectOfficeInput } from '../src/office/index.js';
import { officeView } from '../src/office/service.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';

const NOW = 1_793_808_000_000;

/** 队友工厂：默认在岗、盯着；可用 partial 改状态或 lifecycle。 */
function bot(id: string, name: string, partial: Partial<Bot> = {}): Bot {
  return { ...botFixture, id, name, homeDir: `/hub/bots/${id}`, ...partial };
}

/** 收件箱工厂：默认未关闭、P1 提问。 */
function inbox(id: string, botId: string | null, createdAt: number, partial: Partial<InboxItem> = {}): InboxItem {
  return {
    id, botId, type: 'question', title: `待办 ${id}`, body: '', options: [], defaultOption: null,
    priority: 'P1', status: 'open', answer: null, refId: null, subjectKey: id, pushed: false,
    createdAt, expiresAt: null, answeredAt: null, ...partial,
  };
}

/** 账本工厂：默认已封存、有交账摘要；用 partial 改时间、结果或摘要。 */
function ledger(wakeId: string, botId: string, openedAt: number, partial: Partial<WakeLedgerEntry> = {}): WakeLedgerEntry {
  const suffix = wakeId.replace(/^w_/, '');
  return {
    id: `wl_${suffix}`, wakeId, botId, sessionId: null, variant: 'regular', status: 'committed',
    source: 'live', completeness: 'full', missing: [], openedAt, sealedAt: openedAt + 60_000,
    trigger: {
      kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料有变化', ownerSummary: null,
      ownerInitiated: false, subjectKey: null, queueWaitMs: null, evidenceRefs: [],
    },
    evidence: { items: [] },
    decision: { outcome: 'progress', summary: `产出 ${suffix}`, blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: null },
    actions: { items: [] },
    result: { verification: null, worldChanges: [], refs: [], summary: null },
    steps: 3, tokens: 1000, truncated: false, bytes: 100,
    ...partial,
  };
}

/** 默认空输入：每条用例只写自己关心的字段。 */
function office(partial: Partial<ProjectOfficeInput> = {}): ProjectOfficeInput {
  return {
    now: NOW, bots: [], ledgers: [], artifacts: [], inboxItems: [],
    quotaLight: 'green', openAlerts: 0, sandboxOk: true, truncated: false, ...partial,
  };
}

/** 场景 A 的标准房间：两位在岗（一个等人、一个受阻），一位退役不上座。 */
function scenarioA() {
  const bots = [
    bot('b_0000000001', '小研', { activity: 'waiting_owner' }),
    bot('b_0000000002', '小执', { activity: 'blocked' }),
    bot('b_0000000003', '小退', { lifecycle: 'retired' }),
  ];
  return { bots };
}

describe('F03 场景 A：在岗队友直接摆座', () => {
  it('每个在岗队友一把椅子，按上岗先后排列，退役不上座', () => {
    const { bots } = scenarioA();
    const view = projectOffice(office({ bots }));

    expect(view.asOf).toBe(NOW);
    expect(view.seats.map(seat => seat.title)).toEqual(['小研的座位', '小执的座位']);
    expect(view.seats.map(seat => seat.light)).toEqual(['waiting', 'blocked']);
    // 座位能点回 Bot 详情。
    expect(view.seats[0]!.lightRef).toMatchObject({ botId: 'b_0000000001', activity: 'waiting_owner', ref: 'bot:b_0000000001' });
    expect(view.seats.every(seat => seat.ref === `bot:${seat.botId}`)).toBe(true);
    expect(view.health).toEqual({ quotaLight: 'green', quotaLightLabel: '充足', openAlerts: 0, sandboxOk: true, ok: true });
  });

  it('试岗也算在岗；暂停、隔离、草稿不上座', () => {
    const bots = [
      bot('b_0000000001', '小试', { lifecycle: 'probation' }),
      bot('b_0000000002', '小停', { lifecycle: 'paused' }),
      bot('b_0000000003', '小隔', { lifecycle: 'quarantined' }),
      bot('b_0000000004', '小稿', { lifecycle: 'draft' }),
    ];
    const view = projectOffice(office({ bots }));
    expect(view.seats.map(seat => seat.botId)).toEqual(['b_0000000001']);
  });
});

describe('F03 场景 C：门口计数与列表同源', () => {
  it('座位门口只数该队友未关闭项，团队级进总信箱，数字与列表一致', () => {
    const { bots } = scenarioA();
    const items = [
      inbox('i_0000000001', 'b_0000000001', NOW - 10_000),
      inbox('i_0000000002', 'b_0000000001', NOW - 30_000),
      inbox('i_0000000003', 'b_0000000001', NOW - 20_000),
      inbox('i_0000000004', null, NOW - 5_000),
      inbox('i_0000000005', null, NOW - 15_000),
      // 已处理的项不能再出现在门口。
      inbox('i_0000000006', 'b_0000000001', NOW - 1_000, { status: 'answered' }),
      inbox('i_0000000007', null, NOW - 2_000, { status: 'expired' }),
    ];
    const view = projectOffice(office({ bots, inboxItems: items }));
    const seat = view.seats[0]!;

    expect(seat.door.count).toBe(3);
    expect(seat.door.inboxIds).toEqual(['i_0000000001', 'i_0000000003', 'i_0000000002']);
    expect(seat.door.refs).toEqual(['inbox:i_0000000001', 'inbox:i_0000000003', 'inbox:i_0000000002']);
    // F04：门口逐条带标题与类型，房间内直接显示具体是哪件事。
    expect(seat.door.items.map(item => item.inboxId)).toEqual(['i_0000000001', 'i_0000000003', 'i_0000000002']);
    expect(seat.door.items[0]).toEqual({
      inboxId: 'i_0000000001', type: 'question', title: '待办 i_0000000001', ref: 'inbox:i_0000000001',
    });
    expect(view.doorway.count).toBe(2);
    expect(view.doorway.items.map(item => item.inboxId)).toEqual(['i_0000000004', 'i_0000000005']);
    expect(view.doorway.refs).toEqual(['inbox:i_0000000004', 'inbox:i_0000000005']);
    expect(view.doorway.ref).toBe('inbox');
    // 另一个座位没有自己的门口。
    expect(view.seats[1]!.door.count).toBe(0);
  });
});

describe('F03 场景 E：数据缺失或矛盾一律 unknown', () => {
  it.each([
    ['thinking', 'working'], ['catching_up', 'working'], ['queued', 'queued'],
    ['waiting_owner', 'waiting'], ['waiting_peer', 'waiting'], ['blocked', 'blocked'],
    ['resting', 'resting'], ['reflecting', 'resting'], ['watching', 'watching'],
  ] as const)('activity=%s 映射为灯 %s', (activity, light) => {
    expect(officeLightFor(bot('b_0000000001', '小研', { activity }))).toBe(light);
  });

  it('未映射的活动值显示 unknown，卡片不猜成在跑', () => {
    // 旧档或手改档可能出现词表外的值；这里按运行时数据模拟，不通过类型检查器。
    const weird = { ...bot('b_0000000001', '小研'), activity: 'flying' } as unknown as Bot;
    expect(officeLightFor(weird)).toBe('unknown');
    const view = projectOffice(office({ bots: [weird] }));
    expect(view.seats[0]!.light).toBe('unknown');
    expect(view.seats[0]!.occupant.activity).toBeNull();
    expect(view.seats[0]!.occupant.activityLabel).toBeNull();
  });

  it('暂停/隔离/退役显示 offline；没有队友时没有座位', () => {
    for (const lifecycle of ['paused', 'quarantined', 'retired'] as const) {
      expect(officeLightFor(bot('b_0000000001', '小研', { lifecycle }))).toBe('offline');
    }
    expect(officeLightFor(null)).toBe('vacant');
    expect(projectOffice(office()).seats).toEqual([]);
  });
});

describe('F03 桌上的产出', () => {
  it('取最近一条有产出的已封存账本：交账摘要优先，其次第一条世界变化', () => {
    const { bots } = scenarioA();
    const ledgers = [
      // 更早的一条有摘要。
      ledger('w_0000000001', 'b_0000000001', NOW - 300_000),
      // 最新一条只有世界变化。
      ledger('w_0000000002', 'b_0000000001', NOW - 200_000, {
        decision: null,
        result: {
          verification: null, refs: [], summary: null,
          worldChanges: [{ what: '更新了竞品清单', whoCanSee: 'owner', where: '/hub/reports' }],
        },
      }),
      // 最新但没有任何产出：跳过，不能让空摘要盖掉真实产出。
      ledger('w_0000000003', 'b_0000000001', NOW - 100_000, { decision: { outcome: 'no_change', summary: '', blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: null } }),
      // 未封存的账本不算产出。
      ledger('w_0000000004', 'b_0000000001', NOW - 50_000, { sealedAt: null, decision: { outcome: 'progress', summary: '还没封存', blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: null } }),
    ];
    const view = projectOffice(office({ bots, ledgers }));
    const desk = view.seats[0]!.desk;

    expect(desk).toMatchObject({ kind: 'wake_output', kindLabel: '本次产出（自述）', title: '更新了竞品清单', ref: 'wake:w_0000000002', refKind: 'wake', refId: 'w_0000000002' });
    // 没有产出的座位如实说空，但仍指向队友本身，界面不会把它当账本下钻。
    expect(view.seats[1]!.desk).toMatchObject({ kind: 'none', title: null, ref: 'bot:b_0000000002', refKind: 'bot' });
  });
});

describe('F03 ref 完整性：非装饰节点都能指向真实对象', () => {
  it('座位、灯、桌子、门口 ref 均非空且指向存在的记录', () => {
    const { bots } = scenarioA();
    const ledgers = [ledger('w_0000000001', 'b_0000000001', NOW - 100_000)];
    const items = [inbox('i_0000000001', 'b_0000000001', NOW - 10_000), inbox('i_0000000002', null, NOW - 5_000)];
    const view = projectOffice(office({ bots, ledgers, inboxItems: items }));
    const botIds = new Set(bots.map(item => item.id));
    const wakeIds = new Set(ledgers.map(item => item.wakeId));
    const inboxIds = new Set(items.map(item => item.id));

    for (const seat of view.seats) {
      expect(seat.ref).toBe(`bot:${seat.botId}`);
      expect(botIds.has(seat.botId)).toBe(true);
      expect(seat.desk.ref.length).toBeGreaterThan(0);
      if (seat.desk.refKind === 'wake') expect(wakeIds.has(seat.desk.refId)).toBe(true);
      if (seat.desk.refKind === 'bot') expect(botIds.has(seat.desk.refId)).toBe(true);
      expect(botIds.has(seat.lightRef.botId)).toBe(true);
      expect(seat.lightRef.ref).toBe(`bot:${seat.lightRef.botId}`);
      for (const ref of seat.door.refs) {
        expect(ref.startsWith('inbox:')).toBe(true);
        expect(inboxIds.has(ref.slice('inbox:'.length))).toBe(true);
      }
      // F04：逐条列出的门口项同样必须指回真实收件箱，不能出现悬空标题。
      for (const item of seat.door.items) {
        expect(item.ref).toBe(`inbox:${item.inboxId}`);
        expect(inboxIds.has(item.inboxId)).toBe(true);
      }
    }
    for (const item of view.doorway.items) expect(inboxIds.has(item.inboxId)).toBe(true);
    expect(view.doorway.ref).toBe('inbox');
  });
});

describe('F03 场景 G：性能与截断', () => {
  it('6 位队友 200 条账本的投影中位数低于 5 毫秒', () => {
    const bots = Array.from({ length: 6 }, (_, index) => bot(
      `b_00000000${String(index + 1).padStart(2, '0')}`, `队友 ${index + 1}`,
      { activity: index % 2 === 0 ? 'thinking' : 'watching' },
    ));
    const ledgers = Array.from({ length: 200 }, (_, index) => ledger(
      `w_${String(index + 1).padStart(10, '0')}`, bots[index % bots.length]!.id, NOW - index * 1_000,
    ));
    const input = office({ bots, ledgers });

    const durations: number[] = [];
    for (let run = 0; run < 8; run += 1) {
      const started = performance.now();
      projectOffice(input);
      if (run >= 2) durations.push(performance.now() - started); // 前两次热身，不纳入统计
    }
    durations.sort((a, b) => a - b);
    expect(durations[Math.floor(durations.length / 2)]!).toBeLessThan(5);
  });

  it('截断标记原样透出，界面据此提示只看了最近一段', () => {
    const view = projectOffice(office({ truncated: true }));
    expect(view.truncated).toBe(true);
  });
});

describe('F03 服务层：从存储读出一屏房间', () => {
  it('读队友、账本、收件箱与健康数据，asOf 用注入时钟', () => {
    const ctx = createTestContext();
    const { bots } = scenarioA();
    for (const row of bots) ctx.store.table('bots').put(row);
    ctx.store.table('wakeLedger').put(ledger('w_0000000001', 'b_0000000001', NOW - 100_000));
    ctx.store.table('inbox').put(inbox('i_0000000001', 'b_0000000001', NOW - 10_000));
    ctx.store.table('inbox').put(inbox('i_0000000002', null, NOW - 5_000));
    ctx.store.table('alerts').put({
      id: 'al_0000000001', botId: null, code: 'network', text: '网络失败', level: 'P2',
      count: 1, firstAt: NOW, lastAt: NOW, status: 'open',
    });
    ctx.runtime.sandboxUnavailable = '沙箱不可用';

    const view = officeView(ctx);
    expect(view.asOf).toBe(ctx.clock.now());
    expect(view.seats.map(seat => seat.botId)).toEqual(['b_0000000001', 'b_0000000002']);
    expect(view.seats[0]!.desk.title).toBe('产出 0000000001');
    expect(view.seats[0]!.door.count).toBe(1);
    expect(view.doorway.count).toBe(1);
    expect(view.health).toMatchObject({ quotaLight: 'green', openAlerts: 1, sandboxOk: false, ok: false });
    expect(view.truncated).toBe(false);
  });

  it('账本超过上限时只读最近 200 条并标记 truncated', () => {
    const ctx = createTestContext();
    const bots = [bot('b_0000000001', '小研')];
    ctx.store.table('bots').put(bots[0]!);
    for (let index = 0; index < 205; index += 1) {
      ctx.store.table('wakeLedger').put(ledger(`w_${String(index + 1).padStart(10, '0')}`, 'b_0000000001', NOW + index));
    }
    const view = officeView(ctx);
    expect(view.truncated).toBe(true);
    // 最近的账本在桌上（服务层按 openedAt 倒序截断后再投影）。
    expect(view.seats[0]!.desk.refId).toBe('w_0000000205');
  });
});
