/**
 * P76m（看板遗留 I95，第五块审查 R13、R16）：会误交付时间的提示的两处小问题。
 *
 * R13：交付时间已经过去的事不能再写「可能晚于交付时间」。每件一句写事实句「已过约定的 …」；
 *      清单里每一件都已过交付时间时，推送标题写「已过交付时间」；只要有一件还没到交付时间，标题仍写「可能晚于」。
 * R16：记号（jobNotices.dueRiskNotifiedAt）按额度窗口清：同一个窗口里灯由红转不红再转红时不清、不重复落私聊；
 *      窗口起点前进（窗口滚动）之后才清空，之后才能再提示。与方案 7.8「窗口滚动后清空」一致。
 *
 * 夹具同 p76h-due-risk.test.ts：总管与执行员工由 jobFix 自动创建；额度红灯直接写额度记录与额度单例。
 * 每个用例的注释写明当时是否在免打扰时段（默认 23:00 至 08:00）与推送渠道（fixture 默认设置，渠道打开）。
 * 假时钟：每次推进不超过 10 分钟，跨窗口的用例直接设到目标时刻。
 */
import { describe, expect, it } from 'vitest';
import { checkDueRisk } from '../src/job/due-risk.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';
import { DUE_RISK_REF_PREFIX } from '../src/quota/owner-phrases.js';
import { MINUTE, assigned, jobFix, type JobFix } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';

const HOUR = 60 * MINUTE;
const at = (text: string) => Date.parse(`${text}+08:00`);

/** 宿主收到的、标题里带「交付时间」的通知（与派活时的约定确认等通知区分开）。 */
const notices = (fix: JobFix) => fix.ctx.host.calls.filter(call => call.method === 'notify')
  .map(call => call.args[0] as { title: string; body: string; level: string }).filter(item => item.title.includes('交付时间'));
/** 总管私聊里「会误交付时间」的提示消息（refId 以 duerisk: 开头）。 */
const hints = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.refId?.startsWith(DUE_RISK_REF_PREFIX));
/** 这件事的「已提示」记号。 */
const notified = (fix: JobFix, jobId: string) => fix.ctx.store.table('jobNotices').get(jobId)?.dueRiskNotifiedAt ?? null;
/** 推送队列里「会误交付时间」的行（看它有没有真的发出）。 */
const dueRows = (fix: JobFix) => fix.ctx.store.table('pushQueue').list(row => row.subjectKey.startsWith('duerisk:'));
/** 当前额度窗口的起点（用来把第二次红灯放回同一个窗口）。 */
const windowStart = (fix: JobFix) => fix.ctx.store.table('quota').get('quota')!.windowStartAt;

/**
 * 额度红灯：员工份额用完（kind staff_full）或真实额度用完（exhausted）。
 * windowStartAt 省略时取「现在一小时前」，与 p76h 的写法一致；要模拟同一个窗口时显式传入。
 */
function red(fix: JobFix, kind: 'staff_full' | 'exhausted', resetAt: number, windowStartAt?: number): void {
  const now = fix.ctx.clock.now();
  const started = windowStartAt ?? now - HOUR;
  fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt: started, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
    light: 'red', redUntil: resetAt, probeAllowed: false, lastError: null, lastErrorAt: null });
  fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, started), capacityTokens: 1_000_000, staffTokens: 700_000,
    ...(kind === 'exhausted' ? { exhausted: { at: now, resetAt, resetFromText: true } } : {}) });
}
/** 灯回到绿色（红灯结束，仍在同一个窗口里）。 */
function green(fix: JobFix): void {
  fix.ctx.store.table('quota').patch('quota', { light: 'green', redUntil: null });
}

/** 现在 17:50（不在免打扰时段），派出一件事（旧数据口径：没有预计），交付时间由 options 给。 */
async function scene(options: { remaining?: number; dueAt?: number } = {}) {
  const fix = await jobFix();
  const { job: created } = await assigned(fix);
  fix.ctx.clock.set(at('2026-11-13T17:50:00'));
  fix.ctx.store.table('jobEstimates').remove(created.agreementId);
  const job = fix.ctx.store.table('jobs').patch(created.id, {
    dueAt: options.dueAt ?? at('2026-11-13T18:00:00'), turnCap: created.turnsUsed + (options.remaining ?? 2),
  });
  const title = fix.ctx.store.table('agreements').get(job.agreementId)!.title;
  return { fix, job, title };
}
/** 同一个总管再加一件事（复制一份，新编号，标题不同，同样没有预计）。 */
function addSecondJob(fix: JobFix, job: { id: string; agreementId: string }, dueAt: number, remaining: number) {
  const agreements = fix.ctx.store.table('agreements');
  agreements.put({ ...agreements.get(job.agreementId)!, id: 'agr_0000000099', title: '另一件事' });
  const base = fix.ctx.store.table('jobs').get(job.id)!;
  fix.ctx.store.table('jobs').put({ ...base, id: 'job_0000000099', agreementId: 'agr_0000000099', assignedAt: base.assignedAt + 1, dueAt, turnsUsed: 0, turnCap: remaining });
  return 'job_0000000099';
}

describe('R13 已经过了交付时间写事实句', () => {
  it('正例：17:50 时交付时间 17:40 已过：逐字写「已过约定的 17:40」，标题写「已过交付时间」', async () => {
    const { fix, job, title } = await scene({ dueAt: at('2026-11-13T17:40:00') });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    const expected = ['员工本窗口的额度已用完，18:20 恢复。',
      `${title}还差约 2 回合，按这个时间做完约在 18:30，已过约定的 17:40。`,
      '你可以让我把交付时间改到 19:00 之后；也可以回复「用我的额度」，员工现在用你留出的部分接着做。'].join('\n\n');
    expect(hints(fix)).toHaveLength(1);
    expect(hints(fix)[0]!.text).toBe(expected);
    expect(notices(fix)).toHaveLength(1);
    expect(notices(fix)[0]).toMatchObject({ title: `${title}：已过交付时间`, body: expected, level: 'P1' });
    expect(notified(fix, job.id)).toBe(fix.ctx.clock.now());
  });

  it('反例：交付时间 18:00 还没到：仍写「晚于约定的 18:00」，标题仍写「可能晚于交付时间」', async () => {
    const { fix, title } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)[0]!.text).toContain(`${title}还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 18:00。`);
    expect(hints(fix)[0]!.text).not.toContain('已过约定的');
    expect(notices(fix)[0]!.title).toBe(`${title}可能晚于交付时间`);
  });

  it('边界：交付时间正好等于现在（17:50）不算「已过」：仍写「晚于约定的 17:50」，标题不变', async () => {
    const { fix, title } = await scene({ dueAt: at('2026-11-13T17:50:00') });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)[0]!.text).toContain(`${title}还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 17:50。`);
    expect(notices(fix)[0]!.title).toBe(`${title}可能晚于交付时间`);
  });

  it('两件事都已过交付时间：标题写「2 件事已过交付时间」，两段都写「已过约定的」', async () => {
    const { fix, job, title } = await scene({ dueAt: at('2026-11-13T17:40:00') });
    // 第二件：余下 6 回合，做完 18:50，交付 17:45（也已过）。
    addSecondJob(fix, job, at('2026-11-13T17:45:00'), 6);
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    const segments = hints(fix)[0]!.text.split('\n\n');
    expect(segments[1]).toBe(`${title}还差约 2 回合，按这个时间做完约在 18:30，已过约定的 17:40。`);
    expect(segments[2]).toBe('另一件事还差约 6 回合，按这个时间做完约在 18:50，已过约定的 17:45。');
    expect(notices(fix)[0]!.title).toBe('2 件事已过交付时间');
  });

  it('一件已过、一件只是会晚：标题仍是「2 件事可能晚于交付时间」，两段各按各的事实写', async () => {
    const { fix, job, title } = await scene({ dueAt: at('2026-11-13T17:40:00') });
    addSecondJob(fix, job, at('2026-11-13T18:40:00'), 6);
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    const segments = hints(fix)[0]!.text.split('\n\n');
    expect(segments[1]).toContain('已过约定的 17:40。');
    expect(segments[2]).toContain('晚于约定的 18:40。');
    expect(notices(fix)[0]!.title).toBe('2 件事可能晚于交付时间');
  });
});

describe('R16 记号按额度窗口清', () => {
  it('同一个窗口里灯红、恢复、再红：只落一条私聊、只推一次、记号一直在', async () => {
    const { fix, job } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    const started = windowStart(fix);
    // 灯回到绿色（仍在这个窗口里）：不清记号，再检查不重复。
    fix.ctx.clock.advance(5 * MINUTE);
    green(fix);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBe(at('2026-11-13T17:50:00'));
    expect(hints(fix)).toHaveLength(1);
    // 同一个窗口里又红：仍不重复落私聊、也不再推。
    red(fix, 'staff_full', at('2026-11-13T18:20:00'), started);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(notices(fix)).toHaveLength(1);
    expect(notified(fix, job.id)).toBe(at('2026-11-13T17:50:00'));
  });

  it('正例：窗口起点前进（窗口滚动）后清空记号，再红可以再提示', async () => {
    const { fix, job } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    // 窗口滚动：起点比记号晚；灯这时不红，检查只清记号。
    fix.ctx.clock.advance(5 * MINUTE);
    const started = at('2026-11-13T17:51:00');
    fix.ctx.store.table('quota').patch('quota', { windowStartAt: started, light: 'green', redUntil: null });
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBeNull();
    // 新窗口里又红：可以再提示一次（17:55 时交付 18:00 还没到，标题仍写「可能晚于」）。
    // 推送这时还在 10 分钟合并窗口里，先排队；这不是重复，下一次整理会发。
    red(fix, 'staff_full', at('2026-11-13T18:40:00'), started);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(2);
    expect(dueRows(fix).map(row => row.state)).toEqual(['sent', 'waiting']);
    expect(notified(fix, job.id)).toBe(at('2026-11-13T17:55:00'));
  });

  it('边界：记号正好等于窗口起点（就是本窗口的提示）不清', async () => {
    const { fix, job } = await scene();
    const started = at('2026-11-13T17:50:00');
    red(fix, 'staff_full', at('2026-11-13T18:20:00'), started);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBe(started);
    // 灯不红，再检查：记号不小于窗口起点，保留。
    green(fix);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBe(started);
  });
});
