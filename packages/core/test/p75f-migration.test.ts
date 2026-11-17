/**
 * P75f 迁移测试（任务卡第 6 节 1–8 条，口径照派活说明第一节：迁移记录 done 之前旧规矩表一并生效）。
 * 夹具用注入时钟与内存文件；旧表数据直接写进 store，模拟升级前的存量。
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { LEGACY_MEMORY_NOTICE } from '../src/memory/files.js';
import { renderBotAgentsMd } from '../src/memory/render.js';
import { legacyRulesInEffect } from '../src/memory/memory-read.js';
import { writeMemory } from '../src/memory/service.js';
import { refreshBotFiles, verifyManagedFiles } from '../src/memory/files.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { botFixture, id } from './model-fixtures.js';
import type { HubContext } from '../src/engine/context.js';
import type { Rule, Routine } from '../src/model/team.js';

const INITIAL_MEMORY_MD = '# 长期记忆\n\n只记录已经确认、适合长期保留的事实与经验。\n';

/** 建一个带两位员工的旧世界：home 已建、MEMORY.md 是初始两行、没有迁移记录。 */
async function legacyWorld() {
  const ctx = createTestContext();
  const bots = [botFixture, { ...botFixture, id: 'b_0000000002', name: '评审甲', homeDir: '/hub/bots/b_0000000002' }];
  for (const bot of bots) {
    ctx.store.table('bots').put({ ...bot, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    await ctx.fs.mkdirp(posix.join(bot.homeDir, 'memory'), { within: bot.homeDir });
    await ctx.fs.writeTextAtomic(posix.join(bot.homeDir, 'memory', 'MEMORY.md'), INITIAL_MEMORY_MD, { within: bot.homeDir });
  }
  return { ctx, chiefBot: bots[0]!, other: bots[1]! };
}

/** 放一条旧规矩。 */
function putRule(ctx: HubContext, ruleId: string, patch: Partial<Rule> = {}) {
  ctx.store.table('rules').put({ id: ruleId, scope: 'global', text: '规矩内容', redLine: false, source: 'owner', status: 'active', createdAt: 1, ...patch } as Rule);
}

/** 放一条旧套路。 */
function putRoutine(ctx: HubContext, routineId: string, patch: Partial<Routine> = {}) {
  ctx.store.table('routines').put({ id: routineId, botId: botFixture.id, name: '核查来源', slug: 'check', whenToUse: '资料变化时',
    steps: ['打开原文', '核对日期'], learnedFrom: null, runs: 0, lastRunAt: null, createdAt: 1, updatedAt: 1, ...patch } as Routine);
}

const record = (ctx: HubContext) => ctx.store.table('migrations').get('p75-storage');

describe('P75f 迁移：九类各一例，逐字段核对新行与出处标签', () => {
  it('九类旧数据各自落到该落的表，字段与标签逐字核对', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    // 1 主人的规矩（全队）。
    putRule(ctx, 'ru_0000000001', { text: '对外文字先给主人看', createdAt: 111 });
    // 2 主人的规矩（某员工）+ 3 红线。
    putRule(ctx, 'ru_0000000002', { scope: other.id, text: '交回前先自测', redLine: true, createdAt: 222 });
    // 4 全队教训。
    putRule(ctx, 'ru_0000000003', { text: '引用先核实', source: 'lesson', createdAt: 333 });
    // 5 员工教训（这位员工会得到技能「我的做法」）。
    putRule(ctx, 'ru_0000000004', { scope: chiefBot.id, text: '先看原文再下结论', source: 'lesson', createdAt: 444 });
    // 6 套路有会话与无会话。
    putRoutine(ctx, 'r_0000000001', { name: '导出名单', whenToUse: '每周导出报名表时', steps: ['打开报名表', '导出为表格'], learnedFrom: 'session-9', updatedAt: 555 });
    putRoutine(ctx, 'r_0000000002', { name: '查证来源', whenToUse: '引用新资料时', steps: ['打开原文', '核对日期'], learnedFrom: null, updatedAt: 666 });
    // 7 MEMORY.md 有内容（另一位员工）与只有初始两行（第一位员工）。
    await ctx.fs.writeTextAtomic(posix.join(other.homeDir, 'memory', 'MEMORY.md'), '# 长期记忆\n\n报名表在共享盘。导出用表格格式。\n', { within: other.homeDir });
    // 8 开着的教训提议（rules 状态 proposed）。
    putRule(ctx, 'ru_0000000005', { text: '先跑一遍再交', source: 'lesson', status: 'proposed', scope: chiefBot.id });
    const proposal = createInboxItem(ctx, { botId: chiefBot.id, type: 'proposal', title: '教训：先跑一遍再交', body: 'why', subjectKey: 'proposal:p1', refId: 'ru_0000000005' });
    // 9 队列里的旧复盘候选。
    enqueue(ctx, buildCandidate(ctx, { botId: chiefBot.id, kind: 'reflection', variant: 'reflection', score: 1, summary: '旧复盘' }));

    await runP75Migration(ctx);

    expect(record(ctx)).toMatchObject({ state: 'done', attempts: 0, error: null });
    expect(legacyRulesInEffect(ctx)).toBe(false);
    // 旧表一行都没动。
    expect(ctx.store.table('rules').count()).toBe(5);
    expect(ctx.store.table('routines').count()).toBe(2);
    // 记忆三条：全队主人规矩、员工主人规矩（红线）、全队教训。
    const memories = ctx.store.table('memories').list();
    expect(memories).toHaveLength(3);
    const global = memories.find(row => row.source.legacyRuleId === 'ru_0000000001')!;
    expect(global).toMatchObject({ kind: 'rule', text: '对外文字先给主人看', redLine: false, createdAt: 111,
      scope: { staff: 'all', projects: 'all' }, status: 'active' });
    expect(global.source).toMatchObject({ kind: 'legacy_owner_rule', quote: '对外文字先给主人看', legacyRuleId: 'ru_0000000001' });
    const staff = memories.find(row => row.source.legacyRuleId === 'ru_0000000002')!;
    expect(staff.scope.staff).toEqual([other.id]);
    expect(staff.redLine).toBe(true);
    const lesson = memories.find(row => row.source.legacyRuleId === 'ru_0000000003')!;
    expect(lesson.source.kind).toBe('legacy_lesson');
    // 技能：我的做法（员工教训）+ 两条套路 + 原长期记忆（只有初始两行的员工没有）。
    const skills = ctx.store.table('skills').list();
    const titles = (botId: string) => skills.filter(row => row.botId === botId).map(row => row.title);
    expect(titles(chiefBot.id).sort()).toEqual(['我的做法', '导出名单', '查证来源'].sort());
    expect(titles(other.id)).toEqual(['原长期记忆']);
    const mine = skills.find(row => row.title === '我的做法')!;
    expect(mine).toMatchObject({ state: 'active', legacy: { kind: 'lesson', refId: null } });
    const mineVersion = ctx.store.table('skillVersions').list(row => row.skillId === mine.id)[0]!;
    expect(mineVersion).toMatchObject({ no: 1, change: 'migrate', checkedBy: 'hub' });
    expect(mineVersion.sentences).toEqual([{ text: '先看原文再下结论', sourceIds: [mineVersion.sentences[0]!.sourceIds[0]!], addedInNo: 1 }]);
    const mineSource = ctx.store.table('skillSources').get(mineVersion.sentences[0]!.sourceIds[0]!)!;
    expect(mineSource).toMatchObject({ kind: 'unknown', label: '迁移：升级前的规矩', quote: '先看原文再下结论' });
    const taught = skills.find(row => row.title === '导出名单')!;
    const taughtVersion = ctx.store.table('skillVersions').list(row => row.skillId === taught.id)[0]!;
    expect(taughtVersion.sentences.map(row => row.text)).toEqual(['打开报名表', '导出为表格']);
    const taughtSource = ctx.store.table('skillSources').get(taughtVersion.sentences[0]!.sourceIds[0]!)!;
    expect(taughtSource).toMatchObject({ kind: 'owner_instruction', label: '你的指示（升级前教过的会话）' });
    const plain = skills.find(row => row.title === '查证来源')!;
    const plainVersion = ctx.store.table('skillVersions').list(row => row.skillId === plain.id)[0]!;
    const plainSource = ctx.store.table('skillSources').get(plainVersion.sentences[0]!.sourceIds[0]!)!;
    expect(plainSource).toMatchObject({ kind: 'unknown', label: '迁移：原套路「查证来源」' });
    const oldMemory = skills.find(row => row.title === '原长期记忆')!;
    const oldMemoryVersion = ctx.store.table('skillVersions').list(row => row.skillId === oldMemory.id)[0]!;
    // 按行切句的规则同套路：一行不超过 80 字就是一句（不按句号再拆）。
    expect(oldMemoryVersion.sentences.map(row => row.text)).toEqual(['报名表在共享盘。导出用表格格式。']);
    expect(ctx.store.table('skillSources').get(oldMemoryVersion.sentences[0]!.sourceIds[0]!)!.label).toBe('迁移：原长期记忆');
    // 收尾：开着的教训提议被撤回（rules 行不改），旧复盘候选被丢弃并记审计。
    expect(ctx.store.table('inbox').get(proposal.id)).toMatchObject({ status: 'withdrawn', answer: '已停用：员工的经验改由评审者核对' });
    expect(ctx.store.table('rules').get('ru_0000000005')!.status).toBe('proposed');
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.log('audit').all().some(row => row.action === 'p75_dropped_reflection')).toBe(true);
    // 收尾：MEMORY.md 改写成那一句说明，原文备份到 legacy 目录。
    expect(await ctx.fs.readText(posix.join(other.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', other.id, 'MEMORY.md'))).toBe('# 长期记忆\n\n报名表在共享盘。导出用表格格式。\n');
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', chiefBot.id, 'MEMORY.md'))).toBe(INITIAL_MEMORY_MD);
  });
});

describe('P75f 迁移：在用上限与出处排序', () => {
  it('在用超过 12 条时多出来的收起，你的指示在前', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    // 14 条套路：三条「你的指示」（updatedAt 较老）+ 11 条来源不明（较新）。
    // 按规则，「你的指示」在前占 3 席，来源不明里最新的 9 条占其余席位，最旧的 2 条收起。
    for (let index = 0; index < 14; index += 1) {
      const taught = index < 3;
      putRoutine(ctx, `r_${String(index + 1).padStart(10, '0')}`, {
        name: `套路${String(index + 1).padStart(2, '0')}`,
        learnedFrom: taught ? `session-${index}` : null, updatedAt: taught ? 100 + index : 500 + index,
      });
    }
    void chiefBot;
    await runP75Migration(ctx);
    const skills = ctx.store.table('skills').list();
    expect(skills).toHaveLength(14);
    expect(skills.filter(row => row.state === 'active')).toHaveLength(12);
    const collapsed = skills.filter(row => row.state === 'collapsed');
    expect(collapsed.map(row => row.title)).toEqual(['套路05', '套路04']);
    // P75r2 第 5 节：迁移时因在用名额放不下而收起的，原因是 migrated（原来断言 unused）。
    expect(collapsed.every(row => row.collapseReason === 'migrated')).toBe(true);
    // 「你的指示」的三条都在用。
    const activeTitles = new Set(skills.filter(row => row.state === 'active').map(row => row.title));
    expect(['套路01', '套路02', '套路03'].every(title => activeTitles.has(title))).toBe(true);
  });
});

describe('P75f 迁移：第一段失败', () => {
  it('新表无任何行，迁移记录 failed，legacyRulesInEffect 为真；身份文件旧规矩照常出现，主人新记的一条也在', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    // 一条仍会让记忆 schema 失败的损坏旧规矩：创建时间不是整数毫秒。
    // P75r2 第 1 节：原来用「正文 200 字」触发，现在旧规矩原样迁入、不再因字数失败，换成损坏的行来触发「万一仍然出错」。
    putRule(ctx, 'ru_0000000001', { text: '长'.repeat(200), createdAt: 1.5 });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(ctx.store.table('memories').count()).toBe(0);
    expect(ctx.store.table('skills').count()).toBe(0);
    expect(ctx.store.table('skillVersions').count()).toBe(0);
    expect(ctx.store.table('skillSources').count()).toBe(0);
    expect(legacyRulesInEffect(ctx)).toBe(true);
    // 派活说明第一节第 3 条：身份文件里旧规矩在「红线与规矩」段照常出现；
    // 主人新记的一条规矩同样出现在「主人的规矩与偏好」段（记忆任何时候都生效）。
    await writeMemory(ctx, { kind: 'rule', text: '新规矩：先给主人看', example: null, redLine: false,
      scope: { staff: 'all', projects: 'all' }, source: { kind: 'owner_edit', messageIds: [], quote: '新规矩', threadId: null } });
    await refreshBotFiles(ctx, chiefBot.id);
    const md = await ctx.fs.readText(posix.join(chiefBot.homeDir, 'AGENTS.md'));
    expect(md).toContain('## 红线与规矩\n- ' + '长'.repeat(200));
    expect(md).toContain('## 主人的规矩与偏好（全队共用，中心维护）\n- 规矩：新规矩：先给主人看');
  });
});

describe('P75f 迁移：第二段中途失败', () => {
  it('已写的行全部删掉，旧表不变；下次启动重试成功', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, 'ru_0000000001', { text: '对外文字先给主人看' });
    putRule(ctx, 'ru_0000000002', { text: '第二条规矩' });
    putRule(ctx, 'ru_0000000003', { scope: chiefBot.id, text: '先看原文再下结论', source: 'lesson' });
    // P75r2 第 2.5 节：单条技能写不进只跳过这一条（另有测试）；这里测的是存储本身出错的整次回滚——
    // 写第二条记忆的审计时存储故障（第一条记忆已写入）：整次不做，已写的行（含半写的这一行）全部删掉。
    // （原来用「预先存在同名技能」触发，现在那种情形只跳过这一条技能。）
    const realLog = ctx.store.log.bind(ctx.store);
    let faulty = true;
    let memoryWrites = 0;
    ctx.store.log = ((name: 'audit') => {
      const log = realLog(name);
      if (name !== 'audit') return log;
      return { ...log, append: (row: { action: string }) => {
        if (faulty && row.action === 'memory_write') { memoryWrites += 1; if (memoryWrites === 2) throw new Error('磁盘故障'); }
        return (log.append as (value: unknown) => unknown)(row);
      } };
    }) as never;
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(record(ctx)!.error).toContain('磁盘故障');
    expect(ctx.store.table('memories').count()).toBe(0);
    expect(ctx.store.table('skills').count()).toBe(0);
    expect(ctx.store.table('skillVersions').count()).toBe(0);
    expect(ctx.store.table('skillSources').count()).toBe(0);
    // 旧表不变。
    expect(ctx.store.table('rules').count()).toBe(3);
    // 下次启动重试成功（故障消失）。
    faulty = false;
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.store.table('memories').count()).toBe(2);
    expect(ctx.store.table('skills').count()).toBe(1);
  });
});

describe('P75f 迁移：第三段某一步失败', () => {
  it('迁移已 done；下次启动只补做没完成的那一步（MEMORY.md 备份不被覆盖、教训提议不重复撤回）', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, 'ru_0000000005', { text: '先跑一遍再交', source: 'lesson', status: 'proposed', scope: chiefBot.id });
    const proposal = createInboxItem(ctx, { botId: chiefBot.id, type: 'proposal', title: '教训：先跑一遍再交', body: 'why', subjectKey: 'proposal:p1', refId: 'ru_0000000005' });
    // 让收尾最后一步（刷新全体守则）失败：writeTextAtomic 对根 AGENTS.md 抛错。
    const original = ctx.fs.writeTextAtomic.bind(ctx.fs);
    let failRoot = false;
    ctx.fs.writeTextAtomic = async (path: string, content: string, options?: unknown) => {
      if (failRoot && path === '/hub/AGENTS.md') throw new Error('磁盘满');
      return original(path, content, options as never);
    };
    failRoot = true;
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    expect(record(ctx)!.steps).toMatchObject({ lessonProposals: true, reflectionQueue: true, backupMemory: true, materializeSkills: true });
    expect(record(ctx)!.steps.refreshAll).toBeUndefined();
    expect(ctx.store.table('inbox').get(proposal.id)!.status).toBe('withdrawn');
    // 下次启动：修好故障，只补做 refreshAll；其余步骤不重复（备份不覆盖：把备份先改掉，收尾不会重写它）。
    await ctx.fs.writeTextAtomic('/hub/.hub/legacy/b_0000000001/MEMORY.md', '手工标注过的备份');
    failRoot = false;
    await runP75Migration(ctx);
    expect(record(ctx)!.steps).toMatchObject({ lessonProposals: true, reflectionQueue: true, backupMemory: true, materializeSkills: true, refreshAll: true });
    expect(await ctx.fs.readText('/hub/.hub/legacy/b_0000000001/MEMORY.md')).toBe('手工标注过的备份');
    // 教训提议仍是那一次撤回，没有第二条提议或重复处理。
    expect(ctx.store.table('inbox').list(row => row.subjectKey === 'proposal:p1')).toHaveLength(1);
    expect(ctx.store.table('rules').get('ru_0000000005')!.status).toBe('proposed');
  });
});

describe('P75f 迁移：失败的告警', () => {
  it('连续三次失败出一条告警，文字逐字；第四次不重复出', async () => {
    const { ctx } = await legacyWorld();
    // P75r2：触发改用损坏的行（创建时间不是整数毫秒）；告警文字改为固定的两句（第 4 节，逐字断言见 p75r2-migration-alerts）。
    putRule(ctx, 'ru_0000000001', { text: '长'.repeat(200), createdAt: 1.5 });
    for (let run = 1; run <= 4; run += 1) {
      await runP75Migration(ctx);
      const alerts = ctx.store.table('alerts').list(alert => alert.code === 'p75:migration');
      if (run < 3) expect(alerts).toHaveLength(0);
      else {
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.text).toBe('升级时整理旧的规矩、套路和长期记忆没有完成，每次启动会再试。旧的规矩照常生效；旧的套路和长期记忆暂时没有带给员工。');
      }
    }
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 4 });
  });
});

describe('P75f 迁移：完成后的文件状态', () => {
  it('身份文件含迁来的规矩；技能文件已物化；MEMORY.md 为那一句、备份原文在；改写后被恢复且不计越界', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, 'ru_0000000001', { text: '对外文字先给主人看' });
    putRule(ctx, 'ru_0000000002', { scope: chiefBot.id, text: '先看原文再下结论', source: 'lesson' });
    await runP75Migration(ctx);
    await refreshBotFiles(ctx, chiefBot.id);
    const md = await ctx.fs.readText(posix.join(chiefBot.homeDir, 'AGENTS.md'));
    expect(md).toContain('- 规矩：对外文字先给主人看');
    expect(md).not.toContain('## 红线与规矩');
    // 技能文件已物化。
    const skill = ctx.store.table('skills').list()[0]!;
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, '.agents/skills', skill.dirName, 'SKILL.md'))).toContain('先看原文再下结论');
    // MEMORY.md 是那一句说明，备份原文在。
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(await ctx.fs.readText(posix.join('/hub/.hub/legacy', chiefBot.id, 'MEMORY.md'))).toBe(INITIAL_MEMORY_MD);
    // 员工改写 MEMORY.md：回合结束核对恢复，不计越界。
    await ctx.fs.writeTextAtomic(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'), '私自改写', { within: chiefBot.homeDir });
    const before = ctx.store.table('bots').get(chiefBot.id)!.violations;
    await verifyManagedFiles(ctx, chiefBot.id);
    expect(await ctx.fs.readText(posix.join(chiefBot.homeDir, 'memory', 'MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(ctx.store.table('bots').get(chiefBot.id)!.violations).toBe(before);
  });
});

describe('P75f 迁移：已 done 时再调用什么都不做', () => {
  it('第二次调用不改任何表、不改迁移记录', async () => {
    const { ctx } = await legacyWorld();
    putRule(ctx, 'ru_0000000001', { text: '对外文字先给主人看' });
    await runP75Migration(ctx);
    const snapshot = {
      memories: ctx.store.table('memories').list().map(row => row.id),
      skills: ctx.store.table('skills').list().map(row => row.id),
      sources: ctx.store.table('skillSources').list().map(row => row.id),
      record: record(ctx),
    };
    ctx.clock.advance(60_000);
    await runP75Migration(ctx);
    expect(ctx.store.table('memories').list().map(row => row.id)).toEqual(snapshot.memories);
    expect(ctx.store.table('skills').list().map(row => row.id)).toEqual(snapshot.skills);
    expect(ctx.store.table('skillSources').list().map(row => row.id)).toEqual(snapshot.sources);
    expect(record(ctx)).toEqual(snapshot.record);
  });
});

describe('P75f 迁移：写到一半（writing）时已迁的规矩靠 legacyRuleId 去重', () => {
  it('writing 状态下旧规矩表仍生效，但已有对应记忆的那条各处只出现一次', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, 'ru_0000000001', { text: '对外文字先给主人看' });
    // 模拟上次进程写到一半：记忆已写、迁移记录停在 writing。
    const memory = await writeMemory(ctx, { kind: 'rule', text: '对外文字先给主人看（记忆）', example: null, redLine: false,
      scope: { staff: 'all', projects: 'all' }, source: { kind: 'legacy_owner_rule', messageIds: [], quote: '对外文字先给主人看', threadId: null, legacyRuleId: 'ru_0000000001' }, refresh: false });
    ctx.store.table('migrations').put({ id: 'p75-storage', state: 'writing', attempts: 0, written: { memories: [memory.id] }, steps: {}, error: null, updatedAt: ctx.clock.now() });
    expect(legacyRulesInEffect(ctx)).toBe(true);
    await refreshBotFiles(ctx, chiefBot.id);
    const md = await ctx.fs.readText(posix.join(chiefBot.homeDir, 'AGENTS.md'));
    // 只有记忆那一条，旧规矩原文不重复出现。
    expect(md).toContain('- 规矩：对外文字先给主人看（记忆）');
    expect(md).not.toContain('## 红线与规矩');
  });
});

/** 占位：测试里直接建技能行时需要的空 legacy。 */
function require_null(_ctx: HubContext): Partial<import('../src/model/skill.js').Skill> {
  return {};
}
