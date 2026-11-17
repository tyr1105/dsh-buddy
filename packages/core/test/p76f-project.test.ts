/**
 * P76f：余下份额 projectJob（纯函数）与「超出预计」的原因、选项文字、token 区间写法。
 *
 * 夹具：约定固定时按默认份额估计（对齐 1、执行 3、核对 1、返工预留 3、总管 1，共 9 回合，预算线 8）；
 * 这件事取自真实 Hub 里派出的一件事（总管自动创建、执行类员工听吩咐），只改状态和待改清单，用量行手工构造。
 * 本文件不涉及额度灯：projectJob 不读额度，只读这件事、用量行和预计。
 */
import { describe, expect, it } from 'vitest';
import { budgetOptions, budgetChoiceOf, capOptionsProblem, topUpCountOf, LEGACY_TOP_UP_OPTION } from '../src/job/block-options.js';
import { overrunReasons, projectJob, usedTurnsOf } from '../src/job/budget.js';
import { budgetBody, budgetTitle, projectedChatText, reachedChatText, tokenRangeText } from '../src/job/budget-text.js';
import { emptySteps } from '../src/job/usage.js';
import type { EstimateVersion, JobUsage } from '../src/model/budget.js';
import type { Job } from '../src/model/job.js';
import { assigned } from './p74c-fixtures.js';
import { jobFix } from './p74b-fixtures.js';

/** 默认份额的预计（对齐 1、执行 3、核对 1、返工预留 3、总管 1）。 */
const ESTIMATE: EstimateVersion = {
  versionNo: 1, total: 9, steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 }, tokenLow: 0, tokenHigh: 0,
  basis: 'default', historyCount: 0, reason: 'lock', createdAt: 0,
};

/** 一份只有某几步回合数的用量行（其余为 0）。 */
function usageOf(turns: Partial<Record<'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch', number>>): Pick<JobUsage, 'steps'> {
  const steps = emptySteps();
  for (const [step, count] of Object.entries(turns)) steps[step as keyof typeof steps] = { turns: count, tokens: 0 };
  return { steps };
}

/** 派出的一件事（预算线 8），再改成指定的状态。 */
async function jobIn(state: Job['state'], patch: Partial<Job> = {}): Promise<Job> {
  const fix = await jobFix();
  const { job } = await assigned(fix);
  return { ...job, state, ...patch };
}

describe('1 projectJob：余下份额按状态取（方案 7.5 的表），额度灯不参与', () => {
  it('待开工、执行中且待改清单为空：max(1, 预计执行 - 已用执行) + 1 + 剩余返工 + 剩余总管', async () => {
    // 已用执行 1：max(1, 2) + 1 + 3 + 1 = 7；已用 1，预计共 8 = 预算线（照计划进行）。
    for (const state of ['ready', 'doing'] as const) {
      const view = projectJob(await jobIn(state), usageOf({ align: 1, exec: 1 }), ESTIMATE)!;
      expect(view, state).toMatchObject({ used: 1, remaining: 7, projected: 8, cap: 8, reasons: [] });
    }
  });

  it('执行已用满预计时仍至少还要 1 个回合：已用执行 3 且没交回，余下 max(1, 0) + 1 + 3 + 1 = 6，共 9 超出预算线 8', async () => {
    const view = projectJob(await jobIn('doing'), usageOf({ exec: 3 }), ESTIMATE)!;
    expect(view).toMatchObject({ used: 3, remaining: 6, projected: 9, cap: 8 });
    // P76r3（R7）：正好用满预计的执行回合、还在做、没有待改的条目：原因写「执行已用满预计的 3 回合」，不写「执行多用」。
    expect(view.reasons).toEqual(['执行已用满预计的 3 回合，还没有交回']);
  });

  it('核对中：1 + 剩余返工 + 剩余总管', async () => {
    const view = projectJob(await jobIn('checking'), usageOf({ exec: 3 }), ESTIMATE)!;
    expect(view).toMatchObject({ used: 3, remaining: 5, projected: 8 });
  });

  it('返工中，或执行中且待改清单不为空：1 + 1 + max(0, 剩余返工 - 2) + 剩余总管', async () => {
    // 返工中、已用返工 0：1 + 1 + max(0, 3 - 2) + 1 = 4。
    expect(projectJob(await jobIn('rework'), usageOf({ exec: 2, review: 1 }), ESTIMATE)!).toMatchObject({ used: 3, remaining: 4, projected: 7 });
    // 执行中而待改清单不为空：同样按返工算。
    const unmet = [{ no: 3, problem: '没有提示', fixTo: '显示加载失败' }];
    expect(projectJob(await jobIn('doing', { unmet }), usageOf({ exec: 2, review: 1, rework: 1 }), ESTIMATE)!).toMatchObject({ remaining: 1 + 1 + 0 + 1 });
    // 返工预留已用 3：剩余返工 0，max(0, -2) 取 0。
    expect(projectJob(await jobIn('rework'), usageOf({ rework: 3 }), ESTIMATE)!.remaining).toBe(1 + 1 + 0 + 1);
  });

  it('待你验收：剩余返工 + 剩余总管', async () => {
    expect(projectJob(await jobIn('awaiting_owner'), usageOf({ exec: 3, review: 1 }), ESTIMATE)!).toMatchObject({ used: 4, remaining: 4, projected: 8 });
    // 返工预留、总管预留都已用完：余下 0。
    expect(projectJob(await jobIn('awaiting_owner'), usageOf({ rework: 3, chief: 1 }), ESTIMATE)!.remaining).toBe(0);
  });

  it('受阻、已完成、已停止、发布环节、没有预计：返回 null（不算）', async () => {
    const usage = usageOf({ exec: 1 });
    for (const state of ['blocked', 'done', 'stopped'] as const) expect(projectJob(await jobIn(state), usage, ESTIMATE), state).toBeNull();
    // 已验收、在发布环节（发布准备中）：发布有自己的回合上限，不问。
    const done = await jobIn('done');
    expect(projectJob({ ...done, launch: { ...done.launch, state: 'preparing' } }, usage, ESTIMATE)).toBeNull();
    // 没有预计（旧数据）：不问。
    expect(projectJob(await jobIn('doing'), usage, null)).toBeNull();
  });

  it('已用不含对齐、不含发布：对齐和发布的回合数不进 used', async () => {
    const view = projectJob(await jobIn('checking'), usageOf({ align: 4, exec: 3, launch: 2 }), ESTIMATE)!;
    expect(view.used).toBe(3);
    expect(usedTurnsOf(usageOf({ align: 4, exec: 1, review: 2, rework: 3, chief: 4, launch: 5 }))).toBe(10);
  });
});

describe('2 超出预计的原因（四种，按顺序，成立才列）', () => {
  it('执行多用、返工超出预留、核对多轮、总管回答问题多用：各一例，文字逐字', () => {
    expect(overrunReasons(usageOf({ exec: 5 }), ESTIMATE)).toEqual(['执行多用 2 回合']);
    expect(overrunReasons(usageOf({ rework: 4 }), ESTIMATE)).toEqual(['返工 4 次，超出返工预留']);
    expect(overrunReasons(usageOf({ review: 3 }), ESTIMATE)).toEqual(['核对 3 轮']);
    expect(overrunReasons(usageOf({ chief: 3 }), ESTIMATE)).toEqual(['总管回答问题多用 2 回合']);
  });

  it('四种同时成立时按固定顺序列出；恰好等于预计的不列（反例）', () => {
    expect(overrunReasons(usageOf({ exec: 4, rework: 4, review: 2, chief: 2 }), ESTIMATE))
      .toEqual(['执行多用 1 回合', '返工 4 次，超出返工预留', '核对 2 轮', '总管回答问题多用 1 回合']);
    expect(overrunReasons(usageOf({ exec: 3, rework: 3, review: 1, chief: 1 }), ESTIMATE)).toEqual([]);
  });
});

describe('3 给主人看的句子（派活说明第一节逐字）', () => {
  const base = { usedAll: 5, total: 9, needAll: 11, reasons: ['执行多用 1 回合'], n: 2, tokenLow: 320_000, tokenHigh: 780_000 };

  it('标题：将超出预计、已用到预计消耗', () => {
    expect(budgetTitle('会员定价页', 'projected')).toBe('会员定价页：消耗将超出预计');
    expect(budgetTitle('会员定价页', 'reached')).toBe('会员定价页：已用到预计消耗');
  });

  it('projected 的正文六行（token 用带单位的短写法，不写「万」）', () => {
    expect(budgetBody({ reason: 'projected', ...base })).toBe([
      '已用 5 回合，预计 9，估计共需 11 回合。',
      '超出的部分：执行多用 1 回合。',
      '追加：按原约定做完，多用 2 回合，约 320K 到 780K token。',
      '缩小范围：总管用 1 个回合拟一版改动，你确认后照新版本做。',
      '暂停：用到 9 回合时停下，等你再定。',
      '在这之前，预计之内的部分照常在做。',
    ].join('\n'));
  });

  it('reached 的正文：暂停一行改为现在停下，没有最后一行；多个原因用「；」连接；原因为空写「已用到预计的回合数。」；带「目前停在」', () => {
    const text = budgetBody({ reason: 'reached', ...base, reasons: ['执行多用 1 回合', '核对 2 轮'], stuckLine: '目前停在：等评审甲核对第 1 轮交回' });
    expect(text.split('\n')).toEqual([
      '已用 5 回合，预计 9，估计共需 11 回合。',
      '超出的部分：执行多用 1 回合；核对 2 轮。',
      '追加：按原约定做完，多用 2 回合，约 320K 到 780K token。',
      '缩小范围：总管用 1 个回合拟一版改动，你确认后照新版本做。',
      '暂停：现在停下，等你再定。',
      '目前停在：等评审甲核对第 1 轮交回',
    ]);
    expect(budgetBody({ reason: 'reached', ...base, reasons: [] }).split('\n')[1]).toBe('已用到预计的回合数。');
  });

  it('token 区间换算后两端相同时只写一个；不出现「万」', () => {
    expect(tokenRangeText(320_000, 780_000)).toBe('约 320K 到 780K token');
    expect(tokenRangeText(200_000, 200_000)).toBe('约 200K token');
    expect(tokenRangeText(200_100, 200_300)).toBe('约 200K token');
    expect(budgetBody({ reason: 'projected', ...base })).not.toContain('万');
  });

  it('总管私聊三句', () => {
    expect(projectedChatText('会员定价页', 11, 9)).toBe('会员定价页预计要用 11 回合，超出约定的 9 回合，在等你决定；预计之内的部分照常在做。');
    expect(reachedChatText('会员定价页', 9, 'asked')).toBe('会员定价页已用到预计的 9 回合，超出的部分已停下，在等你决定。');
    expect(reachedChatText('会员定价页', 9, 'unasked')).toBe('会员定价页已用到预计的 9 回合，已停下，在等你决定。');
    expect(reachedChatText('会员定价页', 9, 'held')).toBe('会员定价页已用到预计的 9 回合，按你的选择已暂停。要接着做时告诉我。');
  });
});

describe('4 选项文字与校验', () => {
  it('budgetOptions(n) 三项；追加回合数 1 到 99 认，0、100、写错的不认', () => {
    expect(budgetOptions(3)).toEqual(['追加 3 个回合', '缩小范围', '暂停']);
    expect(topUpCountOf('追加 1 个回合')).toBe(1);
    expect(topUpCountOf('追加 99 个回合')).toBe(99);
    for (const bad of ['追加 0 个回合', '追加 100 个回合', '追加 个回合', '追加2个回合', '再给 8 个回合']) expect(topUpCountOf(bad), bad).toBeNull();
  });

  it('答复文字对应的办法：追加（带回合数）、缩小范围、暂停；旧选项按追加 8 个处理；其余为空', () => {
    expect(budgetChoiceOf('追加 4 个回合')).toEqual({ kind: 'top_up', n: 4 });
    expect(budgetChoiceOf('缩小范围')).toEqual({ kind: 'narrow' });
    expect(budgetChoiceOf('暂停')).toEqual({ kind: 'hold' });
    expect(budgetChoiceOf(LEGACY_TOP_UP_OPTION)).toEqual({ kind: 'top_up', n: 8 });
    expect(budgetChoiceOf('先停下')).toBeNull();
  });

  it('条目建立时的选项校验：新条目三项、旧条目两项通过，其余写法被拒', () => {
    expect(capOptionsProblem(budgetOptions(5))).toBeNull();
    expect(capOptionsProblem(['再给 8 个回合', '暂停'])).toBeNull();
    expect(capOptionsProblem(['追加 5 个回合', '暂停'])).not.toBeNull();
    expect(capOptionsProblem(['追加 0 个回合', '缩小范围', '暂停'])).not.toBeNull();
    expect(capOptionsProblem(['追加 5 个回合', '缩小范围', '先停下'])).not.toBeNull();
  });
});
