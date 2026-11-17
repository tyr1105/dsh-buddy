/**
 * P75h 测试的公共环境（不是测试文件）：在 P75g 的真实链路（派活、交回、核对、返工、验收、复盘）之上，
 * 提供「执行者提交技能更新之后，核对人拿到唤醒」的各种起点，以及只靠唤醒包文字取值的小工具
 * （更新编号、核对段、改写段、改写后可用的 src 编号）。
 *
 * 为什么走真实链路：核对要经过真实的闸门、唤醒包、工具和回合收尾，才能测到接线；
 * 夹具里总管、执行者、评审员都是听吩咐的（与真实创建出来的一致），时间全部用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import type { SkillUpdate } from '../src/model/skill.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { writeSkillVersion } from '../src/skill/store.js';
import { newId } from '../src/util/ids.js';
import {
  bot, callTool, commitAndEnd, flow, nextPacket, retroRun, retroTurn, srcsIn, threadOf,
  type JobFix,
} from './p75g-fixtures.js';

export * from './p75g-fixtures.js';

/** 验收时主人指出第 3 条不符（核对退回过第 3 条，评审员核对时判了符合，所以评审员漏判）。 */
export const THIRD_BACK = { no: 3, text: '第 3 条还是不对：失败时页面没有任何提示', problem: '失败时页面没有任何提示' };

/** 给这位员工放一条已有的自己积累的技能（直接走技能库的写入函数，类别「表单页」）。 */
export async function seedSkill(fix: JobFix, botId: string, title: string, texts: string[]): Promise<string> {
  const source = SkillSourceSchema.parse({
    id: newId('ss', fix.ctx.rng), botId, kind: 'review', label: '旧事第 1 轮退回第 1 条', quote: '提示文字与约定不一致',
    relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: fix.ctx.clock.now(),
  });
  fix.ctx.store.table('skillSources').put(source);
  await writeSkillVersion(fix.ctx, {
    botId, change: 'create', newSkill: { title, whenToUse: '做表单页时用', supplements: null },
    sentences: texts.map(text => ({ text, sourceIds: [source.id] })), updateId: null, checkedBy: null, categories: ['表单页'],
  });
  return fix.ctx.store.table('skills').list(row => row.botId === botId && row.title === title)[0]!.id;
}

/** 清掉这件事的复盘记录、出处和技能类候选，用来在同一份数据上换一个条件重新安排。 */
export function clearRetro(fix: JobFix): void {
  for (const row of fix.ctx.store.table('skillRuns').list()) fix.ctx.store.table('skillRuns').remove(row.id);
  for (const row of fix.ctx.store.table('skillSources').list()) fix.ctx.store.table('skillSources').remove(row.id);
  for (const row of fix.ctx.store.table('queue').list(entry => /^(retro|skillcheck|tidy):/.test(entry.subjectKey))) fix.ctx.store.table('queue').remove(row.id);
}

/** 取出唤醒包里的「本轮核对技能更新」段（到下一个二级标题或结尾）。 */
export function checkSectionOf(packet: string): string {
  const start = packet.indexOf('## 本轮核对技能更新：');
  expect(start, '唤醒包里应该有「本轮核对技能更新」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start);
  const next = rest.slice(4).search(/\n\n## /);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** 取出唤醒包里的「改写技能更新」段。 */
export function rewriteSectionOf(packet: string): string {
  const start = packet.indexOf('## 改写技能更新：');
  expect(start, '唤醒包里应该有「改写技能更新」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start);
  const next = rest.slice(4).search(/\n\n## /);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** 只靠正则从核对段取出每条更新的编号与「提交人的「技能」：…」那一行。 */
export function updatesIn(packet: string): Array<{ id: string; line: string }> {
  return [...checkSectionOf(packet).matchAll(/^updateId (su_[0-9a-z]+)｜(.+)$/gm)].map(match => ({ id: match[1]!, line: match[2]! }));
}

/** 只靠正则从改写段取出更新编号。 */
export function rewriteIdsIn(packet: string): string[] {
  return [...rewriteSectionOf(packet).matchAll(/^updateId (su_[0-9a-z]+)｜/gm)].map(match => match[1]!);
}

/** 只靠正则从改写段取出可用的 src 编号与它的种类、标签、原文。 */
export function rewriteSrcsIn(packet: string): Array<{ src: string; kind: string; label: string; quote: string }> {
  // P75r5b：出处原文放进不可信围栏，正则相应改成取围栏里的原文；返回的形状不变。
  return [...rewriteSectionOf(packet).matchAll(/^ {3}(src\d+) (\S+)｜(.+?)：\n<<<untrusted\n([\s\S]*?)\nuntrusted>>>$/gm)]
    .map(match => ({ src: match[1]!, kind: match[2]!, label: match[3]!, quote: match[4]! }));
}

/** 这位员工在这次复盘里提交的更新（从旧到新）。 */
export function updatesOf(fix: JobFix, botId?: string): SkillUpdate[] {
  return fix.ctx.store.table('skillUpdates').list(row => botId === undefined || row.botId === botId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 执行者提交时用的两句话（一句引评审意见，一句引主人纠正）。 */
export function twoSentences(review: string, correction: string) {
  return [
    { text: '失败时页面要显示明确的失败提示', sources: [review] },
    { text: '改完先自己断开接口试一遍', sources: [correction] },
  ];
}

/** 起点一：核对退回过、验收时指出第 3 条；林舟已为「表单页做法」提交两句更新并结束回合。评审员的合并唤醒还没有拿到。 */
export async function afterExecutorProposes(options: { seed?: string[]; checker?: 'reviewer' | 'chief'; sentences?: number } = {}) {
  const checker = options.checker ?? 'reviewer';
  const made = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, checker });
  const { fix, job } = made;
  await seedSkill(fix, fix.engineer.id, '表单页做法', options.seed ?? ['提交后显示明确的成功提示']);
  const exec = await retroTurn(fix, fix.engineer.id);
  const srcs = srcsIn(exec.packet);
  const review = srcs.find(row => row.kind === '评审意见')!;
  const correction = srcs.find(row => row.label.includes('验收第'))!;
  const proposed = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [
    { skill: '表单页做法', sentences: twoSentences(review.src, correction.src) }] });
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交。' });
  return { fix, job, run: retroRun(fix, job.id)!, review, correction, checkerId: checker === 'reviewer' ? fix.reviewer.id : fix.chief.id };
}

/** 退回改写时核对人写的说明（出处只要求文字一致，没有提到颜色和位置）。 */
export const REJECT_NOTE = '出处只要求提示文字与约定一致，没有提到颜色和位置。第 2 句删去「断开接口试一遍」，改成「交回前试一次失败提示」就能写入。';

/**
 * 评审员在合并唤醒里把唯一一条更新判为超出出处（withinScope 写 unmet、note 写明），
 * 自己的复盘写「没有可写的」（让评审员的参与者记 done），结束回合。返回更新编号。
 * 退回之后林舟被排了一次改写唤醒（事项键 retro:…:rewrite），还没有拿到。
 */
export async function reviewerRejects(fix: JobFix, note = REJECT_NOTE): Promise<string> {
  const packet = await nextPacket(fix, fix.reviewer.id);
  const updateId = updatesIn(packet)[0]!.id;
  const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'unmet', note });
  expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: '已退回林舟改写一次。' });
  const proposed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' });
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '已退回改写。' });
  return updateId;
}

/** 林舟拿到改写唤醒，返回整个唤醒包。 */
export async function rewritePacket(fix: JobFix): Promise<string> {
  return nextPacket(fix, fix.engineer.id);
}

/** 主题里的复盘类消息（复盘卡、改写卡、核对卡、小结），从旧到新。 */
export function retroMessages(fix: JobFix, job: Job) {
  return threadOf(fix.ctx, job.topicId).filter(row => /^(retro|skillcheck|retro-summary):/.test(row.refId ?? ''));
}
