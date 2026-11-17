/**
 * P76q 第 2 条的测试：没有可核对证据的「已改好 / 已完成」，原话不变、末尾补一句如实的话（P85 同步，原来是句中改写成「还没有验证」）。
 *
 * 正例（会被改写）：总管在交账的回复或汇报里说完成，但验证层级是「未验证」、没有真实文件变更、没有交付回执；
 * 反例（原样保留）：问句、否定句、流程描述；有检查结果、有文件变更、有交付回执；不是总管的员工。
 * 另外单独测三类证据的判断本身，避免只靠交账入口一条路。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { Bot } from '../src/model/index.js';
import { completionEvidenceFor, hasCompletionEvidence, hasCompletionClaim, noteUnverifiedClaims, UNVERIFIED_CLAIM_NOTE } from '../src/commit/claim-evidence.js';
import { processCommit } from '../src/commit/process.js';
import { botFixture } from './model-fixtures.js';
import { jobFixture } from './p74a-job-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';

const CLAIM = '已改好：两个页面的提示文字都不用感叹号。';
// P85 同步：原话不改，在末尾另起一行补固定的一句（原来是句中把「已改好」换成「还没有验证是否改好」）。
const SOFTENED = `${CLAIM}\n${UNVERIFIED_CLAIM_NOTE}`;

describe('1 完成声明的处理（P85 同步：原话不改，末尾补一句）', () => {
  it('正例：「已改好」「已完成」「都改好了」「修改好了」都算完成声明，原话一字不改、末尾另起一行补固定的话', () => {
    expect(noteUnverifiedClaims(CLAIM)).toBe(SOFTENED);
    expect(noteUnverifiedClaims('已完成。')).toBe(`已完成。\n${UNVERIFIED_CLAIM_NOTE}`);
    expect(noteUnverifiedClaims('两个页面都改好了。')).toBe(`两个页面都改好了。\n${UNVERIFIED_CLAIM_NOTE}`);
    expect(noteUnverifiedClaims('已经修改好了。')).toBe(`已经修改好了。\n${UNVERIFIED_CLAIM_NOTE}`);
    // 后面的句子不受影响，补的话在整段末尾，只补一次。
    expect(noteUnverifiedClaims('已完成。下一步等你确认。')).toBe(`已完成。下一步等你确认。\n${UNVERIFIED_CLAIM_NOTE}`);
  });

  it('反例：问句、否定句、流程描述不当作完成声明', () => {
    for (const text of ['已经改好了吗？', '是否已完成？', '还没有改好。', '并未修复。', '完成标准是页面能打开。', '改好之后再核对。']) {
      expect(hasCompletionClaim(text), text).toBe(false);
      expect(noteUnverifiedClaims(text), text).toBe(text);
    }
  });

  it('幂等：已经补过那一句的文字再处理一次不变', () => {
    expect(noteUnverifiedClaims(SOFTENED)).toBe(SOFTENED);
  });
});

describe('2 三类证据', () => {
  it('任意一条成立就可以正常说完成；三条都不成立就不行', () => {
    expect(hasCompletionEvidence({ checked: true, fileChanged: false, receipt: false })).toBe(true);
    expect(hasCompletionEvidence({ checked: false, fileChanged: true, receipt: false })).toBe(true);
    expect(hasCompletionEvidence({ checked: false, fileChanged: false, receipt: true })).toBe(true);
    expect(hasCompletionEvidence({ checked: false, fileChanged: false, receipt: false })).toBe(false);
  });

  it('有交付回执：这件事待验收或有交付记录；没有回执、只有通知时不算', async () => {
    const ctx = createTestContext();
    const chief: Bot = { ...botFixture, id: 'b_0000000010', role: 'chief', homeDir: '/hub/bots/b_0000000010' };
    ctx.store.table('bots').put(chief);
    const input = { worldChanges: [], verification: { level: 'none' } };

    // P85 同步：回执只认回合所属的这件事在本回合期间新产生的交付（deliveredAt 不早于回合开始）。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'awaiting_owner', deliveredAt: ctx.clock.now() }));
    expect((await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: ctx.clock.now() }, input)).receipt).toBe(true);

    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'doing' }));
    const noReceipt = await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: ctx.clock.now() }, input);
    expect(noReceipt).toEqual({ checked: false, fileChanged: false, receipt: false });
  });

  it('有文件变更：本回合动过的文件才算；旧文件、URL 与不存在的位置都不算', async () => {
    const ctx = createTestContext();
    const chief: Bot = { ...botFixture, id: 'b_0000000010', role: 'chief', homeDir: '/hub/bots/b_0000000010' };
    ctx.store.table('bots').put(chief);
    const startedAt = ctx.clock.now();
    await ctx.fs.writeTextAtomic(`${chief.homeDir}/work/页面.html`, '<html></html>', { within: chief.homeDir });
    const verification = { level: 'none' };
    const wake = { jobId: null, startedAt };

    expect(await completionEvidenceFor(ctx, chief, wake, {
      worldChanges: [{ where: 'work/页面.html' }], verification })).toMatchObject({ fileChanged: true });
    expect(await completionEvidenceFor(ctx, chief, wake, {
      worldChanges: [{ where: 'https://example.com/页面.html' }], verification })).toMatchObject({ fileChanged: false });
    expect(await completionEvidenceFor(ctx, chief, wake, {
      worldChanges: [{ where: 'work/没有这个文件.html' }], verification })).toMatchObject({ fileChanged: false });
    // 回合开始之前就存在的文件不算本回合的变更。
    ctx.clock.advance(10 * 60_000);
    expect(await completionEvidenceFor(ctx, chief, { jobId: null, startedAt: ctx.clock.now() }, {
      worldChanges: [{ where: 'work/页面.html' }], verification })).toMatchObject({ fileChanged: false });
  });
});

describe('3 交账入口：总管说完成之前先对证据', () => {
  it('正例：没有证据却说「已改好」，落下的回复是原话加末尾补的固定一句', async () => {
    const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
    const result = await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '通知林舟修改', reply: CLAIM }));
    expect(result.ok).toBe(true);
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(SOFTENED);
  });

  it('正例：汇报里的完成声明同样改写', async () => {
    const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '通知林舟修改', report: '已完成。' }));
    expect(ctx.store.table('commits').list()[0]!.report).toBe(`已完成。\n${UNVERIFIED_CLAIM_NOTE}`);
  });

  it('反例：回复里只是说明进展（没有完成声明）时原样保留', async () => {
    const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
    const reply = '已通知林舟修改，等他回执。';
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '通知林舟', reply }));
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(reply);
  });

  it('反例：有检查结果（验证层级不是未验证）时原样保留', async () => {
    const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '核对过页面',
      reply: CLAIM, verification: { level: 'agent', notCovered: '' } }));
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(CLAIM);
  });

  it('反例：有真实文件变更时原样保留', async () => {
    const { ctx, bot: chief, toolCtx } = await turnContext('regular', { role: 'chief' });
    await ctx.fs.writeTextAtomic(`${chief.homeDir}/work/页面.html`, '<html></html>', { within: chief.homeDir });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '改了两个页面', reply: CLAIM,
      worldChanges: [{ what: '提示文字去掉感叹号', whoCanSee: 'owner', where: 'work/页面.html' }] }));
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(CLAIM);
  });

  it('边界：不是总管的员工不走这条文字核对（执行者由交回与核对把关）', async () => {
    const { ctx, toolCtx } = await turnContext('regular');
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '做了一部分', reply: CLAIM }));
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(CLAIM);
  });
});
