/**
 * P75r3 第 4、6、7、8 节的测试：
 * - 4 写技能之前先校验完（不合格时三张表的行数都不变；收起技能写新版本时检查在用上限）；
 * - 6 技能文件上限放得下满额技能（12 句 × 80 字）；
 * - 7 句子、标题、「什么时候用」不接受换行等控制字符；
 * - 8 员工视图里的长期记忆摘录恢复截断。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSchema, SkillSentenceSchema, SkillSourceSchema, SkillVersionSchema } from '../src/model/skill.js';
import { writeSkillVersion, setSkillState } from '../src/skill/store.js';
import { selfSkillPath } from '../src/skill/files.js';
import { createBotHome } from '../src/memory/index.js';
import { botView } from '../src/api/bot-view.js';
import { SKILL_DEFAULTS as D } from '../src/config/defaults.js';
import { byteLength } from '../src/util/text.js';

/** 一位员工和一条出处。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, presetSkillIds: [], dshSkillNames: [] as string[] };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const source = SkillSourceSchema.parse({
    id: newId('ss', ctx.rng), botId: bot.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
    quote: '提示文字与约定不一致', relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: ctx.clock.now(),
  });
  ctx.store.table('skillSources').put(source);
  const create = (title: string, sentences: Array<{ text: string; sourceIds: string[] }>, whenToUse = '做这类事时用') => writeSkillVersion(ctx, {
    botId: bot.id, change: 'create', newSkill: { title, whenToUse, supplements: null }, sentences, updateId: null, checkedBy: null, categories: [],
  });
  const ok = (text = '先校验必填项') => ({ text, sourceIds: [source.id] });
  const counts = () => [ctx.store.table('skills').count(), ctx.store.table('skillVersions').count(), ctx.store.table('skillSources').count()];
  return { ctx, bot, source, create, ok, counts };
}

describe('P75r3 第 4 节：写技能之前先校验完', () => {
  it('四种不合格的输入（单句超长、空句、零句、某句没有出处）：抛错，skills、skillVersions、skillSources 的行数都没有变', async () => {
    const { create, ok, counts } = await setup();
    const before = counts();
    await expect(create('超长句', [ok('长'.repeat(D.SENTENCE_MAX_CHARS + 1))])).rejects.toThrow();
    await expect(create('空句', [ok('   ')])).rejects.toThrow();
    await expect(create('零句', [])).rejects.toThrow();
    await expect(create('没有出处', [{ text: '一句话', sourceIds: [] }])).rejects.toThrow();
    expect(counts()).toEqual(before);
  });
  it('反例：合格的输入写入一条技能、一个版本', async () => {
    const { create, ok, counts } = await setup();
    await create('合格', [ok()]);
    expect(counts()).toEqual([1, 1, 1]);
  });
  it('给已有技能新增句子时不合格的输入同样不留任何痕迹', async () => {
    const { ctx, bot, create, ok, counts } = await setup();
    await create('已有', [ok()]);
    const skill = ctx.store.table('skills').list()[0]!;
    const before = counts();
    const add = (sentences: Array<{ text: string; sourceIds: string[] }>) => writeSkillVersion(ctx, {
      botId: bot.id, skillId: skill.id, change: 'add', sentences, updateId: null, checkedBy: null, categories: [] });
    await expect(add([ok('长'.repeat(D.SENTENCE_MAX_CHARS + 1))])).rejects.toThrow();
    await expect(add([{ text: '没有出处', sourceIds: [] }])).rejects.toThrow();
    expect(counts()).toEqual(before);
    expect(ctx.store.table('skills').get(skill.id)!.currentVersionNo).toBe(1);
  });
  it('对收起的技能写新版本时检查在用上限（放回也不能超过上限）', async () => {
    const { ctx, bot, create, ok } = await setup();
    for (let n = 1; n <= D.SELF_ACTIVE_MAX; n += 1) await create(`技能${n}`, [ok(`第${n}条做法`)]);
    const first = ctx.store.table('skills').list(row => row.title === '技能1')[0]!;
    await setSkillState(ctx, first.id, 'collapsed', 'unused');
    await create('补位的技能', [ok('补位')]); // 收起一条、新建一条：又满了
    expect(ctx.store.table('skills').count(row => row.state === 'active')).toBe(D.SELF_ACTIVE_MAX);
    const versionsBefore = ctx.store.table('skillVersions').count();
    await expect(writeSkillVersion(ctx, { botId: bot.id, skillId: first.id, change: 'add', sentences: [ok('收起之后又有的新内容')], updateId: null, checkedBy: null, categories: [] }))
      .rejects.toThrow(`在用的技能已有 ${D.SELF_ACTIVE_MAX} 条`);
    expect(ctx.store.table('skillVersions').count()).toBe(versionsBefore);
    expect(ctx.store.table('skills').get(first.id)!.state).toBe('collapsed');
    // 反例：在用条数没满时，对收起的技能写新版本等于放回。
    const other = ctx.store.table('skills').list(row => row.title === '技能2')[0]!;
    await setSkillState(ctx, other.id, 'collapsed', 'unused');
    await writeSkillVersion(ctx, { botId: bot.id, skillId: first.id, change: 'add', sentences: [ok('现在放得下了')], updateId: null, checkedBy: null, categories: [] });
    expect(ctx.store.table('skills').get(first.id)!.state).toBe('active');
  });
});

describe('P75r3 第 6 节：技能文件的上限放得下满额的技能', () => {
  it('上限是 4 KB', () => {
    expect(D.SKILL_FILE_MAX_BYTES).toBe(4096);
  });
  it('12 句、每句 80 个汉字：写出的文件里 12 句一句不少，中心标记和文件头都在', async () => {
    const { ctx, bot, source, create } = await setup();
    const sentences = Array.from({ length: D.SENTENCES_MAX }, (_, index) => ({ text: `${String(index + 1).padStart(2, '0')}${'很'.repeat(D.SENTENCE_MAX_CHARS - 2)}`, sourceIds: [source.id] }));
    await create('满额的技能', sentences);
    const skill = ctx.store.table('skills').list()[0]!;
    const content = (await ctx.fs.readText(selfSkillPath(bot, skill)))!;
    for (let index = 0; index < D.SENTENCES_MAX; index += 1) expect(content).toContain(`${index + 1}. ${sentences[index]!.text}`);
    expect(content).not.toContain('句未列出');
    expect(content.startsWith(`---\nname: ${skill.dirName}\n`)).toBe(true);
    expect(content).toContain(`<!-- dsh-buddy:self-skill:${skill.id}:v1 -->`);
    expect(content).toContain('user-invocable: false');
    expect(byteLength(content)).toBeLessThanOrEqual(D.SKILL_FILE_MAX_BYTES);
  });
});

describe('P75r3 第 7 节：标题类字段不接受换行', () => {
  const sentence = (text: string) => SkillSentenceSchema.safeParse({ text, sourceIds: ['ss_0000000001'], addedInNo: 1 });
  const skillWith = (patch: Record<string, unknown>) => SkillSchema.safeParse({
    id: 'sk_0000000001', botId: 'b_0000000001', title: '表单页做法', whenToUse: '做表单页时用', supplements: null, dirName: 'self-00000001',
    state: 'active', collapseReason: null, currentVersionNo: 1, categories: [], lastUsedAt: null, legacy: null, createdAt: 1, updatedAt: 1, collapsedAt: null, ...patch });

  it('句子带换行、回车、制表符被拒，错误文字是中文', () => {
    for (const bad of ['第一行\n第二行', '第一行\r第二行', '前\t后', '带\u0000控制字符', '带 行分隔符']) {
      const result = sentence(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('必须是单行文字');
    }
  });
  it('标题带换行被拒；「什么时候用」带换行被拒', () => {
    expect(skillWith({ title: '标题\n另起一行' }).success).toBe(false);
    expect(skillWith({ whenToUse: '什么时候用\n<!-- dsh-buddy:self-skill:x:v1 -->' }).success).toBe(false);
    expect(skillWith({ title: '标题\r' }).error!.issues[0]!.message).toContain('单行');
  });
  it('正常的句子、标题、「什么时候用」不受影响（含中英文标点、空格）', () => {
    expect(sentence('提交后显示「成功」提示，不要用 alert() 弹窗。').success).toBe(true);
    expect(skillWith({}).success).toBe(true);
    expect(skillWith({ title: 'A b 表单页', whenToUse: '做表单页、展示页时用。' }).success).toBe(true);
  });
  it('出处原文可以是多行（原样抄出，不进技能文件，不受限）', () => {
    const base = { id: 'ss_0000000001', botId: 'b_0000000001', kind: 'review', label: '第 1 轮退回', quote: '第一行\n第二行', relayed: false, jobId: null, category: null, refs: {}, createdAt: 1 };
    expect(SkillSourceSchema.safeParse(base).success).toBe(true);
    expect(SkillSourceSchema.safeParse({ ...base, label: '带\n换行的标签' }).success).toBe(false);
  });
  it('经 writeSkillVersion 写入时同样被拒，且不留残行', async () => {
    const { create, ok, counts } = await setup();
    const before = counts();
    await expect(create('合格的标题', [ok('一行\n两行')])).rejects.toThrow('单行');
    await expect(create('标题\n换行', [ok()])).rejects.toThrow('单行');
    await expect(create('合格的标题', [ok()], '什么时候用\n换行')).rejects.toThrow('单行');
    expect(counts()).toEqual(before);
  });
  it('版本 schema 也拒绝带换行的句子', () => {
    expect(SkillVersionSchema.safeParse({ id: 'skv_0000000001', skillId: 'sk_0000000001', no: 1,
      sentences: [{ text: '甲\n乙', sourceIds: ['ss_0000000001'], addedInNo: 1 }], change: 'create', updateId: null, basedOnNo: null, checkedBy: null, createdAt: 1 }).success).toBe(false);
  });
});

describe('P75r3 第 8 节：员工视图里的长期记忆摘录恢复截断', () => {
  it('超过上限时按整行截到上限以内，末尾写明已截断；短文件原样', async () => {
    const { ctx, bot } = await setup();
    const limit = ctx.settings.memorySummaryMaxBytes;
    expect(limit).toBe(1536);
    const lines = Array.from({ length: 80 }, (_, index) => `第${String(index + 1).padStart(2, '0')}条事实：报名表在共享盘的第 ${index + 1} 个目录里。`);
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/memory/MEMORY.md`, `${lines.join('\n')}\n`);
    const excerpt = (await botView(ctx, bot.id)).memoryExcerpt;
    expect(byteLength(excerpt)).toBeLessThanOrEqual(limit);
    expect(excerpt.endsWith('…（已截断）')).toBe(true);
    // 整行截：保留下来的每一行都是原文里完整的一行，并且是从头开始连续的。
    const kept = excerpt.split('\n').slice(0, -1);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept).toEqual(lines.slice(0, kept.length));
    // 反例：不超过上限的内容原样给出。
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/memory/MEMORY.md`, '只有一句长期记忆。\n');
    expect((await botView(ctx, bot.id)).memoryExcerpt).toBe('只有一句长期记忆。');
  });
  it('单行就超过上限时退回按字节截断，仍不超上限', async () => {
    const { ctx, bot } = await setup();
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/memory/MEMORY.md`, '记'.repeat(2000));
    const excerpt = (await botView(ctx, bot.id)).memoryExcerpt;
    expect(byteLength(excerpt)).toBeLessThanOrEqual(ctx.settings.memorySummaryMaxBytes);
    expect(excerpt.endsWith('…（已截断）')).toBe(true);
  });
});
