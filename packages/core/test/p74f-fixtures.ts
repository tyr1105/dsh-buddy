/**
 * P74f 测试的公共环境（不是测试文件）：在 P74d 的真实 Hub 夹具上，提供「核对通过、已交付、等主人验收」的起点，
 * 以及只靠唤醒包文字取值的正则（reopen 的 jobId 和条目序号）、主人在主题里发话的小工具。
 * 为什么走真实链路：交付、验收要经过真实的核对、状态机、巡检，才能测到接线；时间全部用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import {
  bot, callTool, engineerSubmits, executorInfo, jobFix, nextPacket, putStandardFiles, reviewerInfo, reviewerThoughtRecently, sectionOf, started, theJob,
  threadOf, tick, INTERNAL, MINUTE, lastPacket, type JobFix,
} from './p74d-fixtures.js';
import { assignArgs, commitAndEnd } from './p74c-fixtures.js';
import { chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';

export { bot, callTool, nextPacket, sectionOf, theJob, threadOf, tick, INTERNAL, MINUTE, lastPacket, started, engineerSubmits };
export type { JobFix };

/** 三条全部符合的第 1 轮核对结论（第 1 条交付时核对）。 */
export const PASS_ITEMS = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动' }, { no: 3, verdict: 'met' }];

/**
 * 派活、林舟交回、核对人核对通过：这件事已交付，等主人验收。
 * reviewer 写「总管」时由总管自己核对。返回这件事（交付之后的最新记录）。
 */
export async function delivered(extraEngineers: string[] = [], assignExtra: Record<string, unknown> = {}): Promise<{ fix: JobFix; job: Job; who: { id: string } }> {
  const s = await started(extraEngineers, assignExtra);
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const who = assignExtra.reviewer === '总管' ? s.fix.chief : s.fix.reviewer;
  const seen = reviewerInfo(await nextPacket(s.fix, who.id));
  const result = await callTool(s.fix, bot(s.fix, who.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, who.id, { outcome: 'progress', summary: '核对通过' });
  return { fix: s.fix, job: theJob(s.fix), who };
}

/**
 * 同 delivered，但按指定的「怎样算做完」建约定（第 1 条交付时核对），逐条给结论：第 1 条交付时核对，其余符合。
 * 用于需要四条以上条目的测试（只删去一条后仍不少于 3 条）。
 */
export async function deliveredWith(doneWhen: string[]): Promise<{ fix: JobFix; job: Job }> {
  const fix = await jobFix();
  await chiefDrafts(fix as never, { title: '会员定价页', doneWhen });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
  await tick(fix, 10 * MINUTE);
  reviewerThoughtRecently(fix);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
  const items = [{ no: 1, verdict: 'at_delivery' }, ...doneWhen.slice(1).map((_, i) => ({ no: i + 2, verdict: 'met' }))];
  expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
  return { fix, job: theJob(fix) };
}

/** 这件事主题里的交付卡消息（最新一张）。 */
export function deliveryCard(fix: JobFix, job: Job) {
  return threadOf(fix.ctx, job.topicId).filter(row => row.kind === 'job_card' && row.refId?.startsWith('delivery:')).at(-1);
}

/** 这件事开着的条目。 */
export function openItems(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:`));
}

/** 主人在这个线程里发一句话（经界面命令），必须成功。 */
export async function ownerTypes(fix: JobFix, threadId: string, text: string) {
  const result = await fix.hub.api.sendMessage(threadId, text);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return result;
}

/** 总管这一回合唤醒包里：只靠文字取 jobId 和「交付卡条目」里的序号。 */
export function reopenInfo(packet: string): { jobId: string; nos: number[] } {
  const text = sectionOf(packet);
  const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)?.[1];
  expect(jobId, '总管唤醒包里应该有 jobId').toBeDefined();
  const line = /交付卡条目：(.+?)。\n/.exec(`${text}\n`)?.[1];
  expect(line, '总管唤醒包里应该有交付卡条目').toBeDefined();
  const nos = [...line!.matchAll(/(?:^|；)(\d+)\. /g)].map(match => Number(match[1]));
  return { jobId: jobId!, nos };
}

/** 给主人看的消息（主题和总管私聊）里有没有内部名称。 */
export function internalLeaks(fix: JobFix, job: Job): string[] {
  const rows = [...threadOf(fix.ctx, job.topicId), ...threadOf(fix.ctx, job.chiefId)];
  return rows.filter(row => row.kind !== 'work' && INTERNAL.test(row.text)).map(row => row.text);
}

/** 让总管拿到主人发话叫醒的回合（等最多 40 分钟，每次 5 分钟）。 */
export async function chiefTurn(fix: JobFix): Promise<string> {
  for (let i = 0; i < 8 && !fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]; i += 1) await tick(fix, 5 * MINUTE);
  return lastPacket(fix, bot(fix, fix.chief.id));
}
