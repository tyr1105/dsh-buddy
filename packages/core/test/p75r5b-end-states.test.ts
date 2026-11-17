/**
 * P75r5b 的测试二：记录结束时不留下「核对中」「等待改写」的更新、小结写对人（审查 L1）；
 * 核对人自己的回合还开着时又被分到新的核对（审查 L2）；check 写回「已通过」之前重新读更新（第 8 节第 1 条）。
 * 复盘、学习两种记录都有（整理的更新只有合并类，走同一个结束函数，原因写「整理回合用完」，见本文件最后一条）。
 * 夹具与真实一致：总管、执行者、评审员都是听吩咐的；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { SkillUpdateSchema, type SkillUpdate } from '../src/model/skill.js';
import { arrangeNextSteps, retroSummaryText, sweepSkillRuns } from '../src/skill/run.js';
import { newId } from '../src/util/ids.js';
import {
  MINUTE, afterExecutorProposes, bot, callTool, chiefChat, commitAndEnd, expectMigrated, flow, learnAsked, learnRun, learnerProposes, nextPacket, participantOf,
  retroRun, seedExport, threadOf, tick, updatesIn, updatesOf, type JobFix,
} from './p75i-fixtures.js';

/** 摘要行：本记录的小结文字（主题里 refId 以 retro-summary: 开头的那一条）。 */
function summaryTexts(fix: JobFix, topicId: string, runId: string): string[] {
  return threadOf(fix.ctx, topicId).filter(row => row.refId === `retro-summary:${runId}`).map(row => row.text);
}

/** 这条记录里还显示成「核对中」「等待改写」的更新数。 */
function stranded(fix: JobFix, runId: string): number {
  return fix.ctx.store.table('skillUpdates').count(row => row.runId === runId && (row.state === 'checking' || row.state === 'rewrite'));
}

/** 评审甲的参与者记为指定状态、队列里去掉他的候选，然后跑一次兜底（模拟他的回合用完或等待过期）。 */
function endReviewerAs(fix: JobFix, jobId: string, state: 'capped' | 'expired'): void {
  const row = retroRun(fix, jobId)!;
  for (const entry of fix.ctx.store.table('queue').list(item => item.botId === fix.reviewer.id)) fix.ctx.store.table('queue').remove(entry.id);
  fix.ctx.store.table('skillRuns').put({ ...row, participants: row.participants.map(item => item.botId === fix.reviewer.id
    ? { ...item, state, reason: state === 'capped' ? 'skill_cap' as const : 'skill_expired' as const } : item) });
  sweepSkillRuns(fix.ctx, fix.ctx.clock.now());
}

describe('3.1、3.2 记录结束时没有「核对中」「等待改写」的更新；小结写的是提交人', () => {
  it('复盘，核对人的回合用完（capped）：更新改为放弃、原因「复盘回合用完」；小结写林舟（提交人）的更新未完成核对，不是评审甲', async () => {
    const { fix, job, run } = await afterExecutorProposes();
    expect(updatesOf(fix)[0]!.state).toBe('checking');
    endReviewerAs(fix, job.id, 'capped');
    expect(retroRun(fix, job.id)!.endedAt).not.toBeNull();
    expect(updatesOf(fix)[0]).toMatchObject({ state: 'abandoned', abandonReason: '复盘回合用完' });
    expect(stranded(fix, run.id)).toBe(0);
    expect(summaryTexts(fix, job.topicId, run.id)).toEqual(['复盘回合用完，林舟的更新未完成核对。']);
    // 小结的文字也不含核对人的名字。
    expect(summaryTexts(fix, job.topicId, run.id).join('')).not.toContain('评审甲');
  });

  it('复盘，核对人等待超过 7 天（expired）：更新改为放弃、原因「等待超过 7 天」；小结仍是「评审甲的复盘等待超过 7 天，未进行。」（这一句本来就写这位参与者）', async () => {
    const { fix, job, run } = await afterExecutorProposes();
    endReviewerAs(fix, job.id, 'expired');
    expect(retroRun(fix, job.id)!.endedAt).not.toBeNull();
    expect(updatesOf(fix)[0]).toMatchObject({ state: 'abandoned', abandonReason: '等待超过 7 天' });
    expect(stranded(fix, run.id)).toBe(0);
    expect(summaryTexts(fix, job.topicId, run.id)).toEqual(['评审甲的复盘等待超过 7 天，未进行。']);
  });

  it('复盘，提交人的回合用完而更新在等待改写：改为放弃、原因「复盘回合用完」；小结写提交人林舟；反例：还有人能处理的更新不被放弃', async () => {
    const { fix, job, run } = await afterExecutorProposes();
    const update = updatesOf(fix)[0]!;
    // 把这条更新造成「核对不符、等待改写」，林舟的参与者回合用完、没有候选。
    fix.ctx.store.table('skillUpdates').put({ ...update, state: 'rewrite' });
    for (const entry of fix.ctx.store.table('queue').list(item => item.botId === fix.reviewer.id || item.botId === fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    const row = retroRun(fix, job.id)!;
    // 反例：此刻林舟还是 done、评审甲 queued（评审员的复盘还没做）：记录没有结束、更新保持原状。
    fix.ctx.store.table('skillRuns').put({ ...row, participants: row.participants.map(item => item.botId === fix.reviewer.id ? { ...item, state: 'running' as const } : item) });
    sweepSkillRuns(fix.ctx, fix.ctx.clock.now());
    expect(retroRun(fix, job.id)!.endedAt).toBeNull();
    expect(updatesOf(fix)[0]!.state).toBe('rewrite');
    // 林舟的回合用完、评审甲做完：记录结束，更新放弃。
    fix.ctx.store.table('skillRuns').put({ ...row, participants: row.participants.map(item => item.botId === fix.engineer.id
      ? { ...item, state: 'capped' as const, reason: 'skill_cap' as const } : item.botId === fix.reviewer.id ? { ...item, state: 'done' as const } : item) });
    sweepSkillRuns(fix.ctx, fix.ctx.clock.now());
    expect(retroRun(fix, job.id)!.endedAt).not.toBeNull();
    expect(updatesOf(fix)[0]).toMatchObject({ state: 'abandoned', abandonReason: '复盘回合用完' });
    expect(stranded(fix, run.id)).toBe(0);
    expect(summaryTexts(fix, job.topicId, run.id)).toEqual(['复盘回合用完，林舟的更新未完成核对。']);
  });

  it('学习，核对人的回合用完：更新改为放弃、原因「学习回合用完」；总管私聊里是「林舟这次学习没有完成：学习回合用完。」', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === asked.card.id)!;
    expect(await fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] })).toMatchObject({ ok: true });
    const { result } = await learnerProposes(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    const run = learnRun(fix)!;
    expect(updatesOf(fix)[0]!.state).toBe('checking');
    // 核对人（评审甲）的回合用完、没有候选：学习记录结束，更新放弃。
    for (const entry of fix.ctx.store.table('queue').list(item => item.botId === fix.reviewer.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('skillRuns').put({ ...run, participants: run.participants.map(item => item.botId === fix.reviewer.id
      ? { ...item, state: 'capped' as const, reason: 'skill_cap' as const } : item) });
    sweepSkillRuns(fix.ctx, fix.ctx.clock.now());
    expect(learnRun(fix)!.endedAt).not.toBeNull();
    expect(updatesOf(fix)[0]).toMatchObject({ state: 'abandoned', abandonReason: '学习回合用完' });
    expect(stranded(fix, run.id)).toBe(0);
    expect(chiefChat(fix).at(-1)!.text).toBe('林舟这次学习没有完成：学习回合用完。');
  });

  it('retroSummaryText 纯函数：核对人 capped、更新在核对中 → 写提交人；回合用完的参与者名下没有等待的更新 → 写他自己；纯核对人（没有出处）没有等待的更新 → 不写', async () => {
    const { fix, run } = await afterExecutorProposes();
    const update = updatesOf(fix)[0]!;
    const names = { [fix.engineer.id]: '林舟', [fix.reviewer.id]: '评审甲' };
    const withCapped = (botId: string, role: 'executor' | 'reviewer' | 'chief' | 'checker') => ({ ...run, participants: [
      { botId: fix.engineer.id, role: 'executor' as const, sourceIds: [], state: 'done' as const, reason: null },
      { botId, role, sourceIds: [], state: 'capped' as const, reason: 'skill_cap' as const }].filter((row, index, all) => all.findIndex(item => item.botId === row.botId) === index) });
    expect(retroSummaryText(withCapped(fix.reviewer.id, 'checker'), [update], names)).toBe('复盘回合用完，林舟的更新未完成核对。');
    expect(retroSummaryText(withCapped(fix.reviewer.id, 'reviewer'), [{ ...update, state: 'abandoned' }], names)).toBe('1 条未通过核对，只留在记录里。复盘回合用完，评审甲的更新未完成核对。');
    expect(retroSummaryText(withCapped(fix.reviewer.id, 'checker'), [{ ...update, state: 'abandoned' }], names)).toBe('1 条未通过核对，只留在记录里。');
  });
});

describe('8.3（审查 L2）核对人自己的复盘回合还开着时又被分到新的核对', () => {
  it('评审甲的合并唤醒还没结束（running），又来一条要他核对的更新：新候选被丢弃但不记等待过期、参与者不变；他的回合结束后补排，两条都核对完，记录正常结束，小结里没有「等待超过 7 天」', async () => {
    const { fix, job, run } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    expect(participantOf(retroRun(fix, job.id)!, fix.reviewer.id)).toMatchObject({ state: 'running' });
    const first = updatesOf(fix)[0]!;
    // 造出「又来一条」：林舟的另一条更新（核对人评审甲），走真实的 arrangeNextSteps 排他的核对唤醒；它比评审甲这个回合开始得晚。
    fix.ctx.clock.advance(MINUTE);
    const later = SkillUpdateSchema.parse({ ...first, id: newId('su', fix.ctx.rng), createdAt: fix.ctx.clock.now(), updatedAt: fix.ctx.clock.now(),
      sentences: [{ text: '核对表单页时断开接口试一次失败提示', sourceIds: first.sentences[0]!.sourceIds }] });
    fix.ctx.store.table('skillUpdates').put(later);
    arrangeNextSteps(fix.ctx, run.id, fix.engineer.id, [later]);
    await tick(fix, MINUTE);
    // 新候选因为参与者是 running 被闸门丢弃（原因 skill_stale），不是「等待超过 7 天」；参与者仍是 running。
    expect(participantOf(retroRun(fix, job.id)!, fix.reviewer.id)).toMatchObject({ state: 'running', reason: null });
    expect(fix.ctx.store.log('appraisals').all().some(row => row.suppressedBy === 'skill_expired')).toBe(false);
    expect(fix.ctx.store.log('appraisals').all().some(row => row.suppressedBy === 'skill_stale')).toBe(true);
    // 评审甲只用唤醒包里的文字：核对第一条（只列回合开始之前就在核对中的那一条）、提交自己的复盘（没有可写的）、交账。
    expect(updatesIn(packet).map(row => row.id)).toEqual([first.id]);
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: first.id, consistent: 'met', withinScope: 'met' })).toMatchObject({ ok: true });
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '好了。' });
    // 第二条在他的回合结束后由兜底补排核对唤醒，他再核对一次，记录结束。
    const second = await nextPacket(fix, fix.reviewer.id);
    expect(updatesIn(second).map(row => row.id)).toEqual([later.id]);
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: later.id, consistent: 'met', withinScope: 'met' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '好了。' });
    const end = retroRun(fix, job.id)!;
    expect(end.endedAt).not.toBeNull();
    expect(end.participants.every(row => row.state === 'done')).toBe(true);
    expect(summaryTexts(fix, job.topicId, run.id).join('')).not.toContain('等待超过 7 天');
    expect(stranded(fix, run.id)).toBe(0);
  });
});

describe('8.1 check 写回「已通过」之前重新读一次更新', () => {
  it('等待写入技能库期间这条更新被别处改成放弃：不再写回「已通过」（更新保持放弃、原因不变），并记日志；对照：没有被改动时正常写回「已通过」', async () => {
    const { fix } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    const updateId = updatesIn(packet)[0]!.id;
    // 在写入函数里插入一次状态变化：技能文件物化（writeTextAtomic）时，把这条更新改成放弃。
    const fs = fix.ctx.fs;
    const original = fs.writeTextAtomic.bind(fs);
    let hit = 0;
    fs.writeTextAtomic = async (...args: Parameters<typeof original>) => {
      hit += 1;
      const current = fix.ctx.store.table('skillUpdates').get(updateId)!;
      fix.ctx.store.table('skillUpdates').put({ ...current, state: 'abandoned', abandonReason: '别处放弃了', updatedAt: fix.ctx.clock.now() } as SkillUpdate);
      return original(...args);
    };
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'met' });
    fs.writeTextAtomic = original;
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    expect(hit).toBeGreaterThan(0);
    // 技能库已经写入了第 2 版，但更新的状态没有被旧对象覆盖回「已通过」。
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toMatchObject({ state: 'abandoned', abandonReason: '别处放弃了', versionNo: null });
  });

  it('对照：没有状态变化时，check 照常把更新写回「已通过」并记下版本号', async () => {
    const { fix } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    const updateId = updatesIn(packet)[0]!.id;
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 2 版。' });
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toMatchObject({ state: 'passed', versionNo: 2 });
  });
});
