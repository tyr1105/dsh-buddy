/**
 * P75r1 第 2 节的测试：约定卡上改了引用记忆的条目，不再自动更正那条记忆。
 *
 * 对应审查记录 D1：主人说「这次页面风格改成丰富」，总管修订时把引用规矩的那条已定事项改写了措辞，主人确认之后，
 * 原来全局规矩会被改成这件事的说法。现在约定只管这一件事：规矩只在主人亲口说了之后由总管更正，或由主人在记忆页改。
 * 全部走真实的 Hub：主人说话，总管拿到唤醒包，memoryId 只用正则从唤醒包「可引用的出处」里取。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { CHIEF_RULES_TEXT } from '../src/wake/chief-packet.js';
import { callTool, chiefHears, jobFix, memoriesOf, messagesIn, noted, ownerSays, speak } from './p75c-fixtures.js';

const OLD = '页面上的提示文字都用「请」字开头';

describe('审查记录 D1：约定卡上改写引用规矩的条目', () => {
  it('固定之后那条记忆的文字、适用范围、历史都不变；私聊没有新增「已记住」；这一版的先例照常写出', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const chiefMessages = () => messagesIn(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id);
    const notedCountBefore = chiefMessages().filter(row => row.text.startsWith('已记住')).length;
    expect(notedCountBefore).toBe(1);
    // 第 1 版：总管引用这条规矩起草，主人说「定了」固定。
    const packet = await chiefHears(fix, '做个报价页，提示文字照我的规矩');
    const ruleId = /^(mem_[0-9a-z]{10})：页面上的提示文字/m.exec(packet)![1]!;
    expect(ruleId).toBe(memory.id);
    const created = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      title: '报价页', summary: '做一个报价页', category: '表单页',
      sketch: { layout: 'page', screens: [{ title: '报价页', blocks: [{ kind: 'title', text: '每日报价' }] }] },
      pending: [{ key: 'style', question: '页面风格', options: ['简洁', '丰富'], suggested: '简洁', reason: '你没有说' }],
      decided: [{ text: '提示文字都用「请」字开头', basis: { kind: 'source', ref: ruleId } }],
      scopeIn: ['报价页'], scopeOut: ['历史曲线'], doneWhen: ['能看到报价', '点刷新后数据更新', '接口失败时有提示'],
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '有 1 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    await speak(fix, fix.chief, '已固定。', { outcome: 'progress' });
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    // 第 2 版：主人说的是别的项（页面风格），总管修订时顺手把引用规矩的那一条改写了措辞。
    await ownerSays(fix, fix.chief.id, '这次页面风格改成丰富');
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '页面风格改为丰富',
      pending: [{ key: 'style', question: '页面风格', options: ['简洁', '丰富'], suggested: '丰富', reason: '你刚说要丰富' }],
      decided: [{ text: '报价页的提示文字用「请」开头', basis: { kind: 'source', ref: ruleId } }] });
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '改好了，请确认。', { outcome: 'needs_owner' });
    await fix.hub.api.confirmAgreement({ agreementId, version: 2 });
    await flushJobHooks(fix.ctx);
    // 约定第 2 版确实固定了，引用规矩的那一条在约定里是新措辞。
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    expect(agreement.versions.find(row => row.no === 2)!.lockedAt).not.toBeNull();
    expect(agreement.versions.find(row => row.no === 2)!.content.decided[0]!.text).toBe('报价页的提示文字用「请」开头');
    // 记忆没有被改：文字、适用范围、历史都和固定之前完全一样。
    const after = fix.ctx.store.table('memories').get(ruleId)!;
    expect(after.text).toBe(OLD);
    expect(after.scope).toEqual({ staff: 'all', projects: 'all' });
    expect(after.history).toEqual([]);
    expect(after.status).toBe('active');
    // 私聊里没有新增「已记住」开头的话。
    expect(chiefMessages().filter(row => row.text.startsWith('已记住')).length).toBe(notedCountBefore);
    // 这一版的先例照常写出（选定项为总管建议的「丰富」）。
    const precedent = memoriesOf(fix.ctx).find(row => row.kind === 'precedent' && row.source.versionNo === 2 && row.source.pendingKey === 'style');
    expect(precedent, '第 2 版的先例').toBeDefined();
    expect(precedent!.text).toBe('页面风格：丰富');
  });
});

describe('总管守则第 13 条：约定里改了引用内容，只改这份约定', () => {
  it('逐字加入「只改这份约定，不动那一条记忆」一句，位置在「拿不准时」之后、「主人要删掉」之前', () => {
    const sentence = '主人改了约定里一条引用规矩、偏好或先例的内容时，只改这份约定，不动那一条记忆；reply 末尾同样加一句「要我以后都这样吗」，主人说是，再用 mode correct 改那一条。';
    expect(CHIEF_RULES_TEXT).toContain(`拿不准时只改这一次，reply 末尾加一句「要我以后都这样吗」。${sentence}主人要删掉或改掉记住的某条`);
  });
});
