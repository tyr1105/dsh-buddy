/**
 * P76h 第二段（任务卡第 6 节第 10、11 条）：额度红灯期间，会误了交付时间的事以总管名义提示一次并推送。
 *
 * 夹具与真实情况一致：真实的中心（Hub），总管是自动创建的那一位（听吩咐、安静节奏、节奏最慢），执行员工听吩咐；
 * 额度红灯用额度记录与额度单例直接设成「员工份额用完」或「真实额度用完」（写法同 p76d-owner-phrases）。
 * 每组用例在注释里写明：当时是否在免打扰时段（默认 23:00 至 08:00）、推送渠道（fixture 默认设置，渠道打开）。
 * 假时钟：除了跨窗口的用例直接设到目标时刻，每次推进都不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { checkDueRisk, ceilToHour } from '../src/job/due-risk.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { getQuotaPlan, defaultQuotaPlan } from '../src/quota/plan.js';
import { DUE_RISK_REF_PREFIX } from '../src/quota/owner-phrases.js';
import { MINUTE, assigned, jobFix, type JobFix } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';

const HOUR = 60 * MINUTE;
const at = (text: string) => Date.parse(`${text}+08:00`);

/** 宿主收到的「会误交付时间」通知（夹具里派活时的约定确认等通知不算，所以按标题筛）。 */
const notices = (fix: JobFix) => fix.ctx.host.calls.filter(call => call.method === 'notify').map(call => call.args[0] as { title: string; body: string; level: string })
  .filter(item => item.title.includes('晚于交付时间'));
/** 推送队列里「会误交付时间」的行。 */
const dueRows = (fix: JobFix) => fix.ctx.store.table('pushQueue').list(row => row.subjectKey.startsWith('duerisk:'));
/** 总管私聊里「会误交付时间」的提示消息（refId 以 duerisk: 开头）。 */
const hints = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.refId?.startsWith(DUE_RISK_REF_PREFIX));
const notified = (fix: JobFix, jobId: string) => fix.ctx.store.table('jobNotices').get(jobId)?.dueRiskNotifiedAt ?? null;

/** 额度红灯：员工份额用完（kind staff_full）或真实额度用完（exhausted）；窗口起点一小时前，恢复时刻 resetAt。 */
function red(fix: JobFix, kind: 'staff_full' | 'exhausted', resetAt: number): void {
  const now = fix.ctx.clock.now();
  fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt: now - HOUR, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
    light: 'red', redUntil: resetAt, probeAllowed: false, lastError: null, lastErrorAt: null });
  fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, now - HOUR), capacityTokens: 1_000_000, staffTokens: 700_000,
    ...(kind === 'exhausted' ? { exhausted: { at: now, resetAt, resetFromText: true } } : {}) });
}
/** 灯回到绿色（红灯结束）。 */
function green(fix: JobFix): void {
  fix.ctx.store.table('quota').put({ ...fix.ctx.store.table('quota').get('quota')!, light: 'green', redUntil: null });
  fix.ctx.store.table('quotaWindows').patch('quota', { staffTokens: 0 });
}

/**
 * 夹具：现在 17:50（不在免打扰时段），派出一件事（旧数据口径：没有预计，余下 = max(1, 预算线 - 已用)，所以余下回合数可以直接指定），
 * 交付时间 dueAt。返回这件事和它的标题。
 */
async function scene(options: { remaining?: number; dueAt?: number; now?: string } = {}) {
  const fix = await jobFix();
  const { job: created } = await assigned(fix);
  fix.ctx.clock.set(at(options.now ?? '2026-11-13T17:50:00'));
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
  // 派活时间晚一毫秒：清单里按派活先后排，第二件排在后面。
  fix.ctx.store.table('jobs').put({ ...base, id: 'job_0000000099', agreementId: 'agr_0000000099', assignedAt: base.assignedAt + 1, dueAt, turnsUsed: 0, turnCap: remaining });
  return 'job_0000000099';
}

const STAFF_FULL_TEXT = [
  '员工本窗口的额度已用完，18:20 恢复。',
  '{标题}还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 18:00。',
  '你可以让我把交付时间改到 19:00 之后；也可以回复「用我的额度」，员工现在用你留出的部分接着做。',
].join('\n\n');

describe('10 会误交付时间：落消息与推送（17:50，不在免打扰时段，推送渠道打开）', () => {
  it('员工份额用完、余下 2 回合、恢复 18:20、交付 18:00：落消息逐字、推送一次、refId 前缀 duerisk:、这件事已记提示', async () => {
    const { fix, job, title } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(hints(fix)[0]).toMatchObject({ kind: 'reply', thread: fix.chief.id, from: fix.chief.id, refId: `duerisk:${job.id}`,
      text: STAFF_FULL_TEXT.replace('{标题}', title) });
    expect(notices(fix)).toHaveLength(1);
    expect(notices(fix)[0]).toMatchObject({ title: `${title}可能晚于交付时间`, body: STAFF_FULL_TEXT.replace('{标题}', title), level: 'P1' });
    expect(notified(fix, job.id)).toBe(fix.ctx.clock.now());
  });

  it('反例：交付 21:00，做完约在 18:30，不晚于交付时间：不落消息、不推送、不记提示', async () => {
    const { fix, job } = await scene({ dueAt: at('2026-11-13T21:00:00') });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(0);
    expect(notices(fix)).toHaveLength(0);
    expect(notified(fix, job.id)).toBeNull();
  });

  it('边界：做完时刻正好等于交付时间不算晚；多 1 毫秒算晚（18:20 + 2 回合 x 5 分钟 = 18:30）', async () => {
    const equal = await scene({ dueAt: at('2026-11-13T18:30:00') });
    red(equal.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(equal.fix.ctx, equal.fix.ctx.clock.now());
    expect(hints(equal.fix)).toHaveLength(0);
    const late = await scene({ dueAt: at('2026-11-13T18:30:00') - 1 });
    red(late.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(late.fix.ctx, late.fix.ctx.clock.now());
    expect(hints(late.fix)).toHaveLength(1);
  });

  it('余下回合数决定结论：交付 18:30 时，余下 2 回合（做完 18:30）不提示，余下 3 回合（做完 18:35）提示，文字写「约 3 回合」', async () => {
    const two = await scene({ dueAt: at('2026-11-13T18:30:00'), remaining: 2 });
    red(two.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(two.fix.ctx, two.fix.ctx.clock.now());
    expect(hints(two.fix)).toHaveLength(0);
    const three = await scene({ dueAt: at('2026-11-13T18:30:00'), remaining: 3 });
    red(three.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(three.fix.ctx, three.fix.ctx.clock.now());
    expect(hints(three.fix)[0]!.text).toContain('还差约 3 回合，按这个时间做完约在 18:35，晚于约定的 18:30。');
  });

  it('真实额度用完：首句和末句换成另一套，末句没有「用我的额度」', async () => {
    const { fix, title } = await scene();
    red(fix, 'exhausted', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    const expected = ['额度已用完，约 18:20 恢复。', `${title}还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 18:00。`, '你可以让我把交付时间改到 19:00 之后。'].join('\n\n');
    expect(hints(fix)[0]!.text).toBe(expected);
    expect(hints(fix)[0]!.text).not.toContain('用我的额度');
    expect(notices(fix)).toHaveLength(1);
    expect(notices(fix)[0]!.body).toBe(expected);
  });

  it('跨日：恢复和做完都在次日，时刻带月日；建议时刻取整到下一个整点', async () => {
    const { fix, title } = await scene({ dueAt: at('2026-11-14T01:00:00') });
    red(fix, 'staff_full', at('2026-11-14T02:00:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)[0]!.text).toBe([
      '员工本窗口的额度已用完，11月14日 02:00 恢复。',
      `${title}还差约 2 回合，按这个时间做完约在 11月14日 02:10，晚于约定的 11月14日 01:00。`,
      '你可以让我把交付时间改到 11月14日 03:00 之后；也可以回复「用我的额度」，员工现在用你留出的部分接着做。',
    ].join('\n\n'));
  });

  it('同一窗口只一次：再检查一次不再落消息、不再推送（17:50 与 17:55）', async () => {
    const { fix, job } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    fix.ctx.clock.advance(5 * MINUTE);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(notices(fix)).toHaveLength(1);
    expect(notified(fix, job.id)).toBe(at('2026-11-13T17:50:00'));
  });

  // P76m（审查 R16）：记号原来按「灯不是红」清，同一窗口里灯由红转橙再转红会让私聊重复一次；
  // 现在按额度窗口清（窗口起点比记号晚才清），所以本用例改成显式把窗口起点前进一次。
  it('窗口起点前进（窗口滚动）后清空记号；下次再红可再提示：第二次落消息、再推送一次', async () => {
    const { fix, job } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).not.toBeNull();
    // 灯回到绿色：同一个窗口里不清记号，也不再提示（同窗口再红不重复由 p76m-due-risk.test.ts 覆盖）。
    fix.ctx.clock.advance(10 * MINUTE);
    green(fix);
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBe(at('2026-11-13T17:50:00'));
    expect(hints(fix)).toHaveLength(1);
    // 窗口滚动：起点比记号晚，下一次检查清空记号。
    fix.ctx.store.table('quota').patch('quota', { windowStartAt: at('2026-11-13T17:51:00'), light: 'green', redUntil: null });
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBeNull();
    // 新窗口里又红（直接设到 22:30，在免打扰时段之前；恢复 23:30 之后算不上晚于交付时间，所以把交付时间改到 23:00）。
    fix.ctx.clock.set(at('2026-11-13T22:30:00'));
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: at('2026-11-13T23:00:00') });
    red(fix, 'staff_full', at('2026-11-13T23:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(2);
    expect(notices(fix)).toHaveLength(2);
    expect(notified(fix, job.id)).toBe(at('2026-11-13T22:30:00'));
  });

  // P76m（审查 R16）：清空的条件改成「记号早于当前额度窗口起点」，不再看灯是不是红。
  // 下面两个方向都测：上一个窗口留下的记号清掉；本窗口的记号保留。绿灯下都不提示。
  it('绿灯下按窗口起点清记号：上一个窗口的记号清掉，本窗口的记号保留；都不落消息、不推送', async () => {
    const { fix, job } = await scene();
    const putGreen = (windowStartAt: number) => fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt, botTurns: 0, botTokens: 0,
      turnLimit: 40, tokenLimit: null, light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null });
    const putMarker = (value: number | null) => fix.ctx.store.table('jobNotices').put({ ...fix.ctx.store.table('jobNotices').get(job.id) ?? {
      id: job.id, lastProgressAt: 0, rewakeAt: null, stallNotifiedAt: null, stallKind: null, overdueNotifiedFor: null,
      remindedItemIds: [], budgetAskedCaps: [], holdAtCap: false, narrowRequestedAt: null, dueRiskNotifiedAt: null, updatedAt: 0 },
      dueRiskNotifiedAt: value });
    // 上一个窗口的记号（10:00），本窗口从 11:00 起：清掉。
    putMarker(at('2026-11-13T10:00:00'));
    putGreen(at('2026-11-13T11:00:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBeNull();
    // 本窗口的记号（12:00），本窗口从 11:00 起：保留（同窗口不再重复提示）。
    putMarker(at('2026-11-13T12:00:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(notified(fix, job.id)).toBe(at('2026-11-13T12:00:00'));
    expect(hints(fix)).toHaveLength(0);
    expect(notices(fix)).toHaveLength(0);
  });

  it('两件事同一个总管：合成一条消息（首句一次、每件一段、末句取最晚做完时刻的整点）、推送一次、refId 含两个编号、两件事都记提示', async () => {
    const { fix, job, title } = await scene();
    // 第二件：余下 6 回合，做完 18:20 + 30 分钟 = 18:50，交付 18:40。
    const secondId = addSecondJob(fix, job, at('2026-11-13T18:40:00'), 6);
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(hints(fix)[0]!.refId).toBe(`duerisk:${job.id},${secondId}`);
    const text = hints(fix)[0]!.text;
    expect(text.split('\n\n')).toEqual([
      '员工本窗口的额度已用完，18:20 恢复。',
      `${title}还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 18:00。`,
      '另一件事还差约 6 回合，按这个时间做完约在 18:50，晚于约定的 18:40。',
      '你可以让我把交付时间改到 19:00 之后；也可以回复「用我的额度」，员工现在用你留出的部分接着做。',
    ]);
    expect(notices(fix)).toHaveLength(1);
    expect(notices(fix)[0]).toMatchObject({ title: '2 件事可能晚于交付时间', body: text });
    expect(notified(fix, job.id)).not.toBeNull();
    expect(notified(fix, secondId)).not.toBeNull();
  });

  it('两件事里只有一件会晚：消息只写这一件，另一件不记提示', async () => {
    const { fix, job } = await scene();
    const secondId = addSecondJob(fix, job, at('2026-11-14T18:00:00'), 6);
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)[0]!.refId).toBe(`duerisk:${job.id}`);
    expect(hints(fix)[0]!.text).not.toContain('另一件事');
    expect(notified(fix, secondId)).toBeNull();
  });

  it('不在清单里的事：没有交付时间、待你验收、已验收在发布环节，都不提示', async () => {
    const noDue = await scene();
    noDue.fix.ctx.store.table('jobs').patch(noDue.job.id, { dueAt: null });
    red(noDue.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(noDue.fix.ctx, noDue.fix.ctx.clock.now());
    expect(hints(noDue.fix)).toHaveLength(0);

    const awaiting = await scene();
    awaiting.fix.ctx.store.table('jobs').patch(awaiting.job.id, { state: 'awaiting_owner' });
    red(awaiting.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(awaiting.fix.ctx, awaiting.fix.ctx.clock.now());
    expect(hints(awaiting.fix)).toHaveLength(0);

    const launching = await scene();
    launching.fix.ctx.store.table('jobs').patch(launching.job.id, { state: 'done', launch: { ...launching.job.launch, state: 'preparing' } });
    red(launching.fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(launching.fix.ctx, launching.fix.ctx.clock.now());
    expect(hints(launching.fix)).toHaveLength(0);
    expect(notices(launching.fix)).toHaveLength(0);
  });

  it('进行中的四种状态都会提示（待开工、执行中、核对中、返工中）', async () => {
    for (const state of ['ready', 'doing', 'checking', 'rework'] as const) {
      const { fix, job } = await scene();
      fix.ctx.store.table('jobs').patch(job.id, { state });
      red(fix, 'staff_full', at('2026-11-13T18:20:00'));
      await checkDueRisk(fix.ctx, fix.ctx.clock.now());
      expect(hints(fix), state).toHaveLength(1);
    }
  });

  it('有预计的事：余下取 projectJob（核对中、返工预留与总管预留都用完 → 余下 1 回合；总管预留没用 → 余下 2 回合）', async () => {
    const { fix, job } = await scene();
    // 恢复预计：夹具里 scene 删掉了预计，这里重建一份与派活时相同的（执行 3、核对 1、返工预留 3、总管 1）。
    const estimate = { versionNo: 1, reason: 'lock', createdAt: 1, total: 9, steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 } };
    const row = { id: job.agreementId, versions: [estimate] };
    fix.ctx.store.table('jobEstimates').put(row as never);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'checking', dueAt: at('2026-11-13T18:27:00') });
    const usage = fix.ctx.store.table('jobUsage').get(job.id);
    expect(usage, '夹具里这件事应有用量行').not.toBeNull();
    fix.ctx.store.table('jobUsage').put({ ...usage!, steps: { ...usage!.steps, rework: { turns: 3, tokens: 0 }, chief: { turns: 1, tokens: 0 } } });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    // 余下 1 回合：做完 18:25，交付 18:27 不晚。
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(0);
    // 总管预留没用：余下 2 回合，做完 18:30，晚于 18:27。
    fix.ctx.store.table('jobUsage').put({ ...usage!, steps: { ...usage!.steps, rework: { turns: 3, tokens: 0 }, chief: { turns: 0, tokens: 0 } } });
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(hints(fix)[0]!.text).toContain('还差约 2 回合，按这个时间做完约在 18:30，晚于约定的 18:27。');
  });

  it('没有预计的旧事：余下按 max(1, 预算线 - 已用)；已用超过预算线时至少 1 回合', async () => {
    const { fix, job } = await scene({ remaining: 2 });
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 5, turnsUsed: 9, dueAt: at('2026-11-13T18:24:00') });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)[0]!.text).toContain('还差约 1 回合，按这个时间做完约在 18:25，晚于约定的 18:24。');
  });

  it('取整到整点的纯函数：18:30 取 19:00，正好 19:00 不动，带秒的取下一个整点', () => {
    expect(ceilToHour(at('2026-11-13T18:30:00'), 'Asia/Shanghai')).toBe(at('2026-11-13T19:00:00'));
    expect(ceilToHour(at('2026-11-13T19:00:00'), 'Asia/Shanghai')).toBe(at('2026-11-13T19:00:00'));
    expect(ceilToHour(at('2026-11-13T19:00:01'), 'Asia/Shanghai')).toBe(at('2026-11-13T20:00:00'));
    // 半小时偏移的时区（印度）：本地整点以本地为准。
    expect(ceilToHour(Date.parse('2026-11-13T12:10:00Z'), 'Asia/Kolkata')).toBe(Date.parse('2026-11-13T12:30:00Z'));
  });
});

describe('10 补充：免打扰与渠道（落消息不受影响，推送各按各的规则）', () => {
  it('23:30 在免打扰时段内、渠道打开：消息照落，推送顺延到 08:00 才发', async () => {
    const { fix, job } = await scene({ now: '2026-11-13T23:30:00', dueAt: at('2026-11-14T00:00:00') });
    red(fix, 'staff_full', at('2026-11-14T00:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(notices(fix)).toHaveLength(0);
    expect(dueRows(fix)).toHaveLength(1);
    expect(dueRows(fix)[0]).toMatchObject({ category: 'agreement', state: 'waiting', botId: fix.chief.id });
    expect(notified(fix, job.id)).not.toBeNull();
  });

  it('推送渠道关闭（pushChannel none，10:00 不在免打扰时段）：消息照落、宿主通知没有被调用、队列行丢弃', async () => {
    const fix = await jobFix([], { pushChannel: 'none' });
    const { job: created } = await assigned(fix);
    fix.ctx.clock.set(at('2026-11-13T17:50:00'));
    fix.ctx.store.table('jobEstimates').remove(created.agreementId);
    fix.ctx.store.table('jobs').patch(created.id, { dueAt: at('2026-11-13T18:00:00'), turnCap: created.turnsUsed + 2 });
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    expect(notices(fix)).toHaveLength(0);
    expect(dueRows(fix).map(row => row.state)).toEqual(['dropped']);
  });

  it('推送带的是总管，没有条目编号：队列行不带 inboxId', async () => {
    const { fix } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    const row = dueRows(fix)[0]!;
    expect(row.inboxId).toBeUndefined();
    expect(row.subjectKey).toMatch(/^duerisk:\d+:job_/);
  });
});

describe('10 接线：引擎每个 tick 调用一次（17:50 不在免打扰时段，渠道打开）', () => {
  it('红灯下跑一次真实 tick：落消息、推送一次；再跑一次 tick 不重复', async () => {
    const { fix } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(hints(fix)).toHaveLength(1);
    expect(notices(fix)).toHaveLength(1);
    fix.ctx.clock.advance(MINUTE);
    await fix.hub.tick();
    expect(hints(fix)).toHaveLength(1);
  });
});

describe('11 「用我的额度」接上（端到端，17:50 不在免打扰时段，渠道打开）', () => {
  it('提示落下后，整句回复「用我的额度」：识别生效，这件事进 borrowJobIds，总管回话逐字', async () => {
    const { fix, job, title } = await scene();
    red(fix, 'staff_full', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    expect(hints(fix)).toHaveLength(1);
    fix.ctx.clock.advance(5 * MINUTE);
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(getQuotaPlan(fix.ctx, fix.ctx.clock.now()).borrowJobIds).toEqual([job.id]);
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply',
      text: `好的，${title}现在用你留出的额度接着做，本窗口结束前有效。` });
  });

  it('反例：真实额度用完时，提示里没有这句，回复「用我的额度」也不生效', async () => {
    const { fix } = await scene();
    red(fix, 'exhausted', at('2026-11-13T18:20:00'));
    await checkDueRisk(fix.ctx, fix.ctx.clock.now());
    sendOwnerMessage(fix.ctx, fix.chief.id, '用我的额度');
    expect(getQuotaPlan(fix.ctx, fix.ctx.clock.now()).borrowJobIds).toEqual([]);
  });
});
