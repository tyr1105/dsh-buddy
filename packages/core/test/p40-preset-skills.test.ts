/**
 * P40 队友可选预置 skill - core 测试。
 * 覆盖：
 * - 默认空数组：建队不写任何 skill 文件，唤醒包不出现技能段，行为与未接入时一致；
 * - 物化：勾选后写 `bots/<id>/.agents/skills/<id>/SKILL.md`，开头是 DSH 要求的 YAML 头，后面带标记、名称和用途；
 * - 入口校验：未知 id 在创建/修改档案时报中文错误；
 * - P55 去掉了三档加载条件：什么时候读改由 DSH 的技能目录告诉模型，唤醒包不再单独列技能；
 * - 删除：只清理带中心标记的文件，队友自建/改写过的 skill 不碰；
 * - 视图：设置视图给出只读候选清单（不含正文），机器人详情带勾选 id。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { botView } from '../src/api/bot-view.js';
import { settingsView } from '../src/api/feed-views.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { PRESET_SKILLS, presetSkillById, renderPresetSkillFile } from '../src/config/preset-skills.js';
import { BotSchema } from '../src/model/bot.js';
import { botFixture } from './model-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import type { HubContext } from '../src/engine/context.js';

const base = { name: '小助手', role: 'executor' as const, persona: '做完交账', aspirations: ['把手头的事做完'] };

/** 预置 skill 的落点；与实现同口径，测试直接读文件。 */
function skillPath(ctx: HubContext, botId: string, id: string): string {
  return `${ctx.settings.rootDir}/bots/${botId}/.agents/skills/${id}/SKILL.md`;
}

describe('P40 默认空：与今天行为一致', () => {
  it('建队不勾选时 presetSkillIds 为空、不写任何 skill 文件、唤醒包无技能段', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, base);
    expect(bot.presetSkillIds).toEqual([]);
    for (const skill of PRESET_SKILLS) expect(await ctx.fs.readText(skillPath(ctx, bot.id, skill.id))).toBeNull();

    const turn = await turnContext('regular');
    expect(await buildWakePacket(turn.ctx, turn.bot, turn.entry, turn.ticket)).not.toContain('预置 skill');
  });

  it('旧档案缺 presetSkillIds：BotSchema.parse 补空数组，不需要迁移', () => {
    const { presetSkillIds: _omit, ...legacy } = botFixture;
    expect(BotSchema.parse(legacy).presetSkillIds).toEqual([]);
  });
});

describe('P40 物化与入口校验', () => {
  it('勾选后写 SKILL.md：开头是 DSH 要求的 YAML 头，并带标记、名称和用途', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['owner-brief', 'incident-triage'] });
    expect(bot.presetSkillIds).toEqual(['owner-brief', 'incident-triage']);
    const brief = await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'));
    expect(brief).toBe(renderPresetSkillFile(presetSkillById('owner-brief')!));
    expect(brief).toContain('<!-- dsh-buddy:preset-skill:owner-brief -->');
    expect(brief).toContain('给主人的简报');
    // DSH 按「文件开头的 YAML」识别技能，YAML 头必须在第一行，中心标记只能排在后面。
    expect(brief!.startsWith('---\nname: owner-brief\ndescription: "给主人的简报：')).toBe(true);
    expect(brief).not.toContain('加载条件');
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'incident-triage'))).toContain('name: incident-triage');
  });

  it('未知 id 在创建时报中文错误，且不留下半个机器人', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { ...base, presetSkillIds: ['no-such-skill'] })).rejects.toThrow('预置 skill：没有「no-such-skill」这一项');
    expect(ctx.store.table('bots').count()).toBe(0);
  });

  it('修改档案：未知 id 拒绝；重复 id 去重', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, base);
    await expect(updateBot(ctx, bot.id, { presetSkillIds: ['ghost'] })).rejects.toThrow('预置 skill');
    const updated = await updateBot(ctx, bot.id, { presetSkillIds: ['data-check', 'data-check'] });
    expect(updated.presetSkillIds).toEqual(['data-check']);
  });
});

describe('P40 删除只清清单内文件', () => {
  it('取消勾选删掉中心写入的文件与空目录', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['owner-brief'] });
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'))).not.toBeNull();
    await updateBot(ctx, bot.id, { presetSkillIds: [] });
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'))).toBeNull();
  });

  it('队友自建或改写过的 skill 不被清理', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['owner-brief', 'data-check'] });
    // 队友把中心写的文件改写成了自己的内容（标记没了），又加了一个自己的 skill。
    await ctx.fs.writeTextAtomic(skillPath(ctx, bot.id, 'owner-brief'), '# 我自己的简报套路\n');
    await ctx.fs.writeTextAtomic(`${ctx.settings.rootDir}/bots/${bot.id}/.agents/skills/my-own/SKILL.md`, '# 自建\n');
    await updateBot(ctx, bot.id, { presetSkillIds: [] });
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'))).toBe('# 我自己的简报套路\n');
    expect(await ctx.fs.readText(`${ctx.settings.rootDir}/bots/${bot.id}/.agents/skills/my-own/SKILL.md`)).toBe('# 自建\n');
    // 没被改过的中心文件照常清掉。
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'data-check'))).toBeNull();
  });
});

describe('P55 什么时候读由 DSH 决定', () => {
  it('每份技能的 YAML 头都合法：名字是短横线写法，description 能被 JSON 解析', () => {
    for (const skill of PRESET_SKILLS) {
      const lines = renderPresetSkillFile(skill).split('\n');
      expect(lines[0]).toBe('---');
      expect(lines[1]).toBe(`name: ${skill.id}`);
      expect(skill.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const description = JSON.parse(lines[2]!.replace('description: ', '')) as string;
      expect(description).toBe(`${skill.name}：${skill.purpose}`);
      expect(lines[3]).toBe('user-invocable: false');
      expect(lines[4]).toBe('---');
    }
  });

  it('勾选了技能，唤醒包也不再单独列技能，不重复占用额度', async () => {
    const turn = await turnContext('regular', { presetSkillIds: ['owner-brief', 'project-handoff', 'incident-triage'] });
    const packet = await buildWakePacket(turn.ctx, turn.bot, turn.entry, turn.ticket);
    expect(packet).not.toContain('给主人的简报');
    expect(packet).not.toContain('预置 skill');
    const light = await turnContext('light_check', { presetSkillIds: ['owner-brief'] });
    expect(await buildWakePacket(light.ctx, light.bot, light.entry, light.ticket)).not.toContain('给主人的简报');
  });

  it('旧文件（标记在第一行、没有 YAML 头）取消勾选时仍能被识别并清理', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['owner-brief'] });
    await ctx.fs.writeTextAtomic(skillPath(ctx, bot.id, 'owner-brief'), '<!-- dsh-buddy:preset-skill:owner-brief -->\n# 给主人的简报\n');
    await updateBot(ctx, bot.id, { presetSkillIds: [] });
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'))).toBeNull();
  });
});

describe('P40 视图', () => {
  it('设置视图给出只读候选清单且不含正文；机器人详情带勾选 id', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['data-check'] });
    const settings = await settingsView(ctx);
    expect(settings.presetSkillOptions).toHaveLength(PRESET_SKILLS.length);
    expect(settings.presetSkillOptions[0]).toEqual(expect.objectContaining({ id: 'owner-brief', name: '给主人的简报' }));
    expect(JSON.stringify(settings.presetSkillOptions)).not.toContain('交账或回复主人时');
    const view = await botView(ctx, bot.id);
    expect(view.profile.presetSkillIds).toEqual(['data-check']);
  });
});
