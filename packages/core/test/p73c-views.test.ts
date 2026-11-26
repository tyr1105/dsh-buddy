/**
 * P73c 视图与来历验收：组队卡视图是纯函数、文字与规则一致；视图通过 zod 校验；
 * 给主人看的文字不含工具名和内部编号；模板库添加写来历并落旁白；办公室的「今天入职」。
 */
import { describe, expect, it } from 'vitest';
import { teamCardView, teamQuestionView, TeamCardViewSchema, TeamQuestionViewSchema, type TeamCardViewInput } from '../src/api/team-views.js';
import { mbtiBehaviorLines } from '../src/model/mbti.js';
import { TeamProposalSchema, type TeamCandidate, type TeamProposal, type TeamSetup } from '../src/model/team-proposal.js';
import { originOf } from '../src/model/bot-origin.js';
import { ackText, INITIAL_CONCLUSION, TEAM_OPENING_TEXT, TEAM_QUESTIONS } from '../src/team/rules.js';
import { TEAM_DECLINED_TEXT, TEAM_NO_NEED_TEXT, TEAM_READY_TEXT } from '../src/team/proposals.js';
import { TEAM_PROJECT_NOTE, TEAM_REASK_TEXT } from '../src/team/setup.js';
import { BOT_TEMPLATES, TURN_TOKEN_RANGE_TEXT } from '../src/team/templates.js';
import { answerAll, expectNoModelWork, okData, pickFallsBack, presetBot, teamHub, theProposal, theSetup, thread } from './p73c-fixtures.js';

const day = 24 * 3_600_000;
const NOW = Date.parse('2026-11-05T10:00:00+08:00');

/** 造一位候选：默认没有任何修改。 */
function candidate(key: 'c1' | 'c2' | 'c3', patch: Partial<TeamCandidate> = {}): TeamCandidate {
  const base: TeamCandidate = {
    key, templateId: 'engineer', suggested: { templateId: 'engineer', name: '工程师', mbti: 'ISTJ', modelTier: 'standard' },
    name: '工程师', mbti: 'ISTJ', modelTier: 'standard', removed: false, brief: null,
    alternates: [{ templateId: 'engineer', mbti: 'ESTJ', label: '工程师，换性格 ESTJ：尽早给出初步结果' }],
    swappedFrom: null, outcome: null,
  };
  return { ...base, ...patch };
}
function proposal(patch: Partial<TeamProposal> & { candidates: TeamCandidate[] }): TeamProposal {
  return TeamProposalSchema.parse({
    id: 'tpr_abcdefghij', chiefId: 'b_0000000001', kind: 'initial', state: 'pending', rev: 3, agreementId: null, needReason: null,
    residentReason: null, cardMessageId: 'm_0000000001', inboxId: 'i_0000000001', sourceMessageId: null, wakeId: null,
    decidedAt: null, decidedVia: null, rosterAfter: null, createdAt: NOW, updatedAt: NOW, ...patch,
  });
}
const input = (patch: Partial<TeamCardViewInput> = {}): TeamCardViewInput => ({
  templates: BOT_TEMPLATES, tiers: { lightAvailable: true, lightLabel: 'DeepSeek Flash' }, rosterCount: 1, maxBots: 6,
  now: NOW, timezone: 'Asia/Shanghai', takenTemplateIds: [], agreementTitle: null, ...patch,
});

describe('teamCardView（纯函数）', () => {
  it('19. 同一输入两次调用深相等；四句性格与 mbtiBehaviorLines 逐字相同；已改项带恢复文字', () => {
    const value = proposal({ candidates: [
      candidate('c1', { mbti: 'ESTJ', name: '小工', modelTier: 'light' }),
      candidate('c2', { templateId: 'designer', suggested: { templateId: 'designer', name: '设计师', mbti: 'ISFJ', modelTier: 'standard' }, name: '设计师', mbti: 'ISFJ' }),
    ] });
    const first = teamCardView(value, input());
    expect(teamCardView(value, input())).toEqual(first);
    const [one, two] = first.candidates;
    expect(one!.personality.lines).toEqual(mbtiBehaviorLines('ESTJ')!.map(line => ({ code: line.code, text: line.text })));
    expect(two!.personality.lines.map(line => line.text)).toEqual(mbtiBehaviorLines('ISFJ')!.map(line => line.text));
    expect(one!.personality).toMatchObject({ type: 'ESTJ', suggested: 'ISTJ', changed: true, restoreText: '恢复为建议值 ISTJ' });
    expect(one!.model).toMatchObject({ tier: 'light', label: '轻档', suggestedLabel: '标准档', changed: true, restoreText: '恢复为建议值 标准档' });
    expect(two!.personality).toMatchObject({ changed: false, restoreText: null });
    expect(two!.model).toMatchObject({ changed: false, restoreText: null });
    expect(one!.model.options).toEqual([{ tier: 'standard', label: '标准档', available: true }, { tier: 'light', label: '轻档', available: true }]);
    // 固定文字：待确认的卡。
    expect(first).toMatchObject({
      title: '初始团队', stateLabel: '待你确认', decidedText: null, confirmLabel: '确认，2 位入职',
      footer: { rosterText: '入职后在册 3 / 6 位（含总管）', idleText: '平时不接活时不消耗额度', tokenText: TURN_TOKEN_RANGE_TEXT },
      note: '想调整员工说明或技能，直接在输入框告诉总管，或入职后在员工卡片里修改。想换成模板库里的其他人，也直接在输入框说。',
    });
    expect(one).toMatchObject({ templateName: '工程师', dutyLabel: '执行', uniqueNote: null, canRemove: true, historyText: null, avatarText: '小工' });
    expect(one!.estimateText).toBe('一件中等的事 4 到 8 个回合');
    expect(one!.alternates).toEqual([{ index: 0, label: '工程师，换性格 ESTJ：尽早给出初步结果', disabled: false, reason: null }]);
  });

  it('轻档不可用：标准档写「标准档（跟随默认）」，没有轻档选项；评审员写「评审」「全队一位」；备选已在册时置灰', () => {
    const value = proposal({ candidates: [candidate('c1', {
      templateId: 'reviewer', suggested: { templateId: 'reviewer', name: '评审员', mbti: 'ISTJ', modelTier: 'standard' }, name: '评审员',
      alternates: [{ templateId: 'engineer', mbti: 'ISTJ', label: '换成工程师' }, { templateId: 'reviewer', mbti: 'ESTJ', label: '换性格' }],
    })] });
    const view = teamCardView(value, input({ tiers: { lightAvailable: false, lightLabel: null }, takenTemplateIds: ['engineer'] })).candidates[0]!;
    expect(view).toMatchObject({ dutyLabel: '评审', uniqueNote: '全队一位' });
    expect(view.model.label).toBe('标准档（跟随默认）');
    expect(view.model.options).toEqual([{ tier: 'standard', label: '标准档（跟随默认）', available: true }]);
    expect(view.alternates).toEqual([
      { index: 0, label: '换成工程师', disabled: true, reason: '已在册' },
      { index: 1, label: '换性格', disabled: false, reason: null },
    ]);
  });

  it('19b. 只读后的状态文字和来历：改名、换人、改性格、改模型、不要、失败六种', () => {
    const changed = (patch: Partial<TeamCandidate>) => candidate('c1', patch);
    const rows: Array<[string, TeamCandidate, string]> = [
      ['改名', changed({ name: '小工' }), '由「工程师」改名'],
      ['换人', changed({ templateId: 'product-manager', swappedFrom: 'engineer', suggested: { templateId: 'product-manager', name: '产品经理', mbti: 'INTP', modelTier: 'standard' }, name: '产品经理', mbti: 'INTP' }), '由「工程师」换为「产品经理」'],
      ['改性格', changed({ mbti: 'ESTJ' }), '性格由建议的「ISTJ」改为「ESTJ」'],
      ['改模型', changed({ suggested: { templateId: 'engineer', name: '工程师', mbti: 'ISTJ', modelTier: 'light' }, modelTier: 'standard' }), '模型由建议的「轻档」改为「标准档」'],
      ['不要', changed({ removed: true, outcome: { kind: 'not_hired' } }), '你选了不要'],
      ['失败', changed({ outcome: { kind: 'failed', error: '家目录写不进去' } }), '入职失败：家目录写不进去'],
      ['多项', changed({ name: '小工', mbti: 'ESTJ' }), '由「工程师」改名；性格由建议的「ISTJ」改为「ESTJ」'],
    ];
    for (const [label, row, expected] of rows) {
      const outcome = row.outcome ?? (row.removed ? { kind: 'not_hired' as const } : { kind: 'hired' as const, botId: 'b_0000000002' });
      const value = proposal({ state: 'confirmed', decidedAt: NOW, decidedVia: 'button', rosterAfter: 4, candidates: [{ ...row, outcome }] });
      expect(teamCardView(value, input()).candidates[0]!.historyText, label).toBe(expected);
    }
    // 没有任何修改：来历为空。
    const plain = proposal({ state: 'confirmed', decidedAt: NOW, decidedVia: 'button', rosterAfter: 4, candidates: [candidate('c1', { outcome: { kind: 'hired', botId: 'b_0000000002' } })] });
    expect(teamCardView(plain, input()).candidates[0]!.historyText).toBeNull();
    // 状态文字与在册人数。
    expect(teamCardView(plain, input())).toMatchObject({
      stateLabel: '已入职　11月5日 10:00', decidedText: '11月5日 10:00', note: null, footer: { rosterText: '在册 4 / 6 位' },
    });
    expect(teamCardView(plain, input()).candidates[0]!.alternates).toEqual([]);
    const declined = proposal({ state: 'declined', decidedAt: NOW, decidedVia: 'text', candidates: [candidate('c1', { outcome: { kind: 'not_hired' } })] });
    expect(teamCardView(declined, input())).toMatchObject({ stateLabel: '你选择不新增', footer: { rosterText: '在册 1 / 6 位' } });
    const withdrawn = proposal({ state: 'withdrawn', decidedAt: NOW, decidedVia: 'chief', candidates: [candidate('c1')] });
    expect(teamCardView(withdrawn, input()).stateLabel).toBe('已撤下');
  });

  it('按需加人的卡：标题带约定标题，在册文字不带「（含总管）」，没有「不要这位」，按钮与说明按方案', () => {
    const value = proposal({ kind: 'addition', agreementId: 'agr_abcdefghij', needReason: '需要查资料', residentReason: '以后还会用到', candidates: [candidate('c1')] });
    const view = teamCardView(value, input({ agreementTitle: '活动报名页' }));
    expect(view).toMatchObject({
      title: '新员工：活动报名页', confirmLabel: '确认入职，接手这件事',
      footer: { rosterText: '入职后在册 2 / 6 位', idleText: '入职后常驻；不接活时不消耗额度' },
      note: '不新增也可以：回复「不新增」，由总管自己完成，预计多用 1 到 2 个回合。',
    });
    expect(view.candidates[0]!.canRemove).toBe(false);
  });

  it('20. 视图通过 TeamCardViewSchema、TeamQuestionViewSchema 校验', () => {
    const value = proposal({ candidates: [candidate('c1'), candidate('c2', { name: '工程师二号', templateId: 'engineer' })] });
    expect(() => TeamCardViewSchema.parse(teamCardView(value, input()))).not.toThrow();
    const setup: TeamSetup = {
      id: 'tsu_abcdefghij', chiefId: 'b_0000000001', state: 'asking', step: 2, questionMessageIds: [], proposalId: null, createdAt: NOW, updatedAt: NOW,
      answers: { work: 'software', workText: null, hasProject: null, projectId: null, projectFolder: null, notify: null },
    };
    for (const step of [1, 2, 3] as const) expect(() => TeamQuestionViewSchema.parse(teamQuestionView(setup, step, NOW))).not.toThrow();
    // 已答的问题标出选中项，当前的问题标 current，第二问需要选文件夹。
    expect(teamQuestionView(setup, 1, NOW)).toMatchObject({ answered: true, chosenLabel: '做软件产品：网页、小工具、插件', current: false, folderPick: false });
    expect(teamQuestionView(setup, 2, NOW)).toMatchObject({ answered: false, chosenLabel: null, current: true, folderPick: true, total: 3 });
    expect(teamQuestionView(setup, 3, NOW).options.find(option => option.value === 'decisions')!.suggested).toBe(true);
    // 缺字段的视图被校验拒绝。
    expect(() => TeamCardViewSchema.parse({ ...teamCardView(value, input()), footer: undefined })).toThrow();
  });

  it('20b. 真实中心的线程视图：三问和组队卡消息带专用视图，通过 schema 校验，已答的问题标已答', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const view = okViewThread(await fix.hub.api.thread(fix.chief!.id));
    const questions = view.filter(row => row.kind === 'team_question');
    expect(questions).toHaveLength(3);
    for (const row of questions) {
      expect(() => TeamQuestionViewSchema.parse(row.teamQuestion)).not.toThrow();
      expect(row.teamQuestion).toMatchObject({ answered: true, current: false });
    }
    expect(questions.map(row => row.teamQuestion!.step)).toEqual([1, 2, 3]);
    const card = view.find(row => row.kind === 'team')!;
    expect(() => TeamCardViewSchema.parse(card.teamCard)).not.toThrow();
    expect(card.teamCard).toMatchObject({ state: 'pending', rev: 1, confirmLabel: '确认，3 位入职' });
    // 「待你处理」条目带组队卡 id，按钮是当前确认文字。
    const inbox = await fix.hub.api.inbox();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ teamProposalId: theProposal(fix.ctx).id, options: ['确认，3 位入职'], defaultOption: null, expiresAt: null });
  });
});

/** 线程视图的消息列表（失败时直接让用例挂掉）。 */
function okViewThread<T extends { messages: Array<{ kind: string; teamQuestion?: import('../src/api/team-views.js').TeamQuestionView | null; teamCard?: import('../src/api/team-views.js').TeamCardView | null }> }>(view: T) {
  return view.messages;
}

/** 递归取出一个对象里所有给主人看的文字（跳过 id、key 一类的标识字段）。 */
function ownerStrings(value: unknown, skip = new Set(['proposalId', 'setupId', 'templateId', 'key', 'value', 'code', 'tier', 'kind', 'state', 'type', 'suggested'])): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => ownerStrings(item, skip));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).filter(([key]) => !skip.has(key)).flatMap(([, item]) => ownerStrings(item, skip));
  }
  return [];
}
const FORBIDDEN = ['hub_', 'b_', 'tpr_', 'tsu_', 'agr_'];

describe('给主人看的文字', () => {
  it('21. 固定句、一次完整流程的线程消息、条目、视图文字都不含工具名和内部编号', async () => {
    const fixed = [
      TEAM_OPENING_TEXT, TEAM_REASK_TEXT, TEAM_PROJECT_NOTE, TEAM_READY_TEXT, TEAM_NO_NEED_TEXT, TEAM_DECLINED_TEXT,
      ...TEAM_QUESTIONS.flatMap(row => [row.question, row.note, ...row.options.map(option => option.label)]),
      ackText(1, { value: 'software' }), ackText(1, { value: 'mixed', typedText: '随便', fallback: true }), ackText(2, { value: 'yes', projectName: 'demo' }),
      ackText(2, { value: 'no' }), ackText(3, { value: 'each_step' }),
      INITIAL_CONCLUSION([{ templateId: 'engineer' }, { templateId: 'reviewer' }]),
      '在册已满 6 位，没有总管。请先归档一位员工，中心会自动补建总管。',
    ];
    for (const text of fixed) for (const bad of FORBIDDEN) expect(text, `固定句「${text}」含 ${bad}`).not.toContain(bad);

    // 一次完整流程：点选三问（第二问选项目）、改一改、确认。
    const fix = await teamHub();
    okData(await fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step: 1, choice: 'mixed' }));
    okData(await fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step: 2, choice: 'yes', folderPath: '/Users/x/demo' }));
    okData(await fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step: 3, choice: 'each_step' }));
    await pickFallsBack(fix);
    const id = theProposal(fix.ctx).id;
    okData(await fix.hub.api.editTeamCandidate({ proposalId: id, rev: 1, key: 'c1', action: 'rename', value: '小工' }));
    okData(await fix.hub.api.editTeamCandidate({ proposalId: id, rev: 2, key: 'c2', action: 'remove' }));
    okData(await fix.hub.api.confirmTeamProposal({ proposalId: id, rev: 3 }));
    okData(await fix.hub.api.createBot({ name: '巡检员', role: 'sentinel', templateId: 'inspector', persona: '盯日志', aspirations: ['不漏报'] }));
    const messages = thread(fix.ctx, fix.chief!.id);
    for (const row of messages) for (const bad of FORBIDDEN) expect(row.text, `消息「${row.text}」含 ${bad}`).not.toContain(bad);
    for (const item of fix.ctx.store.table('inbox').list()) {
      for (const text of [item.title, item.body, ...item.options]) for (const bad of FORBIDDEN) expect(text).not.toContain(bad);
    }
    // 视图里给主人看的文字同样干净。
    const view = (await fix.hub.api.thread(fix.chief!.id)).messages;
    for (const row of view) {
      for (const text of [row.text, ...ownerStrings(row.teamCard), ...ownerStrings(row.teamQuestion)]) {
        for (const bad of FORBIDDEN) expect(text, `视图文字「${text}」含 ${bad}`).not.toContain(bad);
      }
    }
    expect(view.some(row => row.kind === 'team' && row.teamCard?.state === 'confirmed')).toBe(true);
  });
});

describe('模板库添加与来历', () => {
  it('22. 带 templateId：来历 library、总管私聊有旁白、不排唤醒；第二位评审员被拒；不带 templateId 来历 custom、无旁白', async () => {
    const fix = await teamHub();
    const { ctx, hub, chief } = fix;
    const before = thread(ctx, chief!.id).length;
    const engineer = okData(await hub.api.createBot({ name: '工程师', role: 'executor', templateId: 'engineer', persona: '写页面', aspirations: ['页面可用'] }));
    expect(ctx.store.table('botOrigins').get(engineer.id)).toMatchObject({ source: 'library', templateId: 'engineer', proposalId: null, joinedAt: ctx.clock.now() });
    expect(thread(ctx, chief!.id).slice(before).map(row => [row.from, row.kind, row.text])).toEqual([
      ['hub', 'system', '你从模板库添加了工程师。之后安排工作时会算上这位员工。'],
    ]);
    const renamed = okData(await hub.api.createBot({ name: '小工', role: 'executor', templateId: 'engineer', persona: '写页面', aspirations: ['页面可用'] }));
    expect(thread(ctx, chief!.id).at(-1)!.text).toBe('你从模板库添加了工程师（小工）。之后安排工作时会算上这位员工。');
    expect(ctx.store.table('botOrigins').get(renamed.id)!.templateId).toBe('engineer');

    okData(await hub.api.createBot({ name: '评审员', role: 'advisor', templateId: 'reviewer', persona: '核对', aspirations: ['逐条核对'] }));
    expect(await hub.api.createBot({ name: '评审员二', role: 'advisor', templateId: 'reviewer', persona: '核对', aspirations: ['逐条核对'] }))
      .toEqual({ ok: false, error: 'templateId：评审员全队一位，已有' });
    expect(await hub.api.createBot({ name: '谁', role: 'executor', templateId: 'no-such-template', persona: '核对', aspirations: ['逐条核对'] }))
      .toEqual({ ok: false, error: 'templateId：没有这个模板' });
    expect(ctx.store.table('bots').count()).toBe(4);

    const messages = thread(ctx, chief!.id).length;
    const custom = okData(await hub.api.createBot({ name: '自配员工', role: 'sentinel', persona: '盯着', aspirations: ['不漏报'] }));
    expect(ctx.store.table('botOrigins').get(custom.id)).toMatchObject({ source: 'custom', templateId: null, joinedAt: ctx.clock.now() });
    expect(thread(ctx, chief!.id)).toHaveLength(messages);
    expectNoModelWork(ctx);
  });

  it('旧员工没有来历：读取时按 legacy，joinedAt 取创建时间，不写表', async () => {
    const fix = await teamHub();
    const old = await presetBot(fix.ctx, 1, { createdAt: NOW - 30 * day });
    expect(fix.ctx.store.table('botOrigins').get(old.id)).toBeNull();
    expect(originOf(fix.ctx, old.id)).toMatchObject({ source: 'legacy', templateId: null, joinedAt: NOW - 30 * day, proposalId: null, renamedFrom: null });
    expect(fix.ctx.store.table('botOrigins').get(old.id)).toBeNull();
  });
});

describe('办公室：今天入职', () => {
  it('23. 今天经组队入职的员工 joinedToday 为 true；拨到次日为 false；没有来历的旧员工为 false', async () => {
    const fix = await teamHub({ before: async c => { await presetBot(c, 1, { name: '老员工甲', role: 'sentinel' }); } });
    // 有老员工：三问跳过。手工造一张初始组队卡再确认，走与真实流程相同的入职代码。
    const { ctx, hub } = fix;
    okData(await hub.api.createBot({ name: '新人', role: 'executor', templateId: 'engineer', persona: '写页面', aspirations: ['页面可用'] }));
    const seat = (name: string) => hub.api.officeView().seats.find(row => row.occupant.name === name)!;
    expect(seat('新人')).toMatchObject({ joinedAt: ctx.clock.now(), joinedToday: true });
    expect(seat('老员工甲')).toMatchObject({ joinedAt: null, joinedToday: false });
    ctx.clock.advance(day);
    expect(seat('新人')).toMatchObject({ joinedToday: false });
    expect(seat('新人').joinedAt).not.toBeNull();
    expect(seat('老员工甲')).toMatchObject({ joinedAt: null, joinedToday: false });
  });

  it('23b. 经组队卡入职的员工今天为 true；按设置的时区判断「今天」，跨过本地午夜即为 false', async () => {
    const fix = await teamHub();
    const { ctx, hub } = fix;
    ctx.clock.set(Date.parse('2026-11-05T23:50:00+08:00'));
    await answerAll(fix);
    okData(await hub.api.confirmTeamProposal({ proposalId: theProposal(ctx).id, rev: 1 }));
    const engineer = () => hub.api.officeView().seats.find(row => row.occupant.name === '工程师')!;
    expect(engineer().joinedToday).toBe(true);
    expect(ctx.store.table('botOrigins').get(engineer().botId)).toMatchObject({ source: 'team_initial' });
    ctx.clock.advance(20 * 60_000);
    expect(engineer().joinedToday).toBe(false);
    // 总管是启动时自动建的，不是今天的新人以外的特殊情况：来历 auto_chief 同样按入职时间判断。
    expect(hub.api.officeView().seats.every(row => row.joinedAt !== undefined)).toBe(true);
  });
});
