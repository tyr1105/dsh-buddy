/**
 * P55 队友配置精简 - core 测试。
 * 主人把配置收成八项，这里钉住这些新规则：
 * - 第五种执行风格「建议」：能建、不能放权给它动手、节奏沿用调研；
 * - 性格和说话风格是选择题：结果拼成写进身份文件的话，改选项时跟着变；
 * - 员工说明进身份文件，志向不填时按执行风格自动补；
 * - DSH 技能：名字校验、去重、目录读取失败不影响页面；
 * - 听吩咐是硬规则：自己醒的来源全部挡住，被点名和派活照常放行，也不算掉线；
 * - 旧档案没有新字段时按默认值读取，老队友行为不变。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { botView } from '../src/api/bot-view.js';
import { settingsView } from '../src/api/feed-views.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { collectTimeCandidates } from '../src/agenda/clock.js';
import { checkDeadman } from '../src/health/deadman.js';
import { renderBotAgentsMd } from '../src/memory/render.js';
import { enqueue } from '../src/scheduler/queue.js';
import { ON_DEMAND_BLOCKED_KINDS, onDemandBlocks } from '../src/scheduler/on-demand.js';
import { paceMinMsFor } from '../src/config/defaults.js';
import { composePersona, DEFAULT_ASPIRATION_BY_ROLE, SPEECH_STYLE_TEXT, TEMPERAMENT_TEXT } from '../src/config/persona-choices.js';
import { BotSchema } from '../src/model/bot.js';
import { ROLES, SPEECH_STYLES, TEMPERAMENTS, WAKE_KINDS, type WakeKind } from '../src/model/enums.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';

const base = { name: '小助手', role: 'executor' as const };

/** 取这位队友当前的志向文字。 */
function aspirationsOf(ctx: HubContext, botId: string): string[] {
  return ctx.store.table('aspirations').list(row => row.botId === botId).map(row => row.text);
}

/** 建一位听吩咐的队友，并把试跑排队清掉，后面的断言只看新进来的唤醒。 */
async function onDemandBot(ctx: HubContext) {
  const bot = await createBot(ctx, { ...base, onDemand: true });
  for (const row of ctx.store.table('queue').list()) ctx.store.table('queue').remove(row.id);
  return bot;
}

describe('P55 建议风格', () => {
  it('能创建，界面标签是「建议」，身份文件写明不动手', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '外脑', role: 'advisor' });
    const view = await botView(ctx, bot.id);
    expect(view.card.roleLabel).toBe('建议');
    const agents = renderBotAgentsMd(ctx, bot);
    expect(agents).toContain('角色：建议');
    expect(agents).toContain('不替别人动手');
  });

  it('不用给旧的设置文件补键：最短间隔沿用调研', () => {
    const ctx = createTestContext();
    expect(paceMinMsFor('advisor', 'normal', ctx.settings)).toBe(paceMinMsFor('researcher', 'normal', ctx.settings));
  });

  it('反例：建议风格不能放权到会动手的等级，创建和修改都挡住', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { name: '外脑', role: 'advisor', autonomy: 'L2' })).rejects.toThrow('建议风格只提意见不动手');
    const bot = await createBot(ctx, { name: '外脑', role: 'advisor' });
    await expect(updateBot(ctx, bot.id, { autonomy: 'L3' })).rejects.toThrow('建议风格只提意见不动手');
    const doer = await createBot(ctx, { name: '干活的', role: 'executor', autonomy: 'L2' });
    await expect(updateBot(ctx, doer.id, { role: 'advisor' })).rejects.toThrow('建议风格只提意见不动手');
  });
});

describe('P55 性格和说话风格选择题', () => {
  it('每个选项都有写进身份文件的话，五种执行风格都有默认志向', () => {
    for (const id of TEMPERAMENTS) expect(TEMPERAMENT_TEXT[id].length).toBeGreaterThan(0);
    for (const id of SPEECH_STYLES) expect(SPEECH_STYLE_TEXT[id].length).toBeGreaterThan(0);
    for (const role of ROLES) expect(DEFAULT_ASPIRATION_BY_ROLE[role].length).toBeGreaterThan(0);
  });

  it('两题都选：拼成一段话写进身份文件', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, temperament: 'rigorous', speechStyle: 'conclusion_first' });
    expect(bot.persona).toBe(`性格：${TEMPERAMENT_TEXT.rigorous}说话：${SPEECH_STYLE_TEXT.conclusion_first}`);
    expect(renderBotAgentsMd(ctx, bot)).toContain(TEMPERAMENT_TEXT.rigorous);
  });

  it('都不选：退回朴素的自我介绍，不留空行', () => {
    expect(composePersona({ name: '小助手', role: 'executor', temperament: null, speechStyle: null })).toBe('我是小助手，按执行的方式做事。');
  });

  it('改选项时重新拼 persona，只改一题另一题保留', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, temperament: 'calm', speechStyle: 'brief' });
    const updated = await updateBot(ctx, bot.id, { speechStyle: 'playful' });
    expect(updated.persona).toBe(`性格：${TEMPERAMENT_TEXT.calm}说话：${SPEECH_STYLE_TEXT.playful}`);
  });

  it('反例：没改选择题时不动 persona，老队友写的长文字不会被覆盖', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, persona: '我的老设定，一直这么写' });
    const updated = await updateBot(ctx, bot.id, { color: '#10b981' });
    expect(updated.persona).toBe('我的老设定，一直这么写');
  });

  it('反例：不在选项里的值被拒绝', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { ...base, temperament: 'moody' })).rejects.toThrow('性格');
  });
});

describe('P55 员工说明和自动志向', () => {
  it('员工说明写进身份文件，首尾空白被去掉', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, brief: '  负责每天看日志。发到外部的内容必须先问我。\n' });
    expect(bot.brief).toBe('负责每天看日志。发到外部的内容必须先问我。');
    const agents = renderBotAgentsMd(ctx, bot);
    expect(agents).toContain('## 员工说明');
    expect(agents).toContain('发到外部的内容必须先问我');
  });

  it('反例：没写员工说明时，身份文件不留空标题', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, base);
    expect(renderBotAgentsMd(ctx, bot)).not.toContain('## 员工说明');
  });

  it('反例：超过 1000 字被拒绝', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { ...base, brief: '说'.repeat(1001) })).rejects.toThrow('员工说明不能超过 1000 字');
  });

  it('员工说明写满也不会把交账协议从身份文件里挤掉', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, brief: '说'.repeat(1000) });
    expect(renderBotAgentsMd(ctx, bot)).toContain('## 交账协议');
  });

  it('不填志向：按执行风格补一条；填了就用主人的', async () => {
    const ctx = createTestContext();
    const auto = await createBot(ctx, { name: '盯守员', role: 'sentinel' });
    expect(aspirationsOf(ctx, auto.id)).toEqual([DEFAULT_ASPIRATION_BY_ROLE.sentinel]);
    const given = await createBot(ctx, { name: '研究员', role: 'researcher', aspirations: ['我自己的志向'] });
    expect(aspirationsOf(ctx, given.id)).toEqual(['我自己的志向']);
  });
});

describe('P55 DSH 技能', () => {
  it('创建时去重，详情里能读到；改档案时能换', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, dshSkillNames: ['office-xlsx', 'office-xlsx', 'office-docx'] });
    expect(bot.dshSkillNames).toEqual(['office-xlsx', 'office-docx']);
    expect((await botView(ctx, bot.id)).profile.dshSkillNames).toEqual(['office-xlsx', 'office-docx']);
    expect((await updateBot(ctx, bot.id, { dshSkillNames: ['office-pptx'] })).dshSkillNames).toEqual(['office-pptx']);
  });

  it('反例：名字格式不对、数量超过上限都被拒绝', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { ...base, dshSkillNames: ['Not A Skill'] })).rejects.toThrow('DSH 技能名格式不对');
    await expect(createBot(ctx, { ...base, dshSkillNames: Array.from({ length: 21 }, (_, i) => `skill-${i}`) })).rejects.toThrow('最多选 20 个');
  });

  it('只改头像色不会清空 DSH 技能和听吩咐', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, dshSkillNames: ['office-xlsx'], onDemand: true, brief: '要留着' });
    const updated = await updateBot(ctx, bot.id, { color: '#10b981' });
    expect(updated.dshSkillNames).toEqual(['office-xlsx']);
    expect(updated.onDemand).toBe(true);
    expect(updated.brief).toBe('要留着');
  });

  it('设置视图给出排好序的目录：去重、丢掉不合规的名字、长描述截断', async () => {
    const ctx = Object.assign(createTestContext(), { listSkills: async () => [
      { name: 'office-xlsx', description: '读写表格' },
      { name: 'apple-notes', description: '长'.repeat(300) },
      { name: 'office-xlsx', description: '重复的一行' },
      { name: 'Bad Name', description: '名字不合规' },
    ] });
    const { dshSkillOptions } = await settingsView(ctx);
    expect(dshSkillOptions.map(row => row.name)).toEqual(['apple-notes', 'office-xlsx']);
    expect([...dshSkillOptions[0]!.description].length).toBe(161);
    expect(dshSkillOptions[0]!.description.endsWith('…')).toBe(true);
  });

  it('反例：目录读失败时清单为空，设置页照常打开', async () => {
    const ctx = Object.assign(createTestContext(), { listSkills: async () => { throw new Error('目录坏了'); } });
    await expect(settingsView(ctx)).resolves.toEqual(expect.objectContaining({ dshSkillOptions: [] }));
  });

  it('宿主没提供目录时清单为空', async () => {
    expect((await settingsView(createTestContext())).dshSkillOptions).toEqual([]);
  });
});

describe('P55 听吩咐是硬规则', () => {
  it('规则表：自己醒的来源挡住，别人叫它的来源放行', () => {
    const allowed: WakeKind[] = ['agenda_due', 'owner_message', 'peer_message', 'inbox_reply', 'approval_decided', 'next_think', 'trial', 'teach', 'retry'];
    for (const kind of WAKE_KINDS) {
      expect(onDemandBlocks({ onDemand: true }, kind), kind).toBe(!allowed.includes(kind));
      expect(onDemandBlocks({ onDemand: false }, kind), kind).toBe(false);
    }
    expect(ON_DEMAND_BLOCKED_KINDS.size + allowed.length).toBe(WAKE_KINDS.length);
  });

  it('入队总闸：外界变化进不了队列，并留下一条能看懂的原因', async () => {
    const ctx = createTestContext();
    const bot = await onDemandBot(ctx);
    const result = enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'percept', score: 0.99, summary: '文件变了', evidence: [] }));
    expect(result).toBeNull();
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.log('appraisals').all().at(-1)?.text).toContain('听吩咐');
  });

  it('主人消息和派活照常进队列', async () => {
    const ctx = createTestContext();
    const bot = await onDemandBot(ctx);
    const result = enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'owner_message',
      score: ctx.settings.c02.ownerSalience, summary: '主人派活', evidence: [], ownerInitiated: true }));
    expect(result).not.toBeNull();
  });

  it('到点的轻复查不发生；普通队友照常发生', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const quiet = await onDemandBot(ctx);
    const normal = await createBot(ctx, { name: '常驻', role: 'executor' });
    ctx.store.table('bots').patch(quiet.id, { lightCheckAt: now - 1 });
    ctx.store.table('bots').patch(normal.id, { lightCheckAt: now - 1 });
    const botIds = collectTimeCandidates(ctx, now).filter(row => row.reason.kind === 'light_check').map(row => row.botId);
    expect(botIds).toEqual([normal.id]);
  });

  it('手上没活时，自己约的下次思考不生效；还有活就生效', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const bot = await onDemandBot(ctx);
    ctx.store.table('bots').patch(bot.id, { nextThinkAt: now - 1, nextThinkReason: '再看看' });
    expect(collectTimeCandidates(ctx, now).some(row => row.reason.kind === 'next_think')).toBe(false);
    ctx.store.table('agenda').put({ id: 'ag1', botId: bot.id, kind: 'task', title: '主人交代的活', detail: '', dueAt: null,
      condition: null, priority: 3, source: 'owner', status: 'open', toOwner: false, createdAt: now, updatedAt: now } as never);
    expect(collectTimeCandidates(ctx, now).some(row => row.reason.kind === 'next_think')).toBe(true);
  });

  it('过了预期时间没醒，不算掉线也不报警', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const bot = await onDemandBot(ctx);
    ctx.store.table('bots').patch(bot.id, { expectedBy: now - 60_000, activity: 'watching' });
    expect(checkDeadman(ctx, now).filter(row => row.botId === bot.id)).toEqual([]);
  });

  it('身份文件和界面都如实说明', async () => {
    const ctx = createTestContext();
    const bot = await onDemandBot(ctx);
    expect(renderBotAgentsMd(ctx, bot)).toContain('听吩咐：只在主人或同伴点名、派活时行动');
    expect((await botView(ctx, bot.id)).card.nextThinkText).toBe('等你点名或派活');
  });

  it('反例：普通队友的身份文件里没有听吩咐', async () => {
    const ctx = createTestContext();
    expect(renderBotAgentsMd(ctx, await createBot(ctx, base))).not.toContain('听吩咐');
  });

  it('听吩咐默认用安静节奏，主人显式传了节奏时以主人为准', async () => {
    const ctx = createTestContext();
    expect((await createBot(ctx, { ...base, onDemand: true })).pace).toBe('quiet');
    expect((await createBot(ctx, { name: '另一位', role: 'executor', onDemand: true, pace: 'active' })).pace).toBe('active');
  });
});

describe('P55 旧档案兼容', () => {
  it('没有新字段的旧档案按默认值读取', () => {
    const { dshSkillNames: _a, temperament: _b, speechStyle: _c, brief: _d, onDemand: _e, ...legacy } = botFixture;
    expect(BotSchema.parse(legacy)).toEqual(expect.objectContaining({
      dshSkillNames: [], temperament: null, speechStyle: null, brief: '', onDemand: false,
    }));
  });
});
