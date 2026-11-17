/**
 * P76i 第 3.1 节：右侧栏「在办的事」（activeJobsView）。
 *
 * 夹具见 p76i-fixtures.ts（设计稿场景 A 的三件事；总管听吩咐、安静节奏，执行员工听吩咐）。
 * 本文件的用例逐字对照派活说明第一节的句子；每条规则至少一个正例一个反例；
 * 时间用注入的假时钟（场景设在 2026-11-17 14:00，北京时间；没有推进时钟的用例）。
 */
import { describe, expect, it } from 'vitest';
import { activeJobsView, ActiveJobsViewSchema } from '../src/api/active-jobs-views.js';
import { chiefJobLineFor } from '../src/api/job-topic-views.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';
import { goalFixture } from './model-fixtures.js';
import { HOUR, MINUTE, NOW, assigned, at, cloneAgreement, cloneJob, jobFix, putEstimate, putItem, putUsage, sceneA, type JobFix } from './p76i-fixtures.js';

describe('1 总管的「在办的事」：三行顺序、每行文字、头部合计', () => {
  it('两件在等你的在前（等得久的在前），其余在后；每行三段文字逐字；头部合计逐字', async () => {
    const { ctx, fix, report, guest, tweet } = await sceneA();
    const view = activeJobsView(ctx, fix.chief.id);
    expect(view.rows.map(row => row.title)).toEqual(['嘉宾介绍页', '活动推文', '活动报名页']);
    expect(view.rows.map(row => row.key)).toEqual([guest.id, tweet.id, report.id]);
    expect(view.rows[0]).toEqual({ key: guest.id, topicId: guest.topicId, title: '嘉宾介绍页', stateLabel: '受阻', stateTone: 'you',
      waitText: '在等：你　决定预计消耗怎样处理　已等 6 小时　交付：待定', costText: '4 / 8 回合　630K token', costRatio: 0.5, waitingOwner: true });
    expect(view.rows[1]).toEqual({ key: tweet.id, topicId: tweet.topicId, title: '活动推文', stateLabel: '对齐中', stateTone: 'you',
      waitText: '在等：你　确认约定第 1 版　交付：待定', costText: '1 / 5 回合　50K token', costRatio: 0.2, waitingOwner: true });
    expect(view.rows[2]).toEqual({ key: report.id, topicId: report.topicId, title: '活动报名页', stateLabel: '核对中', stateTone: 'run',
      waitText: '在等：评审甲　第 1 轮，共 3 轮　交付：11月17日 18:00 前', costText: '9 / 14 回合　1.4M token', costRatio: 9 / 14, waitingOwner: false });
    // 头部：已用回合 4 + 1 + 9 = 14；token 630K + 50K + 1.4M = 2.08M。
    expect(view.headText).toBe('在办的事　3 件　共用 14 回合，2.08M token');
    expect(view.footerText).toBe('查看全部记录');
    expect(ActiveJobsViewSchema.safeParse(view).success).toBe(true);
  });

  it('已完成、已停止的事不在；已完成但在发布准备的事在（状态词「已完成」，在等执行者）', async () => {
    const { ctx, fix, report } = await sceneA();
    const agreement = ctx.store.table('agreements').get(report.agreementId)!;
    const doneAgreement = cloneAgreement(ctx, agreement, 'donepage01', '已验收页');
    cloneJob(ctx, report, 'donepage01', doneAgreement, { state: 'done', launchStep: false, launch: { state: 'none', approvalId: null, link: null }, acceptedAt: NOW - HOUR });
    const stoppedAgreement = cloneAgreement(ctx, agreement, 'stoppedpg1', '已停止页');
    cloneJob(ctx, report, 'stoppedpg1', stoppedAgreement, { state: 'stopped', stoppedAt: NOW - HOUR });
    const launchAgreement = cloneAgreement(ctx, agreement, 'launchpag1', '发布准备页');
    const launching = cloneJob(ctx, report, 'launchpag1', launchAgreement, { state: 'done', launchStep: true, dueAt: null,
      launch: { state: 'preparing', approvalId: null, link: null }, acceptedAt: NOW - HOUR });
    const view = activeJobsView(ctx, fix.chief.id);
    expect(view.rows.map(row => row.title).sort()).toEqual(['发布准备页', '嘉宾介绍页', '活动报名页', '活动推文']);
    const row = view.rows.find(item => item.key === launching.id)!;
    expect(row).toMatchObject({ stateLabel: '已完成', stateTone: 'ok', waitingOwner: false, waitText: '在等：林舟　交付：待定' });
    // 头部的件数跟着变成 4 件。
    expect(view.headText.startsWith('在办的事　4 件')).toBe(true);
  });

  it('其余的行按交付时间先后，没有交付时间的最后；同序按更新时间新到旧', async () => {
    const { ctx, fix, report } = await sceneA();
    const agreement = ctx.store.table('agreements').get(report.agreementId)!;
    // 去掉两件在等你的事的影响：只看总管名下新增的三件进行中的事的相对顺序。
    const make = (suffix: string, title: string, dueAt: number | null, updatedAt: number) =>
      cloneJob(ctx, report, suffix, cloneAgreement(ctx, agreement, suffix, title), { state: 'doing', round: 0, dueAt, reviewerId: null, updatedAt });
    make('orderpg001', '无交付时间甲', null, NOW - 10 * MINUTE);
    make('orderpg002', '交付晚', at('2026-11-18T10:00:00'), NOW - 5 * MINUTE);
    make('orderpg003', '交付早', at('2026-11-17T16:00:00'), NOW - 20 * MINUTE);
    make('orderpg004', '无交付时间乙', null, NOW - 2 * MINUTE);
    const titles = activeJobsView(ctx, fix.chief.id).rows.filter(row => !row.waitingOwner).map(row => row.title);
    // 活动报名页交付 18:00：早于「交付晚」、晚于「交付早」；没有交付时间的在最后，更新得晚的（乙）在前。
    expect(titles).toEqual(['交付早', '活动报名页', '交付晚', '无交付时间乙', '无交付时间甲']);
  });

  it('等的时间越长越靠前：在等你的两件，等 6 小时的排在等 20 分钟的前面（反例：把等待时间反过来则顺序反过来）', async () => {
    const { ctx, fix, guest } = await sceneA();
    expect(activeJobsView(ctx, fix.chief.id).rows.map(row => row.title).slice(0, 2)).toEqual(['嘉宾介绍页', '活动推文']);
    // 把嘉宾介绍页的条目改成 5 分钟前建的：它不再是等得最久的。
    ctx.store.table('inbox').patch('i_capguest01', { createdAt: NOW - 5 * MINUTE });
    expect(activeJobsView(ctx, fix.chief.id).rows.map(row => row.title).slice(0, 2)).toEqual(['活动推文', '嘉宾介绍页']);
    expect(guest.id).toBeTruthy();
  });
});

describe('2 员工口径', () => {
  it('评审员只看到他核对的活动报名页；执行者看到他执行的两件；其他员工没有', async () => {
    const { ctx, fix, report, guest } = await sceneA();
    const reviewer = activeJobsView(ctx, fix.reviewer.id);
    expect(reviewer.rows.map(row => row.key)).toEqual([report.id]);
    expect(reviewer.headText).toBe('在办的事　1 件　共用 9 回合，1.4M token');
    const engineer = activeJobsView(ctx, fix.engineer.id);
    expect(engineer.rows.map(row => row.key).sort()).toEqual([guest.id, report.id].sort());
    // 对齐中的约定只出现在总管那里：执行者、评审员都没有。
    expect(engineer.rows.some(row => row.stateLabel === '对齐中')).toBe(false);
    expect(reviewer.rows.some(row => row.stateLabel === '对齐中')).toBe(false);
  });

  it('没有事的员工：现在没有在办的事', async () => {
    const fix = await jobFix();
    expect(activeJobsView(fix.ctx, fix.engineer.id)).toEqual({ headText: '现在没有在办的事', rows: [], footerText: '查看全部记录' });
    expect(activeJobsView(fix.ctx, fix.chief.id).headText).toBe('现在没有在办的事');
  });
});

/** 额度红灯：员工份额用完（staff_full），窗口起点一小时前，恢复时刻 resetAt。 */
function staffFull(fix: JobFix, resetAt: number): void {
  const now = fix.ctx.clock.now();
  fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt: now - HOUR, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
    light: 'red', redUntil: resetAt, probeAllowed: false, lastError: null, lastErrorAt: null });
  fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, now - HOUR), capacityTokens: 1_000_000, staffTokens: 700_000 });
}

describe('3 预期的人被额度挡住', () => {
  it('员工份额用完、执行者的候选被拦：「在等：额度恢复，约 18:20 继续　交付：……」', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.clock.set(at('2026-11-17T17:50:00'));
    staffFull(fix, at('2026-11-17T18:20:00'));
    const row = activeJobsView(fix.ctx, fix.chief.id).rows.find(item => item.key === job.id)!;
    expect(row.waitText).toBe('在等：额度恢复，约 18:20 继续　交付：11月17日 18:00 前');
  });

  it('反例一：灯是绿色，不改写（写执行者的名字）', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.clock.set(at('2026-11-17T17:50:00'));
    const row = activeJobsView(fix.ctx, fix.chief.id).rows.find(item => item.key === job.id)!;
    expect(row.waitText).toBe('在等：林舟　交付：11月17日 18:00 前');
  });

  it('反例二：红灯，但这件事已被「用我的额度」放行（候选不受额度影响）：不改写', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.clock.set(at('2026-11-17T17:50:00'));
    staffFull(fix, at('2026-11-17T18:20:00'));
    fix.ctx.store.table('quotaWindows').patch('quota', { borrowJobIds: [job.id] });
    const row = activeJobsView(fix.ctx, fix.chief.id).rows.find(item => item.key === job.id)!;
    expect(row.waitText).not.toContain('额度恢复');
    expect(row.waitText.startsWith('在等：林舟')).toBe(true);
  });

  it('反例三：红灯，但这件事没有候选在排队（核对中、核对人是评审甲、队列为空）：不改写', async () => {
    const { ctx, fix, report } = await sceneA();
    staffFull(fix, NOW + 20 * MINUTE);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe('在等：评审甲　第 1 轮，共 3 轮　交付：11月17日 18:00 前');
  });
});

describe('4 停滞记号', () => {
  /** 林舟的一件执行中的事，没有进展 3 小时前；停滞通知时间与最近一次记录由用例给。 */
  async function stalledScene(notice: { lastProgressAt: number; stallNotifiedAt: number | null }) {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'doing', round: 0 });
    ctx.store.table('jobNotices').put({ id: report.id, lastProgressAt: notice.lastProgressAt, rewakeAt: null, stallNotifiedAt: notice.stallNotifiedAt,
      stallKind: notice.stallNotifiedAt === null ? null : 'idle', overdueNotifiedFor: null, remindedItemIds: [], budgetAskedCaps: [], holdAtCap: false,
      narrowRequestedAt: null, dueRiskNotifiedAt: null, updatedAt: NOW });
    return { ctx, fix, report };
  }

  it('通知过停滞、之后没有新记录：「在等：林舟　3 小时没有进展　交付：……」', async () => {
    const { ctx, fix, report } = await stalledScene({ lastProgressAt: NOW - 3 * HOUR, stallNotifiedAt: NOW - HOUR });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe('在等：林舟　3 小时没有进展　交付：11月17日 18:00 前');
    expect(row.waitingOwner).toBe(false);
  });

  it('反例：通知之后又有了新记录（最近记录晚于通知时间）：不写没有进展', async () => {
    const { ctx, fix, report } = await stalledScene({ lastProgressAt: NOW - 10 * MINUTE, stallNotifiedAt: NOW - HOUR });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe('在等：林舟　交付：11月17日 18:00 前');
  });

  it('反例：没有通知过停滞：不写没有进展', async () => {
    const { ctx, fix, report } = await stalledScene({ lastProgressAt: NOW - 3 * HOUR, stallNotifiedAt: null });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe('在等：林舟　交付：11月17日 18:00 前');
  });
});

describe('5 在等你：条目的简短事项与「消耗将超出预计」条目', () => {
  /** 林舟执行中的一件事，开着一条某类的条目（建于 2 小时前）。 */
  async function withItem(kind: string) {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'doing', round: 0 });
    putItem(ctx, { id: 'i_itemtest01', botId: fix.chief.id, subjectKey: `job:${report.id}:${kind}:1`, title: '一条', createdAt: NOW - 2 * HOUR });
    return { ctx, fix, report };
  }

  it.each([
    ['accept', '验收'], ['escalate', '选一个办法'],
  ])('开着一条「%s」条目（甲成立）：「在等：你　%s　已等 2 小时」', async (kind, short) => {
    const { ctx, fix, report } = await withItem(kind);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe(`在等：你　${short}　已等 2 小时　交付：11月17日 18:00 前`);
    expect(row.waitingOwner).toBe(true);
  });

  it.each([
    ['cap', '决定预计消耗怎样处理'], ['stall', '决定怎样继续'],
  ])('开着一条「%s」条目、但这件事没停（只有乙成立）：在等的人仍是执行者，后面补一句「另有一条在等你%s」', async (kind, short) => {
    const { ctx, fix, report } = await withItem(kind);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe(`在等：林舟　另有一条在等你${short}　交付：11月17日 18:00 前`);
    expect(row.waitingOwner).toBe(false);
    // 排序不变：有开着的条目的事仍排在前面。
    expect(activeJobsView(ctx, fix.chief.id).rows.slice(0, 3).map(item => item.key)).toContain(report.id);
  });

  it('还没到预算线的「消耗将超出预计」条目开着、这件事仍在执行：不算真的停下在等你（甲不成立），但排在前面并有那一句', async () => {
    const { ctx, fix, report } = await withItem('cap');
    expect(ctx.store.table('jobs').get(report.id)!.state).toBe('doing'); // 没有受阻，这件事并没有停
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row).toMatchObject({ waitingOwner: false, stateLabel: '执行中', waitText: '在等：林舟　另有一条在等你决定预计消耗怎样处理　交付：11月17日 18:00 前' });
    // 排在最前面的几行里（有开着的条目的事在前）。
    expect(activeJobsView(ctx, fix.chief.id).rows.slice(0, 3).map(item => item.key)).toContain(report.id);
  });

  it('反例：条目已被答复（不是开着）：不算在等你，写执行者的名字', async () => {
    const { ctx, fix, report } = await withItem('cap');
    ctx.store.table('inbox').patch('i_itemtest01', { status: 'answered' });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row).toMatchObject({ waitingOwner: false, waitText: '在等：林舟　交付：11月17日 18:00 前' });
  });

  it('待你验收但没有开着的条目：简短事项兜底写「验收」，已等从交付时间算起', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'awaiting_owner', deliveredAt: NOW - 3 * HOUR });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row).toMatchObject({ stateLabel: '待你验收', waitingOwner: true, waitText: '在等：你　验收　已等 3 小时　交付：11月17日 18:00 前' });
  });

  it('执行中在等你确认约定的新版本：「在等：你　确认约定第 n 版」', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'doing', round: 0, pause: { versionNo: 2, continuing: ['先做着'], paused: ['暂停的部分'], fallback: null, executorWaiting: true } });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row).toMatchObject({ waitingOwner: true, waitText: '在等：你　确认约定第 2 版　交付：11月17日 18:00 前' });
  });
});

describe('6 没有预计的旧事、没有用量的旧事', () => {
  it('没有预计：costText 写「已用 n 回合　x token」，costRatio 为 null；没有这一行的键缺失也不出错', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobEstimates').remove(report.agreementId);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.costText).toBe('已用 9 回合　1.4M token');
    expect(row.costRatio).toBeNull();
    // 反例：有预计的另一行仍有比例。
    expect(activeJobsView(ctx, fix.chief.id).rows.find(item => item.title === '嘉宾介绍页')!.costRatio).toBe(0.5);
  });

  it('没有用量行（旧数据）：只写「已用 n 回合」，不写「0 token」（P76r3，R14 后半）', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobUsage').remove(report.id);
    ctx.store.table('jobEstimates').remove(report.agreementId);
    ctx.store.table('jobs').patch(report.id, { turnsUsed: 3 });
    expect(activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!.costText).toBe('已用 3 回合');
  });

  it('对齐中的行没有预计：「已用 n 回合　x token」', async () => {
    const { ctx, fix, tweet } = await sceneA();
    ctx.store.table('jobEstimates').remove(tweet.id);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === tweet.id)!;
    expect(row).toMatchObject({ costText: '已用 1 回合　50K token', costRatio: null });
  });
});

describe('7 不读目标表', () => {
  it('总管有一个一直「进行中」的目标、没有任何事：现在没有在办的事，左栏一句为空', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('goals').put({ ...goalFixture, botId: fix.chief.id, status: 'active' });
    expect(fix.ctx.store.table('goals').list(row => row.botId === fix.chief.id && row.status === 'active')).toHaveLength(1);
    expect(activeJobsView(fix.ctx, fix.chief.id).headText).toBe('现在没有在办的事');
    expect(chiefJobLineFor(fix.ctx, fix.chief.id)).toBeNull();
  });
});

describe('8 给主人看的文字不含内部编号和英文', () => {
  it('每一行的文字里没有 job_、agr_、b_ 和英文字母（token、K、M 这样的单位除外）', async () => {
    const { ctx, fix } = await sceneA();
    const view = activeJobsView(ctx, fix.chief.id);
    const texts = [view.headText, view.footerText, ...view.rows.flatMap(row => [row.title, row.stateLabel, row.waitText, row.costText])];
    for (const text of texts) {
      expect(text).not.toMatch(/job_|agr_|\bb_|ptp_/);
      expect(text.replace(/token/g, '').replace(/\d+(\.\d+)?[KMBT]/g, '')).not.toMatch(/[A-Za-z]/);
    }
  });
});

it('putUsage、putEstimate 夹具自检：写进去的预计与用量能被视图读到', async () => {
  const { ctx, fix, report } = await sceneA();
  putUsage(ctx, report, { exec: { turns: 2, tokens: 5_000 } });
  putEstimate(ctx, report.agreementId, 6);
  expect(activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!.costText).toBe('2 / 6 回合　5K token');
});
