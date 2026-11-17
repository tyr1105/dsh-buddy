/**
 * P74a 视图验收：进度行（对齐中到已停止、四步与五步、受阻五种原因、轮次/交付时间/暂停文字、发布三种状态）、
 * 主题楼层与往来折叠、侧栏一行、项目页的一件事行；以及接到现有线程视图、员工卡片、项目视图上的字段。
 * 视图都是纯函数，时间和时区显式传入；接线部分只读存储。
 */
import { describe, expect, it } from 'vitest';
import {
  chiefJobLine, jobProgressView, projectJobRows, topicFloorsView, type JobProgressInput, type TopicFloorsInput,
} from '../src/api/job-views.js';
import { JobProgressViewSchema, ProjectJobRowSchema, TopicFloorsViewSchema } from '../src/api/job-view-schemas.js';
import { botCard } from '../src/api/summary-views.js';
import { threadView } from '../src/api/feed-views.js';
import { projectView } from '../src/api/project-views.js';
import { botView } from '../src/api/bot-view.js';
import { logAppraisal } from '../src/appraisal/log.js';
import { AgreementSchema } from '../src/model/agreement.js';
import type { Job } from '../src/model/job.js';
import type { ThreadMessage } from '../src/model/outreach.js';
import { postThread } from '../src/outreach/thread.js';
import { appendJobEvent } from '../src/job/store.js';
import { openTopic, setup } from './p72b-fixtures.js';
import { agreementFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { CHIEF, EXECUTOR, NOW, REVIEWER, jobFixture } from './p74a-job-fixtures.js';

const TZ = 'Asia/Shanghai';
const names = { [CHIEF]: '老大', [EXECUTOR]: '林舟', [REVIEWER]: '评审小周' };
const DUE = Date.parse('2026-11-17T10:00:00Z'); // 上海 11月17日 18:00

/** 进度行：除 job 外都有默认值。 */
function progress(job: Job | null, patch: Partial<JobProgressInput> = {}) {
  return jobProgressView({ agreementState: 'locked', agreementVersionNo: 1, job, names, delayNote: null, now: NOW, timezone: TZ, ...patch });
}
/** 把步骤压成「执行=当前」这样的短串，断言更好读。 */
const brief = (view: ReturnType<typeof progress>) => view!.steps.map(step => `${step.label}=${step.state}`).join(' ');
const unmet = [{ no: 2, problem: '刷新后数据没变', fixTo: '点刷新后列表时间更新' }];
const blocked = (kind: 'review_limit' | 'executor' | 'turn_cap' | 'owner_hold' | 'participant_off', resumeTo: 'ready' | 'doing' | 'checking' | 'rework') =>
  jobFixture({ state: 'blocked', blocked: { kind, no: null, text: '原因', since: NOW, resumeTo } });

describe('进度行：状态与步骤', () => {
  it('对齐中：约定待确认、还没有这件事；在等你；四步，对齐为当前', () => {
    const view = progress(null, { agreementState: 'pending' })!;
    expect(view).toMatchObject({ stateLabel: '对齐中', stateTone: 'you', waitingOn: '你', roundText: null, dueText: '未约定', pausedText: null, delayNote: null });
    expect(brief(view)).toBe('对齐=current 执行=todo 核对=todo 你验收=todo');
  });
  it('约定已固定但还没派活：待开工，在等总管，执行为当前', () => {
    const view = progress(null)!;
    expect(view).toMatchObject({ stateLabel: '待开工', stateTone: 'run', waitingOn: '总管' });
    expect(brief(view)).toBe('对齐=done 执行=current 核对=todo 你验收=todo');
  });
  it('约定已撤下：没有进度行', () => {
    expect(progress(null, { agreementState: 'withdrawn' })).toBeNull();
    expect(progress(jobFixture(), { agreementState: 'withdrawn' })).toBeNull();
  });
  it('待开工、执行中、返工中：执行为当前，在等执行者', () => {
    for (const [state, label] of [['ready', '待开工'], ['doing', '执行中'], ['rework', '返工中']] as const) {
      const view = progress(jobFixture({ state, unmet: state === 'rework' ? unmet : [] }))!;
      expect(view).toMatchObject({ stateLabel: label, stateTone: 'run', waitingOn: '林舟' });
      expect(brief(view)).toBe('对齐=done 执行=current 核对=todo 你验收=todo');
    }
  });
  it('执行中有未回答的提问：在等总管', () => {
    const view = progress(jobFixture({ openAsk: { eventId: 'jev_0000000001', fromId: EXECUTOR, at: NOW } }))!;
    expect(view.waitingOn).toBe('总管');
  });
  it('核对中：核对为当前；在等评审员（用名字），没有评审员在等总管', () => {
    const view = progress(jobFixture({ state: 'checking', round: 1 }))!;
    expect(view).toMatchObject({ stateLabel: '核对中', stateTone: 'run', waitingOn: '评审小周' });
    expect(brief(view)).toBe('对齐=done 执行=done 核对=current 你验收=todo');
    expect(progress(jobFixture({ state: 'checking', round: 1, reviewerId: null }))!.waitingOn).toBe('总管');
    expect(progress(jobFixture({ state: 'checking', round: 1 }), { names: {} })!.waitingOn).toBe('评审员'); // 查不到名字时的兜底
  });
  it('待你验收：你验收为当前，在等你，颜色是 you', () => {
    const view = progress(jobFixture({ state: 'awaiting_owner' }))!;
    expect(view).toMatchObject({ stateLabel: '待你验收', stateTone: 'you', waitingOn: '你' });
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=current');
  });
  it('已完成（无发布步骤）：四步全部完成，不在等谁', () => {
    const view = progress(jobFixture({ state: 'done' }))!;
    expect(view).toMatchObject({ stateLabel: '已完成', stateTone: 'ok', waitingOn: null });
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=done');
  });
  it('已停止：当前步停住，颜色 ok，不在等谁', () => {
    const view = progress(jobFixture({ state: 'stopped', deliveredAt: null, startedAt: null }))!;
    expect(view).toMatchObject({ stateLabel: '已停止', stateTone: 'ok', waitingOn: null });
    expect(brief(view)).toBe('对齐=done 执行=stuck 核对=todo 你验收=todo');
    // 交付过再停下：停在「你验收」
    expect(brief(progress(jobFixture({ state: 'stopped', deliveredAt: NOW }))!)).toBe('对齐=done 执行=done 核对=done 你验收=stuck');
    // 已交回过、没有待改条目：停在「核对」
    expect(brief(progress(jobFixture({ state: 'stopped', round: 2, unmet: [] }))!)).toBe('对齐=done 执行=done 核对=stuck 你验收=todo');
  });
});

describe('进度行：四步与五步', () => {
  it('约定有发布步骤时是五步，没有时四步', () => {
    expect(progress(jobFixture({ launchStep: true }))!.steps).toHaveLength(5);
    expect(progress(jobFixture({ launchStep: false }))!.steps).toHaveLength(4);
    expect(brief(progress(jobFixture({ launchStep: true, state: 'checking', round: 1 }))!)).toBe('对齐=done 执行=done 核对=current 你验收=todo 发布=todo');
  });
  it('已完成且有发布步骤：准备中，发布为当前，在等执行者', () => {
    const view = progress(jobFixture({ state: 'done', launchStep: true, launch: { state: 'preparing', approvalId: null, link: null } }))!;
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=done 发布=current');
    expect(view).toMatchObject({ stateLabel: '已完成', waitingOn: '林舟', delayNote: null });
  });
  it('已完成且有发布步骤：等你批准，发布为当前，在等你', () => {
    const view = progress(jobFixture({ state: 'done', launchStep: true, launch: { state: 'approval', approvalId: 'ap_0000000001', link: null } }))!;
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=done 发布=current');
    expect(view.waitingOn).toBe('你');
  });
  it('已完成且有发布步骤：你暂不发布，发布保持未到，说明写「你暂不发布」（覆盖传入的说明）', () => {
    const view = progress(jobFixture({ state: 'done', launchStep: true, launch: { state: 'declined', approvalId: null, link: null } }), { delayNote: '别的说明' })!;
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=done 发布=todo');
    expect(view).toMatchObject({ delayNote: '你暂不发布', waitingOn: null });
  });
  it('已完成且已发布：五步全部完成', () => {
    const view = progress(jobFixture({ state: 'done', launchStep: true, launch: { state: 'done', approvalId: 'ap_0000000001', link: 'https://example.com' } }))!;
    expect(brief(view)).toBe('对齐=done 执行=done 核对=done 你验收=done 发布=done');
    expect(view.waitingOn).toBeNull();
  });
});

describe('进度行：受阻', () => {
  it.each([
    ['review_limit', 'rework', '你', '对齐=done 执行=stuck 核对=todo 你验收=todo'],
    ['turn_cap', 'doing', '你', '对齐=done 执行=stuck 核对=todo 你验收=todo'],
    ['owner_hold', 'ready', '你', '对齐=done 执行=stuck 核对=todo 你验收=todo'],
    ['executor', 'rework', '总管', '对齐=done 执行=stuck 核对=todo 你验收=todo'],
    ['participant_off', 'checking', '总管', '对齐=done 执行=done 核对=stuck 你验收=todo'],
  ] as const)('%s（原状态 %s）：在等%s', (kind, resumeTo, waiting, steps) => {
    const view = progress(blocked(kind, resumeTo))!;
    expect(view).toMatchObject({ stateLabel: '受阻', stateTone: 'you', waitingOn: waiting });
    expect(brief(view)).toBe(steps);
  });
  it('受阻时没有轮次文字；五步时发布仍是未到', () => {
    const view = progress({ ...blocked('review_limit', 'rework'), launchStep: true, round: 3 })!;
    expect(view.roundText).toBeNull();
    expect(brief(view)).toBe('对齐=done 执行=stuck 核对=todo 你验收=todo 发布=todo');
  });
});

describe('进度行：轮次、交付时间、暂停、延迟说明', () => {
  it('轮次文字只在核对中、返工中出现', () => {
    expect(progress(jobFixture({ state: 'checking', round: 2 }))!.roundText).toBe('第 2 轮，共 3 轮');
    expect(progress(jobFixture({ state: 'rework', round: 2, unmet }))!.roundText).toBe('第 2 轮，共 3 轮');
    // 新阶段刚开始、轮数为 0 的返工写第 1 轮
    expect(progress(jobFixture({ state: 'rework', round: 0, stage: 2, unmet }))!.roundText).toBe('第 1 轮，共 3 轮');
    for (const state of ['ready', 'doing', 'awaiting_owner', 'done', 'stopped'] as const) expect(progress(jobFixture({ state, round: 2 }))!.roundText).toBeNull();
  });
  it('交付时间：未约定，或「M月D日 HH:mm 前」（按传入时区）', () => {
    expect(progress(jobFixture({ dueAt: null }))!.dueText).toBe('未约定');
    expect(progress(jobFixture({ dueAt: DUE }))!.dueText).toBe('11月17日 18:00 前');
    expect(progress(jobFixture({ dueAt: DUE }), { timezone: 'UTC' })!.dueText).toBe('11月17日 10:00 前');
    expect(progress(jobFixture({ dueAt: Date.parse('2026-12-03T01:05:00Z') }))!.dueText).toBe('12月3日 09:05 前');
  });
  it('暂停文字：用顿号连接；没有暂停或暂停栏为空时为 null', () => {
    const pause = { versionNo: 2, continuing: ['报名页'], paused: ['名额计数', '「名额已满」'], fallback: null };
    expect(progress(jobFixture({ pause }))!.pausedText).toBe('暂停：名额计数、「名额已满」');
    expect(progress(jobFixture({ pause: null }))!.pausedText).toBeNull();
    expect(progress(jobFixture({ pause: { ...pause, paused: [] } }))!.pausedText).toBeNull();
  });
  it('延迟说明原样传入（本卡接线时传 null）', () => {
    expect(progress(jobFixture(), { delayNote: '员工的额度用完了，等到明天 00:00' })!.delayNote).toBe('员工的额度用完了，等到明天 00:00');
  });
  it('每种结果都符合导出的 zod 结构', () => {
    const cases = [progress(null, { agreementState: 'pending' }), progress(null), progress(jobFixture({ state: 'checking', round: 1, launchStep: true })), progress(blocked('executor', 'doing'))];
    for (const view of cases) expect(JobProgressViewSchema.safeParse(view).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 主题楼层与往来折叠
// ---------------------------------------------------------------------------

let seq = 0;
/** 造一条主题消息；时间用上海时区的日期字符串，序号保证 id 唯一。 */
function msg(from: string, kind: ThreadMessage['kind'], text: string, at = '2026-11-12T02:00:00Z', refId: string | null = null): ThreadMessage {
  seq += 1;
  return { id: `m_${String(seq).padStart(10, '0')}`, thread: 'ptp_0000000001', from, kind, text, refId, createdAt: Date.parse(at), readAt: null };
}
const floorNames = { owner: '你', [CHIEF]: '老大', [EXECUTOR]: '林舟', [REVIEWER]: '评审小周' };
function floors(messages: ThreadMessage[], patch: Partial<TopicFloorsInput> = {}) {
  return topicFloorsView({ messages, names: floorNames, events: {}, commitSenders: {}, chiefId: CHIEF, timezone: TZ, ...patch });
}
const kinds = (view: ReturnType<typeof floors>) => view.items.map(item => item.kind).join(',');

describe('主题楼层与往来折叠', () => {
  it('没有往来：全是楼层，总数行只写总数', () => {
    const view = floors([msg('owner', 'chat', '你好'), msg(CHIEF, 'reply', '好的')]);
    expect(kinds(view)).toBe('floor,floor');
    expect(view.countText).toBe('共 2 条记录');
    expect(floors([]).countText).toBe('共 0 条记录');
    expect(floors([]).items).toEqual([]);
  });

  it('一组：两条 work 加交回卡归成一组，参与者按首次出现去重，中心提示不算参与者', () => {
    const view = floors([
      msg('owner', 'chat', '开始吧'),
      msg('hub', 'work', '林舟已交回，请评审小周核对。', '2026-11-12T03:00:00Z'),
      msg(EXECUTOR, 'work', '我先做了列表。', '2026-11-12T03:01:00Z'),
      msg(EXECUTOR, 'job_card', '交回卡正文', '2026-11-12T03:02:00Z', 'submission:jsb_0000000001'),
      msg(REVIEWER, 'job_card', '核对卡正文', '2026-11-12T03:03:00Z', 'review:jrv_0000000001'),
      msg(CHIEF, 'reply', '进展不错'),
    ]);
    expect(kinds(view)).toBe('floor,fold,floor');
    const fold = view.items[1]!;
    if (fold.kind !== 'fold') throw new Error('应是折叠组');
    expect(fold).toMatchObject({ count: 4, participants: ['林舟', '评审小周'], rangeText: '11月12日', latest: '核对卡' });
    expect(fold.id).toBe(fold.messages[0]!.message.id);
    expect(fold.messages.map(row => row.fromName)).toEqual(['Agent 中心', '林舟', '林舟', '评审小周']);
    expect(view.countText).toBe('共 6 条记录：给你的 2 条，员工之间的往来 4 条（已收起）');
    expect(TopicFloorsViewSchema.safeParse(view).success).toBe(true);
  });

  it('两组被楼层隔开；交付卡和回执是楼层不进折叠', () => {
    const view = floors([
      msg(EXECUTOR, 'work', '甲'), msg(CHIEF, 'work', '乙'),
      msg(CHIEF, 'job_card', '交付卡', undefined, 'delivery:jrv_0000000001'),
      msg(EXECUTOR, 'work', '丙'),
      msg('hub', 'system', '回执'),
    ]);
    expect(kinds(view)).toBe('fold,floor,fold,floor');
    const [first, , second] = view.items;
    expect(first).toMatchObject({ count: 2, participants: ['林舟', '老大'] });
    expect(second).toMatchObject({ count: 1, participants: ['林舟'] });
    // 中心的约定类旁白计入总数，也计入「给你的」
    expect(view.countText).toBe('共 5 条记录：给你的 2 条，员工之间的往来 3 条（已收起）');
  });

  it('首条和末条都是往来', () => {
    const view = floors([msg(EXECUTOR, 'work', '开头'), msg('owner', 'chat', '中间'), msg(REVIEWER, 'work', '结尾')]);
    expect(kinds(view)).toBe('fold,floor,fold');
  });

  it('只有中心提示的往来组：参与者为空', () => {
    const view = floors([msg('hub', 'work', '总管把这件事交给林舟。')]);
    expect(view.items[0]).toMatchObject({ kind: 'fold', participants: [], count: 1 });
  });

  it('日期范围：同一天、跨天、跨月', () => {
    const range = (a: string, b: string) => {
      const fold = floors([msg(EXECUTOR, 'work', '甲', a), msg(EXECUTOR, 'work', '乙', b)]).items[0]!;
      return fold.kind === 'fold' ? fold.rangeText : '';
    };
    expect(range('2026-11-12T02:00:00Z', '2026-11-12T09:00:00Z')).toBe('11月12日');
    expect(range('2026-11-12T02:00:00Z', '2026-11-14T02:00:00Z')).toBe('11月12日至14日');
    expect(range('2026-11-29T02:00:00Z', '2026-12-02T02:00:00Z')).toBe('11月29日至12月2日');
    // 按上海时区算日：UTC 的 11-12 17:00 已经是上海 11-13 01:00
    expect(range('2026-11-12T02:00:00Z', '2026-11-12T17:00:00Z')).toBe('11月12日至13日');
  });

  it('最近一句：取最后一条的第一句（含句末标点）；遇换行截断；超过 60 字加「…」；无标点取整句', () => {
    const latest = (text: string) => {
      const fold = floors([msg(EXECUTOR, 'work', '先前的话。'), msg(EXECUTOR, 'work', text)]).items[0]!;
      return fold.kind === 'fold' ? fold.latest : '';
    };
    expect(latest('第一句。第二句。')).toBe('第一句。');
    expect(latest('真的吗？不一定')).toBe('真的吗？');
    expect(latest('太好了！继续')).toBe('太好了！');
    expect(latest('第一行没有标点\n第二行。')).toBe('第一行没有标点');
    expect(latest('没有句末标点的一句话')).toBe('没有句末标点的一句话');
    expect(latest(`${'长'.repeat(70)}。`)).toBe(`${'长'.repeat(60)}…`);
    expect(latest(`${'长'.repeat(60)}`)).toBe('长'.repeat(60)); // 恰好 60 字不加省略号
    expect(latest(`  \n前面有空行。`)).toBe('前面有空行。');
  });

  it('最近一句：最后一条是卡片时取卡片标题（可替换）', () => {
    const messages = [msg(EXECUTOR, 'job_card', 'x', undefined, 'submission:jsb_0000000001')];
    const fold = floors(messages).items[0]!;
    expect(fold.kind === 'fold' && fold.latest).toBe('交回卡');
    const custom = floors(messages, { cardTitleOf: () => '第 1 轮交回：5 条附证据。' }).items[0]!;
    expect(custom.kind === 'fold' && custom.latest).toBe('第 1 轮交回：5 条附证据。');
  });

  it('谁 → 谁：事件的接收者、交账（员工发给总管、总管自己无箭头）、其他为空', () => {
    const toEvent = msg('hub', 'work', '总管把问题转给了林舟。', undefined, 'jev_0000000001');
    const missingEvent = msg('hub', 'work', '事件已找不到。', undefined, 'jev_0000000099');
    const fromEmployee = msg(EXECUTOR, 'work', '我做完了。', undefined, 'c_0000000001');
    const fromChief = msg(CHIEF, 'work', '好的。', undefined, 'c_0000000002');
    const plain = msg(EXECUTOR, 'work', '没有关联。');
    const card = msg(EXECUTOR, 'job_card', '卡', undefined, 'submission:jsb_0000000001');
    const view = floors([toEvent, missingEvent, fromEmployee, fromChief, plain, card], {
      events: { jev_0000000001: { actor: CHIEF, to: [EXECUTOR, 'owner', 'hub', 'b_9999999999'] } },
      commitSenders: { c_0000000001: EXECUTOR, c_0000000002: CHIEF },
    });
    const fold = view.items[0]!;
    if (fold.kind !== 'fold') throw new Error('应是折叠组');
    expect(fold.messages.map(row => row.toNames)).toEqual([['林舟', '你', '已删除的员工'], [], ['总管'], [], [], []]);
  });

  it('员工已被删除：发出者写「已删除的员工」', () => {
    const fold = floors([msg('b_9999999999', 'work', '我走了。')]).items[0]!;
    expect(fold.kind === 'fold' && fold.participants).toEqual(['已删除的员工']);
  });
});

// ---------------------------------------------------------------------------
// 侧栏一行与项目页行
// ---------------------------------------------------------------------------

describe('侧栏一行与项目页的一件事行', () => {
  const row = (patch: Partial<Job>, title = '每日报价页') => ({ job: jobFixture(patch), title });
  it('零件、一件、多件', () => {
    expect(chiefJobLine([], NOW)).toBeNull();
    expect(chiefJobLine([row({ state: 'done' }), row({ id: 'job_0000000002', state: 'stopped' })], NOW)).toBeNull(); // 只剩收尾的事
    // P76i：一件时也写「1 件在办」（原为「标题　状态」）。
    expect(chiefJobLine([row({ state: 'checking', round: 1 })], NOW)).toBe('1 件在办');
    expect(chiefJobLine([row({ state: 'checking', round: 1 }), row({ id: 'job_0000000002', state: 'done' })], NOW)).toBe('1 件在办'); // 已完成的不算在办
    expect(chiefJobLine([row({ state: 'awaiting_owner' }), row({ id: 'job_0000000002', state: 'doing' }), row({ id: 'job_0000000003', state: 'blocked', blocked: { kind: 'executor', no: null, text: 'x', since: NOW, resumeTo: 'doing' } })], NOW)).toBe('3 件在办');
  });
  it('项目页行：受阻、待你验收在前，其余按更新时间新到旧，已完成、已停止在最后', () => {
    const mk = (n: number, state: Job['state'], updatedAt: number, extra: Partial<Job> = {}) => ({
      job: jobFixture({ id: `job_000000000${n}`, topicId: `ptp_000000000${n}`, state, updatedAt, ...extra }), title: `事${n}`, executorName: '林舟',
    });
    const rows = projectJobRows([
      mk(1, 'done', 900), mk(2, 'doing', 100), mk(3, 'awaiting_owner', 50),
      mk(4, 'rework', 300, { unmet }), mk(5, 'stopped', 950), mk(6, 'doing', 200, { dueAt: DUE }),
      mk(7, 'blocked', 10, { blocked: { kind: 'turn_cap', no: null, text: 'x', since: NOW, resumeTo: 'doing' } }),
    ], TZ);
    expect(rows.map(r => r.title)).toEqual(['事3', '事7', '事4', '事6', '事2', '事5', '事1']);
    // 同档按更新时间新到旧：事3(50) 在 事7(10) 前
    expect(rows[3]).toEqual({ jobId: 'job_0000000006', topicId: 'ptp_0000000006', title: '事6', executorName: '林舟',
      stateLabel: '执行中', stateTone: 'run', dueText: '11月17日 18:00 前' });
    expect(rows[0]).toMatchObject({ stateLabel: '待你验收', stateTone: 'you', dueText: '未约定' });
    expect(rows.every(r => ProjectJobRowSchema.safeParse(r).success)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 接到现有视图上的字段
// ---------------------------------------------------------------------------

describe('接线：线程视图、员工卡片、项目视图', () => {
  async function wired() {
    const fix = await setup();
    const topicId = await openTopic(fix, '随便聊聊');
    const topic = fix.ctx.store.table('projectTopics').get(topicId)!;
    const agreement = AgreementSchema.parse(agreementFixture({
      botId: fix.chief.id, originThread: fix.chief.id, projectId: topic.projectId, topicId, title: '每日报价页', state: 'locked',
      versions: [versionFixture(1, { state: 'locked', lockedAt: 2000, lockedVia: 'button' })],
    }));
    fix.ctx.store.table('agreements').put(agreement);
    return { fix, topicId, topic, agreement };
  }

  it('主题线程：约定已固定但没有这件事时，进度行是「待开工」；floors 带总数行；旧字段仍在', async () => {
    const { fix, topicId } = await wired();
    const view = threadView(fix.ctx, topicId);
    expect(view.progress).toMatchObject({ stateLabel: '待开工', waitingOn: '总管' });
    expect(view.floors?.countText).toMatch(/^共 \d+ 条记录/);
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.agreement).toBeTruthy();
    expect(JobProgressViewSchema.safeParse(view.progress).success).toBe(true);
    expect(TopicFloorsViewSchema.safeParse(view.floors).success).toBe(true);
  });

  it('主题线程：有这件事时进度行跟着状态；工作往来折叠，事件接收者译成名字', async () => {
    const { fix, topicId, agreement } = await wired();
    const job = jobFixture({ chiefId: fix.chief.id, executorId: fix.wang.id, reviewerId: fix.li.id, agreementId: agreement.id,
      projectId: agreement.projectId, topicId, state: 'checking', round: 1, dueAt: DUE });
    fix.ctx.store.table('jobs').put(job);
    const event = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'forwarded', to: [fix.wang.id], refId: null, data: {} });
    postThread(fix.ctx, { thread: topicId, from: 'hub', kind: 'work', text: '总管把材料转给了小王。', refId: event.id });
    postThread(fix.ctx, { thread: topicId, from: fix.wang.id, kind: 'work', text: '收到。' });
    const view = threadView(fix.ctx, topicId);
    expect(view.progress).toMatchObject({ stateLabel: '核对中', roundText: '第 1 轮，共 3 轮', waitingOn: '小李', dueText: '11月17日 18:00 前' });
    const fold = view.floors!.items.find(item => item.kind === 'fold');
    if (!fold || fold.kind !== 'fold') throw new Error('应有折叠组');
    expect(fold.count).toBe(2);
    expect(fold.participants).toEqual(['小王']);
    expect(fold.messages[0]!.toNames).toEqual(['小王']);
  });

  it('非主题线程（私聊）不带 progress 和 floors', async () => {
    const { fix } = await wired();
    const view = threadView(fix.ctx, fix.chief.id);
    expect('progress' in view).toBe(false);
    expect('floors' in view).toBe(false);
  });

  it('员工卡片：总管带 chiefJobLine，其他员工不带', async () => {
    const { fix, topicId, agreement } = await wired();
    expect(botCard(fix.ctx, fix.chief).chiefJobLine).toBeNull();
    expect('chiefJobLine' in botCard(fix.ctx, fix.wang)).toBe(false);
    fix.ctx.store.table('jobs').put(jobFixture({ chiefId: fix.chief.id, executorId: fix.wang.id, reviewerId: null, agreementId: agreement.id,
      projectId: agreement.projectId, topicId, state: 'awaiting_owner' }));
    // P76i：一件在办、在等你验收：「1 件在办，1 件等你」（原为「标题　状态」）。
    expect(botCard(fix.ctx, fix.chief).chiefJobLine).toBe('1 件在办，1 件等你');
  });

  it('员工详情的评估记录：新增的两个拦截原因码照实给出，说明文字保留；旧原因码照常', async () => {
    const { fix } = await wired();
    const base = { botId: fix.wang.id, perceptIds: [], score: 0.5, threshold: 0.4, decision: 'suppressed' as const };
    logAppraisal(fix.ctx, { ...base, suppressedBy: 'job_cap', text: '这件事的回合用到上限，移出队列' });
    logAppraisal(fix.ctx, { ...base, suppressedBy: 'job_inactive', text: '这件事已不需要这次唤醒，移出队列' });
    logAppraisal(fix.ctx, { ...base, suppressedBy: 'cooldown', text: '冷却中' });
    const rows = (await botView(fix.ctx, fix.wang.id)).appraisals;
    expect(rows.map(row => [row.suppressedBy, row.text])).toEqual([
      ['cooldown', '冷却中'], ['job_inactive', '这件事已不需要这次唤醒，移出队列'], ['job_cap', '这件事的回合用到上限，移出队列'],
    ]);
  });

  it('项目视图：jobRows 带这件事；没有时为空数组', async () => {
    const { fix, topicId, topic, agreement } = await wired();
    expect(projectView(fix.ctx).projects.find(p => p.project.id === topic.projectId)!.jobRows).toEqual([]);
    fix.ctx.store.table('jobs').put(jobFixture({ chiefId: fix.chief.id, executorId: fix.wang.id, reviewerId: null, agreementId: agreement.id,
      projectId: agreement.projectId, topicId, state: 'doing', dueAt: DUE }));
    const rows = projectView(fix.ctx).projects.find(p => p.project.id === topic.projectId)!.jobRows;
    expect(rows).toEqual([{ jobId: 'job_0000000001', topicId, title: '每日报价页', executorName: '小王', stateLabel: '执行中', stateTone: 'run', dueText: '11月17日 18:00 前' }]);
  });
});
