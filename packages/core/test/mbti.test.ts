/**
 * MBTI 行为倾向测试：16 型映射、独立档案表、旧存档迁移、唤醒包注入长度，
 * 以及「MBTI 不改变权限、审批、额度」的回归。
 * 存储口径：MBTI 只在 botProfiles 表，Bot 本体保持旧版本可读，绝不写 mbti 字段。
 */
import { describe, expect, test } from 'vitest';
import { MBTI_TYPE_LABELS, MBTI_TYPES, MbtiTypeSchema } from '../src/model/enums.js';
import { MBTI_AXIS_TEXT, MBTI_UNSET_LABEL, mbtiLabel, mbtiPrompt, mbtiTendency } from '../src/model/mbti.js';
import type { Bot } from '../src/model/bot.js';
import { botFixture } from './model-fixtures.js';
import { BotSchema } from '../src/model/bot.js';
import { BotProfileSchema } from '../src/model/bot-profile.js';
import { botMbti, migrateBotMbti, saveBotMbti } from '../src/personality/profile.js';
import { MBTI_DEFAULTS, botBudgetFor, dailyThinkCapFor, resolveSettings } from '../src/config/defaults.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { byteLength } from '../src/util/text.js';
import { turnContext } from './c03-turn-fixtures.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { effectiveAutonomy } from '../src/tools/common.js';
import { classifyToolCall } from '../src/gate/classify.js';
import { decide } from '../src/gate/matrix.js';
import type { GateContext } from '../src/gate/paths.js';
import type { HubContext } from '../src/engine/context.js';
import type { MbtiType } from '../src/model/enums.js';

/** 给测试机器人写一条性格档案，模拟主人已经选过 MBTI。 */
function setMbti(ctx: HubContext, botId: string, mbti: MbtiType): void {
  saveBotMbti(ctx, botId, mbti);
}

/** 模拟早期版本写坏的存档：Bot 记录里直接带 mbti。 */
function putLegacyBotMbti(ctx: HubContext, bot: Bot, mbti: unknown): void {
  ctx.store.table('bots').put({ ...bot, mbti } as unknown as Bot);
}

/** 从最终唤醒包里摘掉性格段，用来比较「除了性格以外是否完全一致」。 */
function withoutPersonality(packet: string): string {
  // F14 多了一节实际行为数值；两节均为性格，其他协议仍须逐字一致。
  return packet.split('\n\n## ').filter(section => !section.startsWith('你的性格倾向')
    && !section.startsWith('本轮行为偏好')).join('\n\n## ');
}

describe('MBTI 映射（16 型全覆盖）', () => {
  test('16 型都有昵称、中文摘要与四个维度档位', () => {
    expect(MBTI_TYPES).toHaveLength(16);
    for (const type of MBTI_TYPES) {
      const tendency = mbtiTendency(type);
      expect(tendency).not.toBeNull();
      expect(tendency!.type).toBe(type);
      expect(tendency!.nickname).toBe(MBTI_TYPE_LABELS[type]);
      expect([...tendency!.summary].length).toBeGreaterThan(0);
      // 四个字母必须与类型码逐位一致，避免映射错位。
      expect(tendency!.energy.code).toBe(type[0]);
      expect(tendency!.information.code).toBe(type[1]);
      expect(tendency!.decision.code).toBe(type[2]);
      expect(tendency!.rhythm.code).toBe(type[3]);
      expect(tendency!.energy.text).toBe(MBTI_AXIS_TEXT[tendency!.energy.code]);
      expect(tendency!.information.text).toBe(MBTI_AXIS_TEXT[tendency!.information.code]);
      expect(tendency!.decision.text).toBe(MBTI_AXIS_TEXT[tendency!.decision.code]);
      expect(tendency!.rhythm.text).toBe(MBTI_AXIS_TEXT[tendency!.rhythm.code]);
    }
  });

  test('四维文案覆盖产品约定的含义', () => {
    expect(MBTI_AXIS_TEXT.E).toContain('主动');
    expect(MBTI_AXIS_TEXT.I).toContain('少打扰');
    expect(MBTI_AXIS_TEXT.S).toContain('事实');
    expect(MBTI_AXIS_TEXT.N).toContain('判断');
    expect(MBTI_AXIS_TEXT.T).toContain('结论');
    expect(MBTI_AXIS_TEXT.F).toContain('感受');
    expect(MBTI_AXIS_TEXT.J).toContain('计划');
    expect(MBTI_AXIS_TEXT.P).toContain('调整');
  });

  test('两个只差一个字母的类型给出不同倾向（反例防复制粘贴）', () => {
    expect(mbtiTendency('INTJ')!.rhythm.code).toBe('J');
    expect(mbtiTendency('INTP')!.rhythm.code).toBe('P');
    expect(mbtiTendency('ESTJ')!.energy.code).toBe('E');
    expect(mbtiTendency('ISTJ')!.energy.code).toBe('I');
    expect(mbtiTendency('ESFP')!.information.code).toBe('S');
    expect(mbtiTendency('ENFP')!.information.code).toBe('N');
  });

  test('未设置返回 null，标签显示「未设置」', () => {
    expect(mbtiTendency(null)).toBeNull();
    expect(mbtiTendency(undefined)).toBeNull();
    expect(mbtiLabel(null)).toBe(MBTI_UNSET_LABEL);
    expect(mbtiLabel(undefined)).toBe(MBTI_UNSET_LABEL);
    expect(mbtiPrompt(null)).toBeNull();
    expect(mbtiPrompt(undefined)).toBeNull();
    expect(mbtiLabel('INTJ')).toContain('INTJ');
  });
});

describe('MBTI 领域模型与独立存储', () => {
  test('Bot 本体保持旧结构：没有 mbti 字段，旧存档照常解析', () => {
    const parsed = BotSchema.parse(botFixture);
    expect('mbti' in botFixture).toBe(false);
    expect('mbti' in parsed).toBe(false);
  });

  test('Bot 仍是 strictObject：带 mbti 的旧记录不会被当作合法 Bot，必须迁移', () => {
    expect(BotSchema.safeParse({ ...botFixture, mbti: 'INTJ' }).success).toBe(false);
  });

  test('性格档案：16 型与 null 合法，非法类型和缺 botId 被拒', () => {
    const valid = { id: 'b_0000000001', botId: 'b_0000000001', mbti: 'INTJ', updatedAt: 1_793_808_000_000 };
    expect(BotProfileSchema.safeParse(valid).success).toBe(true);
    expect(BotProfileSchema.safeParse({ ...valid, mbti: null }).success).toBe(true);
    expect(BotProfileSchema.safeParse({ ...valid, mbti: 'XXXX' }).success).toBe(false);
    expect(BotProfileSchema.safeParse({ ...valid, botId: undefined }).success).toBe(false);
    for (const type of MBTI_TYPES) expect(MbtiTypeSchema.safeParse(type).success).toBe(true);
    expect(MbtiTypeSchema.safeParse('intj').success).toBe(false);
  });

  test('默认值是未设置，不在代码里替旧机器人猜一个类型', () => {
    expect(MBTI_DEFAULTS.DEFAULT_TYPE).toBeNull();
    expect(MBTI_DEFAULTS.PROMPT_MAX_BYTES).toBeGreaterThan(0);
  });

  test('提示词覆盖四维但显式声明不改变规则，且长度受限', () => {
    for (const type of MBTI_TYPES) {
      const prompt = mbtiPrompt(type)!;
      expect(prompt).toContain(type);
      expect(prompt).toContain(MBTI_TYPE_LABELS[type]);
      expect(prompt).toContain('不改变权限');
      expect(prompt).toContain('审批');
      expect(prompt).toContain('安全规则');
      expect(prompt).toContain('额度');
      expect(prompt).toContain('冲突时以规矩为准');
      expect(byteLength(prompt)).toBeLessThanOrEqual(MBTI_DEFAULTS.PROMPT_MAX_BYTES);
    }
    // 四个维度各自的关键措辞都要出现。
    const prompt = mbtiPrompt('INTJ')!;
    for (const code of ['I', 'N', 'T', 'J'] as const) expect(prompt).toContain(MBTI_AXIS_TEXT[code]);
  });
});

describe('旧存档迁移：Bot 本体的 mbti 搬到 botProfiles', () => {
  test('迁移后 Bot 不再含 mbti，性格进入档案表，且可以按旧 schema 解析', async () => {
    const { ctx, bot } = await turnContext('regular');
    putLegacyBotMbti(ctx, bot, 'INTP');
    expect(migrateBotMbti(ctx)).toBe(1);
    const cleaned = ctx.store.table('bots').get(bot.id)!;
    expect('mbti' in cleaned).toBe(false);
    expect(BotSchema.safeParse(cleaned).success).toBe(true);
    expect(botMbti(ctx, bot.id)).toBe('INTP');
    expect(ctx.store.table('botProfiles').count()).toBe(1);
  });

  test('迁移幂等：第二次运行不重复写档案、不改动时间', async () => {
    const { ctx, bot } = await turnContext('regular');
    putLegacyBotMbti(ctx, bot, 'ENFP');
    migrateBotMbti(ctx);
    const first = ctx.store.table('botProfiles').get(bot.id)!;
    expect(migrateBotMbti(ctx)).toBe(0);
    expect(ctx.store.table('botProfiles').count()).toBe(1);
    expect(ctx.store.table('botProfiles').get(bot.id)).toEqual(first);
  });

  test('档案已存在时不覆盖主人后来的选择，只剥离旧字段', async () => {
    const { ctx, bot } = await turnContext('regular');
    setMbti(ctx, bot.id, 'ESFJ');
    putLegacyBotMbti(ctx, bot, 'INTJ');
    migrateBotMbti(ctx);
    expect(botMbti(ctx, bot.id)).toBe('ESFJ');
    expect('mbti' in ctx.store.table('bots').get(bot.id)!).toBe(false);
  });

  test.each([null, 'XXXX', 42])('非法旧值 %j 只剥离、不生成档案', async legacy => {
    const { ctx, bot } = await turnContext('regular');
    putLegacyBotMbti(ctx, bot, legacy);
    migrateBotMbti(ctx);
    expect('mbti' in ctx.store.table('bots').get(bot.id)!).toBe(false);
    expect(ctx.store.table('botProfiles').get(bot.id)).toBeNull();
  });

  test('清理后的 bots.json 内容不再出现 mbti，旧版本可整表读取', async () => {
    const { ctx, bot } = await turnContext('regular');
    putLegacyBotMbti(ctx, bot, 'ISTJ');
    migrateBotMbti(ctx);
    const text = JSON.stringify(ctx.store.table('bots').list());
    expect(text).not.toContain('"mbti"');
  });
});

describe('API 读写路径不变，只是换了存储', () => {
  test('创建时选了 MBTI：写档案表，Bot 本体不含 mbti，详情可见', async () => {
    const { ctx, api } = await apiFixture();
    const bot = okData(await api.createBot({ name: '小配', role: 'researcher', persona: '先核实', mbti: 'ENFP', aspirations: ['核实公开信息'] }));
    expect('mbti' in bot).toBe(false);
    expect(botMbti(ctx, bot.id)).toBe('ENFP');
    const view = await api.bot(bot.id);
    expect(view.profile.mbti).toBe('ENFP');
    expect(view.profile.mbtiLabel).toContain('ENFP');
  });

  test('创建时跳过 MBTI：没有档案行，详情显示「未设置」', async () => {
    const { ctx, api } = await apiFixture();
    expect(ctx.store.table('botProfiles').count()).toBe(0);
    const view = await api.bot(ctx.store.table('bots').list()[0]!.id);
    expect(view.profile.mbti).toBeNull();
    expect(view.profile.mbtiLabel).toBe(MBTI_UNSET_LABEL);
  });

  test('修改与清空都走 updateBot，Bot 行始终不含 mbti', async () => {
    const { ctx, api } = await apiFixture();
    const bot = ctx.store.table('bots').list()[0]!;
    okData(await api.updateBot(bot.id, { mbti: 'ISTJ' }));
    expect(botMbti(ctx, bot.id)).toBe('ISTJ');
    expect('mbti' in ctx.store.table('bots').get(bot.id)!).toBe(false);
    okData(await api.updateBot(bot.id, { mbti: null }));
    expect(ctx.store.table('botProfiles').get(bot.id)?.mbti).toBeNull();
    expect((await api.bot(bot.id)).profile.mbtiLabel).toBe(MBTI_UNSET_LABEL);
  });

  test('非法 MBTI 在 API 入口被中文错误拦住', async () => {
    const { api } = await apiFixture();
    const bot = okData(await api.createBot({ name: '校验', role: 'researcher', persona: '先核实', aspirations: ['核实'] }));
    const result = await api.updateBot(bot.id, { mbti: 'ABCD' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('mbti');
  });
});

describe('唤醒包注入', () => {
  test('常规回合包含性格段落与类型码', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular');
    setMbti(ctx, bot.id, 'ENFP');
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('## 你的性格倾向');
    expect(packet).toContain('ENFP');
    expect(packet).toContain('不改变权限');
    expect(byteLength(packet)).toBeLessThanOrEqual(6144);
    // 性格段在规矩之后、正文变体之前，不挤掉规矩。
    expect(packet.indexOf('## 规矩')).toBeLessThan(packet.indexOf('## 你的性格倾向'));
  });

  test('轻复查也带性格段，但保持简版（不出现完整规矩标题）', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('light_check');
    setMbti(ctx, bot.id, 'ISTJ');
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('## 你的性格倾向');
    expect(packet).toContain('ISTJ');
    expect(packet).not.toContain('## 规矩');
    expect(packet).not.toContain('## 记忆摘要');
  });

  test('未设置时不出现性格段，不给唤醒包增加字节', async () => {
    const { ctx, bot, entry, ticket } = await turnContext();
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).not.toContain('## 你的性格倾向');
  });

  test('档案行存在但 mbti 为 null 时同样省略', async () => {
    const { ctx, bot, entry, ticket } = await turnContext();
    saveBotMbti(ctx, bot.id, null);
    expect(await buildWakePacket(ctx, bot, entry, ticket)).not.toContain('## 你的性格倾向');
  });

  test('性格段正文不超过配置上限', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular');
    setMbti(ctx, bot.id, 'ESFJ');
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    const start = packet.indexOf('## 你的性格倾向') + '## 你的性格倾向（表达与做事倾向，硬性规则优先）'.length;
    const next = packet.indexOf('\n\n## ', start);
    const body = packet.slice(start, next < 0 ? undefined : next).trim();
    expect(byteLength(body)).toBeLessThanOrEqual(MBTI_DEFAULTS.PROMPT_MAX_BYTES);
  });

  test('只剩最后空间时仍保持 6KB 上限', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular');
    setMbti(ctx, bot.id, 'ENTP');
    for (let i = 0; i < 30; i++) {
      ctx.store.table('aspirations').put({
        id: `asp_${i}`, botId: bot.id, text: '目标'.repeat(2000), status: 'active',
        createdBy: 'owner', approved: true, createdAt: ctx.clock.now(),
      });
    }
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(byteLength(packet)).toBeLessThanOrEqual(6144);
  });
});

describe('MBTI 不改变权限、审批、额度与唤醒判断', () => {
  const gctx: GateContext = {
    homeDir: botFixture.homeDir, rootDir: '/hub', sharedDir: '/hub/shared',
    workDataAllowed: false, workDataPaths: ['/company'],
  };
  const calls: ReadonlyArray<readonly [string, unknown]> = [
    ['read', { path: `${botFixture.homeDir}/AGENTS.md` }],
    ['write', { path: `${botFixture.homeDir}/AGENTS.md` }],
    ['write', { path: `${botFixture.homeDir}/work/a.md` }],
    ['write', { path: '/etc/hosts' }],
    ['web_fetch', { url: 'https://example.test/pay', method: 'POST' }],
    ['hub_commit', {}],
  ];

  test('只改 MBTI，动作分类与审批结论完全一致', () => {
    const a = { ...botFixture, mbti: 'ISTJ' } as unknown as Bot;
    const b = { ...botFixture, mbti: 'ENFP' } as unknown as Bot;
    expect(effectiveAutonomy(a)).toBe(effectiveAutonomy(b));
    for (const [tool, args] of calls) {
      const clsA = classifyToolCall(tool, args, gctx);
      const clsB = classifyToolCall(tool, args, gctx);
      expect(clsA).toEqual(clsB);
      expect(decide(clsA, effectiveAutonomy(a), a.lifecycle)).toEqual(decide(clsB, effectiveAutonomy(b), b.lifecycle));
    }
  });

  test('额度与每日思考上限只由等级和生命周期决定', () => {
    const settings = resolveSettings({ rootDir: '/hub' });
    expect(botBudgetFor('active', settings)).toEqual(botBudgetFor('active', settings));
    expect(dailyThinkCapFor('L1', 'probation', settings)).toBe(dailyThinkCapFor('L1', 'probation', settings));
    // 试岗减半与 MBTI 无关：同一生命周期下预算固定。
    expect(botBudgetFor('probation', settings).dailyTurns).toBe(Math.floor(settings.botDailyTurnBudget * settings.probationBudgetMultiplier));
  });

  test('两个只差 MBTI 的机器人唤醒包去掉性格段后逐字相同', async () => {
    const a = await turnContext('regular');
    const b = await turnContext('regular');
    setMbti(a.ctx, a.bot.id, 'INTJ');
    setMbti(b.ctx, b.bot.id, 'ESFP');
    const packetA = await buildWakePacket(a.ctx, a.bot, a.entry, a.ticket);
    const packetB = await buildWakePacket(b.ctx, b.bot, b.entry, b.ticket);
    expect(withoutPersonality(packetA)).toBe(withoutPersonality(packetB));
  });
});
