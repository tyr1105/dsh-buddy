/**
 * P74r2b 测试的公共环境（不是测试文件）：沿用 P74d、P74e 的真实 Hub 夹具（总管听吩咐、安静节奏，与真实一致），
 * 提供三类小工具：
 * 一、「林舟提问，总管拿到执行链回合」：只从唤醒包文字里正则取出事的编号和约定编号；
 * 二、「执行中改约定等主人确认」：主人在私聊发来冲突的话，总管 revise，卡片落楼（与 p74e-b2 同一做法，那边的辅助函数没有导出）；
 * 三、数回合、数叫醒的小函数。
 * 时间全部用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import { lastPacket } from './p63-topic-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import {
  bot, callTool, engineerSubmits, entriesOf, executorInfo, nextPacket, sectionOf, started, MINUTE, type JobFix,
} from './p74d-fixtures.js';
import { commitAndEnd, runningOf, tick, wakesOf } from './p74c-fixtures.js';

export { MINUTE, bot, callTool, commitAndEnd, entriesOf, nextPacket, runningOf, sectionOf, speak, started, tick, wakesOf, ownerSays, lastPacket, agreementIdIn };
export type { JobFix };

/** 新版本只改「这次做」，多一条（其余不动）；continuing、paused 照 P74e 的写法。 */
export function reviseArgs(agreementId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'revise', agreementId, changeNote: '加暗色模式',
    scopeIn: ['报价列表页', '手动刷新', '支持暗色模式'],
    continuing: ['报价列表页'], paused: ['暗色模式'], fallback: '如果主人不要暗色模式，保留第 1 版。', ...extra,
  };
}

/** 从总管唤醒包里只用正则取出这件事的编号和约定编号。 */
export function idsIn(packet: string): { jobId: string; agreementId: string } {
  const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(sectionOf(packet))?.[1];
  expect(jobId, '总管的唤醒包里应该有这件事的编号').toBeDefined();
  return { jobId: jobId!, agreementId: agreementIdIn(packet) };
}

/**
 * 林舟问了一个约定里推不出答案的问题，总管拿到执行链回合（回合开着，还没交账）。
 * 返回夹具、这件事、总管这一回合的唤醒包，以及只从包里取到的编号。
 */
export async function askedChiefTurn(question = '要不要做暗色模式？约定没写') {
  const s = await started();
  const asked = await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: s.job.id, text: question });
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
  const packet = await nextPacket(s.fix, s.fix.chief.id);
  return { ...s, packet, ...idsIn(packet) };
}

/** 数林舟在这件事上的回合数加排着的候选数（候选一放行就变成回合，所以合计才稳定）。 */
export function touches(fix: JobFix, jobId: string): number {
  return entriesOf(fix, fix.engineer.id, jobId).length + wakesOf(fix, fix.engineer.id, jobId).length;
}

/** 总管到目前为止的回合数。 */
export function chiefWakes(fix: JobFix): number {
  return wakesOf(fix, fix.chief.id).length;
}

/** 林舟为这件事记下的、摘要包含这句话的感知条数（中心叫醒他之前一定先记一条这样的感知）。 */
export function wokenFor(fix: JobFix, summary: string): number {
  return fix.ctx.store.table('percepts').count(row => row.botId === fix.engineer.id && row.summary.includes(summary));
}

/**
 * 执行中改约定，等主人确认（p74e-b2 的前半）：林舟结束当前回合，主人在私聊发来冲突的话，总管 revise 成功并交账，
 * 卡片落在私聊，「待你处理」里有一条。extra 覆盖 revise 的参数（例如改「怎样算做完」）。
 */
export async function pendingReopen(extra: Record<string, unknown> = {}) {
  const s = await started();
  const { fix } = s;
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  await ownerSays(fix, fix.chief.id, '文案里要求暗色模式，和约定不一样');
  const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '这和已定的第 1 版冲突。其余照常在做。', { outcome: 'needs_owner' });
  return { ...s, ...ids };
}

/** 林舟拿到一个回合并交回（用他唤醒包里的条目），必须成功。 */
export async function engineerDelivers(fix: JobFix): Promise<void> {
  const packet = await nextPacket(fix, fix.engineer.id);
  await engineerSubmits(fix, executorInfo(packet));
}
