/**
 * P75g 测试的公共环境（不是测试文件）：在第三块的真实 Hub 夹具上，提供「派活、交回、核对、返工、验收」的完整链路，
 * 以及只靠唤醒包文字取值的小工具（src 编号、已有技能名）、复盘全程「对主人安静」的快照。
 *
 * 为什么走真实链路：复盘要经过验收、真实的出处记录、真实的调度闸门和唤醒包，才能测到接线；
 * 夹具里的总管和执行类员工都是听吩咐的（与真实创建出来的一致，第一块起总管就是自动建的、听吩咐）。
 * 时间全部用注入的假时钟，每次推进不超过 10 分钟；需要「等了 7 天」这类场景时直接改候选的入队时间，不推进时钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import type { SkillRun } from '../src/model/skill.js';
import { buildSnapshot } from '../src/scheduler/gates.js';
import { postThread } from '../src/outreach/thread.js';
import {
  PASS_ITEMS, bot, callTool, chiefTurn, nextPacket, ownerTypes, reopenInfo, started, theJob, threadOf, tick, MINUTE, type JobFix,
} from './p74f-fixtures.js';
import { engineerSubmits, executorInfo, metWithImage, putStandardFiles, reviewerInfo } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { speak } from './p74b-fixtures.js';

export { bot, callTool, commitAndEnd, nextPacket, theJob, threadOf, tick, MINUTE };
export type { JobFix };

/** 主人看得见的文字里不许出现的内部名称（工具名、出处与记录编号、员工编号）。 */
export const INTERNAL_NAMES = /hub_|\bsrc\d|\bsk_|\bsu_|\bsr_|\bss_|\bb_[0-9a-z]{10}|job_|agr_/;

/** 第 1 轮核对：第 3 条不符（写明问题和改到什么程度算过）。 */
export const FAIL_THIRD = [
  { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动', rechecked: true },
  { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' },
];

/** 一条链路要怎样走。 */
export interface FlowOptions {
  /** 第 1 阶段第 1 轮是否退回第 3 条（核对退回过）。 */
  rejectFirst?: boolean;
  /** 验收时主人指出不符：条目序号、主人那句话、总管记下的问题；不写表示直接验收。 */
  ownerReturn?: { no: number; text: string; problem: string } | null;
  /** 谁核对：评审员（默认）或总管自己。 */
  checker?: 'reviewer' | 'chief';
  /** 再加几位工程师（用于「换执行者」的测试）。 */
  extraEngineers?: string[];
  /** 派活之后、验收之前主人在这件事主题里说的话（直接写线程记录，不叫醒总管）。 */
  topicMessages?: string[];
  /** 是否走到验收（默认是）；为假时停在「等你验收」。 */
  accept?: boolean;
  /** 约定里带「对外发布另行确认」：验收之后执行者还要准备发布（带 jobId 的回合）。 */
  launch?: boolean;
  /** P75r5b：主人指出不符、执行者返工交回之后、核对人再核对之前要做的一步；返回再核对的人的编号（不返回则仍由原核对人核对）。 */
  beforeRecheck?: (fix: JobFix, jobId: string) => Promise<string | void>;
}

export interface Flow { fix: JobFix; job: Job }

/** 核对人提交一轮核对并结束回合，必须成功。 */
async function reviewOnce(fix: JobFix, whoId: string, items: unknown[]): Promise<void> {
  const seen = reviewerInfo(await nextPacket(fix, whoId));
  const result = await callTool(fix, bot(fix, whoId), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, whoId, { outcome: 'progress', summary: '核对完成' });
}

/** 执行者针对某一条重新交回并结束回合，必须成功。 */
async function resubmit(fix: JobFix, jobId: string, no: number): Promise<void> {
  const info = executorInfo(await nextPacket(fix, fix.engineer.id));
  await putStandardFiles(fix, info);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
    mode: 'submit', jobId, changeNote: '按意见改了', deliverables: ['交付/报价页.html'],
    // 第 1 条是「交付时核对」的条目：自查只能写 at_delivery。
    items: [no === 1 ? { no, selfCheck: 'at_delivery' } : metWithImage(no, '证据/桌面.png')],
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
}

/**
 * 走一条完整链路：派活、交回、核对（可退回一次）、可选「主人指出不符」再返工再核对、可选验收。
 * 验收走界面命令 acceptJob（与按钮同一入口），第二段里 afterJobAccepted 自动安排复盘。
 */
export async function flow(options: FlowOptions = {}): Promise<Flow> {
  const checker = options.checker ?? 'reviewer';
  const s = await started(options.extraEngineers ?? [], { ...(checker === 'chief' ? { reviewer: '总管' } : {}), ...(options.launch === true ? { launch: true } : {}) });
  const { fix } = s;
  // 夹具与真实一致：总管、执行者、评审员都是听吩咐的。
  for (const who of [fix.chief, fix.engineer, fix.reviewer]) expect(bot(fix, who.id).onDemand, `${who.name} 应该是听吩咐的`).toBe(true);
  const whoId = checker === 'chief' ? fix.chief.id : fix.reviewer.id;
  await engineerSubmitsFirst(fix, s.info);
  await reviewOnce(fix, whoId, options.rejectFirst === true ? FAIL_THIRD : PASS_ITEMS);
  if (options.rejectFirst === true) {
    await resubmit(fix, s.job.id, 3);
    await reviewOnce(fix, whoId, [{ no: 3, verdict: 'met' }]);
  }
  expect(theJob(fix).state).toBe('awaiting_owner');
  const back = options.ownerReturn ?? null;
  if (back !== null) {
    await ownerTypes(fix, theJob(fix).topicId, back.text);
    const seen = reopenInfo(await chiefTurn(fix));
    const reopened = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: back.no, problem: back.problem, fixTo: '按你说的改好' }], missed: '核对时没有试到这一条，这次要试' });
    expect(reopened, JSON.stringify(reopened)).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已退回返工，预计今天内再交给你。', { outcome: 'progress' });
    await resubmit(fix, s.job.id, back.no);
    // P75r5b：返工之后、再次核对之前，测试可以插一步（例如总管把核对人换成另一位），返回此后核对的人。
    const recheckBy = options.beforeRecheck !== undefined ? await options.beforeRecheck(fix, s.job.id) ?? whoId : whoId;
    await reviewOnce(fix, recheckBy, [{ no: back.no, verdict: back.no === 1 ? 'at_delivery' : 'met' }]);
    expect(theJob(fix).state).toBe('awaiting_owner');
  }
  for (const text of options.topicMessages ?? []) postThread(fix.ctx, { thread: theJob(fix).topicId, from: 'owner', kind: 'chat', text });
  if (options.accept !== false) {
    const job = theJob(fix);
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
  }
  return { fix, job: theJob(fix) };
}

/** 执行者第一次交回（标准参数）并结束回合。 */
async function engineerSubmitsFirst(fix: JobFix, info: ReturnType<typeof executorInfo>): Promise<void> {
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
}

// ---------------------------------------------------------------------------
// 记录与唤醒包的读取
// ---------------------------------------------------------------------------

/** 这件事的复盘记录（没有时为 null）。 */
export function retroRun(fix: JobFix, jobId?: string): SkillRun | null {
  return fix.ctx.store.table('skillRuns').list(row => row.kind === 'retro' && (jobId === undefined || row.jobId === jobId))[0] ?? null;
}

/** 复盘记录里某位员工的那一项。 */
export function participantOf(run: SkillRun, botId: string) {
  return run.participants.find(row => row.botId === botId);
}

/** 这位员工在队列里的技能类候选的事项键。 */
export function skillKeysQueued(fix: JobFix, botId: string): string[] {
  return fix.ctx.store.table('queue').list(row => row.botId === botId && /^(retro|skillcheck|tidy):/.test(row.subjectKey)).map(row => row.subjectKey);
}

/** 取出唤醒包里的「本轮复盘」段正文（到下一个二级标题或结尾）。 */
export function retroSectionOf(packet: string): string {
  const start = packet.indexOf('## 本轮复盘：');
  expect(start, '唤醒包里应该有「本轮复盘」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start);
  const next = rest.slice(4).search(/\n\n## /);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** 只靠正则从唤醒包文字里取出的出处：编号、种类、标签、原文。 */
export function srcsIn(packet: string): Array<{ src: string; kind: string; label: string; quote: string }> {
  // P75r5b：出处原文放进不可信围栏（「src1 种类｜标签：」下面一个围栏），正则相应改成取围栏里的原文；返回的形状不变。
  return [...retroSectionOf(packet).matchAll(/^(src\d+) (\S+)｜(.+?)：\n<<<untrusted\n([\s\S]*?)\nuntrusted>>>$/gm)]
    .map(match => ({ src: match[1]!, kind: match[2]!, label: match[3]!, quote: match[4]! }));
}

/**
 * 只靠正则从唤醒包文字里取出的「你现在的技能」的名称。
 * P75r6 同步：技能名称是模型写的，放进围栏（围栏外只有编号 sk1），所以改成取围栏第一行「名称：…」；返回的形状（名称列表）不变。
 */
export function skillNamesIn(packet: string): string[] {
  return [...retroSectionOf(packet).matchAll(/^- sk\d+（第 \d+ 版）：\n<<<untrusted\n名称：(.+)$/gm)].map(match => match[1]!);
}

/** P75r6：只靠正则从唤醒包文字里取出「你现在的技能」的编号（围栏外的 sk1 这样的写法），与 skillNamesIn 同序。 */
export function skillRefsIn(packet: string): string[] {
  return [...retroSectionOf(packet).matchAll(/^- (sk\d+)（第 \d+ 版）：\n<<<untrusted\n名称：/gm)].map(match => match[1]!);
}

/** 这位员工拿到下一个回合，返回唤醒包里的「本轮复盘」段，并附上整个包。 */
export async function retroTurn(fix: JobFix, botId: string): Promise<{ packet: string; section: string }> {
  const packet = await nextPacket(fix, botId);
  return { packet, section: retroSectionOf(packet) };
}

// ---------------------------------------------------------------------------
// 复盘全程对主人安静
// ---------------------------------------------------------------------------

/** 主人被打扰的几个量：「待你处理」开着的条数、单推次数、所有私聊消息数（总管和每位员工的线程，加团队线程）。 */
export function ownerNoise(fix: JobFix) {
  const chats = fix.ctx.store.log('thread').all().filter(row => row.thread === 'team' || fix.ctx.store.table('bots').get(row.thread) !== null);
  return {
    openInbox: fix.ctx.store.table('inbox').list(row => row.status === 'open').length,
    allInbox: fix.ctx.store.table('inbox').count(),
    pushes: fix.ctx.host.calls.filter(call => call.method === 'notify').length,
    privateMessages: chats.length,
  };
}

/** 这位员工的候选放行判断用的快照（带事项键，与调度选候选时一致）。 */
export function snapshotOf(fix: JobFix, botId: string, key: string) {
  return buildSnapshot(fix.ctx, botId, fix.ctx.clock.now(), undefined, key);
}

/** 额度灯此刻是不是绿灯（依赖额度灯的测试先断言前提，不靠它碰巧放行或碰巧拦下）。 */
export function lightOf(fix: JobFix, botId: string): string {
  return buildSnapshot(fix.ctx, botId, fix.ctx.clock.now()).quota.light;
}
