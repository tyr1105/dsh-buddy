/**
 * 三轮不过卡上每个办法的 changeLine（「选了实际会改什么」一行）的测试。
 *
 * 为什么要这一行：主人在卡上选办法，中心就按办法里记下的改动（change 字段）直接生成约定新版本，不再另请主人确认；
 * 卡上原来只有总管写的标题和做法，两者可能对不上。所以由中心按 change 生成一行，不由模型写。
 * 覆盖：改写、删去、不带改动三种文字；选了之后新版本里的原文与选之前卡上写的逐字相同；
 * 选过之后旧卡仍显示当时的文字（约定后来已经变了）；删去的原文超过 60 字截断；文字里没有内部名称。
 */
import { describe, expect, it } from 'vitest';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { INTERNAL } from './p74d-fixtures.js';
import { escalateFromPacket, limitFix } from './p74f2-fixtures.js';

const REWRITE = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const DELETE = { title: '删去这一条', detail: '这次不做失败提示，之后单独做；代价是失败时用户看不到原因', change: { no: 3, text: null } };
const PLAIN = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
const DONES = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '能导出表格'];

/** 取这件事第 1 阶段那张三轮不过卡的各办法 changeLine。 */
function lines(fix: Awaited<ReturnType<typeof limitFix>>['fix'], jobId: string): Array<string | null> {
  return escalationCardView(fix.ctx, `escalation:${jobId}#1`)!.options.map(row => row.changeLine);
}

describe('三轮不过卡的 changeLine', () => {
  it('三个办法：改写、删去、不带改动，分别是固定格式的文字、文字、null；没有内部名称', async () => {
    const { fix, job } = await limitFix(DONES);
    const { result } = await escalateFromPacket(fix, [REWRITE, DELETE, PLAIN]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(lines(fix, job.id)).toEqual([
      '选了会把「怎样算做完」第 3 条改为：接口失败时页面有提示或有备用文案',
      '选了会删去「怎样算做完」第 3 条：接口失败时有提示',
      null,
    ]);
    expect(lines(fix, job.id).filter(row => row !== null).join('')).not.toMatch(INTERNAL);
    // 文字里没有工具名、mode 名之类的内部名称。
    expect(lines(fix, job.id).filter(row => row !== null).join('')).not.toMatch(/hub_|mode|escalate/);
  });

  it('选带改写的办法：生成的新版本里那一条与选之前卡上写的改后原文逐字相同；选过之后旧卡的文字不变', async () => {
    const { fix, job } = await limitFix(DONES);
    await escalateFromPacket(fix, [REWRITE, PLAIN]);
    const before = lines(fix, job.id)[0]!;
    const promised = before.replace('选了会把「怎样算做完」第 3 条改为：', '');
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    expect(agreement.versions[1]!.content.doneWhen[2]).toBe(promised);
    // 选过之后再看这张旧卡：约定已变成第 2 版，卡上仍是当时的文字。
    expect(lines(fix, job.id)).toEqual([before, null]);
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ chosen: 'A' });
  });

  it('选带删去的办法：选过之后约定第 3 条已换成别的内容，旧卡仍显示当时被删去的那一条原文', async () => {
    const { fix, job } = await limitFix(DONES);
    await escalateFromPacket(fix, [DELETE, PLAIN]);
    const before = lines(fix, job.id);
    expect(before[0]).toBe('选了会删去「怎样算做完」第 3 条：接口失败时有提示');
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    // 现在固定的版本里，第 3 条已经是原来的第 4 条；若按当前版本取，旧卡会对不上。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    expect(agreement.versions[1]!.content.doneWhen[2]).toBe('能导出表格');
    expect(lines(fix, job.id)).toEqual(before);
  });

  it('删去的这一条原文超过 60 字时截断并加省略号；刚好 60 字不截断', async () => {
    const long = `${'报价页在网络很慢的时候也要能给出清楚的提示'.repeat(3)}`; // 66 字
    const exact = long.slice(0, 60);
    expect([...long].length).toBeGreaterThan(60);
    const dones = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', long];
    const { fix, job } = await limitFix(dones);
    await escalateFromPacket(fix, [{ ...DELETE, change: { no: 4, text: null } }, PLAIN]);
    expect(lines(fix, job.id)[0]).toBe(`选了会删去「怎样算做完」第 4 条：${exact}…`);
    const second = await limitFix([dones[0]!, dones[1]!, dones[2]!, exact]);
    await escalateFromPacket(second.fix, [{ ...DELETE, change: { no: 4, text: null } }, PLAIN]);
    expect(lines(second.fix, second.job.id)[0]).toBe(`选了会删去「怎样算做完」第 4 条：${exact}`);
  });
});
