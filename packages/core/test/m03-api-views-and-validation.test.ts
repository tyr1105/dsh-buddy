/** M03 线程和输入回归：精确卡片绑定、中文错误、关注续期与夏令时周期均验证真实命令结果。 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { postThread } from '../src/outreach/thread.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { parseInput } from '../src/engine/validation.js';
import { parseLocalDateTime, startOfLocalDay } from '../src/util/time.js';
import { expireWatches } from '../src/agenda/watch-expiry.js';
import { proposeWatch } from '../src/tools/hub-watch-propose.js';
import { resolveSettings } from '../src/config/defaults.js';
import { initRoot } from '../src/memory/files.js';
import { applyNextThink } from '../src/agenda/next-think.js';
import { recordOwnerMessage } from '../src/perception/sources.js';
import { recordPercept } from '../src/perception/percept.js';
import { onExternalSessionEvent } from '../src/perception/sessions.js';

const DAY = 86_400_000;

describe('M03 [1] 线程卡片精确绑定', () => {
  it.each(['question', 'approval', 'proposal', 'alert'] as const)('%s 仅精确收件箱 id 的相应消息带卡，回执和共用业务 refId 不带卡', async type => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type, title: '需要处理', body: '请确认',
      priority: 'P1', options: ['接受', '拒绝'], defaultOption: '拒绝', subjectKey: 'unique-subject', refId: 'business-ref' });
    const cardId = postThread(ctx, { thread: bot.id, from: bot.id, kind: type, text: '操作卡片', refId: item.id }).id;
    const excluded = [];
    for (const kind of ['reply', 'report', 'system'] as const) {
      excluded.push(postThread(ctx, { thread: bot.id, from: bot.id, kind, text: '精确引用普通消息', refId: item.id }).id);
      excluded.push(postThread(ctx, { thread: bot.id, from: bot.id, kind, text: '业务引用普通消息', refId: 'business-ref' }).id);
    }
    excluded.push(postThread(ctx, { thread: bot.id, from: 'owner', kind: 'reply', text: '主人作答回执', refId: item.id }).id);
    excluded.push(postThread(ctx, { thread: bot.id, from: 'owner', kind: type, text: '主人消息不复制卡片', refId: item.id }).id);
    excluded.push(postThread(ctx, { thread: bot.id, from: bot.id, kind: type, text: '错误业务关联不能回退', refId: 'business-ref' }).id);
    const rows = api.thread(bot.id).messages;
    expect(rows.find(row => row.id === cardId)?.card).toMatchObject({ inboxId: item.id, type, status: 'open' });
    for (const id of excluded) expect(rows.find(row => row.id === id)?.card).toBeNull();
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '接受', answeredAt: ctx.clock.now() });
    expect(api.thread(bot.id).messages.find(row => row.id === cardId)?.card).toMatchObject({ status: 'answered', answer: '接受' });
  });
  it('即使 proposal 精确指向点子池，仍不产生卡片', async () => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: '低价值点子', body: '留待周报', priority: 'P2', subjectKey: 'idea' });
    ctx.store.table('inbox').patch(item.id, { status: 'closed', answer: 'idea_pool' });
    postThread(ctx, { thread: bot.id, from: bot.id, kind: 'proposal', text: '历史引用', refId: item.id });
    expect(api.thread(bot.id).messages.at(-1)?.card).toBeNull();
  });
});

describe('M03 [8] 校验错误均为中文', () => {
  it.each([null, 'maybe', 8])('关闭目标非法联合类型 %j 返回中文与字段名', async outcome => {
    const { api } = await apiFixture();
    const result = await api.closeGoal('missing', outcome as never);
    expect(result).toEqual({ ok: false, error: '关闭目标无效：outcome：不是允许的取值或类型' });
  });
  it.each([null, true, 1.5])('分页非法游标 %j 不透传 Invalid input', async before => {
    const { api, bot } = await apiFixture();
    expect(() => api.thread(bot.id, { before: before as never })).toThrow('分页无效：before：不是允许的取值或类型');
    expect(() => api.activity({ before: before as never })).toThrow('分页无效：before：不是允许的取值或类型');
  });
  it('初始目标索引下限没有 schema 自定义文案时仍显示中文', async () => {
    const { api } = await apiFixture();
    const result = await api.createBot({ name: '新人', role: 'researcher', persona: '核实', aspirations: ['证据'],
      goals: [{ title: '每天核实', doneWhen: '有原文', period: 'day', aspirationIndex: -1 }] });
    expect(result).toEqual({ ok: false, error: '创建机器人无效：goals.0.aspirationIndex：至少为 0' });
  });
  it.each([
    [z.string().max(2), 'abc', '不能超过 2'], [z.string().min(3), 'a', '至少为 3'],
    [z.number().positive(), 0, '必须大于 0'], [z.string().email(), 'bad', '格式不正确'],
    [z.number().multipleOf(2), 3, '必须是 2 的整数倍'], [z.string().refine(() => false), 'a', '内容不符合要求'],
  ] as const)('未定制的 zod 错误本地翻译：%s', (schema, raw, message) => {
    expect(() => parseInput(schema as z.ZodType, raw, '测试')).toThrow(`测试无效：测试：${message}`);
  });
  it('正常输入仍接受且保留 schema 明确中文提示', () => {
    expect(parseInput(z.union([z.boolean(), z.string()]), true, '测试')).toBe(true);
    expect(() => parseInput(z.string().min(3, '至少三字才能说明'), '短', '说明')).toThrow('至少三字才能说明');
  });
  it('默认英文模板中的中文未知键、枚举值与格式条件仍须翻译', () => {
    expect(() => parseInput(z.strictObject({}), { 未知字段: true }, '参数')).toThrow('参数无效：参数：不支持字段 未知字段');
    expect(() => parseInput(z.enum(['同意', '拒绝']), '等待', '决定')).toThrow('决定无效：决定：不是允许的值');
    expect(() => parseInput(z.literal('同意'), '等待', '决定')).toThrow('决定无效：决定：不是允许的值');
    expect(() => parseInput(z.string().startsWith('资料'), '其他', '标题')).toThrow('标题无效：标题：格式不正确');
    expect(() => parseInput(z.string().regex(/^资料/), '其他', '标题')).toThrow('标题无效：标题：格式不正确');
  });
  it('同一错误码的 schema 定制中文仍原样保留', () => {
    expect(() => parseInput(z.strictObject({}, { error: '这里只接收已知的字段' }), { 未知字段: true }, '参数')).toThrow('这里只接收已知的字段');
    expect(() => parseInput(z.enum(['同意', '拒绝'], { error: '请在同意和拒绝之间选择' }), '等待', '决定')).toThrow('请在同意和拒绝之间选择');
    expect(() => parseInput(z.string().startsWith('资料', '标题请以资料开头'), '其他', '标题')).toThrow('标题请以资料开头');
  });
  it('预约、外部会话、来源事件和感知入口的未知字段同样中文拒绝', async () => {
    const { ctx, bot } = await apiFixture();
    const unexpected = { extra: true };
    expect(() => applyNextThink(bot, { mode: 'auto', reason: '等待', ...unexpected }, ctx.clock.now(),
      { settings: ctx.settings, hasActiveGoal: false })).toThrow('不支持字段 extra');
    expect(() => onExternalSessionEvent(ctx, { type: 'finished', sessionId: 'outside', title: '核实', summary: '完成', at: ctx.clock.now(), ...unexpected }))
      .toThrow('不支持字段 extra');
    expect(() => recordOwnerMessage(ctx, { botId: bot.id, id: 'message', summary: '核实', at: ctx.clock.now(), ...unexpected }))
      .toThrow('不支持字段 extra');
    expect(() => recordPercept(ctx, { botId: bot.id, watchId: null, source: 'owner', kind: 'owner_message', summary: '核实', location: null,
      fingerprintMaterial: 'message', magnitude: 1, anomaly: false, untrusted: false, occurredAt: ctx.clock.now(), ...unexpected }))
      .toThrow('不支持字段 extra');
  });
});

describe('M03 [15] 主人恢复机器人关注项', () => {
  it.each(['file', 'http'] as const)('过期 %s 恢复时续期，下一轮过期检查仍在岗，未恢复者仍过期', async kind => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'active', autonomy: 'L2', probationEndsAt: null });
    const target = kind === 'file' ? `${bot.homeDir}/work/note.md` : 'https://example.test/feed';
    const watch = await proposeWatch(ctx, bot.id, { kind, target, why: '关注变化' });
    const old = ctx.store.table('watches').list()[0]!;
    expect(watch).toBeDefined();
    expect(old).toMatchObject({ status: 'active', createdBy: 'bot' });
    ctx.clock.advance(31 * DAY);
    expect(expireWatches(ctx, ctx.clock.now())).toHaveLength(1);
    const renewed = okData(await api.upsertWatch({ id: old.id, botId: bot.id, kind, target, why: '继续关注', status: 'active' }));
    expect(renewed).toMatchObject({ createdBy: 'bot', status: 'active', expiresAt: ctx.clock.now() + ctx.settings.botWatchExpiryMs });
    ctx.clock.advance(60_000);
    expect(expireWatches(ctx, ctx.clock.now())).toHaveLength(0);
    expect(ctx.store.table('watches').get(old.id)?.status).toBe('active');
    ctx.clock.advance(31 * DAY);
    expect(expireWatches(ctx, ctx.clock.now())).toHaveLength(1);
  });
});

describe('M03 [16] 每日目标遇到跳过午夜的时区', () => {
  it.each([
    ['America/Havana', '2027-03-13', '2027-03-14'], ['America/Santiago', '2027-09-04', '2027-09-05'],
    ['Asia/Beirut', '2027-03-27', '2027-03-28'], ['Africa/Cairo', '2027-04-29', '2027-04-30'],
    ['Asia/Shanghai', '2027-03-13', '2027-03-14'], ['America/New_York', '2027-03-13', '2027-03-14'],
  ])('%s：创建及更新每日目标使用下一本地日真正起点', async (timezone, today, tomorrow) => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub', timezone }) });
    ctx.clock.set(parseLocalDateTime(`${today} 12:00`, timezone));
    await initRoot(ctx);
    const api = createUiApi(ctx, async () => ctx.store.flush());
    const bot = okData(await api.createBot({ name: '日目标机器人', role: 'researcher', persona: '每日核实', aspirations: ['证据'],
      goals: [{ title: '创建目标', doneWhen: '有原文', period: 'day' }] }));
    const aspiration = ctx.store.table('aspirations').list()[0]!;
    const expected = startOfLocalDay(parseLocalDateTime(`${tomorrow} 12:00`, timezone), timezone);
    expect(ctx.store.table('goals').list()[0]?.periodEndsAt).toBe(expected);
    okData(await api.upsertGoal({ botId: bot.id, aspirationId: aspiration.id, title: '更新目标', doneWhen: '有来源', period: 'day' }));
    expect(ctx.store.table('goals').list()).toEqual([expect.objectContaining({ periodEndsAt: expected }), expect.objectContaining({ periodEndsAt: expected })]);
  });
});
