/**
 * P76f：答复预计消耗条目（追加 n 个回合、缩小范围、暂停）、暂停之后到预算线、缩小范围的总管真跑一个回合、旧条目。
 *
 * 全部走真实 Hub（夹具说明见 p76f-fixtures.ts）：额度灯为绿、预算线 8（预计 9 减对齐 1）；
 * 「未到预算线」指问过一次、这件事仍在做；「已到预算线」指用到预算线、这件事受阻（用到上限）。
 * 每条用例断言：预算线、预计记录、受阻与否、被叫醒的人、条目状态、总管私聊逐字。时钟每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { latestEstimate } from '../src/job/estimate.js';
import { isSelfWork } from '../src/quota/usage.js';
import { chainReviseAsk, NO_OPEN_ASK_TEXT } from '../src/project/agreement-chain.js';
import type { AgreementSubmitInput } from '../src/project/agreement-content.js';
import type { WakeTicket } from '../src/model/index.js';
import {
  MINUTE, askedNotReached, bot, callTool, capItems, chiefSaid, commitAndEnd, engineerTurns, entriesOf, noticeRow, nextPacket, openCap,
  reachedAfterAsked, started, engineerProgress, theJob, tick, type JobFix,
} from './p76f-fixtures.js';
import { INTERNAL, sectionOf } from './p74d-fixtures.js';
import { wakesOf } from './p74c-fixtures.js';

/** 答复这件事现在开着的预算线条目。 */
async function answerCap(fix: JobFix, jobId: string, answer: string) {
  return fix.hub.api.answerJobCap({ jobId, answer });
}

describe('7 追加 n 个回合', () => {
  it('未到预算线：预算线加 2、预计追加一项（总数加 2、返工预留加 2）、不叫人、这件事继续做、私聊逐字', async () => {
    // 额度灯绿；预算线 8；各步已用：对齐 1、执行 3；问过一次。
    const { fix, job } = await askedNotReached();
    const item = openCap(fix, job.id)!;
    const before = latestEstimate(fix.ctx, job.agreementId)!;
    const engineerQueue = entriesOf(fix, fix.engineer.id, job.id).length;
    expect(await answerCap(fix, job.id, '追加 2 个回合')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 10, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '追加 2 个回合' });
    const after = latestEstimate(fix.ctx, job.agreementId)!;
    expect(after).toMatchObject({ reason: 'top_up', versionNo: before.versionNo, total: before.total + 2 });
    expect(after.steps.rework).toBe(before.steps.rework + 2);
    expect(after.tokenLow).toBeGreaterThan(before.tokenLow);
    expect(fix.ctx.store.table('jobEstimates').get(job.agreementId)!.versions).toHaveLength(2);
    // 没受阻的不叫人：队列与原来一样，总管没有被叫醒。
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(engineerQueue);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(chiefSaid(fix).at(-1)).toBe('已追加 2 个回合，预计改为 11 回合，接着做。');
    expect(chiefSaid(fix).at(-1)).not.toMatch(INTERNAL);
  });

  it('已到预算线：预算线加 2、解除受阻回到执行中、叫执行者、预计追加一项、私聊逐字', async () => {
    // 预算线 8；各步已用：对齐 1、执行 8；受阻（用到上限）。
    const { fix, job } = await reachedAfterAsked();
    const item = openCap(fix, job.id)!;
    expect(await answerCap(fix, job.id, '追加 2 个回合')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 10, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered' });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(latestEstimate(fix.ctx, job.agreementId)).toMatchObject({ reason: 'top_up', total: 11 });
    expect(chiefSaid(fix).at(-1)).toBe('已追加 2 个回合，预计改为 11 回合，接着做。');
    // 叫醒的执行者真的拿到回合，不会因预算线被丢弃。
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(`jobId 为 ${job.id}`);
  });

  it('反例：答案不是这一条自己的选项（追加的数不对、先停下、空话）被拒，什么都不改', async () => {
    const { fix, job } = await askedNotReached();
    const before = JSON.stringify(theJob(fix));
    for (const bad of ['追加 5 个回合', '再给 8 个回合', '先停下', '随便']) {
      expect(await answerCap(fix, job.id, bad), bad).toMatchObject({ ok: false });
    }
    expect(JSON.stringify(theJob(fix))).toBe(before);
    expect(openCap(fix, job.id)).toBeDefined();
    expect(fix.ctx.store.table('jobEstimates').get(job.agreementId)!.versions).toHaveLength(1);
  });

  it('追加之后预算线变了，再超出才会再问：新预算线上再问一次，事项键带新的预算线', async () => {
    const { fix, job } = await askedNotReached();
    expect(await answerCap(fix, job.id, '追加 2 个回合')).toMatchObject({ ok: true });
    // 预算线 10、预计 11；再做满：执行第 9 个回合结束时已用加余下超出 10。
    await engineerTurns(fix, 6);
    const items = capItems(fix, job.id);
    expect(items.map(row => row.subjectKey)).toEqual([`job:${job.id}:cap:8`, `job:${job.id}:cap:10`]);
    expect(items.map(row => row.status)).toEqual(['answered', 'open']);
    expect(noticeRow(fix, job.id)!.budgetAskedCaps).toEqual([8, 10]);
  });
});

describe('7 缩小范围', () => {
  it('未到预算线：预算线加 1、总管被叫醒、这件事继续做、记号写下、总管唤醒包里有缩小范围那一段（逐字）', async () => {
    const { fix, job } = await askedNotReached();
    const item = openCap(fix, job.id)!;
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 9, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '缩小范围' });
    expect(noticeRow(fix, job.id)!.narrowRequestedAt).toBe(fix.ctx.clock.now());
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    expect(chiefSaid(fix).at(-1)).toBe('好的，我拟一版缩小范围的改动给你确认。');
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(text).toContain('主人选了缩小范围。约定里还没通过的条目：');
    expect(text).toMatch(/\ndoneWhen 1\. .+\ndoneWhen 2\. .+\ndoneWhen 3\. .+/);
    expect(text).toContain('请用 hub_agreement_submit 提交一版改动：mode 写 revise，agreementId 写 agr_');
    expect(text).toContain('只删去或放宽这些条目，不新增；在本次改动说明里写一句为什么这样缩小。');
  });

  it('已到预算线：预算线加 1、受阻的事不解除受阻、叫醒总管（不是执行者）、总管私聊逐字', async () => {
    const { fix, job } = await reachedAfterAsked();
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, turnCap: 9, inboxId: null });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(chiefSaid(fix).at(-1)).toBe('好的，我拟一版缩小范围的改动给你确认。');
    expect(noticeRow(fix, job.id)!.narrowRequestedAt).not.toBeNull();
  });

  it('叫醒总管的那一次是执行链上的唤醒（带事情编号），不算总管自己发起的回合；预算线用完时不再问（缩小范围进行中）', async () => {
    const { fix, job } = await askedNotReached();
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    await nextPacket(fix, fix.chief.id);
    const wake = wakesOf(fix, fix.chief.id, job.id).at(-1)!;
    expect(wake.jobId).toBe(job.id);
    expect(isSelfWork(wake, 'chief')).toBe(false);
    // 在等新版本期间，已用加余下即使超出新的预算线，也不再另问（主人面前已有缩小范围这件事）。
    expect(capItems(fix, job.id)).toHaveLength(1);
  });
});

describe('7 暂停与 8 暂停之后到预算线', () => {
  it('未到预算线：只记「用到预算线时暂停」，这件事继续做，私聊逐字；用到预算线时转「你已暂停」、不建条目、私聊逐字', async () => {
    const { fix, job } = await askedNotReached();
    const item = openCap(fix, job.id)!;
    expect(await answerCap(fix, job.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 8, inboxId: null });
    expect(noticeRow(fix, job.id)!.holdAtCap).toBe(true);
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '暂停' });
    expect(chiefSaid(fix).at(-1)).toBe('好的，用到 9 回合时暂停，在这之前预计之内的部分照常在做。');
    // 接着做到预算线：转「你已暂停」，没有新条目。
    await engineerTurns(fix, 5);
    await tick(fix, MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, inboxId: null });
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    expect(chiefSaid(fix).at(-1)).toBe('会员定价页已用到预计的 9 回合，按你的选择已暂停。要接着做时告诉我。');
    expect(noticeRow(fix, job.id)!.holdAtCap).toBe(false);
    // 再巡检不重复：没有新条目、没有第二句。
    await tick(fix, MINUTE);
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(chiefSaid(fix).filter(text => text.includes('按你的选择已暂停'))).toHaveLength(1);
  });

  it('已到预算线：转「你已暂停」，私聊逐字，条目已回答、编号清空', async () => {
    const { fix, job } = await reachedAfterAsked();
    const item = openCap(fix, job.id)!;
    expect(await answerCap(fix, job.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' }, inboxId: null });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '暂停' });
    expect(chiefSaid(fix).at(-1)).toBe('已暂停「会员定价页」。要接着做时告诉我。');
    expect(noticeRow(fix, job.id)?.holdAtCap ?? false).toBe(false);
  });

  it('追加会清掉之前选的「暂停」记号（预算线变了，到时候要不要停由新的问答决定）', async () => {
    const { fix, job } = await askedNotReached();
    expect(await answerCap(fix, job.id, '暂停')).toMatchObject({ ok: true });
    expect(noticeRow(fix, job.id)!.holdAtCap).toBe(true);
    // 另开一条条目再追加：直接构造新的预算线条目答复。
    const reopened = fix.ctx.store.table('inbox').get(capItems(fix, job.id)[0]!.id)!;
    fix.ctx.store.table('inbox').put({ ...reopened, status: 'open', answer: null, answeredAt: null });
    expect(await answerCap(fix, job.id, '追加 2 个回合')).toMatchObject({ ok: true });
    expect(noticeRow(fix, job.id)!.holdAtCap).toBe(false);
  });
});

describe('9 缩小范围：总管真跑一个回合', () => {
  /** 只用总管唤醒包里的文字改约定：照包里列的条目，放宽第 3 条（只放宽、不新增、不删去），说明为什么这样缩小。 */
  async function chiefNarrows(fix: JobFix) {
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const agreementId = /agreementId 写 (agr_[0-9a-z]{10})/.exec(text)?.[1];
    expect(agreementId, '包里应该写了约定编号').toBeDefined();
    // 只读「缩小范围」那一段里列的条目（包里另有一份约定各部分的总序号，不能重复读）。
    const paragraph = text.slice(text.indexOf('主人选了缩小范围。约定里还没通过的条目：'));
    const listed = [...paragraph.matchAll(/^doneWhen (\d+)\. (.+)$/gm)].map(match => ({ no: Number(match[1]), text: match[2]! }));
    expect(listed.length, '包里应该列出还没通过的条目').toBeGreaterThanOrEqual(3);
    const doneWhen = listed.map(row => (row.no === 3 ? '价格页能正常打开，三档价格都显示' : row.text));
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'revise', agreementId, changeNote: '放宽第 3 条的要求，先把能用的部分做完',
      doneWhen, continuing: ['第 1、2 条对应的工作'], paused: ['第 3 条对应的工作'],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已拟好新版本' });
    return agreementId!;
  }

  it('已到预算线：总管按包里的文字提交新版本成功；你确认后预计多一项「缩小范围」（总数不变）、解除受阻叫执行者、剩余回合为 0 时追加 2 个回合并落那一句', async () => {
    const { fix, job } = await reachedAfterAsked();
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    const agreementId = await chiefNarrows(fix);
    // 总管的这一回合用掉预算线加的那 1 个：已用 9 = 预算线 9，剩余 0；这件事仍是受阻，新版本在等你确认。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, turnsUsed: 9, turnCap: 9 });
    expect(noticeRow(fix, job.id)!.narrowRequestedAt).not.toBeNull();
    const total = latestEstimate(fix.ctx, job.agreementId)!.total;
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(noticeRow(fix, job.id)!.narrowRequestedAt).toBeNull();
    const versions = fix.ctx.store.table('jobEstimates').get(job.agreementId)!.versions;
    // P76r3（R3）：剩余回合为 0 时追加的 2 个回合也追加进预计，保持「预计总数 − 对齐 == 预算线」。
    expect(versions.at(-1)).toMatchObject({ reason: 'narrow', versionNo: 2, total: total + 2 });
    expect(latestEstimate(fix.ctx, job.agreementId)!.total).toBe(total + 2);
    // 剩余回合为 0：再追加 2 个回合，解除受阻，叫醒执行者照新版本做。
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 11 });
    expect(chiefSaid(fix)).toContain('新版本已确认，追加 2 个回合照新版本做完。');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(`jobId 为 ${job.id}`);
  });

  it('未到预算线：总管提交的新版本你确认后，预计多一项「缩小范围」，不追加回合、不另落那一句；这件事照常在做', async () => {
    const { fix, job } = await askedNotReached();
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    const agreementId = await chiefNarrows(fix);
    const capBefore = theJob(fix).turnCap;
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(noticeRow(fix, job.id)!.narrowRequestedAt).toBeNull();
    expect(fix.ctx.store.table('jobEstimates').get(job.agreementId)!.versions.at(-1)).toMatchObject({ reason: 'narrow', versionNo: 2 });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: capBefore });
    expect(chiefSaid(fix)).not.toContain('新版本已确认，追加 2 个回合照新版本做完。');
  });

  it('反例：没有选缩小范围、也没有未回答的提问时，执行链回合里提交约定仍被拒；选了缩小范围（新版本还没出）才放行，放行后新版本出了又不放行', async () => {
    const { fix, job } = await askedNotReached();
    const wake = { jobId: job.id } as WakeTicket;
    const input = { mode: 'revise', agreementId: job.agreementId } as AgreementSubmitInput;
    expect(() => chainReviseAsk(fix.ctx, fix.chief.id, wake, input)).toThrow(NO_OPEN_ASK_TEXT);
    expect(await answerCap(fix, job.id, '缩小范围')).toMatchObject({ ok: true });
    expect(chainReviseAsk(fix.ctx, fix.chief.id, wake, input)).toMatchObject({ ask: null });
    // 别人（不是这件事的总管）不放行。
    expect(chainReviseAsk(fix.ctx, fix.engineer.id, wake, input)).toBeNull();
    // 记号清掉（例如你不采用新版本）之后恢复为被拒。
    fix.ctx.store.table('jobNotices').patch(job.id, { narrowRequestedAt: null });
    expect(() => chainReviseAsk(fix.ctx, fix.chief.id, wake, input)).toThrow(NO_OPEN_ASK_TEXT);
  });
});

describe('10 旧条目与没有预计的旧事', () => {
  it('旧条目（选项「再给 8 个回合」「暂停」，P76 之前开的）：答「再给 8 个回合」按追加 8 个处理：预算线加 8、解除受阻、预计追加一项', async () => {
    const { fix, job } = await reachedAfterAsked();
    const item = openCap(fix, job.id)!;
    fix.ctx.store.table('inbox').put({ ...item, title: '会员定价页：回合用到上限', options: ['再给 8 个回合', '暂停'] });
    expect(await answerCap(fix, job.id, '再给 8 个回合')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 16, inboxId: null });
    expect(latestEstimate(fix.ctx, job.agreementId)).toMatchObject({ reason: 'top_up', total: 17 });
    expect(chiefSaid(fix).at(-1)).toBe('已追加 8 个回合，预计改为 17 回合，接着做。');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('旧条目答「暂停」：转「你已暂停」', async () => {
    const { fix, job } = await reachedAfterAsked();
    const item = openCap(fix, job.id)!;
    fix.ctx.store.table('inbox').put({ ...item, options: ['再给 8 个回合', '暂停'] });
    expect(await answerCap(fix, job.id, '暂停')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'owner_hold' } });
  });

  it('没有预计的旧事到上限：沿用原来的标题、正文、选项和私聊；答「再给 8 个回合」预算线加 8、解除受阻、私聊「已追加 8 个回合，继续做。」', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    fix.ctx.store.table('jobEstimates').remove(job.agreementId);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, MINUTE);
    const items = capItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '会员定价页：回合用到上限', options: ['再给 8 个回合', '暂停'], status: 'open', defaultOption: null, expiresAt: null });
    expect(items[0]!.body).toBe('已用 8 个回合。继续做最多再用 8 个回合。');
    expect(chiefSaid(fix).at(-1)).toBe('会员定价页已用到本件事的回合上限（8 个），在等你决定是否继续。');
    expect(noticeRow(fix, job.id)?.budgetAskedCaps ?? []).toEqual([]);
    expect(await answerCap(fix, job.id, '再给 8 个回合')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 16 });
    expect(chiefSaid(fix).at(-1)).toBe('已追加 8 个回合，继续做。');
    // 新写法的答案在旧事的旧条目上被拒（选项不是这一条自己的）。
    expect(fix.ctx.store.table('jobEstimates').get(job.agreementId)).toBeNull();
  });
});
