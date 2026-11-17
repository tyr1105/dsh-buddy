/**
 * P74r10 第 1 节的测试：给员工换了模型，下一次叫醒时重建会话、用新模型。
 *
 * 覆盖：
 * 1 会话用模型甲建的，主人经「编辑员工」命令改成乙：下一次叫醒调用 createSession（带乙）、不调用 deliver，会话编号变了，sessionModel 是乙；
 * 2 改成乙之后又改回甲（下一次叫醒之前）：下一次叫醒调用 deliver，会话编号不变；
 * 3 指定模型改成跟随默认、跟随默认改成指定模型：都重建；
 * 4 没有改模型：照旧 deliver；
 * 5 升级前的员工（有会话、没有 sessionModel）：改了模型重建，没改不重建；
 * 6 一件事执行到一半换了执行者的模型：执行链的下一次叫醒建新会话、带新模型，唤醒包里仍有「你手上的事」，这件事能走到交付；
 * 7 建会话成功时 sessionModel 由真实的派发写入。
 * 全部走真实的 Hub，宿主用夹具里的假宿主（它记录每次 createSession 带的模型和每次 deliver）；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import type { ModelChoice } from '../src/model/primitives.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';
import { MINUTE, bot, callTool, commitAndEnd, jobFix, tick, wakesOf, type JobFix } from './p74c-fixtures.js';
import { engineerSubmits, executorInfo, nextPacket, putStandardFiles, reviewerInfo, reviewerThoughtRecently, started, theJob } from './p74d-fixtures.js';

/** 模型甲、模型乙：同一厂商不同型号；另有一个换了厂商的模型丙。 */
const MODEL_A: ModelChoice = { provider: 'p1', model: 'm-a' };
const MODEL_B: ModelChoice = { provider: 'p1', model: 'm-b' };

/** 这位员工到现在为止对宿主的 createSession 调用（带着传给宿主的模型和第一条消息）。 */
function createsOf(fix: JobFix, botId: string) {
  return fix.ctx.host.calls
    .filter(call => call.method === 'createSession' && (call.args[0] as { botId: string }).botId === botId)
    .map(call => call.args[0] as { model: ModelChoice; firstMessage: string });
}

/** 这位员工当前会话（由记录上的会话编号给出）到现在为止收到的 deliver 次数。 */
function deliversTo(fix: JobFix, sessionId: string): number {
  return fix.ctx.host.calls.filter(call => call.method === 'deliver' && call.args[0] === sessionId).length;
}

/**
 * 把员工设成「会话是用 model 建的」：员工的模型和 sessionModel 都写成 model。
 * 为什么直接写记录：夹具里的会话是预先放好的，不是由派发建的；真实派发写 sessionModel 的那一步单独在第 7 组测。
 */
function sessionBuiltWith(fix: JobFix, botId: string, model: ModelChoice): void {
  fix.ctx.store.table('bots').patch(botId, { model, sessionModel: model });
}

/** 主人经「编辑员工」命令改员工的模型，必须成功。 */
async function ownerChangesModel(fix: JobFix, botId: string, model: ModelChoice): Promise<void> {
  const result = await fix.hub.api.updateBot(botId, { model });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

/**
 * 主人给这位员工留一句话，推进时间（每次 5 分钟，最多 40 分钟），直到宿主收到这位员工的 createSession 或对旧会话的 deliver。
 * 返回叫醒前后两种调用各增加了几次。
 */
async function wakeByOwner(fix: JobFix, botId: string): Promise<{ created: number; delivered: number }> {
  const oldSession = bot(fix, botId).sessionId!;
  const before = { created: createsOf(fix, botId).length, delivered: deliversTo(fix, oldSession) };
  await ownerSays(fix, botId, '请看一下这件事');
  for (let i = 0; i < 8 && createsOf(fix, botId).length === before.created && deliversTo(fix, oldSession) === before.delivered; i += 1) await tick(fix, 5 * MINUTE);
  return { created: createsOf(fix, botId).length - before.created, delivered: deliversTo(fix, oldSession) - before.delivered };
}

describe('1 换了模型，下一次叫醒重建会话', () => {
  it('甲改乙：下一次叫醒调用 createSession（带乙），不调用 deliver；会话编号变了，sessionModel 是乙', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    const oldSession = bot(fix, fix.engineer.id).sessionId;
    await ownerChangesModel(fix, fix.engineer.id, MODEL_B);
    // 改完之后、叫醒之前：记录上 sessionModel 仍是甲，model 是乙。
    expect(bot(fix, fix.engineer.id)).toMatchObject({ model: MODEL_B, sessionModel: MODEL_A, sessionId: oldSession });
    const woke = await wakeByOwner(fix, fix.engineer.id);
    expect(woke).toEqual({ created: 1, delivered: 0 });
    expect(createsOf(fix, fix.engineer.id).at(-1)!.model).toEqual(MODEL_B);
    const after = bot(fix, fix.engineer.id);
    expect(after.sessionId).not.toBe(oldSession);
    expect(after.sessionModel).toEqual(MODEL_B);
  });

  it('改成乙之后、下一次叫醒之前又改回甲：调用 deliver，会话编号不变', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    const oldSession = bot(fix, fix.engineer.id).sessionId;
    await ownerChangesModel(fix, fix.engineer.id, MODEL_B);
    await ownerChangesModel(fix, fix.engineer.id, MODEL_A);
    const woke = await wakeByOwner(fix, fix.engineer.id);
    expect(woke).toEqual({ created: 0, delivered: 1 });
    expect(bot(fix, fix.engineer.id)).toMatchObject({ sessionId: oldSession, sessionModel: MODEL_A, model: MODEL_A });
  });

  it('指定模型改成跟随默认（空值）：重建，新会话带空值，sessionModel 记为空值', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    await ownerChangesModel(fix, fix.engineer.id, null as never);
    const woke = await wakeByOwner(fix, fix.engineer.id);
    expect(woke).toEqual({ created: 1, delivered: 0 });
    expect(createsOf(fix, fix.engineer.id).at(-1)!.model).toBeNull();
    expect(bot(fix, fix.engineer.id).sessionModel).toBeNull();
  });

  it('跟随默认改成指定模型：重建，新会话带这个模型', async () => {
    const fix = await jobFix();
    // 会话是跟随默认（空值）时建的。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: null, sessionModel: null });
    await ownerChangesModel(fix, fix.engineer.id, MODEL_B);
    const woke = await wakeByOwner(fix, fix.engineer.id);
    expect(woke).toEqual({ created: 1, delivered: 0 });
    expect(createsOf(fix, fix.engineer.id).at(-1)!.model).toEqual(MODEL_B);
    expect(bot(fix, fix.engineer.id).sessionModel).toEqual(MODEL_B);
  });

  it('只换了厂商、型号名相同：算不同，重建', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    await ownerChangesModel(fix, fix.engineer.id, { provider: 'p2', model: MODEL_A!.model });
    expect(await wakeByOwner(fix, fix.engineer.id)).toEqual({ created: 1, delivered: 0 });
  });

  it('没有改模型：照旧 deliver，不重建', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    const oldSession = bot(fix, fix.engineer.id).sessionId;
    const woke = await wakeByOwner(fix, fix.engineer.id);
    expect(woke).toEqual({ created: 0, delivered: 1 });
    expect(bot(fix, fix.engineer.id).sessionId).toBe(oldSession);
  });

  it('改了与模型无关的字段（只改说明）：照旧 deliver', async () => {
    const fix = await jobFix();
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    const result = await fix.hub.api.updateBot(fix.engineer.id, { brief: '多写注释' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await wakeByOwner(fix, fix.engineer.id)).toEqual({ created: 0, delivered: 1 });
  });
});

describe('5 升级前建的会话（记录上没有 sessionModel）', () => {
  it('有会话、没有 sessionModel，主人改了模型：编辑时把改之前的模型记成 sessionModel，下一次叫醒重建', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: MODEL_A });
    expect(bot(fix, fix.engineer.id).sessionModel).toBeUndefined();
    await ownerChangesModel(fix, fix.engineer.id, MODEL_B);
    expect(bot(fix, fix.engineer.id).sessionModel).toEqual(MODEL_A);
    expect(await wakeByOwner(fix, fix.engineer.id)).toEqual({ created: 1, delivered: 0 });
    expect(createsOf(fix, fix.engineer.id).at(-1)!.model).toEqual(MODEL_B);
  });

  it('同样的员工没有改模型（只改说明）：不记 sessionModel，不重建', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: MODEL_A });
    const result = await fix.hub.api.updateBot(fix.engineer.id, { brief: '多写注释' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(bot(fix, fix.engineer.id).sessionModel).toBeUndefined();
    expect(await wakeByOwner(fix, fix.engineer.id)).toEqual({ created: 0, delivered: 1 });
  });

  it('编辑时传了与现在相同的模型：不算改，不记 sessionModel，不重建', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: MODEL_A });
    await ownerChangesModel(fix, fix.engineer.id, { ...MODEL_A! });
    expect(bot(fix, fix.engineer.id).sessionModel).toBeUndefined();
    expect(await wakeByOwner(fix, fix.engineer.id)).toEqual({ created: 0, delivered: 1 });
  });

  it('旧存档没有 sessionModel 照常能读：员工记录通过校验', async () => {
    const fix = await jobFix();
    const row = fix.ctx.store.table('bots').get(fix.engineer.id)!;
    expect('sessionModel' in row ? row.sessionModel : undefined).toBeUndefined();
  });
});

describe('6 一件事执行到一半换了执行者的模型', () => {
  it('执行链的下一次叫醒建新会话、带新模型，唤醒包里仍有「你手上的事」，这件事能走到交付', async () => {
    const { fix, info } = await started();
    // 林舟这件事的会话是用模型甲建的（执行到一半）；先交一次中间进展并结束回合，执行链还要再叫醒他。
    sessionBuiltWith(fix, fix.engineer.id, MODEL_A);
    const oldSession = bot(fix, fix.engineer.id).sessionId;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做了一半' });
    // 宿主里旧会话这一回合已经结束。
    fix.ctx.host.sessions.set(oldSession!, { exists: true, running: false, contextRatio: 0 });
    await ownerChangesModel(fix, fix.engineer.id, MODEL_B);
    const before = createsOf(fix, fix.engineer.id).length;
    for (let i = 0; i < 8 && createsOf(fix, fix.engineer.id).length === before; i += 1) await tick(fix, 5 * MINUTE);
    const created = createsOf(fix, fix.engineer.id);
    expect(created.length - before, '执行链的下一次叫醒应该建了新会话').toBe(1);
    expect(created.at(-1)!.model).toEqual(MODEL_B);
    // 唤醒包是新会话的第一条消息：写明是新的工作会话，并且仍有「你手上的事」。
    const packet = created.at(-1)!.firstMessage;
    expect(packet).toContain('这是你的新工作会话');
    expect(packet).toContain('## 你手上的事（中心维护）');
    const again = executorInfo(packet);
    expect(again.jobId).toBe(info.jobId);
    expect(bot(fix, fix.engineer.id)).toMatchObject({ sessionModel: MODEL_B });
    expect(bot(fix, fix.engineer.id).sessionId).not.toBe(oldSession);
    // 新会话里的员工照常交回、核对通过，这件事走到交付。
    reviewerThoughtRecently(fix);
    await putStandardFiles(fix, again);
    await engineerSubmits(fix, again);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    // 核对通过之后交付给主人，等主人验收。
    expect(theJob(fix).state).toBe('awaiting_owner');
  });
});

describe('7 建会话成功时写入 sessionModel', () => {
  it('没有会话的员工被叫醒：新会话带员工当前的模型，sessionModel 与之相同', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: MODEL_B, sessionId: null, sessionStartedAt: null });
    expect(await wakeByOwner(fix, fix.engineer.id)).toMatchObject({ created: 1 });
    expect(createsOf(fix, fix.engineer.id).at(-1)!.model).toEqual(MODEL_B);
    expect(bot(fix, fix.engineer.id).sessionModel).toEqual(MODEL_B);
  });

  it('wakesOf 能数到这次叫醒（保证上面的叫醒是一次真实的回合）', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { model: MODEL_B, sessionId: null, sessionStartedAt: null });
    await wakeByOwner(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id).length).toBeGreaterThan(0);
  });
});
