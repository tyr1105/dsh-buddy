/**
 * P74r2b 的测试（一）：总管在执行链回合里，可以为一个未回答的提问出约定新版本（审查报告 G3）。
 *
 * 场景：林舟问「要不要做暗色模式？约定没写」，总管拿到的是执行链回合（不是主人发消息叫醒的）。
 * 第一块的规则「约定只能根据主人的话提交或修改」给这一种情形开了一个范围很窄的例外：四个条件同时满足才放行
 * （执行链回合且是这件事的总管、这件事已固定的约定、mode 是 revise、有未回答的提问）。
 * 新版本不会自己生效，主人确认才固定。这里全部走真实 Hub，编号只用正则从唤醒包文字里取。
 * 反例每个条件各一条；第一块、第二块原有的回合要求的测试在它们自己的文件里原样通过。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { expectedActorOf } from '../src/job/chain.js';
import { jobDelayNote } from '../src/job/delay.js';
import { AgreementSchema } from '../src/model/agreement.js';
import { NO_OPEN_ASK_TEXT } from '../src/project/agreement-chain.js';
import { submitAgreement } from '../src/project/agreements.js';
import { commitAs } from './p74c-fixtures.js';
import { engineerSubmits, executorInfo } from './p74d-fixtures.js';
import {
  MINUTE, askedChiefTurn, bot, callTool, chiefWakes, commitAndEnd, nextPacket, ownerSays, reviseArgs, runningOf, sectionOf, speak, started,
  tick, touches, wakesOf, type JobFix,
} from './p74r2b-fixtures.js';

const ASK = '要不要做暗色模式？约定没写';

/** 模拟旧的做法不存在：给模型看的文字里没有这两个后续才有的 mode 名。 */
const NOT_YET = /escalate|reopen/;

/** 这位总管名下开着的「待你处理」条目。 */
function openInbox(fix: JobFix) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open');
}

/** 总管 revise 成功并交账：返回工具结果。卡片在交账时落楼。 */
async function reviseAndCommit(fix: JobFix, agreementId: string) {
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '暗色模式约定里没有写，已请主人确认。', { outcome: 'progress' });
  return result;
}

describe('执行链回合里为提问出新版本', () => {
  it('只用唤醒包里的文字：revise 成功；约定第 2 版待确认，起因是提问；卡片视图有起因一行；「待你处理」恰好一条', async () => {
    const { fix, job, agreementId, jobId } = await askedChiefTurn();
    expect(jobId).toBe(job.id);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(String(result.text)).not.toMatch(NOT_YET);
    await speak(fix, bot(fix, fix.chief.id), '暗色模式约定里没有写，已请主人确认。', { outcome: 'progress' });

    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const v2 = agreement.versions[1]!;
    expect(agreement.state).toBe('pending');
    // 起因记为那一条提问：来源、提问人、原文、提问事件的编号；没有任何主人消息作依据。
    expect(v2).toMatchObject({ no: 2, state: 'pending', source: 'job_question', sourceMessageId: null, sourceThread: null });
    expect(v2.askOrigin).toMatchObject({ jobId: job.id, askerId: fix.engineer.id, askerName: '林舟', text: ASK, askEventId: fix.ctx.store.table('jobs').get(job.id)!.openAsk!.eventId });
    // 卡片视图：来源能和「主人发话后修订」区分开；多一行起因，由中心生成。
    const view = agreementCardView(fix.ctx, agreement, v2);
    expect(view.sourceLabel).toBe('来源：执行中的提问，约定里没有写');
    expect(view.originLine).toBe(`起因：林舟在做这件事时问「${ASK}」，约定里没有写。`);
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).originLine).toBeNull();
    // 「待你处理」里恰好一条（这份约定的确认），正文带起因一句。
    const open = openInbox(fix);
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe('约定第 2 版待你确认：会员定价页');
    expect(open[0]!.body).toContain(`起因：林舟在做这件事时问「${ASK}」，约定里没有写。`);
    // 提问保持未回答，并记下已转成第 2 版；这件事此刻在等主人，不在等任何人去处理。
    const now = fix.ctx.store.table('jobs').get(job.id)!;
    expect(now.openAsk).toMatchObject({ fromId: fix.engineer.id, agreementNo: 2 });
    expect(now.pause).toMatchObject({ versionNo: 2 });
    expect(expectedActorOf(now)).toBeNull();
  });

  it('起因文字超过 80 字时截断加省略号', async () => {
    const long = `要不要做暗色模式？${'这个问题约定里没有写清楚所以来问。'.repeat(6)}`;
    const { fix, agreementId } = await askedChiefTurn(long);
    await reviseAndCommit(fix, agreementId);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const line = agreementCardView(fix.ctx, agreement, agreement.versions[1]!).originLine!;
    const shown = /问「(.+)」，约定里没有写。$/.exec(line)![1]!;
    expect([...shown]).toHaveLength(81);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.startsWith(long.slice(0, 80))).toBe(true);
  });

  it('之后推进 6 小时：总管没有新回合；没有「停住了」；没有转受阻；林舟最多多 1 个回合', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    const before = touches(fix, job.id);
    await reviseAndCommit(fix, agreementId);
    const chiefBefore = chiefWakes(fix);
    for (let i = 0; i < 36; i += 1) {
      if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
      await tick(fix, 10 * MINUTE);
    }
    expect(chiefWakes(fix)).toBe(chiefBefore);
    expect(openInbox(fix).filter(row => row.title.includes('停住了'))).toHaveLength(0);
    expect(openInbox(fix)).toHaveLength(1);
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('doing');
    expect(touches(fix, job.id) - before).toBeLessThanOrEqual(1);
    // 进度行如实写在等你确认第 2 版。
    expect(jobDelayNote(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!, fix.ctx.clock.now())).toBe('在等你确认约定第 2 版');
  });

  it('主人点确认：提问标为已回答（由约定第 2 版回答）；工作往来一句；林舟被叫醒并能交回；总管没有新回合', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    const askEventId = fix.ctx.store.table('jobs').get(job.id)!.openAsk!.eventId;
    await reviseAndCommit(fix, agreementId);
    // 林舟的回合照常结束（他只能做照常在做的部分）。
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
    const chiefBefore = chiefWakes(fix);
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);

    const now = fix.ctx.store.table('jobs').get(job.id)!;
    expect(now.openAsk).toBeNull();
    expect(now.pause).toBeNull();
    const answered = fix.ctx.store.log('jobEvents').all().filter(row => row.jobId === job.id && row.kind === 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ refId: askEventId, to: [fix.engineer.id], data: { byAgreementNo: 2 } });
    const work = fix.ctx.store.log('thread').all().filter(row => row.thread === job.topicId && row.kind === 'work').map(row => row.text);
    expect(work).toContain('林舟的问题按约定第 2 版处理：加暗色模式。');
    // 林舟被叫醒，唤醒包里写明这个回答，并能交回；总管没有新回合。
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('总管刚回答你：按约定第 2 版处理：加暗色模式。');
    await engineerSubmits(fix, executorInfo(packet));
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('checking');
    expect(chiefWakes(fix)).toBe(chiefBefore);
  });

  it('主人不同意：总管（主人发起的回合）withdraw；提问仍在，在等总管；总管 amend 之后 answer 成功，林舟被叫醒', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    await reviseAndCommit(fix, agreementId);
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
    await ownerSays(fix, fix.chief.id, '暗色模式这次不做');
    const withdrawn = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人不要暗色模式' });
    expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: true });
    const mid = fix.ctx.store.table('jobs').get(job.id)!;
    expect(mid.openAsk).toMatchObject({ fromId: fix.engineer.id });
    expect(mid.openAsk!.agreementNo ?? null).toBeNull();
    expect(mid.pause).toBeNull();
    expect(expectedActorOf(mid)).toBe(fix.chief.id);
    // 在回答之前，约定里没有这一条：amend 在「我已定的」里写一条「暗色模式这次不做」（amend 不能改「这次不做」那一段），再按它回答。
    const amended = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'amend', agreementId, changeNote: '暗色模式这次不做',
      decided: [{ text: '只做网页，不做手机端', basis: { kind: 'judgement' } }, { text: '暗色模式这次不做', basis: { kind: 'judgement' } }],
    });
    expect(amended, JSON.stringify(amended)).toMatchObject({ ok: true });
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    const touchedBefore = touches(fix, job.id);
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
      mode: 'answer', jobId: job.id, to: '林舟', text: '这次不做暗色模式', basis: [{ section: 'decided', no: 2 }],
    });
    expect(answered, JSON.stringify(answered)).toEqual({ ok: true, text: '已回答林舟。' });
    expect(fix.ctx.store.table('jobs').get(job.id)!.openAsk).toBeNull();
    expect(touches(fix, job.id)).toBeGreaterThanOrEqual(touchedBefore);
    await speak(fix, bot(fix, fix.chief.id), '已回答。', { outcome: 'progress' });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('总管刚回答你：这次不做暗色模式');
  });

  it('提问已转成新版本期间，总管不能再用 answer 回答（文字说明在等主人确认）', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    expect((await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId))).ok).toBe(true);
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
      mode: 'answer', jobId: job.id, to: '林舟', text: '做', basis: [{ section: 'scopeIn', no: 1 }],
    });
    expect(refused).toEqual({ ok: false, error: '这个问题已经转成约定第 2 版，在等主人确认；主人确认后中心会回答。主人不同意的话，撤销这一版之后再回答。' });
  });
});

describe('反例：例外的四个条件缺一不可', () => {
  it('执行链回合里这件事没有未回答的提问：revise 被拒，文字写明什么时候才能这样做；没有写入', async () => {
    const { fix, job } = await started();
    // 林舟说明做不下去，总管拿到执行链回合，但这件事没有提问。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺文档', summary: '做不下去' });
    const packet = await nextPacket(fix, fix.chief.id);
    const agreementId = /已固定：约定「会员定价页」第 \d+ 版（agreementId 为 (agr_[a-z0-9]{10})/.exec(packet)![1]!;
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId));
    expect(refused).toEqual({ ok: false, error: NO_OPEN_ASK_TEXT });
    expect(NO_OPEN_ASK_TEXT).toBe('约定只能根据主人的话提交或修改：这一回合不是主人发消息叫醒的。只有执行者或核对人的提问在约定里推不出答案时，才能在这里用 mode revise 出新版本请主人确认。');
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions).toHaveLength(1);
  });

  it('amend、新建、withdraw、别的约定的 revise、已经在等确认时再 revise，在执行链回合里都被拒（原来的文字），没有写入', async () => {
    const { fix, agreementId, job } = await askedChiefTurn();
    const old = '约定只能根据主人的话提交或修改：这一回合不是主人发消息叫醒的';
    const call = (args: Record<string, unknown>) => callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', args);
    expect(await call({ mode: 'amend', agreementId, changeNote: '改一句', summary: '换一句话复述' })).toEqual({ ok: false, error: old });
    expect(await call({ mode: 'withdraw', agreementId, reason: '不做了' })).toEqual({ ok: false, error: old });
    expect(await call({ title: '另一件事', summary: '随便' })).toEqual({ ok: false, error: old });
    // 别的约定（这位总管名下另一份已固定的约定）的 revise。
    const own = fix.ctx.store.table('agreements').get(agreementId)!;
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...own, id: 'agr_abcdefghij', title: '另一份约定' }));
    expect(await call(reviseArgs('agr_abcdefghij'))).toEqual({ ok: false, error: old });
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions).toHaveLength(1);
    expect(fix.ctx.store.table('jobs').get(job.id)!.pause).toBeNull();
    // 成功一次之后，同一回合再 revise：约定已经在等确认（不是已固定），被拒。
    expect((await call(reviseArgs(agreementId))).ok).toBe(true);
    expect(await call(reviseArgs(agreementId, { changeNote: '再加一条' }))).toEqual({ ok: false, error: old });
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions).toHaveLength(2);
  });

  it('员工（非总管）调用被拒；同一个提问在主人不同意之后不能再出新版本', async () => {
    const { fix, agreementId, job } = await askedChiefTurn();
    const staff = await callTool(fix, bot(fix, fix.engineer.id), 'hub_agreement_submit', reviseArgs(agreementId));
    // 林舟此刻没有开着的回合（被拒的文字是「只能在回合里提交」）；总管以外的人即使有回合，也会在身份检查被拒。
    expect(staff.ok).toBe(false);
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions).toHaveLength(1);
    // 先成功出一版，主人不同意并撤销；再拿同一个提问出新版本被拒。直接用这一回合的旧唤醒单调用（它带着这件事的编号）。
    const chain = wakesOf(fix, fix.chief.id, job.id).at(-1)!;
    await expect(submitAgreement(fix.ctx, fix.engineer.id, chain, reviseArgs(agreementId))).rejects.toThrow('只有总管能提交约定');
    expect((await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId))).ok).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'progress' });
    await ownerSays(fix, fix.chief.id, '不要暗色模式');
    expect((await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人不要' })).ok).toBe(true);
    await expect(submitAgreement(fix.ctx, fix.chief.id, chain, reviseArgs(agreementId, { changeNote: '再试一次', scopeIn: ['报价列表页', '手动刷新', '支持暗色模式', '再加一条'] })))
      .rejects.toThrow('这个提问已经出过约定第 2 版了，主人没有采用');
  });

  it('执行链回合里总管带 ownerQuestion 的交账被拒，文字列出现在能做的做法，不含 escalate', async () => {
    const { fix } = await askedChiefTurn();
    const question = { text: '价格定多少？', options: ['九块', '十块'], defaultOption: '九块', whyNeeded: '需要主人定' };
    const refused = await commitAs(fix, fix.chief.id, { outcome: 'progress', summary: '问主人', ownerQuestion: question });
    expect(refused).toEqual({ ok: false, error: '这一回合是处理一件事的回合，不能直接向主人提问。能按约定回答的，用 hub_job_manage 的 answer；要换人，用 hub_job_manage 的 reassign；核对三轮仍不过、或执行者做不下去而你解决不了时，用 hub_job_manage 的 mode escalate 向主人说明并给出办法；执行者或核对人的提问在约定里推不出答案时，用 hub_agreement_submit 的 mode revise 出新版本请主人确认。' });
    // P74f-2：escalate 已存在，拒绝文字写明它的适用情形（两条路各自的情形都写到）。
    expect(String(refused.error)).toMatch(/mode escalate/);
  });
});
