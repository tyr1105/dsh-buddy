/**
 * P74r16b 第 1 节的测试：员工在一件事里被中心自动停用之后的衔接。
 *
 * 夹具与真实情况一致：总管是自动创建的（听吩咐、节奏设为最慢的一档 quiet）、执行者、评审员；一件执行中的事；
 * 执行者是走真实路径被停用的（连续三次碰凭据类文件，闸门记三次越界），不直接改员工状态。
 * 覆盖：
 * 1 停用之后：这件事受阻；队列里有一条给总管的、带这件事编号的候选，没有普通团队信号；两个十分钟之内总管被叫醒
 *   （并用同一条候选去掉编号后会被「最短思考间隔」拦住作对照，证明不是靠额度灯碰巧放行）；
 * 2 总管这个回合：换人成功、向主人说明成功（「待你处理」出现说明卡）；
 * 3 告警条目：标题、正文逐字（一件事、四件事、没有事）；视图上有恢复入口；
 * 4 主人答复恢复：员工在岗、这件事接着做、告警条目关闭、给总管的候选被移出；员工已在岗时再答复被拒；
 * 5 反例：没有参与任何事的员工被停用照旧排普通团队信号；主人手动停用不排唤醒。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { inboxView } from '../src/api/feed-views.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { newId } from '../src/util/ids.js';
import { assigned, bot, entriesOf, MINUTE, runningJob, tick, wakesOf } from './p74c-fixtures.js';
import { callTool, chiefHasLockedAnother, jobFix, speak, type JobFix } from './p74b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';

// 合并 P74r16a 之后，越界达到次数的停用原因带上累计次数和最近一次的理由（P74r16a 第 3 节）。
const REASON = '越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）';

/** 走真实路径让某位员工被中心停用：连续三次碰凭据类文件（闸门拒绝并计越界，第三次停用），再让中心跑一轮把后续做完。 */
async function suspendByCredentials(fix: JobFix, botId: string): Promise<void> {
  const sessionId = bot(fix, botId).sessionId!;
  for (let i = 0; i < 3; i += 1) expect(fix.hub.guardToolCall(sessionId, 'bash', { command: 'cat ~/.ssh/id_rsa' }).allow).toBe(false);
  await fix.hub.tick();
  expect(bot(fix, botId).lifecycle).toBe('quarantined');
}

/** 执行者正在做一件事（回合开着）。返回这件事。 */
async function running(extraEngineers: string[] = ['小周']) {
  const fix = await jobFix(extraEngineers);
  const { job } = await runningJob(fix);
  return { fix, job };
}

/** 总管这件事上的候选（带这件事编号的）。 */
const chiefEntries = (fix: JobFix, jobId: string) => entriesOf(fix, fix.chief.id, jobId);

/** 复制出若干件由同一位执行者做的事（各有自己的约定与主题），用来看告警正文里最多列三件。总管的回合必须开着。 */
async function addJobs(fix: JobFix, titles: string[]): Promise<void> {
  const base = fix.ctx.store.table('jobs').list()[0]!;
  let n = 0;
  for (const title of titles) {
    n += 1;
    const agreementId = await chiefHasLockedAnother(fix, title);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    fix.ctx.store.table('jobs').put({ ...base, id: newId('job', fix.ctx.rng), agreementId, projectId: agreement.projectId,
      topicId: agreement.topicId, createdAt: base.createdAt + n, updatedAt: base.updatedAt + n });
  }
}

describe('1 停用之后总管很快被叫醒', () => {
  it('这件事受阻；队列里有一条给总管的、带这件事编号的候选，没有普通团队信号；两个十分钟之内总管被叫醒，唤醒摘要逐字', async () => {
    const { fix, job } = await running();
    const chiefWakesBefore = wakesOf(fix, fix.chief.id, job.id).length;
    await suspendByCredentials(fix, fix.engineer.id);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off' } });
    // 候选：给总管的、带这件事编号、事项键是执行链的；没有任何团队信号（事项键 team_signal: 开头）。
    const entries = chiefEntries(fix, job.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ botId: fix.chief.id, jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.chief.id}` });
    expect(entriesOf(fix, fix.chief.id).some(row => row.subjectKey.startsWith('team_signal:'))).toBe(false);
    // 对照：同一条候选去掉这件事的编号、改成普通团队信号的样子，会被「最短思考间隔」拦住（总管上次思考不到 60 分钟）。
    const now = fix.ctx.clock.now();
    const chief = bot(fix, fix.chief.id);
    expect(chief.lastThinkAt).not.toBeNull();
    expect(now - chief.lastThinkAt!).toBeLessThan(60 * MINUTE);
    const plain = { ...entries[0]!, jobId: null, subjectKey: 'team_signal:quarantined:对照', reason: { ...entries[0]!.reason, kind: 'percept' as const } };
    expect(evaluateGates(plain, buildSnapshot(fix.ctx, fix.chief.id, now, undefined), now, fix.ctx.settings)).toMatchObject({ pass: false, by: 'pace_min' });
    // 推进时钟（每次不超过 10 分钟），两次以内总管被叫醒。
    for (let i = 0; i < 2 && wakesOf(fix, fix.chief.id, job.id).length === chiefWakesBefore; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.chief.id, job.id).length).toBe(chiefWakesBefore + 1);
    // 给模型看的摘要逐字（唤醒包里的变化摘要）。
    // P74r16c 第 1 节：原因另起一小句、不再套括号（越界停用的原因本身带括号）。
    expect(lastPacket(fix, bot(fix, fix.chief.id))).toContain(`「会员定价页」：林舟已被中心停用，原因：${REASON}。这件事停在执行。`);
    // 没有另排普通团队信号：总管没有关于「林舟已停用」的团队关注感知。
    expect(fix.ctx.store.table('percepts').list(row => row.botId === fix.chief.id && row.kind === 'team_attention')).toHaveLength(0);
  });
});

describe('2 总管这个回合：换人、向主人说明都能成功', () => {
  /** 停用之后总管被叫醒，回合开着。 */
  async function chiefAwake() {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    for (let i = 0; i < 2 && !wakesOf(fix, fix.chief.id, job.id).some(row => row.status === 'running'); i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.chief.id, job.id).some(row => row.status === 'running'), '总管应该被叫醒了').toBe(true);
    return { fix, job };
  }

  it('换人：总管把执行者换成小周，成功，这件事接着做，小周被叫醒', async () => {
    const { fix, job } = await chiefAwake();
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const next = fix.ctx.store.table('jobs').get(job.id)!;
    expect(next).toMatchObject({ executorId: fix.extras[0]!.id, blocked: null });
    expect(['ready', 'doing', 'rework']).toContain(next.state);
    expect(entriesOf(fix, fix.extras[0]!.id, job.id).length + wakesOf(fix, fix.extras[0]!.id, job.id).length).toBeGreaterThan(0);
  });

  it('向主人说明：总管写说明成功，「待你处理」出现说明卡，卡上写停用的这位无法继续', async () => {
    const { fix, job } = await chiefAwake();
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '林舟被停用了，暂时没有人接手',
      options: [{ title: '换小周接着做', detail: '请小周从现有的交回接着做，不改约定' }, { title: '等林舟恢复', detail: '先放着，林舟恢复后接着做' }],
      suggested: 0, reason: '小周手上空着，换人最快' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const card = inboxView(fix.ctx).items.find(item => item.jobEntry?.kind === 'escalate');
    expect(card, '「待你处理」里应该有说明卡').toBeDefined();
    expect(card).toMatchObject({ title: '会员定价页：林舟无法继续', options: ['A　换小周接着做', 'B　等林舟恢复'] });
    expect(card!.escalationCard).not.toBeNull();
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('blocked');
  });
});

describe('3 告警条目', () => {
  it('一件事：标题和正文逐字；视图上有恢复入口（员工名字、答复取值）', async () => {
    const { fix } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert');
    expect(item).toBeDefined();
    expect(item!.title).toBe('林舟已被停用');
    expect(item!.body).toBe(`中心停用了林舟：${REASON}。「会员定价页」已停在执行，已告诉总管。`);
    expect(item!.reinstate).toEqual({ botId: fix.engineer.id, botName: '林舟', answer: 'reinstate' });
    expect(item!.options).toEqual(['知道了']);
  });

  it('四件事：正文列三件，再写「另有 1 件事也已停住。」', async () => {
    const fix = await jobFix();
    // 总管的回合开着时再提交三份约定、复制出三件由林舟做的事，之后总管交账，时间走过启动静默。
    await assigned(fix);
    await addJobs(fix, ['活动页', '报价表', '会员页']);
    await speak(fix, fix.chief, '安排好了。', { outcome: 'progress' });
    await tick(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('jobs').list().filter(row => row.executorId === fix.engineer.id)).toHaveLength(4);
    await suspendByCredentials(fix, fix.engineer.id);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    expect(item.title).toBe('林舟已被停用');
    expect(item.body).toBe(`中心停用了林舟：${REASON}。「会员定价页」已停在执行，已告诉总管。「活动页」已停在执行，已告诉总管。「报价表」已停在执行，已告诉总管。另有 1 件事也已停住。`);
    // 每件事各给总管排了一条执行链唤醒。
    expect(entriesOf(fix, fix.chief.id).filter(row => row.jobId != null)).toHaveLength(4);
  });

  it('没有参与任何事：正文只有停用和原因', async () => {
    const { fix } = await running();
    await suspendByCredentials(fix, fix.extras[0]!.id);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    expect(item.title).toBe('小周已被停用');
    expect(item.body).toBe(`中心停用了小周：${REASON}。`);
    expect(item.reinstate).toMatchObject({ botName: '小周' });
  });

  it('只有这一种告警改了标题：别的告警和没有对应员工的告警标题不变（见 m09-alerts 的既有用例）；知道了仍然关闭条目', async () => {
    const { fix } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    const result = await fix.hub.api.answerInbox(item.id, '知道了');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('closed');
    // 员工仍然是停用状态：「知道了」只关条目，不恢复员工。
    expect(bot(fix, fix.engineer.id).lifecycle).toBe('quarantined');
  });
});

describe('4 主人答复恢复', () => {
  it('答复恢复：员工在岗，这件事接着做（执行者被叫醒），告警条目关闭，队列里给总管的候选被移出', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    expect(chiefEntries(fix, job.id)).toHaveLength(1);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    const touchesBefore = entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length;
    const result = await fix.hub.api.answerInbox(item.id, item.reinstate!.answer);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(bot(fix, fix.engineer.id).lifecycle).toBe('active');
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'doing', blocked: null });
    expect(entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length).toBe(touchesBefore + 1);
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('closed');
    expect(fix.ctx.store.table('alerts').list().every(row => row.status === 'closed')).toBe(true);
    expect(inboxView(fix.ctx).items.some(row => row.type === 'alert')).toBe(false);
    // 总管还没有被叫醒，给他排的那条候选已移出，并记了审计。
    expect(chiefEntries(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.log('audit').all().some(row => row.action === 'suspend_wake_removed')).toBe(true);
    // 之后不会再有一次因「林舟已停用」的叫醒。
    const chiefWakes = wakesOf(fix, fix.chief.id, job.id).length;
    for (let i = 0; i < 2; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.chief.id, job.id).length).toBe(chiefWakes);
  });

  it('不是从告警条目恢复（在员工菜单里点恢复在岗）：告警条目同样关闭，过期的候选同样移出', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(inboxView(fix.ctx).items.some(row => row.type === 'alert')).toBe(false);
    expect(chiefEntries(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'doing', blocked: null });
  });

  it('普通团队信号也移出：没有参与任何事的员工被停用、信号已排队但还没放行，恢复在岗后候选被移出', async () => {
    const { fix } = await running();
    const otherId = fix.extras[0]!.id;
    await suspendByCredentials(fix, otherId);
    // 让中心检查一次团队信号（定时检查里做）；总管此刻有回合在跑或被拦时候选留在队列里。
    const { checkTeamSignals } = await import('../src/peer/team.js');
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    const signals = entriesOf(fix, fix.chief.id).filter(row => row.subjectKey.startsWith('team_signal:quarantined:'));
    expect(signals.length, '应该排了一条普通团队信号').toBe(1);
    await lifecycleAction(fix.ctx, { botId: otherId, action: 'reinstate' });
    expect(entriesOf(fix, fix.chief.id).filter(row => row.subjectKey.startsWith('team_signal:quarantined:'))).toHaveLength(0);
  });

  it('员工已经在岗时再答复恢复：被拒，文字逐字，什么都不改', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    // 不经过告警条目恢复员工（模拟别处已经恢复、条目还没关）。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'active' });
    expect(inboxView(fix.ctx).items.find(row => row.id === item.id)!.reinstate).toBeUndefined();
    const result = await fix.hub.api.answerInbox(item.id, 'reinstate');
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('林舟已经在岗，不需要恢复。');
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('open');
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('blocked');
  });

  it('反例：不是「员工被停用」的告警，答复 reinstate 被拒', async () => {
    const { fix } = await running();
    const { raiseAlert } = await import('../src/health/alerts.js');
    const { syncAlertItems } = await import('../src/outreach/alerts.js');
    raiseAlert(fix.ctx, { code: 'quota', botId: null, text: '额度用完', level: 'P1', immediate: true });
    await syncAlertItems(fix.ctx);
    const item = inboxView(fix.ctx).items.find(row => row.type === 'alert')!;
    expect(item.reinstate).toBeUndefined();
    expect(JSON.stringify(await fix.hub.api.answerInbox(item.id, 'reinstate'))).toContain('合法值为「知道了」');
  });
});

describe('5 反例', () => {
  it('没有参与任何事的员工被停用：照旧排普通团队信号，不排执行链唤醒', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.extras[0]!.id);
    // 总管名下这件事没有受影响：没有给总管排带这件事编号的候选。
    expect(chiefEntries(fix, job.id)).toHaveLength(0);
    const { checkTeamSignals } = await import('../src/peer/team.js');
    checkTeamSignals(fix.ctx, fix.ctx.clock.now());
    expect(fix.ctx.store.table('percepts').list(row => row.botId === fix.chief.id && row.kind === 'team_attention' && row.summary.includes('小周 已停用'))).toHaveLength(1);
    expect(entriesOf(fix, fix.chief.id).some(row => row.subjectKey.startsWith('team_signal:quarantined:'))).toBe(true);
  });

  it('主人手动停用执行者：这件事受阻，不给总管排唤醒', async () => {
    const { fix, job } = await running();
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off' } });
    expect(chiefEntries(fix, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('percepts').list(row => row.botId === fix.chief.id && row.location?.includes(':suspended:') === true)).toHaveLength(0);
    // 手动停用不产生「员工被停用」告警（那是主人自己做的决定）。
    expect(fix.ctx.store.table('alerts').list().filter(row => row.code === 'quarantine')).toHaveLength(0);
    // 进度行上在等的是这位员工（已停用），不是总管。
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟（已停用）');
  });
});
