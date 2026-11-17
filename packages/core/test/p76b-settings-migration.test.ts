/**
 * P76b 的测试三：启动时的一次性设置迁移（旧默认值换新默认值，主人改过的保留）。
 * 覆盖：
 * 4 纯函数 migrateSettingsP76：botDailyTurnBudget 为 6 换成 2、为 4 不变、为 12 收到 10；
 *   owner.tokens 为 80000 换成 300000、为 90000 不变；输入 undefined 或不是对象时原样；输入对象不被修改；被取消的字段不动；
 * 5 runSettingsMigrationP76：新装只写迁移行；有旧设置时写回、记审计、迁移行 done；第二次启动不再改；
 *   校验不过时不写、迁移行 failed、下次重试成功；宿主传入的设置优先；
 * 6 接线：真实 Hub 启动时跑迁移（旧设置被换、迁移行 done、对外读到的设置是迁移后的；宿主传入值优先；第二次启动不再改）。
 * 假时钟：除接线用例里 Hub 自己的启动流程外不推进。
 */
import { describe, expect, it } from 'vitest';
import { BUDGET_DEFAULTS, resolveSettings } from '../src/config/defaults.js';
import { migrateSettingsP76, P76_MIGRATION_ID, runSettingsMigrationP76 } from '../src/config/settings-migration.js';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { MemoryLogger } from '../src/io/testing/index.js';

/** 旧版本存下来的设置：每日自主回合 6、你发起的回合 token 线 8 万（两个旧默认值），patch 改其他项。 */
function legacySettings(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const base = resolveSettings({ rootDir: '/hub' });
  return {
    ...base, botDailyTurnBudget: 6,
    turnLimitsByVariant: { ...base.turnLimitsByVariant, owner: { ...base.turnLimitsByVariant.owner, tokens: 80_000 } },
    ...patch,
  };
}
const ownerTokens = (settings: unknown) => (settings as { turnLimitsByVariant: { owner: { tokens: number } } }).turnLimitsByVariant.owner.tokens;
const budgetOf = (settings: unknown) => (settings as { botDailyTurnBudget: number }).botDailyTurnBudget;

describe('4 纯函数 migrateSettingsP76', () => {
  it('botDailyTurnBudget 为 6（旧默认值）：换成 2，记一条', () => {
    const { next, changed } = migrateSettingsP76(legacySettings({ turnLimitsByVariant: resolveSettings().turnLimitsByVariant }));
    expect(budgetOf(next)).toBe(2);
    expect(changed).toEqual([{ path: 'botDailyTurnBudget', from: 6, to: 2 }]);
  });
  it('botDailyTurnBudget 为 4（主人改过）：不变，不记', () => {
    const { next, changed } = migrateSettingsP76(legacySettings({ botDailyTurnBudget: 4, turnLimitsByVariant: resolveSettings().turnLimitsByVariant }));
    expect(budgetOf(next)).toBe(4);
    expect(changed).toEqual([]);
  });
  it('botDailyTurnBudget 为 12（大于界面上限）：收到 10，记一条；恰好 10 不变', () => {
    const turnLimitsByVariant = resolveSettings().turnLimitsByVariant;
    const high = migrateSettingsP76(legacySettings({ botDailyTurnBudget: 12, turnLimitsByVariant }));
    expect(budgetOf(high.next)).toBe(BUDGET_DEFAULTS.SELF_WORK_UI_MAX);
    expect(high.changed).toEqual([{ path: 'botDailyTurnBudget', from: 12, to: 10 }]);
    const edge = migrateSettingsP76(legacySettings({ botDailyTurnBudget: 10, turnLimitsByVariant }));
    expect(budgetOf(edge.next)).toBe(10);
    expect(edge.changed).toEqual([]);
  });
  it('owner.tokens 为 80000（旧默认值）：换成 300000；为 90000（主人改过）：不变', () => {
    const old = migrateSettingsP76(legacySettings({ botDailyTurnBudget: 4 }));
    expect(ownerTokens(old.next)).toBe(300_000);
    expect(old.changed).toEqual([{ path: 'turnLimitsByVariant.owner.tokens', from: 80_000, to: 300_000 }]);
    const base = resolveSettings();
    const custom = migrateSettingsP76(legacySettings({
      botDailyTurnBudget: 4, turnLimitsByVariant: { ...base.turnLimitsByVariant, owner: { ...base.turnLimitsByVariant.owner, tokens: 90_000 } },
    }));
    expect(ownerTokens(custom.next)).toBe(90_000);
    expect(custom.changed).toEqual([]);
  });
  it('两项都是旧默认值：两项都换，各记一条', () => {
    const { next, changed } = migrateSettingsP76(legacySettings());
    expect(budgetOf(next)).toBe(2);
    expect(ownerTokens(next)).toBe(300_000);
    expect(changed.map(item => item.path)).toEqual(['botDailyTurnBudget', 'turnLimitsByVariant.owner.tokens']);
  });
  it('只有部分字段的旧设置（路径中间缺了）：不报错，缺的不补', () => {
    expect(migrateSettingsP76({ id: 'settings', botDailyTurnBudget: 6 })).toEqual({ next: { id: 'settings', botDailyTurnBudget: 2 }, changed: [{ path: 'botDailyTurnBudget', from: 6, to: 2 }] });
    expect(migrateSettingsP76({ id: 'settings', turnLimitsByVariant: { regular: {} } }).changed).toEqual([]);
    expect(migrateSettingsP76({ id: 'settings', turnLimitsByVariant: null }).changed).toEqual([]);
  });
  it('输入 undefined、null、数组、文字：原样返回，changed 为空', () => {
    expect(migrateSettingsP76(undefined)).toEqual({ next: undefined, changed: [] });
    expect(migrateSettingsP76(null)).toEqual({ next: null, changed: [] });
    expect(migrateSettingsP76('settings')).toEqual({ next: 'settings', changed: [] });
    const list = [{ botDailyTurnBudget: 6 }];
    const result = migrateSettingsP76(list);
    expect(result.next).toBe(list);
    expect(result.changed).toEqual([]);
  });
  it('输入对象不被修改（返回的是拷贝）', () => {
    const input = legacySettings();
    const snapshot = structuredClone(input);
    const { next } = migrateSettingsP76(input);
    expect(input).toEqual(snapshot);
    expect(next).not.toBe(input);
    expect(budgetOf(input)).toBe(6);
  });
  it('被取消的字段（日报时间、推送条数、每日 token、每窗口回合、试岗倍率、每日思考上限）值不动', () => {
    const input = legacySettings({ digestAt: '09:15', dailyPushCap: 5, botDailyPushCap: 4, botDailyTokenBudget: 123_456, botWindowTurnBudget: 7, probationBudgetMultiplier: 0.8 });
    const { next } = migrateSettingsP76(input);
    expect(next).toMatchObject({ digestAt: '09:15', dailyPushCap: 5, botDailyPushCap: 4, botDailyTokenBudget: 123_456, botWindowTurnBudget: 7, probationBudgetMultiplier: 0.8 });
  });
});

describe('5 runSettingsMigrationP76', () => {
  function setup(persisted?: Record<string, unknown>) {
    const ctx = createTestContext();
    if (persisted) ctx.store.table('settings').put(persisted as never);
    return ctx;
  }
  const readRow = (ctx: ReturnType<typeof setup>) => ctx.store.table('settings').get('settings') as unknown as Record<string, unknown> | null;
  const audits = (ctx: ReturnType<typeof setup>) => ctx.store.log('audit').all().filter(row => row.action === 'settings_migrated_p76');
  const migrationRow = (ctx: ReturnType<typeof setup>) => ctx.store.table('migrations').get(P76_MIGRATION_ID);

  it('新装（存储里没有设置）：只写迁移行 done，不写设置、不记审计、ctx.settings 不变', async () => {
    const ctx = setup();
    const before = structuredClone(ctx.settings);
    await runSettingsMigrationP76(ctx, undefined);
    expect(migrationRow(ctx)).toMatchObject({ id: 'p76-settings', state: 'done', attempts: 1, written: {}, steps: {}, error: null });
    expect(ctx.store.table('settings').count()).toBe(0);
    expect(audits(ctx)).toHaveLength(0);
    expect(ctx.settings).toEqual(before);
  });

  it('有旧设置：写回设置表、记审计（detail 为换掉的两项）、迁移行 done、ctx.settings 同步为迁移后的值', async () => {
    const persisted = legacySettings();
    const ctx = setup(persisted);
    await runSettingsMigrationP76(ctx, persisted);
    expect(budgetOf(readRow(ctx))).toBe(2);
    expect(ownerTokens(readRow(ctx))).toBe(300_000);
    expect(ctx.settings.botDailyTurnBudget).toBe(2);
    expect(ctx.settings.turnLimitsByVariant.owner.tokens).toBe(300_000);
    expect(migrationRow(ctx)).toMatchObject({ state: 'done', attempts: 1, written: {}, steps: {}, error: null });
    expect(audits(ctx)).toHaveLength(1);
    expect(JSON.parse(audits(ctx)[0]!.detail)).toEqual([
      { path: 'botDailyTurnBudget', from: 6, to: 2 },
      { path: 'turnLimitsByVariant.owner.tokens', from: 80_000, to: 300_000 },
    ]);
  });

  it('有设置但没有要换的（主人都改过）：设置表不动、不记审计，迁移行 done', async () => {
    const base = resolveSettings({ rootDir: '/hub' });
    const persisted = { ...base, botDailyTurnBudget: 4 };
    const ctx = setup(persisted);
    await runSettingsMigrationP76(ctx, persisted);
    expect(readRow(ctx)).toEqual(persisted);
    expect(audits(ctx)).toHaveLength(0);
    expect(migrationRow(ctx)).toMatchObject({ state: 'done', attempts: 1 });
  });

  it('第二次启动不再改：迁移后主人把值改回 6，再启动，仍是 6，没有新审计，尝试次数不变', async () => {
    const persisted = legacySettings();
    const ctx = setup(persisted);
    await runSettingsMigrationP76(ctx, persisted);
    expect(budgetOf(readRow(ctx))).toBe(2);
    // 主人在设置页把它改回 6（整份设置写回）。
    ctx.store.table('settings').put({ ...readRow(ctx)!, botDailyTurnBudget: 6 } as never);
    await runSettingsMigrationP76(ctx, readRow(ctx));
    expect(budgetOf(readRow(ctx))).toBe(6);
    expect(audits(ctx)).toHaveLength(1);
    expect(migrationRow(ctx)).toMatchObject({ state: 'done', attempts: 1 });
  });

  it('迁移后的对象校验不过：不写设置、迁移行 failed 且写明原因、记日志、没有审计；修好后下次启动重试并完成', async () => {
    // 旧设置里另有一项本来就不合格（heartbeatPid 写成文字）：整份迁移后仍读不出，不能写进去。
    const broken = legacySettings({ heartbeatPid: 'abc' });
    const ctx = setup(broken);
    await runSettingsMigrationP76(ctx, broken);
    expect(budgetOf(readRow(ctx))).toBe(6);
    expect(ownerTokens(readRow(ctx))).toBe(80_000);
    expect(ctx.settings.botDailyTurnBudget).toBe(2);
    const failed = migrationRow(ctx)!;
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(1);
    expect(failed.error).toContain('heartbeatPid');
    expect(audits(ctx)).toHaveLength(0);
    expect((ctx.logger as MemoryLogger).lines.some(line => line.level === 'warn' && line.message.includes('P76 设置迁移'))).toBe(true);
    // 下次启动：设置修好了，重试成功。
    const fixed = legacySettings();
    ctx.store.table('settings').put(fixed as never);
    await runSettingsMigrationP76(ctx, fixed);
    expect(budgetOf(readRow(ctx))).toBe(2);
    expect(migrationRow(ctx)).toMatchObject({ state: 'done', attempts: 2, error: null });
    expect(audits(ctx)).toHaveLength(1);
  });

  it('宿主传入 botDailyTurnBudget: 6：存档被迁移成 2，但 ctx.settings 仍为 6（宿主优先）；没传宿主设置时为 2', async () => {
    const persisted = legacySettings();
    const withHost = setup(persisted);
    await runSettingsMigrationP76(withHost, persisted, { botDailyTurnBudget: 6 });
    expect(budgetOf(readRow(withHost))).toBe(2);
    expect(withHost.settings.botDailyTurnBudget).toBe(6);
    const withoutHost = setup(persisted);
    await runSettingsMigrationP76(withoutHost, persisted);
    expect(withoutHost.settings.botDailyTurnBudget).toBe(2);
  });
});

describe('6 接线：真实 Hub 启动时跑迁移', () => {
  /** 用测试环境的各个部件建 Hub；不传 settings（宿主设置由用例自己给），不做员工整理和组队三问（与迁移无关）。 */
  function buildHub(ctx: ReturnType<typeof createTestContext>, host?: Record<string, unknown>) {
    const { settings: _s, runtime: _r, emit: _e, ...deps } = ctx;
    return createHub({ ...deps, ...(host ? { settings: host } : {}), normalizeStaffOnStart: false, teamSetupOnStart: false } as never);
  }

  it('旧设置启动后被换成新默认值：存档、迁移行、审计、对外读到的设置都对；停止后再启动不再改', async () => {
    const ctx = createTestContext();
    ctx.store.table('settings').put(legacySettings() as never);
    const hub = buildHub(ctx);
    await hub.start();
    const row = ctx.store.table('settings').get('settings') as unknown as Record<string, unknown>;
    expect(budgetOf(row)).toBe(2);
    expect(ownerTokens(row)).toBe(300_000);
    expect(ctx.store.table('migrations').get(P76_MIGRATION_ID)).toMatchObject({ state: 'done' });
    expect(ctx.store.log('audit').all().filter(item => item.action === 'settings_migrated_p76')).toHaveLength(1);
    expect((await hub.api.settings()).settings.botDailyTurnBudget).toBe(2);
    await hub.stop();
    // 主人改回 6 后再启动：保持 6。
    ctx.store.table('settings').put({ ...row, botDailyTurnBudget: 6 } as never);
    const again = buildHub(ctx);
    await again.start();
    expect(budgetOf(ctx.store.table('settings').get('settings'))).toBe(6);
    expect((await again.api.settings()).settings.botDailyTurnBudget).toBe(6);
    await again.stop();
  });

  it('新装启动：只写迁移行，设置表保持没有；对外读到新默认值 2', async () => {
    const ctx = createTestContext();
    // 新装没有存档设置，根目录由宿主给（内存文件系统要求绝对路径）；它不影响本卡的两项。
    const hub = buildHub(ctx, { rootDir: '/hub' });
    await hub.start();
    expect(ctx.store.table('migrations').get(P76_MIGRATION_ID)).toMatchObject({ state: 'done', attempts: 1 });
    expect(ctx.store.log('audit').all().filter(item => item.action === 'settings_migrated_p76')).toHaveLength(0);
    expect((await hub.api.settings()).settings.botDailyTurnBudget).toBe(2);
    await hub.stop();
  });

  it('宿主传入 botDailyTurnBudget: 6：存档被迁移成 2，对外读到的仍是 6', async () => {
    const ctx = createTestContext();
    ctx.store.table('settings').put(legacySettings() as never);
    const hub = buildHub(ctx, { botDailyTurnBudget: 6 });
    await hub.start();
    expect(budgetOf(ctx.store.table('settings').get('settings'))).toBe(2);
    expect((await hub.api.settings()).settings.botDailyTurnBudget).toBe(6);
    await hub.stop();
  });
});
