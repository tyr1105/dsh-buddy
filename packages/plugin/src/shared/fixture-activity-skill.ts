/**
 * 活动流里「技能库」一类的样例行（P75k 建立，P75r7（C1）改为由核心生成后冻结）。
 *
 * 为什么单独一份：基础样例 fixtureActivity 有十行，测试按十行断言，不能往里加；
 * 技能库记录（kind 为 skill）拼在基础样例后面，活动流页的「类型」筛选选「技能库」就能看到它们。
 *
 * P75r7 的改动：这九行不再是手写的样例句子，而是由 core 的 activity 视图生成后原样冻结下来的
 * （fixture-skill.ts 的 createSkillSample 那个内存核心里有一次每周整理、七次技能更新、一次回退）。
 * 手写样例与同一份预览里的技能库数据互相矛盾（版本号、句式都不是核心的写法），所以改成核心的输出。
 * P75r7 复核：员工固定为离线门面里的「探路」（bot-tanlu），与技能库样例同一个员工——
 * 活动流的员工筛选只列总览里的员工，编号不一致时选「探路」会把这几行全筛掉。
 * 浏览器包不能引 core（见 scripts/dev/core-preview.ts），所以冻结在这里；测试
 * 把 SAMPLE_SKILL_ACTIVITY_ROWS 与核心实时生成的行逐字比对，core 改了句子那里会报出来，要照新输出重新冻结。
 *
 * 时间：核心在样例时刻（2026-11-24 09:30）生成的行带绝对时间文字；拼接时整体平移到调用方的 now
 * （只改 at 与时间文字，句子不动），让离线门面与预览里的这几行仍显示为最近发生的。
 *
 * 核心这几句文字一改，必须同步这份快照。
 */
import type { ActivityRow } from './views.js'

/** 样例时刻（与 fixture-skill.ts 的 SAMPLE_SKILL_NOW 相同）。 */
export const SAMPLE_SKILL_ACTIVITY_NOW = Date.parse('2026-11-24T09:30:00+08:00')

/** 核心在样例时刻生成的「技能库」九行（每周整理一、技能更新七、回退一），逐字冻结，不要手改。 */
export const SAMPLE_SKILL_ACTIVITY_ROWS: ActivityRow[] = [
  { id: 'skill-tidy:sr_sampletidy1', at: 1795461300000, timeText: '今天 03:15', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '每周整理　探路　评审员核对通过',
    lines: [
      '探路自己积累的技能　5 条变为 4 条',
      '合并　「纪要模板」并入「会议纪要格式」第 2 版。两条都在讲待办怎么写；两处出处都保留。',
      '收起　「周报排版」34 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。',
      '收起　「交付前检查」来源不明，30 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。',
    ] },
  { id: 'skill-update:su_sample0007', at: 1795314600000, timeText: '11月22日 10:30', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「会议纪要格式」第 1 版，来自你的指示（会话『周会记录整理』）。评审员核对通过。' },
  { id: 'skill-update:su_sample0003', at: 1795165920000, timeText: '11月20日 17:12', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「表单页做法」第 3 版，来自你的纠正（会议室预约页验收第 2 条）。评审员核对通过。' },
  { id: 'skill-update:su_sample0006', at: 1795159800000, timeText: '11月20日 15:30', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「手机端适配」第 1 版，来自评审意见（会议室预约页第 1 轮）。评审员核对通过。' },
  { id: 'skill-update:su_sample0005', at: 1795059000000, timeText: '11月19日 11:30', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「名单导出」第 2 版，来自你的指示（会话『名单整理』）。评审员核对通过。' },
  // 回退：11月19日 11:00 把「名单导出」回退到第 1 版，当天 11:30 又更新到第 2 版（与技能库里的当前版本一致）。
  { id: 'au_sampleroll1', at: 1795057200000, timeText: '11月19日 11:00', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能回退　探路　「名单导出」已回退到第 1 版。' },
  { id: 'skill-update:su_sample0002', at: 1794879600000, timeText: '11月17日 09:40', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「表单页做法」第 2 版，来自评审意见（活动报名页第 1 轮退回第 3 条）等 2 处。评审员核对通过。' },
  { id: 'skill-update:su_sample0004', at: 1794542400000, timeText: '11月13日 12:00', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「名单导出」第 1 版，来自验收结果（活动报名页验收通过）。评审员核对通过。' },
  { id: 'skill-update:su_sample0001', at: 1794537000000, timeText: '11月13日 10:30', botId: 'bot-tanlu', botName: '探路', botColor: '#3f8f7a', kind: 'skill',
    text: '技能更新　探路　「表单页做法」第 1 版，来自评审意见（「数据核对」任务第 1 轮）。评审员核对通过。' },
]

/** 时间文字：与 core 的 shortTime 同一形态（M月D日 HH:mm）。 */
function timeTextOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 样例技能库记录（时间平移到 now，句子原样来自 core）；离线门面和预览用。 */
export function fixtureSkillActivityRows(now: number = Date.now()): ActivityRow[] {
  const delta = now - SAMPLE_SKILL_ACTIVITY_NOW
  if (delta === 0) return SAMPLE_SKILL_ACTIVITY_ROWS.map(row => ({ ...row }))
  return SAMPLE_SKILL_ACTIVITY_ROWS.map(row => ({ ...row, at: row.at + delta, timeText: timeTextOf(row.at + delta) }))
}
