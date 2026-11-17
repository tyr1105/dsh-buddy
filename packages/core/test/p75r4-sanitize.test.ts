/**
 * P75r4 第 2、5、6、7 节的测试（迁移）：
 * - 第 2 节：旧数据里的制表符等控制字符不再让整组技能被跳过；预检直接用技能的结构校验；一条套路几篇时写不进一篇就整条撤掉；
 * - 第 5 节：旧候选的清理补一种（回合变体是复盘、事项键不带新前缀的）；
 * - 第 6 节：单条跳过的审计带上原因；
 * - 第 7 节：整次回滚与单条跳过交错；单条跳过时清理留下的技能行。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）；每条规则一个正例一个反例。
 */
import { describe, expect, it } from 'vitest';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { prepareSentences } from '../src/migrate/p75-plan.js';
import { cleanControl } from '../src/migrate/p75-split.js';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { SkillSentenceSchema, type Skill } from '../src/model/skill.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { newId } from '../src/util/ids.js';
import type { HubContext } from '../src/engine/context.js';
import { legacyWorld, putBlockingSkill, putMemoryMd, putRoutine, putRule, record, routineId, ruleId } from './p75r2-fixtures.js';

/** 某位员工名下某个名字的技能。 */
const skillOf = (ctx: HubContext, botId: string, title: string): Skill => {
  const row = ctx.store.table('skills').list(item => item.botId === botId && item.title === title)[0];
  if (!row) throw new Error(`没有技能「${title}」`);
  return row;
};
/** 一条技能当前版本的句子正文。 */
const sentencesOf = (ctx: HubContext, skill: Skill): string[] => ctx.store.table('skillVersions')
  .list(row => row.skillId === skill.id && row.no === skill.currentVersionNo)[0]!.sentences.map(row => row.text);
const auditsOf = (ctx: HubContext, action: string) => ctx.store.log('audit').all().filter(row => row.action === action);

describe('P75r4 第 2 节：控制字符不再让整组技能被跳过（复验 N1 的复现）', () => {
  it('带制表符的步骤、教训、长期记忆行都迁入，skipped 三个数都是 0，没有问题的那条教训也在', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '表格整理', steps: ['第一列\t第二列', '核对日期'] });
    putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text: '先看\t再写' });
    putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '正常的一条教训' });
    await putMemoryMd(ctx, chiefBot.homeDir, '# 长期记忆\n\n报名表\t在共享盘。\n周报周五交。\n');
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 0, lessons: 0, memoryFiles: 0 } });
    // 制表符各换成一个空格。
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '表格整理'))).toEqual(['第一列 第二列', '核对日期']);
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '我的做法'))).toEqual(['先看 再写', '正常的一条教训']);
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '原长期记忆'))).toEqual(['报名表 在共享盘。', '周报周五交。']);
    expect(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration-skipped')).toBe(0);
    expect(auditsOf(ctx, 'p75_migration_skip')).toHaveLength(0);
  });

  it('名称、「什么时候用」里带行分隔符、NUL 的套路照常迁入（每个控制字符各换成一个空格，换完为空的用默认说法）', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '名 字', whenToUse: '资料\u0000变化时', steps: ['打开原文'] });
    putRoutine(ctx, routineId(2), { botId: chiefBot.id, name: '\u0001\u0002', whenToUse: '\u0001', steps: ['核对日期'] });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', skipped: { routines: 0, lessons: 0, memoryFiles: 0 } });
    const first = skillOf(ctx, chiefBot.id, '名 字');
    expect(first.whenToUse).toBe('资料 变化时');
    // 名称换完为空：用「旧套路」；「什么时候用」换完为空：用「做事时参考」。
    expect(skillOf(ctx, chiefBot.id, '旧套路').whenToUse).toBe('做事时参考');
  });

  it('控制字符的集合与技能字段拒绝的集合逐字符一致（改一边忘了另一边会失败）', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // 单独的代理项不是字符
      const sample = `甲${String.fromCharCode(code)}乙`;
      const rejectedBySchema = !SkillSentenceSchema.shape.text.safeParse(sample).success;
      const changedByClean = cleanControl(sample) !== sample;
      expect(changedByClean, `U+${code.toString(16)}`).toBe(rejectedBySchema);
    }
    expect(cleanControl('\t甲\u0001\u0002乙 ')).toBe('甲  乙');
  });

  it('预检不过的只丢这一句：同一条教训里别的句子、同一位员工别的教训照迁；原因写进审计（反例：全合格时没有审计）', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text: `好句子甲。\n${'长'.repeat(100)}\n好句子乙。` });
    putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '长'.repeat(100) });
    putRule(ctx, ruleId(3), { scope: chiefBot.id, source: 'lesson', text: '正常的一条' });
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源', steps: ['打开原文', '长'.repeat(100), '核对日期'] });
    // 切句器读的是 SKILL_DEFAULTS 的当前值，技能结构里的上限在加载时已定下：临时放宽切句器的上限，造出「切句之后仍超长」的句子。
    const defaults = SKILL_DEFAULTS as { SENTENCE_MAX_CHARS: number };
    const original = defaults.SENTENCE_MAX_CHARS;
    defaults.SENTENCE_MAX_CHARS = 200;
    try { await runP75Migration(ctx); } finally { defaults.SENTENCE_MAX_CHARS = original; }
    // 第二条教训的句子全被丢掉：丢这一条（计入 1 条旧教训），第一条、第三条教训的合格句子照迁。
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 0, lessons: 1, memoryFiles: 0 } });
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '我的做法'))).toEqual(['好句子甲。', '好句子乙。', '正常的一条']);
    expect(sentencesOf(ctx, skillOf(ctx, chiefBot.id, '核查来源'))).toEqual(['打开原文', '核对日期']);
    const reasons = auditsOf(ctx, 'p75_migration_skip').map(row => JSON.parse(row.detail) as { reason?: string });
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    expect(reasons.every(item => typeof item.reason === 'string' && item.reason.includes('不能超过 80 字'))).toBe(true);
  });

  it('prepareSentences：控制字符换成空格；换完为空的丢弃且不算不合格；超长的只丢这一句并给出原因', () => {
    expect(prepareSentences('甲\t乙\n\u0001\n丙')).toEqual({ kept: ['甲 乙', '丙'], dropped: [] });
    const defaults = SKILL_DEFAULTS as { SENTENCE_MAX_CHARS: number };
    const original = defaults.SENTENCE_MAX_CHARS;
    defaults.SENTENCE_MAX_CHARS = 200;
    try {
      const prepared = prepareSentences(`甲。\n${'长'.repeat(90)}\n乙。`);
      expect(prepared.kept).toEqual(['甲。', '乙。']);
      expect(prepared.dropped).toEqual(['不能超过 80 字']);
    } finally { defaults.SENTENCE_MAX_CHARS = original; }
  });

  it('一条套路分成两篇、第二篇写不进时：第一篇被撤掉，技能库里没有这条套路的一半，计数按一条', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    // 13 个步骤各一句：装不进一条技能（最多 12 句），分成两篇；第二篇的名称是「长流程（2）」，先放一条同名占位让它写不进。
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '长流程', steps: Array.from({ length: 13 }, (_, index) => `第${index + 1}步做完`) });
    putBlockingSkill(ctx, chiefBot.id, '长流程（2）', 1);
    putRoutine(ctx, routineId(2), { botId: chiefBot.id, name: '短流程', steps: ['打开原文'] });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 1, lessons: 0, memoryFiles: 0 } });
    // 技能库里只有占位和写入成功的「短流程」；「长流程」的第一篇已撤掉，没有残行。
    expect(ctx.store.table('skills').list().map(row => row.title).sort()).toEqual(['短流程', '长流程（2）'].sort());
    expect(ctx.store.table('skills').count(row => row.legacy?.refId === routineId(1))).toBe(0);
    expect(ctx.store.table('skillVersions').count()).toBe(1);
    expect(ctx.store.table('skillSources').count()).toBe(1);
    expect(ctx.store.table('alerts').list(alert => alert.code === 'p75:migration-skipped')[0]!.text)
      .toBe('升级时有1 条旧套路没能整理进技能库，不再带给员工；原文仍保留在旧数据里。');
    // 反例：两篇都写得进时，两篇都在，计数为 0（另见 p75r2-skills 里 13 条以上的情形）。
    const clean = await legacyWorld();
    putRoutine(clean.ctx, routineId(1), { botId: clean.chiefBot.id, name: '长流程', steps: Array.from({ length: 13 }, (_, index) => `第${index + 1}步做完`) });
    await runP75Migration(clean.ctx);
    expect(record(clean.ctx)).toMatchObject({ skipped: { routines: 0, lessons: 0, memoryFiles: 0 } });
    expect(clean.ctx.store.table('skills').count()).toBe(2);
  });
});

describe('P75r4 第 5 节：旧候选的清理补一种', () => {
  /** 往队列里放一条候选：唤醒原因种类与回合变体、事项键都由调用方给（旧混合队列里两者可以不一致）。 */
  function putMixed(ctx: HubContext, botId: string, kind: 'next_think' | 'reflection', variant: 'regular' | 'reflection', subjectKey: string) {
    const candidate = buildCandidate(ctx, { botId, kind, variant, score: 1, summary: `${kind}/${variant}`, subjectKey });
    ctx.store.table('queue').put({ ...candidate, id: newId('q', ctx.rng), enqueuedAt: ctx.clock.now() });
  }
  const keys = (ctx: HubContext) => ctx.store.table('queue').list().map(row => row.subjectKey).sort();

  it('变体是复盘、事项键不带新前缀的候选被丢弃（不论原因种类），审计 p75_dropped_reflection；带 retro:、skillcheck:、tidy: 前缀的不丢', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    putMixed(ctx, chiefBot.id, 'next_think', 'reflection', 'old:mixed');           // 原因种类不是复盘、变体是复盘：丢
    putMixed(ctx, other.id, 'next_think', 'reflection', 'retro:r1:keep');          // 带前缀：不丢
    putMixed(ctx, other.id, 'next_think', 'reflection', 'skillcheck:r1:keep');
    putMixed(ctx, chiefBot.id, 'next_think', 'reflection', 'tidy:2026-11-09:keep');
    await runP75Migration(ctx);
    expect(keys(ctx)).toEqual(['retro:r1:keep', 'skillcheck:r1:keep', 'tidy:2026-11-09:keep']);
    expect(auditsOf(ctx, 'p75_dropped_reflection')).toHaveLength(1);
  });

  it('反例：变体是常规、原因种类也不是复盘的候选不动', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putMixed(ctx, chiefBot.id, 'next_think', 'regular', 'old:regular');
    await runP75Migration(ctx);
    expect(keys(ctx)).toEqual(['old:regular']);
    expect(auditsOf(ctx, 'p75_dropped_reflection')).toHaveLength(0);
  });
});

describe('P75r4 第 6 节：跳过的审计带上原因', () => {
  it('单条写不进时，p75_migration_skip 的审计写明错误文字（只进审计，告警里没有）', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text: '教训甲' });
    putBlockingSkill(ctx, chiefBot.id, '我的做法', 1);
    await runP75Migration(ctx);
    const skips = auditsOf(ctx, 'p75_migration_skip').map(row => JSON.parse(row.detail) as { note: string; reason: string });
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toContain('已有一条叫「我的做法」的技能');
    expect(skips[0]!.note).toContain('已有一条叫「我的做法」的技能');
    const alertText = ctx.store.table('alerts').list(alert => alert.code === 'p75:migration-skipped')[0]!.text;
    expect(alertText).not.toContain('已有一条叫');
  });
});

describe('P75r4 第 7 节：复验用临时探针确认过的两种情形', () => {
  it('7.1 整次回滚与单条跳过交错：前面一条被跳过、后面整次失败，新表只剩迁移之前就有的行；去掉故障重试完成；再跑一次不重复迁入', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    // 迁移之前就有的行：两条占位技能（同时让两条计划写不进）。
    putBlockingSkill(ctx, chiefBot.id, '我的做法', 1);
    putBlockingSkill(ctx, other.id, '坏套路', 2);
    putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text: '教训甲' }); // 第一条被跳过
    putRoutine(ctx, routineId(1), { botId: other.id, name: '好套路', steps: ['打开原文'], updatedAt: ctx.clock.now() + 10 }); // 写得进
    putRoutine(ctx, routineId(2), { botId: other.id, name: '坏套路', steps: ['核对日期'], updatedAt: 1 }); // 第二条被跳过：此时存储故障
    const before = ctx.store.table('skills').list().map(row => row.id).sort();
    // 第二条写入失败的审计时存储故障（第一条的审计正常）。
    const realLog = ctx.store.log.bind(ctx.store);
    let faulty = true;
    let storageSkips = 0;
    ctx.store.log = ((name: 'audit') => {
      const log = realLog(name);
      if (name !== 'audit') return log;
      return { ...log, append: (row: { action: string; detail: string }) => {
        if (faulty && row.action === 'p75_migration_skip' && row.detail.includes('写入失败')) { storageSkips += 1; if (storageSkips === 2) throw new Error('磁盘故障'); }
        return (log.append as (value: unknown) => unknown)(row);
      } };
    }) as never;
    await runP75Migration(ctx);
    expect(storageSkips).toBe(2);
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(record(ctx)!.error).toContain('磁盘故障');
    // 新表只剩迁移之前就有的行（写进的「好套路」连同它的版本、出处都撤掉了）。
    expect(ctx.store.table('skills').list().map(row => row.id).sort()).toEqual(before);
    expect(ctx.store.table('skillVersions').count()).toBe(0);
    expect(ctx.store.table('skillSources').count()).toBe(0);
    expect(ctx.store.table('memories').count()).toBe(0);
    // 去掉故障后重试：完成，「好套路」迁入一次。
    faulty = false;
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null });
    expect(ctx.store.table('skills').count(row => row.title === '好套路')).toBe(1);
    const afterRetry = ctx.store.table('skills').count();
    const versions = ctx.store.table('skillVersions').count();
    // 再跑一次：不重复迁入。
    await runP75Migration(ctx);
    expect(ctx.store.table('skills').count()).toBe(afterRetry);
    expect(ctx.store.table('skillVersions').count()).toBe(versions);
  });

  it('7.2 单条跳过时清理留下的技能行：技能已写入、随后的收起失败，技能、版本、出处都没有残行；别的照迁', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    // 13 条套路：在用名额 12 条，最旧的一条先写、先收起；让「收起」这一步失败（技能行已写入）。
    for (let n = 1; n <= 13; n += 1) putRoutine(ctx, routineId(n), { botId: chiefBot.id, name: `套路${n}`, steps: [`第${n}条的步骤`], updatedAt: n });
    const realTable = ctx.store.table.bind(ctx.store);
    ctx.store.table = ((name: string) => {
      const table = realTable(name as 'skills');
      if (name !== 'skills') return table;
      return new Proxy(table, { get(target, prop) {
        if (prop === 'patch') return (id: string, patch: { state?: string }) => {
          if (patch.state === 'collapsed') throw new Error('收起时存储出错');
          return (target.patch as (a: string, b: unknown) => unknown)(id, patch);
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }) as never;
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null, skipped: { routines: 1, lessons: 0, memoryFiles: 0 } });
    // 被跳过的是最旧的「套路1」：它的技能行、版本行、出处行都没有留下。
    expect(ctx.store.table('skills').count()).toBe(12);
    expect(ctx.store.table('skills').count(row => row.title === '套路1')).toBe(0);
    expect(ctx.store.table('skills').count(row => row.legacy?.refId === routineId(1))).toBe(0);
    expect(ctx.store.table('skillVersions').count()).toBe(12);
    expect(ctx.store.table('skillSources').count()).toBe(12);
    expect(ctx.store.table('skillSources').count(row => row.quote === '第1条的步骤')).toBe(0);
    const skip = auditsOf(ctx, 'p75_migration_skip').map(row => JSON.parse(row.detail) as { reason: string });
    expect(skip).toHaveLength(1);
    expect(skip[0]!.reason).toContain('收起时存储出错');
  });
});
