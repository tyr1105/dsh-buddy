/** 设置与默认数值测试：检查深合并、非法配置、各角色节奏和试岗预算，不启动引擎。 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS, botBudgetFor, dailyThinkCapFor, paceMaxMsFor, paceMinMsFor, resolveSettings, thresholdFor, turnLimitsFor } from '../src/config/defaults.js';
import { SettingsSchema } from '../src/model/settings.js';
import { AUTONOMIES, VARIANTS } from '../src/model/enums.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const defaults = resolveSettings();

describe('设置入口', () => {
  it('默认设置包含根目录、时区、免打扰和空授权', () => {
    expect(defaults).toMatchObject({ id: 'settings', rootDir: '~/AgentHub', timezone: 'Asia/Shanghai', quietHours: { start: '23:00', end: '08:00' }, digestAt: '08:30', pushChannel: 'macos', defaultModel: null, workDataPaths: [], l3Grants: [] });
  });
  it('深合并单个角色与单个变体限制，保留相邻默认值', () => {
    const settings = resolveSettings({ paceMinMsByRole: { researcher: 90 * minute }, turnLimitsByVariant: { reflection: { steps: 10 } }, quietHours: { end: '09:00' } });
    expect(settings.paceMinMsByRole).toEqual({ chief: 30 * minute, researcher: 90 * minute, executor: 30 * minute, sentinel: 20 * minute });
    expect(settings.turnLimitsByVariant.reflection).toEqual({ steps: 10, durationMs: 15 * minute, tokens: 40000 });
    expect(settings.quietHours).toEqual({ start: '23:00', end: '09:00' });
  });
  it('数组整体替换，模型可显式选择', () => {
    const settings = resolveSettings({ retryBackoffMs: [minute], workDataPaths: ['/work'], l3Grants: ['notify_owner'], defaultModel: { provider: 'p', model: 'm' } });
    expect(settings.retryBackoffMs).toEqual([minute]);
    expect(settings.workDataPaths).toEqual(['/work']);
    expect(settings.defaultModel).toEqual({ provider: 'p', model: 'm' });
  });
  it('设置返回值和传入对象都不会污染全局默认', () => {
    const partial = { quietHours: { start: '20:00' } };
    const first = resolveSettings(partial);
    first.paceMinMsByRole.chief = 1;
    first.quietHours.start = '19:00';
    first.retryBackoffMs.push(1);
    expect(partial.quietHours.start).toBe('20:00');
    expect(resolveSettings().paceMinMsByRole.chief).toBe(30 * minute);
    expect(DEFAULTS.RETRY_BACKOFF_MS).toHaveLength(4);
  });
  it('SettingsSchema 的工作目录授权默认空数组', () => {
    const { workDataPaths: _, l3Grants: __, ...settings } = defaults;
    expect(SettingsSchema.parse(settings)).toMatchObject({ workDataPaths: [], l3Grants: [] });
  });
  it('坏文件备份默认保留三十天，允许有效覆盖并拒绝非正数', () => {
    expect(DEFAULTS.BAD_BACKUP_RETENTION_MS).toBe(30 * day);
    expect(defaults.badBackupRetentionMs).toBe(30 * day);
    expect(resolveSettings({ badBackupRetentionMs: day }).badBackupRetentionMs).toBe(day);
    expect(() => resolveSettings({ badBackupRetentionMs: 0 })).toThrow('badBackupRetentionMs');
    expect(() => resolveSettings({ badBackupRetentionMs: -1 })).toThrow('badBackupRetentionMs');
  });
  it.each([null, 'text', [], 42])('拒绝非对象设置 %s', value => { expect(() => resolveSettings(value)).toThrow('设置必须是对象'); });
  it.each([
    [{ tickMs: -1 }, 'tickMs'], [{ maxBots: 1.5 }, 'maxBots'], [{ timezone: 'Mars/Unknown' }, 'timezone'],
    [{ quietHours: { start: '24:00' } }, 'quietHours.start'], [{ digestAt: '8:30' }, 'digestAt'],
    [{ botQuotaShare: 1.1 }, 'botQuotaShare'], [{ paceMinMsByRole: { chief: NaN } }, 'paceMinMsByRole.chief'],
    [{ turnLimitsByVariant: { regular: { durationMs: Infinity } } }, 'turnLimitsByVariant.regular.durationMs'],
    [{ rootDir: 'relative/path' }, 'rootDir'], [{ workDataPaths: [5] }, 'workDataPaths.0'],
  ])('拒绝非法字段并指明路径 %#', (partial, path) => { expect(() => resolveSettings(partial)).toThrow(path as string); });
  it('未知键与容器错误用中文报错', () => {
    expect(() => resolveSettings({ tickMS: 1 })).toThrow('不支持字段 tickMS');
    expect(() => resolveSettings({ workDataPaths: 'wrong' })).toThrow('workDataPaths：必须是数组');
    expect(() => resolveSettings({ quietHours: [] })).toThrow('quietHours：必须是对象');
    expect(() => resolveSettings({ pushChannel: 'bad' })).toThrow('pushChannel：必须是允许的值');
  });
  it('拒绝嵌套错误键与原型污染键', () => {
    expect(() => resolveSettings({ paceMinMsByRole: { misspelled: 1 } })).toThrow('paceMinMsByRole：不支持字段 misspelled');
    expect(() => resolveSettings(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow('不允许使用');
  });
  it.each([
    [{ saliencePile: 0.95 }, 'salienceUrgent'], [{ quotaYellowRatio: 0.9 }, 'quotaOrangeRatio'],
    [{ claimDefaultMs: 30 * hour }, 'claimDefaultMs'], [{ driveSnoozeMs: 100 * hour }, 'driveSnoozeMs'],
    [{ probationEarlyPromotionMs: 10 * day }, 'probationEarlyPromotionMs'], [{ maxChiefs: 7 }, 'maxChiefs'],
  ])('拒绝倒置配置关系 %#', (partial, path) => { expect(() => resolveSettings(partial)).toThrow(path as string); });
});

describe('纯配置辅助函数', () => {
  it.each([
    ['chief', 30], ['researcher', 60], ['executor', 30], ['sentinel', 20],
  ] as const)('%s 的角色基础节奏与两档倍率', (role, minutes) => {
    expect(paceMinMsFor(role, 'normal', defaults)).toBe(minutes * minute);
    expect(paceMinMsFor(role, 'active', defaults)).toBe(minutes * minute * 0.5);
    expect(paceMinMsFor(role, 'quiet', defaults)).toBe(minutes * minute * 2);
  });
  it('节奏辅助函数使用配置覆盖', () => {
    const settings = resolveSettings({ paceMinMsByRole: { chief: 10 * minute }, paceMultiplierByProfile: { active: 0.25 } });
    expect(paceMinMsFor('chief', 'active', settings)).toBe(2.5 * minute);
  });
  it('有目标与无目标的最长间隔不同', () => {
    expect(paceMaxMsFor(true, defaults)).toBe(48 * hour);
    expect(paceMaxMsFor(false, defaults)).toBe(7 * day);
  });
  it.each(AUTONOMIES)('试岗的 %s 按 L1 每日上限', autonomy => {
    expect(dailyThinkCapFor(autonomy, 'probation', defaults)).toBe(6);
    expect(dailyThinkCapFor(autonomy, 'active', defaults)).toBe({ L0: 2, L1: 6, L2: 10, L3: 12 }[autonomy]);
  });
  it('试岗按覆盖后的 L1 上限计算', () => {
    expect(dailyThinkCapFor('L3', 'probation', resolveSettings({ dailyThinkCapByAutonomy: { L1: 4 } }))).toBe(4);
  });
  it('在岗预算正常，试岗减半并对窗口回合向下取整', () => {
    expect(botBudgetFor('active', defaults)).toEqual({ dailyTurns: 6, dailyTokens: 250000, windowTurns: 3 });
    expect(botBudgetFor('probation', defaults)).toEqual({ dailyTurns: 3, dailyTokens: 125000, windowTurns: 1 });
  });
  it('试岗预算允许覆盖且向下取整', () => {
    expect(botBudgetFor('probation', resolveSettings({ botDailyTurnBudget: 7, botDailyTokenBudget: 101, botWindowTurnBudget: 5 }))).toEqual({ dailyTurns: 3, dailyTokens: 50, windowTurns: 2 });
  });
  it.each([...VARIANTS, 'owner'] as const)('%s 返回正确回合限制且返回值不污染设置', variant => {
    const expected = { regular: [30, 20, 60000], light_check: [5, 5, 15000], reflection: [20, 15, 40000], catch_up: [30, 20, 60000], trial: [30, 20, 60000], teach: [30, 20, 60000], owner: [40, 30, 80000] }[variant];
    const limits = turnLimitsFor(variant, defaults);
    expect(limits).toEqual({ steps: expected[0], durationMs: expected[1]! * minute, tokens: expected[2] });
    limits.steps = 999;
    expect(turnLimitsFor(variant, defaults).steps).toBe(expected[0]);
  });
  it('疲劳与节奏档共同改变门槛', () => {
    expect(thresholdFor(0, 'normal', defaults)).toBeCloseTo(0.6);
    expect(thresholdFor(1, 'normal', defaults)).toBeCloseTo(0.9);
    expect(thresholdFor(0.5, 'active', defaults)).toBeCloseTo(0.65);
    expect(thresholdFor(0.5, 'quiet', defaults)).toBeCloseTo(0.85);
  });
  it('门槛接受设置覆盖，拒绝非法疲劳', () => {
    expect(thresholdFor(0.5, 'quiet', resolveSettings({ thresholdBase: 0.5, thresholdFatigueWeight: 0.2, thresholdOffsetByProfile: { quiet: 0.15 } }))).toBeCloseTo(0.75);
    for (const fatigue of [-0.1, 1.1, NaN, Infinity]) expect(() => thresholdFor(fatigue, 'normal', defaults)).toThrow('疲劳');
  });
});
