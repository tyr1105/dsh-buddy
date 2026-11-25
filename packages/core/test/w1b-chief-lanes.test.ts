/**
 * W1b 总管按项目分线：不同项目的总管回合可以同时跑，同一个项目里仍一次一个；
 * 第二条线同时在跑时用备用会话，工具按会话找到总管；别的员工行为不变。
 * 走真实 Hub + 假宿主（同 W1），测到的是真实的调度、投递、交账和打断。
 */
import { describe, expect, it } from 'vitest';
import type { Bot } from '../src/model/index.js';
import { saveProject } from '../src/project/service.js';
import { buildSnapshot } from '../src/scheduler/snapshot.js';
import { evaluateGates } from '../src/scheduler/gates.js';
import { MAIN_LANE, botForSession, laneOf, multiLaneText } from '../src/scheduler/lanes.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import { floors, ownerSays, setup, type Fix } from './p72b-fixtures.js';

/** 两个总管不负责的项目，各开一条项目对话。 */
async function twoProjects(fix: Fix) {
  const a = saveProject(fix.ctx, { name: '官网改版', charter: '换新版式', memberBotIds: [fix.wang.id], ownerBotId: fix.wang.id });
  const b = saveProject(fix.ctx, { name: '报价页', charter: '每日报价', memberBotIds: [fix.li.id], ownerBotId: fix.li.id });
  const aTopic = okData(await fix.hub.api.openProjectConversation({ projectId: a.id })).topicId;
  const bTopic = okData(await fix.hub.api.openProjectConversation({ projectId: b.id })).topicId;
  return { a, b, aTopic, bTopic };
}

/** 这位员工还开着的唤醒单，按开始时刻排。 */
function openWakes(fix: Fix, botId: string) {
  return fix.ctx.store.table('wakes').list(row => row.botId === botId && row.endedAt === null && ['running', 'delivering'].includes(row.status))
    .sort((x, y) => x.startedAt - y.startedAt);
}

/** 在指定会话里交账并结束回合（总管第二条线用的是备用会话，不能用 bot.sessionId）。 */
async function speakIn(fix: Fix, sessionId: string, reply: string | null): Promise<void> {
  const commit = fix.hub.tools().find(tool => tool.name === 'hub_commit')!;
  const result = await commit.handler(sessionId, commitArgs({ reply }));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await fix.hub.onTurnEvent({ type: 'ended', sessionId, at: fix.ctx.clock.now(), finalText: '', tokens: 500 });
}

function chiefRow(fix: Fix): Bot {
  return fix.ctx.store.table('bots').get(fix.chief.id)!;
}

describe('W1b：总管在两个项目里同时做事', () => {
  it('两个项目对话里各说一句：两个回合同时在跑，第二个用备用会话，会话标题写项目名；状态写同时在处理 2 个项目', async () => {
    const fix = await setup();
    const { a, b, aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    await ownerSays(fix, bTopic, '报价页进度怎样');
    const open = openWakes(fix, fix.chief.id);
    expect(open.map(row => row.topicId)).toEqual([aTopic, bTopic]);
    expect(open[0]!.sessionId).toBe(fix.chief.sessionId);
    const extra = open[1]!.sessionId!;
    expect(extra).not.toBe(fix.chief.sessionId);
    expect(chiefRow(fix).sessionId).toBe(fix.chief.sessionId);
    expect(chiefRow(fix).extraSessions).toEqual([expect.objectContaining({ slot: 1, sessionId: extra })]);
    const created = fix.ctx.host.calls.filter(call => call.method === 'createSession').at(-1)!.args[0] as { title: string; firstMessage: string };
    expect(created.title).toBe('老大 · Agent 中心（报价页）');
    expect(created.firstMessage).toContain('## 别的线和员工此刻在做什么');
    expect(created.firstMessage).toContain('项目「官网改版」');
    expect(chiefRow(fix)).toMatchObject({ activity: 'thinking', activityText: multiLaneText(2) });
    expect(laneOf(fix.ctx, fix.chief, open[0]!)).toBe(a.id);
    expect(laneOf(fix.ctx, fix.chief, open[1]!)).toBe(b.id);
    // 工具按会话找人：备用会话也是总管。
    expect(botForSession(fix.ctx, extra)?.id).toBe(fix.chief.id);
  });

  it('两条线各自交账：回复落在各自的项目对话里；一条结束后状态写另一条在做的事，都结束后回到关注', async () => {
    const fix = await setup();
    const { aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    await ownerSays(fix, bTopic, '报价页进度怎样');
    const [wa, wb] = openWakes(fix, fix.chief.id);
    await speakIn(fix, wb!.sessionId!, '报价页还没开工。');
    expect(floors(fix.ctx, bTopic).filter(row => row.from === fix.chief.id).map(row => row.text)).toEqual(['报价页还没开工。']);
    expect(floors(fix.ctx, aTopic).filter(row => row.from === fix.chief.id)).toHaveLength(0);
    expect(chiefRow(fix).activity).toBe('thinking');
    expect(chiefRow(fix).activityText).toMatch(/^正在处理：/);
    await speakIn(fix, wa!.sessionId!, '官网在改首页。');
    expect(floors(fix.ctx, aTopic).filter(row => row.from === fix.chief.id).map(row => row.text)).toEqual(['官网在改首页。']);
    expect(chiefRow(fix).activity).not.toBe('thinking');
    // 都空下来后，下一次照旧先用原来的会话。
    await ownerSays(fix, bTopic, '再看一眼');
    expect(openWakes(fix, fix.chief.id).map(row => row.sessionId)).toEqual([fix.chief.sessionId]);
  });

  it('同一个项目里仍一次一个：前一个回合没结束，第二句排队', async () => {
    const fix = await setup();
    const { aTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    await ownerSays(fix, aTopic, '顺便看看图片');
    expect(openWakes(fix, fix.chief.id)).toHaveLength(1);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id && row.topicId === aTopic)).toHaveLength(1);
  });

  it('项目线和私聊也能同时跑', async () => {
    const fix = await setup();
    const { aTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    await ownerSays(fix, fix.chief.id, '在吗');
    const open = openWakes(fix, fix.chief.id);
    expect(open).toHaveLength(2);
    expect(laneOf(fix.ctx, fix.chief, open[1]!)).toBe(MAIN_LANE);
  });

  it('全队并发上限仍是全局一份：已有一个回合在跑、上限是 1 时，另一个项目的候选被并发挡住', async () => {
    const fix = await setup();
    const { aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    const now = fix.ctx.clock.now();
    const entry = { id: 'q_0000000001', botId: fix.chief.id, priority: 50, enqueuedAt: now, notBefore: now, urgent: false, ownerInitiated: true,
      topicId: bTopic, reason: { kind: 'owner_message', summary: '主人说话', evidence: [] } } as never;
    const snapshot = buildSnapshot(fix.ctx, fix.chief.id, now, null, null, bTopic);
    expect(snapshot.running).toBe(false);
    expect(snapshot.runningCount).toBe(1);
    const verdict = evaluateGates(entry, snapshot, now, { ...fix.ctx.settings, maxConcurrentThinks: 1 });
    expect(verdict.pass ? 'pass' : verdict.by).toBe('concurrency');
    // 你在场时（上限 1）你亲自叫总管仍按平时的上限（2）算，所以能进第二条线。
    const present = evaluateGates(entry, { ...snapshot, ownerActiveAt: now }, now, { ...fix.ctx.settings, maxConcurrentThinks: 2, ownerActiveConcurrentThinks: 1 });
    expect(present.pass ? 'pass' : present.by).not.toBe('concurrency');
  });

  it('按项目打断：只停那个项目的回合，别的线照常；备用会话位被清空', async () => {
    const fix = await setup();
    const { aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    await ownerSays(fix, bTopic, '报价页进度怎样');
    const result = await fix.hub.api.interruptBot({ botId: fix.chief.id, topicId: bTopic });
    expect(result.ok).toBe(true);
    const open = openWakes(fix, fix.chief.id);
    expect(open.map(row => row.topicId)).toEqual([aTopic]);
    expect(chiefRow(fix).sessionId).toBe(fix.chief.sessionId);
    expect(chiefRow(fix).extraSessions).toEqual([expect.objectContaining({ slot: 1, sessionId: null })]);
    expect(chiefRow(fix)).toMatchObject({ activity: 'thinking' });
    expect(chiefRow(fix).activityText).toMatch(/^正在处理：/);
  });
});

describe('W1b：闸门按（总管、项目）算', () => {
  it('快照：别的项目在跑不算「这位员工正在跑」，同一个项目算；最短间隔按这条线自己的上一次思考', async () => {
    const fix = await setup();
    const { aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    const now = fix.ctx.clock.now();
    expect(buildSnapshot(fix.ctx, fix.chief.id, now, null, null, aTopic).running).toBe(true);
    expect(buildSnapshot(fix.ctx, fix.chief.id, now, null, null, bTopic).running).toBe(false);
    expect(buildSnapshot(fix.ctx, fix.chief.id, now, null, null, null).running).toBe(false);
    const [wa] = openWakes(fix, fix.chief.id);
    await speakIn(fix, wa!.sessionId!, '好的');
    const later = fix.ctx.clock.now();
    expect(buildSnapshot(fix.ctx, fix.chief.id, later, null, null, aTopic).laneLastThinkAt).not.toBeNull();
    expect(buildSnapshot(fix.ctx, fix.chief.id, later, null, null, bTopic).laneLastThinkAt).toBeNull();
  });

  it('最短间隔：总管刚在 A 想过，B 线上员工自己发起的候选不被最短间隔挡；A 线上的被挡', async () => {
    const fix = await setup();
    const { aTopic, bTopic } = await twoProjects(fix);
    await ownerSays(fix, aTopic, '官网进度怎样');
    const [wa] = openWakes(fix, fix.chief.id);
    await speakIn(fix, wa!.sessionId!, '好的');
    const now = fix.ctx.clock.now() + 1000;
    const entry = (topicId: string) => ({
      id: 'q_0000000001', botId: fix.chief.id, priority: 50, enqueuedAt: now, notBefore: now, urgent: false, ownerInitiated: false,
      topicId, reason: { kind: 'self_check', summary: '看看进度', evidence: [] },
    }) as never;
    const paceOf = (topicId: string) => {
      const verdict = evaluateGates(entry(topicId), buildSnapshot(fix.ctx, fix.chief.id, now, null, null, topicId), now, fix.ctx.settings);
      return verdict.pass ? 'pass' : verdict.by;
    };
    expect(paceOf(aTopic)).toBe('pace_min');
    expect(paceOf(bTopic)).not.toBe('pace_min');
  });

  it('不分线的员工不变：小王在两个项目各有一个主题，第二个要等第一个结束', async () => {
    const fix = await setup();
    const a = saveProject(fix.ctx, { name: '官网改版', charter: '', memberBotIds: [fix.wang.id], ownerBotId: fix.wang.id });
    const b = saveProject(fix.ctx, { name: '报价页', charter: '', memberBotIds: [fix.wang.id], ownerBotId: fix.wang.id });
    okData(await fix.hub.api.createProjectTopic({ projectId: a.id, text: '首页换图' }));
    okData(await fix.hub.api.createProjectTopic({ projectId: b.id, text: '报价改色' }));
    expect(openWakes(fix, fix.wang.id)).toHaveLength(1);
    const snapshot = buildSnapshot(fix.ctx, fix.wang.id, fix.ctx.clock.now());
    expect(snapshot.lane).toBeUndefined();
    expect(snapshot.laneLastThinkAt).toBeUndefined();
    expect(fix.ctx.store.table('bots').get(fix.wang.id)!.extraSessions).toBeUndefined();
  });
});
