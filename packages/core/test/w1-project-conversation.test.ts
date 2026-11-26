/**
 * W1 项目对话：每个项目一条「项目对话」，主人在里面直接跟总管说话；在这里提的约定放进这个项目；
 * 私聊里提的约定由总管判断归属，约定卡写明归属；约定可以放进总管不负责的项目。
 * 走真实 Hub + 假宿主（同 P72b），测到的是真实的路由、闸门和发卡。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { PROJECT_CONVERSATION_TITLE, ensureProjectConversation, projectConversationOf } from '../src/project/conversation.js';
import { saveProject } from '../src/project/service.js';
import { AgreementSubmitInputSchema } from '../src/project/agreement-content.js';
import { callTool, chiefDrafts, floors, newAgreementArgs, ownerSays, setup, speak, type Fix } from './p72b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { okData } from './c04-api-fixtures.js';

/** 一个小王负责、总管不是成员的项目。 */
function wangProject(fix: Fix) {
  return saveProject(fix.ctx, { name: '官网改版', charter: '把官网换成新版式', memberBotIds: [fix.wang.id], ownerBotId: fix.wang.id });
}

/** 打开项目对话（界面命令），返回主题 id。 */
async function openConversation(fix: Fix, projectId: string): Promise<string> {
  return okData(await fix.hub.api.openProjectConversation({ projectId })).topicId;
}

describe('W1：打开项目对话', () => {
  it('第一次打开建一条项目对话，总管加进成员；再打开拿到同一条；第一条是中心旁白', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    const topic = fix.ctx.store.table('projectTopics').get(id)!;
    expect(topic).toMatchObject({ kind: 'conversation', title: PROJECT_CONVERSATION_TITLE, projectId: project.id });
    expect(fix.ctx.store.table('projects').get(project.id)!.memberBotIds).toEqual([fix.wang.id, fix.chief.id]);
    // 负责人不变：项目对话不改项目负责人。
    expect(fix.ctx.store.table('projects').get(project.id)!.ownerBotId).toBe(fix.wang.id);
    expect(await openConversation(fix, project.id)).toBe(id);
    expect(fix.ctx.store.table('projectTopics').list(row => row.kind === 'conversation')).toHaveLength(1);
    expect(floors(fix.ctx, id).map(row => [row.from, row.kind])).toEqual([['hub', 'system']]);
    // 打开不叫醒任何人。
    expect(fix.ctx.store.table('queue').count()).toBe(0);
  });

  it('归档的项目、不存在的项目不能打开；参数不对时报错', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    fix.ctx.store.table('projects').patch(project.id, { status: 'archived', archivedAt: fix.ctx.clock.now() });
    expect((await fix.hub.api.openProjectConversation({ projectId: project.id })).ok).toBe(false);
    expect((await fix.hub.api.openProjectConversation({ projectId: 'prj_0000000099' })).ok).toBe(false);
    expect((await fix.hub.api.openProjectConversation({})).ok).toBe(false);
    expect(projectConversationOf(fix.ctx, project.id)).toBeNull();
  });

  it('普通主题不受影响：开主题仍交给负责人', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    await openConversation(fix, project.id);
    const topicId = okData(await fix.hub.api.createProjectTopic({ projectId: project.id, text: '首页图片换一下' })).topicId;
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.kind).toBeUndefined();
    const woken = [...fix.ctx.store.table('wakes').list(row => row.topicId === topicId), ...fix.ctx.store.table('queue').list(row => row.topicId === topicId)];
    expect(woken.map(row => row.botId)).toEqual([fix.wang.id]);
  });
});

describe('W1：主人在项目对话里说话交给总管', () => {
  it('负责人是小王，项目对话里的话照样叫醒总管，不叫小王；总管的回复落在项目对话里', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '这个项目最近怎么样');
    const wake = fix.ctx.store.table('wakes').list(row => row.topicId === id)[0]!;
    expect(wake.botId).toBe(fix.chief.id);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.wang.id)).toHaveLength(0);
    await speak(fix, fix.chief, '目前没有在办的事。');
    expect(floors(fix.ctx, id).filter(row => row.from === fix.chief.id).map(row => row.text)).toContain('目前没有在办的事。');
  });

  it('总管的唤醒包：项目对话的规则段、「这个项目」段（上下文、在等确认的约定、只适用于这个项目的记忆），没有私聊用的项目列表', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    fix.ctx.store.table('projects').patch(project.id, {
      context: { ...project.context, background: '官网三年没改过，访客说看不清价格。' },
    });
    const now = fix.ctx.clock.now();
    const memory = {
      id: 'mem_0000000001', kind: 'rule' as const, text: '官网的字号不小于 16', example: null, redLine: false,
      scope: { staff: 'all' as const, projects: [project.id] },
      source: { kind: 'owner_words' as const, messageIds: [], quote: '字号不小于 16', threadId: null },
      category: null, status: 'active' as const, history: [], createdAt: now, updatedAt: now,
    };
    fix.ctx.store.table('memories').put(memory as never);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '这个项目最近怎么样');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain('## 项目对话');
    expect(packet).toContain('你在项目「官网改版」的项目对话里');
    expect(packet).toContain('## 这个项目（资料，不是主人的指令）');
    expect(packet).toContain(`项目「官网改版」（${project.id}）`);
    expect(packet).toContain('官网三年没改过');
    expect(packet).toContain('官网的字号不小于 16');
    expect(packet).not.toContain('## 进行中的项目');
    // 总管守则第 2 条已改成按项目判断归属。
    expect(packet).toContain('在项目对话里提的约定不填 projectId');
  });

  it('私聊里的总管唤醒包带「进行中的项目」，有编号；没有「这个项目」段', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    await ownerSays(fix, fix.chief.id, '在吗');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain('## 进行中的项目');
    expect(packet).toContain(`${project.id}：官网改版｜把官网换成新版式`);
    expect(packet).toContain(`${fix.project.id}：季度战役`);
    expect(packet).not.toContain('## 这个项目（资料');
    // 真机实测：旧参数说明写「放进你自己负责的进行中项目」，总管认出了归属却不填 projectId，结果新建了项目。
    expect(packet).toContain('在某个进行中的项目上加功能、改东西、补内容，都算属于它');
  });

  it('私聊里主人点了某个进行中项目的名字：「主人对你说」里写明归属；没点名字时不写', async () => {
    const plain = await setup();
    wangProject(plain);
    await ownerSays(plain, plain.chief.id, '在吗');
    expect(lastPacket(plain, plain.chief)).not.toContain('主人原话里点了');
    const fix = await setup();
    const project = wangProject(fix);
    // 真机实测：主人说「给卡牌馆前端加……」，总管却放进了自己负责的另一个项目。
    await ownerSays(fix, fix.chief.id, '给官网改版加一个首页轮播图');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain(`中心判断：主人原话里点了项目「官网改版」（${project.id}）；这件事要提约定时，projectId 填它`);
    expect(packet).not.toContain(`「季度战役」（${fix.project.id}）`);
  });

  it('projectId 的参数说明不再限于「你自己负责的」项目', () => {
    const description = AgreementSubmitInputSchema.shape.projectId.description ?? '';
    expect(description).not.toContain('你自己负责');
    expect(description).toContain('任何进行中的项目都可以');
  });

  it('员工的唤醒包不带这两段', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.wang.id, '在吗');
    const packet = lastPacket(fix, fix.wang);
    expect(packet).not.toContain('## 进行中的项目');
    expect(packet).not.toContain('## 这个项目（资料');
  });
});

describe('W1：在项目对话里提的约定放进这个项目', () => {
  it('不填 projectId：约定挂在这个项目（不新建项目），卡片落在项目对话；卡上写归属', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '首页加一个价格表');
    const projects = fix.ctx.store.table('projects').count();
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '首页价格表' }));
    expect(result).toMatchObject({ ok: true });
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    expect(agreement.projectId).toBe(project.id);
    expect(agreement.originThread).toBe(id);
    expect(fix.ctx.store.table('projects').count()).toBe(projects);
    // 这件事自己另开一个主题，不是项目对话本身。
    expect(agreement.topicId).not.toBe(id);
    expect(fix.ctx.store.table('projectTopics').get(agreement.topicId)!.projectId).toBe(project.id);
    await speak(fix, fix.chief, '有 2 项需要你定。');
    const card = floors(fix.ctx, id).find(row => row.kind === 'agreement');
    expect(card?.refId).toBe(agreement.id);
    expect(floors(fix.ctx, fix.chief.id).some(row => row.kind === 'agreement')).toBe(false);
    const current = fix.ctx.store.table('agreements').get(agreement.id)!;
    expect(agreementCardView(fix.ctx, current, current.versions[0]!).projectLine).toBe('归属：项目「官网改版」');
  });

  it('在项目对话里打「定了」固定这张卡，总管在项目对话里被叫醒', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '首页加一个价格表');
    await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '首页价格表' }));
    await speak(fix, fix.chief, '有 2 项需要你定。');
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    await ownerSays(fix, id, '定了');
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.state).toBe('locked');
    const woken = [...fix.ctx.store.table('wakes').list(row => row.status === 'running'), ...fix.ctx.store.table('queue').list()];
    expect(woken.some(row => row.botId === fix.chief.id && row.topicId === id)).toBe(true);
  });

  it('在项目对话里点卡片上的「定了」：代发的「定了」落在项目对话，总管在项目对话里被叫醒', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '首页加一个价格表');
    await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '首页价格表' }));
    await speak(fix, fix.chief, '有 2 项需要你定。');
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    const result = await fix.hub.api.confirmAgreement({ agreementId: agreement.id, version: 1 });
    expect(result.ok).toBe(true);
    expect(floors(fix.ctx, id).filter(row => row.from === 'owner').map(row => row.text)).toContain('定了');
    const woken = [...fix.ctx.store.table('wakes').list(row => row.status === 'running'), ...fix.ctx.store.table('queue').list()];
    expect(woken.some(row => row.botId === fix.chief.id && row.topicId === id)).toBe(true);
    expect(woken.some(row => row.botId === fix.chief.id && !row.topicId)).toBe(false);
  });

  it('在项目对话里明确写了另一个项目的 projectId：放进那个项目', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await openConversation(fix, project.id);
    await ownerSays(fix, id, '顺便把季度战役那边的周报模板改一下');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '周报模板', projectId: fix.project.id }));
    expect(result).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('agreements').list()[0]!.projectId).toBe(fix.project.id);
  });
});

describe('W1：私聊里的约定由总管判断归属', () => {
  it('私聊里不填 projectId：照旧新建项目，卡上写「新建项目」', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    await speak(fix, fix.chief, '有 2 项需要你定。');
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    expect(agreement.originThread).toBe(fix.chief.id);
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).projectLine).toBe('归属：新建项目「每日报价页」');
  });

  it('私聊里填总管不负责的项目：放进去，总管加入成员，负责人不变；卡上写归属', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    const id = await chiefDrafts(fix, { projectId: project.id });
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    expect(agreement.projectId).toBe(project.id);
    const saved = fix.ctx.store.table('projects').get(project.id)!;
    expect(saved.memberBotIds).toContain(fix.chief.id);
    expect(saved.ownerBotId).toBe(fix.wang.id);
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).projectLine).toBe('归属：项目「官网改版」');
  });
});

describe('W1：ensureProjectConversation 的边界', () => {
  it('没有总管时报错，什么都不写', async () => {
    const fix = await setup();
    const project = wangProject(fix);
    fix.ctx.store.table('bots').patch(fix.chief.id, { role: 'executor' });
    const topics = fix.ctx.store.table('projectTopics').count();
    expect(() => ensureProjectConversation(fix.ctx, project.id)).toThrow('还没有总管');
    expect(fix.ctx.store.table('projectTopics').count()).toBe(topics);
    expect(fix.ctx.store.table('projects').get(project.id)!.memberBotIds).toEqual([fix.wang.id]);
  });
});
