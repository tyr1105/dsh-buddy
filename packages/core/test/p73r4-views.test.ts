/**
 * P73r4 沙箱走查修复里属于 core 的两条：
 * 第 3 条：员工卡片视图（botCard）新增 templateLabel，由员工的来历记录取模板的显示标签；
 *         评审员是「评审」，从头配置的员工、没有来历的旧员工为 null，已有字段 roleLabel 不变。
 * 第 5 条：办公室座位视图里，自动创建的总管（来历 auto_chief）不算入职，joinedToday 为假；
 *         主人确认入职的员工、主人从模板库添加的员工仍为真。
 */
import { describe, expect, it } from 'vitest';
import { answerAll, okData, presetBot, teamHub, theProposal } from './p73c-fixtures.js';

describe('员工卡片：模板的显示标签（第 3 条）', () => {
  it('从模板创建的评审员带「评审」，roleLabel 仍是角色标签；从头配置的员工为 null', async () => {
    const { ctx, hub } = await teamHub();
    const reviewer = okData(await hub.api.createBot({ name: '评审员', role: 'advisor', templateId: 'reviewer', persona: '核对', aspirations: ['逐条核对'] }));
    const custom = okData(await hub.api.createBot({ name: '自配员工', role: 'sentinel', persona: '盯着', aspirations: ['不漏报'] }));
    const cards = hub.api.overview().bots;
    const reviewerCard = cards.find(card => card.id === reviewer.id)!;
    const customCard = cards.find(card => card.id === custom.id)!;
    expect(reviewerCard.templateLabel).toBe('评审');
    // 已有字段含义不变：仍是角色枚举的标签（「建议」）。
    expect(reviewerCard.roleLabel).toBe('建议');
    expect(customCard.templateLabel).toBeNull();
    expect(customCard.roleLabel).toBe('盯守');
    // 自动创建的总管用的是总管模板，标签与角色标签相同，界面上看不出变化。
    expect(cards.find(card => card.role === 'chief')!.templateLabel).toBe('总管');
    expect(ctx.store.table('bots').count()).toBe(3);
  });

  it('没有来历记录的旧员工为 null；模板没有单独显示标签的取角色标签', async () => {
    const fix = await teamHub();
    const old = await presetBot(fix.ctx, 1, { name: '老员工' });
    const engineer = okData(await fix.hub.api.createBot({ name: '新工程师', role: 'executor', templateId: 'engineer', persona: '写页面', aspirations: ['页面可用'] }));
    const cards = fix.hub.api.overview().bots;
    expect(cards.find(card => card.id === old.id)!.templateLabel).toBeNull();
    // 工程师模板没有单独写显示标签，显示标签就是角色标签「执行」。
    expect(cards.find(card => card.id === engineer.id)!.templateLabel).toBe('执行');
  });
});

describe('办公室：自动创建的总管不报到（第 5 条）', () => {
  it('总管 joinedToday 为假；主人确认入职和从模板库添加的员工为真', async () => {
    const fix = await teamHub();
    const { ctx, hub } = fix;
    await answerAll(fix);
    okData(await hub.api.confirmTeamProposal({ proposalId: theProposal(ctx).id, rev: 1 }));
    okData(await hub.api.createBot({ name: '库里加的', role: 'executor', templateId: 'designer', persona: '出原型', aspirations: ['原型清楚'] }));
    const seats = hub.api.officeView().seats;
    const chiefSeat = seats.find(row => row.occupant.role === 'chief')!;
    expect(ctx.store.table('botOrigins').get(chiefSeat.botId)).toMatchObject({ source: 'auto_chief' });
    expect(chiefSeat.joinedToday).toBe(false);
    expect(chiefSeat.joinedAt).toBeNull();
    const hired = seats.filter(row => row.occupant.role !== 'chief');
    expect(hired.length).toBeGreaterThanOrEqual(2);
    expect(hired.every(row => row.joinedToday)).toBe(true);
  });
});
