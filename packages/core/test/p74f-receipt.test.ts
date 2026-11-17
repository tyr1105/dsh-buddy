/**
 * P74f 的测试：回执的数字（纯函数与真实流程）、交付卡与回执的视图、试用反馈。
 * 数字不依赖内存里只保留 14 天的事件日志：用这件事记录上的字段和表里的记录。
 */
import { describe, expect, it } from 'vitest';
import { buildDeliveryCard, buildReceiptCard } from '../src/api/job-delivery-views.js';
import { DeliveryCardViewSchema, ReceiptCardViewSchema } from '../src/api/job-view-schemas.js';
import { computeReceiptRows, durationText } from '../src/job/receipt.js';
import { delivered, threadOf, bot, INTERNAL, type JobFix } from './p74f-fixtures.js';
import type { Job } from '../src/model/job.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('14 回执五行的数字', () => {
  it('构造：两次约定确认、一次验收、一次回答、两轮核对且第 1 轮退回 1 条 -> 3 次、1 个、「2 轮，第 1 轮退回 1 条」', () => {
    const rows = computeReceiptRows({ firstLockedAt: 0, acceptedAt: 26 * HOUR, disturbed: 3, answered: 1, reviewRounds: 2, firstRoundUnmet: 1, versionNo: 2 });
    expect(rows).toEqual([
      { label: '从「定了」到验收', value: '1 天 2 小时' }, { label: '需要你处理', value: '3 次' }, { label: '总管代你答复的问题', value: '1 个' },
      { label: '核对', value: '2 轮，第 1 轮退回 1 条' }, { label: '约定版本', value: '第 2 版' },
    ]);
    expect(computeReceiptRows({ firstLockedAt: 0, acceptedAt: 1, disturbed: 0, answered: 0, reviewRounds: 1, firstRoundUnmet: 0, versionNo: 1 })[3]!.value).toBe('1 轮，一次通过');
  });

  it('时长：不足一天写「小时 分钟」，满一天写「天 小时」', () => {
    expect(durationText(2 * HOUR + 25 * 60_000)).toBe('2 小时 25 分钟');
    expect(durationText(30 * 60_000)).toBe('0 小时 30 分钟');
    expect(durationText(3 * DAY + 5 * HOUR)).toBe('3 天 5 小时');
  });

  it('真实流程：回执卡的五行与记录一致（一轮通过、没有回答、约定第 1 版），打扰你 = 约定确认与验收条目', async () => {
    const { fix, job } = await delivered();
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const card = fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'receipt')!.jobCard!;
    expect(ReceiptCardViewSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ kind: 'receipt', title: '交付回执　会员定价页' });
    const rows = card.kind === 'receipt' ? card.rows : [];
    // P76e：视图在原来五行后面追加第六行「消耗」（不写进这件事的记录，记录里仍是前五行）。
    expect(rows.map(row => row.label)).toEqual(['从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本', '消耗']);
    // P87：派活那个回合是你说「定了」之后总管执行的（你发起的），回执末尾多一句「另有你发起的 1 回合，约 {x} token」；前半句的数字不变。
    expect(rows[5]!.value).toMatch(/^\d+ 回合，预计 9；约 \S+ token；另有你发起的 1 回合，约 \S+ token$/);
    const disturbed = fix.ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`agreement:${job.agreementId}:`) || row.subjectKey.startsWith(`job:${job.id}:`));
    expect(rows[1]!.value).toBe(`${disturbed} 次`);
    expect(disturbed).toBeGreaterThanOrEqual(1);
    expect(rows.slice(2, 5).map(row => row.value)).toEqual(['0 个', '1 轮，一次通过', '第 1 版']);
    expect(rows[0]!.value).toMatch(/^\d+ 小时 \d+ 分钟$|^\d+ 天 \d+ 小时$/);
    expect(JSON.stringify(card)).not.toMatch(INTERNAL);
  });
});

describe('交付卡的视图（纯函数）', () => {
  const sub = (round: number, texts: string[]) => ({ id: `jsb_00000000${round}0`, jobId: 'job_aaaaaaaaaa', stage: 1, round, executorId: 'b_0000000002', versionNo: 1, changeNote: '改',
    items: texts.map((text, i) => ({ no: i + 1, text, selfCheck: 'met' as const, note: null, evidence: [] })), deliverables: ['交付/a.html'], preview: null, createdAt: round });
  const review = (round: number, verdicts: Array<'met' | 'unmet' | 'at_delivery' | 'carried'>) => ({ id: `jrv_00000000${round}0`, jobId: 'job_aaaaaaaaaa', stage: 1, round,
    submissionId: `jsb_00000000${round}0`, reviewerId: 'b_0000000003', carriedNote: null, spotChecked: [], createdAt: round,
    items: verdicts.map((verdict, i) => ({ no: i + 1, verdict, note: verdict === 'unmet' ? '没提示' : null, fixTo: verdict === 'unmet' ? '要提示' : null, rechecked: false })) });
  const base = { jobId: 'job_aaaaaaaaaa', stage: 1, jobState: 'awaiting_owner' as const, currentStage: 1, agreementTitle: '页', versionNo: 1,
    reviews: [review(1, ['at_delivery', 'met', 'unmet']), review(2, ['carried', 'carried', 'met'])], submissions: [sub(1, ['甲', '乙', '丙']), sub(2, ['甲', '乙', '丙'])],
    checks: [{ no: 1, ok: true }], deliveredAt: Date.parse('2026-11-12T02:00:00Z'), acceptedAt: null, ownerReturn: null, pendingVersionNo: null, hasPreview: true, timezone: 'Asia/Shanghai' };

  it('待你验收：交付时核对写交付时间和「总管核对」；改好的条目写「第 1 轮不符，第 2 轮改好。」；可以验收，提示怎么指出不符', () => {
    const card = buildDeliveryCard(base);
    expect(DeliveryCardViewSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ title: '页　按约定第 1 版', stateText: '待你验收', returnedHint: null, doneHint: null,
      actions: { accept: true, preview: true, hint: '哪条不符合，直接写序号和问题。' } });
    expect(card.items[0]).toMatchObject({ verdict: { label: '符合' }, note: '11月12日 10:00 交付。总管核对。' });
    expect(card.items[2]).toMatchObject({ history: '第 1 轮不符，第 2 轮改好。', verdict: { label: '符合' } });
    expect(card.items[1]!.history).toBeNull();
  });

  it('过了交付时间判不符；已完成写时间和「全部符合，你已验收」；被新版本取代写「已失效」', () => {
    expect(buildDeliveryCard({ ...base, checks: [{ no: 1, ok: false }] }).items[0]).toMatchObject({ verdict: { label: '不符' }, note: '已过交付时间' });
    const done = buildDeliveryCard({ ...base, jobState: 'done', acceptedAt: Date.parse('2026-11-12T03:30:00Z') });
    expect(done).toMatchObject({ stateText: '已完成　11月12日 11:30', doneHint: '3 条全部符合，你已验收。', actions: { accept: false } });
    // P74f-2（主会话裁定 3）：阶段被约定新版本退回返工取代，写「已失效：约定已更新」；同一阶段重新交付之后的旧卡写「已失效：已重新交付」。
    expect(buildDeliveryCard({ ...base, stage: 1, currentStage: 2, jobState: 'rework' }).stateText).toBe('已失效：约定已更新');
    expect(buildDeliveryCard({ ...base, stage: 1, currentStage: 1, jobState: 'awaiting_owner', revision: 0, latestRevision: 1 })).toMatchObject({ stateText: '已失效：已重新交付', actions: { accept: false } });
  });

  it('主人指出不符：「未通过：第 3 条」，只列被指出的条目（你判不符），其余保持通过；约定新版本在等确认时不可验收', () => {
    const owner = { stage: 1, at: 1, missed: '漏了', messageId: null, items: [{ no: 3, text: '丙', problem: '还是没提示', fixTo: '要提示' }] };
    const card = buildDeliveryCard({ ...base, jobState: 'rework', currentStage: 2, ownerReturn: owner });
    expect(card).toMatchObject({ stateText: '未通过：第 3 条', returnedHint: '其余 2 条：你未提出问题，保持通过。', actions: { accept: false, hint: null } });
    expect(card.items).toHaveLength(1);
    expect(card.items[0]).toMatchObject({ no: 3, verdict: { label: '你判不符', tone: 'bad' }, note: '还是没提示', fixTo: '要提示' });
    expect(buildDeliveryCard({ ...base, pendingVersionNo: 2 })).toMatchObject({ actions: { accept: false, hint: '约定第 2 版在等你确认，确认后再验收。' } });
    expect(buildReceiptCard('页', []).title).toBe('交付回执　页');
  });
});

describe('15 试用反馈', () => {
  const trialLines = (fix: JobFix, job: Job) => threadOf(fix.ctx, job.chiefId).filter(row => row.text.includes('的第一件事做完了'));

  it('新员工的第一件事验收后各一句（执行者、评审员），数字来自记录；落一次，事件有记录', async () => {
    const { fix, job } = await delivered();
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const lines = trialLines(fix, job).map(row => row.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^林舟（.+）的第一件事做完了：交回 1 次，第一次就全部符合，你验收时没有指出不符。$/);
    expect(lines[1]).toBe('评审甲（评审员）的第一件事做完了：核对 1 轮，你验收时没有发现漏判。');
    expect(fix.ctx.store.table('jobs').get(job.id)!.trialReported).toEqual([fix.engineer.id, fix.reviewer.id]);
    expect(fix.ctx.store.log('jobEvents').all().filter(row => row.kind === 'trial_reported' && row.actor === 'hub')).toHaveLength(2);
  });

  it('他们已有别的验收通过的事：不再出现（第二件）', async () => {
    const { fix, job } = await delivered();
    fix.ctx.store.table('jobs').put({ ...job, id: 'job_cccccccccc', agreementId: job.agreementId, state: 'done', acceptedAt: 1, inboxId: null });
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    expect(trialLines(fix, job)).toHaveLength(0);
  });

  it('总管自己核对：只有执行者那一句', async () => {
    const { fix, job } = await delivered([], { reviewer: '总管' });
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const lines = trialLines(fix, job);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain('林舟');
    expect(bot(fix, fix.engineer.id)).toBeDefined();
  });

  it('主人验收时指出过不符：执行者那句写「指出了 n 条不符」，评审那句写「核对漏掉的问题」（纯文字）', async () => {
    const { executorTrialText, reviewerTrialText } = await import('../src/job/trial.js');
    // P74r9 第 5 节：参数由 duty（岗位类别）改为 post（岗位名称，可为 null）；评审那句括号里不再写死「评审」，没有岗位名称时不写括号。
    expect(executorTrialText({ name: '林舟', post: '工程师', submits: 3, firstUnmet: 2, flagged: 1 }))
      .toBe('林舟（工程师）的第一件事做完了：交回 3 次，第 1 次有 2 条不符，你验收时指出了 1 条不符。');
    expect(reviewerTrialText({ name: '评审甲', post: '评审员', rounds: 3, flagged: 1 })).toBe('评审甲（评审员）的第一件事做完了：核对 3 轮，你验收时指出了 1 条核对漏掉的问题。');
    expect(reviewerTrialText({ name: '评审甲', post: null, rounds: 3, flagged: 1 })).toBe('评审甲的第一件事做完了：核对 3 轮，你验收时指出了 1 条核对漏掉的问题。');
    expect(executorTrialText({ name: '林舟', post: null, submits: 1, firstUnmet: 0, flagged: 0 })).toBe('林舟的第一件事做完了：交回 1 次，第一次就全部符合，你验收时没有指出不符。');
  });
});
