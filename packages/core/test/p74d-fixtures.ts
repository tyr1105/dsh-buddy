/**
 * P74d 测试的公共环境（不是测试文件）：在 P74c 的真实 Hub 夹具上，提供
 * 「只从唤醒包文字里取值」的正则、把文件放进主题文件夹的小工具、第一次交回的一组合法参数、
 * 以及「零写入」的快照比较。
 * 为什么走真实链路：交回、核对要经过工具、真实的启动整理、调度闸门，才能测到接线；不用人为调高分值的候选。
 * 时间全部用注入的假时钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import { lastPacket } from './p63-topic-fixtures.js';
import {
  MINUTE, bot, callTool, entriesOf, eventsOf, jobFix, runningJob, runningOf, theJob, threadOf, tick, type JobFix,
} from './p74c-fixtures.js';

export { MINUTE, bot, callTool, entriesOf, eventsOf, jobFix, runningOf, theJob, threadOf, tick, lastPacket };
export type { JobFix };

/** 内部名称：给主人看的文字里不许出现。 */
export const INTERNAL = /hub_|\bb_[0-9a-z]{10}|job_|agr_|jsb_|jrv_|jev_/;

/** 一个最小的真实 PNG（1 x 1 像素）。 */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const SECTION = '## 你手上的事（中心维护）';

/** 取出「你手上的事」段的正文（到下一个二级标题或结尾）。 */
export function sectionOf(packet: string): string {
  const start = packet.indexOf(SECTION);
  expect(start, '唤醒包里应该有「你手上的事」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start + SECTION.length);
  const next = rest.search(/\n\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 只从唤醒包文字里取到的、执行者交回需要的全部值。 */
export interface PacketInfo {
  jobId: string;
  /** 主题文件夹的绝对路径（从「约定」文件的路径取）。 */
  jobDir: string;
  /** 相对项目文件夹的主题文件夹，例如 jobs/job_xxx。 */
  folder: string;
  items: Array<{ no: number; text: string; atDelivery: boolean }>;
}

/** 执行者的唤醒包：只用正则取 jobId、「怎样算做完」的序号与「交付时核对」标记、主题文件夹路径。 */
export function executorInfo(packet: string): PacketInfo {
  const text = sectionOf(packet);
  const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)?.[1];
  expect(jobId, '唤醒包里应该有 jobId').toBeDefined();
  const jobDir = /约定 (\S+)\/约定\.md；/.exec(text)?.[1];
  expect(jobDir, '唤醒包里应该有约定文件的路径').toBeDefined();
  const folder = /to 写 (jobs\/job_[0-9a-z]{10})\/交付\//.exec(text)?.[1];
  expect(folder, '唤醒包里应该有放交付物的路径').toBeDefined();
  const start = text.indexOf('怎样算做完（交回时逐条对应，no 写序号）：');
  expect(start).toBeGreaterThanOrEqual(0);
  const items: PacketInfo['items'] = [];
  for (const line of text.slice(start).split('\n').slice(1)) {
    const match = /^(\d+)\. (.+)$/.exec(line);
    if (!match) break;
    items.push({ no: Number(match[1]), text: match[2]!, atDelivery: match[2]!.includes('（交付时核对：') });
  }
  expect(items.length).toBeGreaterThan(0);
  return { jobId: jobId!, jobDir: jobDir!, folder: folder!, items };
}

/** 核对人的唤醒包：只取 jobId 和交回里的条目序号。 */
export function reviewerInfo(packet: string): { jobId: string; nos: number[] } {
  const text = sectionOf(packet);
  const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)?.[1];
  expect(jobId, '核对人唤醒包里应该有 jobId').toBeDefined();
  const start = text.indexOf('的交回（');
  expect(start).toBeGreaterThanOrEqual(0);
  const nos: number[] = [];
  for (const line of text.slice(start).split('\n').slice(1)) {
    const match = /^(\d+)\. /.exec(line);
    if (match) nos.push(Number(match[1]));
  }
  return { jobId: jobId!, nos };
}

/** 把文件放进主题文件夹（用唤醒包里取到的绝对路径）。 */
export async function putFile(fix: JobFix, info: { jobDir: string }, rel: string, data: string | Buffer): Promise<void> {
  const path = `${info.jobDir}/${rel}`;
  if (typeof data === 'string') await fix.ctx.fs.writeTextAtomic(path, data);
  else await fix.ctx.fs.writeBytesAtomic(path, data);
}

/** 放好第一次交回要用的三个文件：交付 html、两张截图。 */
export async function putStandardFiles(fix: JobFix, info: PacketInfo): Promise<void> {
  await putFile(fix, info, '交付/报价页.html', '<html>报价</html>');
  await putFile(fix, info, '证据/手机.png', PNG);
  await putFile(fix, info, '证据/桌面.png', PNG);
}

/** 一条符合的自查：附一张截图。 */
export function metWithImage(no: number, rel = '证据/手机.png') {
  return { no, selfCheck: 'met', evidence: [{ kind: 'image', path: rel, summary: '手机　390 宽' }] };
}

/**
 * 第一次交回的一组合法参数：交付时核对的条目写 at_delivery，其余附证据；
 * 第 2 条一张截图，其余普通条目一份文件加一条测试结果。
 */
export function firstSubmitArgs(info: PacketInfo, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'submit', jobId: info.jobId, changeNote: '搭好了价格页，三档价格和刷新按钮都有',
    items: info.items.map(item => item.atDelivery ? { no: item.no, selfCheck: 'at_delivery' }
      : item.no === 2 ? metWithImage(item.no)
        : { no: item.no, selfCheck: 'met', evidence: [
          { kind: 'file', path: '交付/报价页.html', summary: '页面文件' },
          { kind: 'test', summary: '依次提交 81 条，第 81 条显示名额已满', command: 'pnpm test signup' }] }),
    deliverables: ['交付/报价页.html'], preview: 'http://localhost:5173/', ...patch,
  };
}

/** 评审甲 10 分钟前刚思考过（如果核对的唤醒要看最短思考间隔，就会被挡住）。 */
export function reviewerThoughtRecently(fix: JobFix): void {
  fix.ctx.store.table('bots').patch(fix.reviewer.id, { lastThinkAt: fix.ctx.clock.now() - 10 * MINUTE });
}

/** 派活（第 1 条是交付时核对）、林舟拿到第一个回合，文件已放好。返回执行者唤醒包里取到的值。 */
export async function started(extraEngineers: string[] = [], assignExtra: Record<string, unknown> = {}): Promise<{ fix: JobFix; job: Job; info: PacketInfo }> {
  const fix = await jobFix(extraEngineers);
  const { job } = await runningJob(fix, { deliveryItems: [1], ...assignExtra });
  reviewerThoughtRecently(fix);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  return { fix, job, info };
}

/** 林舟交回（用标准参数），必须成功。返回工具结果。 */
export async function engineerSubmits(fix: JobFix, info: PacketInfo, patch: Record<string, unknown> = {}) {
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, patch));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return result;
}

/** 一份「零写入」快照：交回、核对、事件、主题消息、这件事本身、几位员工的队列。 */
export function writeSnapshot(fix: JobFix, jobId: string) {
  return {
    job: fix.ctx.store.table('jobs').get(jobId),
    submissions: fix.ctx.store.table('jobSubmissions').list().map(row => row.id),
    reviews: fix.ctx.store.table('jobReviews').list().map(row => row.id),
    events: eventsOf(fix.ctx, jobId).map(row => row.id),
    topic: threadOf(fix.ctx, fix.ctx.store.table('jobs').get(jobId)!.topicId).map(row => row.id),
    queues: [fix.chief, fix.engineer, fix.reviewer].map(who => entriesOf(fix, who.id).map(entry => entry.id)),
    percepts: fix.ctx.store.table('percepts').list().map(row => row.id),
  };
}

/** 让这位员工拿到一个回合（越过启动静默等）；返回这一回合的唤醒包。 */
export async function nextPacket(fix: JobFix, botId: string): Promise<string> {
  for (let i = 0; i < 8 && !runningOf(fix, botId); i += 1) await tick(fix, 5 * MINUTE);
  expect(runningOf(fix, botId), '应该已经拿到一个回合').toBeDefined();
  return lastPacket(fix, bot(fix, botId));
}
