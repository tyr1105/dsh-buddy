/**
 * P74r8 的测试：核心给界面的三处事实。
 * 一、「待你处理」里约定确认条目带 agreementJobSplit（有事在做）、agreementStop（确认后停止），与约定卡视图同一个来源；
 * 二、交付卡带结构化的 phase，与 stateText 对应；失效的卡没有预览和验收；
 * 三、重新交付之后「待你处理」里的验收条目是新的一条、正文是新的（把现状固定下来的测试）。
 * 时间全部用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { buildDeliveryCard } from '../src/api/job-delivery-views.js';
import { DeliveryCardViewSchema } from '../src/api/job-view-schemas.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { chiefDrafts, speak } from './p74b-fixtures.js';
import { jobFix } from './p74d-fixtures.js';
import { delivered, deliveredWith, openItems, ownerTypes, chiefTurn, bot, callTool, theJob, type JobFix } from './p74f-fixtures.js';
import { started, stopRevise } from './p74f2-fixtures.js';
import { idsIn, pendingReopen, reviseArgs } from './p74r2b-fixtures.js';

/** 「待你处理」里某一版约定的确认条目（视图里的那一项）。 */
const agreementItem = (fix: JobFix, agreementId: string, version: number) =>
  fix.hub.api.inbox().items.find(row => row.agreementId === agreementId && row.agreementVersion === version)!;

/** 同一版约定的约定卡视图。 */
function cardOf(fix: JobFix, agreementId: string, version: number) {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  return agreementCardView(fix.ctx, agreement, agreement.versions.find(row => row.no === version)!);
}

describe('1 约定确认条目带 agreementJobSplit、agreementStop', () => {
  it('没有事在做（第 1 版初稿）：两项都为假，与约定卡视图一致', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页', doneWhen: ['甲', '乙', '丙'] });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    const item = agreementItem(fix, agreementId, 1);
    expect(item).toMatchObject({ agreementJobSplit: false, agreementStop: false });
    const card = cardOf(fix, agreementId, 1);
    expect(card.jobSplit).toBeNull();
    expect(card.stopLine).toBeNull();
  });

  it('有事在做的修改（两栏）：agreementJobSplit 为真、agreementStop 为假，与约定卡的 jobSplit 一致', async () => {
    const { fix, agreementId } = await pendingReopen();
    const item = agreementItem(fix, agreementId, 2);
    expect(item).toMatchObject({ agreementJobSplit: true, agreementStop: false });
    const card = cardOf(fix, agreementId, 2);
    expect(card.jobSplit).not.toBeNull();
    expect(card.stopLine).toBeNull();
    expect(item.agreementJobSplit).toBe(card.jobSplit !== null);
    expect(item.agreementStop).toBe(card.stopLine !== null);
  });

  it('带停止标记的版本：agreementStop 为真、agreementJobSplit 为假，与约定卡的 stopLine 一致', async () => {
    const { fix } = await started();
    const agreementId = await stopRevise(fix);
    const item = agreementItem(fix, agreementId, 2);
    expect(item).toMatchObject({ agreementJobSplit: false, agreementStop: true });
    const card = cardOf(fix, agreementId, 2);
    expect(card.jobSplit).toBeNull();
    expect(card.stopLine).not.toBeNull();
    expect(item.agreementJobSplit).toBe(card.jobSplit !== null);
    expect(item.agreementStop).toBe(card.stopLine !== null);
  });

  it('不是约定确认条目的不带这两个字段', async () => {
    const { fix } = await delivered();
    const accept = fix.hub.api.inbox().items.find(row => row.jobEntry?.kind === 'accept')!;
    expect(accept).toBeDefined();
    expect('agreementJobSplit' in accept).toBe(false);
    expect('agreementStop' in accept).toBe(false);
  });
});

describe('2 交付卡的 phase', () => {
  const sub = { id: 'jsb_0000000010', jobId: 'job_aaaaaaaaaa', stage: 1, round: 1, executorId: 'b_0000000002', versionNo: 1, changeNote: '改',
    items: ['甲', '乙'].map((text, i) => ({ no: i + 1, text, selfCheck: 'met' as const, note: null, evidence: [] })), deliverables: ['交付/a.html'], preview: null, createdAt: 1 };
  const review = { id: 'jrv_0000000010', jobId: 'job_aaaaaaaaaa', stage: 1, round: 1, submissionId: 'jsb_0000000010', reviewerId: 'b_0000000003', carriedNote: null,
    spotChecked: [], createdAt: 1, items: [1, 2].map(no => ({ no, verdict: 'met' as const, note: null, fixTo: null, rechecked: false })) };
  const base = { jobId: 'job_aaaaaaaaaa', stage: 1, jobState: 'awaiting_owner' as const, currentStage: 1, agreementTitle: '页', versionNo: 1,
    reviews: [review], submissions: [sub], checks: [], deliveredAt: Date.parse('2026-11-12T02:00:00Z'), acceptedAt: null, ownerReturn: null,
    pendingVersionNo: null, hasPreview: true, timezone: 'Asia/Shanghai' };
  const owner = { stage: 1, items: [{ no: 2, text: '乙', problem: '没做', fixTo: '要做' }], at: 1 } as never;

  it('awaiting：待你验收且可验收，预览保留', () => {
    const card = buildDeliveryCard(base);
    expect(DeliveryCardViewSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ phase: 'awaiting', stateText: '待你验收', actions: { accept: true, preview: true } });
  });

  it('waiting_agreement：文字仍是待你验收，但暂不可验收', () => {
    expect(buildDeliveryCard({ ...base, pendingVersionNo: 2 })).toMatchObject({ phase: 'waiting_agreement', stateText: '待你验收', actions: { accept: false } });
  });

  it('accepted：已完成，预览保留', () => {
    const card = buildDeliveryCard({ ...base, jobState: 'done', acceptedAt: Date.parse('2026-11-12T03:30:00Z') });
    expect(card).toMatchObject({ phase: 'accepted', actions: { accept: false, preview: true } });
    expect(card.stateText.startsWith('已完成')).toBe(true);
  });

  it('returned：未通过，不可验收', () => {
    const card = buildDeliveryCard({ ...base, jobState: 'rework', currentStage: 2, ownerReturn: owner });
    expect(card).toMatchObject({ phase: 'returned', stateText: '未通过：第 2 条', actions: { accept: false } });
  });

  it('void（三种原因）：已失效，预览和验收都为假，即使这张卡有预览', () => {
    const reissued = buildDeliveryCard({ ...base, revision: 0, latestRevision: 1 });
    const stopped = buildDeliveryCard({ ...base, jobState: 'stopped' });
    const updated = buildDeliveryCard({ ...base, jobState: 'rework', currentStage: 2 });
    expect(reissued).toMatchObject({ phase: 'void', stateText: '已失效：已重新交付' });
    expect(stopped).toMatchObject({ phase: 'void', stateText: '已失效：这件事已停止' });
    expect(updated).toMatchObject({ phase: 'void', stateText: '已失效：约定已更新' });
    for (const card of [reissued, stopped, updated]) expect(card.actions).toMatchObject({ accept: false, preview: false });
  });
});

/** 已交付、等验收时主人提出要改，总管出了第 2 版请主人确认（与 p74f-awaiting 同一做法）。 */
async function pendingAfterDelivery(extra: Record<string, unknown>, four: boolean) {
  const { fix, job } = four ? await deliveredWith(['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '能导出表格']) : await delivered();
  await ownerTypes(fix, job.topicId, '文案里要求暗色模式，和约定不一样');
  const packet = await chiefTurn(fix);
  const ids = idsIn(packet);
  expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra))).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '这和已定的第 1 版冲突，请你确认。', { outcome: 'needs_owner' });
  return { fix, job, agreementId: ids.agreementId };
}
/** 这件事这个阶段的全部验收条目（含已撤回的），按创建先后。 */
const acceptRows = (fix: JobFix, jobId: string) =>
  fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${jobId}:accept:1`).sort((a, b) => a.createdAt - b.createdAt);

describe('3 重新交付之后「待你处理」里的验收条目是新的', () => {
  it('约定没有变、中心重新交付：旧条目已撤回，新条目是另一条，正文是新的，指向同一张交付卡（修订号 0）', async () => {
    const { fix, job, agreementId } = await pendingAfterDelivery({}, false);
    const before = acceptRows(fix, job.id);
    expect(before).toHaveLength(1);
    const oldId = before[0]!.id;
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const rows = acceptRows(fix, job.id);
    expect(rows.map(row => row.status)).toEqual(['withdrawn', 'open']);
    const fresh = openItems(fix, job.id).filter(row => row.subjectKey.includes(':accept:'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(oldId);
    expect(theJob(fix).inboxId).toBe(fresh[0]!.id);
    const view = fix.hub.api.inbox().items.filter(row => row.jobEntry?.kind === 'accept');
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: fresh[0]!.id, jobEntry: { kind: 'accept', jobId: job.id }, body: expect.stringContaining('3 条「怎样算做完」全部符合') });
    expect(theJob(fix).delivery?.rev ?? 0).toBe(0);
  });

  it('只删去一条、重排后重新交付：新条目的正文按新条数（4 条变 3 条），交付修订号加 1，累计多一条是重新交付算新的一次', async () => {
    const { fix, job, agreementId } = await pendingAfterDelivery({ doneWhen: ['打开页面能看到今天的报价', '接口失败时有提示', '能导出表格'], removals: ['点刷新后数据更新'] }, true);
    const oldRow = acceptRows(fix, job.id)[0]!;
    expect(oldRow.body).toContain('4 条');
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const rows = acceptRows(fix, job.id);
    expect(rows.map(row => row.status)).toEqual(['withdrawn', 'open']);
    const view = fix.hub.api.inbox().items.filter(row => row.jobEntry?.kind === 'accept');
    expect(view).toHaveLength(1);
    expect(view[0]!.id).not.toBe(oldRow.id);
    expect(view[0]!.body).toContain('3 条「怎样算做完」全部符合');
    expect(view[0]!.body).not.toContain('4 条');
    expect(theJob(fix).delivery?.rev).toBe(1);
    expect(theJob(fix).inboxId).toBe(view[0]!.id);
  });
});
