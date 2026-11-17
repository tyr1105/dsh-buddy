/**
 * P75r5b 第 7 节：补上审查「临时去掉判断」表里没有测试守着的几处判断，以及 P75i 新增判断的自查。
 * 每一条都是：构造出「这条判断不成立就会出事」的数据，断言被拒、被拒之后什么都没有改变；
 * 做过「临时去掉这个判断、看新测试失败、改回」（结果写在 docs/progress/P75r5b.md 的两张表里）。
 * 每种「在等某人」的情形都让那个人真跑一个回合；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { SkillUpdateSchema, type SkillUpdate } from '../src/model/skill.js';
import { newId } from '../src/util/ids.js';
import {
  MINUTE, afterExecutorProposes, bot, callTool, commitAndEnd, nextPacket, participantOf, retroRun, reviewerRejects, rewriteSrcsIn, updatesOf, type JobFix,
} from './p75h-fixtures.js';

/** 技能「表单页做法」当前是第几版（核对通过会让它加一；这里用来证明什么都没写进技能库）。 */
function formSkillVersion(fix: JobFix): number {
  return fix.ctx.store.table('skills').list(row => row.title === '表单页做法')[0]!.currentVersionNo;
}

/** 在原更新的基础上造一条新更新（换编号、可覆盖字段），写进表。 */
function cloneUpdate(fix: JobFix, base: SkillUpdate, patch: Partial<SkillUpdate>): SkillUpdate {
  const row = SkillUpdateSchema.parse({ ...base, id: newId('su', fix.ctx.rng), ...patch });
  fix.ctx.store.table('skillUpdates').put(row);
  return row;
}

describe('7.1 check：更新必须属于本回合的这次记录（check.ts 的 runId 判断）', () => {
  it('评审甲在记录 A 的核对回合里，去核对记录 B 的更新：被拒（不在本回合的核对清单里），B 的更新与技能库都没有改变', async () => {
    const { fix, run } = await afterExecutorProposes();
    await nextPacket(fix, fix.reviewer.id);
    // 另一次复盘 B（照 A 复制一份，换编号），里面有一条核对人也是评审甲的更新，核对前的各项条件都满足（更新时间在回合开始之前）。
    const runB = { ...run, id: newId('sr', fix.ctx.rng) };
    fix.ctx.store.table('skillRuns').put(runB);
    const foreign = cloneUpdate(fix, updatesOf(fix)[0]!, { runId: runB.id });
    const versionBefore = formSkillVersion(fix);
    const refused = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: foreign.id, consistent: 'met', withinScope: 'met' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('这条更新不在本回合的核对清单里');
    expect(fix.ctx.store.table('skillUpdates').get(foreign.id)).toEqual(foreign);
    expect(formSkillVersion(fix)).toBe(versionBefore);
  });
});

describe('7.2 check：只能核对回合开始之前就在核对中的更新（check.ts 的回合开始时刻判断，最要紧）', () => {
  it('更新在评审甲这个回合开始之后又被改过（进入核对的时刻晚于回合开始）：被拒；技能库没有写入、更新没有变化——保证写进技能库的就是核对人看到的句子', async () => {
    const { fix } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    const update = updatesOf(fix)[0]!;
    expect(packet).toContain(update.id);
    // 回合进行中，这条更新的句子被换掉（更新时间晚于回合开始）：核对人看到的是旧句子，不能把新句子核对通过。
    fix.ctx.clock.advance(MINUTE);
    const changed = { ...update, sentences: [{ text: '一句核对人没有看过的新句子', sourceIds: update.sentences[0]!.sourceIds }], updatedAt: fix.ctx.clock.now() };
    fix.ctx.store.table('skillUpdates').put(changed);
    const versionBefore = formSkillVersion(fix);
    const refused = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: update.id, consistent: 'met', withinScope: 'met' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('本回合开始之后才提交的');
    expect(fix.ctx.store.table('skillUpdates').get(update.id)).toEqual(changed);
    expect(formSkillVersion(fix)).toBe(versionBefore);
  });
});

describe('7.3 revise：只能改写回合开始之前被退回的更新（revise.ts 的回合开始时刻判断）', () => {
  it('更新在林舟这个改写回合开始之后才被退回：被拒（本回合开始之后才退回的），更新保持原样', async () => {
    const { fix } = await afterExecutorProposes();
    const updateId = await reviewerRejects(fix);
    const packet = await nextPacket(fix, fix.engineer.id);
    const srcs = rewriteSrcsIn(packet);
    fix.ctx.clock.advance(MINUTE);
    const late = { ...fix.ctx.store.table('skillUpdates').get(updateId)!, updatedAt: fix.ctx.clock.now() };
    fix.ctx.store.table('skillUpdates').put(late);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'revise', updateId, sentences: [{ text: '失败时页面要显示明确的失败提示', sources: [srcs[0]!.src] }] });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('本回合开始之后才退回的');
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toEqual(late);
  });
});

describe('7.4 propose：改写唤醒里不能 propose（propose.ts 的 rewrite 判断，否则可以绕过「最多改写一次」，要紧）', () => {
  it('林舟在改写回合里提交一批新的更新：被拒（只能在中心叫你复盘的回合里用），没有新增任何更新，参与者状态不变', async () => {
    const { fix, job } = await afterExecutorProposes();
    await reviewerRejects(fix);
    const packet = await nextPacket(fix, fix.engineer.id);
    const srcs = rewriteSrcsIn(packet);
    const before = fix.ctx.store.table('skillUpdates').list();
    const stateBefore = participantOf(retroRun(fix, job.id)!, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [
      { title: '绕过改写的新更新', whenToUse: '做表单页时', sentences: [{ text: '失败时页面要显示明确的失败提示', sources: [srcs[0]!.src] }] }] });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('只能在中心叫你复盘的回合里用');
    expect(fix.ctx.store.table('skillUpdates').list()).toEqual(before);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toEqual(stateBefore);
  });
});

describe('7.5 check：改写唤醒里不能 check（check.ts 的 rewrite 判断）', () => {
  it('林舟在改写回合里去核对一条核对人写成林舟的更新：被拒（只能在中心叫你核对技能更新的回合里用），那条更新没有任何变化', async () => {
    const { fix } = await afterExecutorProposes();
    await reviewerRejects(fix);
    await nextPacket(fix, fix.engineer.id);
    // 另一条更新：提交人是评审甲、核对人写成林舟，状态核对中、更新时间在回合开始之前——除了回合种类不对，其余条件都满足。
    const original = updatesOf(fix)[0]!;
    const planted = cloneUpdate(fix, original, { botId: fix.reviewer.id, checkerId: fix.engineer.id, state: 'checking', checks: [], rewrites: 0, updatedAt: original.createdAt });
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'check', updateId: planted.id, consistent: 'met', withinScope: 'met' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('只能在中心叫你核对技能更新的回合里用');
    expect(fix.ctx.store.table('skillUpdates').get(planted.id)).toEqual(planted);
  });
});

describe('7.6 改写回合结束：只放弃回合开始之前退回的更新（run.ts 的 onRewriteTurnEnd 时刻判断）', () => {
  it('林舟的改写回合没有改写就结束：回合开始之前退回的那条放弃（原因「没有改写」）；回合进行中才退回的另一条保持「等待改写」（它有自己的改写唤醒）', async () => {
    const { fix } = await afterExecutorProposes();
    const first = updatesOf(fix)[0]!;
    await reviewerRejects(fix);
    await nextPacket(fix, fix.engineer.id);
    // 回合进行中，林舟的另一条更新被退回（更新时间晚于回合开始）。
    fix.ctx.clock.advance(MINUTE);
    const later = cloneUpdate(fix, first, { state: 'rewrite', checks: first.checks, rewrites: 0, createdAt: fix.ctx.clock.now(), updatedAt: fix.ctx.clock.now() });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '没有改' });
    expect(fix.ctx.store.table('skillUpdates').get(first.id)).toMatchObject({ state: 'abandoned', abandonReason: '没有改写' });
    expect(fix.ctx.store.table('skillUpdates').get(later.id)).toMatchObject({ state: 'rewrite' });
  });
});
