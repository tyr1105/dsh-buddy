/**
 * P75e 的测试二：技能文件的物化（renderSelfSkillFile、syncSelfSkills）、预置同步不碰 self- 目录、
 * 回合结束核对（verifyManagedFiles：恢复、搬走杂项、不计越界、私聊没有新消息）。
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { PRESET_SKILLS, presetSkillMarker } from '../src/config/preset-skills.js';
import { writeSkillVersion, setSkillState } from '../src/skill/store.js';
import { renderSelfSkillFile, selfSkillPath, syncSelfSkills, selfSkillMarker } from '../src/skill/files.js';
import { syncPresetSkills } from '../src/memory/preset-skills.js';
import { verifyManagedFiles } from '../src/memory/files.js';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';

/** 轻量上下文 + 一位员工 + 一条在用技能（含出处）。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, presetSkillIds: ['owner-brief', 'data-check'], dshSkillNames: [] };
  ctx.store.table('bots').put(bot);
  const source = SkillSourceSchema.parse({
    id: newId('ss', ctx.rng), botId: bot.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
    quote: '提示文字与约定不一致', relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: ctx.clock.now(),
  });
  ctx.store.table('skillSources').put(source);
  await writeSkillVersion(ctx, {
    botId: bot.id, change: 'create', newSkill: { title: '表单页做法', whenToUse: '做表单页时用', supplements: null },
    sentences: [{ text: '提交后显示明确的成功提示', sourceIds: [source.id] }, { text: '先校验必填项', sourceIds: [source.id] }],
    updateId: null, checkedBy: null, categories: ['表单页'],
  });
  return { ctx, bot, source };
}

describe('P75e 物化：文件格式', () => {
  it('YAML 头三项、中心标记、编号句子、不含出处', async () => {
    const { ctx, bot } = await setup();
    const skill = ctx.store.table('skills').list()[0]!;
    const content = (await ctx.fs.readText(selfSkillPath(bot, skill)))!;
    const lines = content.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '---',
      `name: ${skill.dirName}`,
      `description: ${JSON.stringify('表单页做法：做表单页时用')}`,
      'user-invocable: false',
      '---',
    ]);
    expect(content).toContain(selfSkillMarker(skill.id, 1));
    expect(content).toContain('# 表单页做法');
    expect(content).toContain('做表单页时用');
    expect(content).toContain('1. 提交后显示明确的成功提示');
    expect(content).toContain('2. 先校验必填项');
    // 不写出处（出处给主人看，不进提示词）。
    expect(content).not.toContain('活动报名页');
    expect(content).not.toContain(sourceLabelQuote());
  });

  it('字节超限时从最后一句往前删并写明未列出的句数', async () => {
    const { ctx, bot } = await setup();
    const skill = ctx.store.table('skills').list()[0]!;
    // 直接用纯函数构造一个超长版本。P75r3 第 6 节把文件上限放宽到 4 KB（满额 12 句 × 80 字放得下），
    // 所以这里每句改成 200 字（纯函数不过 schema），才能撑过上限、继续验证「从最后一句往前删」。
    const longVersion = {
      ...ctx.store.table('skillVersions').list()[0]!,
      sentences: Array.from({ length: 12 }, (_, index) => ({
        text: '很'.repeat(200) + index, sourceIds: [ctx.store.table('skillSources').list()[0]!.id], addedInNo: 2,
      })),
    };
    const content = renderSelfSkillFile(skill, longVersion);
    const bytes = new TextEncoder().encode(content).length;
    expect(bytes).toBeLessThanOrEqual(SKILL_DEFAULTS.SKILL_FILE_MAX_BYTES);
    expect(content).toContain('（另有 ');
    expect(content).toContain(' 句未列出）');
    // 没超限时正常全列、没有那一行。
    const normal = renderSelfSkillFile(skill, ctx.store.table('skillVersions').list()[0]!);
    expect(normal).not.toContain('句未列出');
  });
});

function sourceLabelQuote(): string {
  return '提示文字与约定不一致';
}

describe('P75e 物化：同步行为', () => {
  it('内容相同不重写；收起删文件、放回恢复；只删带标记的文件', async () => {
    const { ctx, bot } = await setup();
    const skill = ctx.store.table('skills').list()[0]!;
    const path = selfSkillPath(bot, skill);
    // 内容相同：不再写。
    expect((await syncSelfSkills(ctx, bot)).written).toEqual([]);
    // 员工在同一个目录里放的别的文件不带标记：收起时不删。
    const extra = posix.join(bot.homeDir, '.agents/skills', skill.dirName, 'notes.md');
    await ctx.fs.writeTextAtomic(extra, '员工自己的笔记', { within: bot.homeDir });
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    expect(await ctx.fs.readText(path)).toBeNull();
    expect(await ctx.fs.readText(extra)).toBe('员工自己的笔记');
    // 放回：文件恢复。
    await setSkillState(ctx, skill.id, 'active');
    expect(await ctx.fs.readText(path)).toContain('表单页做法');
    expect(await ctx.fs.readText(extra)).toBe('员工自己的笔记');
  });

  it('预置同步不碰 self- 目录；预置清单的 id 不以 self- 开头', async () => {
    const { ctx, bot } = await setup();
    const skill = ctx.store.table('skills').list()[0]!;
    const path = selfSkillPath(bot, skill);
    const before = await ctx.fs.readText(path);
    await syncPresetSkills(ctx, bot);
    expect(await ctx.fs.readText(path)).toBe(before);
    // 预置清单断言：id 一律不以 self- 开头（加载时 config 里有断言，这里再从数据侧验一遍）。
    expect(PRESET_SKILLS.length).toBeGreaterThan(0);
    expect(PRESET_SKILLS.every(item => !item.id.startsWith('self-'))).toBe(true);
    // 预置技能文件带的是预置标记，不是自己积累的标记。
    const presetContent = await ctx.fs.readText(posix.join(bot.homeDir, '.agents/skills', 'owner-brief', 'SKILL.md'));
    expect(presetContent).toContain(presetSkillMarker('owner-brief'));
    expect(presetContent).not.toContain('dsh-buddy:self-skill:');
  });

  it('refreshBotFiles 末尾会同步自己积累的技能（写进中心刷新链路）', async () => {
    const { ctx, bot } = await setup();
    const skill = ctx.store.table('skills').list()[0]!;
    const path = selfSkillPath(bot, skill);
    // 模拟文件丢失：删掉之后跑中心刷新，文件应被补上。
    await ctx.fs.remove(posix.dirname(path), { within: bot.homeDir });
    const { refreshBotFiles } = await import('../src/memory/files.js');
    await refreshBotFiles(ctx, bot.id);
    expect(await ctx.fs.readText(path)).toContain('表单页做法');
  });
});

describe('P75e 回合结束核对（verifyManagedFiles）', () => {
  // P75r3 第 2 节改了预期：原来「dshSkillNames 里的同名目录不动」，现在 DSH 技能由 DSH 自己从它的技能目录加载，
  // 家目录里不应有同名目录，一律搬走（所以搬走的审计从 1 条变成 2 条）。
  it('改过的技能文件被恢复；新建的无标记目录被移走并有审计；dshSkillNames 里的同名目录同样被移走；不计越界、私聊没有新消息', async () => {
    const { ctx } = await setup();
    const bot = ctx.store.table('bots').get(botFixture.id)!;
    const skill = ctx.store.table('skills').list()[0]!;
    const path = selfSkillPath(bot, skill);
    const expected = await ctx.fs.readText(path);
    // 1. 员工改了中心的技能文件。
    await ctx.fs.writeTextAtomic(path, '被员工改掉的内容', { within: bot.homeDir });
    // 2. 员工新建了一个没有中心标记的目录。
    const strayDir = posix.join(bot.homeDir, '.agents/skills', 'my-own-skill');
    await ctx.fs.mkdirp(strayDir, { within: bot.homeDir });
    await ctx.fs.writeTextAtomic(posix.join(strayDir, 'SKILL.md'), '员工自己写的技能', { within: bot.homeDir });
    // 3. DSH 技能名单里的同名目录：P75r3 起同样搬走。
    ctx.store.table('bots').patch(bot.id, { dshSkillNames: ['dsh-kept'] });
    const keptDir = posix.join(bot.homeDir, '.agents/skills', 'dsh-kept');
    await ctx.fs.mkdirp(keptDir, { within: bot.homeDir });
    await ctx.fs.writeTextAtomic(posix.join(keptDir, 'SKILL.md'), '入职时选的 DSH 技能', { within: bot.homeDir });

    const violationsBefore = bot.violations;
    const messagesBefore = ctx.store.log('thread').all().length;
    await verifyManagedFiles(ctx, bot.id);

    // 改过的文件恢复成中心版本；无标记目录被搬走；DSH 技能名的同名目录也被搬走（原来是原地不动）。
    expect(await ctx.fs.readText(path)).toBe(expected);
    expect(await ctx.fs.readText(posix.join(keptDir, 'SKILL.md'))).toBeNull();
    const moved = ctx.store.log('audit').all().filter(row => row.action === 'stray_skill_moved');
    expect(moved.map(row => JSON.parse(row.detail).dir).sort()).toEqual(['dsh-kept', 'my-own-skill']);
    const own = moved.find(row => JSON.parse(row.detail).dir === 'my-own-skill')!;
    expect(JSON.parse(own.detail)).toMatchObject({ botId: bot.id, dir: 'my-own-skill' });
    expect(JSON.parse(own.detail).to).toContain(posix.join(SKILL_DEFAULTS.STRAY_DIR, bot.id));
    // 搬走的文件还在（留档，主人想看还看得到）。
    const to = JSON.parse(own.detail).to as string;
    expect(await ctx.fs.readText(posix.join(to, 'SKILL.md'))).toBe('员工自己写的技能');
    expect(await ctx.fs.list(posix.join(bot.homeDir, '.agents/skills'))).not.toContain('my-own-skill');
    // 不计越界、不在私聊落消息。
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(violationsBefore);
    expect(ctx.store.log('thread').all().length).toBe(messagesBefore);
  });

  it('预置技能文件被改也会恢复（预置与自己积累都算「中心应有的」）', async () => {
    const { ctx } = await setup();
    const bot = ctx.store.table('bots').get(botFixture.id)!;
    await syncPresetSkills(ctx, bot);
    const presetPath = posix.join(bot.homeDir, '.agents/skills', 'owner-brief', 'SKILL.md');
    const expected = await ctx.fs.readText(presetPath);
    await ctx.fs.writeTextAtomic(presetPath, '改掉预置技能', { within: bot.homeDir });
    await ctx.fs.remove(posix.join(bot.homeDir, '.agents/skills', 'data-check', 'SKILL.md'), { within: bot.homeDir });
    await verifyManagedFiles(ctx, bot.id);
    expect(await ctx.fs.readText(presetPath)).toBe(expected);
    expect(await ctx.fs.readText(posix.join(bot.homeDir, '.agents/skills', 'data-check', 'SKILL.md'))).toContain('数据核对');
  });
});
