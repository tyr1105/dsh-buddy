/**
 * P76f 小修：停在预算线上的事，一定有一条开着的条目、或一版等确认的约定、或你已选暂停。
 * 夹具说明见 p76f-fixtures.ts：额度灯为绿、预算线 8、时钟每次推进不超过 10 分钟；总管、执行者都是真实回合。
 */
import { describe, expect, it } from 'vitest';
import { repairCapStop } from '../src/job/budget-ask.js';
import { ownerSays } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, capItems, chiefSaid, commitAndEnd, nextPacket, openCap, reachedAfterAsked, theJob, tick, type JobFix,
} from './p76f-fixtures.js';
import { sectionOf } from './p74d-fixtures.js';

/** 选缩小范围，总管拿到回合；返回约定编号和总管唤醒包文字。 */
async function narrowChosen(fix: JobFix, jobId: string) {
  expect(await fix.hub.api.answerJobCap({ jobId, answer: '缩小范围' })).toMatchObject({ ok: true });
  const text = sectionOf(await nextPacket(fix, fix.chief.id));
  const agreementId = /agreementId 写 (agr_[0-9a-z]{10})/.exec(text)![1]!;
  const paragraph = text.slice(text.indexOf('主人选了缩小范围。约定里还没通过的条目：'));
  const listed = [...paragraph.matchAll(/^doneWhen (\d+)\. (.+)$/gm)].map(m => ({ no: Number(m[1]), text: m[2]! }));
  return { agreementId, listed };
}

/** 总管提交缩小范围的新版本（放宽第 3 条）并结束回合。 */
async function chiefSubmits(fix: JobFix, agreementId: string, listed: Array<{ no: number; text: string }>) {
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
    mode: 'revise', agreementId, changeNote: '放宽第 3 条的要求，先把能用的部分做完',
    doneWhen: listed.map(row => (row.no === 3 ? '价格页能正常打开，三档价格都显示' : row.text)),
    continuing: ['第 1、2 条对应的工作'], paused: ['第 3 条对应的工作'],
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已拟好新版本' });
}

// P76r3（R10 第 5 点）：缩小范围这条路径停下时没有告诉过主人「已停下」，重建条目时用到达预算线的那一句，不说「仍」。
// P76r3（R3）：缩小范围加的那 1 个回合同时追加进预计，预计总数从 9 变成 10。
const REISSUED = '会员定价页已用到预计的 10 回合，已停下，在等你决定。';

describe('小修：停在预算线上的事不会没有下文', () => {
  it('总管提交缩小范围的改动后又撤销这一版：下一次巡检重新出现条目，私聊逐字；主人选「追加」照常解除受阻', async () => {
    const { fix, job } = await reachedAfterAsked();
    const { agreementId, listed } = await narrowChosen(fix, job.id);
    await chiefSubmits(fix, agreementId, listed);
    // 新版本在等你确认：不重建。
    await tick(fix, MINUTE);
    expect(openCap(fix, job.id)).toBeUndefined();
    // 你说这版不要，总管撤销。
    await ownerSays(fix, fix.chief.id, '这一版不要了，还是按原来的');
    await nextPacket(fix, fix.chief.id);
    const withdrawn = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '你不采用这一版' });
    expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已撤销', reply: '好的，这一版不采用，仍按原来的约定。' });
    await tick(fix, MINUTE);
    const open = openCap(fix, job.id)!;
    expect(open).toBeDefined();
    expect(open.title).toBe('会员定价页：已用到预计消耗');
    expect(chiefSaid(fix).filter(text => text === REISSUED)).toHaveLength(1);
    expect(theJob(fix).inboxId).toBe(open.id);
    expect(fix.ctx.store.table('jobNotices').get(job.id)!.narrowRequestedAt).toBeNull();
    // 再巡检不重复。
    await tick(fix, MINUTE);
    expect(chiefSaid(fix).filter(text => text === REISSUED)).toHaveLength(1);
    // 选「追加」能照常解除受阻。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: open.options[0]! })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null });
  });

  it('总管拟改动的回合结束了却没有提交新版本：下一次巡检重新出现条目', async () => {
    const { fix, job } = await reachedAfterAsked();
    await narrowChosen(fix, job.id);
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '没有提交' });
    await tick(fix, MINUTE);
    expect(openCap(fix, job.id)).toBeDefined();
    expect(chiefSaid(fix)).toContain(REISSUED);
    expect(fix.ctx.store.table('jobNotices').get(job.id)!.narrowRequestedAt).toBeNull();
  });

  it('反例：总管的回合还在排队或在跑时不重建', async () => {
    const { fix, job } = await reachedAfterAsked();
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '缩小范围' })).toMatchObject({ ok: true });
    expect(repairCapStop(fix.ctx, job.id)).toBe(false);
    await nextPacket(fix, fix.chief.id);
    expect(repairCapStop(fix.ctx, job.id)).toBe(false);
    expect(capItems(fix, job.id).filter(row => row.status === 'open')).toHaveLength(0);
    expect(chiefSaid(fix)).not.toContain(REISSUED);
  });

  it('反例：主人选了暂停（不再是因预算线受阻）、还没到预算线，都不建', async () => {
    const held = await reachedAfterAsked();
    expect(await held.fix.hub.api.answerJobCap({ jobId: held.job.id, answer: '暂停' })).toMatchObject({ ok: true });
    expect(repairCapStop(held.fix.ctx, held.job.id)).toBe(false);
    expect(theJob(held.fix)).toMatchObject({ blocked: { kind: 'owner_hold' } });
    const early = await reachedAfterAsked();
    expect(openCap(early.fix, early.job.id)).toBeDefined();
    expect(repairCapStop(early.fix.ctx, early.job.id)).toBe(false);
  });
});
