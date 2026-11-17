/**
 * P75i 的测试三：活动流里的「技能库」一类记录（kind 为 skill）与技能库一栏的「上次整理」。
 * 第一条用设计稿场景 F 的数据逐字对照；第二条覆盖回退、放回、复盘等待过期、复盘回合用完、技能更新放弃各一条，
 * 并断言文字里没有内部编号和工具名。数据都从表里生成（不读 14 天的事件日志）：测试直接写表，或走真实链路。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { SkillRunSchema, SkillSourceSchema, SkillUpdateSchema } from '../src/model/skill.js';
import { setSkillState, writeSkillVersion } from '../src/skill/store.js';
import { newId } from '../src/util/ids.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { skillActivityRows } from '../src/api/skill-activity.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import {
  INTERNAL_NAMES, MINUTE, flow, jobFix, retroRun, seedSkill, setLocal, tick,
  type JobFix,
} from './p75i-fixtures.js';

const DAY = 24 * 60 * MINUTE;

/** 活动流里全部技能库记录（从新到旧）。 */
function skillRows(fix: JobFix) {
  return fix.hub.api.activity({ limit: 200 } as never).rows.filter(row => row.kind === 'skill');
}

/** 一条按本地时刻写的时间戳。 */
function at(fix: JobFix, text: string): number {
  return parseLocalDateTime(text, fix.ctx.settings.timezone);
}

describe('15 设计稿 F 的数据：活动流记录逐字相同；技能库「上次整理：11月24日」', () => {
  it('11月24日 林舟合并一项、收起一项、未改动；评审员没有变化未整理；11月20日一条技能更新', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { name: '评审员' });
    setLocal(fix, '2026-11-24 09:00');
    const when = (text: string) => at(fix, text);
    // 林舟的技能：表单页做法（第 3 版，11月20日会议室预约页验收时学到）、手机端适配、名单导出（30 天没用被收起）、另两条。
    const source = (id: string, kind: 'review' | 'owner_correction', label: string, botId = fix.engineer.id) => SkillSourceSchema.parse({
      id, botId, kind, label, quote: '原文', relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: when('2026-11-20 17:00') });
    const ssA = source('ss_000000000a', 'owner_correction', '会议室预约页验收第 2 条');
    const ssB = source('ss_000000000b', 'review', '旧事第 1 轮退回第 1 条');
    for (const row of [ssA, ssB]) fix.ctx.store.table('skillSources').put(row);
    // 11月20日 17:12：「表单页做法」第 3 版通过（来自你的纠正，评审员核对通过）。
    fix.ctx.clock.set(when('2026-11-20 17:12'));
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    const phone = await seedSkill(fix, fix.engineer.id, '手机端适配', ['手机上不出现横向滚动']);
    const export_ = await seedSkill(fix, fix.engineer.id, '名单导出', ['导出前先确认有哪些列']);
    // P75r5c 同步（第 5 节第 6 条）：「两处出处都保留」改为按实际出处判断，所以设计稿的数据里要写明两条原技能各自的出处：
    // 表单页做法的出处是 ssA（你的纠正），手机端适配的出处是 ssB（评审意见）；合并后的句子同时用到两者。原来这两条技能的出处是 seedSkill 现建的、
    // 与合并更新里的出处没有关系（这份数据直接写表，没有走真实链路）。
    for (const [skillId, sourceId] of [[form, ssA.id], [phone, ssB.id]] as const) {
      for (const version of fix.ctx.store.table('skillVersions').list(row => row.skillId === skillId)) {
        fix.ctx.store.table('skillVersions').patch(version.id, { sentences: version.sentences.map(row => ({ ...row, sourceIds: [sourceId] })) });
      }
    }
    const passedLearn = SkillUpdateSchema.parse({
      id: 'su_0000000001', botId: fix.engineer.id, runId: 'sr_0000000001', kind: 'learn', skillId: form, newSkill: null, mergeFromIds: [],
      sentences: [{ text: '提交后显示明确的成功提示', sourceIds: [ssA.id] }], checkerId: fix.reviewer.id, state: 'passed',
      checks: [{ at: when('2026-11-20 17:12'), checkerId: fix.reviewer.id, exists: 'met', consistent: 'met', withinScope: 'met', note: null }],
      rewrites: 0, versionNo: 3, createdAt: when('2026-11-20 17:00'), updatedAt: when('2026-11-20 17:12'),
    });
    fix.ctx.store.table('skillUpdates').put(passedLearn);
    // 11月24日：整理。林舟（评审员核对通过一项合并：手机端适配并入表单页做法，成为第 4 版；名单导出 30 天没用被收起；说明没有矛盾）。
    const mergeUpdate = SkillUpdateSchema.parse({
      id: 'su_0000000002', botId: fix.engineer.id, runId: 'sr_0000000002', kind: 'merge', skillId: form, newSkill: null, mergeFromIds: [phone],
      sentences: [{ text: '手机上不出现横向滚动', sourceIds: [ssB.id] }, { text: '提交后显示明确的成功提示', sourceIds: [ssA.id] }], checkerId: fix.reviewer.id, state: 'passed',
      checks: [{ at: when('2026-11-24 03:10'), checkerId: fix.reviewer.id, exists: 'met', consistent: 'met', withinScope: 'met', note: null }],
      rewrites: 0, versionNo: 4, createdAt: when('2026-11-24 03:05'), updatedAt: when('2026-11-24 03:10'),
    });
    fix.ctx.store.table('skillUpdates').put(mergeUpdate);
    fix.ctx.store.table('skillRuns').put(SkillRunSchema.parse({
      id: 'sr_0000000002', kind: 'tidy', jobId: null, category: null,
      participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [ssA.id, ssB.id], state: 'done', reason: null }, { botId: fix.reviewer.id, role: 'checker', sourceIds: [], state: 'done', reason: null }],
      turnsUsed: 2, turnCap: 2, tokens: 0, summaryPostedAt: null, createdAt: when('2026-11-24 03:00'), endedAt: when('2026-11-24 03:10'),
      weekOf: '2026-11-23', collapsed: [{ skillId: export_, reason: 'unused', days: 30 }],
      merges: [{ updateId: mergeUpdate.id, reason: '两条都要求手机上不出现横向滚动' }], tidyNote: '没有发现相互矛盾的条目', activeAtStart: 5,
    }));
    // 评审员：本周技能库没有变化，未整理（03:00 建记录立即结束）。
    fix.ctx.store.table('skillRuns').put(SkillRunSchema.parse({
      id: 'sr_0000000003', kind: 'tidy', jobId: null, category: null,
      participants: [{ botId: fix.reviewer.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'no_change' }],
      turnsUsed: 0, turnCap: 2, tokens: 0, summaryPostedAt: null, createdAt: when('2026-11-24 03:00'), endedAt: when('2026-11-24 03:00'),
      weekOf: '2026-11-23', collapsed: [], merges: [], tidyNote: null, activeAtStart: 0,
    }));
    fix.ctx.clock.set(when('2026-11-24 09:00'));

    const rows = skillRows(fix);
    expect(rows.map(row => ({ at: row.at, botId: row.botId, botName: row.botName, text: row.text, lines: row.lines }))).toEqual([
      // P75r5c 同步（第 5 节第 9 条、第 4 条、第 1 条）：「{名字}自己积累的技能　a 条变为 b 条」；
      // 本周技能库没有变化的员工不出行（评审员那一行原来写「本周技能库没有变化，未整理。」，现在不显示）；
      // 名单导出有类别（seedSkill 现建的技能类别是「表单页」），所以仍写「下次接到同类的事自动放回」；没有类别的写法在 p75r5c-tidy 里测。
      { at: when('2026-11-24 03:10'), botId: fix.engineer.id, botName: '林舟', text: '每周整理　林舟　评审员核对通过', lines: [
        '林舟自己积累的技能　5 条变为 4 条',
        '合并　「手机端适配」并入「表单页做法」第 4 版。两条都要求手机上不出现横向滚动；两处出处都保留。',
        '收起　「名单导出」30 天内没有用到，移到「不常用」。不删除，下次接到同类的事自动放回。',
        '未改动　没有发现相互矛盾的条目。',
      ] },
      { at: when('2026-11-20 17:12'), botId: fix.engineer.id, botName: '林舟', text: '技能更新　林舟　「表单页做法」第 3 版，来自你的纠正（会议室预约页验收第 2 条）。评审员核对通过。', lines: undefined },
    ]);
    // 每一行的类型是 skill；只有整理那一行有细项。
    expect(rows.every(row => row.kind === 'skill')).toBe(true);
    // 技能库一栏顶部：林舟「上次整理：11月24日」；评审员没有做整理（只是没有变化）所以没有。
    expect((await fix.hub.api.skillLibrary(fix.engineer.id) as { lastTidyText: string | null }).lastTidyText).toBe('上次整理：11月24日');
    expect((await fix.hub.api.skillLibrary(fix.reviewer.id) as { lastTidyText: string | null }).lastTidyText).toBeNull();
    expect(rows.flatMap(row => [row.text, ...(row.lines ?? [])]).filter(text => INTERNAL_NAMES.test(text))).toEqual([]);
  });

  it('合并没有通过核对：那一项写「未通过核对，未改动」，没有「N 条变为 M 条」之外的编造；只收起没有整理时没有「条数」与「未改动」两行', async () => {
    const fix = await jobFix();
    setLocal(fix, '2026-11-24 09:00');
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['一句']);
    const phone = await seedSkill(fix, fix.engineer.id, '手机端适配', ['一句']);
    const old = await seedSkill(fix, fix.engineer.id, '名单导出', ['一句']);
    const sourceId = fix.ctx.store.table('skillVersions').list(row => row.skillId === form)[0]!.sentences[0]!.sourceIds[0]!;
    const abandoned = SkillUpdateSchema.parse({
      id: 'su_0000000009', botId: fix.engineer.id, runId: 'sr_0000000009', kind: 'merge', skillId: form, newSkill: null, mergeFromIds: [phone],
      sentences: [{ text: '一句', sourceIds: [sourceId] }], checkerId: fix.reviewer.id, state: 'abandoned', checks: [], rewrites: 0, versionNo: null,
      abandonReason: '合并后的句子超出了原技能', createdAt: fix.ctx.clock.now(), updatedAt: fix.ctx.clock.now(),
    });
    fix.ctx.store.table('skillUpdates').put(abandoned);
    const base = {
      kind: 'tidy' as const, jobId: null, category: null, turnsUsed: 2, turnCap: 2, tokens: 0, summaryPostedAt: null, createdAt: fix.ctx.clock.now(), endedAt: fix.ctx.clock.now(), weekOf: '2026-11-23',
    };
    fix.ctx.store.table('skillRuns').put(SkillRunSchema.parse({ ...base, id: 'sr_0000000009', merges: [{ updateId: abandoned.id, reason: '重复' }], tidyNote: '没有发现相互矛盾的条目', collapsed: [], activeAtStart: 3,
      participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'done', reason: null }] }));
    // 另一位员工只被收起（没有整理唤醒）：整理记录里 no_change，但有收起一项。
    fix.ctx.store.table('skillRuns').put(SkillRunSchema.parse({ ...base, id: 'sr_0000000010', merges: [], tidyNote: null, activeAtStart: 3,
      collapsed: [{ skillId: old, reason: 'unknown_source', days: 45 }],
      participants: [{ botId: fix.chief.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'no_change' }] }));
    const rows = skillRows(fix);
    const merged = rows.find(row => row.botId === fix.engineer.id)!;
    expect(merged.text).toBe('每周整理　林舟');
    // P75r5c 同步（第 5 节第 9 条）：a 等于 b（合并都没有通过）时不出「条数」那一行。
    expect(merged.lines).toEqual([
      '合并　「手机端适配」并入「表单页做法」未通过核对，未改动。',
      '未改动　没有发现相互矛盾的条目。',
    ]);
    const onlyCollapsed = rows.find(row => row.botId === fix.chief.id)!;
    expect(onlyCollapsed.text).toBe('每周整理　老大');
    // P75r5c 同步（第 5 节第 2 条）：来源不明的收起也写多少天没有用到（记录上的天数改为 45，原来是 null），并写「可以在技能库里放回」。
    expect(onlyCollapsed.lines).toEqual(['收起　「名单导出」来源不明，45 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。']);
    // 这一行里没有「本周技能库没有变化」那句（有收起，不是没有变化）。
    expect(rows.some(row => row.text.includes('没有变化'))).toBe(false);
    expect(SKILL_DEFAULTS.TIDY_MIN_SKILLS).toBe(2);
    // 整理没有结束时不生成合并的行：把林舟这条记录改成没有结束，那一行就消失。
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get('sr_0000000009')!, endedAt: null });
    expect(skillRows(fix).some(row => row.botId === fix.engineer.id)).toBe(false);
    expect(skillActivityRows(fix.ctx).length).toBe(1);
  });
});

describe('16 回退、放回、复盘过期、复盘回合用完、技能更新放弃：各一条记录；文字不含内部编号和工具名', () => {
  it('回退与放回（经界面命令）：审计生成一行，写明技能名与版本；14 天之后事件日志没了也还在', async () => {
    const fix = await jobFix();
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    const phone = await seedSkill(fix, fix.engineer.id, '手机端适配', ['手机上不出现横向滚动']);
    const sourceId = fix.ctx.store.table('skillVersions').list(row => row.skillId === form)[0]!.sentences[0]!.sourceIds[0]!;
    await writeSkillVersion(fix.ctx, { botId: fix.engineer.id, skillId: form, change: 'add', sentences: [{ text: '失败时显示明确的失败提示', sourceIds: [sourceId] }], updateId: null, checkedBy: fix.reviewer.id, categories: [] });
    expect(fix.ctx.store.table('skills').get(form)!.currentVersionNo).toBe(2);
    expect(skillRows(fix)).toHaveLength(0);
    // 回退到第 1 版。
    fix.ctx.clock.advance(MINUTE);
    expect(await fix.hub.api.rollbackSkill({ skillId: form, versionNo: 1 })).toMatchObject({ ok: true });
    // 回到当前版本不算回退（什么都没有改，不留记录）。
    expect(await fix.hub.api.rollbackSkill({ skillId: form, versionNo: 1 })).toMatchObject({ ok: true });
    // 收起再放回（界面命令）。收起不是主人的操作，没有活动流记录；放回有。
    await setSkillState(fix.ctx, phone, 'collapsed', 'unused');
    fix.ctx.clock.advance(MINUTE);
    expect(await fix.hub.api.restoreSkill({ skillId: phone })).toMatchObject({ ok: true });
    const rows = skillRows(fix);
    expect(rows.map(row => row.text)).toEqual([
      '技能放回　林舟　「手机端适配」已放回。',
      '技能回退　林舟　「表单页做法」已回退到第 1 版。',
    ]);
    expect(rows.every(row => row.botId === fix.engineer.id && row.botName === '林舟' && row.lines === undefined)).toBe(true);
    // 已经在用的技能再「放回」不留记录（没有从收起变成在用）。
    expect(await fix.hub.api.restoreSkill({ skillId: phone })).toMatchObject({ ok: true });
    expect(skillRows(fix)).toHaveLength(2);
  });

  it('复盘等待超过 7 天（候选等了 8 天被放弃）与复盘回合用完（回合数用完被丢弃）：各一条', async () => {
    // 等待过期。
    const expired = await flow({ rejectFirst: true });
    const run = retroRun(expired.fix, expired.job.id)!;
    const key = retroSubjectKey(run.id, expired.fix.engineer.id);
    const entry = expired.fix.ctx.store.table('queue').list(row => row.subjectKey === key)[0]!;
    expired.fix.ctx.store.table('queue').put({ ...entry, enqueuedAt: expired.fix.ctx.clock.now() - 8 * DAY });
    await tick(expired.fix, MINUTE);
    expect(skillRows(expired.fix).map(row => row.text)).toEqual(['复盘　林舟　「会员定价页」的复盘等待超过 7 天，未进行。']);
    // 回合用完。
    const capped = await flow({ rejectFirst: true });
    const run2 = retroRun(capped.fix, capped.job.id)!;
    capped.fix.ctx.store.table('skillRuns').put({ ...run2, turnsUsed: run2.turnCap });
    await tick(capped.fix, MINUTE);
    expect(skillRows(capped.fix).map(row => row.text)).toEqual(['复盘　林舟　「会员定价页」的复盘回合用完，未完成。']);
    for (const fix of [expired.fix, capped.fix]) {
      const [row] = skillRows(fix);
      expect(row).toMatchObject({ kind: 'skill', botId: fix.engineer.id, botName: '林舟' });
      expect([row!.text, ...(row!.lines ?? [])].filter(text => INTERNAL_NAMES.test(text))).toEqual([]);
    }
  });

  it('技能更新通过（多个出处接「等 {k} 处」）与放弃（只留在记录里）各一条', async () => {
    const fix = await jobFix();
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['一句']);
    const sources = ['ss_0000000a01', 'ss_0000000a02', 'ss_0000000a03'].map((id, index) => SkillSourceSchema.parse({
      id, botId: fix.engineer.id, kind: index === 0 ? 'review' : 'owner_correction', label: `会员定价页第 ${index + 1} 轮退回第 3 条`, quote: '原文',
      relayed: false, jobId: null, category: null, refs: {}, createdAt: fix.ctx.clock.now() }));
    for (const row of sources) fix.ctx.store.table('skillSources').put(row);
    const base = { botId: fix.engineer.id, runId: 'sr_0000000001', kind: 'learn' as const, skillId: form, newSkill: null, mergeFromIds: [], checkerId: fix.reviewer.id,
      rewrites: 0, createdAt: fix.ctx.clock.now(), updatedAt: fix.ctx.clock.now() };
    fix.ctx.store.table('skillUpdates').put(SkillUpdateSchema.parse({ ...base, id: 'su_0000000001', state: 'passed', versionNo: 2, checks: [],
      sentences: [{ text: '第一句', sourceIds: [sources[0]!.id, sources[1]!.id] }, { text: '第二句', sourceIds: [sources[2]!.id] }] }));
    fix.ctx.clock.advance(MINUTE);
    fix.ctx.store.table('skillUpdates').put(SkillUpdateSchema.parse({ ...base, id: 'su_0000000002', state: 'abandoned', versionNo: null, checks: [], updatedAt: fix.ctx.clock.now(),
      sentences: [{ text: '没通过', sourceIds: [sources[0]!.id] }] }));
    expect(skillRows(fix).map(row => row.text)).toEqual([
      // P75r5c 同步（第 5 节第 7 条）：按更新上记的放弃原因写；这条没有记原因，写「未通过核对」。
      '技能更新　林舟　「表单页做法」的一条更新没有写入：未通过核对。只留在记录里。',
      '技能更新　林舟　「表单页做法」第 2 版，来自评审意见（会员定价页第 1 轮退回第 3 条）等 3 处。评审甲核对通过。',
    ]);
  });
});
