/**
 * P73c 组队卡验收：生成、卡内修改、确认入职（含预检失败与部分失败）、拒绝、「不新增」口令、
 * 「待你处理」单一条目、兜底补发；以及听吩咐的总管仍能被四类事叫醒、满员时的归档建议。
 * 全程不调用模型：宿主没有投递，队列和唤醒单为空（口令那一条主人消息本来就会叫醒总管，单独断言）。
 */
import { describe, expect, it, vi } from 'vitest';
import { expireInbox } from '../src/outreach/inbox.js';
import { botMbti } from '../src/personality/profile.js';
import { declineByText, PICK_FALLBACK_PREFIX } from '../src/team/proposals.js';
import { archiveRows, suggestArchiveFor } from '../src/team/archive-suggestion.js';
import { sendMail } from '../src/peer/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue, removeEntry } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import type { HubContext } from '../src/engine/context.js';
import type { WakeKind } from '../src/model/index.js';
import {
  answerAll, expectOnlyPickTurn, modelCalls, pickFallsBack, okData, openTeamInbox, presetBot, teamHub, teamInboxItems,
  theProposal, theSetup, thread, type TeamFix,
} from './p73c-fixtures.js';

const hour = 3_600_000;
const day = 24 * hour;
/** 目录里有一个轻量模型：轻档可用。 */
const CATALOG = [
  { provider: 'p', model: 'deepseek-v4-pro', label: 'DeepSeek Pro' },
  { provider: 'p', model: 'deepseek-v4-flash', label: 'DeepSeek Flash' },
];
/** 带轻量模型目录启动。 */
function withLight(): Promise<TeamFix> {
  return teamHub({ before: async c => { Object.assign(c, { listModels: async () => CATALOG }); } });
}
/** 一次编辑命令。 */
function edit(fix: TeamFix, key: string, action: string, value?: string | number, rev = theProposal(fix.ctx).rev) {
  return fix.hub.api.editTeamCandidate({ proposalId: theProposal(fix.ctx).id, rev, key, action, ...(value === undefined ? {} : { value }) });
}
const confirm = (fix: TeamFix, rev = theProposal(fix.ctx).rev) =>
  fix.hub.api.confirmTeamProposal({ proposalId: theProposal(fix.ctx).id, rev });

describe('生成初始组队卡', () => {
  it('10. 软件类推荐 3 位，候选与规则表一致；结论句在前、卡片在后', async () => {
    const fix = await teamHub();
    const proposal = await answerAll(fix);
    expect(proposal).toMatchObject({ kind: 'initial', state: 'pending', rev: 1, agreementId: null, needReason: null, residentReason: null, decidedAt: null });
    expect(proposal.candidates.map(row => [row.key, row.templateId, row.name, row.mbti, row.modelTier])).toEqual([
      ['c1', 'engineer', '工程师', 'ISTJ', 'standard'],
      ['c2', 'designer', '设计师', 'ISFJ', 'standard'],
      // 目录里没有轻量模型：评审员的建议档位由轻档改为标准档。
      ['c3', 'reviewer', '评审员', 'ISTJ', 'standard'],
    ]);
    for (const row of proposal.candidates) {
      expect(row.suggested).toEqual({ templateId: row.templateId, name: row.name, mbti: row.mbti, modelTier: row.modelTier });
      expect(row).toMatchObject({ removed: false, brief: null, swappedFrom: null, outcome: null });
    }
    expect(proposal.candidates[0]!.alternates.map(row => row.templateId)).toEqual(['engineer', 'product-manager']);
    const rows = thread(fix.ctx, fix.chief!.id);
    // W11：这是总管没能挑人时的默认推荐，结论句前面先说明一句。
    const conclusion = rows.findIndex(row => row.text.startsWith(`${PICK_FALLBACK_PREFIX('no_card')}我建议先安排 3 位`));
    const card = rows.findIndex(row => row.kind === 'team');
    expect(conclusion).toBeGreaterThan(-1);
    expect(card).toBe(conclusion + 1);
    expect(rows[card]).toMatchObject({ refId: proposal.id, text: '组队卡：初始团队，待你确认' });
    expect(proposal.cardMessageId).toBe(rows[card]!.id);
    expectOnlyPickTurn(fix.ctx);
  });

  it('10b. 目录里有轻量模型时评审员建议轻档；推荐 0 位时不发卡，总管说明，三问转 done', async () => {
    const light = await withLight();
    const proposal = await answerAll(light);
    expect(proposal.candidates[2]).toMatchObject({ templateId: 'reviewer', modelTier: 'light' });

    // 巡检员已在册：盯守类推荐 0 位。
    const none = await teamHub();
    okData(await none.hub.api.createBot({ name: '巡检员', role: 'sentinel', templateId: 'inspector', persona: '盯日志', aspirations: ['不漏报'] }));
    okData(await none.hub.api.answerTeamQuestion({ setupId: theSetup(none.ctx).id, step: 1, choice: 'watch' }));
    okData(await none.hub.api.answerTeamQuestion({ setupId: theSetup(none.ctx).id, step: 2, choice: 'no' }));
    okData(await none.hub.api.answerTeamQuestion({ setupId: theSetup(none.ctx).id, step: 3, choice: 'decisions' }));
    await pickFallsBack(none);
    expect(none.ctx.store.table('teamProposals').count()).toBe(0);
    expect(theSetup(none.ctx)).toMatchObject({ state: 'done', proposalId: null });
    expect(thread(none.ctx, none.chief!.id).at(-1)!.text).toBe('现有员工已能覆盖这类事。你可以直接把事情交给我。');
    expect(none.ctx.store.table('bots').get(none.chief!.id)!.activityText).toBe('继续关注变化');
  });
});

describe('卡内修改', () => {
  it('11. 改名、改性格、改模型、恢复建议值、换一位、不要这位；每次 rev 加 1，旧 rev 被拒，条目始终一条，全程不投递', async () => {
    const fix = await withLight();
    await answerAll(fix);
    const { ctx } = fix;
    const messagesBefore = ctx.store.log('thread').all().length;
    const inboxId = openTeamInbox(ctx)[0]!.id;
    const calls = modelCalls(ctx).length;
    const rev = () => theProposal(ctx).rev;

    // 改名：成功；与卡内他人重名、与现有员工重名、过长、空白都被拒。
    okData(await edit(fix, 'c1', 'rename', '  小工  '));
    expect(theProposal(ctx)).toMatchObject({ rev: 2 });
    expect(theProposal(ctx).candidates[0]!.name).toBe('小工');
    for (const bad of ['设计师', '总管', '', '   ', '一二三四五六七八九十一二三四五六七八九十一']) {
      expect((await edit(fix, 'c1', 'rename', bad)).ok, `名字「${bad}」应被拒`).toBe(false);
    }
    expect(rev()).toBe(2);
    // 旧 rev 被拒。
    expect(await edit(fix, 'c1', 'rename', '小工2', 1)).toEqual({ ok: false, error: '卡片已更新，请在最新内容上操作' });

    // 改性格与恢复。
    okData(await edit(fix, 'c2', 'set_mbti', 'ESTJ'));
    expect(theProposal(ctx).candidates[1]!.mbti).toBe('ESTJ');
    expect((await edit(fix, 'c2', 'set_mbti', 'XXXX')).ok).toBe(false);
    okData(await edit(fix, 'c2', 'restore_mbti'));
    expect(theProposal(ctx).candidates[1]!.mbti).toBe('ISFJ');

    // 改模型与恢复（轻档可用）。
    okData(await edit(fix, 'c1', 'set_model', 'light'));
    expect(theProposal(ctx).candidates[0]!.modelTier).toBe('light');
    okData(await edit(fix, 'c1', 'restore_model'));
    expect(theProposal(ctx).candidates[0]!.modelTier).toBe('standard');

    // 换一位：工程师换成产品经理；建议值同步，swappedFrom 记原模板，备选按新模板重算。
    okData(await edit(fix, 'c1', 'swap', 1));
    const swapped = theProposal(ctx).candidates[0]!;
    expect(swapped).toMatchObject({ templateId: 'product-manager', name: '产品经理', mbti: 'INTP', modelTier: 'standard', swappedFrom: 'engineer' });
    expect(swapped.suggested).toEqual({ templateId: 'product-manager', name: '产品经理', mbti: 'INTP', modelTier: 'standard' });
    expect(swapped.alternates).toEqual([]);
    // 设计师的备选 0 也是产品经理：卡上已有，被拒；备选序号越界被拒。
    const dup = await edit(fix, 'c2', 'swap', 0);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('产品经理');
    expect((await edit(fix, 'c2', 'swap', 5)).ok).toBe(false);
    // 换成视频策划（备选 1）：成功。
    okData(await edit(fix, 'c2', 'swap', 1));
    expect(theProposal(ctx).candidates[1]).toMatchObject({ templateId: 'video-planner', swappedFrom: 'designer' });

    // 同模板换性格：评审员换 ESTJ，模板不变、不记换人。
    okData(await edit(fix, 'c3', 'swap', 0));
    expect(theProposal(ctx).candidates[2]).toMatchObject({ templateId: 'reviewer', mbti: 'ESTJ', swappedFrom: null });

    // 不要这位与撤销：按钮文字随保留人数变化；被去掉的只允许撤销。
    const label = () => openTeamInbox(ctx)[0]!.options;
    expect(label()).toEqual(['确认，3 位入职']);
    okData(await edit(fix, 'c2', 'remove'));
    expect(label()).toEqual(['确认，2 位入职']);
    expect((await edit(fix, 'c2', 'rename', '别的名字')).ok).toBe(false);
    expect((await edit(fix, 'c2', 'unremove')).ok).toBe(true);
    expect((await edit(fix, 'c2', 'unremove')).ok).toBe(false);
    for (const key of ['c1', 'c2', 'c3']) okData(await edit(fix, key, 'remove'));
    expect(label()).toEqual(['全部不要']);
    okData(await edit(fix, 'c1', 'unremove'));
    expect(label()).toEqual(['确认，1 位入职']);

    // 每次成功修改 rev 加 1；条目始终只有一条（还是最初那一条），没有新线程消息，没有投递。
    expect(openTeamInbox(ctx)).toHaveLength(1);
    expect(teamInboxItems(ctx)).toHaveLength(1);
    expect(openTeamInbox(ctx)[0]!.id).toBe(inboxId);
    expect(ctx.store.log('thread').all()).toHaveLength(messagesBefore);
    expect(modelCalls(ctx)).toHaveLength(calls);
    expectOnlyPickTurn(ctx);
  });

  it('11b. 轻档不可用时改轻档被拒；换到已在册的模板被拒', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const refused = await edit(fix, 'c1', 'set_model', 'light');
    expect(refused).toEqual({ ok: false, error: '轻档不可用：模型目录里没有可用的轻量模型' });
    expect(theProposal(fix.ctx).rev).toBe(1);
    // 产品经理已在册：工程师换成产品经理被拒。
    okData(await fix.hub.api.createBot({ name: '产品经理', role: 'researcher', templateId: 'product-manager', persona: '写需求', aspirations: ['需求清楚'] }));
    const taken = await edit(fix, 'c1', 'swap', 1);
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error).toContain('已经在册');
    expect(theProposal(fix.ctx).candidates[0]!.templateId).toBe('engineer');
  });
});

describe('确认入职', () => {
  it('12. 确认：入职人数与保留人数一致，来历记录原值，卡片 confirmed、条目已回答，旁白与固定句，三问 done，不投递', async () => {
    const fix = await withLight();
    await answerAll(fix);
    const { ctx, chief } = fix;
    okData(await edit(fix, 'c1', 'rename', '小工'));
    okData(await edit(fix, 'c1', 'set_mbti', 'ESTJ'));
    okData(await edit(fix, 'c3', 'set_model', 'standard'));
    okData(await edit(fix, 'c2', 'remove'));
    const saved = okData(await confirm(fix));
    expect(saved).toMatchObject({ state: 'confirmed', decidedVia: 'button', rosterAfter: 3 });
    expect(saved.decidedAt).toBe(ctx.clock.now());

    // 保留两位：小工和评审员入职；设计师没有入职。
    const bots = ctx.store.table('bots').list(row => row.role !== 'chief');
    expect(bots.map(row => row.name).sort()).toEqual(['小工', '评审员'].sort());
    for (const bot of bots) expect(bot).toMatchObject({ lifecycle: 'active', onDemand: true, autonomy: 'L1', pace: 'quiet' });
    const worker = bots.find(row => row.name === '小工')!;
    const reviewer = bots.find(row => row.name === '评审员')!;
    expect(botMbti(ctx, worker.id)).toBe('ESTJ');
    expect(ctx.store.table('botOrigins').get(worker.id)).toMatchObject({
      source: 'team_initial', templateId: 'engineer', proposalId: saved.id, renamedFrom: '工程师', mbtiSuggested: 'ISTJ', modelTierSuggested: null,
    });
    // 评审员建议轻档、卡上改成了标准档：来历记下建议值 light；模型是标准档（跟随默认，null）。
    expect(ctx.store.table('botOrigins').get(reviewer.id)).toMatchObject({ source: 'team_initial', renamedFrom: null, mbtiSuggested: null, modelTierSuggested: 'light' });
    expect(reviewer.model).toBeNull();
    expect(saved.candidates.map(row => row.outcome?.kind)).toEqual(['hired', 'not_hired', 'hired']);

    expect(openTeamInbox(ctx)).toHaveLength(0);
    expect(teamInboxItems(ctx)[0]).toMatchObject({ status: 'answered', answer: '确认，2 位入职' });
    const texts = thread(ctx, chief!.id).map(row => row.text);
    expect(texts).toContain('小工、评审员已入职，在册 3 / 6 位。');
    expect(thread(ctx, chief!.id).at(-1)).toMatchObject({ from: chief!.id, kind: 'chat',
      text: '团队已就位。你交代的第一件真实的事，就是他们的试用；做完后我会告诉你每位做得怎样。现在可以直接把事情交给我。' });
    expect(theSetup(ctx).state).toBe('done');
    expect(ctx.store.table('bots').get(chief!.id)!.activityText).toBe('继续关注变化');
    expectOnlyPickTurn(ctx);
  });

  it('12b. 轻档的建议被保留时，入职的评审员用目录里的轻量模型', async () => {
    const fix = await withLight();
    await answerAll(fix);
    okData(await confirm(fix));
    const reviewer = fix.ctx.store.table('bots').list(row => row.name === '评审员')[0]!;
    expect(reviewer.model).toEqual({ provider: 'p', model: 'deepseek-v4-flash' });
    expect(fix.ctx.store.table('botOrigins').get(reviewer.id)!.modelTierSuggested).toBeNull();
  });

  it('13. 预检失败（确认前另有人用了同名）：零写入，卡片仍待确认，报错指出第几位', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    okData(await fix.hub.api.createBot({ name: '设计师', role: 'executor', persona: '做原型', aspirations: ['原型能用'] }));
    const botsBefore = fix.ctx.store.table('bots').count();
    const originsBefore = fix.ctx.store.table('botOrigins').count();
    const result = await confirm(fix);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('第 2 位「设计师」'); expect(result.error).toContain('同名'); }
    expect(fix.ctx.store.table('bots').count()).toBe(botsBefore);
    expect(fix.ctx.store.table('botOrigins').count()).toBe(originsBefore);
    expect(theProposal(fix.ctx)).toMatchObject({ state: 'pending', decidedAt: null });
    expect(theProposal(fix.ctx).candidates.every(row => row.outcome === null)).toBe(true);
    expect(openTeamInbox(fix.ctx)).toHaveLength(1);
    expect(theSetup(fix.ctx).state).toBe('proposed');
  });

  it('13b. 预检失败的其他原因：全队一位已有、在册人数会超过上限', async () => {
    const unique = await teamHub();
    await answerAll(unique);
    okData(await unique.hub.api.createBot({ name: '另一位评审', role: 'advisor', templateId: 'reviewer', persona: '核对', aspirations: ['逐条核对'] }));
    const refused = await confirm(unique);
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.error).toContain('第 3 位「评审员」'); expect(refused.error).toContain('全队一位'); }

    // 上限 4：总管加推荐 3 位正好 4；确认前又添一位，超过上限。
    const small = await teamHub({ settings: { maxBots: 4 } });
    await answerAll(small);
    okData(await small.hub.api.createBot({ name: '路人', role: 'executor', persona: '帮忙', aspirations: ['有用'] }));
    const over = await confirm(small);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain('上限');
    expect(small.ctx.store.table('bots').count()).toBe(2);
  });

  it('14. 中途一位创建失败：第一位已入职，第二位 failed，卡片 confirmed，旁白含失败原因', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const homes = new Set<string>();
    const real = fix.ctx.fs.mkdirp.bind(fix.ctx.fs);
    vi.spyOn(fix.ctx.fs, 'mkdirp').mockImplementation(async (path, boundary) => {
      const home = /^\/hub\/bots\/[^/]+/.exec(path)?.[0];
      if (home !== undefined) {
        homes.add(home);
        // 第二位员工的家目录写不进去。
        if (homes.size === 2) throw new Error('受控的家目录写入失败');
      }
      return real(path, boundary);
    });
    const saved = okData(await confirm(fix));
    expect(saved.state).toBe('confirmed');
    expect(saved.candidates.map(row => row.outcome?.kind)).toEqual(['hired', 'failed', 'hired']);
    expect(saved.candidates[1]!.outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('受控的家目录写入失败') });
    expect(fix.ctx.store.table('bots').list(row => row.role !== 'chief').map(row => row.name)).toEqual(['工程师', '评审员']);
    expect(fix.ctx.store.table('botOrigins').count()).toBe(3);
    const texts = thread(fix.ctx, fix.chief!.id).map(row => row.text);
    expect(texts).toContain('工程师、评审员已入职，在册 3 / 6 位。');
    expect(texts.some(text => text.startsWith('设计师入职失败：') && text.includes('受控的家目录写入失败'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('15. 全部「不要这位」后确认：卡片 declined，没有人入职，三问 done', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    for (const key of ['c1', 'c2', 'c3']) okData(await edit(fix, key, 'remove'));
    const saved = okData(await confirm(fix));
    expect(saved).toMatchObject({ state: 'declined', decidedVia: 'button' });
    expect(saved.candidates.every(row => row.outcome?.kind === 'not_hired')).toBe(true);
    expect(fix.ctx.store.table('bots').count()).toBe(1);
    expect(fix.ctx.store.table('botOrigins').count()).toBe(1);
    expect(openTeamInbox(fix.ctx)).toHaveLength(0);
    expect(teamInboxItems(fix.ctx)[0]!.status).toBe('withdrawn');
    expect(thread(fix.ctx, fix.chief!.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '你选择不新增员工。' });
    expect(theSetup(fix.ctx).state).toBe('done');
    expectOnlyPickTurn(fix.ctx);
  });

  it('确认命令的 rev 与卡片不一致被拒；已处理的卡不能再确认或修改', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    okData(await edit(fix, 'c1', 'rename', '小工'));
    expect(await confirm(fix, 1)).toEqual({ ok: false, error: '卡片已更新，请在最新内容上确认' });
    okData(await confirm(fix));
    expect((await confirm(fix)).ok).toBe(false);
    expect((await edit(fix, 'c1', 'rename', '再改')).ok).toBe(false);
  });
});

describe('拒绝口令与「待你处理」', () => {
  it('16. 「不新增」口令：卡片 declined，条目撤回；这条主人消息照常排了唤醒；「不新增吗」不识别', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const { ctx, chief, hub } = fix;
    okData(await hub.api.sendMessage(chief!.id, '不新增吗'));
    expect(theProposal(ctx).state).toBe('pending');
    expect(openTeamInbox(ctx)).toHaveLength(1);
    okData(await hub.api.sendMessage(chief!.id, '不新增'));
    expect(theProposal(ctx)).toMatchObject({ state: 'declined', decidedVia: 'text' });
    expect(openTeamInbox(ctx)).toHaveLength(0);
    expect(teamInboxItems(ctx)[0]!.status).toBe('withdrawn');
    expect(theSetup(ctx).state).toBe('done');
    expect(thread(ctx, chief!.id).map(row => row.text)).toContain('你选择不新增员工。');
    // 主人说话即发起：这条消息照常叫醒总管（排了队或已经开始投递）。
    expect(ctx.store.table('queue').list().length + ctx.store.table('wakes').list().length).toBeGreaterThan(0);
  });

  it('16b. 卡片落楼之前发的「不新增」不识别；没有待确认的卡时不识别；不是总管私聊不识别', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const { ctx, chief } = fix;
    const card = thread(ctx, chief!.id).find(row => row.kind === 'team')!;
    const early = { ...card, id: 'm_0000000000', kind: 'chat' as const, from: 'owner', text: '不新增', createdAt: card.createdAt - 1 };
    expect(declineByText(ctx, chief!.id, early)).toBe(false);
    expect(theProposal(ctx).state).toBe('pending');
    const later = { ...early, createdAt: card.createdAt + 1 };
    expect(declineByText(ctx, 'team', later)).toBe(false);
    expect(declineByText(ctx, chief!.id, later)).toBe(true);
    expect(theProposal(ctx).state).toBe('declined');
    // 已经没有待确认的卡。
    expect(declineByText(ctx, chief!.id, later)).toBe(false);
  });

  it('17. 「待你处理」确认：用按钮文字回答等同卡片确认；条目无期限无默认；放很久仍开着；旧按钮文字被拒', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const { ctx } = fix;
    const item = openTeamInbox(ctx)[0]!;
    expect(item).toMatchObject({ type: 'question', priority: 'P2', title: '确认初始团队', options: ['确认，3 位入职'],
      defaultOption: null, expiresAt: null, subjectKey: `team:${theProposal(ctx).id}`, refId: theProposal(ctx).id, botId: fix.chief!.id });
    expect(item.body).toBe('工程师、设计师、评审员，确认后入职。');
    await expireInbox(ctx, ctx.clock.now() + 400 * day);
    expect(openTeamInbox(ctx)).toHaveLength(1);
    // 卡片上改过之后，旧按钮文字不再有效。
    okData(await edit(fix, 'c3', 'remove'));
    expect((await fix.hub.api.answerInbox(item.id, '确认，3 位入职')).ok).toBe(false);
    expect(theProposal(ctx).state).toBe('pending');
    const answered = okData(await fix.hub.api.answerInbox(item.id, '确认，2 位入职'));
    expect(answered).toMatchObject({ status: 'answered', answer: '确认，2 位入职' });
    expect(theProposal(ctx)).toMatchObject({ state: 'confirmed', decidedVia: 'inbox' });
    expect(ctx.store.table('bots').list(row => row.role !== 'chief').map(row => row.name)).toEqual(['工程师', '设计师']);
    expectOnlyPickTurn(ctx);
  });

  it('18. 兜底：条目 id 被清空后跑一次 tick，补建一条条目，开着的条目只有一条；卡片消息缺失时补发', async () => {
    const fix = await teamHub();
    await answerAll(fix);
    const { ctx, chief, hub } = fix;
    const oldId = openTeamInbox(ctx)[0]!.id;
    ctx.store.table('teamProposals').patch(theProposal(ctx).id, { inboxId: null });
    ctx.clock.advance(60_000);
    await hub.tick();
    const open = openTeamInbox(ctx);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(oldId);
    expect(theProposal(ctx).inboxId).toBe(open[0]!.id);
    // 条目被误撤回：同样补建。
    ctx.store.table('inbox').patch(open[0]!.id, { status: 'withdrawn' });
    ctx.clock.advance(60_000);
    await hub.tick();
    expect(openTeamInbox(ctx)).toHaveLength(1);
    // 卡片消息 id 丢了：补发一张卡，之后不再重复。
    ctx.store.table('teamProposals').patch(theProposal(ctx).id, { cardMessageId: null });
    const cardsBefore = thread(ctx, chief!.id).filter(row => row.kind === 'team').length;
    ctx.clock.advance(60_000);
    await hub.tick();
    ctx.clock.advance(60_000);
    await hub.tick();
    expect(thread(ctx, chief!.id).filter(row => row.kind === 'team')).toHaveLength(cardsBefore + 1);
    expect(theProposal(ctx).cardMessageId).not.toBeNull();
    expect(openTeamInbox(ctx)).toHaveLength(1);
  });

  it('18b. 三问答完却没生成组队卡：tick 补生成一次', async () => {
    const fix = await teamHub();
    const { ctx, hub } = fix;
    okData(await hub.api.answerTeamQuestion({ setupId: theSetup(ctx).id, step: 1, choice: 'software' }));
    okData(await hub.api.answerTeamQuestion({ setupId: theSetup(ctx).id, step: 2, choice: 'no' }));
    // 手工模拟「第三问已答、组队卡没生成」：只写答案。
    ctx.store.table('teamSetups').patch(theSetup(ctx).id, { answers: { ...theSetup(ctx).answers, notify: 'decisions' } });
    expect(ctx.store.table('teamProposals').count()).toBe(0);
    ctx.clock.advance(60_000);
    await hub.tick();
    // 补生成是异步任务，再等一次中心入口让它做完。
    await hub.api.overview();
    await new Promise<void>(resolve => { setTimeout(resolve, 20); });
    expect(ctx.store.table('teamProposals').count()).toBe(1);
    expect(theSetup(ctx).state).toBe('proposed');
  });
});

/** 按候选种类造一个排队候选，返回闸门是否放行；用完把候选移出队列，不留痕迹。 */
function gatePass(ctx: HubContext, botId: string, kind: WakeKind, extra: Record<string, unknown> = {}): boolean {
  const entry = enqueue(ctx, buildCandidate(ctx, { botId, kind, score: 0.9, summary: '测试', evidence: [], ...extra } as never));
  if (!entry) return false;
  const now = ctx.clock.now();
  const result = evaluateGates(entry, buildSnapshot(ctx, botId, now), now, ctx.settings);
  removeEntry(ctx, entry.id);
  return result.pass;
}

describe('听吩咐的总管仍能被四类事叫醒（裁定 3）', () => {
  async function chiefWorld() {
    const fix = await teamHub();
    // 闸门快照读取 runtime.startedAt：拨到一小时前，避开启动静默。
    fix.ctx.runtime.startedAt -= hour;
    fix.ctx.clock.advance(hour);
    expect(fix.chief).toMatchObject({ onDemand: true });
    return fix;
  }

  // P73r3 S2：不再用人为调高的 0.9，各类事都用中心真实给出的显著性数值。
  it('主人发话：放行', async () => {
    const { ctx, chief } = await chiefWorld();
    expect(gatePass(ctx, chief!.id, 'owner_message', { ownerInitiated: true, score: ctx.settings.c02.ownerSalience })).toBe(true);
  });

  it('主人确认或拒绝组队卡（待你处理的回复）：放行', async () => {
    const { ctx, chief } = await chiefWorld();
    expect(gatePass(ctx, chief!.id, 'inbox_reply', { ownerInitiated: true, score: ctx.settings.c02.replySalience })).toBe(true);
  });

  it('员工发来消息或交接：放行（走真实的 sendMail，显著性是同伴消息的真实上限 0.70）', async () => {
    const { ctx, chief } = await chiefWorld();
    const worker = await presetBot(ctx, 1);
    await sendMail(ctx, worker.id, { to: chief!.id, text: '做完了，请看一下' });
    const entry = ctx.store.table('queue').list(row => row.botId === chief!.id)[0];
    expect(entry).toBeDefined();
    expect(entry!.reason.score).toBeLessThanOrEqual(0.7);
    const now = ctx.clock.now();
    expect(evaluateGates(entry!, buildSnapshot(ctx, chief!.id, now), now, ctx.settings).pass).toBe(true);
  });

  it('总管自己议程里到期的事：放行；对照：自己定期自查、内驱不放行', async () => {
    const { ctx, chief } = await chiefWorld();
    expect(gatePass(ctx, chief!.id, 'agenda_due', { score: ctx.settings.c02.agendaDueScore })).toBe(true);
    expect(gatePass(ctx, chief!.id, 'light_check')).toBe(false);
    expect(gatePass(ctx, chief!.id, 'drive')).toBe(false);
  });
});

describe('满员时的归档建议（接入真实的项目负责人信息）', () => {
  it('项目负责人不会被建议归档；没有负责人关系时最久没接活的那位会被建议', async () => {
    const fix = await teamHub();
    const a = await presetBot(fix.ctx, 1, { name: '甲', lastThinkAt: null });
    const b = await presetBot(fix.ctx, 2, { name: '乙', lastThinkAt: null });
    // 对照：没有项目时，两位都没接过活，规则选排在前面的甲。
    expect(suggestArchiveFor(fix.ctx)).toMatchObject({ botId: a.id, reasonText: '最近 30 天没有接活' });
    // 甲成为一个未归档项目的负责人：它不能归档，也不会被建议。
    okData(await fix.hub.api.saveProject({ name: '周报', memberBotIds: [a.id, b.id], ownerBotId: a.id }));
    const rows = archiveRows(fix.ctx);
    expect(rows.find(row => row.botId === a.id)!.ownsProject).toBe(true);
    expect(rows.find(row => row.botId === b.id)!.ownsProject).toBe(false);
    expect(rows.find(row => row.botId === fix.chief!.id)!.ownsProject).toBe(false);
    const suggested = suggestArchiveFor(fix.ctx);
    expect(suggested).toMatchObject({ botId: b.id, name: '乙' });
    // 总管永远不会被建议。
    expect(suggested!.botId).not.toBe(fix.chief!.id);
  });
});
