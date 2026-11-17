/**
 * P87：一件事的消耗里写出「你发起的回合」（遗留 I101）。
 *
 * 单列一栏，存在新表 jobOwnerTurns，不并入六步、不写进 jobUsage 的行：六步的回合数与 token、turnsUsed、预计都不变，
 * 只用于给你看的四处文字（回执、进度行、明细、在办的事）。
 * 走真实 Hub（总管、执行者、核对人），时钟用假时钟；条件细节用直接构造的唤醒单和数据行检验。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activeJobsView } from '../src/api/active-jobs-views.js';
import { receiptCardView } from '../src/api/job-delivery-views.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { latestEstimate } from '../src/job/estimate.js';
import { recordOwnerTurn, recordOwnerTurnFromTool, undoOwnerTurn } from '../src/job/owner-turns.js';
import { countJobTurn, refundJobTurn } from '../src/job/turns.js';
import { costLineOf, costTurnRows, ownerCostPhrase, receiptCostValue } from '../src/job/usage-text.js';
import { finalizeJobUsage } from '../src/job/usage.js';
import { JobOwnerTurnsSchema, JobUsageSchema, type EstimateVersion, type JobOwnerTurns, type JobUsage } from '../src/model/budget.js';
import { recordUsage } from '../src/quota/usage.js';
import { assigned, wakesOf } from './p74c-fixtures.js';
import { chiefTurn, delivered, ownerTypes, reopenInfo } from './p74f-fixtures.js';
import { callTool, jobFix, speak, type JobFix } from './p74b-fixtures.js';
import { addLedger, addWake } from './p76c-fixtures.js';

const TZ = 'Asia/Shanghai';

/** 总管的全部唤醒单，从旧到新。 */
function wakesOfChief(fix: JobFix) {
  return wakesOf(fix, fix.chief.id);
}

/** 这件事的用量行。 */
function usageOf(fix: JobFix, jobId: string): JobUsage {
  return fix.ctx.store.table('jobUsage').get(jobId)!;
}

/** 这件事上你发起的回合（新表的行）；没记过为 null。 */
function ownerOf(fix: JobFix, jobId: string): JobOwnerTurns | null {
  return fix.ctx.store.table('jobOwnerTurns').get(jobId);
}

/** 用量行（只给文字测试用）：六步给 [回合, token]。 */
function row(steps: Partial<Record<'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch', [number, number]>>, extra: Partial<JobUsage> = {}): JobUsage {
  const pick = (key: 'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch') => ({ turns: steps[key]?.[0] ?? 0, tokens: steps[key]?.[1] ?? 0 });
  return { id: 'job_aaaaaaaaaa', agreementId: 'agr_aaaaaaaaaa', category: '其他', turns: [], finalizedAt: null, updatedAt: 1, ...extra,
    steps: { align: pick('align'), exec: pick('exec'), review: pick('review'), rework: pick('rework'), chief: pick('chief'), launch: pick('launch') } };
}

/** 这一栏的数据行（只给文字测试用）。 */
function ownerRow(turns: number, tokens: number, extra: Partial<JobOwnerTurns> = {}): JobOwnerTurns {
  return { id: 'job_aaaaaaaaaa', total: { turns, tokens }, turns: [], updatedAt: 1, ...extra };
}

const ESTIMATE = { total: 9 } as EstimateVersion;

/** P87 之前 jobUsage 行的结构（没有任何新键）：用来证明装过 P87 的数据退回旧版本后，旧代码仍读得进来。 */
const LegacyJobUsageSchema = z.strictObject({
  id: z.string(), agreementId: z.string(), category: z.string(),
  steps: z.strictObject({ align: z.any(), exec: z.any(), review: z.any(), rework: z.any(), chief: z.any(), launch: z.any() }),
  turns: z.array(z.any()), finalizedAt: z.number().nullable(), finalUsed: z.number().optional(), finalTokens: z.number().optional(), updatedAt: z.number(),
});

describe('1 记录：派活的回合与补 token', () => {
  it('你说「定了」之后总管在你发起的回合里 assign 成功：这一栏 1 回合；记账后 token 等于账本里的数；六步、turnsUsed 不变', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    let owner = ownerOf(fix, job.id)!;
    // 这时回合还开着：已记归属、还没记账。
    expect(owner.total).toEqual({ turns: 1, tokens: 0 });
    expect(owner.turns).toHaveLength(1);
    expect(owner.turns[0]).toMatchObject({ botId: fix.chief.id, endedAt: null, tokens: 0 });
    const wakeId = owner.turns[0]!.wakeId;
    expect(fix.ctx.store.table('wakes').get(wakeId)).toMatchObject({ ownerInitiated: true });
    // 交账结束回合：记账之后补 token，与账本一致。
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    owner = ownerOf(fix, job.id)!;
    const booked = fix.ctx.store.log('ledger').all().find(entry => entry.kind === 'turn' && entry.wakeId === wakeId)!;
    expect(owner.total).toEqual({ turns: 1, tokens: Math.ceil(booked.tokenBase ?? booked.tokens) });
    expect(owner.turns[0]!.endedAt).not.toBeNull();
    // 六步、turnsUsed 与没有这一栏时相同：对齐 1，其余 0；总管一步没有这个回合。
    const usage = usageOf(fix, job.id);
    expect(usage.steps.chief).toEqual({ turns: 0, tokens: 0 });
    expect(usage.steps.align.turns).toBe(1);
    expect(usage.steps.exec.turns + usage.steps.review.turns + usage.steps.rework.turns + usage.steps.launch.turns).toBe(0);
    expect(usage.turns.every(turn => turn.wakeId !== wakeId)).toBe(true);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
  });

  it('先记账后记归属：账本里已有这张唤醒单的记账时，当场按账本补齐', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const wake = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    addLedger(fix.ctx, wake, 700);
    recordOwnerTurn(fix.ctx, wake, fix.ctx.store.table('jobs').get(job.id)!);
    const turn = ownerOf(fix, job.id)!.turns.find(item => item.wakeId === wake.id)!;
    expect(turn).toMatchObject({ tokens: 700 });
    expect(turn.endedAt).not.toBeNull();
    expect(ownerOf(fix, job.id)!.total).toEqual({ turns: 2, tokens: 700 });
  });

  it('补 token：实测向上取整；补过的不重复补；没记归属的你发起的回合记账不动这一栏', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const wake = addWake(fix.ctx, { ownerInitiated: true, jobId: job.id, status: 'running', endedAt: null, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    countJobTurn(fix.ctx, wake);
    recordUsage(fix.ctx, { botId: fix.chief.id, wakeId: wake.id, tokens: 1234, steps: 1, packetBytes: 0 });
    expect(ownerOf(fix, job.id)!.turns.find(item => item.wakeId === wake.id)).toMatchObject({ tokens: 1234 });
    const before = ownerOf(fix, job.id)!.total;
    recordUsage(fix.ctx, { botId: fix.chief.id, wakeId: wake.id, tokens: 999, steps: 1, packetBytes: 0 });
    expect(ownerOf(fix, job.id)!.total).toEqual(before);
    // 与这件事无关的你发起的回合（没有 jobId、没调工具）：记账也不进这一栏。
    const stray = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordUsage(fix.ctx, { botId: fix.chief.id, wakeId: stray.id, tokens: 5000, steps: 1, packetBytes: 0 });
    expect(ownerOf(fix, job.id)!.total).toEqual(before);
  });
});

describe('2 归属规则', () => {
  it('主人验收时退回：总管在你发起的回合里 reopen 成功，这一栏加 1（回合在总管私聊里、没有 jobId，靠工具成功记）', async () => {
    const { fix, job } = await delivered();
    const before = ownerOf(fix, job.id)!.total;
    await ownerTypes(fix, job.chiefId, '第 3 条不对：失败时页面没有任何提示');
    const packet = await chiefTurn(fix);
    const wake = wakesOfChief(fix).at(-1)!;
    expect(wake.jobId).toBeUndefined();
    expect(ownerOf(fix, job.id)!.total).toEqual(before); // 调工具之前还没记
    const seen = reopenInfo(packet);
    const result = await callTool(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[2]!, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }], missed: '核对时没有试断开接口' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === wake.id)).toBe(true);
  });

  it('带 jobId 的你发起的总管回合记一次（建唤醒单时）；同一回合里又调了 hub_job_manage 不重复', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const before = ownerOf(fix, job.id)!.total;
    const wake = addWake(fix.ctx, { ownerInitiated: true, jobId: job.id, status: 'running', endedAt: null, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    countJobTurn(fix.ctx, wake);
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
    // 不计入这件事的回合数，也不进六步。
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
    expect(usageOf(fix, job.id).steps.chief.turns).toBe(0);
    recordOwnerTurnFromTool(fix.ctx, wake, 'hub_job_manage', { mode: 'stop', jobId: job.id });
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
    expect(ownerOf(fix, job.id)!.turns.filter(turn => turn.wakeId === wake.id)).toHaveLength(1);
    // 再建一次同一张唤醒单（重试的情形）也只记一次。
    countJobTurn(fix.ctx, wake);
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
  });

  it('主题内审批答复叫醒执行者（带 jobId、你发起）：这一栏加 1，记账后补 token；六步与 turnsUsed 不变；核对人也算；不在这件事里的员工不记', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await assigned(fix);
    const before = usageOf(fix, job.id);
    const beforeOwner = ownerOf(fix, job.id)!;
    const base = { ownerInitiated: true, jobId: job.id, status: 'running' as const, endedAt: null, startedAt: fix.ctx.clock.now() };
    const wake = addWake(fix.ctx, base, fix.engineer.id);
    countJobTurn(fix.ctx, wake);
    expect(ownerOf(fix, job.id)!.total.turns).toBe(beforeOwner.total.turns + 1);
    recordUsage(fix.ctx, { botId: fix.engineer.id, wakeId: wake.id, tokens: 2222, steps: 1, packetBytes: 0 });
    const after = usageOf(fix, job.id);
    const owner = ownerOf(fix, job.id)!;
    expect(owner.turns.find(turn => turn.wakeId === wake.id)).toMatchObject({ botId: fix.engineer.id, tokens: 2222 });
    expect(owner.total.tokens).toBe(beforeOwner.total.tokens + 2222);
    expect(after.steps).toEqual(before.steps);
    expect(after.turns).toEqual(before.turns);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
    // 明细里「谁」写做这个回合的员工，步骤写「你发起」。
    expect(costTurnRows(after, { [fix.engineer.id]: '林舟' }, TZ, owner).some(item => item.who === '林舟' && item.step === '你发起' && item.tokens === '2.22K token')).toBe(true);
    // 核对人同样记。
    const reviewerWake = addWake(fix.ctx, base, fix.reviewer.id);
    countJobTurn(fix.ctx, reviewerWake);
    expect(ownerOf(fix, job.id)!.total.turns).toBe(beforeOwner.total.turns + 2);
    // 反例：不在这件事里的员工不记。
    const stranger = addWake(fix.ctx, base, fix.extras[0]!.id);
    countJobTurn(fix.ctx, stranger);
    expect(ownerOf(fix, job.id)!.total.turns).toBe(beforeOwner.total.turns + 2);
    // 工具成功的入口仍只认总管：执行者的你发起回合调用管理工具不记。
    const other = addWake(fix.ctx, { ...base, jobId: undefined }, fix.engineer.id);
    recordOwnerTurnFromTool(fix.ctx, other, 'hub_job_manage', { mode: 'answer', jobId: job.id });
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === other.id)).toBe(false);
  });

  it('你在这件事的主题里回复、总管成功调用 hub_job_manage：记一次', async () => {
    const { fix, job } = await delivered();
    const before = ownerOf(fix, job.id)!.total;
    await ownerTypes(fix, job.topicId, '第 3 条不对：失败时页面没有任何提示');
    const packet = await chiefTurn(fix);
    const wake = wakesOfChief(fix).at(-1)!;
    expect(wake.ownerInitiated).toBe(true);
    const seen = reopenInfo(packet);
    expect(await callTool(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[2]!, problem: '没有提示', fixTo: '显示加载失败' }], missed: '漏了' })).toMatchObject({ ok: true });
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
    expect(ownerOf(fix, job.id)!.turns.filter(turn => turn.wakeId === wake.id)).toHaveLength(1);
  });

  it('不是你发起的总管回合（员工提问叫醒总管）：照旧记进六步的「总管」，这一栏不变', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const before = ownerOf(fix, job.id);
    const wake = addWake(fix.ctx, { jobId: job.id, ownerInitiated: false, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    countJobTurn(fix.ctx, wake);
    recordOwnerTurnFromTool(fix.ctx, wake, 'hub_job_manage', { mode: 'answer', jobId: job.id });
    expect(usageOf(fix, job.id).steps.chief.turns).toBe(1);
    expect(ownerOf(fix, job.id)).toEqual(before);
  });

  it('你发起、但与这件事无关的总管私聊回合不记；工具调用失败的不记；别的工具成功也不记', async () => {
    const { fix, job } = await delivered();
    const before = ownerOf(fix, job.id);
    await ownerTypes(fix, job.chiefId, '随便聊聊');
    await chiefTurn(fix);
    expect(ownerOf(fix, job.id)).toEqual(before);
    // 工具调用失败（这件事已交付、等你验收时不能转交材料）：抛错，不记。
    const failed = await callTool(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, 'hub_job_manage',
      { mode: 'forward', jobId: job.id, title: '材料', text: '一段材料' });
    expect(failed.ok).toBe(false);
    expect(ownerOf(fix, job.id)).toEqual(before);
    // 别的工具成功（记一条记忆）：不是管理这件事，不记。
    const wake = wakesOfChief(fix).at(-1)!;
    recordOwnerTurnFromTool(fix.ctx, wake, 'hub_memory', { mode: 'remember' });
    expect(ownerOf(fix, job.id)).toEqual(before);
  });

  it('不是这件事的总管、技能类事项键的回合不记', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const before = ownerOf(fix, job.id);
    const jobNow = fix.ctx.store.table('jobs').get(job.id)!;
    recordOwnerTurn(fix.ctx, addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.engineer.id), jobNow);
    const retro = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now(), reason: { kind: 'reflection', detail: '复盘' } as never, subjectKey: 'retro:skr_aaaaaaaaaa:x' }, fix.chief.id);
    recordOwnerTurn(fix.ctx, retro, jobNow);
    expect(ownerOf(fix, job.id)).toEqual(before);
  });

  it('一个回合里先后操作了两件事：只记在先发生的那一件上', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const first = fix.ctx.store.table('jobs').get(job.id)!;
    const second = { ...first, id: 'job_bbbbbbbbbb' };
    fix.ctx.store.table('jobs').put(second);
    fix.ctx.store.table('jobUsage').put({ ...usageOf(fix, job.id), id: second.id });
    const wake = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurn(fix.ctx, wake, first);
    recordOwnerTurn(fix.ctx, wake, second);
    expect(ownerOf(fix, first.id)!.turns.some(turn => turn.wakeId === wake.id)).toBe(true);
    expect(ownerOf(fix, second.id)).toBeNull();
    // 同一张唤醒单在同一件事上再记也只有一项。
    recordOwnerTurn(fix.ctx, wake, first);
    expect(ownerOf(fix, first.id)!.turns.filter(turn => turn.wakeId === wake.id)).toHaveLength(1);
  });

  it('没有用量行的旧事不记、不新建', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobUsage').remove(job.id);
    fix.ctx.store.table('jobOwnerTurns').remove(job.id);
    const wake = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurn(fix.ctx, wake, fix.ctx.store.table('jobs').get(job.id)!);
    expect(fix.ctx.store.table('jobUsage').get(job.id)).toBeNull();
    expect(ownerOf(fix, job.id)).toBeNull();
  });
});

describe('2b 工具入口的细则（P87r1）', () => {
  it('hub_agreement_submit：经真实工具入口（amend）成功，记在这件事上；参数名 agreementId 被守住', async () => {
    const { fix, job } = await delivered();
    const before = ownerOf(fix, job.id)!.total;
    await ownerTypes(fix, job.chiefId, '把怎样算做完的第 2 条改一下');
    await chiefTurn(fix);
    const wake = wakesOfChief(fix).at(-1)!;
    // 主人亲口的小改动（amend，只改一句话复述）：经真实工具入口与交账，成功就记。
    const result = await callTool(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, 'hub_agreement_submit',
      { agreementId: job.agreementId, mode: 'amend', changeNote: '你亲口说的小改动', summary: '把页面做得更简洁一些' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(ownerOf(fix, job.id)!.total.turns).toBe(before.turns + 1);
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === wake.id)).toBe(true);
    // 失败的提交（业务拒绝，例如与上一版没有任何不同）不记：换一张唤醒单再提交同样的内容。
    await speak(fix, fix.chief, '已改。', { outcome: 'progress' });
    await ownerTypes(fix, job.chiefId, '再改一次');
    await chiefTurn(fix);
    const next = wakesOfChief(fix).at(-1)!;
    const again = await callTool(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, 'hub_agreement_submit',
      { agreementId: job.agreementId, mode: 'amend', changeNote: '没改', summary: '把页面做得更简洁一些' });
    expect(again.ok).toBe(false);
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === next.id)).toBe(false);
  });

  it('hub_agreement_submit：带 agreementId 就记，不限 mode（amend、revise、省略 mode、withdraw 都记）；没有 agreementId 或这件事已收尾不记', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const ids = ['amend', 'revise', undefined, 'withdraw'].map((mode, index) => {
      const wake = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() + index }, fix.chief.id);
      recordOwnerTurnFromTool(fix.ctx, wake, 'hub_agreement_submit', { ...(mode === undefined ? {} : { mode }), agreementId: job.agreementId });
      return wake.id;
    });
    for (const id of ids) expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === id), id).toBe(true);
    // 新建约定（没有 agreementId）不记。
    const created = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurnFromTool(fix.ctx, created, 'hub_agreement_submit', { title: '新约定' });
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === created.id)).toBe(false);
    // 这件事已收尾：不记。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    const closed = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurnFromTool(fix.ctx, closed, 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId });
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === closed.id)).toBe(false);
  });

  it('assign 只按约定找刚建的事：参数里多带的已停止旧事的编号被忽略；其余 mode 照旧按 jobId', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    // 旧事：同一份约定下一件已停止的事（编号不同），带着一行用量行。
    const old = { ...fix.ctx.store.table('jobs').get(job.id)!, id: 'job_cccccccccc', state: 'stopped' as const, createdAt: 1 };
    fix.ctx.store.table('jobs').put(old);
    fix.ctx.store.table('jobUsage').put({ ...usageOf(fix, job.id), id: old.id });
    const wake = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurnFromTool(fix.ctx, wake, 'hub_job_manage', { mode: 'assign', agreementId: job.agreementId, jobId: old.id });
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === wake.id)).toBe(true);
    expect(ownerOf(fix, old.id)).toBeNull();
    // 其余 mode 按 jobId：对旧事的 resume（旧事没收尾检查，按 jobId 找到就记）。
    const second = addWake(fix.ctx, { ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordOwnerTurnFromTool(fix.ctx, second, 'hub_job_manage', { mode: 'resume', jobId: old.id });
    expect(ownerOf(fix, old.id)!.turns.some(turn => turn.wakeId === second.id)).toBe(true);
  });
});

describe('3 回合被退还', () => {
  it('带 jobId 的你发起的回合被退还：这一栏撤掉对应的一项（回合数与 token 一并减）；其余项不动', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const before = ownerOf(fix, job.id)!.total;
    const wake = addWake(fix.ctx, { ownerInitiated: true, jobId: job.id, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    countJobTurn(fix.ctx, wake);
    recordUsage(fix.ctx, { botId: fix.chief.id, wakeId: wake.id, tokens: 800, steps: 1, packetBytes: 0 });
    expect(ownerOf(fix, job.id)!.total).toEqual({ turns: before.turns + 1, tokens: before.tokens + 800 });
    refundJobTurn(fix.ctx, wake);
    expect(ownerOf(fix, job.id)!.total).toEqual(before);
    expect(ownerOf(fix, job.id)!.turns.some(turn => turn.wakeId === wake.id)).toBe(false);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
  });

  it('只有这一项的这一栏撤空后，整行删掉；没记过的退还什么都不做', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const wakeId = ownerOf(fix, job.id)!.turns[0]!.wakeId;
    undoOwnerTurn(fix.ctx, { id: wakeId, startedAt: fix.ctx.clock.now() });
    expect(ownerOf(fix, job.id)).toBeNull();
    undoOwnerTurn(fix.ctx, { id: 'w_zzzzzzzzzz', startedAt: fix.ctx.clock.now() });
    expect(ownerOf(fix, job.id)).toBeNull();
  });
});

describe('4 定稿', () => {
  it('回执读定稿数：验收之后再发生的你发起的回合不改回执，但进度行、明细里看得到', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(usageOf(fix, job.id).finalizedAt).not.toBeNull();
    const finalized = ownerOf(fix, job.id)!;
    expect(finalized.finalTurns).toBe(finalized.total.turns);
    expect(finalized.finalTokens).toBe(finalized.total.tokens);
    const receipt = receiptCardView(fix.ctx, `receipt:${job.id}`)!.rows[5]!.value;
    expect(receipt).toMatch(/；另有你发起的 1 回合，约 \S+ token$/);
    // 验收之后主人又来问：这一栏照常记，定稿数与回执不变。
    const wake = addWake(fix.ctx, { ownerInitiated: true, jobId: job.id, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    countJobTurn(fix.ctx, wake);
    recordUsage(fix.ctx, { botId: fix.chief.id, wakeId: wake.id, tokens: 4000, steps: 1, packetBytes: 0 });
    const after = ownerOf(fix, job.id)!;
    expect(after.total.turns).toBe(finalized.total.turns + 1);
    expect(after.finalTurns).toBe(finalized.finalTurns);
    expect(after.finalTokens).toBe(finalized.finalTokens);
    expect(receiptCardView(fix.ctx, `receipt:${job.id}`)!.rows[5]!.value).toBe(receipt);
    const progress = jobProgressForTopic(fix.ctx, job.topicId)!;
    expect(progress.costLine).toContain('，另有你发起的 2 回合 ');
    expect(progress.costTurns!.filter(turn => turn.step === '你发起')).toHaveLength(2);
  });

  it('这一栏为 0 时定稿不写这一栏；已定稿的不再改', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    undoOwnerTurn(fix.ctx, { id: ownerOf(fix, job.id)!.turns[0]!.wakeId, startedAt: fix.ctx.clock.now() });
    finalizeJobUsage(fix.ctx, job.id);
    const usage = usageOf(fix, job.id);
    expect(usage.finalizedAt).not.toBeNull();
    expect(ownerOf(fix, job.id)).toBeNull();
    expect(receiptCostValue(usage, ESTIMATE)).not.toContain('你发起');
  });
});

describe('5 文字（逐字）', () => {
  const withOwner = row({ align: [1, 140_000], exec: [2, 700_000], review: [1, 300_000], rework: [1, 130_000] });
  const owner = ownerRow(2, 183_000);

  it('回执：有预计、没有预计；定稿数优先；定稿之后没写定稿数按 0', () => {
    const finalized = row({}, { finalUsed: 5, finalTokens: 1_270_000, finalizedAt: 9 });
    const final = ownerRow(2, 183_000, { finalTurns: 2, finalTokens: 183_000 });
    expect(receiptCostValue(finalized, ESTIMATE, final)).toBe('5 回合，预计 9；约 1.27M token；另有你发起的 2 回合，约 183K token');
    expect(receiptCostValue(finalized, null, final)).toBe('5 回合；约 1.27M token；另有你发起的 2 回合，约 183K token');
    // 已定稿而定稿数没有（定稿时这一栏为 0），之后才记的不进回执。
    expect(receiptCostValue(finalized, ESTIMATE, ownerRow(1, 5_000))).toBe('5 回合，预计 9；约 1.27M token');
    // 还没定稿：读现有合计。
    expect(receiptCostValue(row({ exec: [2, 100_000] }), ESTIMATE, ownerRow(1, 5_000))).toBe('2 回合，预计 9；约 100K token；另有你发起的 1 回合，约 5K token');
  });

  it('进度行：有预计「已用 x token」之后、分布之前；没有预计在末尾；对齐中不变', () => {
    expect(costLineOf(withOwner, ESTIMATE, {}, TZ, false, owner).costLine)
      .toBe('消耗：5 / 9 回合，已用 1.27M token，另有你发起的 2 回合 183K token　对齐 1，执行 2，核对 1，返工 1');
    expect(costLineOf(withOwner, null, {}, TZ, false, owner).costLine).toBe('消耗：已用 5 回合，1.27M token，另有你发起的 2 回合 183K token');
    expect(costLineOf(withOwner, ESTIMATE, {}, TZ, true).costLine).toBe('消耗：预计 9 回合，已用 1 回合（对齐）');
    expect(costLineOf(withOwner, null, {}, TZ, true).costLine).toBe('消耗：已用 1 回合（对齐）');
  });

  it('明细：你发起的回合也列出，步骤写「你发起」，与其余回合按开始时间合在一起排序；没记账的写进行中', () => {
    const at = (hour: number) => Date.UTC(2026, 10, 16, hour - 8, 0, 0); // 北京时间 hour 点
    const usage = row({}, { turns: [
      { wakeId: 'w_aaaaaaaaaa', step: 'exec', botId: 'b_exec', startedAt: at(11), endedAt: at(12), tokens: 300_000 },
      { wakeId: 'w_bbbbbbbbbb', step: 'review', botId: 'b_rev', startedAt: at(15), endedAt: at(16), tokens: 120_000 },
    ] });
    const own = ownerRow(2, 66_152, { turns: [
      { wakeId: 'w_cccccccccc', botId: 'b_chief', startedAt: at(10), endedAt: at(10), tokens: 66_152 },
      { wakeId: 'w_dddddddddd', botId: 'b_chief', startedAt: at(13), endedAt: null, tokens: 0 },
    ] });
    expect(costTurnRows(usage, { b_exec: '林舟', b_rev: '评审甲', b_chief: '老大' }, TZ, own)).toEqual([
      { at: '11月16日 10:00', who: '老大', step: '你发起', tokens: '66.2K token' },
      { at: '11月16日 11:00', who: '林舟', step: '执行', tokens: '300K token' },
      { at: '11月16日 13:00', who: '老大', step: '你发起', tokens: '进行中' },
      { at: '11月16日 15:00', who: '评审甲', step: '核对', tokens: '120K token' },
    ]);
  });

  it('旧数据（没有这一栏）：四处文字与没有这一栏时逐字相同；旧行读得进来', () => {
    const legacy = row({ align: [1, 140_000], exec: [2, 700_000] }, { finalUsed: 3, finalTokens: 840_000, finalizedAt: 5 });
    expect(JobUsageSchema.parse(legacy)).toEqual(legacy);
    expect(ownerCostPhrase(null)).toBeNull();
    expect(receiptCostValue(legacy, ESTIMATE)).toBe('3 回合，预计 9；约 840K token');
    expect(costLineOf(legacy, ESTIMATE, {}, TZ).costLine).toBe('消耗：3 / 9 回合，已用 840K token　对齐 1，执行 2');
    expect(costLineOf(legacy, null, {}, TZ).costLine).toBe('消耗：已用 3 回合，840K token');
    expect(costTurnRows(legacy, {}, TZ)).toEqual([]);
    // 这一栏明确为 0 回合时同样不出现。
    expect(ownerCostPhrase(ownerRow(0, 0))).toBeNull();
  });

  it('在办的事：每件事的消耗一行加「，另有你发起的 n 回合 y token」，头部合计不含这一栏', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    expect(latestEstimate(fix.ctx, agreementId)!.total).toBe(9);
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    const view = activeJobsView(fix.ctx, fix.chief.id);
    const mine = view.rows.find(item => item.key === job.id)!;
    const owned = ownerOf(fix, job.id)!.total;
    const { formatTokenCount } = await import('../src/util/token-format.js');
    expect(mine.costText).toMatch(/^\d+ \/ 9 回合　\S+ token，另有你发起的 1 回合 \S+ token$/);
    expect(mine.costText.endsWith(`，另有你发起的 1 回合 ${formatTokenCount(owned.tokens)} token`)).toBe(true);
    // 比例与头部合计不含这一栏：已用回合数只有对齐 1。
    expect(mine.costRatio).toBeCloseTo(1 / 9);
    expect(view.headText).toMatch(/共用 1 回合，/);
    // 没有这一栏的事，文字不变。
    fix.ctx.store.table('jobOwnerTurns').remove(job.id);
    expect(activeJobsView(fix.ctx, fix.chief.id).rows.find(item => item.key === job.id)!.costText).toMatch(/^\d+ \/ 9 回合　\S+ token$/);
  });

  it('六步与预计不受影响：turnsUsed 只数不是你发起的回合', async () => {
    const { fix, job } = await delivered();
    const counted = fix.ctx.store.table('wakes').list(wake => wake.jobId === job.id && !wake.ownerInitiated).length;
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(counted);
    expect(latestEstimate(fix.ctx, job.agreementId)!.total).toBe(9);
    expect(ownerOf(fix, job.id)!.total.turns).toBeGreaterThan(0);
  });
});

describe('6 回退安全（P87r1）：jobUsage 的行与 P87 之前相同，新键只在新表里', () => {
  it('做完一件带你发起回合的事（含定稿）之后，jobUsage 里的行能被没有新键的旧结构解析；新表行自己合格', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const usage = usageOf(fix, job.id);
    expect(usage.finalizedAt).not.toBeNull();
    expect(Object.keys(usage).sort()).toEqual(['agreementId', 'category', 'finalTokens', 'finalUsed', 'finalizedAt', 'id', 'steps', 'turns', 'updatedAt']);
    expect(() => LegacyJobUsageSchema.parse(usage)).not.toThrow();
    const owner = ownerOf(fix, job.id)!;
    expect(JobOwnerTurnsSchema.parse(owner)).toEqual(owner);
    expect(owner.total.turns).toBeGreaterThan(0);
  });
});
