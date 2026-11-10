/**
 * P65 的兜底与边界：回不了主题时照旧落私聊、旧数据照常、到期默认处理不算主人回答、
 * 回到主题的回合照旧不计窗口回合（账本照记），以及几条规则函数本身。
 * 时间一律用注入的假时钟推进，不等真实时间。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalSchema, InboxItemSchema } from '../src/model/index.js';
import { prepareApproval } from '../src/gate/approvals.js';
import { archiveProject, pauseProject } from '../src/project/service.js';
import { followUpNoteText, followUpTopic, topicReplyFields } from '../src/project/topic-followup.js';
import { buildSnapshot } from '../src/scheduler/gates.js';
import { modelFixtures } from './model-fixtures.js';
import { floors, openTopic, queued, runningWake, speak, topicHub, type TopicHub } from './p63-topic-fixtures.js';
import { ask, expectOk, expectPrivate, followUpOf, privateThread } from './p65-topic-followup-fixtures.js';
import type { Bot, InboxItem } from '../src/model/index.js';

/** 小王在主题里提了一个问题，负责人收了尾，这一轮已经结束。 */
async function wangAsked(): Promise<{ fix: TopicHub; boss: Bot; wang: Bot; topicId: string; item: InboxItem }> {
  const fix = await topicHub();
  const [boss, wang] = fix.bots;
  const topicId = await openTopic(fix, '@小王 先看');
  const item = await ask(fix, wang!);
  await speak(fix, boss!, '等主人定');
  return { fix, boss: boss!, wang: wang!, topicId, item };
}

/** 回答后照旧落私聊：主题一条不多、计数和名单不变，后续回合不带主题，私聊记下主人的回答，负责人没被叫。 */
async function expectPrivateFollowUp(env: Awaited<ReturnType<typeof wangAsked>>): Promise<void> {
  const { fix, boss, wang, topicId, item } = env;
  const floorsBefore = floors(fix.ctx, topicId).length;
  const topicBefore = fix.ctx.store.table('projectTopics').get(topicId);
  expectOk(await fix.hub.api.answerInbox(item.id, 'A'));
  expect(floors(fix.ctx, topicId)).toHaveLength(floorsBefore);
  expect(fix.ctx.store.table('projectTopics').get(topicId)).toEqual(topicBefore);
  expect(fix.ctx.store.table('queue').count(row => row.topicId === topicId)).toBe(0);
  expect(fix.ctx.store.table('wakes').count(row => row.topicId === topicId && row.reason.kind === 'inbox_reply')).toBe(0);
  expect(privateThread(fix.ctx, wang.id).at(-1)).toMatchObject({ from: 'owner', kind: 'reply', text: '「选 A 还是 B」：A' });
  expect(runningWake(fix.ctx, boss.id)).toBeUndefined();
}

describe('P65 兜底：回不了主题时照旧落私聊，不报错', () => {
  it('主题已经删除', async () => {
    const env = await wangAsked();
    env.fix.ctx.store.table('projectTopics').remove(env.topicId);
    await expectPrivateFollowUp(env);
    expectPrivate(followUpOf(env.fix.ctx, env.item.id, 'inbox_reply'));
  });

  it('项目暂停了', async () => {
    const env = await wangAsked();
    pauseProject(env.fix.ctx, env.fix.project.id);
    await expectPrivateFollowUp(env);
    expectPrivate(runningWake(env.fix.ctx, env.wang.id));
  });

  it('项目归档了', async () => {
    const env = await wangAsked();
    archiveProject(env.fix.ctx, env.fix.project.id);
    await expectPrivateFollowUp(env);
    expectPrivate(runningWake(env.fix.ctx, env.wang.id));
  });

  it('队友已经不是项目成员', async () => {
    const env = await wangAsked();
    expectOk(await env.fix.hub.api.saveProject({ id: env.fix.project.id, name: '季度战役', ownerBotId: env.boss.id, memberBotIds: [env.boss.id] }));
    await expectPrivateFollowUp(env);
    expectPrivate(runningWake(env.fix.ctx, env.wang.id));
  });

  it('队友不在岗：后续回合照旧被调度丢掉，主题里不落「这一棒跳过」，也不因此叫负责人', async () => {
    const env = await wangAsked();
    env.fix.ctx.store.table('bots').patch(env.wang.id, { lifecycle: 'paused' });
    await expectPrivateFollowUp(env);
    expect(floors(env.fix.ctx, env.topicId).some(row => row.text.includes('不在岗'))).toBe(false);
    expect(queued(env.fix.ctx, env.boss.id, env.topicId)).toBeUndefined();
  });

  it('正例对照：同样的环境不加任何兜底条件时回到主题', async () => {
    const { fix, wang, topicId, item } = await wangAsked();
    expectOk(await fix.hub.api.answerInbox(item.id, 'A'));
    expect(runningWake(fix.ctx, wang.id)).toMatchObject({ topicId });
  });
});

describe('P65 旧数据照常', () => {
  it('模型样例没有 topicId 也能通过校验；带了就必须是主题 id', () => {
    for (const [schema, valid] of [[InboxItemSchema, modelFixtures.InboxItem.valid], [ApprovalSchema, modelFixtures.Approval.valid]] as const) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...(valid as object), topicId: 'ptp_0000000001' }).success).toBe(true);
      expect(schema.safeParse({ ...(valid as object), topicId: null }).success).toBe(true);
      expect(schema.safeParse({ ...(valid as object), topicId: 'b_0000000001' }).success).toBe(false);
    }
  });

  it('P65 之前存下的提问卡（没有 topicId）：能答，回答后照旧落私聊', async () => {
    const env = await wangAsked();
    const { topicId: _drop, ...legacy } = env.item;
    env.fix.ctx.store.table('inbox').put(legacy);
    expect(InboxItemSchema.safeParse(legacy).success).toBe(true);
    await expectPrivateFollowUp(env);
  });

  it('P65 之前存下的审批单（没有 topicId）：能批，批准后照旧落私聊', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/x' }, 'C', '要写文件');
    const { topicId: _drop, ...legacy } = approval;
    fix.ctx.store.table('approvals').put(legacy);
    await speak(fix, owner!, '等你批准');
    const before = floors(fix.ctx, topicId).length;
    expectOk(await fix.hub.api.decideApproval(approval.id, true));
    expect(floors(fix.ctx, topicId)).toHaveLength(before);
    const followUp = followUpOf(fix.ctx, approval.id, 'approval_decided');
    expectPrivate(followUp);
    expect(followUp!.ownerInitiated).toBe(false);
  });
});

describe('P65 到期默认处理不是主人的回答', () => {
  it('提问到期按默认处理：照旧落私聊，主题里不加旁白、不动计数', async () => {
    const { fix, wang, topicId, item } = await wangAsked();
    const before = floors(fix.ctx, topicId).length;
    const turns = fix.ctx.store.table('projectTopics').get(topicId)!.agentTurnsSinceOwner;
    fix.ctx.clock.advance(fix.ctx.settings.questionExpiryMs + 60_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'expired', answer: 'A' });
    expect(floors(fix.ctx, topicId)).toHaveLength(before);
    expect(fix.ctx.store.table('projectTopics').get(topicId)).toMatchObject({ agentTurnsSinceOwner: turns, pendingBotIds: [] });
    const followUp = followUpOf(fix.ctx, item.id, 'inbox_reply');
    expectPrivate(followUp);
    expect(followUp!.ownerInitiated).toBe(false);
    expect(privateThread(fix.ctx, wang.id).some(row => row.from === 'hub' && row.text === '「选 A 还是 B」已按默认回答处理：A')).toBe(true);
  });

  it('审批过期是中心处理的：照旧落私聊，主题里不加旁白', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/x' }, 'C', '要写文件');
    await speak(fix, owner!, '等你批准');
    const before = floors(fix.ctx, topicId).length;
    fix.ctx.clock.advance(fix.ctx.settings.approvalExpiryMs + 60_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
    expect(floors(fix.ctx, topicId)).toHaveLength(before);
    expectPrivate(followUpOf(fix.ctx, approval.id, 'approval_decided'));
  });
});

describe('P65 额度：回到主题的那一回合照旧不计窗口回合，账本照记', () => {
  it('提问回答后接着做的那一回合：窗口回合、自主额度都不加，账本有这一条', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const item = await ask(fix, owner!);
    expectOk(await fix.hub.api.answerInbox(item.id, 'B'));
    const wakeId = runningWake(fix.ctx, owner!.id)!.id;
    await speak(fix, owner!, '好');
    const quota = fix.ctx.store.table('quota').get('quota');
    expect(quota?.botTurns ?? 0).toBe(0);
    expect(quota?.botTokens ?? 0).toBe(0);
    const ledger = fix.ctx.store.log('ledger').all().filter(row => row.wakeId === wakeId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.tokens).toBeGreaterThan(0);
    const snapshot = buildSnapshot(fix.ctx, owner!.id, fix.ctx.clock.now());
    expect(snapshot.todayTurns).toBe(0);
    expect(snapshot.windowTurns).toBe(0);
  });

  it('审批后回到主题的那一回合同样不计窗口、不占自主额度，账本照记', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/x' }, 'C', '要写文件');
    await speak(fix, owner!, '等你批准');
    expectOk(await fix.hub.api.decideApproval(approval.id, true));
    const wakeId = runningWake(fix.ctx, owner!.id)!.id;
    await speak(fix, owner!, '写好了');
    expect(fix.ctx.store.table('quota').get('quota')?.botTurns ?? 0).toBe(0);
    expect(fix.ctx.store.log('ledger').all().filter(row => row.wakeId === wakeId)).toHaveLength(1);
    expect(buildSnapshot(fix.ctx, owner!.id, fix.ctx.clock.now()).todayTurns).toBe(0);
  });

  it('反例：私聊提问回答后接着做的那一回合照旧计入窗口', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    expectOk(await fix.hub.api.sendMessage(owner!.id, '私聊问一句'));
    const item = await ask(fix, owner!);
    expectOk(await fix.hub.api.answerInbox(item.id, 'B'));
    await speak(fix, owner!, '好');
    expect(fix.ctx.store.table('quota').get('quota')?.botTurns).toBe(2);
  });
});

describe('P65 规则函数', () => {
  it('旁白：提问写「你回答了」，建议写接受或没有采纳；标题和回答太长时截短', () => {
    expect(followUpNoteText({ type: 'question', title: '选 A 还是 B' }, 'A')).toBe('你回答了「选 A 还是 B」：A');
    expect(followUpNoteText({ type: 'proposal', title: '早上看日志' }, '接受')).toBe('你接受了建议「早上看日志」。');
    expect(followUpNoteText({ type: 'proposal', title: '早上看日志' }, '不做')).toBe('你没有采纳建议「早上看日志」。');
    expect(followUpNoteText({ type: 'question', title: '题'.repeat(80) }, '答'.repeat(300)))
      .toBe(`你回答了「${'题'.repeat(60)}…」：${'答'.repeat(200)}…`);
  });

  it('能不能回主题：主题、项目进行中、是成员、在岗都成立才回；缺一项返回 null', async () => {
    const fix = await topicHub();
    const [, wang] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    expect(followUpTopic(fix.ctx, wang!.id, topicId)?.id).toBe(topicId);
    expect(followUpTopic(fix.ctx, null, topicId)).toBeNull();
    expect(followUpTopic(fix.ctx, wang!.id, null)).toBeNull();
    expect(followUpTopic(fix.ctx, wang!.id, undefined)).toBeNull();
    expect(followUpTopic(fix.ctx, wang!.id, 'ptp_0000000000')).toBeNull();
    expect(followUpTopic(fix.ctx, 'b_9999999999', topicId)).toBeNull();
    fix.ctx.store.table('bots').patch(wang!.id, { lifecycle: 'paused' });
    expect(followUpTopic(fix.ctx, wang!.id, topicId)).toBeNull();
  });

  it('后续候选的主题字段：带主题、算主人发起，活动句里有和其他主题回合同样截法的「主题「…」」', async () => {
    const fix = await topicHub();
    const topicId = await openTopic(fix, '长'.repeat(50));
    const fields = topicReplyFields(fix.ctx.store.table('projectTopics').get(topicId)!);
    expect(fields).toMatchObject({ topicId, ownerInitiated: true });
    expect(fields.ownerSummary).toBe(`按你的回复接着做主题「${'长'.repeat(40)}…」`);
    expect(fields.summary).toContain(`主题「${'长'.repeat(40)}…」`);
  });
});
