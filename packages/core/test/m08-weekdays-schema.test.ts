/** M08 数据与入口回归：用真实工具、界面命令和内存文件存储验证星期约束及旧档案兼容。 */
import { describe, expect, it } from 'vitest';
import { ExpectationSchema, WatchSchema } from '../src/model/perception.js';
import { buildTools, runTool } from '../src/tools/index.js';
import { FileStore } from '../src/store/file-store.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';

const expectation = { text: '早盘日志出现', everyMs: null, byLocalTime: '08:20', lastSatisfiedAt: null, lastMissedAt: null };
const watchInput = { kind: 'http', target: 'https://example.test/m08-status', why: '核对公开日志是否出现' };
const profile = { name: '星期队友', role: 'sentinel', persona: '按检查日核实公开日志', aspirations: ['记录应出现的公开变化'] };
const description = '只在这些日子检查：1=周一…7=周日；省略表示每天；工作日写 [1,2,3,4,5]';
const invalidWeekdays = [
  { value: [0], message: '星期不能小于 1' },
  { value: [8], message: '星期不能大于 7' },
  { value: [1.5], message: '星期必须是整数' },
  { value: [], message: '检查日数组不能为空' },
  { value: ['1'], message: '星期必须是 1–7 的整数' },
  { value: '1', message: '检查日必须是星期数组或 null' },
];

/** 输入只包含用户可配置字段，避免把最近满足时间等中心字段当成公开参数。 */
function requestExpectation(weekdays: unknown) {
  return { text: expectation.text, byLocalTime: expectation.byLocalTime, ...(weekdays === undefined ? {} : { weekdays }) };
}

describe('M08 星期数据模型与模型可见参数', () => {
  it('旧期望缺字段时补 null，显式 null 仍表示每天', () => {
    expect(ExpectationSchema.parse(expectation)).toEqual({ ...expectation, weekdays: null });
    expect(ExpectationSchema.parse({ ...expectation, weekdays: null })).toEqual({ ...expectation, weekdays: null });
  });

  it('重复与乱序规范化为去重升序且不修改输入数组', () => {
    const weekdays = [7, 3, 1, 3, 7];
    expect(ExpectationSchema.parse({ ...expectation, weekdays }).weekdays).toEqual([1, 3, 7]);
    expect(weekdays).toEqual([7, 3, 1, 3, 7]);
  });

  it.each(invalidWeekdays)('模型拒绝非法星期 $value 并解释原因', ({ value, message }) => {
    const parsed = ExpectationSchema.safeParse({ ...expectation, weekdays: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(['weekdays']), message }),
    ]));
  });

  it('hub_watch_propose 导出可选星期数组的边界与中文说明，所有工具根结构仍满足 M06', () => {
    const tools = buildTools(toolFixture().ctx);
    for (const tool of tools) {
      expect(tool.jsonSchema).toMatchObject({ type: 'object', properties: expect.any(Object) });
      for (const key of ['oneOf', 'anyOf', 'allOf']) expect(tool.jsonSchema).not.toHaveProperty(key);
      expect(JSON.stringify(tool.jsonSchema)).not.toMatch(/"\$(?:ref|defs|schema)"\s*:/);
    }
    const schema = tools.find(tool => tool.name === 'hub_watch_propose')!.jsonSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const fields = properties.expectation!.properties as Record<string, Record<string, unknown>>;
    expect(fields.weekdays).toMatchObject({ type: ['array', 'null'], minItems: 1, description,
      items: { type: 'integer', minimum: 1, maximum: 7 } });
    expect(properties.expectation!.required).not.toContain('weekdays');
    // 模型知道重复值会被规范化，因此不宣称输入必须 uniqueItems。
    expect(fields.weekdays).not.toHaveProperty('uniqueItems');
  });
});

describe('M08 所有可配置期望的入口', () => {
  it.each([
    { label: '缺省', value: undefined, saved: null },
    { label: '每天', value: null, saved: null },
    { label: '指定星期去重升序', value: [5, 1, 3, 1], saved: [1, 3, 5] },
  ])('$label 经 propose、createBot 和 upsertWatch 保存一致', async ({ value, saved }) => {
    const { ctx, tc } = toolFixture();
    expect(await runTool(ctx, tc, 'hub_watch_propose', { ...watchInput, expectation: requestExpectation(value) })).toMatchObject({ ok: true });
    expect(ctx.store.table('watches').list(row => row.target === watchInput.target)[0]?.expectation?.weekdays).toEqual(saved);

    const state = await apiFixture();
    const bot = okData(await state.api.createBot({ ...profile, watches: [{ ...watchInput, expectation: requestExpectation(value) }] }));
    expect(state.ctx.store.table('watches').list(row => row.botId === bot.id)[0]?.expectation?.weekdays).toEqual(saved);
    const created = WatchSchema.parse(okData(await state.api.upsertWatch({ ...watchInput, botId: state.bot.id, expectation: requestExpectation(value) })));
    expect(created.expectation?.weekdays).toEqual(saved);
    const edited = WatchSchema.parse(okData(await state.api.upsertWatch({ ...watchInput, botId: state.bot.id, id: created.id,
      expectation: requestExpectation([7, 6, 6]) })));
    expect(edited.expectation?.weekdays).toEqual([6, 7]);
    // 未传整个 expectation 是保留原配置；明确传入但省略 weekdays 则恢复每天。
    const retained = WatchSchema.parse(okData(await state.api.upsertWatch({ ...watchInput, botId: state.bot.id, id: created.id })));
    expect(retained.expectation?.weekdays).toEqual([6, 7]);
    const daily = WatchSchema.parse(okData(await state.api.upsertWatch({ ...watchInput, botId: state.bot.id, id: created.id,
      expectation: requestExpectation(undefined) })));
    expect(daily.expectation?.weekdays).toBeNull();
  });

  it.each(invalidWeekdays)('propose、createBot 和 upsertWatch 拒绝 $value 且不落半份记录', async ({ value, message }) => {
    const { ctx, tc } = toolFixture();
    const before = ctx.store.table('watches').list();
    const proposal = await runTool(ctx, tc, 'hub_watch_propose', { ...watchInput, expectation: requestExpectation(value) });
    expect(proposal).toMatchObject({ ok: false, error: expect.stringContaining(`expectation.weekdays`) });
    if (!proposal.ok) expect(proposal.error).toContain(message);
    expect(ctx.store.table('watches').list()).toEqual(before);

    const state = await apiFixture();
    const beforeBots = state.ctx.store.table('bots').list();
    const created = await state.api.createBot({ ...profile, watches: [{ ...watchInput, expectation: requestExpectation(value) }] });
    expect(created).toMatchObject({ ok: false, error: expect.stringContaining('watches.0.expectation.weekdays') });
    if (!created.ok) expect(created.error).toContain(message);
    expect(state.ctx.store.table('bots').list()).toEqual(beforeBots);
    const updated = await state.api.upsertWatch({ ...watchInput, botId: state.bot.id, expectation: requestExpectation(value) });
    expect(updated).toMatchObject({ ok: false, error: expect.stringContaining('expectation.weekdays') });
    if (!updated.ok) expect(updated.error).toContain(message);
    expect(state.ctx.store.table('watches').count()).toBe(0);
  });

  it('反思交账新增关注复用星期校验与规范化，旧 watch_update 不扩权', async () => {
    const { ctx, tc, wake } = toolFixture();
    ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    expect(await runTool(ctx, tc, 'hub_reflect_commit', { summary: '只在应检查的星期核实资料', lessons: [], routineUpdates: [],
      watchChanges: [{ ...watchInput, expectation: requestExpectation([5, 1, 5]) }] })).toMatchObject({ ok: true });
    expect(ctx.store.table('watches').list(row => row.target === watchInput.target)[0]?.expectation?.weekdays).toEqual([1, 5]);
    const update = buildTools(ctx).find(tool => tool.name === 'hub_watch_update')!;
    expect(update.jsonSchema.properties).not.toHaveProperty('expectation');
  });
});

describe('M08 真实旧文件存档迁移', () => {
  it('缺星期旧档读出每天，周六照常检查；写回补 null 并完整保留其他历史字段和行', async () => {
    const ctx = createTestContext();
    ctx.clock.set(Date.parse('2026-11-07T09:00:00+08:00'));
    const path = '/hub/.hub/state/watches.json';
    const legacy = { ...watchFixture, expectation: { ...expectation, historicalNote: '保留原始期望说明' }, historicalVersion: 1 };
    const untouched = { ...watchFixture, id: 'wt_0000000002', expectation: null, historicalVersion: 2 };
    await ctx.fs.writeTextAtomic(path, JSON.stringify([legacy, untouched]));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', 'Asia/Shanghai', ctx.logger);
    await store.load();
    expect(store.table('watches').list()).toEqual([
      { ...legacy, expectation: { ...legacy.expectation, weekdays: null, effectiveAt: legacy.createdAt } }, untouched,
    ]);
    expect(store.isDirty()).toBe(true);
    expect(ctx.logger.lines).toEqual([]);
    await store.flush();
    expect(JSON.parse((await ctx.fs.readText(path))!)).toEqual(store.table('watches').list());
    expect((await ctx.fs.list('/hub/.hub/state')).filter(name => name.includes('.bad'))).toEqual([]);
    const reloaded = new FileStore(ctx.fs, ctx.clock, '/hub', 'Asia/Shanghai', ctx.logger);
    await reloaded.load();
    expect(reloaded.isDirty()).toBe(false);
    expect(reloaded.table('watches').get(legacy.id)?.expectation?.weekdays).toBeNull();
    reloaded.table('bots').put(botFixture);
    const runtime = { ...ctx, store: reloaded };
    expect(checkExpectations(runtime, ctx.clock.now())).toHaveLength(1);
  });

  it('已有 null 或星期及生效字段的存档加载不触发迁移，不改其他集合中的同名字段', async () => {
    const ctx = createTestContext();
    const watches = [
      { ...watchFixture, expectation: { ...expectation, weekdays: null, effectiveAt: watchFixture.createdAt } },
      { ...watchFixture, id: 'wt_0000000002', expectation: { ...expectation, weekdays: [1, 3, 5], effectiveAt: watchFixture.createdAt } },
    ];
    const legacyOther = { id: 'ru_0000000001', expectation: { historicalNote: '不是关注项' } };
    await ctx.fs.writeTextAtomic('/hub/.hub/state/watches.json', JSON.stringify(watches));
    await ctx.fs.writeTextAtomic('/hub/.hub/state/rules.json', JSON.stringify([legacyOther]));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', 'Asia/Shanghai', ctx.logger);
    await store.load();
    expect(store.table('watches').list()).toEqual(watches);
    expect(store.table('rules').list()).toEqual([legacyOther]);
    expect(store.isDirty()).toBe(false);
  });
});
