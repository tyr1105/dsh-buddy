/**
 * P75g 的测试一：验收后安排复盘（触发表、谁复盘、出处、主题里的一句提示）。
 * 走真实链路：派活、交回、核对、返工、验收（界面命令 acceptJob），复盘由 afterJobAccepted 自动安排；
 * 夹具里总管、执行者、评审员都是听吩咐的，额度灯绿，员工在岗，当天技能类回合数为 0（每条用例开头断言）。
 * 「在等某人」的情形让那个人真的跑一个回合：只用唤醒包里的文字取 src 编号和技能名来调用工具。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { planRetro, collectRetroSources, retroHintText } from '../src/skill/retro-plan.js';
import { writeSkillVersion } from '../src/skill/store.js';
import { newId } from '../src/util/ids.js';
import type { JobReview } from '../src/model/job.js';
import {
  INTERNAL_NAMES, bot, callTool, commitAndEnd, flow, lightOf, participantOf, retroRun, retroTurn, skillKeysQueued, srcsIn, skillNamesIn, skillRefsIn, theJob, threadOf,
  type JobFix,
} from './p75g-fixtures.js';

const THIRD_BACK = { no: 3, text: '第 3 条还是不对：失败时页面没有任何提示', problem: '失败时页面没有任何提示' };

/** 前提：额度绿灯、员工在岗、听吩咐、全队今天技能类回合数为 0（不靠额度灯碰巧放行）。 */
function assertPreconditions(fix: JobFix): void {
  expect(lightOf(fix, fix.engineer.id)).toBe('green');
  for (const who of [fix.chief, fix.engineer, fix.reviewer]) {
    expect(bot(fix, who.id)).toMatchObject({ lifecycle: 'active', onDemand: true });
  }
  expect(fix.ctx.store.table('wakes').list().filter(row => /^(retro|skillcheck|tidy):/.test(row.subjectKey ?? ''))).toHaveLength(0);
}

/** 给这位员工放一条已有的自己积累的技能（直接走技能库的写入函数）。 */
async function seedSkill(fix: JobFix, botId: string, title: string, texts: string[]): Promise<void> {
  const source = SkillSourceSchema.parse({
    id: newId('ss', fix.ctx.rng), botId, kind: 'review', label: '旧事第 1 轮退回第 1 条', quote: '提示文字与约定不一致',
    relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: fix.ctx.clock.now(),
  });
  fix.ctx.store.table('skillSources').put(source);
  await writeSkillVersion(fix.ctx, {
    botId, change: 'create', newSkill: { title, whenToUse: '做表单页时用', supplements: null },
    sentences: texts.map(text => ({ text, sourceIds: [source.id] })), updateId: null, checkedBy: null, categories: ['表单页'],
  });
}

/** 清掉这件事的复盘记录、出处和技能类候选，用来在同一份数据上换一个条件重新安排。 */
function clearRetro(fix: JobFix): void {
  for (const row of fix.ctx.store.table('skillRuns').list()) fix.ctx.store.table('skillRuns').remove(row.id);
  for (const row of fix.ctx.store.table('skillSources').list()) fix.ctx.store.table('skillSources').remove(row.id);
  for (const row of fix.ctx.store.table('queue').list(entry => /^(retro|skillcheck|tidy):/.test(entry.subjectKey))) fix.ctx.store.table('queue').remove(row.id);
}

/** 主题里的全部文字（消息文本）。 */
function topicTexts(fix: JobFix): string[] {
  return threadOf(fix.ctx, theJob(fix).topicId).map(row => row.text);
}

describe('1 只用唤醒包里的文字调用成功（设计稿 A 的数据）', () => {
  it('第 1 轮退回第 3 条、验收指出第 3 条、主题里一句纠正：林舟拿到复盘回合，只靠正则取 src 与技能名，提交成功，评审员的复盘已入队', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, topicMessages: ['以后不要在提示文字里用感叹号'] });
    const run = retroRun(fix, job.id)!;
    expect(run).not.toBeNull();
    await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    // 林舟真的跑一个回合，只看唤醒包文字。
    const { packet, section } = await retroTurn(fix, fix.engineer.id);
    expect(section).toContain('这件事已由主人验收。下面是中心从记录里抄出的出处，只能从这些出处学：');
    const srcs = srcsIn(packet);
    expect(srcs.map(row => row.kind)).toEqual(['评审意见', '你的纠正', '你的纠正', '验收结果']);
    const names = skillNamesIn(packet);
    expect(names).toEqual(['表单页做法']);
    // P75r6 同步：已有技能在围栏外用编号（sk1）指代，工具参数 skill 只用唤醒包里的编号。
    const refs = skillRefsIn(packet);
    expect(refs).toEqual(['sk1']);
    const review = srcs.find(row => row.kind === '评审意见')!;
    const correction = srcs.find(row => row.label.includes('验收第'))!;
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{
      skill: refs[0], sentences: [
        { text: '失败时页面要显示明确的失败提示', sources: [review.src] },
        { text: '改完先自己断开接口试一遍', sources: [correction.src] }] }] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, text: '已提交 1 条技能更新，等评审甲核对。' });
    // 评审员的复盘唤醒已入队（合并核对与复盘）；记录里林舟 done、评审员仍 queued。
    expect(skillKeysQueued(fix, fix.reviewer.id)).toEqual([`retro:${run.id}:${fix.reviewer.id}`]);
    const after = retroRun(fix, job.id)!;
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'done' });
    expect(participantOf(after, fix.reviewer.id)).toMatchObject({ state: 'queued' });
    expect(fix.ctx.store.table('skillUpdates').list()).toMatchObject([{ botId: fix.engineer.id, state: 'checking', checkerId: fix.reviewer.id }]);
    // 按唤醒包最后一句的写法收尾：调用 hub_commit，reply 写一句。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交一条技能更新。' });
  });
});

describe('2 触发表四行，各一正一反', () => {
  it('核对退回过：复盘；一次通过：不复盘（只有同类任务记录，主题里没有新东西）', async () => {
    const back = await flow({ rejectFirst: true });
    assertPreconditions(back.fix);
    const run = retroRun(back.fix, back.job.id)!;
    expect(run.participants.map(row => [row.botId, row.role, row.state])).toEqual([[back.fix.engineer.id, 'executor', 'queued']]);
    expect(back.fix.ctx.store.table('skillSources').list().map(row => row.kind)).toEqual(['review', 'acceptance']);

    const pass = await flow({ accept: false });
    const before = threadOf(pass.fix.ctx, theJob(pass.fix).topicId).map(row => row.id);
    expect(await pass.fix.hub.api.acceptJob({ jobId: pass.job.id, stage: pass.job.stage })).toMatchObject({ ok: true });
    assertPreconditions(pass.fix);
    expect(pass.fix.ctx.store.table('jobOutcomes').count()).toBe(1);
    expect(pass.fix.ctx.store.table('skillRuns').count()).toBe(0);
    expect(pass.fix.ctx.store.table('skillSources').count()).toBe(0);
    const added = threadOf(pass.fix.ctx, theJob(pass.fix).topicId).filter(row => !before.includes(row.id));
    expect(added.length).toBeGreaterThan(0); // 验收自己的几条（完成提示、回执）照常在
    expect(added.filter(row => row.text.includes('复盘') || row.text.includes('出处') || row.refId?.startsWith('retro')).map(row => row.text)).toEqual([]);
    expect(skillKeysQueued(pass.fix, pass.fix.engineer.id)).toEqual([]);
  });

  it('验收时指出不符：复盘；直接验收：不复盘', async () => {
    const back = await flow({ ownerReturn: THIRD_BACK });
    assertPreconditions(back.fix);
    const run = retroRun(back.fix, back.job.id)!;
    expect(run.participants.map(row => row.role)).toEqual(['executor', 'reviewer']);
    expect(back.fix.ctx.store.table('skillSources').list().map(row => `${row.botId === back.fix.engineer.id ? '林舟' : '评审甲'}:${row.kind}`)).toEqual(['林舟:owner_correction', '林舟:acceptance', '评审甲:owner_correction']);
    const pass = await flow({});
    expect(pass.fix.ctx.store.table('skillRuns').count()).toBe(0);
  });

  it('主题里主人说「以后不要……」：复盘；主题里只有问答：不复盘', async () => {
    const said = await flow({ topicMessages: ['以后不要在提示文字里用感叹号'] });
    assertPreconditions(said.fix);
    const run = retroRun(said.fix, said.job.id)!;
    expect(run.participants.map(row => row.botId)).toEqual([said.fix.engineer.id]);
    // 执行者已有这一条纠正，所以附上验收结果（任务卡第 3.1 节）。
    expect(said.fix.ctx.store.table('skillSources').list().map(row => [row.kind, row.label, row.quote])).toEqual([
      ['owner_correction', '你在会员定价页主题里说的', '以后不要在提示文字里用感叹号'],
      ['acceptance', '会员定价页验收结果', '核对 1 轮，验收返工 0 次，共 2 个回合。'],
    ]);
    const asked = await flow({ topicMessages: ['这个价格页可以加个导出按钮吗？', '好的，谢谢'] });
    expect(asked.fix.ctx.store.table('skillRuns').count()).toBe(0);
  });

  it('停止的事：不复盘（同一份记录换回已完成就会复盘，证明不是数据不够）', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    clearRetro(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    await planRetro(fix.ctx, job.id);
    expect(fix.ctx.store.table('skillRuns').count()).toBe(0);
    expect(fix.ctx.store.table('skillSources').count()).toBe(0);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done' });
    await planRetro(fix.ctx, job.id);
    expect(fix.ctx.store.table('skillRuns').count()).toBe(1);
  });

  it('幂等：同一件事再安排一次，不会多出记录、出处和候选', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    const sources = fix.ctx.store.table('skillSources').count();
    const keys = skillKeysQueued(fix, fix.engineer.id);
    expect(keys).toHaveLength(1);
    await planRetro(fix.ctx, job.id);
    await planRetro(fix.ctx, job.id);
    expect(fix.ctx.store.table('skillRuns').count()).toBe(1);
    expect(fix.ctx.store.table('skillSources').count()).toBe(sources);
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual(keys);
  });
});

describe('3 漏判的核对人', () => {
  it('评审员判第 3 条符合、主人验收指出第 3 条：评审员复盘；交付时核对的第 1 条被指出（评审员没有判过符合）：评审员不复盘', async () => {
    const missed = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK });
    expect(retroRun(missed.fix, missed.job.id)!.participants.map(row => [row.role, row.state])).toEqual([['executor', 'queued'], ['reviewer', 'queued']]);
    // 指出的是第 1 条：这一条评审员当时的结论是「交付时核对」，不是符合，没有漏判。
    const other = await flow({ ownerReturn: { no: 1, text: '第 1 条不对：表单页没有按我说的样子做', problem: '没有按约定的样子做' } });
    expect(retroRun(other.fix, other.job.id)!.participants.map(row => [row.role, row.state])).toEqual([['executor', 'queued']]);
  });

  it('核对人最后一次核对里这一条是「不符」（纯函数）：不算漏判；是「沿用」：算漏判', () => {
    const review = (verdict: 'unmet' | 'carried', reviewerId: string): JobReview => ({
      id: 'jrv_0000000001', jobId: 'job_0000000001', stage: 1, round: 2, submissionId: 'jsb_0000000001', reviewerId,
      items: [{ no: 4, verdict, note: verdict === 'unmet' ? '没做' : null, fixTo: null, rechecked: false }],
      carriedNote: null, spotChecked: [], createdAt: 1,
    });
    const base = (reviews: JobReview[]) => collectRetroSources({
      title: '活动报名页',
      job: { executorId: 'b_exec', reviewerId: 'b_rev', chiefId: 'b_chief', stage: 2, assignedAt: 0, acceptedAt: 100,
        ownerReturns: [{ stage: 1, at: 50, messageId: null, items: [{ no: 4, problem: '名单里那一列是空的', fixTo: '' }] }] },
      reviews, topicOwnerMessages: [], messageTexts: {}, outcome: null,
    });
    // 只看「你的纠正（验收）」这一条给谁（判了不符的那一条评审意见另有一条出处，给执行者）。
    const correctionFor = (reviews: JobReview[]) => base(reviews).find(row => row.kind === 'owner_correction')!.botIds;
    expect(correctionFor([review('unmet', 'b_rev')])).toEqual(['b_exec']);
    expect(correctionFor([review('carried', 'b_rev')])).toEqual(['b_exec', 'b_rev']);
  });

  it('总管核对的事被指出不符、这件事没有评审员：总管 skipped、原因 no_checker、没有给总管排唤醒；执行者照常复盘', async () => {
    const { fix, job } = await flow({ checker: 'chief', rejectFirst: true, ownerReturn: THIRD_BACK });
    expect(theJob(fix).reviewerId).toBeNull();
    const run = retroRun(fix, job.id)!;
    expect(run.participants.map(row => [row.role, row.state, row.reason])).toEqual([['executor', 'queued', null], ['chief', 'skipped', 'no_checker']]);
    expect(skillKeysQueued(fix, fix.chief.id)).toEqual([]);
    expect(skillKeysQueued(fix, fix.engineer.id)).toHaveLength(1);
  });

  it('总管核对、这件事有评审员（评审员后来才加入）：总管漏判时总管复盘', async () => {
    const { fix, job } = await flow({ checker: 'chief', rejectFirst: true, ownerReturn: THIRD_BACK });
    clearRetro(fix);
    fix.ctx.store.table('jobs').patch(job.id, { reviewerId: fix.reviewer.id });
    await planRetro(fix.ctx, job.id);
    const run = retroRun(fix, job.id)!;
    expect(run.participants.map(row => [row.role, row.state])).toEqual([['executor', 'queued'], ['chief', 'queued']]);
  });
});

describe('4 被换掉的执行者、停用的参与者', () => {
  it('执行者中途被换掉：原执行者不复盘，只有现在的执行者（这件事验收时的执行者）复盘', async () => {
    const { fix, job } = await flow({ rejectFirst: true, extraEngineers: ['小周'] });
    const newcomer = fix.extras[0]!;
    clearRetro(fix);
    fix.ctx.store.table('jobs').patch(job.id, { executorId: newcomer.id });
    await planRetro(fix.ctx, job.id);
    const run = retroRun(fix, job.id)!;
    expect(run.participants.map(row => row.botId)).toEqual([newcomer.id]);
    expect(fix.ctx.store.table('skillSources').list().every(row => row.botId === newcomer.id)).toBe(true);
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([]);
    expect(skillKeysQueued(fix, newcomer.id)).toHaveLength(1);
  });

  it('参与者此刻停用记 skipped 且原因是 owner_paused，归档记 archived；在岗的照常 queued', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, accept: false });
    // 评审员停用、执行者归档，再验收：两位都 skipped，没有任何唤醒、主题里不落提示。
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { lifecycle: 'paused' });
    fix.ctx.store.table('bots').patch(fix.engineer.id, { archivedAt: fix.ctx.clock.now() });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const run = retroRun(fix, job.id)!;
    expect(run.participants.map(row => [row.role, row.state, row.reason])).toEqual([['executor', 'skipped', 'archived'], ['reviewer', 'skipped', 'owner_paused']]);
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([]);
    expect(skillKeysQueued(fix, fix.reviewer.id)).toEqual([]);
    expect(topicTexts(fix).some(text => text.includes('可学的出处'))).toBe(false);
  });

  it('执行者停用、评审员在岗：执行者 skipped，直接给评审员排复盘', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, accept: false });
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const run = retroRun(fix, job.id)!;
    expect(run.participants.map(row => [row.role, row.state, row.reason])).toEqual([['executor', 'skipped', 'owner_paused'], ['reviewer', 'queued', null]]);
    expect(skillKeysQueued(fix, fix.reviewer.id)).toEqual([`retro:${run.id}:${fix.reviewer.id}`]);
    expect(topicTexts(fix).filter(text => text.includes('可学的出处'))).toEqual(['有 2 条可学的出处，评审甲复盘一次。']);
  });
});

describe('5 出处：标签与原文逐字', () => {
  it('评审意见、验收纠正（主人原话）、验收结果各一条，标签与原文逐字；原话就是主人在主题里打的那句', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK });
    const rows = fix.ctx.store.table('skillSources').list(row => row.botId === fix.engineer.id);
    expect(rows.map(row => [row.kind, row.label, row.quote, row.relayed])).toEqual([
      ['review', '会员定价页第 1 轮退回第 3 条', '失败时没有提示改到什么程度算过：断开接口后页面显示「加载失败」', false],
      ['owner_correction', '会员定价页验收第 3 条', '第 3 条还是不对：失败时页面没有任何提示', false],
      ['acceptance', '会员定价页验收结果', `核对 ${fix.ctx.store.table('jobOutcomes').get(job.id)!.rounds} 轮，验收返工 1 次，共 ${theJob(fix).turnsUsed} 个回合。`, false],
    ]);
    // 每条都带这件事的编号、类别和来源记录。
    expect(rows.every(row => row.jobId === job.id && row.category === '其他')).toBe(true);
    expect(rows[0]!.refs).toMatchObject({ itemNo: 3 });
    expect(rows[1]!.refs).toMatchObject({ itemNo: 3 });
    // 评审员只有这一条主人原话，没有评审意见和验收结果。
    expect(fix.ctx.store.table('skillSources').list(row => row.botId === fix.reviewer.id).map(row => row.kind)).toEqual(['owner_correction']);
  });

  it('主人原话取不到时用总管转述的问题，标签末尾带「（总管转述）」、relayed 为真', () => {
    const drafts = collectRetroSources({
      title: '活动报名页',
      job: { executorId: 'b_exec', reviewerId: null, chiefId: 'b_chief', stage: 2, assignedAt: 0, acceptedAt: 100,
        ownerReturns: [{ stage: 1, at: 50, messageId: 'm_gone', items: [{ no: 2, problem: '名单里那一列是空的', fixTo: '' }] }] },
      reviews: [], topicOwnerMessages: [], messageTexts: {}, outcome: { rounds: 1, reworks: 1, turns: 6 },
    });
    expect(drafts.map(row => [row.kind, row.label, row.quote, row.relayed])).toEqual([
      ['owner_correction', '活动报名页验收第 2 条（总管转述）', '名单里那一列是空的', true],
      ['acceptance', '活动报名页验收结果', '核对 1 轮，验收返工 1 次，共 6 个回合。', false],
    ]);
  });

  it('验收结果只在执行者已有其他出处时附上；主题里已作为验收纠正出处的那句不重复算', () => {
    const base = {
      title: '活动报名页',
      job: { executorId: 'b_exec', reviewerId: null, chiefId: 'b_chief', stage: 1, assignedAt: 0, acceptedAt: 100, ownerReturns: [] as never[] },
      reviews: [], messageTexts: {}, outcome: { rounds: 1, reworks: 0, turns: 3 },
    };
    expect(collectRetroSources({ ...base, topicOwnerMessages: [] })).toEqual([]);
    const withSaid = collectRetroSources({ ...base, topicOwnerMessages: [{ id: 'm_1', text: '记住：提示文字别用感叹号', at: 10 }] });
    expect(withSaid.map(row => row.kind)).toEqual(['owner_correction', 'acceptance']);
    // 同一句话既是验收时指出不符的原话，又在主题里：只算验收纠正这一条。
    const dup = collectRetroSources({
      ...base, job: { ...base.job, stage: 2, ownerReturns: [{ stage: 1, at: 50, messageId: 'm_1', items: [{ no: 1, problem: '不对', fixTo: '' }] }] },
      messageTexts: { m_1: '第 1 条不对，别再这样做' }, topicOwnerMessages: [{ id: 'm_1', text: '第 1 条不对，别再这样做', at: 50 }],
    });
    expect(dup.map(row => row.label)).toEqual(['活动报名页验收第 1 条', '活动报名页验收结果']);
    // 派活之前、验收之后说的话不算这件事的出处。
    const outside = collectRetroSources({ ...base, topicOwnerMessages: [{ id: 'm_2', text: '记住：别再用感叹号', at: 500 }] });
    expect(outside).toEqual([]);
  });

  it('第 2 阶段起的评审意见标签写「第 s 阶段第 r 轮退回第 no 条」；原文与标签超长时按上限截断', () => {
    const review: JobReview = {
      id: 'jrv_0000000001', jobId: 'job_0000000001', stage: 2, round: 1, submissionId: 'jsb_0000000001', reviewerId: 'b_rev',
      items: [{ no: 3, verdict: 'unmet', note: '长'.repeat(500), fixTo: null, rechecked: false }], carriedNote: null, spotChecked: [], createdAt: 1,
    };
    const [row] = collectRetroSources({
      title: '活动报名页', job: { executorId: 'b_exec', reviewerId: 'b_rev', chiefId: 'b_chief', stage: 2, assignedAt: 0, acceptedAt: 100, ownerReturns: [] },
      reviews: [review], topicOwnerMessages: [], messageTexts: {}, outcome: null,
    });
    expect(row!.label).toBe('活动报名页第 2 阶段第 1 轮退回第 3 条');
    expect([...row!.quote]).toHaveLength(SKILL_DEFAULTS.SOURCE_QUOTE_MAX_CHARS);
    expect(row!.quote.startsWith('长长长')).toBe(true);
    // 标签超长时同样截到上限。
    const [long] = collectRetroSources({
      title: '很长的标题'.repeat(20), job: { executorId: 'b_exec', reviewerId: 'b_rev', chiefId: 'b_chief', stage: 1, assignedAt: 0, acceptedAt: 100, ownerReturns: [] },
      reviews: [{ ...review, stage: 1 }], topicOwnerMessages: [], messageTexts: {}, outcome: null,
    });
    expect([...long!.label]).toHaveLength(SKILL_DEFAULTS.SOURCE_LABEL_MAX_CHARS);
  });
});

describe('6 主题里的一句提示（逐字）', () => {
  it('两位复盘：「有 3 条可学的出处，林舟、评审甲各复盘一次。」，排在回执之后，不含内部名称', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, topicMessages: ['以后不要在提示文字里用感叹号'] });
    const rows = threadOf(fix.ctx, job.topicId);
    const hint = rows.find(row => row.text.includes('可学的出处'))!;
    expect(hint).toMatchObject({ from: 'hub', kind: 'system', text: '有 3 条可学的出处，林舟、评审甲各复盘一次。' });
    const receipt = rows.findIndex(row => row.refId === `receipt:${job.id}`);
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(hint)).toBeGreaterThan(receipt);
    expect(INTERNAL_NAMES.test(hint.text)).toBe(false);
  });

  it('只有一位复盘：「有 1 条可学的出处，林舟复盘一次。」；纯函数两种写法', async () => {
    const { fix, job } = await flow({ topicMessages: ['以后不要在提示文字里用感叹号'] });
    expect(threadOf(fix.ctx, job.topicId).find(row => row.text.includes('可学的出处'))!.text).toBe('有 1 条可学的出处，林舟复盘一次。');
    expect(retroHintText(3, ['林舟', '评审员'])).toBe('有 3 条可学的出处，林舟、评审员各复盘一次。');
    expect(retroHintText(2, ['林舟'])).toBe('有 2 条可学的出处，林舟复盘一次。');
  });

  it('提示里的条数不含验收结果；评审意见与纠正各算一条', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    const hint = threadOf(fix.ctx, job.topicId).find(row => row.text.includes('可学的出处'))!;
    expect(hint.text).toBe('有 1 条可学的出处，林舟复盘一次。');
    expect(fix.ctx.store.table('skillSources').count()).toBe(2); // 评审意见 + 验收结果
  });
});
