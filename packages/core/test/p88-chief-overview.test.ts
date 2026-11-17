/**
 * P88 的测试：总管提到别的事的状态时以唤醒包为准（遗留 I100）。
 * 覆盖：
 * 1 一览的三种样子：没有在办也没有收尾的事 / 没有在办、有最近收尾的事（含跨日时区）/ 有在办也有收尾的事；
 * 2 收尾的范围：超过 7 天不列、最多 3 件按收尾时间从近到远、别的总管名下的不列；
 * 3 带 jobId 的总管唤醒包：只写这一件事，段末有固定的一句；
 * 4 总管守则第 15 条逐字；
 * 5 压缩：放不下时最近收尾的事先被删，「现在没有在办的事。」和固定那一句任何时候都在。
 * 全部走真实的 Hub 夹具；时间用注入的假时钟，收尾的事直接写进存储（只改状态和收尾时间）。
 */
import { describe, expect, it } from 'vitest';
import type { QueueEntry, WakeTicket } from '../src/model/wake.js';
import type { Job } from '../src/model/job.js';
import { newId } from '../src/util/ids.js';
import { byteLength } from '../src/util/text.js';
import { localParts } from '../src/util/time.js';
import { CHIEF_RULES_TEXT } from '../src/wake/chief-packet.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import { CHAIN_ONLY_THIS_LINE, OVERVIEW_NONE_LINE, OVERVIEW_RULE_LINE, chiefOverviewBody } from '../src/wake/job-section-chief.js';
import { bot, jobFix, runningJob, type JobFix } from './p74c-fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const RULE = '提到一件已经派出的事的状态时，只按这一段列出的写；这一段没有列出的事，不要说它正在进行或正在返工。约定的状态见「你手上的约定」。';
const NONE = '现在没有已经派出、还没有收尾的事。';

/** 以一件在办的事为底，写入一件已收尾的事（只改状态和收尾时间；可指定别的总管）。 */
function closedCopy(fix: JobFix, base: Job, state: 'done' | 'stopped', at: number, chiefId = base.chiefId): void {
  fix.ctx.store.table('jobs').put({
    ...base, id: newId('job', fix.ctx.rng), chiefId, state, blocked: null,
    acceptedAt: state === 'done' ? at : null, stoppedAt: state === 'stopped' ? at : null, updatedAt: at,
  });
}

/** 把在办的那件事也改成已收尾，让总管名下没有在办的事。 */
function closeBase(fix: JobFix, base: Job, at: number): void {
  fix.ctx.store.table('jobs').put({ ...base, state: 'done', blocked: null, acceptedAt: at, updatedAt: at });
}

/** UTC 的某一天（距现在 daysAgo 天）20:00 的时刻：换算到东八区是第二天凌晨，用来检验日期按时区算。 */
function utc2000(fix: JobFix, daysAgo: number): { at: number; utcDay: string; shanghaiDay: string } {
  const day = new Date(fix.ctx.clock.now() - daysAgo * DAY);
  const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 20, 0, 0);
  const shanghai = new Date(at + 8 * 60 * 60 * 1000);
  return { at, utcDay: `${day.getUTCMonth() + 1}月${day.getUTCDate()}日`, shanghaiDay: `${shanghai.getUTCMonth() + 1}月${shanghai.getUTCDate()}日` };
}

describe('1 一览的三种样子', () => {
  it('没有在办的事、没有最近收尾的事：两行固定的话', async () => {
    const fix = await jobFix();
    expect(chiefOverviewBody(fix.ctx, fix.chief.id)).toBe(`${NONE}\n${RULE}`);
    expect(OVERVIEW_NONE_LINE).toBe(NONE);
    expect(OVERVIEW_RULE_LINE).toBe(RULE);
  });

  it('没有在办的事、有一件 2 天前验收的事：多一段最近收尾的事；日期按设置里的时区（跨日用例）', async () => {
    for (const [timezone, pick] of [['UTC', 'utcDay'], ['Asia/Shanghai', 'shanghaiDay']] as const) {
      const fix = await jobFix([], { timezone });
      const { job } = await runningJob(fix);
      const day = utc2000(fix, 2);
      closeBase(fix, job, day.at);
      expect(chiefOverviewBody(fix.ctx, fix.chief.id), timezone).toBe(`${NONE}\n最近收尾的事：\n「会员定价页」已验收完成（${day[pick]}）\n${RULE}`);
    }
    // 两个时区的日期确实不同（用例有效）。
    const sample = utc2000(await jobFix(), 2);
    expect(sample.utcDay).not.toBe(sample.shanghaiDay);
  });

  it('有在办的事、同时有已停止的事：在办的事写法不变，之后是最近收尾的事，最后是固定的一句', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const day = utc2000(fix, 1);
    const before = chiefOverviewBody(fix.ctx, fix.chief.id);
    closedCopy(fix, job, 'stopped', day.at);
    const after = chiefOverviewBody(fix.ctx, fix.chief.id);
    const shown = localParts(day.at, fix.ctx.settings.timezone);
    // 改动前（没有收尾的事）：在办的事原样，加固定的一句。
    expect(before.endsWith(`\n${RULE}`)).toBe(true);
    const active = before.slice(0, before.length - RULE.length - 1);
    expect(active.startsWith(`「会员定价页」（jobId 为 ${job.id}）执行中，在等林舟\n  消耗：`)).toBe(true);
    expect(after).toBe(`${active}\n最近收尾的事：\n「会员定价页」已停止（${shown.month}月${shown.day}日）\n${RULE}`);
  });
});

describe('2 收尾的范围', () => {
  it('超过 7 天的不列；超过 3 件只列最近 3 件，按收尾时间从近到远；别的总管名下的不列', async () => {
    const fix = await jobFix([], { timezone: 'UTC' });
    const { job } = await runningJob(fix);
    const now = fix.ctx.clock.now();
    // 离现在 1、3、5、6 天的四件（只留最近 3 件），8 天前的一件（过期），别的总管名下半天前的一件。
    closedCopy(fix, job, 'done', now - 5 * DAY);
    closedCopy(fix, job, 'stopped', now - 1 * DAY);
    closedCopy(fix, job, 'done', now - 6 * DAY);
    closedCopy(fix, job, 'done', now - 3 * DAY);
    closedCopy(fix, job, 'done', now - 8 * DAY);
    closedCopy(fix, job, 'done', now - DAY / 2, fix.reviewer.id);
    const text = chiefOverviewBody(fix.ctx, fix.chief.id);
    const dayOf = (ago: number): string => {
      const d = new Date(now - ago * DAY);
      return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
    };
    const tail = text.slice(text.indexOf('最近收尾的事：'));
    expect(tail).toBe(`最近收尾的事：\n「会员定价页」已停止（${dayOf(1)}）\n「会员定价页」已验收完成（${dayOf(3)}）\n「会员定价页」已验收完成（${dayOf(5)}）\n${RULE}`);
  });
});

describe('3 带 jobId 的总管唤醒包', () => {
  it('只写这一件事（不列别的事）：段末有固定的一句；别的事已收尾也不出现', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    closedCopy(fix, job, 'done', fix.ctx.clock.now() - DAY);
    const entry = { jobId: job.id, reason: { evidence: [] } } as unknown as QueueEntry;
    const body = await buildJobBodyDetailed(fix.ctx, bot(fix, fix.chief.id), entry, { jobId: job.id } as unknown as WakeTicket);
    expect(body.text.split('\n').pop()).toBe('这里只写了这一件事；提到别的事的状态时，不要凭记忆说它正在进行或正在返工。');
    expect(CHAIN_ONLY_THIS_LINE).toBe(body.text.split('\n').pop());
    expect(body.text.split('（jobId 为 ').length - 1).toBe(1);
    // 压缩到最紧的一级仍在。
    const tight = await buildJobBodyDetailed(fix.ctx, bot(fix, fix.chief.id), entry, { jobId: job.id } as unknown as WakeTicket, 700);
    expect(tight.text.endsWith(CHAIN_ONLY_THIS_LINE)).toBe(true);
  });
});

describe('4 总管守则第 15 条', () => {
  it('逐字在守则里，接在第 14 条之后', () => {
    expect(CHIEF_RULES_TEXT).toContain('15. 回复里提到某件事现在的状态（在做、在返工、在等谁、已验收、已停止）时，以这一回合唤醒包「你手上的事」里写的为准；那里没有写的事，不说它正在进行或正在返工。对话里较早的消息只说明当时的情况，不代表现在。');
    expect(CHIEF_RULES_TEXT.indexOf('14. 交付物一律派给队友')).toBeLessThan(CHIEF_RULES_TEXT.indexOf('15. 回复里提到'));
  });
});

describe('5 压缩', () => {
  it('放不下时先整块删掉最近收尾的事；两行固定的话任何时候都在', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    closeBase(fix, job, fix.ctx.clock.now() - DAY);
    closedCopy(fix, job, 'stopped', fix.ctx.clock.now() - 2 * DAY);
    const full = chiefOverviewBody(fix.ctx, fix.chief.id);
    expect(full).toContain('最近收尾的事：');
    // 上限正好放得下不带最近收尾的事的写法：收尾的事被删，两行固定的话保留。
    const minimal = `${OVERVIEW_NONE_LINE}\n${RULE}`;
    const limit = byteLength(minimal);
    expect(chiefOverviewBody(fix.ctx, fix.chief.id, limit)).toBe(minimal);
    // 比完整写法只小 1 字节：收尾的事同样被删，其余原样。
    const justUnder = chiefOverviewBody(fix.ctx, fix.chief.id, byteLength(full) - 1);
    expect(justUnder).not.toContain('最近收尾的事');
    expect(justUnder.startsWith(OVERVIEW_NONE_LINE)).toBe(true);
    expect(justUnder.endsWith(RULE)).toBe(true);
    // 经 buildJobBodyDetailed：没有压缩时级别为 0，删过时为 1。
    const entry = { reason: { evidence: [] } } as unknown as QueueEntry;
    const ticket = {} as unknown as WakeTicket;
    expect((await buildJobBodyDetailed(fix.ctx, bot(fix, fix.chief.id), entry, ticket)).level).toBe(0);
    const squeezed = await buildJobBodyDetailed(fix.ctx, bot(fix, fix.chief.id), entry, ticket, limit);
    expect(squeezed.level).toBe(1);
    expect(squeezed.text).toBe(minimal);
  });

  it('在办的事太长时只截短在办的部分，固定的一句留在末尾', async () => {
    const fix = await jobFix();
    await runningJob(fix);
    const full = chiefOverviewBody(fix.ctx, fix.chief.id);
    const limit = byteLength(RULE) + 40;
    const cut = chiefOverviewBody(fix.ctx, fix.chief.id, limit);
    expect(byteLength(full)).toBeGreaterThan(limit);
    expect(cut.endsWith(`\n${RULE}`)).toBe(true);
    expect(byteLength(cut)).toBeLessThanOrEqual(limit + 1);
  });
});
