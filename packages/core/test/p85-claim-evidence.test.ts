/**
 * P85 第 3.3、3.4 节的测试：完成声明的核对（审查 W4、W5、W6）。
 *
 * 3.3 W4：交付回执只认这一回合自己的——回合不属于某件事时不认回执；属于某件事时只认这件事在回合期间新产生的交付或验收。
 * 3.4 W5：本回合中心工具办成的事对应的说法不算「没有证据」；动词名单收窄到指交付物做成的说法；
 *        没有证据的完成声明原话一字不改，在这段话末尾另起一行补一句固定的话，一段话只补一次（reply、report 两处都这样）。
 * 3.4 W6：否定只认紧贴动词之前的写法；逗号、分号也是分句边界。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot } from '../src/model/index.js';
import {
  UNVERIFIED_CLAIM_NOTE, completionEvidenceFor, hasCompletionClaim, hasCompletionEvidence, noteUnverifiedClaims,
} from '../src/commit/claim-evidence.js';
import { processCommit } from '../src/commit/process.js';
import { botFixture } from './model-fixtures.js';
import { jobFixture } from './p74a-job-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';
import { assigned } from './p74c-fixtures.js';
import { callTool, chiefDrafts, jobFix, ownerSays, speak } from './p74b-fixtures.js';
import { chiefHears, noteArgs } from './p75c-fixtures.js';

const NOTE = UNVERIFIED_CLAIM_NOTE;
const NONE = { worldChanges: [], verification: { level: 'none' } };

describe('3.3 回执只认这一回合自己的', () => {
  it('W4 复现：总管名下有已验收的事，私聊回合（不属于某件事）里的完成声明仍然没有证据', async () => {
    const ctx = createTestContext();
    const chief: Bot = { ...botFixture, id: 'b_0000000010', role: 'chief', homeDir: '/hub/bots/b_0000000010' };
    ctx.store.table('bots').put(chief);
    // 名下有一件已验收、早已交付的事。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'done', deliveredAt: ctx.clock.now() - 5000, acceptedAt: ctx.clock.now() - 1000 }));
    const evidence = await completionEvidenceFor(ctx, chief, { jobId: null, startedAt: ctx.clock.now() }, NONE);
    expect(evidence).toEqual({ checked: false, fileChanged: false, receipt: false });
    expect(hasCompletionEvidence(evidence)).toBe(false);
  });

  it('回合属于某件事：只认回合期间新产生的交付；回合开始之前的交付、验收不算', async () => {
    const ctx = createTestContext();
    const chief: Bot = { ...botFixture, id: 'b_0000000010', role: 'chief', homeDir: '/hub/bots/b_0000000010' };
    ctx.store.table('bots').put(chief);
    const now = ctx.clock.now();
    // 回合开始之前就交付、验收过。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'done', deliveredAt: now - 5000, acceptedAt: now - 1000 }));
    expect((await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: now }, NONE)).receipt).toBe(false);
    // 回合期间新交付：算。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'awaiting_owner', deliveredAt: now + 10 }));
    expect((await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: now }, NONE)).receipt).toBe(true);
    // 回合期间新验收：算。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'done', deliveredAt: now - 5000, acceptedAt: now + 10 }));
    expect((await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: now }, NONE)).receipt).toBe(true);
    // 另一件事的回执不算：回合所属的事没有。
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'doing' }));
    ctx.store.table('jobs').put(jobFixture({ id: 'job_0000000002', chiefId: chief.id, state: 'done', deliveredAt: now + 10, acceptedAt: now + 20 }));
    expect((await completionEvidenceFor(ctx, chief, { jobId: 'job_0000000001', startedAt: now }, NONE)).receipt).toBe(false);
  });

  it('交账入口：总管名下有已验收的事，私聊回合里没有证据的「已改好」仍然补那一句', async () => {
    const { ctx, bot: chief, toolCtx } = await turnContext('regular', { role: 'chief' });
    const now = ctx.clock.now();
    ctx.store.table('jobs').put(jobFixture({ chiefId: chief.id, state: 'done', deliveredAt: now - 5000, acceptedAt: now - 1000 }));
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '通知林舟修改', reply: '已改好：两个页面。' }));
    expect(ctx.store.table('commits').list()[0]!.reply).toBe(`已改好：两个页面。\n${NOTE}`);
  });
});

describe('3.4 动词名单收窄、原话不改、末尾补一句、只补一次', () => {
  it('W5 的五个例句：前三句和第五句不再是完成声明（动词已从名单去掉），原话不动', () => {
    for (const text of ['约定已更新，请你确认。', '我已删除那条记忆。', '已调整交付时间，改到周五。', '已发布约定卡给你确认。']) {
      expect(hasCompletionClaim(text), text).toBe(false);
      expect(noteUnverifiedClaims(text), text).toBe(text);
    }
  });

  it('W5 第四句：「已通知林舟，他完成了第一版。」没有证据：原话不变，末尾另起一行补固定的话', () => {
    expect(noteUnverifiedClaims('已通知林舟，他完成了第一版。')).toBe(`已通知林舟，他完成了第一版。\n${NOTE}`);
  });

  it('补的话逐字固定；同一段话有多句声明也只补一次；原话以换行结尾时不多空一行；再处理一次不变', () => {
    expect(NOTE).toBe('（以上关于已经完成的说法，这一回合没有可以核对的结果。）');
    const many = '已完成。页面都改好了。下一步上线了。';
    const once = noteUnverifiedClaims(many);
    expect(once).toBe(`${many}\n${NOTE}`);
    expect(once.split(NOTE)).toHaveLength(2);
    expect(noteUnverifiedClaims(once)).toBe(once);
    expect(noteUnverifiedClaims('已完成。\n')).toBe(`已完成。\n${NOTE}`);
  });

  it('名单里留下的指交付物做成的说法：改好、修好、修复、做好、做完、完成、上线', () => {
    for (const text of ['页面已改好。', '已修好。', '问题已修复。', '已做好。', '已做完。', '已完成。', '已经上线了。', '页面都做好了。', '问题已解决。', '这件事已处理好。']) {
      expect(hasCompletionClaim(text), text).toBe(true);
    }
    // 主会话裁定：解决、处理好同样指事情做成，加回名单；没有证据时末尾补那一句。
    expect(noteUnverifiedClaims('问题已解决。')).toBe(`问题已解决。\n${NOTE}`);
    expect(noteUnverifiedClaims('这件事已处理好。')).toBe(`这件事已处理好。\n${NOTE}`);
    for (const text of ['已更新。', '已调整。', '已删除。', '已添加。', '已发布。']) {
      expect(hasCompletionClaim(text), text).toBe(false);
    }
  });

  it('W6：只认紧贴动词之前的否定；逗号、分号是分句边界', () => {
    // 「没问题」的「没」隔着逗号，不算否定：这句是完成声明。
    expect(hasCompletionClaim('没问题，已经修复了。')).toBe(true);
    expect(noteUnverifiedClaims('没问题，已经修复了。')).toBe(`没问题，已经修复了。\n${NOTE}`);
    // 「还没完成」之后的「已更新计划」不是声明（更新不在名单里），整句不是完成声明。
    expect(hasCompletionClaim('这件事还没完成，已更新计划。')).toBe(false);
    expect(noteUnverifiedClaims('这件事还没完成，已更新计划。')).toBe('这件事还没完成，已更新计划。');
    // 紧贴动词之前的否定：不算声明。
    for (const text of ['还没有改好了。', '并未修复了。', '尚未做好了。', '没有完成了。']) {
      expect(hasCompletionClaim(text), text).toBe(false);
    }
    // 分号也是分句边界。
    expect(hasCompletionClaim('这一项没做；那一项已完成。')).toBe(true);
    // 「不用担心，已完成。」是声明。
    expect(hasCompletionClaim('不用担心，已完成。')).toBe(true);
  });
});

/** 总管最近一次交账落下的 reply、report。 */
function lastCommitOf(ctx: HubContext) {
  const rows = ctx.store.table('commits').list().sort((a, b) => a.createdAt - b.createdAt);
  return rows[rows.length - 1]!;
}

describe('复验 C1：放行以分句为单位', () => {
  const agreement = new Set(['agreement'] as const);
  const job = new Set(['job'] as const);
  it('别的分句里的词不能替没有证据的完成声明放行（要补那一句）', () => {
    expect(noteUnverifiedClaims('约定已更新，页面也改好了。', agreement)).toBe(`约定已更新，页面也改好了。\n${NOTE}`);
    expect(noteUnverifiedClaims('已交给林舟，页面已改好了。', job)).toBe(`已交给林舟，页面已改好了。\n${NOTE}`);
    expect(noteUnverifiedClaims('页面已改好，约定也更新了。', agreement)).toBe(`页面已改好，约定也更新了。\n${NOTE}`);
    expect(noteUnverifiedClaims('约定已更新；页面也改好了。', agreement)).toBe(`约定已更新；页面也改好了。\n${NOTE}`);
  });
  it('不补的：约定已更新、删除记忆；声明自己所在分句里有对应用词并且工具成功过时放行', () => {
    expect(noteUnverifiedClaims('约定已更新，请你确认。', agreement)).toBe('约定已更新，请你确认。');
    expect(noteUnverifiedClaims('我已删除那条记忆。', new Set(['memory'] as const))).toBe('我已删除那条记忆。');
    expect(noteUnverifiedClaims('约定已做好，请你确认。', agreement)).toBe('约定已做好，请你确认。');
  });
  it('真实链路：约定提交成功后回复「约定已更新，页面也改好了。」仍补那一句', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never);
    await speak(fix, fix.chief, '约定已更新，页面也改好了。', { outcome: 'needs_owner' });
    expect(lastCommitOf(fix.ctx).reply).toBe(`约定已更新，页面也改好了。\n${NOTE}`);
  });
});

describe('3.4 交账入口：reply、report 两处都补一句、各补一次', () => {
  it('没有任何证据：reply 和 report 各在末尾补一次，原话不改', async () => {
    const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '通知林舟', reply: '已通知林舟，他完成了第一版。', report: '两个页面已改好。' }));
    const commit = ctx.store.table('commits').list()[0]!;
    expect(commit.reply).toBe(`已通知林舟，他完成了第一版。\n${NOTE}`);
    expect(commit.report).toBe(`两个页面已改好。\n${NOTE}`);
  });

  it('不是完成声明的话（W5 例句）经过交账也原样保留', async () => {
    for (const reply of ['约定已更新，请你确认。', '我已删除那条记忆。', '已调整交付时间，改到周五。', '已发布约定卡给你确认。']) {
      const { ctx, toolCtx } = await turnContext('regular', { role: 'chief' });
      await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '办事', reply }));
      expect(ctx.store.table('commits').list()[0]!.reply, reply).toBe(reply);
    }
  });
});

describe('3.4 本回合中心工具已经办成的事：对应的说法放行（真实 Hub、真实工具）', () => {
  it('约定提交成功：「约定已做好，请你确认。」不补；同一回合里「页面已改好」没有证据，仍补', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never); // 总管调用 hub_agreement_submit，成功
    await speak(fix, fix.chief, '约定已做好，请你确认。页面已改好。', { outcome: 'needs_owner' });
    // 页面那一句没有证据：整段补一句；约定那一句因为中心工具办成而不单独触发——这里的第二句触发了补句。
    expect(lastCommitOf(fix.ctx).reply).toBe(`约定已做好，请你确认。页面已改好。\n${NOTE}`);
    // 只有约定那一句时不补。
    const second = await jobFix();
    await chiefDrafts(second as never);
    await speak(second, second.chief, '约定已做好，请你确认。', { outcome: 'needs_owner' });
    expect(lastCommitOf(second.ctx).reply).toBe('约定已做好，请你确认。');
  });

  it('没有调用约定提交：同一句「约定已做好」没有证据，补一句', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    await speak(fix, fix.chief, '约定已做好，请你确认。', { outcome: 'progress' });
    expect(lastCommitOf(fix.ctx).reply).toBe(`约定已做好，请你确认。\n${NOTE}`);
  });

  it('记忆写入成功：「这条规矩已做好」不补', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面上的提示文字都用「请」字开头');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
    // 复验 C1 同步：放行按分句，「已做好」要和「规矩」在同一个分句里。
    await speak(fix, fix.chief, '这条规矩已做好，已记住。', { outcome: 'progress' });
    expect(lastCommitOf(fix.ctx).reply).toBe('这条规矩已做好，已记住。');
  });

  it('派活成功：「这件事已交给林舟，派活已做好」不补', async () => {
    const fix = await jobFix();
    await assigned(fix);
    await speak(fix, fix.chief, '这件事已交给林舟，派活已做好。', { outcome: 'progress' });
    expect(lastCommitOf(fix.ctx).reply).toBe('这件事已交给林舟，派活已做好。');
  });

  it('工具调用失败不算：约定提交被拒绝之后，「约定已做好」仍补一句', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    // 缺必填项，提交失败。
    expect((await callTool(fix, fix.chief, 'hub_agreement_submit', { title: '空的' })).ok).toBe(false);
    await speak(fix, fix.chief, '约定已做好，请你确认。', { outcome: 'progress' });
    expect(lastCommitOf(fix.ctx).reply).toBe(`约定已做好，请你确认。\n${NOTE}`);
  });
});
