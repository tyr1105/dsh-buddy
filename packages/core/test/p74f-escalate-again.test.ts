/**
 * P74f-2 补充（主会话裁定）：「只说明一次」的范围是「同一次受阻」，不是「同一阶段」。
 *
 * 执行者做不下去时阶段号不变。主人选了不带改动的办法、总管换人之后，新执行者又做不下去，总管可以再向主人说明一次：
 * 新的三轮不过卡、新的「待你处理」条目（事项键带修订号，不与第一次撞键），第一张卡仍显示主人上次选的办法；
 * 同一次受阻期间第二次说明被拒。怎样识别「同一次」：记录里存说明时的受阻开始时间，与现在的受阻开始时间相同就是同一次。
 */
import { describe, expect, it } from 'vitest';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { MINUTE, bot, callTool, escalateFromPacket, started, theJob, tick } from './p74f2-fixtures.js';

const KEEP = { title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚' };
const SWAP = { title: '换一位执行者再试', detail: '换人重做；代价是多花一轮时间' };

describe('同一次受阻只说明一次', () => {
  it('说明、主人选不带改动的办法、换人、新执行者又做不下去：第二次说明成功；两张卡、两条条目互不撞键，旧卡显示上次选的办法；同一次受阻内再说明被拒', async () => {
    const { fix, job } = await started(['小周']);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    const first = await escalateFromPacket(fix, [KEEP, SWAP]);
    expect(first.result).toMatchObject({ ok: true });
    // 同一次受阻期间第二次说明被拒。
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '再说一次', options: [KEEP, SWAP], suggested: 0, reason: '理由' }))
      .toEqual({ ok: false, error: '这一次受阻已经向主人说明过了，在等主人选办法，不能再说明' });
    // 主人选「换一位执行者再试」（不带改动），总管换人。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1, revision: 0 })).toMatchObject({ ok: true });
    await tick(fix, 5 * MINUTE);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已改派', reply: '已改派给小周。' }).catch(() => undefined);
    // 新执行者又做不下去：同一阶段、新的一次受阻。
    const newcomer = fix.extras[0]!.id;
    const { nextPacket } = await import('./p74f2-fixtures.js');
    await nextPacket(fix, newcomer);
    expect(await callTool(fix, bot(fix, newcomer), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '文档还是没有', tried: ['问了同事'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer, { outcome: 'blocked', blocker: '文档还是没有', summary: '做不下去' });
    expect(theJob(fix)).toMatchObject({ stage: 1, state: 'blocked', escalation: { rev: 0, chosen: 1 } });
    // 总管真跑回合：只用唤醒包里的文字（jobId）调用第二次说明，成功。
    const second = await escalateFromPacket(fix, [KEEP, SWAP]);
    expect(second.result, JSON.stringify(second.result)).toEqual({ ok: true, text: '已把卡在哪和办法交给主人。这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。' });
    expect(theJob(fix)).toMatchObject({ escalation: { stage: 1, rev: 1, chosen: null }, escalationHistory: [{ rev: 0, chosen: 1 }] });
    // 两张卡、一条开着的条目（第二次的，键带修订号）；第一张卡仍显示主人上次选的办法。
    const cards = threadOf(fix.ctx, fix.chief.id).filter(row => row.kind === 'job_card' && row.refId?.startsWith('escalation:')).map(row => row.refId);
    expect(cards).toEqual([`escalation:${job.id}#1`, `escalation:${job.id}#1~1`]);
    expect(escalationCardView(fix.ctx, cards[0]!)).toMatchObject({ stateText: '你选了 B', chosen: 'B', revision: 0 });
    expect(escalationCardView(fix.ctx, cards[1]!)).toMatchObject({ stateText: '等你决定', chosen: null, revision: 1 });
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:escalate:`));
    expect(open.map(row => row.subjectKey)).toEqual([`job:${job.id}:escalate:1~1`]);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:escalate:1`)[0]).toMatchObject({ status: 'answered' });
    // 对着旧卡选办法被拒；对着新卡（或「待你处理」里的按钮）选成功。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 0 })).toMatchObject({ ok: false, error: '这张卡已不是最新的，请在最新的一张上选办法' });
    expect(await fix.hub.api.answerInbox(open[0]!.id, 'A　先放一放')).toMatchObject({ ok: true });
    expect(theJob(fix).escalation).toMatchObject({ rev: 1, chosen: 0 });
  });
});
