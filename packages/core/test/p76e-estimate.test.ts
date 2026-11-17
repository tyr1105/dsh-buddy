/**
 * P76e：预计消耗（纯函数的规则、同类记录的筛选、算的时机、预算线）。
 *
 * 纯函数那部分直接给输入、断言输出；时机和预算线走真实 Hub（约定提交、主人说「定了」、总管派活），
 * 夹具与真实情况一致（总管自动创建、听吩咐、节奏最慢；执行类员工听吩咐），推进假时钟每次不超过 10 分钟。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUDGET_DEFAULTS as D, JOB_DEFAULTS } from '../src/config/defaults.js';
import { setJobBudget } from '../src/job/budget-line.js';
import { estimateFor, estimateJob, historyFor, latestEstimate, median, displayEstimate, type EstimateInput } from '../src/job/estimate.js';
import { onAgreementLocked, flushJobHooks } from '../src/job/agreement-hooks.js';
import type { JobUsage } from '../src/model/budget.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, callTool, chiefDrafts, jobFix, lockedAndAwake, ownerSays, speak } from './p74b-fixtures.js';
import { assigned } from './p74c-fixtures.js';

/** 一条同类记录（只填预计会读的几项）。 */
function usageRow(index: number, steps: { exec: number; review: number; rework: number; chief: number }, extra: Partial<JobUsage> = {}): JobUsage {
  const step = (turns: number) => ({ turns, tokens: 0 });
  return {
    id: `job_aaaaaaaa0${index}`, agreementId: 'agr_aaaaaaaaaa', category: '其他',
    steps: { align: step(1), exec: step(steps.exec), review: step(steps.review), rework: step(steps.rework), chief: step(steps.chief), launch: step(0) },
    turns: [], finalizedAt: 1, updatedAt: 1, ...extra,
  };
}

/** 纯函数的基础输入：对齐已用 1 个回合、0 token，没有同类记录。 */
function input(patch: Partial<EstimateInput> = {}): EstimateInput {
  return { hasReviewer: true, hasLaunch: false, align: { turns: 1, tokens: 0 }, history: [], turnSamples: {}, versionNo: 1, reason: 'lock', createdAt: 1000, ...patch };
}

/** 一批同类记录：每一项的执行回合数由 execs 给出，其余步骤用同一组数。 */
function rows(execs: number[], rest = { review: 1, rework: 0, chief: 0 }): JobUsage[] {
  return execs.map((exec, index) => usageRow(index, { exec, ...rest }));
}

describe('1 估计的纯函数：默认份额与同类记录', () => {
  it('没有同类记录：默认 1 + 3 + 1 + 3 + 1 = 9（对齐 1），依据 default', () => {
    const result = estimateJob(input());
    expect(result).toMatchObject({ total: 9, steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 }, basis: 'default', historyCount: 0, versionNo: 1, reason: 'lock', createdAt: 1000 });
  });

  it('对齐回合数计入总数：对齐 2 个回合 = 10', () => {
    expect(estimateJob(input({ align: { turns: 2, tokens: 0 } })).total).toBe(10);
  });

  it('1 件同类记录：不够 HISTORY_MIN，仍按默认', () => {
    const result = estimateJob(input({ history: rows([7]) }));
    expect(result).toMatchObject({ basis: 'default', historyCount: 0, steps: { exec: 3 } });
  });

  it('2 件同类记录（执行 1、5）：执行取中位数 3，依据 history，用了 2 件', () => {
    const result = estimateJob(input({ history: rows([1, 5]) }));
    expect(result).toMatchObject({ basis: 'history', historyCount: 2, steps: { exec: 3 } });
  });

  it('6 件同类记录（执行 1,2,2,3,4,9）：中位数 2.5 向上取整为 3（不是 2）', () => {
    expect(median([1, 2, 2, 3, 4, 9])).toBe(2.5);
    const result = estimateJob(input({ history: rows([1, 2, 2, 3, 4, 9]) }));
    expect(result.steps.exec).toBe(3);
  });

  it('奇数个取中间那个；没有数据的中位数为 0', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBe(0);
  });

  it('核对至少 1：同类记录里核对都是 0 回合时仍写 1', () => {
    const result = estimateJob(input({ history: rows([2, 2], { review: 0, rework: 0, chief: 0 }) }));
    expect(result.steps.review).toBe(1);
  });

  it('返工预留：中位数 0 → 1；中位数 1 → 2；中位数 5 → 取默认预留 3', () => {
    expect(estimateJob(input({ history: rows([2, 2], { review: 1, rework: 0, chief: 0 }) })).steps.rework).toBe(1);
    expect(estimateJob(input({ history: rows([2, 2], { review: 1, rework: 1, chief: 0 }) })).steps.rework).toBe(2);
    expect(estimateJob(input({ history: rows([2, 2], { review: 1, rework: 5, chief: 0 }) })).steps.rework).toBe(D.REWORK_RESERVE_DEFAULT);
  });

  it('总管：同类记录里中位数 0 就是 0（预计里不留）；有回答的事取中位数向上取整', () => {
    expect(estimateJob(input({ history: rows([2, 2], { review: 1, rework: 0, chief: 0 }) })).steps.chief).toBe(0);
    expect(estimateJob(input({ history: rows([2, 2], { review: 1, rework: 0, chief: 2 }) })).steps.chief).toBe(2);
  });

  it('总数 = 对齐 + 执行 + 核对 + 返工预留 + 总管（用同类记录时）', () => {
    // 执行中位数 3，核对 1，返工 0 → 预留 1，总管 0；对齐 1 → 1 + 3 + 1 + 1 + 0 = 6
    expect(estimateJob(input({ history: rows([2, 4]) })).total).toBe(6);
  });
});

describe('2 估计的纯函数：token 区间', () => {
  it('没有样本：每步用默认区间，对齐用已发生的实测数', () => {
    const result = estimateJob(input({ align: { turns: 1, tokens: 100_000 } }));
    // 低：对齐 + 执行 3 x 16 万 + 核对 1 x 6 万 + 返工 3 x 16 万 + 总管 1 x 6 万
    expect(result.tokenLow).toBe(100_000 + 3 * 160_000 + 60_000 + 3 * 160_000 + 60_000);
    expect(result.tokenHigh).toBe(100_000 + 3 * 390_000 + 180_000 + 3 * 390_000 + 180_000);
  });

  it('样本只有 2 个（少于 TOKEN_SAMPLE_MIN）：退回默认区间；3 个：取最小、最大', () => {
    const two = estimateJob(input({ turnSamples: { exec: [100, 200] } }));
    expect(two.tokenLow).toBe(1_080_000);
    expect(two.tokenHigh).toBe(2_700_000);
    const three = estimateJob(input({ turnSamples: { exec: [100, 300, 200] } }));
    expect(three.tokenLow).toBe(3 * 100 + 60_000 + 480_000 + 60_000);
    expect(three.tokenHigh).toBe(3 * 300 + 180_000 + 1_170_000 + 180_000);
  });

  it('对齐与发布的样本不参与预计', () => {
    const result = estimateJob(input({ turnSamples: { align: [1, 2, 3, 4], launch: [1, 2, 3, 4] } }));
    expect(result.tokenLow).toBe(1_080_000);
  });
});

describe('3 同类记录的筛选', () => {
  /** 往存储里放一件已完成的事和它的用量行。 */
  async function seedDone(fix: Awaited<ReturnType<typeof jobFix>>, index: number, patch: { acceptedAt: number; state?: 'done' | 'stopped'; category?: string; finalizedAt?: number | null; turns?: JobUsage['turns'] }) {
    const base = fix.ctx.store.table('jobs').list()[0]!;
    const id = `job_bbbbbbbb0${index}`;
    fix.ctx.store.table('jobs').put({ ...base, id, state: patch.state ?? 'done', acceptedAt: patch.acceptedAt, stoppedAt: null });
    fix.ctx.store.table('jobUsage').put(usageRow(index, { exec: index + 1, review: 1, rework: 0, chief: 0 }, {
      id, category: patch.category ?? '其他', finalizedAt: patch.finalizedAt === undefined ? 5 : patch.finalizedAt, turns: patch.turns ?? [] }));
  }

  it('只取：已定稿、同类别、已验收；停止的、未定稿的、别的类别的不算；按验收时间倒序最多 5 件', async () => {
    const fix = await jobFix();
    await assigned(fix);
    for (let i = 0; i < 7; i += 1) await seedDone(fix, i, { acceptedAt: 1000 + i });
    await seedDone(fix, 7, { acceptedAt: 5000, state: 'stopped' });
    await seedDone(fix, 8, { acceptedAt: 5001, finalizedAt: null });
    await seedDone(fix, 9, { acceptedAt: 5002, category: '表单页' });
    const { history } = historyFor(fix.ctx, '其他');
    expect(history.map(row => row.id)).toEqual(['job_bbbbbbbb06', 'job_bbbbbbbb05', 'job_bbbbbbbb04', 'job_bbbbbbbb03', 'job_bbbbbbbb02']);
    expect(historyFor(fix.ctx, '表单页').history.map(row => row.id)).toEqual(['job_bbbbbbbb09']);
  });

  it('各步回合的 token 样本只取已经记过账的回合（回合还没结束的不取）', async () => {
    const fix = await jobFix();
    await assigned(fix);
    const turn = (wakeId: string, step: 'exec' | 'review', tokens: number, ended: boolean) => ({ wakeId, step, botId: 'b_0000000002', startedAt: 1, endedAt: ended ? 2 : null, tokens });
    await seedDone(fix, 0, { acceptedAt: 1000, turns: [turn('w_0000000001', 'exec', 111, true), turn('w_0000000002', 'exec', 222, false), turn('w_0000000003', 'review', 333, true)] });
    const { turnSamples } = historyFor(fix.ctx, '其他');
    expect(turnSamples).toEqual({ exec: [111], review: [333] });
  });

  it('estimateFor 用同类记录：2 件已验收的同类事 → 依据 history，用了 2 件', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    // 这份约定本身还没有派活。同类记录：直接写两件已完成的事与用量行（另起一个夹具派一次活，取一条合法的事记录当底）。
    const other = await jobFix();
    await assigned(other);
    const base = other.ctx.store.table('jobs').list()[0]!;
    for (const i of [0, 1]) {
      fix.ctx.store.table('jobs').put({ ...base, id: `job_dddddddd0${i}`, agreementId: 'agr_zzzzzzzzzz', state: 'done', acceptedAt: 100 + i });
      fix.ctx.store.table('jobUsage').put(usageRow(i, { exec: 2 + i * 2, review: 1, rework: 0, chief: 0 }, { id: `job_dddddddd0${i}` }));
    }
    const estimate = estimateFor(fix.ctx, agreementId, 1, 'lock');
    expect(estimate).toMatchObject({ basis: 'history', historyCount: 2, steps: { exec: 3, review: 1, rework: 1, chief: 0 } });
  });
});

describe('4 算的时机', () => {
  it('约定提交新版本：写一项 draft；第一次固定：写 lock 并替换同版本的 draft（不留两项）', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    const drafted = fix.ctx.store.table('jobEstimates').get(agreement.id)!;
    expect(drafted.versions).toHaveLength(1);
    expect(drafted.versions[0]).toMatchObject({ versionNo: 1, reason: 'draft', total: expect.any(Number) });
    // 提交的那一回合还没结束，对齐只算这一个回合（账本里还没有它的用量，token 记 0）。
    expect(drafted.versions[0]!.steps.align).toBe(1);
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    const locked = fix.ctx.store.table('jobEstimates').get(agreement.id)!;
    expect(locked.versions).toHaveLength(1);
    expect(locked.versions[0]).toMatchObject({ versionNo: 1, reason: 'lock' });
    // 固定时对齐的 token 已经是账本里那个回合的实测数。
    const ledger = fix.ctx.store.log('ledger').all().filter(entry => entry.wakeId === agreement.versions[0]!.wakeId);
    expect(ledger).toHaveLength(1);
    expect(locked.versions[0]!.tokenLow).toBeGreaterThanOrEqual(Math.ceil(ledger[0]!.tokenBase!));
  });

  it('已有这件事的约定再次固定：不重算、不追加（预计只在追加和缩小范围时才改）', async () => {
    const fix = await jobFix();
    const { agreementId } = await assigned(fix);
    const before = fix.ctx.store.table('jobEstimates').get(agreementId)!;
    expect(before.versions).toHaveLength(1);
    onAgreementLocked(fix.ctx, agreementId, 1, 'confirm');
    onAgreementLocked(fix.ctx, agreementId, 1, 'amend');
    await flushJobHooks(fix.ctx);
    expect(fix.ctx.store.table('jobEstimates').get(agreementId)).toEqual(before);
  });

  it('还没有这件事的约定重复固定同一版：替换，不追加', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    onAgreementLocked(fix.ctx, agreementId, 1, 'confirm');
    await flushJobHooks(fix.ctx);
    expect(fix.ctx.store.table('jobEstimates').get(agreementId)!.versions).toHaveLength(1);
  });

  it('估计出错只记日志：约定不存在时 estimateFor 抛出中文错误，onAgreementLocked 不抛', () => {
    // 不需要真实 Hub：约定不存在的情况由 estimateFor 的入口校验。
    expect(() => estimateFor({ store: { table: () => ({ get: () => null }) } } as never, 'agr_aaaaaaaaaa', 1, 'draft')).toThrow('预计消耗：没有这份约定');
  });

  it('latestEstimate 取最新的非 draft 项；displayEstimate：已有进行中的事时待确认的版本显示当前生效那一项，没有事时待确认取 draft', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const lock = fix.ctx.store.table('jobEstimates').get(agreementId)!.versions[0]!;
    expect(latestEstimate(fix.ctx, agreementId)).toEqual(lock);
    expect(displayEstimate(fix.ctx, agreement, { no: 1, state: 'locked' })).toEqual(lock);
    // 第 2 版（重新确认中）：只有 draft，没有 lock。
    const draft = { ...lock, versionNo: 2, reason: 'draft' as const, total: 99 };
    fix.ctx.store.table('jobEstimates').put({ id: agreementId, versions: [lock, draft] });
    // P76r3（R5）：这份约定已有进行中的事：待确认的版本还没生效，卡片显示当前生效的那一项（latestEstimate），不显示这一版的 draft。
    expect(displayEstimate(fix.ctx, agreement, { no: 2, state: 'pending' })).toEqual(lock);
    expect(displayEstimate(fix.ctx, agreement, { no: 1, state: 'locked' })).toEqual(lock);
    expect(displayEstimate(fix.ctx, agreement, { no: 2, state: 'locked' })).toEqual(lock); // 第 2 版固定了但按规则没有重算：回落到最新非 draft
    expect(latestEstimate(fix.ctx, agreementId)).toEqual(lock);
    // 没有进行中的事（对齐中）：待确认的版本照旧显示这一版的 draft；这一版还没有 draft 时为 null。
    fix.ctx.store.table('jobs').remove(job.id);
    expect(displayEstimate(fix.ctx, agreement, { no: 2, state: 'pending' })).toEqual(draft);
    expect(displayEstimate(fix.ctx, agreement, { no: 3, state: 'pending' })).toBeNull();
  });
});

describe('5 预算线', () => {
  it('派活后预算线 = 预计总数 - 已用对齐（9 - 1 = 8）', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    const estimate = latestEstimate(fix.ctx, agreementId)!;
    expect(estimate.total).toBe(9);
    expect(job.turnCap).toBe(8);
    expect(job.turnCap).toBe(estimate.total - estimate.steps.align);
  });

  it('没有预计的旧约定派活：仍是 JOB_DEFAULTS.TURN_CAP（16）', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    fix.ctx.store.table('jobEstimates').remove(agreementId);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').list()[0]!.turnCap).toBe(JOB_DEFAULTS.TURN_CAP);
    expect(JOB_DEFAULTS.TURN_CAP).toBe(16);
  });

  it('预算线至少 1：预计总数不超过已用对齐时也是 1', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    const row = fix.ctx.store.table('jobEstimates').get(agreementId)!;
    fix.ctx.store.table('jobEstimates').put({ id: agreementId, versions: row.versions.map(version => ({ ...version, total: 1 })) });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').list()[0]!.turnCap).toBe(1);
  });

  it('setJobBudget：写预算线和更新时间；至少 1；没有这件事时抛出中文错误', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.clock.advance(1000);
    expect(setJobBudget(fix.ctx, job.id, 20, 'top_up')).toBe(20);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ turnCap: 20, updatedAt: fix.ctx.clock.now() });
    expect(setJobBudget(fix.ctx, job.id, 0, 'narrow')).toBe(1);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnCap).toBe(1);
    expect(() => setJobBudget(fix.ctx, 'job_zzzzzzzzzz', 5, 'assign')).toThrow('预算线：没有这件事');
  });

  it('源码里写预算线的位置：只有建记录（assign.ts）和预算线入口（budget-line.ts）两处（技能类事项的回合上限和结构定义除外）', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    const writers = files.filter(path => {
      const rel = path.slice(root.length + 1);
      if (rel.startsWith('skill/') || rel === 'model/job.ts' || rel === 'model/skill.ts') return false;
      // turnCap: 后面不是 number（排除函数参数类型）或者 turnCap + n（追加）才算写。
      return /\bturnCap:\s*(?!number\b)\S/.test(readFileSync(path, 'utf8')) || /\bturnCap \+/.test(readFileSync(path, 'utf8'));
    }).map(path => path.slice(root.length + 1)).sort();
    // job/assign.ts 建记录；job/budget-line.ts 是唯一入口；原有的三处「再给回合」（答复、选办法、恢复）P76f 起都经 budget-line.ts。
    expect(writers).toEqual(['job/assign.ts', 'job/budget-line.ts']);
  });
});
