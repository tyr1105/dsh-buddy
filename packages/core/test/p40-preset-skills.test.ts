/**
 * P40 队友可选预置 skill - core 测试。
 * 覆盖：
 * - 默认空数组：建队不写任何 skill 文件，唤醒包不出现技能段，行为与未接入时一致；
 * - 物化：勾选后写 `bots/<id>/.agents/skills/<id>/SKILL.md`，内容带标记、名称、用途与条件；
 * - 入口校验：未知 id 在创建/修改档案时报中文错误；
 * - 三档加载条件：每次唤醒恒列；仅项目工作看本轮任务；特定任务类型按关键词命中；
 * - 删除：只清理带中心标记的文件，队友自建/改写过的 skill 不碰；
 * - 视图：设置视图给出只读候选清单（不含正文），机器人详情带勾选 id。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { botView } from '../src/api/bot-view.js';
import { settingsView } from '../src/api/feed-views.js';
import { saveProject, saveTask } from '../src/project/service.js';
import { assignTask } from '../src/project/assign.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { buildPresetSkillsSection, presetSkillActive } from '../src/wake/preset-skills.js';
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
  it('勾选后写 SKILL.md：带标记、名称、用途与加载条件', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['owner-brief', 'incident-triage'] });
    expect(bot.presetSkillIds).toEqual(['owner-brief', 'incident-triage']);
    const brief = await ctx.fs.readText(skillPath(ctx, bot.id, 'owner-brief'));
    expect(brief).toBe(renderPresetSkillFile(presetSkillById('owner-brief')!));
    expect(brief).toContain('<!-- dsh-buddy:preset-skill:owner-brief -->');
    expect(brief).toContain('给主人的简报');
    expect(brief).toContain('加载条件：每次唤醒');
    expect(await ctx.fs.readText(skillPath(ctx, bot.id, 'incident-triage'))).toContain('加载条件：特定任务类型');
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

describe('P40 三档加载条件', () => {
  const everyWake = presetSkillById('owner-brief')!;
  const projectWork = presetSkillById('project-handoff')!;
  const taskType = presetSkillById('incident-triage')!;

  it('每次唤醒恒命中；仅项目工作看本轮任务；特定任务类型按关键词', () => {
    expect(presetSkillActive(everyWake, { projectWork: false, triggerText: '', lightCheck: true })).toBe(true);
    expect(presetSkillActive(projectWork, { projectWork: false, triggerText: '', lightCheck: false })).toBe(false);
    expect(presetSkillActive(projectWork, { projectWork: true, triggerText: '', lightCheck: false })).toBe(true);
    expect(presetSkillActive(taskType, { projectWork: false, triggerText: '整理资料', lightCheck: false })).toBe(false);
    expect(presetSkillActive(taskType, { projectWork: false, triggerText: '排查数据日报异常', lightCheck: false })).toBe(true);
  });

  it('常规唤醒：项目任务命中关键词时三档全列；轻复查只列每次唤醒档', async () => {
    const turn = await turnContext('regular', { presetSkillIds: ['owner-brief', 'project-handoff', 'incident-triage'] });
    const project = saveProject(turn.ctx, { name: '数据日报项目', memberBotIds: [turn.bot.id] });
    const task = saveTask(turn.ctx, { projectId: project.id, title: '排查数据日报半夜报错' });
    assignTask(turn.ctx, { taskId: task.id, botId: turn.bot.id });

    const packet = await buildWakePacket(turn.ctx, turn.bot, turn.entry, turn.ticket);
    expect(packet).toContain('给主人的简报');
    expect(packet).toContain('项目交接核对');
    expect(packet).toContain('异常排查四步');
    // 只列名称、用途与条件，不塞正文。
    expect(packet).not.toContain('交账或回复主人时，按这个顺序写');

    const light = await turnContext('light_check', { presetSkillIds: ['owner-brief', 'project-handoff', 'incident-triage'] });
    const lightPacket = await buildWakePacket(light.ctx, light.bot, light.entry, light.ticket);
    expect(lightPacket).toContain('给主人的简报');
    expect(lightPacket).not.toContain('项目交接核对');
    expect(lightPacket).not.toContain('异常排查四步');
  });

  it('常规唤醒没有项目任务且理由不含关键词：只列每次唤醒档', async () => {
    const turn = await turnContext('regular', { presetSkillIds: ['owner-brief', 'project-handoff', 'incident-triage'] });
    const section = buildPresetSkillsSection(turn.bot, { projectWork: false, triggerText: '核对资料变化', lightCheck: false })!;
    expect(section.body).toContain('给主人的简报');
    expect(section.body).not.toContain('项目交接核对');
    expect(section.body).not.toContain('异常排查四步');
    expect(section.body).toContain('不改变工具权限');
  });

  it('一项都没命中时整段省略', () => {
    const turn = botFixture;
    expect(buildPresetSkillsSection({ ...turn, presetSkillIds: [] }, { projectWork: false, triggerText: '', lightCheck: false })).toBeNull();
  });
});

describe('P40 视图', () => {
  it('设置视图给出只读候选清单且不含正文；机器人详情带勾选 id', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { ...base, presetSkillIds: ['data-check'] });
    const settings = await settingsView(ctx);
    expect(settings.presetSkillOptions).toHaveLength(PRESET_SKILLS.length);
    expect(settings.presetSkillOptions[0]).toEqual(expect.objectContaining({ id: 'owner-brief', conditionLabel: '每次唤醒' }));
    expect(JSON.stringify(settings.presetSkillOptions)).not.toContain('交账或回复主人时');
    const view = await botView(ctx, bot.id);
    expect(view.profile.presetSkillIds).toEqual(['data-check']);
  });
});
