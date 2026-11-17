/**
 * P75r6 第 4、5 节：学习的 7 天从主人选会话时算起（复验 N4）；会话标题也要隐去，标题是外部文字（复验 N5）。
 *
 * 第 4 节：总管发起学习之后，主人可能隔很多天才选会话（提问卡不过期）。以前 7 天从发起时算起：隔 8 天才选、之后一次打断，
 * 下一次巡检就把学习记成「等待超过 7 天」，实际选会话只过了几分钟。现在从选会话时算起；选会话之后真的 7 天没做成，仍然过期。
 * 第 5 节：会话标题（通常取自会话的第一条消息）里可能带着密钥：存进学习记录之前先隐去，之后提问卡选项、总管私聊里主人所选的那一行、
 * 出处标签、唤醒包用的都是隐去之后的标题；给模型看的出处标签写固定的「你指定的会话」，标题挪进这条出处的围栏作为第一行「标题：…」。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具；时间用注入的假时钟（跨天直接设到目标时刻）。
 */
import { describe, expect, it } from 'vitest';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import {
  MINUTE, bot, callTool, chiefChat, chiefTeaches, chooseLearnByButton, commitAndEnd, checkSectionOf, expectMigrated, flow, learnAsked, learnCards, learnItems, learnRun,
  learnSectionOf, learnerProposes, nextPacket, participantOf, putSessions, seedExport, tick, updatesIn, type JobFix,
} from './p75r6-fixtures.js';

const DAY = 24 * 60 * MINUTE;

/** 把假时钟往后推 days 天，并让每位员工沿用原来的会话（跨天之后会话会超过最长存活时间，唤醒包就读不到了；与 setLocal 同一做法）。 */
function jumpDays(fix: JobFix, days: number): void {
  fix.ctx.clock.advance(days * DAY);
  for (const row of fix.ctx.store.table('bots').list()) fix.ctx.store.table('bots').patch(row.id, { sessionStartedAt: fix.ctx.clock.now() });
}

/** 打断员工；之后把原会话接回去（与 p75r5b-lifecycle 同一做法），让下一个回合的唤醒包走「投递」、夹具读得到。 */
async function interruptAndResume(fix: JobFix, botId: string): Promise<void> {
  const sessionId = bot(fix, botId).sessionId!;
  expect(await fix.hub.api.interruptBot({ botId })).toMatchObject({ ok: true });
  fix.ctx.host.sessions.set(sessionId, { exists: true, running: false, contextRatio: 0 });
  fix.ctx.store.table('bots').patch(botId, { sessionId, sessionStartedAt: fix.ctx.clock.now() });
}

/** 学习的员工提交、交账；核对人核对通过，学习记录结束。 */
async function learnRunsToEnd(fix: JobFix): Promise<void> {
  const { result } = await learnerProposes(fix);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
  const packet = await nextPacket(fix, fix.reviewer.id);
  const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(packet)[0]!.id, consistent: 'met', withinScope: 'met' });
  expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
}

/** 主人看得见的文字：总管私聊、活动流。 */
function visibleTexts(fix: JobFix): string[] {
  return [...chiefChat(fix).map(row => row.text), ...fix.hub.api.activity().rows.flatMap(row => [row.text, ...(row.lines ?? [])])];
}

describe('4 学习的 7 天从主人选会话时算起（N4）', () => {
  it('总管发起学习，主人隔 8 天才选会话，学习回合被打断一次：学习没有被记成过期，下一次巡检补排，照常进行直到做完', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    const askedAt = fix.ctx.clock.now();
    jumpDays(fix, 8); // 主人隔 8 天才选（提问卡不过期）
    expect(await chooseLearnByButton(fix, asked)).toMatchObject({ ok: true });
    const chosenAt = fix.ctx.clock.now();
    expect(learnRun(fix)!.learn!.chosenAt).toBe(chosenAt); // 记下了选会话的时刻
    expect(chosenAt - askedAt).toBeGreaterThan(7 * DAY);
    await nextPacket(fix, fix.engineer.id); // 学习员工拿到回合
    await interruptAndResume(fix, fix.engineer.id); // 主人打断一次：候选被收回，参与者改回排队中
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    // 下一次巡检：没有记成过期（以前这里就记 expired、学习当场结束），而是补排。
    await tick(fix, 5 * MINUTE);
    const midway = learnRun(fix)!;
    expect(midway.endedAt).toBeNull();
    expect(participantOf(midway, fix.engineer.id)!.state).not.toBe('expired');
    expect(chiefChat(fix).some(row => row.text.includes('等待超过 7 天'))).toBe(false);
    // 照常进行：学习员工再拿到回合、提交、核对人核对通过，学习正常结束。
    await learnRunsToEnd(fix);
    const end = learnRun(fix)!;
    expect(end.endedAt).not.toBeNull();
    expect(chiefChat(fix).at(-1)!.text).toContain('已从这段会话学到');
    expect(visibleTexts(fix).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('反例：选会话之后真的过了 7 天没有做成（打断之后一直没有被排上）：过期，学习结束，总管私聊落「等待超过 7 天」', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    expect(await chooseLearnByButton(fix, asked)).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id);
    await interruptAndResume(fix, fix.engineer.id);
    // 选会话之后过了 7 天零一点：过期（直接把假时钟设到目标时刻，不逐步推进）。
    jumpDays(fix, 8);
    await tick(fix, 5 * MINUTE);
    const end = learnRun(fix)!;
    expect(end.endedAt).not.toBeNull();
    expect(participantOf(end, fix.engineer.id)).toMatchObject({ state: 'expired', reason: 'skill_expired' });
    expect(chiefChat(fix).at(-1)!.text).toBe('林舟这次学习没有完成：等待超过 7 天。');
  });

  it('旧记录没有选会话的时刻：仍按记录建立的时刻起算（兼容）', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    expect(await chooseLearnByButton(fix, asked)).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id);
    await interruptAndResume(fix, fix.engineer.id);
    // 把选会话的时刻抹掉（模拟升级之前写下的旧记录），记录建立已超过 7 天：过期。
    const run = learnRun(fix)!;
    const { chosenAt: _drop, ...learnWithout } = run.learn!;
    fix.ctx.store.table('skillRuns').put({ ...run, learn: learnWithout });
    jumpDays(fix, 8);
    await tick(fix, 5 * MINUTE);
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'expired' });
  });
});

describe('5 会话标题也要隐去；标题是外部文字（N5）', () => {
  // 编造的，不是真密钥；拆成两段拼接，避免公开仓库的密钥形状扫描命中源码连写。
  const KEY = 'sk-' + 'FAKEabcdefghijkl1234';
  const TITLE = `配 ${KEY} 的那次`;

  it('标题里带一段像密钥的字符串：学习记录、提问卡选项、总管私聊所选的那一行、出处标签、学习唤醒包、核对唤醒包里都没有这段字符串；唤醒包里标题在围栏内', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    putSessions(fix);
    (fix.ctx.host as FakeHost).recentSessions[0]!.title = TITLE;
    const { result } = await chiefTeaches(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '请主人选会话', reply: '是哪一段？' });
    const run = learnRun(fix)!;
    const item = learnItems(fix)[0]!;
    const card = learnCards(fix)[0]!;
    // 学习记录、提问卡的选项里都没有密钥，标题其余的字还在。
    expect(JSON.stringify(run)).not.toContain(KEY);
    expect(run.learn!.sessions[0]!.title).toBe('配 （已隐去） 的那次');
    expect(JSON.stringify(item)).not.toContain(KEY);
    expect(item.options[0]).toContain('配 （已隐去） 的那次');
    expect(JSON.stringify(fix.hub.api.thread(fix.chief.id).messages)).not.toContain(KEY);
    // 主人选这一段：总管私聊里主人所选的那一行、出处标签（记录里）也没有密钥。
    const asked = { run, card, item };
    expect(await chooseLearnByButton(fix, asked as never)).toMatchObject({ ok: true });
    expect(JSON.stringify(chiefChat(fix))).not.toContain(KEY);
    const source = fix.ctx.store.table('skillSources').list(row => row.kind === 'owner_instruction')[0]!;
    expect(JSON.stringify(source)).not.toContain(KEY);
    expect(source.label).toBe('会话『配 （已隐去） 的那次』'); // 给主人看的地方仍显示标题（隐去之后的）
    // 学习唤醒包：没有密钥；出处标签是固定的「你指定的会话」；标题在摘要的围栏里（第一行）。
    const packet = await nextPacket(fix, fix.engineer.id);
    const learn = learnSectionOf(packet);
    expect(packet).not.toContain(KEY);
    expect(learn).toContain('出处：src1 你的指示｜你指定的会话');
    expect(learn).toContain('<<<untrusted\n标题：配 （已隐去） 的那次\n');
    expect(learn.replace(/<<<untrusted\n[\s\S]*?\nuntrusted>>>/g, '〔围栏〕')).not.toContain('配 ');
    // 学习员工提交，核对人的核对唤醒包里同样没有密钥、标题在围栏内。
    const proposed = await learnerProposes(fix);
    expect(proposed.result, JSON.stringify(proposed.result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    const checkPacket = await nextPacket(fix, fix.reviewer.id);
    expect(checkPacket).not.toContain(KEY);
    const check = checkSectionOf(checkPacket);
    expect(check).toContain('出处 你指定的会话：见下面的会话摘要');
    expect(check).toContain('<<<untrusted\n标题：配 （已隐去） 的那次\n');
    // 给主人看的文字（总管私聊、活动流）里也没有密钥。
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(checkPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
    expect(visibleTexts(fix).join('\n')).not.toContain(KEY);
    expect(visibleTexts(fix).join('\n')).toContain('会话『配 （已隐去） 的那次』'); // 技能库来源一句仍显示标题
  });

  it('反例：普通标题原样保留（含冒号、数字、英文单词），出处标签仍是固定的「你指定的会话」，标题在围栏里', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    expect(learnRun(fix)!.learn!.sessions[0]!.title).toBe('导出报名表');
    expect(await chooseLearnByButton(fix, asked)).toMatchObject({ ok: true });
    const learn = learnSectionOf(await nextPacket(fix, fix.engineer.id));
    expect(learn).toContain('出处：src1 你的指示｜你指定的会话');
    expect(learn).toContain('<<<untrusted\n标题：导出报名表\n');
  });
});
