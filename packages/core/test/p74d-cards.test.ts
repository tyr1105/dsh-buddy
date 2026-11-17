/**
 * P74d 的测试：交回卡与核对卡的视图（api/job-card-views.ts）。
 *
 * 纯函数那一层直接喂数据（不读存储），逐种写法单测：标题、自查条数、证据的四种名称和检查说明、
 * 核对卡通过与不通过的列法、沿用说明的三种写法；读存储那一层走真实流程，确认主题线程里带的视图能通过导出的 zod 结构校验，
 * 往来折叠组里卡片的标题函数两种写法正确。
 */
import { describe, expect, it } from 'vitest';
import { cardTitleFor, jobCardView } from '../src/api/job-card-views.js';
import {
  JobCardViewSchema, buildReviewCard, buildSubmissionCard, reviewCardTitle, submissionCardTitle, REVIEW_CARD_FOOTER, topicFloorsView,
} from '../src/api/index.js';
import type { JobReview, JobSubmission } from '../src/model/job.js';
import { CHIEF, EXECUTOR, REVIEWER, evidenceFixture, reviewFixture, submissionFixture } from './p74a-job-fixtures.js';
import { INTERNAL, bot, callTool, engineerSubmits, nextPacket, reviewerInfo, started, theJob, threadOf } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';

/** 设计稿场景 C 的六条「怎样算做完」。 */
const TEXTS = ['手机和电脑都能看到标题、时间地点和报名表', '提交后显示「报名成功」', '手机号少填一位时提示「请填写 11 位手机号」',
  '提交 3 条后名单恰好 3 行', '11月17日 18:00 前交给你验收', '第 81 次提交显示「名额已满」'];

/** 第 1 轮交回：每条一种证据，覆盖四种名称。 */
function sample(patch: Partial<JobSubmission> = {}): JobSubmission {
  return submissionFixture({
    versionNo: 4, round: 1, deliverables: ['交付/报名页.html', '交付/提交成功页.html', '交付/名单.csv'],
    items: TEXTS.map((text, index) => ({ no: index + 1, text, selfCheck: 'met' as const, note: null, evidence: [] as JobSubmission['items'][number]['evidence'] })).map(item => {
      switch (item.no) {
        case 1: return { ...item, evidence: [evidenceFixture({ id: 'ev1', kind: 'image', path: '证据/手机.png', summary: '手机　390 宽', check: { status: 'ok', detail: '图片，3.2 KB' } })] };
        case 2: return { ...item, evidence: [evidenceFixture({ id: 'ev2', kind: 'file', path: '交付/提交成功页.html', summary: '提交成功页', check: { status: 'ok', detail: '文件存在，1.0 KB' } })] };
        case 3: return { ...item, selfCheck: 'not_met' as const, note: '提示文字还没改', evidence: [] };
        case 4: return { ...item, evidence: [evidenceFixture({ id: 'ev3', kind: 'link', path: null, url: 'https://demo.example.com/list?x=1', summary: '线上名单', check: { status: 'unchecked', detail: '中心不打开链接，由核对人查看' } })] };
        case 5: return { ...item, selfCheck: 'at_delivery' as const, note: null };
        default: return { ...item, evidence: [evidenceFixture({ id: 'ev4', kind: 'test', path: null, url: null, command: 'pnpm test signup', summary: '依次提交 81 条，第 81 条显示名额已满', check: { status: 'unchecked', detail: '中心不执行命令，由核对人复跑' } })] };
      }
    }),
    ...patch,
  });
}

/** 核对：第 3 条不符，其余符合，第 5 条交付时核对。 */
function failing(): JobReview {
  return reviewFixture({
    round: 1, items: TEXTS.map((_, index) => ({ no: index + 1, verdict: 'met' as const, note: null, fixTo: null, rechecked: false })).map(item =>
      item.no === 3 ? { ...item, verdict: 'unmet' as const, note: '提示文字与约定不一致', fixTo: '提示文字逐字一致：「请填写 11 位手机号」' }
        : item.no === 5 ? { ...item, verdict: 'at_delivery' as const }
          : item.no === 1 ? { ...item, note: '两张截图均无横向滚动', rechecked: true } : item),
  });
}

describe('17 交回卡', () => {
  it('标题、卡头、自查条数、产出物一行；每条的结论、证据名称（文件名、截图说明、自动测试、主机名）和检查说明', () => {
    const view = buildSubmissionCard({ submission: sample(), agreementTitle: '活动报名页' });
    expect(view).toMatchObject({
      kind: 'submission', head: '交回', title: '活动报名页　第 1 轮', stateText: '按约定第 4 版　自查 6 条',
      intro: '产出物：报名页.html、提交成功页.html、名单.csv，在主题文件夹「交付」里。',
    });
    expect(view.title).toBe(submissionCardTitle('活动报名页', 1));
    expect(view.items.map(item => [item.no, item.verdict])).toEqual([
      [1, { label: '自查符合', tone: 'ok' }], [2, { label: '自查符合', tone: 'ok' }], [3, { label: '自查不符', tone: 'bad' }],
      [4, { label: '自查符合', tone: 'ok' }], [5, { label: '交付时核对', tone: 'na' }], [6, { label: '自查符合', tone: 'ok' }]]);
    expect(view.items[0]!.evidence).toEqual([{ id: 'ev1', kind: 'image', label: '手机　390 宽', path: '证据/手机.png', url: null, summary: '手机　390 宽', checkText: '图片，3.2 KB' }]);
    expect(view.items[1]!.evidence[0]).toMatchObject({ kind: 'file', label: '提交成功页.html', checkText: '文件存在，1.0 KB' });
    expect(view.items[3]!.evidence[0]).toMatchObject({ kind: 'link', label: 'demo.example.com', url: 'https://demo.example.com/list?x=1', checkText: '中心不打开链接，由核对人查看' });
    expect(view.items[5]!.evidence[0]).toMatchObject({ kind: 'test', label: '自动测试', checkText: '中心不执行命令，由核对人复跑' });
    expect(view.items[2]).toMatchObject({ note: '提示文字还没改', fixTo: null, history: null });
    expect(view.items[0]!.text).toBe(TEXTS[0]);
    expect(JobCardViewSchema.parse(view)).toEqual(view);
  });

  it('沿用的条目：算在「沿用」里，不算自查条数，卡片上不重复展示证据，数据里的证据原样保留', () => {
    const base = sample();
    const submission = { ...base, round: 2, items: base.items.map(item => item.no === 3 ? item : { ...item, selfCheck: 'carried' as const }) };
    const view = buildSubmissionCard({ submission, agreementTitle: '活动报名页' });
    expect(view.stateText).toBe('按约定第 4 版　自查 1 条');
    expect(view.items.filter(item => item.verdict.label === '沿用')).toHaveLength(5);
    expect(view.items.filter(item => item.verdict.label === '沿用').every(item => item.evidence.length === 0 && item.note === null)).toBe(true);
    expect(submission.items[0]!.evidence).toHaveLength(1);
  });
});

describe('17 核对卡', () => {
  const names = { [EXECUTOR]: '林舟', [REVIEWER]: '评审员' };
  const base = { submission: sample(), previousRound: null, names, chiefId: CHIEF };

  it('不通过：标题写不符条数，剩余轮数，全部条目都列出，不符的写问题和改到什么程度算过，证据来自交回', () => {
    const view = buildReviewCard({ ...base, review: failing() });
    expect(view).toMatchObject({ kind: 'review', head: '核对', title: '第 1 轮　不通过：1 条不符', stateText: null, roundText: '剩余 2 轮',
      carriedText: null, footer: REVIEW_CARD_FOOTER, reviewerName: '评审员' });
    expect(view.title).toBe(reviewCardTitle(1, false, 1));
    expect(view.items).toHaveLength(6);
    expect(view.items[2]).toMatchObject({ no: 3, verdict: { label: '不符', tone: 'bad' }, note: '提示文字与约定不一致', fixTo: '提示文字逐字一致：「请填写 11 位手机号」' });
    expect(view.items[0]).toMatchObject({ verdict: { label: '符合', tone: 'ok' }, note: '两张截图均无横向滚动' });
    expect(view.items[0]!.evidence).toHaveLength(1);
    expect(view.items[4]!.verdict).toEqual({ label: '交付时核对', tone: 'na' });
    expect(REVIEW_CARD_FOOTER).toBe('只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。');
    expect(JobCardViewSchema.parse(view)).toEqual(view);
  });

  it('第 3 轮不通过写「剩余 0 轮」', () => {
    expect(buildReviewCard({ ...base, review: { ...failing(), round: 3 } }).roundText).toBe('剩余 0 轮');
  });

  /** 第 2 轮：只写了第 3 条，其余沿用。 */
  const passing = (patch: Partial<JobReview> = {}): JobReview => reviewFixture({
    round: 2, items: TEXTS.map((_, index) => index === 2 ? { no: 3, verdict: 'met' as const, note: '提示文字与约定逐字一致', fixTo: null, rechecked: true }
      : { no: index + 1, verdict: 'carried' as const, note: null, fixTo: null, rechecked: false }), ...patch,
  });

  it('通过：标题写全部条数，已通过，只列本轮非沿用的条目，沿用说明三种写法', () => {
    const submission = sample({ round: 2 });
    const card = (review: JobReview, previousRound: number | null = 1) => buildReviewCard({ ...base, submission, review, previousRound });
    const plain = card(passing());
    expect(plain).toMatchObject({ title: '第 2 轮　通过：6 条均符合', stateText: '已通过', roundText: null });
    expect(plain.items.map(item => item.no)).toEqual([3]);
    expect(plain.items[0]).toMatchObject({ verdict: { label: '符合', tone: 'ok' }, note: '提示文字与约定逐字一致' });
    expect(plain.carriedText).toBe('其余 5 条沿用第 1 轮结论。');
    expect(card(passing({ carriedNote: '本轮只改了提示文字，不影响它们' })).carriedText).toBe('其余 5 条沿用第 1 轮结论：本轮只改了提示文字，不影响它们。');
    expect(card(passing({ carriedNote: '本轮只改了提示文字，不影响它们', spotChecked: [2] })).carriedText)
      .toBe('其余 5 条沿用第 1 轮结论：本轮只改了提示文字，不影响它们；抽查了第 2 条，仍然符合。');
    expect(card(passing({ spotChecked: [2, 4] })).carriedText).toBe('其余 5 条沿用第 1 轮结论；抽查了第 2、4 条，仍然符合。');
    expect(card(passing(), null).carriedText).toBe('其余 5 条沿用上一轮结论。');
    // 抽查的条目如果被重新写了结论（不再是沿用），不算抽查。
    const overridden = passing({ spotChecked: [3] });
    expect(card(overridden).carriedText).toBe('其余 5 条沿用第 1 轮结论。');
  });

  it('总管自己核对时核对人写「总管」；找不到名字写「评审员」', () => {
    expect(buildReviewCard({ ...base, review: { ...failing(), reviewerId: CHIEF } }).reviewerName).toBe('总管');
    expect(buildReviewCard({ ...base, names: {}, review: failing() }).reviewerName).toBe('评审员');
  });

  it('不通过的卡片里沿用的条目标「沿用」，不符的条目仍然列出', () => {
    const review = passing({ items: passing().items.map(item => item.no === 3 ? { ...item, verdict: 'unmet' as const, note: '还是不对', fixTo: '改成一致' } : item) });
    const view = buildReviewCard({ ...base, submission: sample({ round: 2 }), review, previousRound: 1 });
    expect(view.title).toBe('第 2 轮　不通过：1 条不符');
    expect(view.items).toHaveLength(6);
    expect(view.items.filter(item => item.verdict.label === '沿用')).toHaveLength(5);
    expect(view.carriedText).toBe('其余 5 条沿用第 1 轮结论。');
  });
});

describe('17 读存储的一层：主题线程里的视图与折叠组标题（真实流程）', () => {
  /** 走到「第 1 轮核对退回第 3 条」。 */
  async function afterReturn() {
    const s = await started();
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
    const result = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '没有失败提示', fixTo: '失败时显示「加载失败」' }] });
    expect(result).toMatchObject({ ok: true });
    return s;
  }

  it('主题线程的卡片消息带 jobCard，能通过导出的 zod 结构校验；非卡片消息不带这个字段', async () => {
    const { fix, job } = await afterReturn();
    const view = fix.hub.api.thread(job.topicId);
    const cards = view.messages.filter(row => row.kind === 'job_card');
    expect(cards).toHaveLength(2);
    for (const row of cards) {
      expect(row.jobCard, row.text).not.toBeNull();
      expect(() => JobCardViewSchema.parse(row.jobCard), row.text).not.toThrow();
    }
    expect(cards[0]!.jobCard).toMatchObject({ kind: 'submission', title: '会员定价页　第 1 轮', stateText: '按约定第 1 版　自查 3 条' });
    expect(cards[1]!.jobCard).toMatchObject({ kind: 'review', title: '第 1 轮　不通过：1 条不符', roundText: '剩余 2 轮', reviewerName: '评审甲' });
    expect(view.messages.filter(row => row.kind !== 'job_card').every(row => !('jobCard' in row))).toBe(true);
  });

  it('cardTitleOf：交回卡写「{执行者}交回第 n 轮」，核对卡取卡片标题；折叠组「最近一句」据此显示', async () => {
    const { fix, job } = await afterReturn();
    const titleOf = cardTitleFor(fix.ctx);
    const topic = threadOf(fix.ctx, job.topicId);
    const submissionCard = topic.find(row => row.kind === 'job_card' && row.refId?.startsWith('submission:'))!;
    const reviewCard = topic.find(row => row.kind === 'job_card' && row.refId?.startsWith('review:'))!;
    expect(titleOf(submissionCard)).toBe('林舟交回第 1 轮');
    expect(titleOf(reviewCard)).toBe('第 1 轮　不通过：1 条不符');
    expect(titleOf({ ...submissionCard, refId: 'submission:jsb_0000000099' })).toBe('交回卡');
    expect(titleOf({ ...reviewCard, refId: 'review:jrv_0000000099' })).toBe('核对卡');
    expect(titleOf({ ...reviewCard, refId: null })).toBe('');
    // 折叠组到卡片为止时，最近一句就是卡片标题。
    const upToSubmission = topic.slice(0, topic.indexOf(submissionCard) + 1);
    const floors = topicFloorsView({ messages: upToSubmission, names: { [fix.engineer.id]: '林舟' }, events: {}, commitSenders: {}, chiefId: fix.chief.id,
      timezone: 'Asia/Shanghai', cardTitleOf: titleOf });
    const fold = floors.items.find(item => item.kind === 'fold');
    expect(fold).toMatchObject({ kind: 'fold', latest: '林舟交回第 1 轮' });
    // 真实的楼层视图里卡片也算在往来里（收起）。
    const real = fix.hub.api.thread(job.topicId).floors!;
    expect(real.items.some(item => item.kind === 'fold' && item.messages.some(entry => entry.message.kind === 'job_card'))).toBe(true);
  });

  it('jobCardView：找不到记录、refId 为空、不认识的前缀都返回 null', async () => {
    const { fix, job } = await afterReturn();
    expect(jobCardView(fix.ctx, null)).toBeNull();
    expect(jobCardView(fix.ctx, 'submission:jsb_0000000099')).toBeNull();
    expect(jobCardView(fix.ctx, 'review:jrv_0000000099')).toBeNull();
    expect(jobCardView(fix.ctx, 'delivery:x')).toBeNull();
    const submission = fix.ctx.store.table('jobSubmissions').list()[0]!;
    expect(jobCardView(fix.ctx, `submission:${submission.id}`)).toMatchObject({ kind: 'submission' });
    expect(theJob(fix).id).toBe(job.id);
  });

  it('第 2 轮通过的核对卡：沿用的结论来自第 1 轮（previousRound 取上一次核对的轮次）', async () => {
    const { fix, job } = await afterReturn();
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId: job.id, changeNote: '补了提示', deliverables: ['交付/报价页.html'],
      items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'image', path: '证据/桌面.png', summary: '断开接口后的页面' }] }] });
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: job.id,
      items: [{ no: 3, verdict: 'met', note: '提示一致' }], spotChecked: [2], carriedNote: '只改了提示文字' });
    expect(result).toMatchObject({ ok: true });
    // P74f：核对通过之后中心紧接着落交付卡，所以最后一张卡变成了交付卡；这里改为取最后一张核对卡。
    const view = fix.hub.api.thread(job.topicId).messages.filter(row => row.kind === 'job_card' && row.jobCard?.kind === 'review').at(-1)!.jobCard!;
    expect(view).toMatchObject({ kind: 'review', title: '第 2 轮　通过：3 条均符合', stateText: '已通过', roundText: null,
      carriedText: '其余 2 条沿用第 1 轮结论：只改了提示文字；抽查了第 2 条，仍然符合。' });
    expect(view.kind === 'review' && view.items.map(item => item.no)).toEqual([3]);
  });
});

describe('18 给主人看的卡片文字不含内部名称', () => {
  it('卡片视图序列化后不含工具名、员工编号、各种内部编号', async () => {
    const s = await started();
    await engineerSubmits(s.fix, s.info);
    const cards = s.fix.hub.api.thread(s.job.topicId).messages.filter(row => row.kind === 'job_card');
    expect(cards.length).toBeGreaterThan(0);
    // 两个编号字段（evidenceJobId、evidenceSubmissionId）是给界面读取截图用的数据，不进任何给主人看的文字，检查时先去掉。
    const ownerText = (view: unknown) => JSON.stringify({ ...(view as object), evidenceJobId: undefined, evidenceSubmissionId: undefined });
    for (const row of cards) expect(ownerText(row.jobCard), row.text).not.toMatch(INTERNAL);
    const sampleView = JSON.stringify([buildSubmissionCard({ submission: sample(), agreementTitle: '活动报名页' }),
      buildReviewCard({ review: failing(), submission: sample(), previousRound: null, names: { [REVIEWER]: '评审员' }, chiefId: CHIEF })]
      .map(view => JSON.parse(ownerText(view))));
    expect(sampleView).not.toMatch(INTERNAL);
  });
});
