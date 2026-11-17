/**
 * P74r3 的测试（一）：主人发起的回合里为提问出新版本，由总管写明这一版是不是在回答那个提问（复验报告 H1）。
 *
 * 场景：林舟问「要不要做暗色模式？」，主人在私聊对总管说「你看着办，需要改约定就改」，总管拿到的是主人发起的回合
 * （不是执行链回合）。裁定：不自动关联（主人这一回合说的可能是另一件不相干的改动），由总管用 answersAsk 写明。
 * 全部走真实 Hub（真实的启动整理、闸门、假时钟，每次推进不超过 10 分钟）；编号只用正则从唤醒包文字里取。
 * 断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { expectedActorOf } from '../src/job/chain.js';
import { CHAIN_ANSWERS_FALSE_TEXT } from '../src/project/agreement-chain.js';
import { writeSnapshot, engineerSubmits, executorInfo } from './p74d-fixtures.js';
import {
  MINUTE, askedChiefTurn, bot, callTool, chiefWakes, commitAndEnd, entriesOf, idsIn, lastPacket, nextPacket, ownerSays, pendingReopen, reviseArgs,
  runningOf, sectionOf, speak, started, tick, type JobFix,
} from './p74r2b-fixtures.js';

const ASK = '要不要做暗色模式？约定没写';

/** 这位总管名下开着的「待你处理」条目。 */
function openInbox(fix: JobFix) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open');
}

/**
 * 林舟提问并结束回合；总管排着的提问唤醒删掉（让总管的回合只来自主人的话）；主人在私聊发话。
 * 返回夹具、这件事、总管这一回合（主人发起）的唤醒包，以及只从包里取到的编号。
 */
async function askedThenOwnerTurn(question = ASK) {
  const s = await started();
  const { fix, job } = s;
  const asked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: question });
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
  for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
  await ownerSays(fix, fix.chief.id, '暗色模式的事你看着办，需要改约定就改');
  const packet = lastPacket(fix, bot(fix, fix.chief.id));
  return { ...s, packet, ...idsIn(packet) };
}

/** 总管 revise 并交账（卡片落楼）。 */
async function reviseAndCommit(fix: JobFix, agreementId: string, extra: Record<string, unknown> = {}) {
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '暗色模式约定里没有写，已请主人确认。', { outcome: 'needs_owner' });
  return result;
}

/** 林舟当前的回合（如果有）按「在等确认」结束，避免他的回合一直开着。 */
async function engineerWaits(fix: JobFix): Promise<void> {
  if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
}

describe('answersAsk: true（这一版在回答提问）', () => {
  it('出新版本后推进 4 小时：总管没有执行链回合、没有转受阻、没有「停住了」；主人确认后提问清掉、有回答事件、林舟被叫醒并能交回', async () => {
    const { fix, job, agreementId } = await askedThenOwnerTurn();
    const askEventId = fix.ctx.store.table('jobs').get(job.id)!.openAsk!.eventId;
    await reviseAndCommit(fix, agreementId, { answersAsk: true });
    // 提问关联到第 2 版；版本的来源仍是主人的话，卡片没有起因一行。
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    expect(agreement.versions[1]).toMatchObject({ no: 2, state: 'pending', source: 'owner_reopen' });
    expect(agreement.versions[1]!.askOrigin ?? null).toBeNull();
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toMatchObject({ fromId: fix.engineer.id, agreementNo: 2 });
    expect(expectedActorOf(fix.ctx.store.table('jobs').get(job.id)!)).toBeNull();
    // 推进 4 小时（24 次，每次 10 分钟）：总管不再被叫，这件事不转受阻。
    await engineerWaits(fix);
    const chiefBefore = chiefWakes(fix);
    for (let i = 0; i < 24; i += 1) {
      await engineerWaits(fix);
      await tick(fix, 10 * MINUTE);
    }
    expect(chiefWakes(fix)).toBe(chiefBefore);
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('doing');
    expect(openInbox(fix).filter(row => row.title.includes('停住了'))).toHaveLength(0);
    // 主人确认：提问标为已回答，林舟被叫醒并能交回；总管没有新回合。
    await engineerWaits(fix);
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const now = fix.ctx.store.table('jobs').get(job.id)!;
    expect(now.openAsk).toBeNull();
    expect(now.pause).toBeNull();
    const answered = fix.ctx.store.log('jobEvents').all().filter(row => row.jobId === job.id && row.kind === 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ refId: askEventId, to: [fix.engineer.id], data: { byAgreementNo: 2 } });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('总管刚回答你：按约定第 2 版处理：加暗色模式。');
    await engineerSubmits(fix, executorInfo(packet));
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('checking');
    expect(chiefWakes(fix)).toBe(chiefBefore);
  });

  it('主人撤销（总管 withdraw）之后：关联过的提问回到未回答，这件事又在等总管', async () => {
    const { fix, job, agreementId } = await askedThenOwnerTurn();
    await reviseAndCommit(fix, agreementId, { answersAsk: true });
    await engineerWaits(fix);
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toMatchObject({ agreementNo: 2 });
    await ownerSays(fix, fix.chief.id, '暗色模式这次不做');
    const withdrawn = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人不要暗色模式' });
    expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: true });
    const mid = fix.ctx.store.table('jobs').get(job.id)!;
    expect(mid.openAsk).toMatchObject({ fromId: fix.engineer.id });
    expect(mid.openAsk!.agreementNo ?? null).toBeNull();
    expect(mid.pause).toBeNull();
    expect(expectedActorOf(mid)).toBe(fix.chief.id);
  });
});

describe('没写 answersAsk：被拒', () => {
  it('有未回答的提问、主人发起的回合、revise：被拒，文字写明提问人和原文；约定和这件事没有任何写入', async () => {
    const { fix, job, agreementId } = await askedThenOwnerTurn();
    const before = { snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) };
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
    expect(result).toEqual({ ok: false, error: `这件事有一个没回答的提问：林舟问「${ASK}」。这一版是不是在回答它？是就写 answersAsk: true；不是就写 answersAsk: false，之后仍要用 hub_job_manage 的 answer 回答它。` });
    expect({ snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) }).toEqual(before);
  });

  it('提问原文超过 80 字：拒绝文字里截断到 80 字并加省略号', async () => {
    const long = `要不要做暗色模式？${'这个问题约定里没有写清楚所以来问。'.repeat(6)}`;
    const { fix, agreementId } = await askedThenOwnerTurn(long);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
    expect(result.ok).toBe(false);
    const shown = /问「(.+)」。这一版是不是在回答它/.exec(String(result.error))![1]!;
    expect([...shown]).toHaveLength(81);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.startsWith(long.slice(0, 80))).toBe(true);
  });
});

describe('answersAsk: false（这一版与提问无关）', () => {
  it('新版本待确认，提问仍在等总管；总管随后 answer 成功、林舟被叫醒；主人确认新版本后一切正常', async () => {
    const { fix, job, agreementId } = await askedThenOwnerTurn();
    await reviseAndCommit(fix, agreementId, { answersAsk: false });
    const mid = fix.ctx.store.table('jobs').get(job.id)!;
    expect(mid.openAsk).toMatchObject({ fromId: fix.engineer.id });
    expect(mid.openAsk!.agreementNo ?? null).toBeNull();
    expect(mid.pause).toMatchObject({ versionNo: 2 });
    expect(expectedActorOf(mid)).toBe(fix.chief.id);
    // 总管用 answer 回答它（约定第 1 版「这次做」第 1 条能推出答案时的写法）。
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
      mode: 'answer', jobId: job.id, to: '林舟', text: '先不做暗色模式。', basis: [{ section: 'scopeIn', no: 1 }] });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toBeNull();
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain('总管刚回答你');
    await engineerWaits(fix);
    // 主人确认新版本：提问已不在，收尾照常（没有重复的回答事件）。
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const now = fix.ctx.store.table('jobs').get(job.id)!;
    expect(now).toMatchObject({ openAsk: null, pause: null, state: 'doing', handledVersionNo: 2 });
    expect(fix.ctx.store.log('jobEvents').all().filter(row => row.jobId === job.id && row.kind === 'answered')).toHaveLength(1);
  });
});

describe('执行链回合与不相干情形', () => {
  it('执行链回合里写 answersAsk: false 被拒，文字如上，没有任何写入；不写照旧成功并关联', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    const before = { snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) };
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId, { answersAsk: false }));
    expect(refused).toEqual({ ok: false, error: CHAIN_ANSWERS_FALSE_TEXT });
    expect(CHAIN_ANSWERS_FALSE_TEXT).toBe('这一回合只有为了回答这个提问才能出新版本，answersAsk 不能写 false。');
    expect({ snapshot: writeSnapshot(fix, job.id), agreements: JSON.stringify(fix.ctx.store.table('agreements').list()) }).toEqual(before);
    // 不写：成功并关联（P74r2b 的做法）。
    const ok = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toMatchObject({ agreementNo: 2 });
  });

  it('执行链回合里写 answersAsk: true 也可以（与不写相同）', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    const ok = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId, { answersAsk: true }));
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toMatchObject({ agreementNo: 2 });
  });

  it('没有未回答的提问时传 answersAsk 被忽略：true、false 都成功，提问字段不变（本来就没有）', async () => {
    for (const value of [true, false]) {
      const { fix, job } = await pendingReopen({ answersAsk: value });
      expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toBeNull();
      expect(fix.ctx.store.table('jobs').get(job.id)!.pause).toMatchObject({ versionNo: 2 });
    }
  });

  it('只用唤醒包里的文字：主人发话后，总管这一回合的包里写明提问人和原文；照包里的编号和说明调用成功', async () => {
    const { fix, job, packet, agreementId } = await askedThenOwnerTurn();
    // 包里只靠正则取：约定编号、提问人、原文，以及 answersAsk 的用法说明。
    expect(agreementId).toMatch(/^agr_[0-9a-z]{10}$/);
    const line = /这件事有一个没回答的提问：(.+?)问「(.+?)」。(.+)/.exec(packet);
    expect(line, '唤醒包里应该有没回答的提问').not.toBeNull();
    expect(line![1]).toBe('林舟');
    expect(line![2]).toBe(ASK);
    expect(line![3]).toContain('answersAsk');
    expect(packet).toContain('answersAsk');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId, { answersAsk: true }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toMatchObject({ agreementNo: 2 });
  });
});
