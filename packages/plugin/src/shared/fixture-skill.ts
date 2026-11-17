/**
 * 样例技能库数据（P75j，样例数据模式专用）：照设计稿场景 C（员工卡片上的技能库）与场景 H（技能刻度）造样例，
 * 让离线走查和测试能看到：自己积累、岗位技能、不常用三组，三版、两版、一版的技能，学习写出的技能（出处是会话），
 * 不常用的三种原因（久未使用、来源不明、已并入），同类任务对比，以及刻度上八道（其中 11月24日 一道是整理合并）。
 *
 * 做法（第一块的教训，与 fixture-job.ts、fixture-team.ts 相同）：这个文件只写「记录」（core 的技能、版本、出处、更新、
 * 整理记录、同类任务记录），视图一律走 core 对外的 UiApi（createUiApi 的 skillLibrary、skillDetail）生成：
 * 这里用 core 的 testing 环境（内存存储加假时钟）种进这些记录，再取回视图。不手写任何视图字段：
 * 版本文字、来源一句、对比结论、刻度文字、收起说明都由 core 生成，core 改了口径，样例会跟着变。
 * 回退、放回两条命令同样走 core 的 UiApi（在内存环境里真的改记录），所以离线模式点按钮后看到的是 core 算出的结果。
 * 另有一条一致性测试（test/p75j-fixture-consistency.test.ts）校验样例视图符合设计稿的数据。
 *
 * 与设计稿的差别（已在进度记录里写明）：
 * - 设计稿 C 写「入职 13 天」，但「久未使用」要求至少 30 天没有用到，所以样例员工入职 45 天（刻度的八道仍在 11月13日 至 24日）；
 * - 设计稿 C 里表单页做法显示「本周更新」，但样例时刻定在 11月24日（周二，设计稿 H 的整理合并发生在这一天），
 *   表单页做法最近一版在 11月20日（上周），所以「本周更新」小标出现在被整理合并的那一条上。
 *
 * 样例文字不进文案登记表（见 docs/copy/strings.md「不登记」一条）；core 生成的句子登记在 SKL- 前缀下。
 */
import { createUiApi, testing } from '@agent-hub/core'
import type { UiApi } from '@agent-hub/core'
import type { ActivityRow, SkillDetailView, SkillLibraryView } from './views.js'

/** 样例时刻：2026-11-24 09:30（北京时间，周二）；整理合并发生在当天 03:12，所以刻度上最新一道是「新刻」的。 */
export const SAMPLE_SKILL_NOW = Date.parse('2026-11-24T09:30:00+08:00')
export const SAMPLE_SKILL_TIMEZONE = 'Asia/Shanghai'

/** 样例员工的固定编号与名字（前缀加 10 位小写字母或数字，与 core 的 recordId 规则一致）。 */
export const SAMPLE_SKILL_BOT_ID = 'b_samplelinz'
const CHIEF_ID = 'b_samplechfx'
const REVIEWER_ID = 'b_samplerevw'

/** 样例技能的固定编号：详情和命令按它取。 */
export const SAMPLE_SKILL_IDS = {
  form: 'sk_sampleform', // 表单页做法：三版
  roster: 'sk_sampleexpo', // 名单导出：两版
  mobile: 'sk_samplemobi', // 手机端适配：一版
  minutes: 'sk_samplemeet', // 会议纪要格式：学习写出的（出处是会话），被整理合并过一次
  template: 'sk_sampletmpl', // 纪要模板：已并入「会议纪要格式」
  report: 'sk_samplerepo', // 周报排版：久未使用
  legacy: 'sk_samplelegc', // 交付前检查：来源不明
} as const

/** 一个北京时间的时刻。 */
const at = (text: string): number => Date.parse(`2026-${text}:00+08:00`)

/** 一条出处记录：同一份默认字段，只写变化的几项。 */
function source(id: string, kind: 'review' | 'owner_correction' | 'acceptance' | 'owner_instruction' | 'unknown', label: string,
  createdAt: number, jobId: string | null, category: string | null) {
  return {
    id, botId: SAMPLE_SKILL_BOT_ID, kind, label, quote: `（样例原文）${label}`, relayed: false, jobId, category, refs: {}, createdAt,
  }
}

/** 三件样例事的编号（核对轮数、验收返工等数字取自同类任务记录）。 */
const JOB_DATA = 'job_sampdata01'
const JOB_REG = 'job_sampreg001'
const JOB_MEET = 'job_sampmeet01'

const SOURCES = [
  source('ss_sample0001', 'review', '「数据核对」任务第 1 轮', at('11-13T10:20'), JOB_DATA, '数据核对'),
  source('ss_sample0002', 'review', '活动报名页第 1 轮退回第 3 条', at('11-15T16:00'), JOB_REG, '表单页'),
  source('ss_sample0003', 'owner_correction', '活动报名页验收第 4 条', at('11-16T18:00'), JOB_REG, '表单页'),
  source('ss_sample0004', 'owner_correction', '会议室预约页验收第 2 条', at('11-20T16:50'), JOB_MEET, '表单页'),
  source('ss_sample0005', 'acceptance', '活动报名页验收通过', at('11-16T18:30'), JOB_REG, '表单页'),
  source('ss_sample0006', 'owner_instruction', '会话『名单整理』', at('11-19T11:00'), null, null),
  source('ss_sample0007', 'review', '会议室预约页第 1 轮', at('11-20T15:00'), JOB_MEET, '表单页'),
  source('ss_sample0008', 'owner_instruction', '会话『周会记录整理』', at('11-22T10:00'), null, null),
  source('ss_sample0009', 'review', '周会纪要第 1 轮', at('11-18T14:00'), null, null),
  source('ss_sample0010', 'unknown', '升级前的长期记忆', at('11-11T09:00'), null, null),
  source('ss_sample0011', 'review', '周报第 1 轮', at('10-18T14:00'), null, null),
]

/** 一句技能：正文、出处、第几版加入。 */
const sentence = (text: string, sourceId: string, addedInNo: number) => ({ text, sourceIds: [sourceId], addedInNo })

// 表单页做法的四句（逐字取自设计稿 C）。
const FORM_S1 = sentence('提交后显示明确的成功提示，名单写入前先校验必填项。', 'ss_sample0001', 1)
const FORM_S2 = sentence('页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。', 'ss_sample0002', 2)
const FORM_S3 = sentence('自测数据要覆盖选填项填写和不填两种情况。', 'ss_sample0003', 2)
const FORM_S4 = sentence('日期和时间段的选择框，默认值不能落在已过去的时间。', 'ss_sample0004', 3)
const ROSTER_S1 = sentence('导出名单时第一行写表头，手机号保留前导零。', 'ss_sample0005', 1)
const ROSTER_S2 = sentence('名单导出前先去掉重复的手机号，只保留最后一次。', 'ss_sample0006', 2)
const MOBILE_S1 = sentence('手机端的按钮和输入框高度不小于 44 像素，两侧各留 16 像素边距。', 'ss_sample0007', 1)
const MINUTES_S1 = sentence('纪要第一行写结论，其后按「待办、决定、遗留」三段排。', 'ss_sample0008', 1)
const MINUTES_S2 = sentence('每条待办写明负责人和日期，没有日期的写「待定」。', 'ss_sample0009', 2)
const TEMPLATE_S1 = sentence('每条待办写明负责人和日期，没有日期的写「待定」。', 'ss_sample0009', 1)
const LEGACY_S1 = sentence('交付前把自测结果贴在交回里。', 'ss_sample0010', 1)
const REPORT_S1 = sentence('周报的数字放在表格里，结论写在表格上方。', 'ss_sample0011', 1)

/** 一条技能记录的默认字段。 */
function skill(id: string, dir: string, title: string, whenToUse: string, rest: Record<string, unknown>) {
  return {
    id, botId: SAMPLE_SKILL_BOT_ID, title, whenToUse, supplements: null, dirName: `self-${dir}`, state: 'active', collapseReason: null,
    currentVersionNo: 1, categories: [] as string[], lastUsedAt: null, legacy: null, collapsedAt: null, ...rest,
  }
}

const SKILLS = [
  skill(SAMPLE_SKILL_IDS.form, 'sample01', '表单页做法', '做报名、预约这类带表单的页面时', {
    categories: ['表单页'], currentVersionNo: 3, createdAt: at('11-13T10:30'), updatedAt: at('11-20T17:12'), lastUsedAt: at('11-20T11:00'),
  }),
  skill(SAMPLE_SKILL_IDS.roster, 'sample02', '名单导出', '把报名名单导出成表格文件时', {
    categories: ['数据整理'], currentVersionNo: 2, createdAt: at('11-13T12:00'), updatedAt: at('11-19T11:30'), lastUsedAt: at('11-19T11:00'),
  }),
  skill(SAMPLE_SKILL_IDS.mobile, 'sample03', '手机端适配', '页面要在手机上打开时', {
    supplements: '动手前后自查', categories: [], currentVersionNo: 1, createdAt: at('11-20T15:30'), updatedAt: at('11-20T15:30'),
  }),
  skill(SAMPLE_SKILL_IDS.minutes, 'sample04', '会议纪要格式', '整理会议记录、写纪要时', {
    categories: [], currentVersionNo: 2, createdAt: at('11-22T10:30'), updatedAt: at('11-24T03:12'), lastUsedAt: at('11-23T16:00'),
  }),
  skill(SAMPLE_SKILL_IDS.template, 'sample05', '纪要模板', '写纪要时套用的模板', {
    state: 'collapsed', collapseReason: 'merged', collapsedAt: at('11-24T03:12'), createdAt: at('11-18T14:30'), updatedAt: at('11-24T03:12'),
  }),
  skill(SAMPLE_SKILL_IDS.report, 'sample06', '周报排版', '写每周工作周报时', {
    state: 'collapsed', collapseReason: 'unused', collapsedAt: at('11-24T03:12'), createdAt: at('10-18T14:30'), updatedAt: at('10-18T14:30'),
    lastUsedAt: at('10-20T10:00'),
  }),
  skill(SAMPLE_SKILL_IDS.legacy, 'sample07', '交付前检查', '交回一件事之前', {
    state: 'collapsed', collapseReason: 'unknown_source', collapsedAt: at('11-24T03:12'), createdAt: at('11-11T09:00'), updatedAt: at('11-11T09:00'),
    legacy: { kind: 'memory_md', refId: null },
  }),
]

/** 一个版本：编号由 skill 与序号拼出。 */
function version(no: number, skillId: string, serial: string, change: 'create' | 'add' | 'merge' | 'migrate', updateId: string | null,
  checkedBy: string | null, createdAt: number, sentences: Array<ReturnType<typeof sentence>>) {
  return { id: `skv_${serial}`, skillId, no, sentences, change, updateId, basedOnNo: no === 1 ? null : no - 1, checkedBy, createdAt }
}

const VERSIONS = [
  version(1, SAMPLE_SKILL_IDS.form, 'sample0001', 'create', 'su_sample0001', CHIEF_ID, at('11-13T10:30'), [FORM_S1]),
  version(2, SAMPLE_SKILL_IDS.form, 'sample0002', 'add', 'su_sample0002', REVIEWER_ID, at('11-17T09:40'), [FORM_S1, FORM_S2, FORM_S3]),
  version(3, SAMPLE_SKILL_IDS.form, 'sample0003', 'add', 'su_sample0003', REVIEWER_ID, at('11-20T17:12'), [FORM_S1, FORM_S2, FORM_S3, FORM_S4]),
  version(1, SAMPLE_SKILL_IDS.roster, 'sample0004', 'create', 'su_sample0004', CHIEF_ID, at('11-13T12:00'), [ROSTER_S1]),
  version(2, SAMPLE_SKILL_IDS.roster, 'sample0005', 'add', 'su_sample0005', REVIEWER_ID, at('11-19T11:30'), [ROSTER_S1, ROSTER_S2]),
  version(1, SAMPLE_SKILL_IDS.mobile, 'sample0006', 'create', 'su_sample0006', REVIEWER_ID, at('11-20T15:30'), [MOBILE_S1]),
  version(1, SAMPLE_SKILL_IDS.minutes, 'sample0007', 'create', 'su_sample0007', CHIEF_ID, at('11-22T10:30'), [MINUTES_S1]),
  version(2, SAMPLE_SKILL_IDS.minutes, 'sample0008', 'merge', 'su_sample0008', REVIEWER_ID, at('11-24T03:12'), [MINUTES_S1, MINUTES_S2]),
  version(1, SAMPLE_SKILL_IDS.template, 'sample0009', 'create', null, 'hub', at('11-18T14:30'), [TEMPLATE_S1]),
  version(1, SAMPLE_SKILL_IDS.report, 'sample0010', 'create', null, 'hub', at('10-18T14:30'), [REPORT_S1]),
  version(1, SAMPLE_SKILL_IDS.legacy, 'sample0011', 'migrate', null, 'hub', at('11-11T09:00'), [LEGACY_S1]),
]

/** 一次通过核对的技能更新。 */
function update(serial: string, runId: string, kind: 'learn' | 'merge', skillId: string, updatedAt: number,
  sentences: Array<{ text: string; sourceIds: string[] }>, versionNo: number, extra: Record<string, unknown> = {}) {
  return {
    id: `su_${serial}`, botId: SAMPLE_SKILL_BOT_ID, runId, kind, skillId, newSkill: null, mergeFromIds: [] as string[],
    sentences, checkerId: REVIEWER_ID, state: 'passed', checks: [], rewrites: 0, versionNo, createdAt: updatedAt - 600_000, updatedAt, ...extra,
  }
}
const plain = (row: ReturnType<typeof sentence>) => ({ text: row.text, sourceIds: row.sourceIds })

// 八道：表单页做法三道、名单导出两道、手机端适配一道、会议纪要格式一道（学习写出），再加 11月24日 的整理合并一道。
const UPDATES = [
  update('sample0001', 'sr_sampleretr1', 'learn', SAMPLE_SKILL_IDS.form, at('11-13T10:30'), [plain(FORM_S1)], 1),
  update('sample0002', 'sr_sampleretr2', 'learn', SAMPLE_SKILL_IDS.form, at('11-17T09:40'), [plain(FORM_S2), plain(FORM_S3)], 2),
  update('sample0003', 'sr_sampleretr3', 'learn', SAMPLE_SKILL_IDS.form, at('11-20T17:12'), [plain(FORM_S4)], 3),
  update('sample0004', 'sr_sampleretr1', 'learn', SAMPLE_SKILL_IDS.roster, at('11-13T12:00'), [plain(ROSTER_S1)], 1),
  update('sample0005', 'sr_samplelearn', 'learn', SAMPLE_SKILL_IDS.roster, at('11-19T11:30'), [plain(ROSTER_S2)], 2),
  update('sample0006', 'sr_sampleretr3', 'learn', SAMPLE_SKILL_IDS.mobile, at('11-20T15:30'), [plain(MOBILE_S1)], 1),
  update('sample0007', 'sr_samplelearn', 'learn', SAMPLE_SKILL_IDS.minutes, at('11-22T10:30'), [plain(MINUTES_S1)], 1),
  update('sample0008', 'sr_sampletidy1', 'merge', SAMPLE_SKILL_IDS.minutes, at('11-24T03:12'), [plain(MINUTES_S1), plain(MINUTES_S2)], 2, {
    mergeFromIds: [SAMPLE_SKILL_IDS.template], mergeBase: { fromVersionNo: 1, intoVersionNo: 1 },
  }),
]

/** 11月24日 的每周整理记录：整理做完，并按规则收起两条（久未使用、来源不明）。 */
const TIDY_RUN = {
  id: 'sr_sampletidy1', kind: 'tidy', jobId: null, category: null,
  participants: [{ botId: SAMPLE_SKILL_BOT_ID, role: 'executor', sourceIds: [], state: 'done', reason: null }],
  turnsUsed: 2, turnCap: 3, tokens: 0, summaryPostedAt: null, createdAt: at('11-24T03:00'), endedAt: at('11-24T03:15'),
  weekOf: '2026-11-23', activeAtStart: 5,
  collapsed: [
    { skillId: SAMPLE_SKILL_IDS.report, reason: 'unused', days: 34 },
    { skillId: SAMPLE_SKILL_IDS.legacy, reason: 'unknown_source', days: null },
  ],
  merges: [{ updateId: 'su_sample0008', reason: '两条都在讲待办怎么写' }],
}

/** 同类任务记录（表单页两次：活动报名页、会议室预约页；设计稿 C 的数字）。 */
const OUTCOMES = [
  { id: JOB_REG, category: '表单页', executorId: SAMPLE_SKILL_BOT_ID, reviewerId: REVIEWER_ID, title: '活动报名页', rounds: 2, reworks: 1, turns: 14, seq: 1, acceptedAt: at('11-16T18:30') },
  { id: JOB_MEET, category: '表单页', executorId: SAMPLE_SKILL_BOT_ID, reviewerId: REVIEWER_ID, title: '会议室预约页', rounds: 1, reworks: 1, turns: 9, seq: 2, acceptedAt: at('11-20T12:00') },
]

/** 员工与来历：入职 45 天；岗位技能两条（工程师岗位自带的「动手前后自查」、通用的「异常排查四步」）。 */
function botRecords(name: string, botId: string = SAMPLE_SKILL_BOT_ID) {
  const joinedAt = at('10-10T09:00')
  return [
    { id: botId, name, color: '#3f8f7a', createdAt: joinedAt, presetSkillIds: ['build-self-check', 'incident-triage'], dshSkillNames: [] },
    { id: CHIEF_ID, name: '总管', color: '#5b6b8c', createdAt: joinedAt, presetSkillIds: [], dshSkillNames: [] },
    { id: REVIEWER_ID, name: '评审员', color: '#b07a3a', createdAt: joinedAt, presetSkillIds: [], dshSkillNames: [] },
  ]
}

/** 一份样例技能世界：种好记录的 core 环境，加上取视图、发命令用的 UiApi。 */
export interface SkillSample {
  /** core 的界面接口（视图读取与回退、放回命令都走它）。 */
  api: UiApi
  /** 样例员工的编号。 */
  botId: string
  /** 命令执行之后需要通知界面时调用（离线门面接事件用）。 */
  readonly events: ReadonlyArray<{ scope: string; botId: string | null }>
}

/**
 * 造一份样例技能世界。botName 默认「林舟」（设计稿的员工）；离线模式里换成当前员工的名字。
 * options.empty 为真时只有员工、没有任何技能记录（用来看「还没有自己积累的技能」的空状态）。
 * options.botId 换员工编号（P75r7 复核：活动流样例要用离线门面里的「探路」bot-tanlu，员工筛选才筛得到）。
 */
export function createSkillSample(botName = '林舟', options: { empty?: boolean; botId?: string } = {}): SkillSample {
  const botId = options.botId ?? SAMPLE_SKILL_BOT_ID
  const ctx = testing.createTestContext({ clock: new testing.FakeClock(SAMPLE_SKILL_NOW) })
  for (const bot of botRecords(botName, botId)) ctx.store.table('bots').put(bot as never)
  // 岗位名称（「工程师岗位自带」）由员工来历里的模板决定。
  ctx.store.table('botOrigins').put({
    id: botId, botId, templateId: 'engineer', source: 'legacy', proposalId: null,
    joinedAt: at('10-10T09:00'), renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null,
  } as never)
  if (options.empty === true) return { api: createUiApi(ctx, async () => undefined), botId, events: ctx.events }
  for (const row of SKILLS) ctx.store.table('skills').put({ ...row, botId } as never)
  for (const row of VERSIONS) ctx.store.table('skillVersions').put(row as never)
  for (const row of SOURCES) ctx.store.table('skillSources').put({ ...row, botId } as never)
  for (const row of UPDATES) ctx.store.table('skillUpdates').put({ ...row, botId } as never)
  ctx.store.table('skillRuns').put({ ...TIDY_RUN, participants: TIDY_RUN.participants.map(row => ({ ...row, botId })) } as never)
  for (const row of OUTCOMES) ctx.store.table('jobOutcomes').put({ ...row, executorId: row.executorId === SAMPLE_SKILL_BOT_ID ? botId : row.executorId } as never)
  // P75r7（C1）：11月19日 11:00 把「名单导出」回退到第 1 版（当天 11:30 又更新到第 2 版，所以当前版本仍是第 2 版）。
  // 回退和放回在真实数据里只有审计记录，这里按 core 的写法种一条，活动流的「技能库」一行由核心从审计生成。
  ctx.store.log('audit').append({
    id: 'au_sampleroll1', at: at('11-19T11:00'), actor: 'owner', action: 'skill_rollback',
    detail: JSON.stringify({ botId, skillId: SAMPLE_SKILL_IDS.roster, title: '名单导出', versionNo: 1 }),
  } as never)
  return { api: createUiApi(ctx, async () => undefined), botId, events: ctx.events }
}

/** 样例技能库视图（员工右侧栏一栏）：由 core 的 skillLibrary 生成。 */
export function sampleSkillLibrary(sample: SkillSample = createSkillSample()): SkillLibraryView {
  return sample.api.skillLibrary(sample.botId)
}

/** 样例技能详情（按技能编号）：由 core 的 skillDetail 生成。 */
export function sampleSkillDetail(skillId: string, sample: SkillSample = createSkillSample()): SkillDetailView {
  return sample.api.skillDetail(skillId)
}

/**
 * P75r7（C1）：样例活动流里「技能库」一类的行，由 core 的 activity 生成（整理一行带细项、七条技能更新、一条回退）。
 * 默认员工是离线门面里的「探路」（bot-tanlu）：活动流的员工筛选只列总览里的员工，样例必须用同一个编号，选「探路」才筛得到。
 * 只在宿主侧用（生成预览快照用）；浏览器包不能引 core，所以预览与离线门面用 fixture-activity-skill.ts 里
 * 由这份输出冻结下来的那份，并由测试钉住「样例行等于核心的输出」。
 */
export function sampleSkillActivityRows(sample: SkillSample = createSkillSample('探路', { botId: 'bot-tanlu' })): ActivityRow[] {
  const view = sample.api.activity() as unknown as { rows: ActivityRow[] }
  return view.rows.filter(row => row.kind === 'skill')
}
