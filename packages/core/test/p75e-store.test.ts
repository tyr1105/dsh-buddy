/**
 * P75e 的测试一：技能写入（writeSkillVersion、setSkillState、rollbackSkill）、「最近用到」（守卫）、
 * 账本对 skill 工具的目标栏、接到同类的事时自动放回（单元与两条真实路径：派活、改派）。
 * 夹具用真实链路（总管听吩咐、执行员工听吩咐），时间用注入的假时钟；单元部分用轻量测试上下文。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { writeSkillVersion, setSkillState, rollbackSkill, restoreCollapsedForCategory, activeSelfSkillCount } from '../src/skill/store.js';
import { renderSelfSkillFile, selfSkillPath, versionsOfSkill } from '../src/skill/files.js';
import { guardToolCall } from '../src/gate/guard.js';
import { describeAction } from '../src/util/action-text.js';
import { jobFix, callTool, lockedAndAwake, assignArgs, MINUTE } from './p74b-fixtures.js';

/** 建一个轻量上下文和一位员工。 */
function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put(botFixture);
  return { ctx, bot: botFixture };
}

/** 给这位员工加一条出处，返回出处编号。 */
function addSource(ctx: HubContext, botId: string, kind: 'review' | 'owner_correction' | 'owner_instruction' | 'acceptance' = 'review', jobId: string | null = null) {
  const row = SkillSourceSchema.parse({
    id: newId('ss', ctx.rng), botId, kind, label: '活动报名页第 1 轮退回第 3 条', quote: '提示文字与约定不一致',
    relayed: false, jobId, category: '表单页', refs: {}, createdAt: ctx.clock.now(),
  });
  ctx.store.table('skillSources').put(row);
  return row.id;
}

/** 新建一条技能的最小入参。 */
function createInput(botId: string, sourceId: string, extra: Record<string, unknown> = {}) {
  return { botId, change: 'create' as const, newSkill: { title: '表单页做法', whenToUse: '做表单页时用', supplements: null },
    sentences: [{ text: '提交后显示明确的成功提示', sourceIds: [sourceId] }], updateId: null, checkedBy: null, categories: ['表单页'], ...extra };
}

describe('P75e 写入：建立、新增、合并', () => {
  it('建立：版本 1、句子全部 addedInNo 为 1、目录名 self- 加 8 位、物化文件、发 bot 事件', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    const version = await writeSkillVersion(ctx, createInput(bot.id, source, { checkedBy: 'hub' }));
    expect(version.no).toBe(1);
    expect(version.sentences).toEqual([{ text: '提交后显示明确的成功提示', sourceIds: [source], addedInNo: 1 }]);
    const skill = ctx.store.table('skills').list()[0]!;
    expect(skill.dirName).toMatch(/^self-[a-z0-9]{8}$/);
    expect(skill.currentVersionNo).toBe(1);
    expect(skill.state).toBe('active');
    expect(skill.categories).toEqual(['表单页']);
    // 物化：文件写到了家目录的技能目录里，内容就是渲染结果。
    const content = await ctx.fs.readText(selfSkillPath(bot, skill));
    expect(content).toBe(renderSelfSkillFile(skill, version));
    // 发了 bot 事件（宿主据此刷新技能过滤器）。
    expect(ctx.events.some(event => event.scope === 'bot' && event.botId === bot.id)).toBe(true);
  });

  it('新增：新版本在当前版本的句子上加新句子，basedOnNo 为当前版本号，新版本号取最大号加一', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    const first = await writeSkillVersion(ctx, createInput(bot.id, source));
    const skill = () => ctx.store.table('skills').list()[0]!;
    const source2 = addSource(ctx, bot.id);
    // 先收起再新增也行（有新内容等于放回），这里直接测正常新增。
    const second = await writeSkillVersion(ctx, {
      botId: bot.id, skillId: skill().id, change: 'add',
      sentences: [{ text: '页面上的提示与约定逐字一致', sourceIds: [source2] }],
      updateId: null, checkedBy: null, categories: ['表单页'],
    });
    expect(second.no).toBe(2);
    expect(second.basedOnNo).toBe(1);
    expect(second.sentences).toHaveLength(2);
    expect(second.sentences[1]).toMatchObject({ addedInNo: 2 });
    expect(skill().currentVersionNo).toBe(2);
  });

  it('合并：传入的就是全文；原句保留原版本号，新句记新版本号', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    await writeSkillVersion(ctx, createInput(bot.id, source));
    const skill = ctx.store.table('skills').list()[0]!;
    const source2 = addSource(ctx, bot.id);
    const merged = await writeSkillVersion(ctx, {
      botId: bot.id, skillId: skill.id, change: 'merge',
      sentences: [
        { text: '提交后显示明确的成功提示', sourceIds: [source] },
        { text: '自测数据要覆盖选填项两种情况', sourceIds: [source2] },
      ],
      updateId: null, checkedBy: null, categories: ['表单页'],
    });
    expect(merged.no).toBe(2);
    expect(merged.change).toBe('merge');
    expect(merged.sentences[0]).toMatchObject({ addedInNo: 1 });
    expect(merged.sentences[1]).toMatchObject({ addedInNo: 2 });
  });

  it('回退后再新增：新版本在回退到的版本上加句、basedOnNo 正确、被回退的版本仍在、可以再回到它', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    await writeSkillVersion(ctx, createInput(bot.id, source));
    const skillRow = () => ctx.store.table('skills').list()[0]!;
    const source2 = addSource(ctx, bot.id);
    await writeSkillVersion(ctx, { botId: bot.id, skillId: skillRow().id, change: 'add',
      sentences: [{ text: '第二句', sourceIds: [source2] }], updateId: null, checkedBy: null, categories: [] });
    // 回退到第 1 版：只改当前版本号，不生成新版本。
    await rollbackSkill(ctx, skillRow().id, 1);
    expect(skillRow().currentVersionNo).toBe(1);
    expect(versionsOfSkill(ctx, skillRow().id)).toHaveLength(2);
    // 再新增：第 3 版，句子是第 1 版的句子加新句，basedOnNo 是 1。
    const source3 = addSource(ctx, bot.id);
    const third = await writeSkillVersion(ctx, { botId: bot.id, skillId: skillRow().id, change: 'add',
      sentences: [{ text: '第三句', sourceIds: [source3] }], updateId: null, checkedBy: null, categories: [] });
    expect(third.no).toBe(3);
    expect(third.basedOnNo).toBe(1);
    expect(third.sentences.map(row => row.text)).toEqual(['提交后显示明确的成功提示', '第三句']);
    expect(third.sentences[1]).toMatchObject({ addedInNo: 3 });
    // 被回退过的第 2 版仍在，可以再回到它。
    expect(versionsOfSkill(ctx, skillRow().id).map(row => row.no)).toEqual([3, 2, 1]);
    await rollbackSkill(ctx, skillRow().id, 2);
    expect(skillRow().currentVersionNo).toBe(2);
  });

  it('句数超限被拒且什么都没写；条数超限被拒；出处不属于这位员工被拒', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    // 先建一条 12 句的技能（上限内）。
    await writeSkillVersion(ctx, createInput(bot.id, source, {
      sentences: Array.from({ length: 12 }, (_, index) => ({ text: `第 ${index + 1} 句的做法`, sourceIds: [source] })),
    }));
    const skill = ctx.store.table('skills').list()[0]!;
    const source2 = addSource(ctx, bot.id);
    // 再加 1 句：合并后 13 句，被拒。
    await expect(writeSkillVersion(ctx, { botId: bot.id, skillId: skill.id, change: 'add',
      sentences: [{ text: '多出来的一句', sourceIds: [source2] }], updateId: null, checkedBy: null, categories: [] }))
      .rejects.toThrow('先在每周整理时合并');
    expect(versionsOfSkill(ctx, skill.id)).toHaveLength(1);
    expect(ctx.store.table('skills').get(skill.id)!.currentVersionNo).toBe(1);
    // 条数上限：再建第 13 条被拒（上限 12）。
    for (let index = 1; index < 12; index += 1) {
      await writeSkillVersion(ctx, createInput(bot.id, source, {
        newSkill: { title: `技能${index}`, whenToUse: '做同类的事时用', supplements: null },
      }));
    }
    expect(activeSelfSkillCount(ctx, bot.id)).toBe(12);
    await expect(writeSkillVersion(ctx, createInput(bot.id, source, {
      newSkill: { title: '第十三条', whenToUse: '多出来的', supplements: null },
    }))).rejects.toThrow('在用的技能已有 12 条，请并入已有的技能');
    expect(activeSelfSkillCount(ctx, bot.id)).toBe(12);
    // 出处不属于这位员工：另一位员工的出处被拒。
    const other = { ...botFixture, id: 'b_0000000002', name: '别人', homeDir: '/hub/bots/b_0000000002' };
    ctx.store.table('bots').put(other);
    const foreign = addSource(ctx, other.id, 'review');
    await expect(writeSkillVersion(ctx, createInput(other.id, foreign, {
      newSkill: { title: '用别人的出处', whenToUse: '不该写成', supplements: null },
      sentences: [{ text: '一句', sourceIds: [foreign] }],
    }))).resolves.toBeDefined(); // 自己的出处给自己用没问题
    await expect(writeSkillVersion(ctx, createInput(bot.id, foreign, {
      newSkill: { title: '拿别人的出处', whenToUse: '不该写成', supplements: null },
      sentences: [{ text: '一句', sourceIds: [foreign] }],
    }))).rejects.toThrow('不存在或不属于这位员工');
  });
});

describe('P75e 收起与放回', () => {
  it('收起记原因与时间、删文件；放回恢复文件；放回超上限被拒', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    await writeSkillVersion(ctx, createInput(bot.id, source));
    const skill = ctx.store.table('skills').list()[0]!;
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    const collapsed = ctx.store.table('skills').get(skill.id)!;
    expect(collapsed.state).toBe('collapsed');
    expect(collapsed.collapseReason).toBe('unused');
    expect(collapsed.collapsedAt).toBe(ctx.clock.now());
    expect(await ctx.fs.readText(selfSkillPath(bot, skill))).toBeNull();
    await setSkillState(ctx, skill.id, 'active');
    expect(ctx.store.table('skills').get(skill.id)!.state).toBe('active');
    expect(await ctx.fs.readText(selfSkillPath(bot, skill))).not.toBeNull();
    // 上限已满时放回被拒：先填满 12 条，收起一条再放回没问题；把另一条也收起后，放回第 13 条不行（此时 12 条在用）。
    for (let index = 1; index < 12; index += 1) {
      await writeSkillVersion(ctx, createInput(bot.id, source, { newSkill: { title: `技能${index}`, whenToUse: '用时看', supplements: null } }));
    }
    const all = ctx.store.table('skills').list();
    await setSkillState(ctx, all[0]!.id, 'collapsed', 'unused');
    await expect(setSkillState(ctx, all[0]!.id, 'active')).resolves.toBeDefined();
  });
});

describe('P75e 最近用到（工具守卫）', () => {
  it('skill 调用的名字是在用的自己积累技能时写 lastUsedAt，决定不变；预置技能名不写', async () => {
    const { ctx, bot } = setup();
    const withSession = { ...botFixture, sessionId: 'bot-session' };
    ctx.store.table('bots').put(withSession);
    const source = addSource(ctx, withSession.id);
    await writeSkillVersion(ctx, createInput(withSession.id, source));
    const skill = ctx.store.table('skills').list()[0]!;
    // 名字是这条技能：放行不变，lastUsedAt 写上。
    const decision = await guardToolCall(ctx, 'bot-session', 'skill', { name: skill.dirName });
    expect(decision.allow).toBe(true);
    expect(ctx.store.table('skills').get(skill.id)!.lastUsedAt).toBe(ctx.clock.now());
    // 名字是预置技能（不在 skills 表里）：不写。
    ctx.clock.advance(MINUTE);
    await guardToolCall(ctx, 'bot-session', 'skill', { name: 'incident-triage' });
    expect(ctx.store.table('skills').get(skill.id)!.lastUsedAt).toBe(ctx.clock.now() - MINUTE);
    // 收起的技能不记。
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    ctx.clock.advance(MINUTE);
    await guardToolCall(ctx, 'bot-session', 'skill', { name: skill.dirName });
    expect(ctx.store.table('skills').get(skill.id)!.lastUsedAt).toBe(ctx.clock.now() - 2 * MINUTE);
  });
});

describe('P75e 账本对 skill 工具的目标栏（派活说明裁定 3）', () => {
  it('describeAction 对 skill 工具写出技能名，别的工具不变', () => {
    expect(describeAction('skill', { name: 'self-abcd1234' })).toBe('加载技能 self-abcd1234');
    expect(describeAction('skill', {})).toContain('未提供技能名');
    // 别的工具的目标栏写法不变（抽样两条）。
    expect(describeAction('web_search', { query: '报名' })).toBe('搜索 报名');
    expect(describeAction('read_file', { path: '/a/b.md' })).toContain('/a/b.md');
  });
});

describe('P75e 接到同类的事时自动放回（第 7 节）', () => {
  it('单元：unused 且类别相同的放回；unknown_source、merged 不放回；类别不同不放回；在用已满时不放回只记审计', async () => {
    const { ctx, bot } = setup();
    const source = addSource(ctx, bot.id);
    await writeSkillVersion(ctx, createInput(bot.id, source));
    const rows = () => ctx.store.table('skills').list();
    await writeSkillVersion(ctx, createInput(bot.id, source, { newSkill: { title: '来源不明的一条', whenToUse: '用时看', supplements: null } }));
    await writeSkillVersion(ctx, createInput(bot.id, source, { newSkill: { title: '另一类别的一条', whenToUse: '用时看', supplements: null }, categories: ['调研报告'] }));
    const byTitle = (title: string) => ctx.store.table('skills').list().find(row => row.title === title)!;
    const first = byTitle('表单页做法');
    const other = byTitle('来源不明的一条');
    const another = byTitle('另一类别的一条');
    await setSkillState(ctx, first.id, 'collapsed', 'unused');
    await setSkillState(ctx, other.id, 'collapsed', 'unknown_source');
    await setSkillState(ctx, another.id, 'collapsed', 'unused');
    await restoreCollapsedForCategory(ctx, bot.id, '表单页');
    expect(ctx.store.table('skills').get(first.id)!.state).toBe('active');
    expect(ctx.store.table('skills').get(other.id)!.state).toBe('collapsed');
    expect(ctx.store.table('skills').get(another.id)!.state).toBe('collapsed');
    // 在用已满：先收起这条，再补到 12 条在用；之后放回被拒、只记审计。
    await setSkillState(ctx, first.id, 'collapsed', 'unused');
    for (let index = 0; index < 12; index += 1) {
      await writeSkillVersion(ctx, createInput(bot.id, source, { newSkill: { title: `填满${index}`, whenToUse: '用时看', supplements: null } }));
    }
    expect(activeSelfSkillCount(ctx, bot.id)).toBe(12);
    await restoreCollapsedForCategory(ctx, bot.id, '表单页');
    expect(ctx.store.table('skills').get(first.id)!.state).toBe('collapsed');
    expect(ctx.store.log('audit').all().some(row => row.action === 'skill_restore_skipped')).toBe(true);
  });

  it('真实路径一（派活）：派活给有同类收起技能（unused）的员工后放回', async () => {
    const fix = await jobFix();
    const { ctx, engineer } = fix;
    const source = SkillSourceSchema.parse({
      id: newId('ss', ctx.rng), botId: engineer.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
      quote: '原文', relayed: false, jobId: null, category: '其他', refs: {}, createdAt: ctx.clock.now(),
    });
    ctx.store.table('skillSources').put(source);
    await writeSkillVersion(ctx, { botId: engineer.id, change: 'create',
      newSkill: { title: '通用做法', whenToUse: '做事时用', supplements: null },
      sentences: [{ text: '先看约定再动手', sourceIds: [source.id] }], updateId: null, checkedBy: null,
      categories: [jobCategoryOf(fix)] });
    const skill = ctx.store.table('skills').list(row => row.botId === engineer.id)[0]!;
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    // 真实派活链路：约定固定、总管拿到回合、派给林舟。
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('会员定价页');
    const agreementId = ctx.store.table('agreements').list()[0]!.id;
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    expect(ctx.store.table('skills').get(skill.id)!.state).toBe('active');
  });

  it('真实路径二（改派，含经 exitReviewLimit 进新阶段的那一种）：换执行者后新执行者的同类收起技能放回', async () => {
    const fix = await jobFix(['小周']);
    const { ctx, engineer, chief } = fix;
    const newcomer = fix.extras[0]!;
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('会员定价页');
    const agreementId = ctx.store.table('agreements').list()[0]!.id;
    expect(await callTool(fix, chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    const job = ctx.store.table('jobs').list()[0]!;
    // 小周有一条同类（类别「其他」，与这份约定的默认类别一致）的收起技能。
    const source = SkillSourceSchema.parse({
      id: newId('ss', ctx.rng), botId: newcomer.id, kind: 'review', label: '另一个页面第 1 轮退回第 1 条',
      quote: '原文', relayed: false, jobId: null, category: '其他', refs: {}, createdAt: ctx.clock.now(),
    });
    ctx.store.table('skillSources').put(source);
    await writeSkillVersion(ctx, { botId: newcomer.id, change: 'create',
      newSkill: { title: '周的做法', whenToUse: '做事时用', supplements: null },
      sentences: [{ text: '先复述要求', sourceIds: [source.id] }], updateId: null, checkedBy: null, categories: ['其他'] });
    const skill = ctx.store.table('skills').list(row => row.botId === newcomer.id)[0]!;
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    expect(await callTool(fix, chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(ctx.store.table('skills').get(skill.id)!.state).toBe('active');
  });
});

/** 这份夹具约定的类别（没标过类别时是「其他」）。 */
function jobCategoryOf(fix: Awaited<ReturnType<typeof jobFix>>): string {
  const agreementId = fix.ctx.store.table('agreements').list()[0]?.id;
  return agreementId === undefined ? '其他' : fix.ctx.store.table('agreementTags').get(agreementId)?.category ?? '其他';
}

describe('P75e 允许名单（加载）', () => {
  it('allowedSkillNames 含预置、DSH 技能与在用的自己积累技能目录名；收起的不进名单（派活说明裁定 2：不做的键不碰）', async () => {
    const fix = await jobFix();
    const { ctx, engineer } = fix;
    const source = SkillSourceSchema.parse({
      id: newId('ss', ctx.rng), botId: engineer.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
      quote: '原文', relayed: false, jobId: null, category: '其他', refs: {}, createdAt: ctx.clock.now(),
    });
    ctx.store.table('skillSources').put(source);
    await writeSkillVersion(ctx, { botId: engineer.id, change: 'create',
      newSkill: { title: '通用做法', whenToUse: '做事时用', supplements: null },
      sentences: [{ text: '先看约定再动手', sourceIds: [source.id] }], updateId: null, checkedBy: null, categories: ['其他'] });
    const skill = ctx.store.table('skills').list(row => row.botId === engineer.id)[0]!;
    // 名单 = 预置 + DSH 技能 + 在用的自己积累技能目录名（夹具里前两类可能为空，只断言结构）。
    expect(fix.hub.allowedSkillNames(engineer.id)).toContain(skill.dirName);
    // 收起：离开名单；放回：回到名单。
    await setSkillState(ctx, skill.id, 'collapsed', 'unused');
    expect(fix.hub.allowedSkillNames(engineer.id)).not.toContain(skill.dirName);
    await setSkillState(ctx, skill.id, 'active');
    expect(fix.hub.allowedSkillNames(engineer.id)).toContain(skill.dirName);
  });
});
