/**
 * P73c 启动与三问验收：自动建总管、三问的点选与打字、选文件夹建项目、重复作答被拒、
 * 全程不调用模型（宿主没有创建会话、没有投递、队列为空）。
 */
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { NO_CHIEF_ALERT_CODE } from '../src/team/chief.js';
import { TEAM_OPENING_TEXT, TEAM_QUESTIONS } from '../src/team/rules.js';
import { TEAM_PROJECT_NOTE, TEAM_REASK_TEXT } from '../src/team/setup.js';
import {
  answerAll, expectNoModelWork, modelCalls, okData, pick, presetBot, teamHub, theProposal, theSetup, thread,
} from './p73c-fixtures.js';

describe('启动：自动建总管并开始三问', () => {
  it('1. 空存档启动：建了总管（听吩咐、来历 auto_chief），私聊有开场白和第一问，没有投递唤醒', async () => {
    const { ctx, chief } = await teamHub();
    expect(chief).toMatchObject({ name: '总管', role: 'chief', lifecycle: 'active', onDemand: true, autonomy: 'L1', pace: 'quiet' });
    expect(ctx.store.table('bots').count()).toBe(1);
    expect(ctx.store.table('botOrigins').get(chief!.id)).toMatchObject({
      source: 'auto_chief', templateId: 'project-manager', proposalId: null, joinedAt: ctx.clock.now(),
    });
    const setup = theSetup(ctx);
    expect(setup).toMatchObject({ state: 'asking', step: 1, chiefId: chief!.id, proposalId: null });
    const rows = thread(ctx, chief!.id);
    expect(rows.map(row => [row.from, row.kind])).toEqual([[chief!.id, 'chat'], [chief!.id, 'team_question']]);
    expect(rows[0]!.text).toBe(TEAM_OPENING_TEXT);
    expect(rows[1]).toMatchObject({ text: TEAM_QUESTIONS[0].question, refId: setup.id });
    expect(setup.questionMessageIds).toEqual([rows[1]!.id]);
    expect(ctx.store.table('bots').get(chief!.id)!.activityText).toBe('正在为你组建团队，需要你回答 3 个问题。');
    expectNoModelWork(ctx);
  });

  it('2. 已有一位总管和一位工程师：不新建总管，三问为 skipped，没有新消息', async () => {
    const { ctx } = await teamHub({
      before: async c => { await presetBot(c, 1, { role: 'chief', name: '老总管' }); await presetBot(c, 2, { name: '工程师' }); },
    });
    expect(ctx.store.table('bots').count()).toBe(2);
    expect(theSetup(ctx)).toMatchObject({ state: 'skipped' });
    expect(ctx.store.log('thread').all()).toEqual([]);
    expectNoModelWork(ctx);
  });

  it('3. 已有一位工程师、没有总管：补建总管，三问为 skipped；在册已满且没有总管：不建，有一条告警', async () => {
    const withEngineer = await teamHub({ before: async c => { await presetBot(c, 1, { name: '工程师' }); } });
    expect(withEngineer.chief).toMatchObject({ role: 'chief', name: '总管' });
    expect(withEngineer.ctx.store.table('bots').count()).toBe(2);
    expect(theSetup(withEngineer.ctx)).toMatchObject({ state: 'skipped' });
    expect(withEngineer.ctx.store.log('thread').all()).toEqual([]);

    const full = await teamHub({ before: async c => { for (let i = 1; i <= 6; i += 1) await presetBot(c, i); } });
    expect(full.chief).toBeNull();
    expect(full.ctx.store.table('bots').count()).toBe(6);
    expect(full.ctx.store.table('teamSetups').count()).toBe(0);
    const alerts = full.ctx.store.table('alerts').list(row => row.code === NO_CHIEF_ALERT_CODE && row.status === 'open');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toBe('在册已满 6 位，没有总管。请先归档一位员工，中心会自动补建总管。');
    // 重启一次，同一告警码仍然只开一条。
    await full.hub.stop();
    const again = createHub({ ...full.ctx, settings: { ...full.ctx.settings } });
    await again.start();
    expect(full.ctx.store.table('alerts').list(row => row.code === NO_CHIEF_ALERT_CODE && row.status === 'open')).toHaveLength(1);
  });

  it('4. 第二次启动不重复建总管，不重复发开场白', async () => {
    const fix = await teamHub();
    await fix.hub.stop();
    const again = createHub({ ...fix.ctx, settings: { ...fix.ctx.settings } });
    await again.start();
    expect(fix.ctx.store.table('bots').count()).toBe(1);
    expect(fix.ctx.store.table('teamSetups').count()).toBe(1);
    expect(thread(fix.ctx, fix.chief!.id)).toHaveLength(2);
    expectNoModelWork(fix.ctx);
  });
});

describe('三问：点选', () => {
  it('5. 每问落主人消息、「已记下」和下一问；答完落结论句、卡片和「待你处理」条目；全程没有投递唤醒', async () => {
    const fix = await teamHub();
    const { ctx, chief } = fix;
    okData(await pick(fix, 1, 'software'));
    expect(thread(ctx, chief!.id).slice(2).map(row => [row.from === 'owner' ? 'owner' : 'chief', row.kind, row.text])).toEqual([
      ['owner', 'chat', '做软件产品：网页、小工具、插件'],
      ['chief', 'chat', '已记下：以做软件产品为主。'],
      ['chief', 'team_question', TEAM_QUESTIONS[1].question],
    ]);
    expect(theSetup(ctx)).toMatchObject({ step: 2, answers: { work: 'software', workText: null } });
    okData(await pick(fix, 2, 'no'));
    expect(theSetup(ctx)).toMatchObject({ step: 3, answers: { hasProject: false, projectId: null } });
    okData(await pick(fix, 3, 'each_done'));
    const rows = thread(ctx, chief!.id);
    const tail = rows.slice(-4);
    expect(tail.map(row => row.kind)).toEqual(['chat', 'chat', 'chat', 'team']);
    // 顺序：主人的选择、「已记下」、结论句（在前）、卡片（在后）。
    expect(tail[0]).toMatchObject({ from: 'owner', text: '每件事做完都告诉我' });
    expect(tail[1]!.text).toBe('已记下：每件事做完都告诉你。');
    expect(tail[2]!.text).toContain('我建议先安排 3 位');
    expect(tail[3]).toMatchObject({ from: chief!.id, refId: theProposal(ctx).id });
    expect(theSetup(ctx)).toMatchObject({ state: 'proposed', proposalId: theProposal(ctx).id, answers: { notify: 'each_done' } });
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(1);
    expect(ctx.store.table('bots').get(chief!.id)!.activityText).toBe('等你确认新员工');
    expectNoModelWork(ctx);
  });

  it('6. 第二问点「有」带文件夹：建了项目（负责人与成员都是总管，背景含路径）；不带文件夹报错不前进', async () => {
    const fix = await teamHub();
    const { ctx, chief } = fix;
    okData(await pick(fix, 1, 'research'));
    const missing = await pick(fix, 2, 'yes');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('folderPath');
    expect(theSetup(ctx)).toMatchObject({ step: 2, answers: { hasProject: null } });
    expect(ctx.store.table('projects').count()).toBe(0);
    const relative = await pick(fix, 2, 'yes', { folderPath: 'relative/dir' });
    expect(relative.ok).toBe(false);
    expect(ctx.store.table('projects').count()).toBe(0);
    okData(await pick(fix, 2, 'yes', { folderPath: '/Users/x/demo/' }));
    const project = ctx.store.table('projects').list()[0]!;
    expect(project).toMatchObject({ name: 'demo', ownerBotId: chief!.id, memberBotIds: [chief!.id] });
    expect(project.context.background).toContain('项目文件夹：/Users/x/demo/');
    expect(theSetup(ctx)).toMatchObject({ step: 3, answers: { hasProject: true, projectId: project.id, projectFolder: '/Users/x/demo/' } });
    const texts = thread(ctx, chief!.id).map(row => row.text);
    expect(texts).toContain('有，项目文件夹：demo');
    expect(texts).toContain(`已记下：项目「demo」。${TEAM_PROJECT_NOTE}`);
    expectNoModelWork(ctx);
  });

  it('6b. 文件夹名与现有项目重名时加序号；路径只有斜杠时用「我的项目」', async () => {
    const fix = await teamHub();
    okData(await fix.hub.api.saveProject({ name: 'demo', memberBotIds: [fix.chief!.id] }));
    okData(await pick(fix, 1, 'watch'));
    okData(await pick(fix, 2, 'yes', { folderPath: '/Users/x/demo' }));
    expect(fix.ctx.store.table('projects').list().map(row => row.name).sort()).toEqual(['demo', 'demo2']);

    const other = await teamHub();
    okData(await pick(other, 1, 'watch'));
    okData(await pick(other, 2, 'yes', { folderPath: '/' }));
    expect(other.ctx.store.table('projects').list()[0]!.name).toBe('我的项目');
  });
});

describe('三问：打字', () => {
  it('7. 第一问发「做网页」记为 software；第二问「有的」重问；给路径建项目；第三问「随便」按建议项；全程没有投递唤醒', async () => {
    const fix = await teamHub();
    const { ctx, chief, hub } = fix;
    okData(await hub.api.sendMessage(chief!.id, '做网页'));
    expect(theSetup(ctx)).toMatchObject({ step: 2, answers: { work: 'software', workText: '做网页' } });
    expect(thread(ctx, chief!.id).slice(2).map(row => row.text)).toEqual(['做网页', '已记下：以做软件产品为主。', TEAM_QUESTIONS[1].question]);
    expectNoModelWork(ctx);

    okData(await hub.api.sendMessage(chief!.id, '有的'));
    expect(theSetup(ctx)).toMatchObject({ step: 2, answers: { hasProject: null } });
    expect(thread(ctx, chief!.id).at(-1)).toMatchObject({ from: chief!.id, kind: 'chat', text: TEAM_REASK_TEXT });

    okData(await hub.api.sendMessage(chief!.id, '/Users/x/demo'));
    expect(theSetup(ctx)).toMatchObject({ step: 3, answers: { hasProject: true, projectFolder: '/Users/x/demo' } });
    expect(ctx.store.table('projects').list()[0]).toMatchObject({ name: 'demo', ownerBotId: chief!.id });

    okData(await hub.api.sendMessage(chief!.id, '随便'));
    expect(theSetup(ctx)).toMatchObject({ state: 'proposed', answers: { notify: 'decisions' } });
    expect(thread(ctx, chief!.id).map(row => row.text)).toContain('已记下：只在需要你拍板时找你。');
    expect(theProposal(ctx).candidates).toHaveLength(3);
    expectNoModelWork(ctx);
  });

  it('7b. 第一问打字没命中关键词：按以上都有处理，「已记下」引用原话；命中两类也按以上都有', async () => {
    const fix = await teamHub();
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '帮我随便弄点东西'));
    expect(theSetup(fix.ctx)).toMatchObject({ step: 2, answers: { work: 'mixed', workText: '帮我随便弄点东西' } });
    expect(thread(fix.ctx, fix.chief!.id).map(row => row.text)).toContain('已记下：你说的是「帮我随便弄点东西」，看不出偏哪一类，先按三类都有来安排。');
    expectNoModelWork(fix.ctx);
  });

  it('7c. 三问结束之后，主人在总管私聊说的话照常排唤醒（不再被当作回答）', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const before = fix.ctx.store.table('queue').list().length;
    okData(await fix.hub.api.sendMessage(fix.chief!.id, '做网页'));
    expect(fix.ctx.store.table('queue').list().length + fix.ctx.store.table('wakes').list().length).toBeGreaterThan(before);
    expect(theSetup(fix.ctx).answers.work).toBe('software');
  });
});

describe('三问：重复作答与模板库', () => {
  it('8. 已答过的问题再次作答被拒；不是当前问的也被拒', async () => {
    const fix = await teamHub();
    okData(await pick(fix, 1, 'software'));
    const again = await pick(fix, 1, 'research');
    expect(again).toEqual({ ok: false, error: '这个问题已经回答过了' });
    const early = await pick(fix, 3, 'decisions');
    expect(early).toEqual({ ok: false, error: '这个问题已经回答过了' });
    expect(theSetup(fix.ctx).answers.work).toBe('software');
    // 选项不是这一问的：报错，不前进。
    const wrong = await pick(fix, 2, 'maybe');
    expect(wrong.ok).toBe(false);
    expect(theSetup(fix.ctx).step).toBe(2);
    // choice 与 text 同时给、都不给：报错。
    const both = await fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step: 2, choice: 'no', text: '没有' });
    expect(both.ok).toBe(false);
    const none = await fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step: 2 });
    expect(none.ok).toBe(false);
  });

  it('9. 三问期间从模板库添加了工程师：推荐里没有工程师', async () => {
    const fix = await teamHub();
    okData(await fix.hub.api.createBot({ name: '工程师', role: 'executor', templateId: 'engineer', persona: '先核实再行动', aspirations: ['把页面做对'] }));
    expect(theSetup(fix.ctx).state).toBe('asking');
    const proposal = await answerAll(fix);
    expect(proposal.candidates.map(row => row.templateId)).toEqual(['designer', 'reviewer']);
    expect(modelCalls(fix.ctx)).toEqual([]);
  });
});
