/**
 * P74f-2 测试的公共环境（不是测试文件）：在 P74d 的真实 Hub 夹具上，提供「核对三轮仍不过、已受阻」「写明不再做的新版约定在等确认」
 * 两个起点，以及只靠唤醒包文字取值的小工具。为什么走真实链路：说明办法、选办法、停止要经过真实的核对、状态机、巡检和
 * 总管的唤醒包，才能测到接线；时间全部用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, commitAndEnd } from './p74c-fixtures.js';
import { chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import {
  bot, callTool, engineerSubmits, executorInfo, jobFix, lastPacket, nextPacket, putStandardFiles, reviewerInfo, reviewerThoughtRecently,
  sectionOf, started, theJob, tick, MINUTE, type JobFix,
} from './p74d-fixtures.js';

export { bot, callTool, nextPacket, sectionOf, theJob, tick, MINUTE, started, lastPacket, ownerSays, speak };
export type { JobFix };

/** 第 3 条核对人判不符时写的说明和改法（按轮）。 */
const unmet = (round: number) => [{ no: 3, verdict: 'unmet', note: `第${round}轮的问题`, fixTo: `第${round}轮的改法` }];

/**
 * 派活、林舟交回，核对人连续三轮判第 3 条不符：这件事因核对三轮不过而受阻，总管被叫醒写说明。
 * 不给 doneWhen 时用默认的三条；给了就按它建约定（第 1 条交付时核对，第 3 条是卡住的条目，其余符合）。
 */
export async function limitFix(doneWhen?: string[]): Promise<{ fix: JobFix; job: Job }> {
  let fix: JobFix;
  let info: ReturnType<typeof executorInfo>;
  if (doneWhen === undefined) {
    const s = await started(['小周']);
    fix = s.fix; info = s.info;
  } else {
    fix = await jobFix(['小周']);
    await chiefDrafts(fix as never, { title: '会员定价页', doneWhen });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    await tick(fix, 10 * MINUTE);
    reviewerThoughtRecently(fix);
    info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    await putStandardFiles(fix, info);
  }
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
  const rest = (doneWhen ?? []).slice(3).map((_, i) => ({ no: i + 4, verdict: 'met' }));
  const first = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, ...unmet(1), ...rest];
  expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: first })).toMatchObject({ ok: true });
  for (const round of [2, 3]) {
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: seen.jobId, changeNote: `第${round}轮的做法`, deliverables: ['交付/报价页.html'],
      items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/报价页.html', summary: '页面文件' }] }] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: unmet(round) })).toMatchObject({ ok: true });
  }
  const job = theJob(fix);
  expect(job).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit', no: 3 } });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '交回了' }).catch(() => undefined);
  // 核对人这一回合也结束，之后才能再被叫醒（回合还开着时 nextPacket 会直接返回旧的唤醒包）。
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '三轮都没通过' }).catch(() => undefined);
  return { fix, job };
}

/** 总管只用唤醒包里的文字（jobId、卡住的条目序号）调用 escalate；options 由测试给。 */
export async function escalateFromPacket(fix: JobFix, options: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const text = sectionOf(await nextPacket(fix, fix.chief.id));
  const jobId = /写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)?.[1];
  expect(jobId, '包里应该有「写说明」的做法').toBeDefined();
  const no = Number(/第 (\d+) 条核对三轮仍未通过/.exec(text)?.[1]);
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
    mode: 'escalate', jobId, stuckAt: '接口失败时的提示，页面一直做不到让人看得懂', options, suggested: 0, reason: '最小的改动，其余条目不受影响', ...extra });
  // 说明成功之后总管这一回合结束，之后才能被主人选办法的话再叫醒。
  if (result.ok) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已把办法交给主人' });
  return { result, jobId: jobId!, no };
}

/** 这件事开着的三轮不过条目。 */
export function escalateItem(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:escalate:`))[0];
}

/** 派活之后，一份写明不再做（stopsJob）的新版约定在等主人确认；返回约定编号。 */
export async function stopRevise(fix: JobFix): Promise<string> {
  // 林舟这一回合先结束（回合还开着时，主人的话叫醒不了总管）；已经结束的再结束一次会报错，忽略。
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' }).catch(() => undefined);
  await ownerSays(fix, fix.chief.id, '这件事不做了');
  const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', {
    mode: 'revise', agreementId, changeNote: '这件事不再做', scopeOut: ['历史曲线', '这件事不再做，之前的内容都不用继续'],
    stopsJob: true, fallback: '如果还想做，回复「继续」，我撤回这次修改。' });
  expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '这件事不再做，请你确认。', { outcome: 'needs_owner' });
  return agreementId;
}
