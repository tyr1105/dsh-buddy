/**
 * P74r17 第 4、5、6 节的测试：总管不在岗时的告警句子、六处小问题、以及审查指出没有测试守着的几处。
 *
 * 夹具与真实情况一致：总管是自动创建的（听吩咐、节奏最慢）、执行类员工听吩咐；
 * 执行者走真实路径被停用（连续三次碰凭据类文件，闸门记三次越界）；时间用注入的假时钟，每次推进不超过 10 分钟。
 * 覆盖：
 * 4 总管被主人停用之后执行者被中心停用：告警正文第二句逐字、总管候选 0 条、进度行「在等：你」；一件事两位总管的情形用纯函数各一条；
 * 5.1 低-1 符号链接根目录下含展不开变量的路径：真实写法与设置写法结果一致；5.2 低-2 Unicode 规范形式不同时换算正确；
 *     5.3 低-3 只改交付时间也发刷新事件；5.4 低-4 总管「你手上的事」写「（已停用）」；5.5 低-5 三种状态各一条逐字；
 * 6.1 M6 恢复在岗只清因停用给总管排的候选；6.2 M7a 受阻没有开始时间的说明不享受放宽；6.3 M12 核对中被结束的不是核对人的回合不计数；
 *     6.4 疑点一 总管正在跑「因员工被停用而叫醒」的回合时主人恢复了这位员工。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { inboxView } from '../src/api/feed-views.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { waitingOnOf } from '../src/api/job-views.js';
import { resolveSettings } from '../src/config/defaults.js';
import type { HubContext } from '../src/engine/context.js';
import { toCenterForm } from '../src/gate/paths.js';
import { guardToolCallSync, type ToolCallHostReport } from '../src/gate/guard.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { endChainTurn } from '../src/job/chain-turn-end.js';
import { jobEscalationExpiry } from '../src/job/escalation-expiry.js';
import { putJob, eventsOf as jobEventsOf } from '../src/job/store.js';
import { suspendedAlertText } from '../src/job/suspended.js';
import { newId } from '../src/util/ids.js';
import { chiefOverviewBody } from '../src/wake/job-section-chief.js';
import { botFixture } from './model-fixtures.js';
import { bot, callTool, commitAs, entriesOf, jobFix, MINUTE, runningJob, runningOf, tick, wakesOf, type JobFix } from './p74c-fixtures.js';
import { engineerSubmits, started } from './p74d-fixtures.js';

// 越界达到次数的停用原因（守卫里的写法）。
const REASON = '越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）';

/** 走真实路径让某位员工被中心停用：连续三次碰凭据类文件，第三次停用，再让中心跑一轮把后续做完。 */
async function suspendByCredentials(fix: JobFix, botId: string): Promise<void> {
  const sessionId = bot(fix, botId).sessionId!;
  for (let i = 0; i < 3; i += 1) expect(fix.hub.guardToolCall(sessionId, 'bash', { command: 'cat ~/.ssh/id_rsa' }).allow).toBe(false);
  await fix.hub.tick();
  expect(bot(fix, botId).lifecycle).toBe('quarantined');
}

/** 林舟正在做一件事（回合开着）；总管、小周、评审甲都在岗。 */
async function running() {
  const fix = await jobFix(['小周']);
  const { job } = await runningJob(fix);
  return { fix, job };
}

/** 停用之后总管被叫醒（回合开着）。 */
async function chiefAwake(fix: JobFix, jobId: string): Promise<void> {
  for (let i = 0; i < 3 && !wakesOf(fix, fix.chief.id, jobId).some(row => row.status === 'running'); i += 1) await tick(fix, 10 * MINUTE);
  expect(wakesOf(fix, fix.chief.id, jobId).some(row => row.status === 'running'), '总管应该被叫醒了').toBe(true);
}

const alertItem = (fix: JobFix) => inboxView(fix.ctx).items.find(item => item.type === 'alert');

// ---------------------------------------------------------------------------
describe('4 总管不在岗时，告警正文不写「已告诉总管」', () => {
  it('总管被主人停用之后执行者被中心停用：告警正文是第二句（逐字）；总管候选 0 条；进度行「在等：你」', async () => {
    const { fix, job } = await running();
    await lifecycleAction(fix.ctx, { botId: fix.chief.id, action: 'suspend' });
    await suspendByCredentials(fix, fix.engineer.id);
    expect(alertItem(fix)!.body).toBe(`中心停用了林舟：${REASON}。「会员定价页」已停在执行，总管此刻不在岗，需要你处理。`);
    expect(alertItem(fix)!.body).not.toContain('已告诉总管');
    expect(entriesOf(fix, fix.chief.id)).toHaveLength(0);
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('你');
  });

  it('总管在岗时仍是第一句（对照）：已告诉总管，总管有这件事的候选', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    expect(alertItem(fix)!.body).toBe(`中心停用了林舟：${REASON}。「会员定价页」已停在执行，已告诉总管。`);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
  });

  it('两件事、两位总管一位在岗一位不在岗（夹具里每件事只有一位总管，用纯函数传入两件事）：每件事各按自己的总管写，各一句', async () => {
    const { fix, job } = await running();
    await lifecycleAction(fix.ctx, { botId: fix.chief.id, action: 'suspend' });
    const onDuty = fix.extras[0]!;
    const text = suspendedAlertText(fix.ctx, { name: '林舟' }, REASON, [{ ...job, chiefId: fix.chief.id }, { ...job, chiefId: onDuty.id }]);
    expect(text).toBe(`中心停用了林舟：${REASON}。「会员定价页」已停在执行，总管此刻不在岗，需要你处理。「会员定价页」已停在执行，已告诉总管。`);
  });
});

// ---------------------------------------------------------------------------
describe('5.1 低-1 符号链接根目录下，含展不开变量的路径与设置写法结果一致', () => {
  const OWNER = '/Users/someone';
  const ROOT = `${OWNER}/AgentHub`;
  const REAL = '/Volumes/Disk/AgentHub';
  const TMP_T = '/var/folders/ab/xyz/T';
  const SANDBOX: ToolCallHostReport = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp', TMP_T, `/private${TMP_T}`] };
  const EXECUTOR = 'b_0000000001', CHIEF = 'b_0000000003';

  /** 环境乙：设置写法 /Users/someone/AgentHub，真实路径 /Volumes/Disk/AgentHub，沙箱开着。 */
  function setup(): HubContext {
    const runtime = createTestContext({ ownerHome: OWNER });
    runtime.settings = resolveSettings({ rootDir: ROOT, l3Grants: [] });
    runtime.runtime.realRootDir = REAL;
    const make = (id: string, role: 'chief' | 'executor', session: string) => ({ ...botFixture, id, role, onDemand: true, sessionId: session,
      homeDir: `${ROOT}/bots/${id}`, autonomy: 'L1' as const, pace: role === 'chief' ? 'quiet' as const : 'normal' as const });
    runtime.store.table('bots').put(make(CHIEF, 'chief', 'session-chief'));
    runtime.store.table('bots').put(make(EXECUTOR, 'executor', 'session-exec'));
    return runtime;
  }
  async function guard(runtime: HubContext, command: string) {
    const effects: Promise<unknown>[] = [];
    const decision = guardToolCallSync(runtime, 'session-exec', 'exec', { command, workdir: `${REAL}/bots/${EXECUTOR}` }, effect => { effects.push(effect); }, undefined, SANDBOX);
    await Promise.all(effects);
    return { decision, approvals: runtime.store.table('approvals').count(), violations: runtime.store.table('bots').get(EXECUTOR)!.violations };
  }

  it('写自己 mind/ 下的文件：真实路径写法与设置写法的结果相同（都要审批，不放行）', async () => {
    const real = await guard(setup(), `echo x > "$NOPE${REAL}/bots/${EXECUTOR}/mind/goals.md"`);
    const configured = await guard(setup(), `echo x > "$NOPE${ROOT}/bots/${EXECUTOR}/mind/goals.md"`);
    expect(configured.decision.allow).toBe(false);
    expect(real.decision.allow).toBe(false);
    expect({ approvals: real.approvals, violations: real.violations }).toEqual({ approvals: configured.approvals, violations: configured.violations });
  });

  it('反例：写自己家目录里的普通文件，两种写法的结果也相同（不因此多拦）', async () => {
    const real = await guard(setup(), `echo x > "$NOPE${REAL}/bots/${EXECUTOR}/work/a.txt"`);
    const configured = await guard(setup(), `echo x > "$NOPE${ROOT}/bots/${EXECUTOR}/work/a.txt"`);
    expect(real.decision.allow).toBe(configured.decision.allow);
    expect({ approvals: real.approvals, violations: real.violations }).toEqual({ approvals: configured.approvals, violations: configured.violations });
  });
});

describe('5.2 低-2 toCenterForm 在 Unicode 规范形式不同时换算正确', () => {
  const composed = 'Café';
  const decomposed = 'Café';
  it('真实路径用分解形式、目标用合成形式：换算结果里没有多出一级目录', () => {
    expect(toCenterForm(`/Volumes/Disk/${composed}/bots/b1/mind/x`, { rootDir: '/Users/someone/AgentHub', realRootDir: `/Volumes/Disk/${decomposed}` }))
      .toBe('/Users/someone/AgentHub/bots/b1/mind/x');
  });
  it('反过来：真实路径用合成形式、目标用分解形式', () => {
    expect(toCenterForm(`/Volumes/Disk/${decomposed}/bots/b1/mind/x`, { rootDir: '/Users/someone/AgentHub', realRootDir: `/Volumes/Disk/${composed}` }))
      .toBe('/Users/someone/AgentHub/bots/b1/mind/x');
  });
  it('反例：两边形式相同、以及不在真实路径下，结果不变', () => {
    expect(toCenterForm(`/Volumes/Disk/${composed}/bots/b1/x`, { rootDir: '/Users/someone/AgentHub', realRootDir: `/Volumes/Disk/${composed}` })).toBe('/Users/someone/AgentHub/bots/b1/x');
    expect(toCenterForm('/Volumes/Other/x', { rootDir: '/Users/someone/AgentHub', realRootDir: '/Volumes/Disk/AgentHub' })).toBe('/Volumes/Other/x');
  });
});

describe('5.3 低-3 只改交付时间也通知主题刷新', () => {
  type Seen = Array<{ scope: string; botId: string | null }>;
  const eventsSeen = (fix: JobFix): Seen => (fix.ctx as unknown as { events: Seen }).events;
  it('只改交付时间、状态不变：主题刷新事件发出一次；原样再写一次不发', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    eventsSeen(fix).length = 0;
    putJob(fix.ctx, { ...job, dueAt: fix.ctx.clock.now() + 60 * MINUTE });
    expect(eventsSeen(fix).filter(row => row.scope === 'thread' && row.botId === job.topicId)).toHaveLength(1);
    eventsSeen(fix).length = 0;
    putJob(fix.ctx, { ...fix.ctx.store.table('jobs').get(job.id)! });
    expect(eventsSeen(fix).filter(row => row.scope === 'thread' && row.botId === job.topicId)).toHaveLength(0);
  });
});

describe('5.4 低-4 总管「你手上的事」与进度行口径一致', () => {
  it('参与者被停用而受阻：这一行写「在等林舟（已停用）」，与进度行一致，不写「在等总管」', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const body = chiefOverviewBody(fix.ctx, fix.chief.id);
    expect(body).toContain('，在等林舟（已停用）');
    expect(body).not.toContain('，在等总管');
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟（已停用）');
  });
});

describe('5.5 低-5 按员工的实际状态写', () => {
  it('参与者已归档：进度行写「林舟（已归档）」；停用的仍写「（已停用）」；纯函数同样', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟（已停用）');
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'retired', archivedAt: fix.ctx.clock.now() });
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟（已归档）');
    const blocked = { ...job, state: 'blocked' as const, blocked: { kind: 'participant_off' as const, no: null, text: '林舟已停用', resumeTo: 'doing' as const, since: 1 } };
    const names = { [fix.engineer.id]: '林舟' };
    expect(waitingOnOf(blocked, names, new Set([fix.engineer.id]), new Set([fix.engineer.id]))).toBe('林舟（已归档）');
    expect(waitingOnOf(blocked, names, new Set([fix.engineer.id]))).toBe('林舟（已停用）');
  });

  /** 告警条目上答复恢复在岗：员工已不是被中心停用的状态，按实际状态回答；什么都不改。 */
  async function answerAfter(patch: Record<string, unknown>) {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const item = alertItem(fix)!;
    fix.ctx.store.table('bots').patch(fix.engineer.id, patch);
    const result = await fix.hub.api.answerInbox(item.id, 'reinstate');
    expect(result).toMatchObject({ ok: false });
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('open');
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('blocked');
    return JSON.stringify(result);
  }
  it('在岗：「林舟已经在岗，不需要恢复。」（不变）', async () => {
    expect(await answerAfter({ lifecycle: 'active' })).toContain('林舟已经在岗，不需要恢复。');
  });
  it('已归档：「林舟已归档，不能恢复在岗。」', async () => {
    expect(await answerAfter({ lifecycle: 'retired', archivedAt: 1 })).toContain('林舟已归档，不能恢复在岗。');
  });
  it('被主人停用：「林舟现在是你停用的，请在员工菜单里恢复在岗。」', async () => {
    expect(await answerAfter({ lifecycle: 'paused' })).toContain('林舟现在是你停用的，请在员工菜单里恢复在岗。');
  });
});

// ---------------------------------------------------------------------------
describe('6.1 M6 恢复在岗只清因这次停用给总管排的候选', () => {
  it('总管在这件事上另有一条别的原因的候选：恢复之后它仍在，因停用排的那条被移出', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const suspendEntries = entriesOf(fix, fix.chief.id, job.id);
    expect(suspendEntries).toHaveLength(1);
    // 另一条别的原因的候选（例如执行者交回之后给总管排的）：事项键不同、证据里没有停用感知。
    const other = { ...suspendEntries[0]!, id: newId('q', fix.ctx.rng), subjectKey: `jobwake:${job.id}:${fix.chief.id}:other`,
      reason: { ...suspendEntries[0]!.reason, evidence: [] } };
    fix.ctx.store.table('queue').put(other);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(2);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    const left = entriesOf(fix, fix.chief.id, job.id);
    expect(left.map(row => row.id)).toEqual([other.id]);
  });
});

describe('6.2 M7a 说明卡失效时间的放宽要求受阻有开始时间', () => {
  it('说明记下了受阻开始时间：参与者停用期间仍有效；没有记（旧数据）：不享受放宽，按已继续进行失效', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await chiefAwake(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '林舟被停用了，暂时没有人接手',
      options: [{ title: '换小周接着做', detail: '请小周从现有的交回接着做，不改约定' }, { title: '等林舟恢复', detail: '先放着，林舟恢复后接着做' }],
      suggested: 0, reason: '小周手上空着，换人最快' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const written = fix.ctx.store.table('jobs').get(job.id)!;
    expect(written.blocked?.kind).toBe('participant_off');
    expect(written.escalation).toMatchObject({ kind: 'executor' });
    expect(written.escalation!.blockedSince).toBe(written.blocked!.since);
    expect(jobEscalationExpiry(fix.ctx, written, written.escalation!)).toBeNull();
    // 旧数据：说明上没有受阻开始时间。
    const { blockedSince: _dropped, ...legacy } = written.escalation!;
    expect(jobEscalationExpiry(fix.ctx, { ...written, escalation: legacy }, legacy)).toBe('released');
  });
});

describe('6.3 M12 核对中被结束的不是核对人的回合，不计入总管核对的次数', () => {
  /** 在已有的一条唤醒单基础上复制出一条开着的回合（用来多次结束）。 */
  function openCopy(fix: JobFix, base: ReturnType<typeof wakesOf>[number], botId: string, sessionId: string | null) {
    const copy = { ...base, id: newId('w', fix.ctx.rng), botId, sessionId, status: 'running' as const, endedAt: null, commitId: null,
      startedAt: fix.ctx.clock.now(), lastEventAt: fix.ctx.clock.now() };
    fix.ctx.store.table('wakes').put(copy);
    return copy;
  }

  it('总管自己核对、执行者交回之后还没收尾的回合被结束两次：不算核对回合，没有事件、没有「停住了」条目、状态不变', async () => {
    const s = await started([], { reviewer: '总管' });
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'checking', reviewerId: null });
    const turn = runningOf(fix, fix.engineer.id)!;
    const countEnds = () => jobEventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && typeof row.data.turnEnded === 'string').length;
    await endChainTurn(fix.ctx, turn, fix.ctx.clock.now(), 'overtime');
    const second = openCopy(fix, turn, fix.engineer.id, turn.sessionId);
    await endChainTurn(fix.ctx, second, fix.ctx.clock.now(), 'overtime');
    expect(countEnds()).toBe(0);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'checking', inboxId: null });
  });

  it('对照：总管自己的核对回合被结束，才记一次（第一次再叫总管，第二次建「没有进展」条目）', async () => {
    const s = await started([], { reviewer: '总管' });
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    const turn = runningOf(fix, fix.engineer.id)!;
    const countEnds = () => jobEventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && typeof row.data.turnEnded === 'string').length;
    const chiefSession = bot(fix, fix.chief.id).sessionId ?? null;
    await endChainTurn(fix.ctx, openCopy(fix, turn, fix.chief.id, chiefSession), fix.ctx.clock.now(), 'overtime');
    expect(countEnds()).toBe(1);
    expect(fix.ctx.store.table('jobs').get(job.id)!.inboxId).toBeNull();
    await endChainTurn(fix.ctx, openCopy(fix, turn, fix.chief.id, chiefSession), fix.ctx.clock.now(), 'overtime');
    expect(countEnds()).toBe(2);
    expect(fix.ctx.store.table('jobs').get(job.id)!.inboxId).not.toBeNull();
  });
});

describe('6.4 疑点一 总管正在跑「因员工被停用而叫醒」的回合时，主人恢复了这位员工', () => {
  it('这位员工已恢复在岗、这件事已接着做：总管换人被拒，文字逐字；换人没有发生', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await chiefAwake(fix, job.id);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ blocked: null, executorId: fix.engineer.id });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result).toEqual({ ok: false, error: '林舟已恢复在岗，这件事已接着做，不需要换人。' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ executorId: fix.engineer.id });
    // 恢复时因此排给原执行者的候选没有被换人撤掉。
    expect(entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
  });

  it('反例一：这位员工还停用着，换人照常成功', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await chiefAwake(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ executorId: fix.extras[0]!.id });
  });

  it('反例二：回合不是因员工被停用而叫醒的（总管在主人发话的回合里换人），恢复在岗之后的换人不受影响', async () => {
    const { fix, job } = await running();
    // 总管的回合：主人发话叫醒（不是停用唤醒）。执行者此刻在岗、事在做；换人本来就允许。
    const wake = wakesOf(fix, fix.chief.id).at(-1)!;
    expect(wake.reason.evidence.every(id => !(fix.ctx.store.table('percepts').get(id)?.location ?? '').includes(':suspended:'))).toBe(true);
    // 没有停用唤醒的证据：换人照常成功（在主人发话的回合里进行）。
    const open = { ...wake, id: newId('w', fix.ctx.rng), status: 'running' as const, endedAt: null, commitId: null, ownerInitiated: true,
      startedAt: fix.ctx.clock.now(), lastEventAt: fix.ctx.clock.now(), sessionId: bot(fix, fix.chief.id).sessionId };
    fix.ctx.store.table('wakes').put(open);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});
