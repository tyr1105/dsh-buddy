/**
 * P75i 测试的公共环境（不是测试文件）：教它技能（学习）与每周整理共用的小工具。
 *
 * 为什么走真实链路：学习要经过总管的回合（调用 teach、回复落下之后落提问卡）、主人选会话（按钮、「待你处理」两个入口）、
 * 员工的学习回合、核对人的回合；整理要经过 tick 的巡检、闸门、整理回合与核对回合。
 * 夹具里总管、执行者、评审员都是听吩咐的（与真实创建出来的一致，总管是自动建的、安静节奏），
 * 时间用注入的假时钟；推进不超过 10 分钟，要跨天时直接把假时钟设到目标时刻（setLocal）。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具。
 */
import { expect } from 'vitest';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import type { SkillRun } from '../src/model/skill.js';
import { SkillUpdateSchema, SkillSourceSchema } from '../src/model/skill.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { newId } from '../src/util/ids.js';
import { chiefHears, jobFix, staffNamesIn } from './p75c-fixtures.js';
import { bot, callTool, commitAndEnd, flow, nextPacket, seedSkill, type JobFix } from './p75h-fixtures.js';

export * from './p75h-fixtures.js';
export { chiefHears, jobFix, staffNamesIn };

/** 主人对总管说的那句话（任务卡第 8 节第 1 条）。 */
export const TEACH_OWNER_TEXT = '让林舟学一下我昨天在 DSH 里导出表格的做法，以后导出名单就这么做';

/** 三段最近的会话（标题、会话编号、摘要）。 */
export const SESSIONS = [
  { id: 'ses-export', title: '导出报名表', digest: '主人导出报名表的做法：先按报名时间从早到晚排序，再导出成 CSV，文件名带日期；导出之前先确认第一行是列名。' },
  { id: 'ses-poster', title: '做活动海报', digest: '主人做海报：先定标题再排版，颜色只用两种。' },
  { id: 'ses-weekly', title: '整理周报', digest: '主人整理周报：每条只写一句结论。' },
] as const;

/** 给假宿主放三段最近的会话（按从新到旧排，第一段最新）和各自的摘要。 */
export function putSessions(fix: JobFix, count = 3): void {
  const host = fix.ctx.host as FakeHost;
  host.recentSessions.length = 0;
  SESSIONS.slice(0, count).forEach((row, index) => {
    host.recentSessions.push({ sessionId: row.id, title: row.title, updatedAt: fix.ctx.clock.now() - (index + 1) * 3_600_000 });
    host.digests.set(row.id, row.digest);
  });
}

/**
 * 把假时钟直接设到某个本地时刻（设置的时区，格式 YYYY-MM-DD HH:mm）。
 * 跨天跳过去之后员工的会话会超过「会话最长存活时间」，中心会给他们换新会话（唤醒包随新会话一起送出，不再走「投递」），
 * 测试读不到唤醒包；所以同时把每位员工的会话开始时间改成现在，让他们沿用原来的会话。
 */
export function setLocal(fix: JobFix, text: string): void {
  fix.ctx.clock.set(parseLocalDateTime(text, fix.ctx.settings.timezone));
  for (const row of fix.ctx.store.table('bots').list()) fix.ctx.store.table('bots').patch(row.id, { sessionStartedAt: fix.ctx.clock.now() });
}

/** 迁移已完成（teach、每周整理的前提）；夹具启动时就应该是完成的，这里断言前提而不是人为改。 */
export function expectMigrated(fix: JobFix): void {
  expect(fix.ctx.store.table('migrations').get('p75-storage')?.state, '夹具启动后迁移应已完成').toBe('done');
}

/** 一次学习的记录（最新的一条）；没有时为 null。 */
export function learnRun(fix: JobFix): SkillRun | null {
  // 从旧到新（同一毫秒建的按写入先后），取最后一条。
  return fix.ctx.store.table('skillRuns').list(row => row.kind === 'learn').sort((a, b) => a.createdAt - b.createdAt).at(-1) ?? null;
}

/** 总管私聊里的全部消息，从旧到新。 */
export function chiefChat(fix: JobFix) {
  return fix.ctx.store.log('thread').all().filter(row => row.thread === fix.chief.id);
}

/** 总管私聊里学习选会话的提问卡（kind 为 question、指向 learn: 条目）。 */
export function learnCards(fix: JobFix) {
  const items = new Map(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('learn:')).map(row => [row.id, row]));
  return chiefChat(fix).filter(row => row.kind === 'question' && row.refId !== null && items.has(row.refId));
}

/** 「待你处理」里学习选会话的条目（全部状态）。 */
export function learnItems(fix: JobFix) {
  return fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('learn:')).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 主人对总管说一句要员工学习的话，总管拿到回合，只从唤醒包里取员工名字，调用 teach；返回工具结果和总管这一回合的唤醒包。
 * 总管的回合还开着（没有交账），调用者可以接着交账或再调用别的。
 */
export async function chiefTeaches(fix: JobFix, ownerText = TEACH_OWNER_TEXT, note = '导出表格的做法，以后导出名单就这么做') {
  const packet = await chiefHears(fix, ownerText);
  // 只取员工名字：唤醒包的团队一节里的员工名，且主人这句话里提到的那位（不取总管自己）。
  const staff = staffNamesIn(packet).find(name => ownerText.includes(name) && name !== fix.chief.name);
  expect(staff, '总管唤醒包里应该有主人提到的员工名字').toBeDefined();
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_skill', { mode: 'teach', staff, note });
  return { result, packet, staff: staff! };
}

/** 学习的完整前半：夹具里放好会话、总管 teach 并交账（回复「是哪一段？」，落提问卡）；返回学习记录和那张卡。 */
export async function learnAsked(fix: JobFix) {
  putSessions(fix);
  const { result } = await chiefTeaches(fix);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '请主人选会话', reply: '是哪一段？' });
  const run = learnRun(fix)!;
  const card = learnCards(fix)[0]!;
  return { run, card, item: learnItems(fix)[0]! };
}

/** 学习唤醒包里「## 学习：」那一段（到下一个二级标题或结尾）。 */
export function learnSectionOf(packet: string): string {
  const start = packet.indexOf('## 学习：');
  expect(start, '唤醒包里应该有「学习」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start);
  const next = rest.slice(4).search(/\n\n## /);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** 只靠正则从学习段取出出处编号与标签（「出处：src1 你的指示｜{标签}」）。 */
export function learnSrcIn(packet: string): { src: string; kind: string; label: string } {
  const match = /^出处：(src\d+) (\S+)｜(.+)$/m.exec(learnSectionOf(packet));
  expect(match, '学习段里应该有出处一行').not.toBeNull();
  return { src: match![1]!, kind: match![2]!, label: match![3]! };
}

/** 学习员工拿到学习回合，只用唤醒包里的 src 编号提交三句做法（已有技能「名单导出」新增三句）；返回结果。 */
export async function learnerProposes(fix: JobFix, skill = '名单导出') {
  const packet = await nextPacket(fix, fix.engineer.id);
  const { src } = learnSrcIn(packet);
  // P75r6 同步：已有技能在围栏外用编号（sk1）指代，只用唤醒包里的文字：按名称（在围栏里）找到它的编号；找不到时才退回原来的名称写法。
  const refMatch = new RegExp(`^- (sk\\d+)（第 \\d+ 版）：\\n<<<untrusted\\n名称：${skill}\\n`, 'm').exec(learnSectionOf(packet));
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{ skill: refMatch?.[1] ?? skill, sentences: [
    { text: '导出前先按报名时间从早到晚排序', sources: [src] },
    { text: '导出成 CSV，文件名带日期', sources: [src] },
    { text: '导出之前先确认第一行是列名', sources: [src] },
  ] }] });
  return { result, packet, src };
}

/** 放一条已有技能「名单导出」（林舟），返回技能编号。 */
export async function seedExport(fix: JobFix): Promise<string> {
  return seedSkill(fix, fix.engineer.id, '名单导出', ['导出前先确认有哪些列']);
}

/** 林舟、总管、评审员的全部技能类候选事项键（队列里）。 */
export function skillKeysOf(fix: JobFix): string[] {
  return fix.ctx.store.table('queue').list(row => /^(retro|skillcheck|tidy|learn):/.test(row.subjectKey)).map(row => row.subjectKey);
}

/** 这位员工的整理记录（本周一日期为 weekOf 时只看那一周）。 */
export function tidyRuns(fix: JobFix, botId?: string, weekOf?: string): SkillRun[] {
  return fix.ctx.store.table('skillRuns')
    .list(row => row.kind === 'tidy' && (weekOf === undefined || row.weekOf === weekOf) && (botId === undefined || row.participants.some(item => item.botId === botId)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 直接放一条「上周通过的技能更新」（整理触发的条件之一），updatedAt 是通过的时刻。 */
export function seedPassedUpdate(fix: JobFix, botId: string, skillId: string, at: number): string {
  const skill = fix.ctx.store.table('skills').get(skillId)!;
  const sourceId = fix.ctx.store.table('skillVersions').list(row => row.skillId === skillId)[0]!.sentences[0]!.sourceIds[0]!;
  const update = SkillUpdateSchema.parse({
    id: newId('su', fix.ctx.rng), botId, runId: newId('sr', fix.ctx.rng), kind: 'learn', skillId, newSkill: null, mergeFromIds: [],
    sentences: [{ text: `${skill.title}补充一句`, sourceIds: [sourceId] }], checkerId: fix.reviewer.id, state: 'passed',
    checks: [{ at, checkerId: fix.reviewer.id, exists: 'met', consistent: 'met', withinScope: 'met', note: null }],
    rewrites: 0, versionNo: skill.currentVersionNo, createdAt: at, updatedAt: at,
  });
  fix.ctx.store.table('skillUpdates').put(update);
  return update.id;
}

/** 放一条「来源不明」的技能（出处种类 unknown）。 */
export async function seedUnknownSkill(fix: JobFix, botId: string, title: string): Promise<string> {
  const { writeSkillVersion } = await import('../src/skill/store.js');
  const source = SkillSourceSchema.parse({
    id: newId('ss', fix.ctx.rng), botId, kind: 'unknown', label: '迁移：原套路', quote: '原套路', relayed: false, jobId: null, category: null,
    refs: {}, createdAt: fix.ctx.clock.now(),
  });
  fix.ctx.store.table('skillSources').put(source);
  await writeSkillVersion(fix.ctx, { botId, change: 'create', newSkill: { title, whenToUse: '用到时', supplements: null },
    sentences: [{ text: '迁移来的一句', sourceIds: [source.id] }], updateId: null, checkedBy: 'hub', categories: [] });
  return fix.ctx.store.table('skills').list(row => row.botId === botId && row.title === title)[0]!.id;
}

/** 假时钟所在的这一周的周一（夹具起点是 2026-11-05 周四；设置时区北京时间）。 */
export const MONDAY = '2026-11-16';
/** 上一周里的一个时刻（周四 10:00）：整理看「上周一 00:00 到本周一 00:00 之间有没有通过的更新」。 */
export const LAST_WEEK_AT = '2026-11-12 10:00';

/**
 * 整理的场景：一条真实链路（林舟交回的事被评审甲核对过，所以林舟的核对人是评审甲），林舟有两条在用技能
 * 「手机端适配」「表单页做法」（出处各不相同），上周四通过过一次技能更新；假时钟设到本周一 03:10（已过整理时刻，还没巡检）。
 * 总管和评审员没有技能、没有更新，整理时记「没有变化」。
 */
export async function tidyScene() {
  const made = await flow();
  const { fix } = made;
  expectMigrated(fix);
  const phone = await seedSkill(fix, fix.engineer.id, '手机端适配', ['手机上不出现横向滚动']);
  fix.ctx.clock.advance(1_000); // 两条技能的建立时间错开，整理唤醒包里的排列顺序固定（先「手机端适配」后「表单页做法」）
  const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
  const updateId = seedPassedUpdate(fix, fix.engineer.id, form, parseLocalDateTime(LAST_WEEK_AT, fix.ctx.settings.timezone));
  setLocal(fix, `${MONDAY} 03:10`);
  return { ...made, phone, form, updateId };
}

/** 一位员工拿到整理唤醒，返回整个唤醒包。 */
export async function tidyPacket(fix: JobFix, botId: string): Promise<string> {
  return nextPacket(fix, botId);
}

/** 唤醒包里「## 每周整理：你的技能库」那一段。 */
export function tidySectionOf(packet: string): string {
  const start = packet.indexOf('## 每周整理：你的技能库');
  expect(start, '唤醒包里应该有「每周整理」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start);
  const next = rest.slice(4).search(/\n\n## /);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/**
 * 只靠正则从整理段取出每条技能名。
 * P75r6 同步：技能名称放进围栏（围栏外只有编号 sk1），所以改成取「- sk1（第 n 版）：」下面围栏里的「名称：…」；返回的形状不变。
 */
export function tidySkillNamesIn(packet: string): string[] {
  return [...tidySectionOf(packet).matchAll(/^- sk\d+（第 \d+ 版）：\n<<<untrusted\n名称：(.+)\nuntrusted>>>$/gm)].map(match => match[1]!);
}

/** P75r6：只靠正则从整理段取出每条技能的编号（围栏外的 sk1 这样的写法），与 tidySkillNamesIn 同序。 */
export function tidySkillRefsIn(packet: string): string[] {
  return [...tidySectionOf(packet).matchAll(/^- (sk\d+)（第 \d+ 版）：\n<<<untrusted\n名称：(.+)\nuntrusted>>>$/gm)].map(match => match[1]!);
}

/** 只靠正则从整理段取出某条技能第 k 句的出处编号（「k.（出处 src1、src2）」，名称在围栏里，按名称找到它的那一行）。 */
export function tidySrcsOfSkill(packet: string, title: string): string[] {
  const lines = tidySectionOf(packet).split('\n');
  const at = lines.findIndex(line => line === `名称：${title}`);
  const srcs: string[] = [];
  for (let i = at + 1; i < lines.length && !lines[i]!.startsWith('- ') && !lines[i]!.startsWith('出处：'); i += 1) {
    const match = /（出处 (.+)）$/.exec(lines[i]!);
    if (match !== null) for (const src of match[1]!.split('、')) if (!srcs.includes(src)) srcs.push(src);
  }
  return srcs;
}
