/**
 * P74g 给界面卡二补的两处视图数据的测试：
 * 1. 工作往来折叠组里，交回卡、核对卡也带接收者名字（评审员核对、总管自己核对各一条）；
 * 2. 交回卡、核对卡、交付卡的视图带着读取截图要用的两个编号，用视图里的编号调用读取截图命令能读到图。
 * 走真实 Hub（评审员核对 / 总管自己核对），只读视图，不改任何行为。
 */
import { describe, expect, it } from 'vitest';
import { delivered, theJob } from './p74f-fixtures.js';
import type { JobFix } from './p74f-fixtures.js';

/** 折叠组里全部卡片消息的「标题 -> 接收者」。 */
function foldedCards(fix: JobFix, topicId: string): Array<{ kind: 'submission' | 'review'; fromName: string; toNames: string[] }> {
  const view = fix.hub.api.thread(topicId);
  const rows: Array<{ kind: 'submission' | 'review'; fromName: string; toNames: string[] }> = [];
  for (const item of view.floors!.items) {
    if (item.kind !== 'fold') continue;
    for (const folded of item.messages) {
      const ref = folded.message.refId ?? '';
      if (folded.message.kind === 'job_card' && (ref.startsWith('submission:') || ref.startsWith('review:'))) {
        rows.push({ kind: ref.startsWith('submission:') ? 'submission' : 'review', fromName: folded.fromName, toNames: folded.toNames });
      }
    }
  }
  return rows;
}

describe('折叠组里卡片消息的接收者', () => {
  it('评审员核对：交回卡发给「评审甲、总管」，核对卡发给「林舟、总管」', async () => {
    const { fix, job } = await delivered();
    const cards = foldedCards(fix, job.topicId);
    expect(cards.find(row => row.kind === 'submission')).toEqual({ kind: 'submission', fromName: '林舟', toNames: ['评审甲', '总管'] });
    expect(cards.find(row => row.kind === 'review')).toMatchObject({ kind: 'review', toNames: ['林舟', '总管'] });
  });

  it('总管自己核对：交回卡只发给「总管」，核对卡只发给「林舟」', async () => {
    const { fix, job } = await delivered([], { reviewer: '总管' });
    const cards = foldedCards(fix, job.topicId);
    expect(cards.find(row => row.kind === 'submission')!.toNames).toEqual(['总管']);
    expect(cards.find(row => row.kind === 'review')!.toNames).toEqual(['林舟']);
  });
});

describe('卡片视图带着读取截图的两个编号', () => {
  it('交回卡、核对卡、交付卡：evidenceJobId 是这件事、evidenceSubmissionId 是证据所属的那次交回；用它们调用读取截图命令能读到图', async () => {
    const { fix, job } = await delivered();
    const submission = fix.ctx.store.table('jobSubmissions').list(row => row.jobId === job.id).at(-1)!;
    const review = fix.ctx.store.table('jobReviews').list(row => row.jobId === job.id).at(-1)!;
    expect(review.submissionId).toBe(submission.id);
    const views = fix.hub.api.thread(job.topicId).messages.flatMap(row => row.jobCard ? [row.jobCard] : []);
    const kinds = ['submission', 'review', 'delivery'] as const;
    for (const kind of kinds) {
      const view = views.find(row => row.kind === kind);
      expect(view, kind).toBeDefined();
      if (view === undefined || view.kind === 'escalation' || view.kind === 'receipt' || view.kind === 'retro' || view.kind === 'skill_check') continue;
      expect(view.evidenceJobId, kind).toBe(theJob(fix).id);
      expect(view.evidenceSubmissionId, kind).toBe(submission.id);
      // 用视图里的编号读第一张截图。
      const image = view.items.flatMap(item => item.evidence).find(entry => entry.kind === 'image');
      expect(image, kind).toBeDefined();
      const result = await fix.hub.api.readJobEvidence({ jobId: view.evidenceJobId, submissionId: view.evidenceSubmissionId, evidenceId: image!.id });
      expect(result, kind).toMatchObject({ ok: true, data: { mime: 'image/png' } });
    }
  });
});
