/**
 * P75r5b 第 7 节末尾：P75i（学习、整理）新增的判断自查。
 * 自查做法：对 P75i 的几处关键判断逐一「临时去掉、跑 P75i 的测试、看有没有失败」；没有测试失败的，在这里补测试，
 * 并再做一次「临时去掉、看新测试失败、改回」（结果写在 docs/progress/P75r5b.md 的第二张表里）。
 * 本文件补的是 P75i 测试没有守着的两处：
 * - check 不能在学习回合、整理回合里用（check.ts 的 tidy、learn 判断）；
 * - 整理的提交只认「整理的员工」那一项，不认纯核对人（tidy-submit.ts 的 role 判断）。
 */
import { describe, expect, it } from 'vitest';
import { SkillUpdateSchema, type SkillUpdate } from '../src/model/skill.js';
import { tidySubjectKey } from '../src/skill/keys.js';
import { newId } from '../src/util/ids.js';
import {
  MONDAY, bot, callTool, expectMigrated, flow, learnAsked, learnRun, nextPacket, seedExport, tick, tidyRuns, tidyScene, type JobFix,
} from './p75i-fixtures.js';

/** 造一条「提交人是评审甲、核对人是 checkerId、核对中、更新时间早于任何回合」的更新。 */
function planted(fix: JobFix, runId: string, sourceId: string, checkerId: string, merge?: { into: string; from: string }): SkillUpdate {
  const kind = merge === undefined ? 'learn' : 'merge';
  const row = SkillUpdateSchema.parse({
    id: newId('su', fix.ctx.rng), botId: fix.reviewer.id, runId, kind, skillId: merge?.into ?? null,
    newSkill: merge === undefined ? { title: '植入的技能', whenToUse: '用到时', supplements: null } : null,
    mergeFromIds: merge === undefined ? [] : [merge.from], sentences: [{ text: '植入的一句', sourceIds: [sourceId] }], checkerId, state: 'checking', checks: [], rewrites: 0, versionNo: null,
    createdAt: 1, updatedAt: 1,
  });
  fix.ctx.store.table('skillUpdates').put(row);
  return row;
}

describe('check 不能在学习回合里用', () => {
  it('学习员工在自己的学习回合里去核对一条核对人写成他的更新：被拒（只能在中心叫你核对技能更新的回合里用），那条更新没有变化', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === asked.card.id)!;
    expect(await fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] })).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id);
    const run = learnRun(fix)!;
    const update = planted(fix, run.id, run.participants[0]!.sourceIds[0]!, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'check', updateId: update.id, consistent: 'met', withinScope: 'met' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('只能在中心叫你核对技能更新的回合里用');
    expect(fix.ctx.store.table('skillUpdates').get(update.id)).toEqual(update);
  });
});

describe('check 不能在整理回合里用；整理的提交不认纯核对人', () => {
  it('整理员工在自己的整理回合里去核对一条核对人写成他的更新：被拒，那条更新没有变化', async () => {
    const { fix, phone, form } = await tidyScene();
    await tick(fix, 60_000);
    await nextPacket(fix, fix.engineer.id);
    const run = tidyRuns(fix, fix.engineer.id, MONDAY)[0]!;
    const sourceId = fix.ctx.store.table('skillSources').list(row => row.botId === fix.engineer.id)[0]!.id;
    const update = planted(fix, run.id, sourceId, fix.engineer.id, { into: form, from: phone });
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'check', updateId: update.id, consistent: 'met', withinScope: 'met' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('只能在中心叫你核对技能更新的回合里用');
    expect(fix.ctx.store.table('skillUpdates').get(update.id)).toEqual(update);
  });

  it('评审甲只是林舟那条整理记录里的纯核对人（他自己没有整理记录）：在整理回合里调用 tidy 被拒（只能在中心叫你整理技能库的回合里用），林舟的整理记录不变', async () => {
    const { fix } = await tidyScene();
    await tick(fix, 60_000);
    await nextPacket(fix, fix.engineer.id);
    const run = tidyRuns(fix, fix.engineer.id, MONDAY)[0]!;
    // 评审甲自己的整理记录拿掉，只留下他在林舟这条记录里的核对人一项。
    for (const row of tidyRuns(fix, fix.reviewer.id, MONDAY).filter(item => item.id !== run.id)) fix.ctx.store.table('skillRuns').remove(row.id);
    fix.ctx.store.table('skillRuns').put({ ...run, participants: [...run.participants, { botId: fix.reviewer.id, role: 'checker' as const, sourceIds: [], state: 'queued' as const, reason: null }] });
    // 评审甲此刻在跑一个整理回合（事项键是他自己的整理键）。
    const base = fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.endedAt === null)[0]!;
    fix.ctx.store.table('wakes').put({ ...base, id: newId('w', fix.ctx.rng), botId: fix.reviewer.id, sessionId: bot(fix, fix.reviewer.id).sessionId!,
      subjectKey: tidySubjectKey(MONDAY, fix.reviewer.id), status: 'running', endedAt: null });
    const before = fix.ctx.store.table('skillRuns').get(run.id)!;
    const refused = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [] });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('只能在中心叫你整理技能库的回合里用');
    expect(fix.ctx.store.table('skillRuns').get(run.id)).toEqual(before);
  });
});
