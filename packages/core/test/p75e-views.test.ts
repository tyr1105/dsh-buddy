/**
 * P75e 的测试八：视图。按设计稿场景 C 的数据（三条自己积累、两条岗位技能、三版「表单页做法」、两件表单页的事）
 * 生成技能库一栏与技能详情，sourceText、版本文字、对比表与 note 逐字相符；刻度的长短与 lastText；
 * 纯函数与读存储版本结果相同；视图通过 schema；给主人看的文字里不含内部编号与工具名。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { FakeClock } from '../src/io/testing/fake-clock.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSchema, SkillSourceSchema, SkillUpdateSchema, SkillVersionSchema, JobOutcomeSchema } from '../src/model/skill.js';
import type { Bot, Skill, SkillSource, SkillUpdate, SkillVersion, JobOutcome } from '../src/model/index.js';
import {
  buildSkillLibraryView, buildSkillDetailView, buildSkillTicks, skillLibraryView, skillDetailView, skillSourceText, sourceFromText,
  SkillLibraryViewSchema, SkillDetailViewSchema, type SkillLibraryInput, type SkillDetailInput,
} from '../src/api/skill-views.js';
import { internalNameIn } from '../src/job/owner-text.js';

const TZ = 'Asia/Shanghai';
const T = (text: string) => Date.parse(text);
const NOW = T('2026-11-24T09:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

/** 三位相关的人：林舟（执行者）、评审员、总管。 */
const LIN = { ...botFixture, id: 'b_0000000001', name: '林舟', createdAt: NOW - 13 * DAY, presetSkillIds: ['build-self-check', 'incident-triage'], dshSkillNames: [] };
const REVIEWER = { ...botFixture, id: 'b_0000000002', name: '评审员', createdAt: NOW - 40 * DAY };
const CHIEF = { ...botFixture, id: 'b_0000000003', name: '总管', createdAt: NOW - 40 * DAY };

/** 出处。 */
function source(id: string, botId: string, kind: SkillSource['kind'], label: string, jobId: string | null, at: number): SkillSource {
  return SkillSourceSchema.parse({ id, botId, kind, label, quote: '原文', relayed: false, jobId, category: '表单页', refs: {}, createdAt: at });
}
const SS = {
  rev1: source('ss_0000000001', LIN.id, 'review', '「数据核对」任务第 1 轮', 'job_0000000001', T('2026-11-13T09:00:00+08:00')),
  rev2: source('ss_0000000002', LIN.id, 'review', '活动报名页第 1 轮退回第 3 条', 'job_0000000003', T('2026-11-16T09:00:00+08:00')),
  corr1: source('ss_0000000003', LIN.id, 'owner_correction', '活动报名页验收第 4 条', 'job_0000000001', T('2026-11-16T10:00:00+08:00')),
  corr2: source('ss_0000000004', LIN.id, 'owner_correction', '会议室预约页验收第 2 条', 'job_0000000002', T('2026-11-20T16:00:00+08:00')),
  instr1: source('ss_0000000005', LIN.id, 'owner_instruction', '你的指示，附会话「导出报名表」', null, T('2026-11-19T09:00:00+08:00')),
  rev3: source('ss_0000000006', LIN.id, 'review', '手机端自测第 1 轮退回第 1 条', null, T('2026-11-20T09:00:00+08:00')),
};

/** 技能与版本。 */
function skillOf(id: string, title: string, whenToUse: string, versionNo: number, updatedAt: number, extra: Partial<Skill> = {}): Skill {
  return SkillSchema.parse({ id, botId: LIN.id, title, whenToUse, supplements: null, dirName: `self-${id.slice(-8)}`,
    state: 'active', collapseReason: null, currentVersionNo: versionNo, categories: ['表单页'], lastUsedAt: null,
    legacy: null, createdAt: T('2026-11-13T08:00:00+08:00'), updatedAt, collapsedAt: null, ...extra });
}
const FORM = skillOf('sk_0000000001', '表单页做法', '做表单页（输入、提交、提示）时用', 3, T('2026-11-20T17:12:00+08:00'));
const EXPORT = skillOf('sk_0000000002', '名单导出', '导出名单文件时用', 2, T('2026-11-19T12:00:00+08:00'));
const MOBILE = skillOf('sk_0000000003', '手机端适配', '页面要在手机上能看时用', 1, T('2026-11-20T19:00:00+08:00'));

function version(skillId: string, no: number, sentences: Array<[string, string[], number]>, change: SkillVersion['change'], checkedBy: string | null, at: number): SkillVersion {
  return SkillVersionSchema.parse({ id: `skv_${skillId.slice(-9)}${String(no).padStart(1, '0')}`, skillId, no,
    sentences: sentences.map(([text, sourceIds, addedInNo]) => ({ text, sourceIds, addedInNo })),
    change, updateId: `su_000000000${no}`, basedOnNo: no === 1 ? null : no - 1, checkedBy, createdAt: at });
}
const VERSIONS: SkillVersion[] = [
  version('sk_0000000001', 1, [['提交后显示明确的成功提示，名单写入前先校验必填项。', [SS.rev1.id], 1]], 'create', CHIEF.id, T('2026-11-13T10:00:00+08:00')),
  version('sk_0000000001', 2, [
    ['提交后显示明确的成功提示，名单写入前先校验必填项。', [SS.rev1.id], 1],
    ['页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。', [SS.rev2.id], 2],
    ['自测数据要覆盖选填项填写和不填两种情况。', [SS.corr1.id], 2],
  ], 'add', REVIEWER.id, T('2026-11-17T15:00:00+08:00')),
  version('sk_0000000001', 3, [
    ['提交后显示明确的成功提示，名单写入前先校验必填项。', [SS.rev1.id], 1],
    ['页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。', [SS.rev2.id], 2],
    ['自测数据要覆盖选填项填写和不填两种情况。', [SS.corr1.id], 2],
    ['日期和时间段的选择框，默认值不能落在已过去的时间。', [SS.corr2.id], 3],
  ], 'add', REVIEWER.id, T('2026-11-20T17:12:00+08:00')),
  version('sk_0000000002', 1, [['导出的名单要有表头。', [SS.instr1.id], 1]], 'create', REVIEWER.id, T('2026-11-19T10:00:00+08:00')),
  version('sk_0000000002', 2, [
    ['导出的名单要有表头。', [SS.instr1.id], 1],
    ['导出后打开抽查第一行和最后一行。', [SS.instr1.id], 2],
  ], 'add', CHIEF.id, T('2026-11-19T12:00:00+08:00')),
  version('sk_0000000003', 1, [['手机上先看横向滚动。', [SS.rev3.id], 1]], 'create', REVIEWER.id, T('2026-11-20T19:00:00+08:00')),
];

/** 同类任务记录：表单页两件（第 1 次与最近一次）。 */
function outcome(seq: number, title: string, rounds: number, reworks: number, turns: number, acceptedAt: number): JobOutcome {
  return JobOutcomeSchema.parse({ id: `job_000000000${seq}`, category: '表单页', executorId: LIN.id, reviewerId: REVIEWER.id,
    title, rounds, reworks, turns, seq, acceptedAt });
}
const OUTCOMES = [
  outcome(1, '活动报名页', 2, 1, 14, T('2026-11-16T18:00:00+08:00')),
  outcome(2, '会议室预约页', 1, 1, 9, T('2026-11-20T16:30:00+08:00')),
];

/** 技能更新（刻度的原料）：1 道评审意见、1 道验收结果、1 道你的纠正、1 道合并。 */
function update(id: string, kind: SkillUpdate['kind'], sourceIds: string[], at: number, mergeFromIds: string[] = [], skillId: string | null = 'sk_0000000001'): SkillUpdate {
  return SkillUpdateSchema.parse({ id, botId: LIN.id, runId: 'sr_0000000001', kind, skillId,
    newSkill: null, mergeFromIds, sentences: [{ text: '一句做法', sourceIds }], checkerId: REVIEWER.id,
    state: 'passed', checks: [], rewrites: 0, versionNo: 1, createdAt: at, updatedAt: at });
}
const UPDATES = [
  update('su_0000000001', 'learn', [SS.rev1.id], T('2026-11-13T10:00:00+08:00')),
  update('su_0000000002', 'learn', [SS.instr1.id], T('2026-11-19T12:00:00+08:00'), [], 'sk_0000000002'),
  update('su_0000000003', 'learn', [SS.corr2.id], T('2026-11-20T17:12:00+08:00')),
  // 最近一道：每周整理合并了一条（把「手机端适配」并进「表单页做法」）。
  update('su_0000000004', 'merge', [SS.rev3.id], T('2026-11-24T08:00:00+08:00'), ['sk_0000000003']),
];

const PRESET_SELECTED = [
  { id: 'build-self-check', name: '动手前后自查', purpose: '动手前后核对', audience: 'role' as const },
  { id: 'incident-triage', name: '异常排查四步', purpose: '遇到异常按四步走' },
];

/** 纯函数的输入。 */
function libraryInput(): SkillLibraryInput {
  return {
    botName: '林舟', botCreatedAt: LIN.createdAt, now: NOW, tz: TZ,
    skills: [MOBILE, FORM, EXPORT].sort((a, b) => b.updatedAt - a.updatedAt),
    versions: VERSIONS, sources: Object.values(SS), updates: UPDATES,
    presetSelected: PRESET_SELECTED, dshSkillNames: [], postName: '工程师',
  };
}

/** 把同一份数据放进存储，供读存储版本使用。 */
function storedSetup() {
  const clock = new FakeClock(NOW);
  const ctx = createTestContext({ clock });
  for (const bot of [LIN, REVIEWER, CHIEF]) ctx.store.table('bots').put(bot);
  ctx.store.table('botOrigins').put({ id: LIN.id, botId: LIN.id, templateId: 'engineer', source: 'custom', proposalId: null,
    joinedAt: LIN.createdAt, renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null });
  for (const skill of [FORM, EXPORT, MOBILE]) ctx.store.table('skills').put(skill);
  for (const row of VERSIONS) ctx.store.table('skillVersions').put(row);
  for (const row of Object.values(SS)) ctx.store.table('skillSources').put(row);
  for (const row of UPDATES) ctx.store.table('skillUpdates').put(row);
  for (const row of OUTCOMES) ctx.store.table('jobOutcomes').put(row);
  return ctx;
}

describe('P75e 视图：技能库一栏（设计稿场景 C）', () => {
  it('计数、最近更新、分组与每行的文字逐字相符', () => {
    const view = buildSkillLibraryView(libraryInput());
    expect(view.title).toBe('技能库');
    expect(view.countText).toBe('5 条');
    expect(view.lastUpdatedText).toBe('最近更新　11月20日');
    expect(view.lastTidyText).toBeNull();
    const [self, role, collapsed] = view.groups as [typeof view.groups[number], typeof view.groups[number], typeof view.groups[number]];
    expect(self).toMatchObject({ key: 'self', label: '自己积累', note: '3 条，林舟自己维护' });
    expect(self.items.map(row => row.title)).toEqual(['手机端适配', '表单页做法', '名单导出']);
    // 三行的来源文字与版本号逐字相符（顺序按更新时间倒序）。本周一是 11月23日，三条的版本都早于它，badge 为 null。
    expect(self.items[0]).toMatchObject({ title: '手机端适配', versionText: '第 1 版', badge: null, sourceText: '来自评审意见　11月20日' });
    expect(self.items[1]).toMatchObject({ title: '表单页做法', versionText: '第 3 版', badge: null, sourceText: '来自 3 件事　评审意见 2、你的纠正 2' });
    expect(self.items[2]).toMatchObject({ title: '名单导出', versionText: '第 2 版', badge: null, sourceText: '来自你的指示　11月19日' });
    // 「本周更新」的正例：把「现在」挪到 11月21日（本周一是 11月16日），第 3 版（11月20日）之后有新版本的技能带上标记。
    const thisWeek = buildSkillLibraryView({ ...libraryInput(), now: T('2026-11-21T09:00:00+08:00') });
    const badgeOf = (title: string) => thisWeek.groups[0]!.items.find(row => row.title === title)!.badge;
    expect(badgeOf('表单页做法')).toBe('本周更新');
    expect(badgeOf('手机端适配')).toBe('本周更新');
    expect(badgeOf('名单导出')).toBe('本周更新');
    expect(role).toMatchObject({ key: 'role', label: '岗位技能', note: '2 条，预置，只读' });
    expect(role.roleItems).toEqual([
      { title: '动手前后自查', note: '工程师岗位自带' },
      { title: '异常排查四步', note: '通用，入职时选定' },
    ]);
    expect(collapsed).toMatchObject({ key: 'collapsed', label: '不常用', note: '0 条', items: [] });
  });
});

describe('P75e 视图：技能详情（设计稿场景 C）', () => {
  it('headText、正文逐句出处、三个版本的文字、对比表与 note 逐字相符', () => {
    const input: SkillDetailInput = {
      now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: UPDATES,
      checkerNames: { [REVIEWER.id]: '评审员', [CHIEF.id]: '总管' },
      skillTitles: { sk_0000000003: '手机端适配' },
      outcomes: OUTCOMES, mergedIntoTitle: null,
    };
    const view = buildSkillDetailView(input);
    expect(view.title).toBe('表单页做法');
    expect(view.headText).toBe('第 3 版　11月20日 17:12');
    expect(view.bodyTitle).toBe('正文　每一句都注明出处');
    expect(view.sentences).toEqual([
      { text: '提交后显示明确的成功提示，名单写入前先校验必填项。', sourceText: '第 1 版　来自评审意见：「数据核对」任务第 1 轮' },
      { text: '页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。', sourceText: '第 2 版　来自评审意见：活动报名页第 1 轮退回第 3 条' },
      { text: '自测数据要覆盖选填项填写和不填两种情况。', sourceText: '第 2 版　来自你的纠正：活动报名页验收第 4 条' },
      { text: '日期和时间段的选择框，默认值不能落在已过去的时间。', sourceText: '第 3 版　来自你的纠正：会议室预约页验收第 2 条' },
    ]);
    expect(view.versions).toEqual([
      { no: 3, text: '11月20日　新增 1 句。评审员核对通过。', current: true, canRollback: false },
      { no: 2, text: '11月17日　新增 2 句。评审员核对通过。', current: false, canRollback: true },
      { no: 1, text: '11月13日　建立。总管核对通过。', current: false, canRollback: true },
    ]);
    expect(view.compare).toEqual({
      title: '同类任务：表单页',
      headers: ['第几次', '哪件事', '核对轮数', '验收返工', '回合'],
      rows: [
        { seqText: '第 1 次', title: '活动报名页', rounds: 2, reworks: 1, turns: 14 },
        { seqText: '第 2 次', title: '会议室预约页', rounds: 1, reworks: 1, turns: 9 },
      ],
      note: '第 2 次核对一次通过；验收仍返工 1 次，原因已记入第 3 版。',
    });
    expect(view.stateText).toBeNull();
    expect(view.canRestore).toBe(false);
  });

  it('对比的边界：记录少于 2 条时为 null；核对轮数与第 1 次相同的说法', () => {
    const none = buildSkillDetailView({ now: NOW, tz: TZ, skill: MOBILE, versions: VERSIONS.filter(row => row.skillId === MOBILE.id),
      sources: Object.values(SS), updates: [], checkerNames: {}, skillTitles: {}, outcomes: [], mergedIntoTitle: null });
    expect(none.compare).toBeNull();
    // 同轮数：与第 1 次相同。
    const sameRounds = [OUTCOMES[0]!, outcome(2, '会议室预约页', 2, 0, 9, T('2026-11-20T16:30:00+08:00'))];
    const view = buildSkillDetailView({ now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: [], checkerNames: {}, skillTitles: {}, outcomes: sameRounds, mergedIntoTitle: null });
    expect(view.compare!.note).toBe('第 2 次核对 2 轮，与第 1 次相同。');
  });
});

describe('P75e 视图：技能刻度（设计稿场景 H 提案一）', () => {
  it('长短按出处种类、合并为主色、24 小时内为 fresh、lastText', () => {
    const ticks = buildSkillTicks({ updates: UPDATES, sources: Object.values(SS), now: NOW, tz: TZ, botCreatedAt: LIN.createdAt });
    expect(ticks.headText).toBe('刻度　4 道　入职 13 天');
    expect(ticks.legend).toBe('短：评审意见　中：验收结果　长：你的纠正　主色：整理合并');
    expect(ticks.ticks.map(row => row.length)).toEqual(['short', 'long', 'long', 'main']);
    expect(ticks.ticks.map(row => row.fresh)).toEqual([false, false, false, true]);
    expect(ticks.lastText).toBe('最近一道：11月24日 每周整理，合并 1 条');
    // 验收结果为中。
    const acceptance = update('su_0000000009', 'learn', ['ss_0000000009'], T('2026-11-21T09:00:00+08:00'));
    const acceptanceSource = source('ss_0000000009', LIN.id, 'acceptance', '活动报名页验收结果', 'job_0000000001', T('2026-11-21T09:00:00+08:00'));
    const mid = buildSkillTicks({ updates: [acceptance], sources: [acceptanceSource], now: NOW, tz: TZ, botCreatedAt: LIN.createdAt });
    expect(mid.ticks[0]!.length).toBe('mid');
    expect(mid.lastText).toBe('最近一道：11月21日 技能更新，来自验收结果');
  });
  it('来源不明的更新不刻、不出 lastText（迁移不产生更新，天然不刻）', () => {
    const unknown = update('su_0000000010', 'learn', ['ss_0000000010'], T('2026-11-22T09:00:00+08:00'));
    const unknownSource = source('ss_0000000010', LIN.id, 'unknown', '迁移：原套路「周报整理」', null, T('2026-11-22T09:00:00+08:00'));
    const ticks = buildSkillTicks({ updates: [unknown], sources: [unknownSource], now: NOW, tz: TZ, botCreatedAt: LIN.createdAt });
    expect(ticks.ticks).toHaveLength(1);
    expect(ticks.lastText).toBe('最近一道：11月22日 技能更新，来源不明');
  });
});

describe('P75r7：技能库与详情的文字（A1 第 3 条、A4）', () => {
  it('A4：没有「不常用」时写「{n} 条」；有时写「在用 {n} 条，不常用 {m} 条」（{n} 的算法不变）', () => {
    expect(buildSkillLibraryView(libraryInput()).countText).toBe('5 条');
    const collapsedSkill = skillOf('sk_0000000009', '旧做法', '很少用', 1, T('2026-11-10T09:00:00+08:00'), { state: 'collapsed', collapseReason: 'unused', collapsedAt: T('2026-11-12T09:00:00+08:00') });
    const withCollapsed = buildSkillLibraryView({ ...libraryInput(), skills: [...libraryInput().skills, collapsedSkill] });
    expect(withCollapsed.countText).toBe('在用 5 条，不常用 1 条');
    // 下面三组的合计就是 5 + 1，与顶部两个数相符。
    expect(withCollapsed.groups.map(group => group.note)).toEqual(['3 条，林舟自己维护', '2 条，预置，只读', '1 条']);
  });

  it('A1 第 3 条：出处种类为「来源不明」时，三处拼「来自」的地方都不会出现「来自来源不明」', () => {
    // 技能行的出处文字（只有来源不明的出处）。
    const unknownSource = source('ss_0000000010', LIN.id, 'unknown', '迁移：原套路「周报整理」', null, T('2026-11-22T09:00:00+08:00'));
    expect(skillSourceText([unknownSource], TZ)).toBe('来源不明');
    // 技能详情里逐句出处：迁移来的句子写「第 n 版　来源不明：标签」。
    const migrated = skillOf('sk_0000000011', '周报整理', '写周报时用', 1, T('2026-11-22T09:00:00+08:00'));
    const detail = buildSkillDetailView({
      now: NOW, tz: TZ, skill: migrated,
      versions: [version(migrated.id, 1, [['周报先写结论。', [unknownSource.id], 1]], 'create', null, T('2026-11-22T09:00:00+08:00'))],
      sources: [unknownSource], updates: [], checkerNames: {}, skillTitles: {}, outcomes: [], mergedIntoTitle: null,
    });
    expect(detail.sentences[0]!.sourceText).toBe('第 1 版　来源不明：迁移：原套路「周报整理」');
    expect(detail.sentences[0]!.sourceText).not.toContain('来自来源不明');
    // 其余种类照旧写「来自{种类}」。
    expect(sourceFromText('review')).toBe('来自评审意见');
    expect(sourceFromText('unknown')).toBe('来源不明');
  });

  it('A1 第 1、2 条：正文小标题与两处入职说明的新文字', () => {
    const detail = buildSkillDetailView({
      now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: UPDATES, checkerNames: {}, skillTitles: {}, outcomes: OUTCOMES, mergedIntoTitle: null,
    });
    expect(detail.bodyTitle).toBe('正文　每一句都注明出处');
    const library = buildSkillLibraryView({ ...libraryInput(), dshSkillNames: ['代码审查'] });
    expect(library.groups[1]!.roleItems.map(row => row.note)).toEqual(['工程师岗位自带', '通用，入职时选定', 'DSH 技能，入职时选定']);
  });
});

describe('P75e 视图：纯函数与读存储一致、schema、不含内部名称', () => {
  it('读存储版本与纯函数结果相同（技能库与详情）', () => {
    const ctx = storedSetup();
    expect(skillLibraryView(ctx, LIN.id)).toEqual(buildSkillLibraryView(libraryInput()));
    const pureDetail = buildSkillDetailView({
      now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: UPDATES.filter(row => row.skillId === FORM.id || row.kind === 'merge'),
      checkerNames: { [REVIEWER.id]: '评审员', [CHIEF.id]: '总管' }, skillTitles: { sk_0000000003: '手机端适配' },
      outcomes: OUTCOMES, mergedIntoTitle: null,
    });
    expect(skillDetailView(ctx, FORM.id)).toEqual(pureDetail);
  });

  it('两个视图都通过自己的 schema', () => {
    expect(() => SkillLibraryViewSchema.parse(buildSkillLibraryView(libraryInput()))).not.toThrow();
    expect(() => SkillDetailViewSchema.parse(buildSkillDetailView({
      now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: [], checkerNames: {}, skillTitles: {}, outcomes: OUTCOMES, mergedIntoTitle: null,
    }))).not.toThrow();
  });

  it('给主人看的文字里不含内部编号（sk_、b_、hub_ 等，用中心的检查工具逐句扫）', () => {
    const library = buildSkillLibraryView(libraryInput());
    const detail = buildSkillDetailView({
      now: NOW, tz: TZ, skill: FORM, versions: VERSIONS.filter(row => row.skillId === FORM.id),
      sources: Object.values(SS), updates: UPDATES, checkerNames: { [REVIEWER.id]: '评审员', [CHIEF.id]: '总管' },
      skillTitles: {}, outcomes: OUTCOMES, mergedIntoTitle: null,
    });
    const texts: string[] = [];
    texts.push(library.countText, library.lastUpdatedText ?? '', ...library.groups.flatMap(group => [group.label, group.note,
      ...group.items.flatMap(row => [row.title, row.versionText, row.badge ?? '', row.sourceText, row.supplementsText ?? '']),
      ...group.roleItems.flatMap(row => [row.title, row.note])]));
    texts.push(library.ticks.headText, library.ticks.legend, library.ticks.lastText ?? '');
    texts.push(detail.title, detail.headText, detail.bodyTitle, ...detail.sentences.flatMap(row => [row.text, row.sourceText]),
      ...detail.versions.map(row => row.text), detail.compare?.title ?? '', detail.compare?.note ?? '', detail.stateText ?? '');
    for (const text of texts) expect(internalNameIn(text), text).toBeNull();
  });
});
