/**
 * P76g 测试的公共小工具（不是测试文件）：推进假时钟的几种写法，都遵守「每步不超过 10 分钟」。
 *
 * 为什么每步不超过 10 分钟：停滞判断（2 小时、1 小时、24 小时）靠巡检一步一步看过去；一步跳得太大，
 * 会让「中途出现的记录」「回合结束」之类的条件被跳过，测不到真实运行时每个 tick 都在判断的样子。
 * 这里把 2 小时、24 小时都写成循环，每一步都巡检（或整个 tick）一次。
 */
import { expect } from 'vitest';
import { sweepJobs } from '../src/job/sweep.js';
import { MINUTE, bot, entriesOf, lastPacket, runningOf, started, threadOf, tick, type JobFix } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';

export const STEP = 10 * MINUTE;

/** 巡检一次（不改时钟，不跑调度）。 */
export function sweepNow(fix: JobFix): void {
  sweepJobs(fix.ctx, fix.ctx.clock.now());
}

/** 推进 total 毫秒，每步不超过 10 分钟，每一步巡检一次（只巡检，不跑调度：排上的候选留在队列里）。 */
export function advanceSweeping(fix: JobFix, total: number): void {
  let left = total;
  while (left > 0) {
    const step = Math.min(STEP, left);
    fix.ctx.clock.advance(step);
    sweepNow(fix);
    left -= step;
  }
}

/** 推进 total 毫秒，每步不超过 10 分钟，每一步跑一个完整的 tick（巡检加调度加通知整理）。 */
export async function advanceTicking(fix: JobFix, total: number): Promise<void> {
  let left = total;
  while (left > 0) {
    const step = Math.min(STEP, left);
    await tick(fix, step);
    left -= step;
  }
}

/**
 * 每步 1 分钟、整个 tick，直到这位员工拿到一个回合（最多 maxMinutes 分钟）；返回这一回合的唤醒包。
 * 用在「等重新唤醒的回合」：重新唤醒要等 2 小时，所以 maxMinutes 要给够。
 * 为什么每步只有 1 分钟：候选放行之后要在下一个 tick 才送达员工；一步跳 10 分钟会让「投递中」的回合被当成孤儿投递（超过 2 分钟没有送达）而作废重试，
 * 员工拿到的就不是这一次的回合了。
 */
export async function waitForPacket(fix: JobFix, botId: string, maxMinutes: number): Promise<string> {
  for (let spent = 0; spent < maxMinutes && !runningOf(fix, botId); spent += 1) await tick(fix, MINUTE);
  expect(runningOf(fix, botId), `${maxMinutes} 分钟内应该拿到一个回合`).toBeDefined();
  return lastPacket(fix, bot(fix, botId));
}

/**
 * 推进 total 毫秒，每步 10 分钟、每步巡检一次，每步之后把这位员工（默认执行者林舟）排着的候选拿掉
 * （模拟接力断了、被叫醒的回合没有留下任何记录）。只巡检不跑调度，所以候选不会变成真的回合。
 */
export function holdSilent(fix: JobFix, total: number, jobId: string, botId: string = fix.engineer.id): void {
  for (let left = total; left > 0; left -= STEP) {
    advanceSweeping(fix, Math.min(STEP, left));
    dropQueue(fix, botId, jobId);
  }
}

/** 把这位员工在这件事上排着的候选全部拿掉（模拟接力断了、唤醒丢了）。 */
export function dropQueue(fix: JobFix, botId: string, jobId: string): void {
  for (const entry of entriesOf(fix, botId, jobId)) fix.ctx.store.table('queue').remove(entry.id);
}

/** 这件事全部的「没有进展」条目（任何状态），按建立顺序。 */
export function stallItems(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${jobId}:stall:`)).sort((a, b) => a.createdAt - b.createdAt);
}

/** 这件事的提醒记号（没有记录为 null）。 */
export function noticeRow(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('jobNotices').get(jobId);
}

/** 总管私聊里总管自己说的话（文字，按先后）。 */
export function chiefSays(fix: JobFix): string[] {
  return threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id).map(row => row.text);
}

/** 主人的推送通知（宿主真正收到的）：每次调用宿主通知的标题，按先后。 */
export function pushedTitles(fix: JobFix): string[] {
  return fix.ctx.host.calls.filter(call => call.method === 'notify').map(call => (call.args[0] as { title: string }).title);
}

/**
 * 接力断了的起点：林舟拿到第一个回合并交账 progress（不交回），中心续排的候选被拿掉，他没有排队、没有在跑。
 * 额度灯为绿，预算线未用完。返回起点（这件事、林舟唤醒包里取到的值）。
 */
export async function brokenRelay() {
  const s = await started();
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '先做着' });
  dropQueue(s.fix, s.fix.engineer.id, s.job.id);
  return s;
}

export { MINUTE };
