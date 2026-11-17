/**
 * P75r1 第 6 节的测试：引用记忆时核对适用范围，并让总管在「可引用的出处」里看得到范围。
 *
 * 对应审查记录 M3：原来 resolveBasis 的 mem_ 分支只看记忆是否生效，只用于别的项目的规矩也能被引用；
 * 总管约定段的出处行不带范围；只适用于某位员工的规矩不在总管的出处列表里，主人要删改它时总管拿不到编号。
 * 全部走真实的 Hub：编号只用正则从唤醒包「可引用的出处」里取。
 */
import { describe, expect, it } from 'vitest';
import { resolveBasis } from '../src/project/agreement-content.js';
import { writeMemory } from '../src/memory/service.js';
import { scopeSuffix } from '../src/wake/chief-sources.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { callTool, chiefHears, jobFix, speak, type JobFix } from './p75c-fixtures.js';

/** 写一条规矩，适用范围可指定。 */
async function rule(fix: JobFix, text: string, scope: { staff: 'all' | string[]; projects: 'all' | string[] }) {
  return writeMemory(fix.ctx, { kind: 'rule', text, example: '例子', redLine: false, scope,
    source: { kind: 'owner_words', messageIds: [], quote: '以后都这样', threadId: fix.chief.id } });
}

/** 总管听到一句话之后唤醒包里「可引用的出处」的那一段，并结束这一回合。 */
async function sourcesSection(fix: JobFix, ownerText = '随便聊聊'): Promise<string> {
  const packet = await chiefHears(fix, ownerText);
  const start = packet.indexOf('可引用的出处（basis.ref 只能写这些编号）：');
  return start < 0 ? '' : packet.slice(start, packet.indexOf('类别（category 只能写这些）', start));
}

describe('引用时核对项目范围', () => {
  it('只用于项目甲的规矩：在项目乙的约定里引用被拒，在项目甲的约定里通过', async () => {
    const fix = await jobFix();
    const memory = await rule(fix, '只在项目甲：提示用请字开头', { staff: 'all', projects: [fix.project.id] });
    const input = [{ text: 'x', basis: { kind: 'source' as const, ref: memory.id } }];
    // 项目甲的约定：通过。
    expect(resolveBasis(fix.ctx, fix.chief.id, input, fix.project.id)[0]!.basis).toMatchObject({ ref: memory.id });
    // 项目乙（另一个项目）的约定：被拒，文字说明只用于哪个项目。
    expect(() => resolveBasis(fix.ctx, fix.chief.id, input, 'prj_zzzzzzzzzz'))
      .toThrow(`decided[0].basis.ref：这一条只用于「${fix.project.name}」，这份约定不在这些项目里，不能引用；查不到合适的出处就把 kind 写成 judgement`);
    // 这份约定不属于任何项目时，带项目范围的记忆一律不能引用。
    expect(() => resolveBasis(fix.ctx, fix.chief.id, input, null)).toThrow(/这份约定不在这些项目里/);
    // 全部项目的规矩在任何约定里都能引用。
    const open = await rule(fix, '全部项目：汇报先说结论', { staff: 'all', projects: 'all' });
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: open.id } }], null)[0]!.basis.ref).toBe(open.id);
  });

  it('走真实提交：新建约定不属于任何项目，引用只用于某项目的规矩被拒；没有写入约定', async () => {
    const fix = await jobFix();
    const memory = await rule(fix, '只在项目甲：提示用请字开头', { staff: 'all', projects: [fix.project.id] });
    await chiefHears(fix, '做个报价页');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({
      title: '报价页', category: '表单页', decided: [{ text: '提示用请字开头', basis: { kind: 'source', ref: memory.id } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`这一条只用于「${fix.project.name}」，这份约定不在这些项目里，不能引用`);
    expect(fix.ctx.store.table('agreements').list()).toHaveLength(0);
  });
});

describe('总管约定段的出处行带范围后缀，且列全部生效的规矩', () => {
  it('三种后缀：只适用于部分员工、只用于部分项目、两样都有；全部的不加', async () => {
    const fix = await jobFix();
    await rule(fix, '全部的规矩甲', { staff: 'all', projects: 'all' });
    await rule(fix, '只给员工的规矩乙', { staff: [fix.engineer.id], projects: 'all' });
    await rule(fix, '只限项目的规矩丙', { staff: 'all', projects: [fix.project.id] });
    await rule(fix, '员工和项目的规矩丁', { staff: [fix.engineer.id, fix.reviewer.id], projects: [fix.project.id] });
    const section = await sourcesSection(fix);
    const line = (text: string) => new RegExp(`^mem_[0-9a-z]{10}：${text}(.*)$`, 'm').exec(section)?.[1];
    expect(line('全部的规矩甲')).toBe('');
    expect(line('只给员工的规矩乙')).toBe('（仅适用于林舟）');
    expect(line('只限项目的规矩丙')).toBe(`（仅用于${fix.project.name}）`);
    expect(line('员工和项目的规矩丁')).toBe(`（仅适用于林舟、评审甲）（仅用于${fix.project.name}）`);
  });

  it('员工或项目已不存在时写「已离队的员工」「已删除的项目」', async () => {
    const fix = await jobFix();
    const row = await rule(fix, '规矩', { staff: ['b_zzzzzzzzzz'], projects: ['prj_zzzzzzzzzz'] });
    expect(scopeSuffix(fix.ctx, row)).toBe('（仅适用于已离队的员工）（仅用于已删除的项目）');
  });

  it('只适用于某位员工的规矩出现在总管的出处列表里，总管用它的编号 forget 成功', async () => {
    const fix = await jobFix();
    const memory = await rule(fix, '评审甲专用：核对要写依据', { staff: [fix.reviewer.id], projects: 'all' });
    const section = await sourcesSection(fix, '把评审甲专用的那条删了');
    const id = new RegExp('^(mem_[0-9a-z]{10})：评审甲专用', 'm').exec(section)?.[1];
    expect(id, '总管的出处列表里应该有只给评审甲的这一条').toBe(memory.id);
    // 上面的 sourcesSection 已经让总管听到了「把评审甲专用的那条删了」；这个回合仍开着，直接 forget。
    const result = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: id });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('deleted');
    await speak(fix, fix.chief, `已删除「${memory.text}」。`, { outcome: 'progress' });
  });
});
