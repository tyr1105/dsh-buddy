/**
 * P75r2 第 2 节：教训、套路、长期记忆迁成技能：切句、分组、单条跳过，不让整次迁移失败；
 * 第 5 节：迁移时因在用名额放不下而收起的技能，说明写事实、接到同类的事时自动放回。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）；每条规则一个正例一个反例。
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { restoreCollapsedForCategory } from '../src/skill/store.js';
import { skillDetailView } from '../src/api/skill-views.js';
import { answerInbox, createInboxItem } from '../src/outreach/inbox.js';
import type { HubContext } from '../src/engine/context.js';
import type { Skill } from '../src/model/skill.js';
import {
  legacyWorld, putBlockingSkill, putMemoryMd, putRoutine, putRule, record, routineId, ruleId,
} from './p75r2-fixtures.js';

const size = (text: string) => [...text].length;
/** 某位员工名下某个名字的技能。 */
const skillOf = (ctx: HubContext, botId: string, title: string): Skill => {
  const row = ctx.store.table('skills').list(item => item.botId === botId && item.title === title)[0];
  if (!row) throw new Error(`没有技能「${title}」`);
  return row;
};
/** 一条技能当前版本的句子正文。 */
const sentencesOf = (ctx: HubContext, skill: Skill): string[] => ctx.store.table('skillVersions')
  .list(row => row.skillId === skill.id && row.no === skill.currentVersionNo)[0]!.sentences.map(row => row.text);
/** 一条技能当前版本各句出处的原文（去重）。 */
const quotesOf = (ctx: HubContext, skill: Skill): string[] => {
  const version = ctx.store.table('skillVersions').list(row => row.skillId === skill.id && row.no === skill.currentVersionNo)[0]!;
  return [...new Set(version.sentences.flatMap(row => row.sourceIds).map(id => ctx.store.table('skillSources').get(id)!.quote))];
};
/** 第 n 个互不相同的汉字串（无标点），用来造「约 200 字」的步骤。 */
const hanzi = (seed: number, length: number): string => Array.from({ length }, (_, index) => String.fromCharCode(0x4e00 + seed * 300 + index)).join('');

describe('P75r2 第 2.5 节：套路', () => {
  it('已删除员工的套路：迁移完成，别的数据都迁入，审计一条，不计入 skipped', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看' });
    putRoutine(ctx, routineId(1), { botId: 'b_0000000009', name: '已删员工的套路' });
    putRoutine(ctx, routineId(2), { botId: chiefBot.id, name: '核查来源' });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 0, lessons: 0, memoryFiles: 0 } });
    expect(ctx.store.table('memories').count()).toBe(1);
    expect(ctx.store.table('skills').list().map(row => row.title)).toEqual(['核查来源']);
    const skips = ctx.store.log('audit').all().filter(row => row.action === 'p75_migration_skip');
    expect(skips).toHaveLength(1);
    expect(skips[0]!.detail).toContain(routineId(1));
    // 没有告警（不计入跳过）。
    expect(ctx.store.table('alerts').count()).toBe(0);
  });

  it('5 步、每步约 200 字的套路：迁成两条技能，各句首尾相接等于各步骤原文，没有失败；续篇名称加（2）、编号相同', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    const steps = [1, 2, 3, 4, 5].map(seed => hanzi(seed, 200));
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '整理周报', whenToUse: '每周五下班前', steps, learnedFrom: 'session-1' });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null });
    const first = skillOf(ctx, chiefBot.id, '整理周报');
    const second = skillOf(ctx, chiefBot.id, '整理周报（2）');
    // 每步 200 字切成 80、80、40 三句：前四步 12 句装满第一条，第五步（3 句）另起一条，一个步骤不拆开。
    expect(sentencesOf(ctx, first)).toHaveLength(12);
    expect(sentencesOf(ctx, second)).toHaveLength(3);
    expect([...sentencesOf(ctx, first), ...sentencesOf(ctx, second)].join('')).toBe(steps.join(''));
    for (const sentence of [...sentencesOf(ctx, first), ...sentencesOf(ctx, second)]) expect(size(sentence)).toBeLessThanOrEqual(80);
    expect(quotesOf(ctx, first)).toEqual(steps.slice(0, 4));
    expect(quotesOf(ctx, second)).toEqual(steps.slice(4));
    expect(first.legacy).toEqual({ kind: 'routine', refId: routineId(1) });
    expect(second.legacy).toEqual({ kind: 'routine', refId: routineId(1) });
    expect(second.whenToUse).toBe(first.whenToUse);
    // 出处：续篇的种类与标签和首篇相同（learnedFrom 有值：你的指示）。
    const sourceOf = (skill: Skill) => ctx.store.table('skillSources').get(ctx.store.table('skillVersions').list(row => row.skillId === skill.id)[0]!.sentences[0]!.sourceIds[0]!)!;
    expect(sourceOf(first)).toMatchObject({ kind: 'owner_instruction', label: '你的指示（升级前教过的会话）' });
    expect(sourceOf(second)).toMatchObject({ kind: 'owner_instruction', label: '你的指示（升级前教过的会话）' });
    expect(ctx.store.table('alerts').count()).toBe(0);
  });

  it('反例：步骤不超限的套路仍是一条技能，名称不加后缀', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源', steps: ['打开原文', '核对日期', '写结论'] });
    await runP75Migration(ctx);
    expect(ctx.store.table('skills').list().map(row => row.title)).toEqual(['核查来源']);
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '核查来源'))).toEqual(['打开原文', '核对日期', '写结论']);
  });

  it('套路名、「什么时候用」里的换行和制表符换成一个空格；截取之后为空的写「做事时参考」', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '导出\t名单\n每周', whenToUse: '每周\n导出\t报名表', steps: ['打开报名表'] });
    putRoutine(ctx, routineId(2), { botId: other.id, name: '空说明', whenToUse: '\n\t \n', steps: ['打开报名表'] });
    await runP75Migration(ctx);
    const one = ctx.store.table('skills').list().find(row => row.botId === chiefBot.id)!;
    expect(one.title).toBe('导出 名单 每周');
    expect(one.whenToUse).toBe('每周 导出 报名表');
    expect(ctx.store.table('skills').list().find(row => row.botId === other.id)!.whenToUse).toBe('做事时参考');
  });
});

describe('P75r2 第 2.2 节：教训', () => {
  it('一位员工 30 条教训：迁成三条技能（12、12、6 句），名称依次是「我的做法」「（2）」「（3）」', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    for (let index = 0; index < 30; index += 1) putRule(ctx, ruleId(index + 1), { scope: chiefBot.id, source: 'lesson', text: `教训${String(index).padStart(2, '0')}：先核实再引用`, createdAt: 100 + index });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 0, lessons: 0, memoryFiles: 0 } });
    const titles = ['我的做法', '我的做法（2）', '我的做法（3）'];
    const lengths = titles.map(title => sentencesOf(ctx, skillOf(ctx, chiefBot.id, title)).length);
    expect(lengths).toEqual([12, 12, 6]);
    // 按教训原来的顺序排。
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '我的做法'))[0]).toBe('教训00：先核实再引用');
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '我的做法（3）')).at(-1)).toBe('教训29：先核实再引用');
    expect(ctx.store.table('skills').count()).toBe(3);
  });

  it('一条教训的各句不拆到两条技能里：7 条各 4 句的教训分成 3 + 3 + 1 条', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    const lessons = Array.from({ length: 7 }, (_, index) => hanzi(index + 1, 300)); // 300 字无标点 = 80、80、80、60 四句
    lessons.forEach((text, index) => putRule(ctx, ruleId(index + 1), { scope: chiefBot.id, source: 'lesson', text, createdAt: 100 + index }));
    await runP75Migration(ctx);
    const skills = ['我的做法', '我的做法（2）', '我的做法（3）'].map(title => skillOf(ctx, chiefBot.id, title));
    expect(skills.map(skill => sentencesOf(ctx, skill).length)).toEqual([12, 12, 4]);
    // 每条教训的原文只出现在一条技能的出处里。
    const owners = lessons.map(text => skills.filter(skill => quotesOf(ctx, skill).includes(text)).length);
    expect(owners).toEqual([1, 1, 1, 1, 1, 1, 1]);
    for (const [index, skill] of skills.entries()) expect(quotesOf(ctx, skill)).toEqual(lessons.slice(index * 3, index * 3 + 3));
  });

  it('一条 300 字的教训：一条技能、四句，各句首尾相接等于原文，出处原文是全文', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    const text = hanzi(9, 300);
    putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text });
    await runP75Migration(ctx);
    const skill = skillOf(ctx, chiefBot.id, '我的做法');
    expect(sentencesOf(ctx, skill).map(size)).toEqual([80, 80, 80, 60]);
    expect(sentencesOf(ctx, skill).join('')).toBe(text);
    expect(quotesOf(ctx, skill)).toEqual([text]);
    expect(ctx.store.table('skills').count()).toBe(1);
  });

  it('出处：主人接受过的教训提议写「你批准的提议（升级前）」，其余照现状；一条技能里两种出处并存，有批准的排在用名额的前面', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    // 一条提议中的教训，主人在「待你处理」里点了「接受」（真实路径：answerInbox 把规矩改成有效、条目记 answered / 接受）。
    ctx.store.table('rules').put({ id: ruleId(1), scope: chiefBot.id, text: '先跑一遍再交', redLine: false, source: 'lesson', status: 'proposed', createdAt: 5 });
    const item = createInboxItem(ctx, { botId: chiefBot.id, type: 'proposal', title: '教训：先跑一遍再交', body: 'why', subjectKey: 'proposal:p1', refId: ruleId(1) });
    await answerInbox(ctx, item.id, '接受');
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '接受', type: 'proposal', refId: ruleId(1) });
    expect(ctx.store.table('rules').get(ruleId(1))!.status).toBe('active');
    putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '引用先核实', createdAt: 6 });
    // 12 条更新的套路（来源不明）：在用名额只有 12 条，旧的那条「我的做法」要靠「批准过」排前。
    for (let index = 0; index < 12; index += 1) putRoutine(ctx, routineId(index + 1), { botId: chiefBot.id, name: `套路${String(index).padStart(2, '0')}`, updatedAt: 1000 + index });
    await runP75Migration(ctx);
    const skill = skillOf(ctx, chiefBot.id, '我的做法');
    expect(skill.state).toBe('active');
    const version = ctx.store.table('skillVersions').list(row => row.skillId === skill.id)[0]!;
    const sourceOfSentence = (text: string) => ctx.store.table('skillSources').get(version.sentences.find(row => row.text === text)!.sourceIds[0]!)!;
    expect(sourceOfSentence('先跑一遍再交')).toMatchObject({ kind: 'owner_instruction', label: '你批准的提议（升级前）', quote: '先跑一遍再交' });
    expect(sourceOfSentence('引用先核实')).toMatchObject({ kind: 'unknown', label: '迁移：升级前的规矩' });
    // 13 条里最旧的那条套路被收起，原因 migrated。
    const collapsed = ctx.store.table('skills').list(row => row.state === 'collapsed');
    expect(collapsed.map(row => row.title)).toEqual(['套路00']);
    expect(collapsed[0]!.collapseReason).toBe('migrated');
  });

  it('反例：没有被批准过的教训，「我的做法」排在后面，名额不够时被收起', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '引用先核实', createdAt: 6 });
    for (let index = 0; index < 12; index += 1) putRoutine(ctx, routineId(index + 1), { botId: chiefBot.id, name: `套路${String(index).padStart(2, '0')}`, updatedAt: 1000 + index });
    await runP75Migration(ctx);
    expect(skillOf(ctx, chiefBot.id, '我的做法').state).toBe('collapsed');
  });
});

describe('P75r2 第 2.4 节：长期记忆', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `第${String(index).padStart(2, '0')}条事实：报名表在共享盘第${index}个目录。`);

  it('20 行：只迁前 12 句，不并句；审计里有员工、总句数、迁入句数；全文在备份文件里', async () => {
    const { ctx, other } = await legacyWorld();
    const content = `# 长期记忆\n\n${lines(20).join('\n')}\n`;
    await putMemoryMd(ctx, other.homeDir, content);
    await runP75Migration(ctx);
    const skill = skillOf(ctx, other.id, '原长期记忆');
    expect(sentencesOf(ctx, skill)).toEqual(lines(12));
    const audits = ctx.store.log('audit').all().filter(row => row.action === 'p75_migration_memory_trimmed');
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.detail)).toEqual({ botId: other.id, total: 20, kept: 12 });
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', other.id, 'MEMORY.md'))).toBe(content);
    expect(record(ctx)!.skipped).toEqual({ routines: 0, lessons: 0, memoryFiles: 0 });
  });

  it('反例：恰好 12 行不写审计；只有标题和初始说明的文件不迁', async () => {
    const { ctx, other, chiefBot } = await legacyWorld();
    await putMemoryMd(ctx, other.homeDir, `# 长期记忆\n\n${lines(12).join('\n')}\n`);
    await runP75Migration(ctx);
    expect(sentencesOf(ctx, skillOf(ctx, other.id, '原长期记忆'))).toEqual(lines(12));
    expect(ctx.store.log('audit').all().some(row => row.action === 'p75_migration_memory_trimmed')).toBe(false);
    expect(ctx.store.table('skills').list().some(row => row.botId === chiefBot.id)).toBe(false);
  });
});

describe('P75r2 第 2.5 节：单条写不进只跳过这一条', () => {
  it('同名技能已存在让三类各有一条写不进：这几条被跳过、没有残行、别的照迁、skipped 的数对、告警写明各类各几条', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看' });
    // 员工一：两条教训（写「我的做法」时被同名占位拒绝）、一条套路被拒、一条套路写入成功。
    putRule(ctx, ruleId(11), { scope: chiefBot.id, source: 'lesson', text: '教训甲' });
    putRule(ctx, ruleId(12), { scope: chiefBot.id, source: 'lesson', text: '教训乙' });
    putBlockingSkill(ctx, chiefBot.id, '我的做法', 1);
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源' });
    putBlockingSkill(ctx, chiefBot.id, '核查来源', 2);
    putRoutine(ctx, routineId(2), { botId: chiefBot.id, name: '导出名单', steps: ['打开报名表', '导出为表格'] });
    // 员工二：长期记忆写不进。
    await putMemoryMd(ctx, other.homeDir, '# 长期记忆\n\n报名表在共享盘。\n');
    putBlockingSkill(ctx, other.id, '原长期记忆', 3);
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 1, lessons: 2, memoryFiles: 1 } });
    // 别的照迁：规矩、写入成功的那条套路。
    expect(ctx.store.table('memories').list().map(row => row.text)).toEqual(['先给主人看']);
    expect(ctx.store.table('skills').list().map(row => row.title).sort()).toEqual(['导出名单', '核查来源', '我的做法', '原长期记忆'].sort());
    const migrated = ctx.store.table('skills').list().filter(row => row.legacy !== null);
    expect(migrated.map(row => row.title)).toEqual(['导出名单']);
    // 没有残行：版本只有成功那条的一行；出处只有成功那条的两行（失败那几条为它们建的出处行都删了）。
    expect(ctx.store.table('skillVersions').count()).toBe(1);
    expect(ctx.store.table('skillSources').count()).toBe(2);
    expect(ctx.store.table('skillSources').list().map(row => row.quote).sort()).toEqual(['打开报名表', '导出为表格'].sort());
    // 审计：写入失败的三条各一条。
    expect(ctx.store.log('audit').all().filter(row => row.action === 'p75_migration_skip')).toHaveLength(3);
    // 告警：三类都有（逐字，级别 P2）。
    const alerts = ctx.store.table('alerts').list(alert => alert.code === 'p75:migration-skipped');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: 'P2', status: 'open',
      text: '升级时有1 条旧套路、2 条旧教训、1 位员工的原长期记忆没能整理进技能库，不再带给员工；原文仍保留在旧数据里。' });
    // 收尾仍然完成（旧长期记忆文件被改写、备份在）。
    expect(record(ctx)!.steps).toMatchObject({ backupMemory: true, refreshAll: true });
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', other.id, 'MEMORY.md'))).toBe('# 长期记忆\n\n报名表在共享盘。\n');
  });

  it('反例：没有任何一条写不进时 skipped 全为 0，不出这一句告警', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源' });
    await runP75Migration(ctx);
    expect(record(ctx)!.skipped).toEqual({ routines: 0, lessons: 0, memoryFiles: 0 });
    expect(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration-skipped')).toBe(0);
  });
});

describe('P75r2 第 5 节：迁移时收起的技能', () => {
  /** 13 条套路：最旧的一条被收起。 */
  async function overflowWorld() {
    const { ctx, chiefBot } = await legacyWorld();
    for (let index = 0; index < 13; index += 1) putRoutine(ctx, routineId(index + 1), { botId: chiefBot.id, name: `套路${String(index).padStart(2, '0')}`, updatedAt: 1000 + index });
    await runP75Migration(ctx);
    return { ctx, chiefBot, collapsed: skillOf(ctx, chiefBot.id, '套路00') };
  }

  it('详情里的说明逐字：升级时在用的技能超过 12 条，移到「不常用」。', async () => {
    const { ctx, collapsed } = await overflowWorld();
    expect(collapsed).toMatchObject({ state: 'collapsed', collapseReason: 'migrated' });
    expect(skillDetailView(ctx, collapsed.id).stateText).toBe('升级时在用的技能超过 12 条，移到「不常用」。');
  });

  it('反例：久未用收起的说明仍是原来的写法（含天数）', async () => {
    const { ctx, collapsed } = await overflowWorld();
    ctx.store.table('skills').patch(collapsed.id, { collapseReason: 'unused' });
    expect(skillDetailView(ctx, collapsed.id).stateText).toMatch(/^\d+ 天内没有用到，移到「不常用」。$/);
  });

  it('接到同类的事时自动放回：migrated 与 unused 同样对待；在用已满时不放回，只记审计', async () => {
    const { ctx, chiefBot, collapsed } = await overflowWorld();
    // 在用先腾出一个名额：把一条在用的收起（原因 merged，不会被放回）。
    const active = ctx.store.table('skills').list(row => row.botId === chiefBot.id && row.state === 'active');
    expect(active).toHaveLength(12);
    // 类别不同不放回。
    ctx.store.table('skills').patch(collapsed.id, { categories: ['调研报告'] });
    await restoreCollapsedForCategory(ctx, chiefBot.id, '表单页');
    expect(ctx.store.table('skills').get(collapsed.id)!.state).toBe('collapsed');
    // 在用已满：不放回，只记审计。
    ctx.store.table('skills').patch(collapsed.id, { categories: ['表单页'] });
    await restoreCollapsedForCategory(ctx, chiefBot.id, '表单页');
    expect(ctx.store.table('skills').get(collapsed.id)!.state).toBe('collapsed');
    expect(ctx.store.log('audit').all().some(row => row.action === 'skill_restore_skipped')).toBe(true);
    // 腾出名额之后放回。
    ctx.store.table('skills').patch(active[0]!.id, { state: 'collapsed', collapseReason: 'merged', collapsedAt: ctx.clock.now() });
    await restoreCollapsedForCategory(ctx, chiefBot.id, '表单页');
    expect(ctx.store.table('skills').get(collapsed.id)).toMatchObject({ state: 'active', collapseReason: null });
  });

  it('反例：来源不明、被合并的收起不放回（与 unused 的现有断言一致）', async () => {
    const { ctx, chiefBot, collapsed } = await overflowWorld();
    ctx.store.table('skills').patch(collapsed.id, { categories: ['表单页'], collapseReason: 'unknown_source' });
    ctx.store.table('skills').patch(skillOf(ctx, chiefBot.id, '套路12').id, { state: 'collapsed', collapseReason: 'merged', collapsedAt: 1 });
    await restoreCollapsedForCategory(ctx, chiefBot.id, '表单页');
    expect(ctx.store.table('skills').get(collapsed.id)!.state).toBe('collapsed');
  });
});
