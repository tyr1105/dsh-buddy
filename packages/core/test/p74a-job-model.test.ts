/**
 * P74a 模型与存储验收：一件事及其交回、核对、事件、审批补充的校验；
 * 旧存档兼容与重启读回；队列与唤醒单带 jobId；两种新线程消息类型与两个新拦截原因；旧事务状态词。
 * 全程不调用模型，时间用假时钟。
 */
import { describe, expect, it } from 'vitest';
import { parseWithPaths } from '../src/model/agreement.js';
import {
  ApprovalNoteSchema, EvidenceSchema, JOB_BLOCK_LABELS, JOB_EVENT_KINDS, JOB_STATE_LABELS, JOB_STATE_TONES, ALIGNING_LABEL,
  JobEventSchema, JobReviewSchema, JobSchema, JobSubmissionSchema, jobBlockLabel,
} from '../src/model/job.js';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { SUPPRESSION_REASON_LABELS, THREAD_KINDS } from '../src/model/enums.js';
import { TASK_STATUS_LABELS } from '../src/model/project.js';
import { FileStore, MemoryStore } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { createTicket } from '../src/wake/ticket.js';
import { explainSuppression } from '../src/appraisal/log.js';
import { activeJobsOf, appendJobEvent, eventsOf, jobOfAgreement, jobsOfChief, latestSubmission, reviewsOf } from '../src/job/store.js';
import { botFixture } from './model-fixtures.js';
import {
  CHIEF, EXECUTOR, NOW, REVIEWER, approvalNoteFixture, evidenceFixture, eventFixture, jobFixture, reviewFixture, submissionFixture,
} from './p74a-job-fixtures.js';

/** 校验失败时取出中文错误全文。 */
function errorOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as Error).message; }
  throw new Error('应当抛错但没有抛');
}
const parseJob = (value: unknown) => parseWithPaths(JobSchema, value, '一件事');

describe('默认值与标签', () => {
  it('回合上限按主会话裁定为 16，追加 8；核对每阶段 3 轮', () => {
    expect(JOB_DEFAULTS.TURN_CAP).toBe(16);
    // P76f：TURN_TOP_UP 删除（追加回合数由预计消耗条目的选项给出）。
    expect('TURN_TOP_UP' in JOB_DEFAULTS).toBe(false);
    expect(JOB_DEFAULTS.REVIEW_ROUNDS_MAX).toBe(3);
    // P76g：原来的兜底（30 分钟、两次）整段删除，IDLE_RESUME_MS、IDLE_RESUME_MAX 不再存在；改由 BUDGET_DEFAULTS.STALL_IDLE_MS（2 小时）等判断。
    expect('IDLE_RESUME_MS' in JOB_DEFAULTS).toBe(false);
    expect('IDLE_RESUME_MAX' in JOB_DEFAULTS).toBe(false);
    expect(JOB_DEFAULTS.IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(JOB_DEFAULTS.FOLDER_FILES).toEqual({ agreement: '约定.md', words: '原话.md', sketch: '草图.md', materials: '材料', delivery: '交付', evidence: '证据' });
  });
  it('状态词、颜色、受阻原因、事件种类', () => {
    expect(JOB_STATE_LABELS).toEqual({ ready: '待开工', doing: '执行中', checking: '核对中', rework: '返工中',
      awaiting_owner: '待你验收', blocked: '受阻', done: '已完成', stopped: '已停止' });
    expect(ALIGNING_LABEL).toBe('对齐中');
    expect(JOB_STATE_TONES).toEqual({ ready: 'run', doing: 'run', checking: 'run', rework: 'run', awaiting_owner: 'you', blocked: 'you', done: 'ok', stopped: 'ok' });
    expect(JOB_BLOCK_LABELS.review_limit).toBe('核对三轮未通过');
    expect(jobBlockLabel('executor', '林舟')).toBe('林舟无法继续');
    expect(jobBlockLabel('participant_off', '评审员')).toBe('评审员已停用');
    expect(jobBlockLabel('turn_cap', null)).toBe('回合用到上限');
    expect(JOB_EVENT_KINDS).toHaveLength(24); // P74r18b 同步：新增 launch_failed（23 改 24）
  });
  it('旧事务状态词只改显示文字', () => {
    expect(TASK_STATUS_LABELS).toEqual({ todo: '待开工', doing: '执行中', blocked: '受阻', done_pending_check: '待你验收', accepted: '已完成', rejected: '返工中' });
  });
  it('线程消息新增 work、job_card；拦截原因新增 job_cap、job_inactive 且各有解释', () => {
    expect(THREAD_KINDS.slice(-2)).toEqual(['work', 'job_card']);
    expect(SUPPRESSION_REASON_LABELS.job_cap).toBeTruthy();
    expect(SUPPRESSION_REASON_LABELS.job_inactive).toBeTruthy();
    const ctx = createTestContext();
    const entry = { ...buildCandidate((ctx.store.table('bots').put(botFixture), ctx), { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '测试' }), id: 'q_0000000001', enqueuedAt: NOW };
    expect(explainSuppression(entry, 'job_cap', null, NOW, 'Asia/Shanghai')).toContain('这件事的回合用到上限，移出队列');
    expect(explainSuppression(entry, 'job_inactive', null, NOW, 'Asia/Shanghai')).toContain('这件事已不需要这次唤醒，移出队列');
  });
});

describe('一件事 JobSchema', () => {
  it('合法例：八个状态各一例（受阻带原因）', () => {
    for (const state of ['ready', 'doing', 'checking', 'rework', 'awaiting_owner', 'done', 'stopped'] as const) {
      expect(parseJob(jobFixture({ state })).state).toBe(state);
    }
    const blocked = { kind: 'review_limit', no: 2, text: '第 2 条三轮没过', since: NOW, resumeTo: 'rework' } as const;
    expect(parseJob(jobFixture({ state: 'blocked', blocked })).blocked).toEqual(blocked);
    expect(parseJob(jobFixture({ reviewerId: null })).reviewerId).toBeNull(); // 总管自己核对
  });
  it('非法：blocked 与状态不一致，两个方向都要拒绝，并带字段路径', () => {
    const blocked = { kind: 'executor', no: null, text: '做不下去', since: NOW, resumeTo: 'doing' } as const;
    expect(errorOf(() => parseJob(jobFixture({ state: 'blocked' })))).toMatch(/blocked：受阻状态必须写明受阻原因/);
    expect(errorOf(() => parseJob(jobFixture({ state: 'doing', blocked })))).toMatch(/blocked：只有受阻状态才能有受阻原因/);
  });
  it('非法：核对人等于执行者', () => {
    expect(errorOf(() => parseJob(jobFixture({ reviewerId: EXECUTOR })))).toMatch(/reviewerId：核对人不能是执行者本人/);
  });
  it('非法：round 越界（超过上限、负数）', () => {
    expect(errorOf(() => parseJob(jobFixture({ round: 4 })))).toMatch(/round：核对轮数必须在 0 到 3 之间/);
    expect(errorOf(() => parseJob(jobFixture({ round: -1 })))).toMatch(/round/);
    expect(parseJob(jobFixture({ round: 3 })).round).toBe(3);
  });
  it('非法：交付条目重复或不是正整数；stage 从 1 起；未知字段被拒绝', () => {
    expect(errorOf(() => parseJob(jobFixture({ deliveryItems: [2, 2] })))).toMatch(/deliveryItems：交付时核对的条目序号不能重复/);
    expect(errorOf(() => parseJob(jobFixture({ deliveryItems: [0] })))).toMatch(/deliveryItems\[0\]/);
    expect(errorOf(() => parseJob(jobFixture({ stage: 0 })))).toMatch(/stage/);
    expect(errorOf(() => parseJob({ ...jobFixture(), extra: 1 }))).toMatch(/不支持字段 extra/);
  });
  it('非法：id 前缀、字数超限（受阻说明、返工条目、暂停条目）', () => {
    expect(errorOf(() => parseJob(jobFixture({ id: 'x_0000000001' })))).toMatch(/id/);
    const long = '字'.repeat(JOB_DEFAULTS.NOTE_MAX_CHARS + 1);
    expect(errorOf(() => parseJob(jobFixture({ state: 'blocked', blocked: { kind: 'executor', no: null, text: long, since: NOW, resumeTo: 'doing' } }))))
      .toMatch(/blocked\.text：不能超过 200 字/);
    expect(errorOf(() => parseJob(jobFixture({ unmet: [{ no: 1, problem: long, fixTo: '改好' }] })))).toMatch(/unmet\[0\]\.problem：不能超过 200 字/);
    expect(errorOf(() => parseJob(jobFixture({ pause: { versionNo: 2, continuing: [], paused: ['字'.repeat(101)], fallback: null } }))))
      .toMatch(/pause\.paused\[0\]：不能超过 100 字/);
    // 恰好等于上限的合法
    expect(parseJob(jobFixture({ unmet: [{ no: 1, problem: '字'.repeat(200), fixTo: '改好' }] })).unmet).toHaveLength(1);
  });
});

describe('交回与核对', () => {
  it('合法例', () => {
    expect(parseWithPaths(JobSubmissionSchema, submissionFixture(), '交回').items).toHaveLength(2);
    expect(parseWithPaths(JobReviewSchema, reviewFixture(), '核对').items).toHaveLength(2);
    expect(parseWithPaths(EvidenceSchema, evidenceFixture({ kind: 'link', path: null, url: 'https://example.com' }), '证据').url).toBe('https://example.com');
    expect(parseWithPaths(EvidenceSchema, evidenceFixture({ kind: 'test', path: null, command: 'pnpm test' }), '证据').command).toBe('pnpm test');
  });
  it('交回非法：改动说明超限、条目为空、序号重复、证据超过 4 项、证据编号在一次交回内重复', () => {
    const item = submissionFixture().items[0]!;
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ changeNote: '字'.repeat(201) }), '交回'))).toMatch(/changeNote：不能超过 200 字/);
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ items: [] }), '交回'))).toMatch(/items：至少要有 1 条/);
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ items: [item, { ...item }] }), '交回'))).toMatch(/items\[1\]\.no：条目序号 1 重复/);
    const five = Array.from({ length: 5 }, (_, i) => evidenceFixture({ id: `ev${i + 1}` }));
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ items: [{ ...item, evidence: five }] }), '交回'))).toMatch(/items\[0\]\.evidence：每条最多 4 项证据/);
    const second = { ...submissionFixture().items[1]!, no: 2, evidence: [evidenceFixture({ id: 'ev1' })] };
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ items: [item, second] }), '交回'))).toMatch(/items\[1\]\.evidence\[0\]\.id：证据编号「ev1」在这次交回里重复/);
    expect(errorOf(() => parseWithPaths(JobSubmissionSchema, submissionFixture({ deliverables: Array(21).fill('交付/a.html') }), '交回'))).toMatch(/deliverables：产出物最多 20 条/);
  });
  it('证据非法：编号格式、file 缺路径、link 缺链接、一句话与命令超限、检查状态未知', () => {
    expect(errorOf(() => parseWithPaths(EvidenceSchema, evidenceFixture({ id: 'e1' }), '证据'))).toMatch(/id：证据编号必须是 ev1、ev2/);
    expect(errorOf(() => parseWithPaths(EvidenceSchema, evidenceFixture({ path: null }), '证据'))).toMatch(/path：file 类型的证据必须写明文件路径/);
    expect(errorOf(() => parseWithPaths(EvidenceSchema, evidenceFixture({ kind: 'link', path: null }), '证据'))).toMatch(/url：link 类型的证据必须写明链接/);
    expect(errorOf(() => parseWithPaths(EvidenceSchema, evidenceFixture({ summary: '字'.repeat(121) }), '证据'))).toMatch(/summary：不能超过 120 字/);
    expect(errorOf(() => parseWithPaths(EvidenceSchema, evidenceFixture({ kind: 'test', path: null, command: '字'.repeat(301) }), '证据'))).toMatch(/command：不能超过 300 字/);
    expect(errorOf(() => parseWithPaths(EvidenceSchema, { ...evidenceFixture(), check: { status: 'weird', detail: '' } }, '证据'))).toMatch(/check\.status/);
  });
  it('核对非法：沿用理由超限、序号重复、结论未知', () => {
    expect(errorOf(() => parseWithPaths(JobReviewSchema, reviewFixture({ carriedNote: '字'.repeat(121) }), '核对'))).toMatch(/carriedNote：不能超过 120 字/);
    const item = reviewFixture().items[0]!;
    expect(errorOf(() => parseWithPaths(JobReviewSchema, reviewFixture({ items: [item, { ...item }] }), '核对'))).toMatch(/items\[1\]\.no：条目序号 1 重复/);
    expect(errorOf(() => parseWithPaths(JobReviewSchema, { ...reviewFixture(), items: [{ ...item, verdict: 'maybe' }] }, '核对'))).toMatch(/items\[0\]\.verdict：核对结论必须是/);
  });
});

describe('事件与审批补充', () => {
  it('事件合法例；24 种之外的类型被拒绝；data 超过 2 KB 被拒绝', () => {
    expect(parseWithPaths(JobEventSchema, eventFixture(), '事件').kind).toBe('assigned');
    for (const kind of JOB_EVENT_KINDS) expect(JobEventSchema.safeParse(eventFixture({ kind })).success).toBe(true);
    expect(errorOf(() => parseWithPaths(JobEventSchema, eventFixture({ kind: 'nope' as never }), '事件'))).toMatch(/kind：事件类型不在允许的 24 种之内/);
    expect(errorOf(() => parseWithPaths(JobEventSchema, eventFixture({ data: { text: 'x'.repeat(2100) } }), '事件'))).toMatch(/data：事件附带内容太长/);
    expect(JobEventSchema.safeParse(eventFixture({ data: { text: '字'.repeat(600) } })).success).toBe(true); // 1800 字节，在上限内
    expect(JobEventSchema.safeParse(eventFixture({ data: { text: '字'.repeat(700) } })).success).toBe(false); // 2100 字节，超限（中文按 UTF-8 计）
  });
  it('审批补充：合法、三行可为空、超限被拒绝、键必须是审批单 id', () => {
    expect(parseWithPaths(ApprovalNoteSchema, approvalNoteFixture(), '补充').cost).toBe('不花钱');
    expect(ApprovalNoteSchema.safeParse(approvalNoteFixture({ cost: null, undo: null, after: null })).success).toBe(true);
    expect(errorOf(() => parseWithPaths(ApprovalNoteSchema, approvalNoteFixture({ after: '字'.repeat(81) }), '补充'))).toMatch(/after：不能超过 80 字/);
    expect(errorOf(() => parseWithPaths(ApprovalNoteSchema, approvalNoteFixture({ id: 'job_0000000001' }), '补充'))).toMatch(/id/);
  });
});

describe('存储：新表与日志、旧存档、重启读回', () => {
  const ROOT = '/hub-fixture';
  const fileStore = (fs: MemoryFs) => new FileStore(fs, new FakeClock(NOW), ROOT, 'Asia/Shanghai', new MemoryLogger());

  it('旧存档（没有四张新表和新日志的文件）启动后可读，四张表和日志为空', async () => {
    const fs = new MemoryFs(new FakeClock(NOW));
    const first = fileStore(fs);
    await first.load();
    first.table('rules').put({ id: 'ru_old', text: '先核验证据', scope: 'global', redLine: false, source: 'owner', status: 'active', createdAt: NOW });
    await first.flush();
    // 确认旧存档里确实没有新文件
    for (const name of ['jobs', 'jobSubmissions', 'jobReviews', 'approvalNotes']) {
      expect(await fs.readText(`${ROOT}/.hub/state/${name}.json`)).toBeNull();
    }
    const second = fileStore(fs);
    await second.load();
    expect(second.table('rules').count()).toBe(1);
    for (const name of ['jobs', 'jobSubmissions', 'jobReviews', 'approvalNotes'] as const) expect(second.table(name).count()).toBe(0);
    expect(second.log('jobEvents').all()).toEqual([]);
  });

  it('写入后重启可读回（四张表和事件日志）', async () => {
    const fs = new MemoryFs(new FakeClock(NOW));
    const first = fileStore(fs);
    await first.load();
    first.table('jobs').put(jobFixture());
    first.table('jobSubmissions').put(submissionFixture());
    first.table('jobReviews').put(reviewFixture());
    first.table('approvalNotes').put(approvalNoteFixture());
    first.log('jobEvents').append(eventFixture());
    await first.flush();
    const second = fileStore(fs);
    await second.load();
    expect(second.table('jobs').get('job_0000000001')).toEqual(jobFixture());
    expect(second.table('jobSubmissions').get('jsb_0000000001')).toEqual(submissionFixture());
    expect(second.table('jobReviews').get('jrv_0000000001')).toEqual(reviewFixture());
    expect(second.table('approvalNotes').get('ap_0000000001')).toEqual(approvalNoteFixture());
    expect(second.log('jobEvents').all()).toEqual([eventFixture()]);
  });

  it('清理保留期时不会把事件日志丢掉（事件日志有自己的保留期）', async () => {
    const store = new MemoryStore();
    store.log('jobEvents').append(eventFixture());
    await store.prune(NOW + 1000);
    expect(store.log('jobEvents').all()).toHaveLength(1);
  });

  it('查询帮手：按约定找、某员工手上的事、总管名下、最新交回、核对、事件', () => {
    const ctx = createTestContext();
    const jobs = ctx.store.table('jobs');
    jobs.put(jobFixture());
    jobs.put(jobFixture({ id: 'job_0000000002', agreementId: 'agr_0000000002', executorId: 'b_0000000009', reviewerId: null, createdAt: NOW }));
    jobs.put(jobFixture({ id: 'job_0000000003', agreementId: 'agr_0000000003', state: 'done', createdAt: NOW + 1 }));
    expect(jobOfAgreement(ctx, 'agr_0000000001')?.id).toBe('job_0000000001');
    expect(jobOfAgreement(ctx, 'agr_9999999999')).toBeNull();
    // 执行者、评审员都算；已完成的不算；reviewerId 为空时总管本人是核对人
    expect(activeJobsOf(ctx, EXECUTOR).map(row => row.id)).toEqual(['job_0000000001']);
    expect(activeJobsOf(ctx, REVIEWER).map(row => row.id)).toEqual(['job_0000000001']);
    expect(activeJobsOf(ctx, CHIEF).map(row => row.id)).toEqual(['job_0000000002']);
    expect(activeJobsOf(ctx, 'b_0000000009').map(row => row.id)).toEqual(['job_0000000002']);
    expect(jobsOfChief(ctx, CHIEF).map(row => row.id)).toEqual(['job_0000000001', 'job_0000000002', 'job_0000000003']);
    ctx.store.table('jobSubmissions').put(submissionFixture({ createdAt: 10 }));
    ctx.store.table('jobSubmissions').put(submissionFixture({ id: 'jsb_0000000002', round: 2, createdAt: 20 }));
    expect(latestSubmission(ctx, 'job_0000000001')?.id).toBe('jsb_0000000002');
    expect(latestSubmission(ctx, 'job_0000000002')).toBeNull();
    ctx.store.table('jobReviews').put(reviewFixture({ id: 'jrv_0000000002', createdAt: 20 }));
    ctx.store.table('jobReviews').put(reviewFixture({ createdAt: 10 }));
    expect(reviewsOf(ctx, 'job_0000000001').map(row => row.id)).toEqual(['jrv_0000000001', 'jrv_0000000002']);
    const event = appendJobEvent(ctx, { jobId: 'job_0000000001', actor: CHIEF, kind: 'assigned', to: [EXECUTOR], refId: null, data: {} });
    expect(event.id).toMatch(/^jev_[a-z0-9]{10}$/);
    expect(eventsOf(ctx, 'job_0000000001')).toEqual([event]);
    expect(eventsOf(ctx, 'job_0000000002')).toEqual([]);
    // 非法事件在入口就被拒绝，并带中文路径
    expect(errorOf(() => appendJobEvent(ctx, { jobId: 'bad', actor: CHIEF, kind: 'assigned', to: [], refId: null, data: {} }))).toMatch(/事件无效：jobId/);
  });
});

describe('队列与唤醒单带 jobId', () => {
  function setup() { const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active' }); return ctx; }

  it('带 jobId 的候选入队、建唤醒单后 jobId 原样保留', () => {
    const ctx = setup();
    const candidate = buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '开工', jobId: 'job_0000000001' });
    expect(candidate.jobId).toBe('job_0000000001');
    const entry = enqueue(ctx, candidate)!;
    expect(entry.jobId).toBe('job_0000000001');
    expect(ctx.store.table('queue').get(entry.id)?.jobId).toBe('job_0000000001');
    const ticket = createTicket(ctx, entry, null);
    expect(ticket.jobId).toBe('job_0000000001');
    expect(ctx.store.table('wakes').get(ticket.id)?.jobId).toBe('job_0000000001');
  });

  it('不带 jobId 的候选和唤醒单没有这一项；旧唤醒单（没有 jobId 字段）可读', () => {
    const ctx = setup();
    const candidate = buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '随便聊' });
    expect('jobId' in candidate).toBe(false);
    const entry = enqueue(ctx, candidate)!;
    expect(entry.jobId ?? null).toBeNull();
    const ticket = createTicket(ctx, entry, null);
    expect(ticket.jobId ?? null).toBeNull();
    // 旧数据：整条没有 jobId，仍可写入再读出
    const { jobId: _drop, ...legacy } = ticket;
    ctx.store.table('wakes').put({ ...legacy, id: 'w_0000000099' });
    expect(ctx.store.table('wakes').get('w_0000000099')?.jobId ?? null).toBeNull();
  });

  it('jobId 必须是 job_ 前缀；候选入参的 jobId 不能为空串', () => {
    const ctx = setup();
    const candidate = buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '开工', jobId: 'job_0000000001' });
    expect(() => enqueue(ctx, { ...candidate, jobId: 'x_1' })).toThrow(/jobId/);
    expect(() => buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '开工', jobId: '' })).toThrow();
  });

  // P74c 改了预期：合并键加上 jobId。原来这条测「带 jobId 的候选和不带 jobId 的候选合并后保留 jobId」，
  // 现在这两条不再合并（不同的事各排各的，一件事的唤醒不和主人私聊的唤醒合并），所以拆成两条：同一件事合并并保留，不同的不合并。
  it('同一员工、同一主题、同一件事的两个候选合并时保留 jobId', () => {
    const ctx = setup();
    const first = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '甲', jobId: 'job_0000000001' }))!;
    const merged = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '乙', jobId: 'job_0000000001' }))!;
    expect(merged.id).toBe(first.id);
    expect(merged.jobId).toBe('job_0000000001');
  });

  it('带 jobId 的候选和不带 jobId 的候选、带不同 jobId 的候选不合并', () => {
    const ctx = setup();
    const first = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '甲', jobId: 'job_0000000001' }))!;
    const plain = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '乙' }))!;
    const other = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '丙', jobId: 'job_0000000002' }))!;
    expect(new Set([first.id, plain.id, other.id]).size).toBe(3);
    expect(plain.jobId).toBeUndefined();
    expect(first.jobId).toBe('job_0000000001');
    expect(other.jobId).toBe('job_0000000002');
  });
});
