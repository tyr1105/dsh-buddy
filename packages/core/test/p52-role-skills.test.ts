/**
 * P52 岗位专属预置 skill - core 测试。
 * 这批内容只是 P40 机制上的新条目，所以这里主要钉住三件事：
 * - 内容质量的底线：id 能当文件夹名、不重复、界面文案不带内部黑话、都写明不提高权限；
 * - 走的还是 P40 的路：能被勾选、能物化到家目录，DSH 的目录只拿到名称和用途；
 * - 界面拿得到「岗位专属」这个分组标记，但拿不到正文。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { settingsView } from '../src/api/feed-views.js';
import { PRESET_SKILLS, presetSkillById, presetSkillOptions, renderPresetSkillFile } from '../src/config/preset-skills.js';
import { ROLE_PRESET_SKILLS } from '../src/config/role-preset-skills.js';

/** 文案审计定下的禁用词：这些词不能出现在主人看得到的名称和用途里。 */
const JARGON = ['产物', '交账', '唤醒', '上下文', '治理', '投影', '额度保护', '套路'];

describe('P52 岗位专属技能的内容底线', () => {
  it('一共 13 条，id 可以安全地当文件夹名，且和通用项不重复', () => {
    expect(ROLE_PRESET_SKILLS).toHaveLength(13);
    for (const skill of ROLE_PRESET_SKILLS) expect(skill.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const ids = PRESET_SKILLS.map(skill => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('都标成岗位专属，通用项不受影响', () => {
    for (const skill of ROLE_PRESET_SKILLS) expect(skill.audience).toBe('role');
    expect(PRESET_SKILLS.slice(0, 4).map(skill => skill.id)).toEqual(['owner-brief', 'project-handoff', 'incident-triage', 'data-check']);
    expect(PRESET_SKILLS.slice(0, 4).every(skill => skill.audience === undefined)).toBe(true);
  });

  it('界面文案不带内部黑话，用途是一句短话', () => {
    for (const skill of ROLE_PRESET_SKILLS) {
      for (const word of JARGON) {
        expect(skill.name, `${skill.id} 的名称`).not.toContain(word);
        expect(skill.purpose, `${skill.id} 的用途`).not.toContain(word);
      }
      expect([...skill.purpose].length, `${skill.id} 的用途太长`).toBeLessThanOrEqual(40);
    }
  });

  it('每份正文都写明不提高工具权限', () => {
    for (const skill of ROLE_PRESET_SKILLS) expect(skill.content).toContain('不提高任何工具权限');
  });
});

describe('P52 沿用 P40 的物化规则', () => {
  it('勾选后写进家目录，内容带中心标记（清理时靠它识别）', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '工程师', role: 'executor', persona: '做完就说', aspirations: ['按时做完'], presetSkillIds: ['build-self-check', 'review-checklist'] });
    const path = `${ctx.settings.rootDir}/bots/${bot.id}/.agents/skills/build-self-check/SKILL.md`;
    expect(await ctx.fs.readText(path)).toBe(renderPresetSkillFile(presetSkillById('build-self-check')!));
    expect(await ctx.fs.readText(path)).toContain('<!-- dsh-buddy:preset-skill:build-self-check -->');
  });

  it('反例：清单里没有的 id 仍然被拒绝，岗位项没有放宽校验', async () => {
    const ctx = createTestContext();
    await expect(createBot(ctx, { name: '工程师', role: 'executor', persona: '做完就说', aspirations: ['按时做完'], presetSkillIds: ['fake-role-skill'] }))
      .rejects.toThrow('预置 skill');
  });

  it('YAML 头只有名称和用途，正文只在模型真正加载时才读到', () => {
    const file = renderPresetSkillFile(presetSkillById('acceptance-check')!);
    const header = file.slice(0, file.indexOf('\n---\n'));
    expect(header).toContain('逐项验收');
    expect(header).not.toContain('把验收项逐条列出来');
    expect(file).toContain('把验收项逐条列出来');
  });
});

describe('P52 回归：只改一个字段不能动其他档案', () => {
  // 新建队友时会紧接着单独存一次头像色。修之前这次保存会把刚选的技能清空，文件也被删掉。
  it('只存头像色：技能、技能文件和工作数据授权都保持原样', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '工程师', role: 'executor', persona: '做完就说', aspirations: ['按时做完'], presetSkillIds: ['build-self-check'] });
    await updateBot(ctx, bot.id, { workDataAllowed: true });
    const updated = await updateBot(ctx, bot.id, { color: '#10b981' });
    expect(updated.presetSkillIds).toEqual(['build-self-check']);
    expect(updated.workDataAllowed).toBe(true);
    expect(await ctx.fs.readText(`${ctx.settings.rootDir}/bots/${bot.id}/.agents/skills/build-self-check/SKILL.md`)).not.toBeNull();
  });

  it('反例：明确传空数组和 false 时仍然生效，取消勾选和收回授权没有被挡住', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '工程师', role: 'executor', persona: '做完就说', aspirations: ['按时做完'], presetSkillIds: ['build-self-check'] });
    await updateBot(ctx, bot.id, { workDataAllowed: true });
    const updated = await updateBot(ctx, bot.id, { presetSkillIds: [], workDataAllowed: false });
    expect(updated.presetSkillIds).toEqual([]);
    expect(updated.workDataAllowed).toBe(false);
  });
});

describe('P52 界面视图', () => {
  it('选项带分组标记但不带正文', async () => {
    const ctx = createTestContext();
    const settings = await settingsView(ctx);
    expect(settings.presetSkillOptions.find(option => option.id === 'prd-writing')?.audience).toBe('role');
    expect(settings.presetSkillOptions.find(option => option.id === 'owner-brief')?.audience).toBe('general');
    expect(JSON.stringify(presetSkillOptions())).not.toContain('把验收项逐条列出来');
  });
});
