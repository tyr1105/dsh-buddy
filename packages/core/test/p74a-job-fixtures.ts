/**
 * P74a 测试的公共样例（不是测试文件）：一件事、一次交回、一次核对、一条事件、一条审批补充。
 * 为什么集中放这里：模型、状态机、视图三组测试都要造合法样例，再按字段破坏它去验证边界。
 * 每次调用都返回新对象，测试可放心修改。
 */
import type { ApprovalNote, Evidence, Job, JobEvent, JobReview, JobSubmission } from '../src/model/job.js';

export const CHIEF = 'b_0000000001';
export const EXECUTOR = 'b_0000000002';
export const REVIEWER = 'b_0000000003';
export const NOW = Date.parse('2026-11-12T02:00:00Z'); // 上海时间 2026-11-12 10:00

/** 一件事：默认「执行中」，评审员核对，没有发布步骤。 */
export function jobFixture(patch: Partial<Job> = {}): Job {
  return {
    id: 'job_0000000001', chiefId: CHIEF, agreementId: 'agr_0000000001', projectId: 'prj_0000000001', topicId: 'ptp_0000000001',
    folder: 'jobs/job_0000000001', state: 'doing', executorId: EXECUTOR, reviewerId: REVIEWER, dueAt: null, deliveryItems: [],
    launchStep: false, stage: 1, round: 0, blocked: null, pause: null, openAsk: null, unmet: [], turnsUsed: 0, turnCap: 16,
    launch: { state: 'none', approvalId: null, link: null }, inboxId: null, firstLockedAt: NOW - 3_600_000,
    assignedAt: NOW - 3_000_000, startedAt: NOW - 2_000_000, deliveredAt: null, acceptedAt: null, stoppedAt: null,
    createdAt: NOW - 3_000_000, updatedAt: NOW - 1_000_000, ...patch,
  };
}

export function evidenceFixture(patch: Partial<Evidence> = {}): Evidence {
  return { id: 'ev1', kind: 'file', path: '交付/报价页.html', url: null, summary: '报价页文件', command: null,
    check: { status: 'ok', detail: '文件存在' }, ...patch };
}

export function submissionFixture(patch: Partial<JobSubmission> = {}): JobSubmission {
  return {
    id: 'jsb_0000000001', jobId: 'job_0000000001', stage: 1, round: 1, executorId: EXECUTOR, versionNo: 1,
    changeNote: '先做了报价列表和刷新按钮',
    items: [
      { no: 1, text: '打开页面能看到今天的报价', selfCheck: 'met', note: null, evidence: [evidenceFixture()] },
      { no: 2, text: '点刷新后数据更新', selfCheck: 'at_delivery', note: '交付时再核对', evidence: [] },
    ],
    deliverables: ['交付/报价页.html'], preview: '交付/报价页.html', createdAt: NOW, ...patch,
  };
}

export function reviewFixture(patch: Partial<JobReview> = {}): JobReview {
  return {
    id: 'jrv_0000000001', jobId: 'job_0000000001', stage: 1, round: 1, submissionId: 'jsb_0000000001', reviewerId: REVIEWER,
    items: [
      { no: 1, verdict: 'met', note: null, fixTo: null, rechecked: true },
      { no: 2, verdict: 'unmet', note: '刷新后数据没变', fixTo: '点刷新后列表时间更新', rechecked: true },
    ],
    carriedNote: null, spotChecked: [], createdAt: NOW, ...patch,
  };
}

export function eventFixture(patch: Partial<JobEvent> = {}): JobEvent {
  return { id: 'jev_0000000001', jobId: 'job_0000000001', at: NOW, actor: CHIEF, kind: 'assigned', to: [EXECUTOR], refId: null,
    data: { executorId: EXECUTOR }, ...patch };
}

export function approvalNoteFixture(patch: Partial<ApprovalNote> = {}): ApprovalNote {
  return { id: 'ap_0000000001', cost: '不花钱', undo: '可以撤回', after: '任何人拿到链接都能报名', createdAt: NOW, ...patch };
}
